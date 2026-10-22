import { useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as RPointerEvent } from 'react';
import type { LyricLine } from '../services/lyrics';
import { peaksOf, peakAt, type Peaks } from '../engine/peaks';
import { playback } from '../engine/playback';

export interface SlicerTrack {
  title: string;
  channel: string;
  buffer: AudioBuffer;
  /** bar starts in this recording's own clock */
  bars?: number[];
}

export interface SlicerValues {
  /** karaoke time = lipsync time + offK */
  offK: number;
  /** a lyric written at time t is sung at lipsync time t + shift */
  shift: number;
}

interface Props {
  song: { title: string; artist: string; art?: string };
  loading: { text: string; progress?: number } | null;
  lip?: SlicerTrack;
  kar?: SlicerTrack;
  lines: LyricLine[];
  lyricDuration?: number;
  lyricLabel?: string;
  initial: SlicerValues;
  auto: { offK?: number; offKSure?: boolean; shift?: number; shiftSure?: boolean };
  /** start: before playing (+ and Empezar) · queue: inside the side panel · live: mid-song */
  mode: 'start' | 'queue' | 'live';
  /** songs already waiting in the queue (shown on the + button) */
  queued?: number;
  /** keep this song and go pick another (start mode) */
  onAdd?: (v: SlicerValues) => void;
  onConfirm: (v: SlicerValues) => void;
  onBack: () => void;
}

type Row = 'lyrics' | 'lip' | 'kar';
const ROW_H = 76;
const SNAP_PX = 7;
const MAX_PPS = 140;

const fmt = (s: number, tenths = true) => {
  const neg = s < 0;
  const v = Math.abs(s);
  const m = Math.floor(v / 60);
  const sec = v - m * 60;
  return `${neg ? '−' : ''}${m}:${(tenths ? sec.toFixed(1) : Math.floor(sec).toString()).padStart(tenths ? 4 : 2, '0')}`;
};
const signed = (s: number) => `${s >= 0 ? '+' : '−'}${Math.abs(s).toFixed(2)} s`;

/** Expected end of each lyric line: the next line, or a length from its text. */
function lineEnds(lines: LyricLine[]) {
  return lines.map((l, i) => {
    const est = l.t + Math.min(8, Math.max(1.2, l.text.length * 0.09 + 0.4));
    return Math.min(lines[i + 1]?.t ?? est, est);
  });
}

/* --------------------------- audition --------------------------- */

class Audition {
  private src: AudioBufferSourceNode | null = null;
  private gain: GainNode | null = null;
  kind: 'lip' | 'kar' | null = null;
  private startCtx = 0;
  private startAxis = 0;
  private offK = 0;

  play(kind: 'lip' | 'kar', buffer: AudioBuffer, axisT: number, offK: number) {
    this.stop(0.02);
    const ctx = playback.ctx;
    void ctx.resume();
    const g = ctx.createGain();
    g.connect(ctx.destination);
    const s = ctx.createBufferSource();
    s.buffer = buffer;
    s.connect(g);
    const when = ctx.currentTime + 0.03;
    const at = kind === 'kar' ? axisT + offK : axisT;
    g.gain.setValueAtTime(0, when);
    g.gain.linearRampToValueAtTime(1, when + 0.03);
    s.start(when, Math.max(0, Math.min(at, buffer.duration - 0.05)));
    s.onended = () => {
      if (this.src === s) {
        this.src = null;
        this.kind = null;
      }
    };
    this.src = s;
    this.gain = g;
    this.kind = kind;
    this.startCtx = when;
    this.startAxis = axisT;
    this.offK = offK;
  }

  stop(fade = 0.06) {
    if (!this.src || !this.gain) return;
    const ctx = playback.ctx;
    const t = ctx.currentTime;
    this.gain.gain.cancelScheduledValues(t);
    this.gain.gain.setValueAtTime(this.gain.gain.value, t);
    this.gain.gain.linearRampToValueAtTime(0, t + fade);
    this.src.onended = null;
    this.src.stop(t + fade + 0.02);
    this.src = null;
    this.kind = null;
  }

  /** Where the sound you hear sits on the lipsync axis. */
  axisNow() {
    if (!this.src) return null;
    const ctx = playback.ctx;
    const heard = ctx.currentTime - (ctx.outputLatency || ctx.baseLatency || 0);
    return this.startAxis + Math.max(0, heard - this.startCtx);
  }

  get offset() {
    return this.offK;
  }
}

/* --------------------------- component --------------------------- */

export function Slicer(p: Props) {
  const { lip, kar, lines } = p;
  const [offK, setOffK] = useState(p.initial.offK);
  const [shift, setShift] = useState(p.initial.shift);
  const [view, setView] = useState({ t0: -5, pps: 4 });
  const [width, setWidth] = useState(800);
  const [playhead, setPlayhead] = useState(0);
  const [hearing, setHearing] = useState<'lip' | 'kar' | null>(null);
  const [focusRow, setFocusRow] = useState<Row>('lyrics');
  const [dragging, setDragging] = useState<Row | null>(null);
  const [snapped, setSnapped] = useState<Row | null>(null);
  const [perfect, setPerfect] = useState<'checking' | 'yes' | 'no'>('checking');

  const lanes = useRef<HTMLDivElement>(null);
  const canvases = useRef<Record<Row, HTMLCanvasElement | null>>({ lyrics: null, lip: null, kar: null });
  const audition = useRef(new Audition());
  const fitted = useRef(false);

  const hasLyrics = lines.some((l) => l.text);
  const ends = useMemo(() => lineEnds(lines), [lines]);
  const lyricSpan = useMemo(() => {
    const sung = lines.map((l, i) => ({ s: l.t, e: ends[i], text: l.text })).filter((x) => x.text);
    if (!sung.length) return null;
    return { s: sung[0].s, e: sung[sung.length - 1].e };
  }, [lines, ends]);
  const lyricLen = p.lyricDuration ?? (lyricSpan ? lyricSpan.e + 4 : 0);
  const lipPeaks = useMemo<Peaks | null>(() => (lip ? peaksOf(lip.buffer) : null), [lip]);
  const karPeaks = useMemo<Peaks | null>(() => (kar ? peaksOf(kar.buffer) : null), [kar]);

  // keep values in step if new data arrives (auto results come in after first render)
  useEffect(() => {
    setOffK(p.initial.offK);
    setShift(p.initial.shift);
  }, [p.initial.offK, p.initial.shift]);

  /* ---------- extents on the shared axis (the lipsync clock) ---------- */
  const extents = useMemo(() => {
    const r: Record<Row, [number, number] | null> = {
      lyrics: hasLyrics ? [shift, shift + lyricLen] : null,
      lip: lip ? [0, lip.buffer.duration] : null,
      kar: kar ? [-offK, kar.buffer.duration - offK] : null,
    };
    return r;
  }, [hasLyrics, shift, lyricLen, lip, kar, offK]);

  const fit = useCallback(() => {
    const all = Object.values(extents).filter((e): e is [number, number] => !!e);
    if (!all.length || !width) return;
    const a = Math.min(...all.map((e) => e[0])), b = Math.max(...all.map((e) => e[1]));
    const pad = (b - a) * 0.03 + 1;
    setView({ t0: a - pad, pps: width / (b - a + pad * 2) });
  }, [extents, width]);

  // measure, and fit the first time there's something to show
  useEffect(() => {
    const el = lanes.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setWidth(el.clientWidth));
    ro.observe(el);
    setWidth(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    if (!fitted.current && lip && width > 100) {
      fitted.current = true;
      fit();
    }
  }, [lip, width, fit]);

  /* ---------- perfect match: skip straight to the show ---------- */
  useEffect(() => {
    if (p.mode === 'live' || p.loading || !lip || perfect !== 'checking') return;
    const karOk = !kar || (Math.abs(p.initial.offK) < 0.08 && p.auto.offKSure !== false && Math.abs(kar.buffer.duration - lip.buffer.duration) < 1.5);
    const lyrOk = !hasLyrics || (Math.abs(p.initial.shift) < 0.08 && p.auto.shiftSure !== false);
    setPerfect(karOk && lyrOk ? 'yes' : 'no');
  }, [p, lip, kar, hasLyrics, perfect]);
  const latest = useRef(p);
  latest.current = p;
  // a perfect match in start mode starts on its own after a short countdown; touching anything cancels it
  const [countdown, setCountdown] = useState(false);
  useEffect(() => {
    if (perfect !== 'yes' || p.mode !== 'start') return;
    setCountdown(true);
    const t = setTimeout(() => latest.current.onConfirm({ offK: latest.current.initial.offK, shift: latest.current.initial.shift }), 2600);
    const cancel = () => {
      clearTimeout(t);
      setCountdown(false);
    };
    window.addEventListener('pointerdown', cancel, { once: true, capture: true });
    window.addEventListener('keydown', cancel, { once: true, capture: true });
    return () => {
      clearTimeout(t);
      window.removeEventListener('pointerdown', cancel, { capture: true });
      window.removeEventListener('keydown', cancel, { capture: true });
    };
  }, [perfect, p.mode]);

  /* ---------- drawing ---------- */
  const x = useCallback((t: number) => (t - view.t0) * view.pps, [view]);

  const draw = useCallback(() => {
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    const band = lyricSpan ? [lyricSpan.s + shift, lyricSpan.e + shift] : extents.kar ?? extents.lip ?? [0, 0];
    const rows: Row[] = ['lyrics', 'lip', 'kar'];
    for (const row of rows) {
      const c = canvases.current[row];
      if (!c) continue;
      const W = width, H = ROW_H;
      if (c.width !== Math.round(W * dpr)) c.width = Math.round(W * dpr);
      if (c.height !== Math.round(H * dpr)) c.height = Math.round(H * dpr);
      const g = c.getContext('2d')!;
      g.setTransform(dpr, 0, 0, dpr, 0, 0);
      g.clearRect(0, 0, W, H);
      const mid = H / 2;

      if (row === 'lyrics') {
        if (!hasLyrics) continue;
        // the lyric timeline as a strip, line by line
        const a = x(shift), b = x(shift + lyricLen);
        g.fillStyle = 'rgba(255,255,255,0.04)';
        roundRect(g, a, 8, b - a, H - 16, 10);
        g.fill();
        g.font = '500 11.5px "Bricolage Grotesque Variable", system-ui, sans-serif';
        g.textBaseline = 'middle';
        lines.forEach((l, i) => {
          if (!l.text) return;
          const s = x(l.t + shift), e = x(ends[i] + shift);
          if (e < 0 || s > W) return;
          const at = playhead - shift;
          const now = at >= l.t && at < (lines[i + 1]?.t ?? ends[i]);
          g.fillStyle = now ? 'rgba(246,253,255,0.9)' : 'rgba(246,253,255,0.22)';
          roundRect(g, s, 16, Math.max(2, e - s - 1.5), H - 32, 6);
          g.fill();
          if (e - s > 34) {
            g.save();
            g.beginPath();
            g.rect(s + 6, 0, e - s - 12, H);
            g.clip();
            g.fillStyle = now ? '#140103' : 'rgba(246,253,255,0.85)';
            g.fillText(l.text, s + 7, mid);
            g.restore();
          }
        });
        continue;
      }

      const peaks = row === 'lip' ? lipPeaks : karPeaks;
      const track = row === 'lip' ? lip : kar;
      if (!peaks || !track) continue;
      const toRow = (axisT: number) => (row === 'kar' ? axisT + offK : axisT);
      const warm = row === 'lip';
      // bar lines of this recording
      if (track.bars) {
        g.strokeStyle = 'rgba(255,255,255,0.07)';
        g.lineWidth = 1;
        g.beginPath();
        for (const bt of track.bars) {
          const px = x(row === 'kar' ? bt - offK : bt);
          if (px < 0 || px > W) continue;
          g.moveTo(Math.round(px) + 0.5, 6);
          g.lineTo(Math.round(px) + 0.5, H - 6);
        }
        g.stroke();
      }
      // the waveform, brighter inside the band
      const bandA = x(band[0]), bandB = x(band[1]);
      for (let px = 0; px < W; px += 2) {
        const t0 = toRow(view.t0 + px / view.pps);
        const t1 = toRow(view.t0 + (px + 2) / view.pps);
        if (t1 < 0) continue;
        const v = peakAt(peaks, t0, t1);
        if (v < 0) break;
        const h = Math.max(1, v * (H / 2 - 9));
        const inside = px >= bandA && px <= bandB;
        g.fillStyle = warm
          ? inside ? 'rgba(255,122,104,0.95)' : 'rgba(255,122,104,0.32)'
          : inside ? 'rgba(127,230,255,0.95)' : 'rgba(127,230,255,0.3)';
        g.fillRect(px, mid - h, 1.4, h * 2);
      }
    }
  }, [width, view, x, shift, offK, lines, ends, hasLyrics, lyricLen, lipPeaks, karPeaks, lip, kar, playhead, lyricSpan, extents]);

  useEffect(() => {
    const id = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(id);
  }, [draw]);

  /* ---------- audition loop ---------- */
  useEffect(() => {
    if (!hearing) return;
    let raf = 0;
    const loop = () => {
      raf = requestAnimationFrame(loop);
      const t = audition.current.axisNow();
      if (t === null) {
        setHearing(null);
        return;
      }
      setPlayhead(t);
      // keep the playhead on screen
      setView((v) => {
        const px = (t - v.t0) * v.pps;
        if (px > width * 0.85) return { ...v, t0: t - (width * 0.3) / v.pps };
        if (px < 0) return { ...v, t0: t - (width * 0.1) / v.pps };
        return v;
      });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [hearing, width]);
  useEffect(() => () => audition.current.stop(), []);
  // in the side panel a song is playing: lower it while you listen to a version here
  useEffect(() => {
    if (p.mode !== 'queue') return;
    playback.duck(!!hearing);
  }, [hearing, p.mode]);
  useEffect(() => () => void (p.mode === 'queue' && playback.duck(false)), [p.mode]);

  const hear = useCallback(
    (kind: 'lip' | 'kar', from = playhead) => {
      const track = kind === 'lip' ? lip : kar;
      if (!track) return;
      audition.current.play(kind, track.buffer, from, offK);
      setHearing(kind);
    },
    [lip, kar, offK, playhead],
  );
  const stopHearing = () => {
    audition.current.stop();
    setHearing(null);
  };
  // moving the karaoke while listening to it: restart where it now lines up
  useEffect(() => {
    if (hearing === 'kar' && !dragging && Math.abs(audition.current.offset - offK) > 0.001) {
      const t = audition.current.axisNow();
      if (t !== null && kar) audition.current.play('kar', kar.buffer, t, offK);
    }
  }, [offK, dragging, hearing, kar]);

  /* ---------- pointer: drag rows, pan, set playhead ---------- */
  const drag = useRef<{ row: Row; x0: number; v0: number; moved: boolean; t00: number } | null>(null);
  const axisAt = (clientX: number) => {
    const r = lanes.current!.getBoundingClientRect();
    return view.t0 + (clientX - r.left) / view.pps;
  };
  const onDown = (row: Row) => (e: RPointerEvent<HTMLDivElement>) => {
    e.currentTarget.setPointerCapture(e.pointerId);
    setFocusRow(row);
    drag.current = { row, x0: e.clientX, v0: row === 'lyrics' ? shift : row === 'kar' ? offK : 0, moved: false, t00: view.t0 };
  };
  const onMove = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.x0;
    if (!d.moved && Math.abs(dx) < 4) return;
    if (!d.moved) {
      d.moved = true;
      setDragging(d.row);
    }
    const dt = dx / view.pps;
    if (d.row === 'lip') {
      setView((v) => ({ ...v, t0: d.t00 - dt }));
      return;
    }
    // magnetic snap to the automatic suggestion
    const autoV = d.row === 'lyrics' ? p.auto.shift : p.auto.offK;
    let next = d.row === 'lyrics' ? d.v0 + dt : d.v0 - dt;
    let snap = false;
    if (autoV !== undefined && Math.abs(next - autoV) * view.pps < SNAP_PX) {
      next = autoV;
      snap = true;
    }
    setSnapped(snap ? d.row : null);
    if (d.row === 'lyrics') setShift(next);
    else setOffK(next);
  };
  const onUp = (e: RPointerEvent<HTMLDivElement>) => {
    const d = drag.current;
    drag.current = null;
    setDragging(null);
    setTimeout(() => setSnapped(null), 600);
    if (d && !d.moved) {
      const t = axisAt(e.clientX);
      setPlayhead(t);
      if (hearing) hear(hearing, t);
    }
  };
  const board = useRef<HTMLElement>(null);
  const wheel = useRef<(e: WheelEvent) => void>(() => undefined);
  wheel.current = (e: WheelEvent) => {
    e.preventDefault();
    if (e.ctrlKey || e.metaKey) {
      const t = axisAt(e.clientX);
      setView((v) => {
        const pps = Math.min(MAX_PPS, Math.max(0.5, v.pps * Math.exp(-e.deltaY * 0.01)));
        return { pps, t0: t - (t - v.t0) * (v.pps / pps) };
      });
    } else {
      const d = Math.abs(e.deltaX) > Math.abs(e.deltaY) ? e.deltaX : e.deltaY;
      setView((v) => ({ ...v, t0: v.t0 + d / v.pps }));
    }
  };
  useEffect(() => {
    const el = board.current;
    if (!el) return;
    const fn = (e: WheelEvent) => wheel.current(e);
    el.addEventListener('wheel', fn, { passive: false });
    return () => el.removeEventListener('wheel', fn);
  }, []);
  const zoomBy = (f: number) =>
    setView((v) => {
      const c = playhead >= v.t0 && playhead <= v.t0 + width / v.pps ? playhead : v.t0 + width / v.pps / 2;
      const pps = Math.min(MAX_PPS, Math.max(0.5, v.pps * f));
      return { pps, t0: c - (c - v.t0) * (v.pps / pps) };
    });
  const nudge = (row: Row, d: number) => {
    if (row === 'lyrics') setShift((s) => s + d);
    if (row === 'kar') setOffK((o) => o - d);
  };

  /* ---------- keyboard ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches('input')) return;
      if (e.code === 'Space') {
        e.preventDefault();
        if (hearing) stopHearing();
        else hear(focusRow === 'kar' && kar ? 'kar' : 'lip');
      } else if (e.key === '1') hear('lip');
      else if (e.key === '2' && kar) hear('kar');
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        e.preventDefault();
        const d = (e.key === 'ArrowLeft' ? -1 : 1) * (e.shiftKey ? 1 : e.altKey ? 0.01 : 0.1);
        nudge(focusRow === 'lip' ? 'lyrics' : focusRow, d);
      } else if (e.key === '+' || e.key === '=') zoomBy(1.4);
      else if (e.key === '-') zoomBy(1 / 1.4);
      else if (e.key === '0') fit();
      else if (e.key === 'Enter') confirm();
      else if (e.key === '+' && p.mode === 'start') add();
      else if (e.key === 'Escape') p.onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  const confirm = () => {
    stopHearing();
    p.onConfirm({ offK, shift });
  };
  const add = () => {
    stopHearing();
    p.onAdd?.({ offK, shift });
  };
  const resetAuto = () => {
    if (p.auto.shift !== undefined) setShift(p.auto.shift);
    if (p.auto.offK !== undefined) setOffK(p.auto.offK);
  };

  /* ---------- band labels per row ---------- */
  const band = lyricSpan ? { a: lyricSpan.s + shift, b: lyricSpan.e + shift } : null;
  const inRow = (row: Row, axisT: number) => {
    if (row === 'lyrics') return axisT - shift;
    if (row === 'kar') return axisT + offK;
    return axisT;
  };
  const rowDur: Record<Row, number | null> = {
    lyrics: hasLyrics ? lyricLen : null,
    lip: lip?.buffer.duration ?? null,
    kar: kar?.buffer.duration ?? null,
  };
  const outside = (row: Row, t: number) => {
    const d = rowDur[row];
    return d !== null && (t < -0.05 || t > d + 0.05);
  };

  const currentLine = useMemo(() => {
    const at = playhead - shift;
    let i = -1;
    for (let k = 0; k < lines.length; k++) if (lines[k].t <= at) i = k;
    return i >= 0 && at < (lines[i + 1]?.t ?? ends[i] + 2) ? lines[i].text : '';
  }, [playhead, shift, lines, ends]);

  const ticks = useMemo(() => {
    const span = width / view.pps;
    const step = [1, 2, 5, 10, 15, 30, 60, 120].find((s) => span / s <= 14) ?? 120;
    const out: number[] = [];
    for (let t = Math.ceil(view.t0 / step) * step; t < view.t0 + span; t += step) out.push(t);
    return out;
  }, [view, width]);

  const rowsDef: { row: Row; title: string; sub: string; movable: boolean; present: boolean }[] = [
    { row: 'lyrics', title: 'Letra', sub: p.lyricLabel ?? 'Sincronizada', movable: true, present: hasLyrics },
    { row: 'lip', title: 'Lipsync', sub: lip ? `${lip.channel} · referencia` : '', movable: false, present: !!lip },
    { row: 'kar', title: 'Karaoke', sub: kar?.channel ?? '', movable: true, present: !!kar },
  ];

  const compact = p.mode === 'queue';
  const offsetText = (row: Row) => {
    if (row === 'lyrics') return compact ? signed(shift) : Math.abs(shift) < 0.005 ? 'Sin desfase' : `La letra va ${signed(shift)}`;
    if (row === 'kar') return compact ? signed(-offK) : Math.abs(offK) < 0.005 ? 'Sin desfase' : `Karaoke ${signed(-offK)}`;
    return 'Fija';
  };
  const sure = (row: Row) => (row === 'lyrics' ? p.auto.shiftSure : row === 'kar' ? p.auto.offKSure : true);

  const ready = !p.loading && !!lip;

  return (
    <main className={`slicer ui mode-${p.mode}${ready ? ' ready' : ''}`}>
      <header className="sl-head">
        <button className="pick-back" onClick={p.onBack} aria-label="Volver">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        {p.song.art ? <img className="pick-art" src={p.song.art} alt="" /> : <span className="pick-art empty" />}
        <div className="sl-title">
          <b>Sincroniza las versiones</b>
          <span className="muted">
            {p.song.title} · {p.song.artist}
          </span>
        </div>
        <p className="sl-hint">
          Arrastra la letra y la karaoke hasta que la franja caiga sobre la voz. Toca una fila para mover el cursor; escúchala con 1 y 2.
        </p>
      </header>

      {p.loading && (
        <div className="sl-loading" role="status">
          <span>{p.loading.text}</span>
          <div className="sl-progress">
            <i style={{ width: `${Math.round((p.loading.progress ?? 0) * 100)}%` }} />
          </div>
        </div>
      )}
      {perfect === 'yes' && (
        <div className="sl-perfect" role="status">
          <b>Coinciden perfecto</b>
          <span>{countdown ? 'Empezando…' : p.mode === 'queue' ? 'Lista para la cola' : 'Nada que ajustar'}</span>
        </div>
      )}

      <section className="sl-board" aria-label="Línea de tiempo" ref={board}>
        <div className="sl-ruler-row">
          <div className="sl-label" />
          <div
            className="sl-ruler"
            onPointerDown={(e) => {
              const t = axisAt(e.clientX);
              setPlayhead(t);
              if (hearing) hear(hearing, t);
            }}
          >
            {ticks.map((t) => (
              <span key={t} style={{ left: x(t) }}>
                {fmt(t, false)}
              </span>
            ))}
          </div>
          <div className="sl-dur" />
        </div>

        <div className="sl-rows">
          {rowsDef.map(({ row, title, sub, movable, present }) => (
            <div
              key={row}
              className={`sl-row row-${row}${hearing && row !== 'lyrics' ? (hearing === row ? ' playing' : ' quiet') : ''}${focusRow === row ? ' focus' : ''}${dragging === row ? ' dragging' : ''}${snapped === row ? ' snapped' : ''}${present ? '' : ' empty'}`}
            >
              <div className="sl-label">
                <b>{title}</b>
                <span className="muted">{sub}</span>
                {present && (
                  <span className={`sl-off${sure(row) === false ? ' unsure' : ''}`} title={sure(row) === false ? 'Revisa: la alineación automática no está segura' : undefined}>
                    {movable && (
                      <button onClick={() => nudge(row, -0.1)} aria-label={`${title} antes`}>
                        ‹
                      </button>
                    )}
                    <em>{offsetText(row)}</em>
                    {movable && (
                      <button onClick={() => nudge(row, 0.1)} aria-label={`${title} después`}>
                        ›
                      </button>
                    )}
                  </span>
                )}
              </div>
              <div
                className={`sl-lane${movable ? ' movable' : ''}`}
                ref={row === 'lyrics' ? lanes : undefined}
                onPointerDown={present ? onDown(row) : undefined}
                onPointerMove={onMove}
                onPointerUp={onUp}
                onPointerCancel={onUp}
              >
                <canvas ref={(el) => (canvases.current[row] = el)} style={{ width: '100%', height: ROW_H }} />
                {!present && <span className="sl-none">{row === 'kar' ? 'Sin versión karaoke' : 'Sin letra'}</span>}
                {present && row !== 'lip' && sure(row) !== undefined && (
                  <span
                    className="sl-ghost"
                    style={{ left: x(row === 'lyrics' ? p.auto.shift ?? 0 : -(p.auto.offK ?? 0)) }}
                    title="Posición sugerida"
                  />
                )}
                {present && band && (
                  <>
                    <span className={`sl-edge a${outside(row, inRow(row, band.a)) ? ' bad' : ''}`} style={{ left: x(band.a) }}>
                      {outside(row, inRow(row, band.a)) ? 'antes del inicio' : fmt(inRow(row, band.a))}
                    </span>
                    <span className={`sl-edge b${outside(row, inRow(row, band.b)) ? ' bad' : ''}`} style={{ left: x(band.b) }}>
                      {outside(row, inRow(row, band.b)) ? 'se corta antes' : fmt(inRow(row, band.b))}
                    </span>
                  </>
                )}
              </div>
              <div className="sl-dur">{rowDur[row] !== null ? fmt(rowDur[row]!, false) : '—'}</div>
            </div>
          ))}
          <div className="sl-overlay" aria-hidden="true">
            {band && <div className="sl-band" style={{ left: x(band.a), width: Math.max(2, x(band.b) - x(band.a)) }} />}
            <div className={`sl-playhead${hearing ? ' live' : ''}`} style={{ left: x(playhead) }} />
          </div>
        </div>
      </section>

      <footer className="sl-foot">
        <div className="sl-transport">
          <button className={`sl-hear lip${hearing === 'lip' ? ' on' : ''}`} onClick={() => (hearing === 'lip' ? stopHearing() : hear('lip'))} disabled={!lip}>
            <i />
            {hearing === 'lip' ? 'Pausar' : 'Escuchar lipsync'} <kbd>1</kbd>
          </button>
          <button className={`sl-hear kar${hearing === 'kar' ? ' on' : ''}`} onClick={() => (hearing === 'kar' ? stopHearing() : hear('kar'))} disabled={!kar}>
            <i />
            {hearing === 'kar' ? 'Pausar' : 'Escuchar karaoke'} <kbd>2</kbd>
          </button>
        </div>
        <div className="sl-now" aria-live="polite">
          <span className="muted">{fmt(playhead)}</span>
          <b key={currentLine}>{currentLine || (hasLyrics ? '· · ·' : '')}</b>
        </div>
        <div className="sl-zoom">
          <button onClick={() => zoomBy(1 / 1.4)} aria-label="Alejar">−</button>
          <button onClick={fit}>Ver todo</button>
          <button onClick={() => zoomBy(1.4)} aria-label="Acercar">+</button>
        </div>
        <button className="btn" onClick={resetAuto}>Automático</button>
        {p.mode === 'start' && (
          <button className="sl-add" onClick={add} disabled={!ready} aria-label="Guardar y añadir otra canción" title="Añadir otra canción (+)">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
              <path d="M12 5v14M5 12h14" />
            </svg>
            {!!p.queued && <span className="sl-add-count">{p.queued}</span>}
          </button>
        )}
        <button className={`btn solid sl-go${countdown ? ' counting' : ''}`} onClick={confirm} disabled={!ready}>
          {countdown && <i className="sl-go-ring" aria-hidden="true" />}
          {p.mode === 'live' ? 'Aplicar' : p.mode === 'queue' ? 'Añadir a la cola' : p.queued ? 'Empezar la cola' : 'Empezar'}
        </button>
      </footer>
    </main>
  );
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  const rr = Math.min(r, w / 2, h / 2);
  g.beginPath();
  g.moveTo(x + rr, y);
  g.arcTo(x + w, y, x + w, y + h, rr);
  g.arcTo(x + w, y + h, x, y + h, rr);
  g.arcTo(x, y + h, x, y, rr);
  g.arcTo(x, y, x + w, y, rr);
  g.closePath();
}
