/** Waveform peaks: per slice of time, the loudest absolute sample (0..1), across channels. */
export interface Peaks {
  perSec: number;
  data: Float32Array;
  duration: number;
}

const cache = new WeakMap<AudioBuffer, Peaks>();
export const PEAKS_PER_SEC = 100;

export function peaksOf(buffer: AudioBuffer): Peaks {
  const hit = cache.get(buffer);
  if (hit) return hit;
  const n = Math.ceil(buffer.duration * PEAKS_PER_SEC);
  const data = new Float32Array(n);
  const step = buffer.sampleRate / PEAKS_PER_SEC;
  for (let c = 0; c < buffer.numberOfChannels; c++) {
    const ch = buffer.getChannelData(c);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * step), b = Math.min(ch.length, Math.floor((i + 1) * step));
      let m = data[i];
      for (let j = a; j < b; j += 2) {
        const v = ch[j] < 0 ? -ch[j] : ch[j];
        if (v > m) m = v;
      }
      data[i] = m;
    }
  }
  // normalise to the loud parts, gently compressed so quiet passages stay visible
  const sorted = Float32Array.from(data).sort();
  const top = sorted[Math.floor(sorted.length * 0.995)] || 1;
  for (let i = 0; i < n; i++) data[i] = Math.pow(Math.min(1, data[i] / top), 0.7);
  const p = { perSec: PEAKS_PER_SEC, data, duration: buffer.duration };
  cache.set(buffer, p);
  return p;
}

/** Loudest peak within [t0, t1) seconds. */
export function peakAt(p: Peaks, t0: number, t1: number) {
  const a = Math.max(0, Math.floor(t0 * p.perSec));
  const b = Math.min(p.data.length, Math.max(a + 1, Math.ceil(t1 * p.perSec)));
  let m = 0;
  for (let i = a; i < b; i++) if (p.data[i] > m) m = p.data[i];
  return a >= p.data.length ? -1 : m;
}
