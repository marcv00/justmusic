/// <reference lib="webworker" />
import { ANALYSIS_RATE, type Analysis, type BandEvents, type Section } from './analysisTypes';

/**
 * Offline music analysis, entirely on device.
 * Audio arrives already resampled to 22.05 kHz. We take a 1024-point FFT every 256 samples
 * (~86 frames/s) and derive: per-band loudness (low / mid / high), per-band spectral flux,
 * onset events per band, tempo (autocorrelation with a perceptual prior), a beat grid
 * (dynamic programming, Ellis 2007), downbeats (bar phase with the heaviest low end),
 * and sections (novelty between neighbouring 4-bar windows).
 */

const SR = ANALYSIS_RATE;
const N = 1024;
const HOP = 256;
const FPS = SR / HOP;
const HALF = N / 2;
/** a frame's analysis window is centred half a window after its start */
const T0 = N / 2 / SR;

/* ---------------- FFT ---------------- */
const rev = new Uint32Array(N);
for (let i = 0, bits = Math.log2(N); i < N; i++) {
  let r = 0;
  for (let b = 0; b < bits; b++) r |= ((i >> b) & 1) << (bits - 1 - b);
  rev[i] = r;
}
const cosT = new Float32Array(HALF);
const sinT = new Float32Array(HALF);
for (let i = 0; i < HALF; i++) {
  cosT[i] = Math.cos((2 * Math.PI * i) / N);
  sinT[i] = -Math.sin((2 * Math.PI * i) / N);
}
const hann = new Float32Array(N);
for (let i = 0; i < N; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (N - 1));

function fft(re: Float32Array, im: Float32Array) {
  for (let i = 0; i < N; i++) {
    const j = rev[i];
    if (j > i) {
      let t = re[i]; re[i] = re[j]; re[j] = t;
      t = im[i]; im[i] = im[j]; im[j] = t;
    }
  }
  for (let size = 2; size <= N; size <<= 1) {
    const half = size >> 1;
    const step = N / size;
    for (let start = 0; start < N; start += size) {
      for (let k = 0; k < half; k++) {
        const wr = cosT[k * step], wi = sinT[k * step];
        const a = start + k, b = a + half;
        const xr = re[b] * wr - im[b] * wi;
        const xi = re[b] * wi + im[b] * wr;
        re[b] = re[a] - xr; im[b] = im[a] - xi;
        re[a] += xr; im[a] += xi;
      }
    }
  }
}

/* ---------------- small stats helpers ---------------- */
function percentile(a: Float32Array, p: number) {
  const s = Float32Array.from(a).sort();
  return s[Math.min(s.length - 1, Math.max(0, Math.floor(p * (s.length - 1))))] || 0;
}
function normRange(a: Float32Array, lo = 0.05, hi = 0.98) {
  const a0 = percentile(a, lo), a1 = percentile(a, hi);
  const d = a1 - a0 || 1;
  const out = new Float32Array(a.length);
  for (let i = 0; i < a.length; i++) out[i] = Math.min(1.25, Math.max(0, (a[i] - a0) / d));
  return out;
}
function movingMean(a: Float32Array, w: number) {
  const out = new Float32Array(a.length);
  let s = 0;
  const q: number[] = [];
  for (let i = 0; i < a.length + w; i++) {
    if (i < a.length) { s += a[i]; q.push(a[i]); }
    if (q.length > 2 * w + 1) s -= q.shift()!;
    const c = i - w;
    if (c >= 0 && c < a.length) out[c] = s / q.length;
  }
  return out;
}

/**
 * The bass "pump": low-band loudness measured against its own range over the last and next
 * ~1.5 s. A quiet verse and a loud chorus both swing from dark to full on every bass hit,
 * while true silence stays dark.
 */
function localContrast(x: Float32Array, w: number) {
  const n = x.length;
  const out = new Float32Array(n);
  const g0 = percentile(x, 0.05), g1 = percentile(x, 0.98);
  const gRange = g1 - g0 || 1;
  for (let i = 0; i < n; i++) {
    let lo = Infinity, hi = -Infinity;
    for (let j = Math.max(0, i - w); j < Math.min(n, i + (w >> 2)); j += 2) {
      const v = x[j];
      if (v < lo) lo = v;
      if (v > hi) hi = v;
    }
    const r = hi - lo;
    const presence = Math.min(1, r / (0.3 * gRange)) * Math.min(1, Math.max(0, (x[i] - g0) / (0.3 * gRange)));
    out[i] = r > 1e-6 ? ((x[i] - lo) / r) * presence : 0;
  }
  return out;
}

/* ---------------- features ---------------- */
const BANDS = {
  low: [Math.round(40 / (SR / N)), Math.round(150 / (SR / N))],
  mid: [Math.round(150 / (SR / N)), Math.round(2500 / (SR / N))],
  high: [Math.round(2500 / (SR / N)), Math.round(10000 / (SR / N))],
} as const;

function features(x: Float32Array) {
  const frames = Math.max(1, Math.floor((x.length - N) / HOP) + 1);
  const re = new Float32Array(N), im = new Float32Array(N);
  const prev = new Float32Array(HALF);
  const out = {
    low: new Float32Array(frames), mid: new Float32Array(frames), high: new Float32Array(frames),
    fLow: new Float32Array(frames), fMid: new Float32Array(frames), fHigh: new Float32Array(frames),
    loud: new Float32Array(frames),
    voice: new Float32Array(frames),
  };
  const v0 = Math.round(300 / (SR / N)), v1 = Math.round(3400 / (SR / N));
  const band = (k: number) => (k < BANDS.low[1] ? 0 : k < BANDS.mid[1] ? 1 : k < BANDS.high[1] ? 2 : 3);
  const KMAX = BANDS.high[1];
  const bandOf = new Uint8Array(HALF);
  for (let k = 0; k < HALF; k++) bandOf[k] = k < BANDS.low[0] ? 4 : band(k);

  for (let f = 0; f < frames; f++) {
    const o = f * HOP;
    for (let i = 0; i < N; i++) { re[i] = (x[o + i] || 0) * hann[i]; im[i] = 0; }
    fft(re, im);
    let e0 = 0, e1 = 0, e2 = 0, d0 = 0, d1 = 0, d2 = 0, tot = 0, ev = 0;
    for (let k = 1; k < KMAX; k++) {
      const m = Math.sqrt(re[k] * re[k] + im[k] * im[k]);
      const lm = Math.log1p(m * 10);
      const d = lm - prev[k];
      prev[k] = lm;
      const p = m * m;
      tot += p;
      if (k >= v0 && k < v1) ev += p;
      const b = bandOf[k];
      if (b === 0) { e0 += p; if (d > 0) d0 += d; }
      else if (b === 1) { e1 += p; if (d > 0) d1 += d; }
      else if (b === 2) { e2 += p; if (d > 0) d2 += d; }
    }
    out.low[f] = Math.log1p(e0); out.mid[f] = Math.log1p(e1); out.high[f] = Math.log1p(e2);
    out.fLow[f] = d0; out.fMid[f] = d1 / 8; out.fHigh[f] = d2 / 20;
    out.loud[f] = Math.log1p(tot);
    out.voice[f] = Math.log(ev + 1e-6);
  }
  return out;
}

/* ---------------- tempo + beats ---------------- */
function tempo(o: Float32Array) {
  const minLag = Math.floor((FPS * 60) / 200), maxLag = Math.ceil((FPS * 60) / 60);
  const n = o.length;
  const ac = new Float32Array(maxLag + 2);
  for (let lag = minLag - 1; lag <= maxLag + 1; lag++) {
    let s = 0;
    for (let i = lag; i < n; i++) s += o[i] * o[i - lag];
    ac[lag] = s / (n - lag);
  }
  let best = 0, bestLag = Math.round((FPS * 60) / 120);
  for (let lag = minLag; lag <= maxLag; lag++) {
    const bpm = (60 * FPS) / lag;
    const prior = Math.exp(-0.5 * (Math.log2(bpm / 118) / 0.85) ** 2);
    const s = (ac[lag] + 0.5 * (ac[lag * 2] ?? 0)) * prior;
    if (s > best) { best = s; bestLag = lag; }
  }
  // parabolic refinement
  const a = ac[bestLag - 1], b = ac[bestLag], c = ac[bestLag + 1];
  const den = a - 2 * b + c;
  const shift = den !== 0 ? (0.5 * (a - c)) / den : 0;
  return bestLag + Math.max(-0.5, Math.min(0.5, shift));
}

function beatTrack(o: Float32Array, period: number) {
  const n = o.length;
  const score = new Float32Array(n);
  const back = new Int32Array(n).fill(-1);
  const tight = 120;
  const lo = Math.round(period * 2), hi = Math.round(period / 2);
  for (let t = 0; t < n; t++) {
    let best = -Infinity, bi = -1;
    for (let p = Math.max(0, t - lo); p <= t - hi; p++) {
      const v = score[p] - tight * Math.log((t - p) / period) ** 2;
      if (v > best) { best = v; bi = p; }
    }
    score[t] = o[t] + (bi >= 0 ? Math.max(0, best) : 0);
    back[t] = best > 0 ? bi : -1;
  }
  let end = n - 1, top = -Infinity;
  for (let t = Math.max(0, n - Math.round(period)); t < n; t++) if (score[t] > top) { top = score[t]; end = t; }
  const beats: number[] = [];
  for (let t = end; t >= 0; t = back[t]) beats.push(t);
  beats.reverse();
  // extend the grid backwards to the start if the chain began late
  const first = beats[0] ?? 0;
  const pre: number[] = [];
  for (let t = first - period; t > 0; t -= period) pre.unshift(Math.round(t));
  return [...pre, ...beats];
}

/* ---------------- events ---------------- */
function pick(flux: Float32Array, minGap: number, k: number): BandEvents {
  const f = normRange(flux, 0.1, 0.995);
  const mean = movingMean(f, Math.round(FPS * 0.25));
  const gap = Math.round(minGap * FPS);
  const t: number[] = [], s: number[] = [], r: number[] = [];
  let last = -gap;
  for (let i = 1; i < f.length - 1; i++) {
    if (f[i] > mean[i] * 1.35 + k && f[i] >= f[i - 1] && f[i] > f[i + 1] && i - last >= gap) {
      t.push(i / FPS + T0);
      s.push(f[i]);
      r.push(f[i] / (mean[i] + 0.02));
      last = i;
    }
  }
  const sArr = Float32Array.from(s);
  const top = percentile(sArr, 0.95) || 1;
  for (let i = 0; i < sArr.length; i++) sArr[i] = Math.min(1, sArr[i] / top);
  return { t: Float32Array.from(t), s: sArr, r: Float32Array.from(r) };
}

/* ---------------- sections ---------------- */
function sections(beats: number[], down: Uint8Array, loud: Float32Array, low: Float32Array, high: Float32Array, duration: number): Section[] {
  const bars: number[] = [];
  beats.forEach((b, i) => down[i] && bars.push(b));
  if (bars.length < 12) return [{ start: 0, end: duration, energy: 0.6, drop: false }];
  bars.push(loud.length);
  const feats = bars.slice(0, -1).map((b, i) => {
    const e = bars[i + 1];
    let L = 0, B = 0, H = 0;
    for (let f = b; f < e; f++) { L += loud[f]; B += low[f]; H += high[f]; }
    const n = Math.max(1, e - b);
    return [L / n, B / n, H / n];
  });
  const W = 4;
  const nov = feats.map((_, i) => {
    if (i < W || i + W > feats.length) return 0;
    let d = 0;
    for (let k = 0; k < 3; k++) {
      let a = 0, b = 0;
      for (let j = 1; j <= W; j++) { a += feats[i - j][k]; b += feats[i + j - 1][k]; }
      d += Math.abs(b - a) / W * (k === 0 ? 1.5 : 1);
    }
    return d;
  });
  const mean = nov.reduce((s, v) => s + v, 0) / nov.length;
  const std = Math.sqrt(nov.reduce((s, v) => s + (v - mean) ** 2, 0) / nov.length);
  const cuts = [0];
  for (let i = 2; i < nov.length - 2; i++) {
    const isPeak = nov[i] >= nov[i - 1] && nov[i] >= nov[i + 1] && nov[i] >= nov[i - 2] && nov[i] >= nov[i + 2];
    if (isPeak && nov[i] > mean + 0.5 * std && i - cuts[cuts.length - 1] >= 8) cuts.push(i);
  }
  const loudAll = feats.map((f) => f[0]);
  const lo = Math.min(...loudAll), hi = Math.max(...loudAll);
  const out: Section[] = [];
  for (let c = 0; c < cuts.length; c++) {
    const a = cuts[c], b = cuts[c + 1] ?? feats.length;
    let e = 0;
    for (let i = a; i < b; i++) e += loudAll[i];
    const energy = (e / Math.max(1, b - a) - lo) / (hi - lo || 1);
    out.push({ start: bars[a] / FPS + T0, end: (bars[b] ?? loud.length) / FPS + T0, energy, drop: false });
  }
  out[0].start = 0;
  out[out.length - 1].end = duration;
  for (let i = 1; i < out.length; i++) out[i].drop = out[i].energy - out[i - 1].energy > 0.28 && out[i].energy > 0.6;
  return out;
}

/* ---------------- main ---------------- */
function analyze(channels: Float32Array[]): Analysis {
  const len = channels[0].length;
  const x = new Float32Array(len);
  for (const ch of channels) for (let i = 0; i < len; i++) x[i] += ch[i] / channels.length;

  const F = features(x);
  const low = normRange(F.low), mid = normRange(F.mid), high = normRange(F.high);

  // onset envelope: weighted flux, detrended, unit variance
  const raw = new Float32Array(F.fLow.length);
  for (let i = 0; i < raw.length; i++) raw[i] = F.fLow[i] * 1.0 + F.fMid[i] * 0.8 + F.fHigh[i] * 0.5;
  const m = movingMean(raw, Math.round(FPS * 0.2));
  const onset = new Float32Array(raw.length);
  let s2 = 0;
  for (let i = 0; i < raw.length; i++) { onset[i] = Math.max(0, raw[i] - m[i]); s2 += onset[i] ** 2; }
  const sd = Math.sqrt(s2 / onset.length) || 1;
  for (let i = 0; i < onset.length; i++) onset[i] /= sd;

  const period = tempo(onset);
  const beatsF = beatTrack(onset, period);
  const lowRaw = F.fLow;
  let phase = 0, bestPhase = -Infinity;
  for (let p = 0; p < 4; p++) {
    let s = 0;
    for (let i = p; i < beatsF.length; i += 4) s += lowRaw[beatsF[i]] + low[beatsF[i]];
    if (s > bestPhase) { bestPhase = s; phase = p; }
  }
  const downbeats = new Uint8Array(beatsF.length);
  for (let i = 0; i < beatsF.length; i++) downbeats[i] = (i - phase) % 4 === 0 ? 1 : 0;

  const duration = len / SR;
  // percussive envelope for aligning two versions of the same song (vocals excluded)
  const perc = new Float32Array(raw.length);
  for (let i = 0; i < perc.length; i++) perc[i] = F.fLow[i] + F.fHigh[i];

  // slow energy contour without vocals: tells verse from chorus, so alignment can't slip by a bar
  const shapeRaw = new Float32Array(raw.length);
  for (let i = 0; i < raw.length; i++) shapeRaw[i] = F.low[i] + F.high[i];
  const shape = movingMean(normRange(shapeRaw), Math.round(FPS * 0.4));

  const pump = localContrast(F.low, Math.round(FPS * 1.5));
  const ev = {
    low: pick(F.fLow, 0.2, 0.1),
    mid: pick(F.fMid, 0.1, 0.1),
    high: pick(F.fHigh, 0.06, 0.12),
  };
  // drive: sharp hits per second, an absolute measure. A ballad's loudest chorus still has few
  // of them; a dance track's quietest verse still has a kick on every beat.
  const secs = sections(beatsF, downbeats, F.loud, F.low, F.high, duration).map((sec) => {
    const count = (e: BandEvents, minR: number) => {
      let n = 0;
      for (let i = 0; i < e.t.length; i++) if (e.t[i] >= sec.start && e.t[i] < sec.end && e.r[i] > minR) n++;
      return n;
    };
    const dur = Math.max(1, sec.end - sec.start);
    return { ...sec, drive: (count(ev.low, 2.4) + 0.35 * count(ev.mid, 2.6)) / dur };
  });

  return {
    fps: FPS,
    shape,
    pump,
    voice: F.voice,
    duration,
    low, mid, high,
    perc: normRange(perc, 0.05, 0.99),
    bpm: (60 * FPS) / period,
    t0: T0,
    beats: Float32Array.from(beatsF, (b) => b / FPS + T0),
    downbeats,
    sections: secs,
    events: ev,
  };
}

/** Lag (seconds) such that a moment at time tA in A happens at tA + offset in B. */
function align(a: { perc: Float32Array; shape: Float32Array }, b: { perc: Float32Array; shape: Float32Array }, fps: number) {
  const D = 4;
  const ds = (x: Float32Array) => {
    const out = new Float32Array(Math.floor(x.length / D));
    for (let i = 0; i < out.length; i++) for (let j = 0; j < D; j++) out[i] += x[i * D + j];
    let mu = 0;
    for (const v of out) mu += v;
    mu /= out.length || 1;
    let sd = 0;
    for (const v of out) sd += (v - mu) ** 2;
    sd = Math.sqrt(sd / (out.length || 1)) || 1;
    for (let i = 0; i < out.length; i++) out[i] = (out[i] - mu) / sd;
    return out;
  };
  // Pearson correlation over the overlap only, so silence or an intro at either end can't bias it
  const corr = (X: Float32Array, Y: Float32Array, lag: number) => {
    let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
    for (let i = Math.max(0, -lag); i < X.length && i + lag < Y.length; i++) {
      const x = X[i], y = Y[i + lag];
      sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; n++;
    }
    if (n < 200) return 0;
    const cov = sxy - (sx * sy) / n;
    const v = Math.sqrt(Math.max(1e-9, (sxx - (sx * sx) / n) * (syy - (sy * sy) / n)));
    // favour long overlaps a little: a tiny overlap can correlate by luck
    return (cov / v) * Math.min(1, n / (X.length * 0.6));
  };
  const Ap = ds(a.perc), Bp = ds(b.perc), As = ds(a.shape), Bs = ds(b.shape);
  const maxLag = Math.round((40 * fps) / D);
  const vals: number[] = [];
  let best = -Infinity, bestLag = 0;
  for (let lag = -maxLag; lag <= maxLag; lag++) {
    const c = corr(Ap, Bp, lag) * 0.5 + corr(As, Bs, lag);
    vals.push(c);
    if (c > best) { best = c; bestLag = lag; }
  }
  const mu = vals.reduce((s, v) => s + v, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((s, v) => s + (v - mu) ** 2, 0) / vals.length) || 1;
  // refine on the percussive envelope at full resolution
  let fine = bestLag * D, fineBest = -Infinity;
  for (let lag = bestLag * D - D * 2; lag <= bestLag * D + D * 2; lag++) {
    const c = corr(a.perc, b.perc, lag);
    if (c > fineBest) { fineBest = c; fine = lag; }
  }
  return { offset: fine / fps, confidence: (best - mu) / sd };
}

/* ---------------- lyrics against the voice ---------------- */

interface VoiceInput {
  voiceO: Float32Array;
  /** the karaoke version's voice band, if we have it; the difference is (mostly) the singer */
  voiceK?: Float32Array;
  /** karaoke time = original time + offK */
  offK: number;
  fps: number;
  t0: number;
}

/** How much someone is singing at each frame of the original version, 0..1. */
function vocalActivity({ voiceO, voiceK, offK, fps }: VoiceInput) {
  const n = voiceO.length;
  const d = new Float32Array(n);
  if (voiceK) {
    const off = Math.round(offK * fps);
    for (let i = 0; i < n; i++) {
      const j = i + off;
      d[i] = j >= 0 && j < voiceK.length ? voiceO[i] - voiceK[j] : 0;
    }
    // remove the overall loudness difference between the two masters
    const med = percentile(d, 0.5);
    for (let i = 0; i < n; i++) d[i] = Math.max(0, d[i] - med);
  } else {
    // no karaoke: the voice band against its own slow floor (weaker, still useful)
    const floor = movingMean(voiceO, Math.round(fps * 2));
    for (let i = 0; i < n; i++) d[i] = Math.max(0, voiceO[i] - floor[i]);
  }
  const sm = movingMean(d, Math.round(fps * 0.12));
  const top = percentile(sm, 0.95) || 1;
  for (let i = 0; i < n; i++) sm[i] = Math.min(1, sm[i] / top);
  return sm;
}

function pearson(a: Float32Array, b: Float32Array, lag: number) {
  // correlation of a[i] with b[i - lag]
  let sx = 0, sy = 0, sxx = 0, syy = 0, sxy = 0, n = 0;
  for (let i = Math.max(0, lag); i < a.length && i - lag < b.length; i++) {
    const x = a[i], y = b[i - lag];
    sx += x; sy += y; sxx += x * x; syy += y * y; sxy += x * y; n++;
  }
  if (n < 100) return -1;
  const v = Math.sqrt(Math.max(1e-9, (sxx - (sx * sx) / n) * (syy - (sy * sy) / n)));
  return (sxy - (sx * sy) / n) / v;
}

/** Find how many seconds later the lyrics' timeline sits in this recording (intros, edits). */
function alignLyrics(input: VoiceInput & { lines: { t: number; text: string }[] }) {
  const R = 10; // work at 10 frames per second
  const V = vocalActivity(input);
  const step = input.fps / R;
  const v = new Float32Array(Math.floor(V.length / step));
  for (let i = 0; i < v.length; i++) v[i] = V[Math.floor(i * step)];
  const L = new Float32Array(v.length + 1200);
  const lines = input.lines;
  lines.forEach((l, i) => {
    if (!l.text) return;
    const next = lines[i + 1]?.t ?? l.t + 6;
    const end = Math.min(next, l.t + Math.min(8, Math.max(1, l.text.length * 0.09 + 0.4)));
    for (let k = Math.max(0, Math.round(l.t * R)); k < Math.min(L.length, Math.round(end * R)); k++) L[k] = 1;
  });
  const vals: number[] = [];
  let best = -Infinity, bestLag = 0;
  for (let lag = -60 * R; lag <= 60 * R; lag++) {
    const c = pearson(v, L, lag);
    vals.push(c);
    if (c > best) { best = c; bestLag = lag; }
  }
  const mu = vals.reduce((a, b) => a + b, 0) / vals.length;
  const sd = Math.sqrt(vals.reduce((a, b) => a + (b - mu) ** 2, 0) / vals.length) || 1;
  // refine at full frame rate around the coarse answer
  const fps = input.fps;
  const Lf = new Float32Array(V.length + Math.round(60 * fps));
  lines.forEach((l, i) => {
    if (!l.text) return;
    const next = lines[i + 1]?.t ?? l.t + 6;
    const end = Math.min(next, l.t + Math.min(8, Math.max(1, l.text.length * 0.09 + 0.4)));
    for (let k = Math.max(0, Math.round(l.t * fps)); k < Math.min(Lf.length, Math.round(end * fps)); k++) Lf[k] = 1;
  });
  let fine = Math.round((bestLag / R) * fps), fineBest = -Infinity;
  const c0 = fine;
  for (let lag = c0 - Math.round(fps * 0.2); lag <= c0 + Math.round(fps * 0.2); lag++) {
    const c = pearson(V, Lf, lag);
    if (c > fineBest) { fineBest = c; fine = lag; }
  }
  return { offset: fine / fps, confidence: (best - mu) / sd, strength: best };
}

/** Sung phrases: stretches of clear singing, split at breaths. */
function phrasesOf(V: Float32Array, fps: number) {
  const thr = 0.25, gap = Math.round(0.22 * fps), minLen = Math.round(0.25 * fps);
  const out: { s: number; e: number }[] = [];
  let start = -1, lastOn = -1;
  for (let i = 0; i <= V.length; i++) {
    const on = i < V.length && V[i] > thr;
    if (on) {
      if (start < 0) start = i;
      lastOn = i;
    } else if (start >= 0 && i - lastOn > gap) {
      if (lastOn - start >= minLen) out.push({ s: start, e: lastOn + 1 });
      start = -1;
    }
  }
  return out;
}

/**
 * Time untimed lyrics: find the sung phrases, then place lines on phrase starts with dynamic
 * programming so each line's expected length (from its syllables) matches the singing it covers.
 * A line may span several detected phrases; phrases before the first line can be skipped.
 */
function autoTime(input: VoiceInput & { lines: string[] }) {
  const V = vocalActivity(input);
  const fps = input.fps;
  const P = phrasesOf(V, fps);
  const idx = input.lines.map((l, i) => (l.trim() ? i : -1)).filter((i) => i >= 0);
  const n = idx.length, m = P.length;
  const times: number[] = new Array(input.lines.length).fill(0);
  if (!n || !m) return times;
  const expect = idx.map((i) => Math.max(0.8, input.lines[i].replace(/\s+/g, ' ').length * 0.075));
  const len = P.map((p) => (p.e - p.s) / fps);
  const MAXSPAN = 6;
  const INF = 1e9;
  // cost[i][j]: best cost with line i starting at phrase j
  const cost = Array.from({ length: n }, () => new Float64Array(m).fill(INF));
  const from = Array.from({ length: n }, () => new Int32Array(m).fill(-1));
  let skipped = 0;
  for (let j = 0; j < m; j++) {
    cost[0][j] = skipped * 0.15;
    skipped += len[j];
  }
  const spanCost = (i: number, j: number, j2: number) => {
    let sung = 0;
    for (let k = j; k < j2; k++) sung += len[k];
    const span = (P[j2 - 1].e - P[j].s) / fps;
    return Math.abs(sung - expect[i]) / expect[i] + Math.max(0, span - expect[i] * 2.2) * 0.3;
  };
  for (let i = 0; i < n - 1; i++) {
    for (let j = 0; j < m; j++) {
      if (cost[i][j] >= INF) continue;
      for (let j2 = j + 1; j2 <= Math.min(m - 1, j + MAXSPAN); j2++) {
        const c = cost[i][j] + spanCost(i, j, j2);
        if (c < cost[i + 1][j2]) { cost[i + 1][j2] = c; from[i + 1][j2] = j; }
      }
    }
  }
  // the last line covers what's left (up to MAXSPAN phrases)
  let bestJ = -1, best = INF;
  for (let j = 0; j < m; j++) {
    if (cost[n - 1][j] >= INF) continue;
    const c = cost[n - 1][j] + spanCost(n - 1, j, Math.min(m, j + 1));
    if (c < best) { best = c; bestJ = j; }
  }
  if (bestJ < 0) {
    // fewer phrases than lines: fall back to even spacing over the sung part
    const t0 = P[0].s / fps, t1 = P[m - 1].e / fps;
    idx.forEach((li, k) => (times[li] = input.t0 + t0 + ((t1 - t0) * k) / n));
  } else {
    for (let i = n - 1, j = bestJ; i >= 0; j = from[i][j], i--) times[idx[i]] = P[j].s / fps + input.t0;
  }
  // empty lines (instrumental breaks) sit just after the previous line ends
  for (let i = 0; i < times.length; i++) if (!input.lines[i].trim()) times[i] = (times[i - 1] ?? 0) + 3;
  return times;
}

self.onmessage = (e: MessageEvent) => {
  const { id, type } = e.data;
  try {
    if (type === 'analyze') {
      const result = analyze(e.data.channels as Float32Array[]);
      (self as unknown as Worker).postMessage({ id, result });
    } else if (type === 'alignLyrics') {
      (self as unknown as Worker).postMessage({ id, result: alignLyrics(e.data.input) });
    } else if (type === 'autoTime') {
      (self as unknown as Worker).postMessage({ id, result: autoTime(e.data.input) });
    } else if (type === 'align') {
      (self as unknown as Worker).postMessage({ id, result: align(e.data.a, e.data.b, e.data.fps) });
    }
  } catch (err) {
    (self as unknown as Worker).postMessage({ id, error: String(err) });
  }
};
