import { audio } from './audio';
import { conductor } from './conductor';
import { playback } from './playback';

export const BANDS = 96;
/** samples of recent energy; the swell takes SWELL_SECONDS to travel from the centre to the edges */
export const SWELL = 160;
export const SWELL_SECONDS = 3.2;

/**
 * Live spectrum for the wave: log-spaced bands from what is playing (or the mic),
 * auto-gained and smoothed with a fast attack and slow release so it moves like liquid.
 */
export class Spectrum {
  bands = new Float32Array(BANDS);
  swell = new Float32Array(SWELL);
  private swellLevel = 0;
  private swellAcc = 0;
  level = 0;
  private buf: Uint8Array<ArrayBuffer> = new Uint8Array(1024);
  private peak = 0.3;
  private edges: number[] = [];
  private lastRate = 0;

  private build(sampleRate: number, bins: number) {
    const lo = 35, hi = 14000;
    const hz = sampleRate / 2 / bins;
    this.edges = Array.from({ length: BANDS + 1 }, (_, i) => Math.max(1, Math.round((lo * Math.pow(hi / lo, i / BANDS)) / hz)));
    this.lastRate = sampleRate;
  }

  update(dt: number, t: number) {
    let an: AnalyserNode | null = null;
    if (playback.engine === 'audio' && playback.playing) an = playback.analyser;
    else if (audio.micOn && audio.analyserNode) an = audio.analyserNode;

    const target = new Float32Array(BANDS);
    if (an) {
      if (this.buf.length !== an.frequencyBinCount) this.buf = new Uint8Array(an.frequencyBinCount);
      if (this.lastRate !== an.context.sampleRate || !this.edges.length) this.build(an.context.sampleRate, an.frequencyBinCount);
      an.getByteFrequencyData(this.buf);
      let max = 0;
      for (let b = 0; b < BANDS; b++) {
        const i0 = this.edges[b], i1 = Math.max(i0 + 1, this.edges[b + 1]);
        let s = 0;
        for (let i = i0; i < i1 && i < this.buf.length; i++) s += this.buf[i];
        const v = s / ((i1 - i0) * 255);
        target[b] = v;
        if (v > max) max = v;
      }
      this.peak = Math.max(max, this.peak * Math.pow(0.5, dt / 6), 0.25);
      for (let b = 0; b < BANDS; b++) target[b] = Math.pow(Math.min(1, target[b] / this.peak), 1.6);
    } else {
      // nothing to listen to: a slow breathing horizon, nudged by the conductor's beat
      const L = conductor.state;
      for (let b = 0; b < BANDS; b++) {
        const x = b / BANDS;
        target[b] = (0.35 + 0.25 * Math.sin(t * 0.4 + x * 6) + 0.15 * Math.sin(t * 0.23 - x * 11)) * (1 - x * 0.6) * 0.6 + L.kick * 0.25 * (1 - x);
      }
    }
    // spread energy across neighbouring bands (two box passes ≈ gaussian) so the horizon is a hill, not a bar chart
    const tmp = new Float32Array(BANDS);
    for (let pass = 0; pass < 2; pass++) {
      const R = 5;
      for (let b = 0; b < BANDS; b++) {
        let acc = 0, n = 0;
        for (let k = -R; k <= R; k++) {
          const j = b + k;
          if (j >= 0 && j < BANDS) { acc += target[j]; n++; }
        }
        tmp[b] = acc / n;
      }
      target.set(tmp);
    }
    let lvl = 0;
    for (let b = 0; b < BANDS; b++) {
      const cur = this.bands[b], tg = target[b];
      const tau = tg > cur ? 0.035 : 0.22;
      this.bands[b] = cur + (tg - cur) * (1 - Math.exp(-dt / tau));
      lvl += this.bands[b];
    }
    this.level = lvl / BANDS;

    // the swell: low-end energy, eased so it rises and falls like water, written into a short history
    let low = 0;
    const lowN = Math.round(BANDS * 0.3);
    for (let b = 0; b < lowN; b++) low += this.bands[b];
    low /= lowN;
    const tau = low > this.swellLevel ? 0.18 : 0.6;
    this.swellLevel += (low - this.swellLevel) * (1 - Math.exp(-dt / tau));
    this.swellAcc += dt;
    const step = SWELL_SECONDS / SWELL;
    while (this.swellAcc >= step) {
      this.swellAcc -= step;
      this.swell.copyWithin(1, 0, SWELL - 1);
      this.swell[0] = this.swellLevel;
    }
  }
}
