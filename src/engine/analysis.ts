import { api } from '../services/api';
import { ANALYSIS_RATE, type Analysis } from './analysisTypes';

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: any) => void; reject: (e: Error) => void }>();

function rpc<T>(msg: Record<string, unknown>, transfer: Transferable[] = []): Promise<T> {
  if (!worker) {
    worker = new Worker(new URL('./analysis.worker.ts', import.meta.url), { type: 'module' });
    worker.onmessage = (e) => {
      const p = pending.get(e.data.id);
      if (!p) return;
      pending.delete(e.data.id);
      if (e.data.error) p.reject(new Error(e.data.error));
      else p.resolve(e.data.result);
    };
  }
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve, reject });
    worker!.postMessage({ ...msg, id }, transfer);
  });
}

export class AudioUnavailable extends Error {}

export interface Track {
  id: string;
  buffer: AudioBuffer;
  analysis: Promise<Analysis>;
}

/** Decoded audio is large (~90 MB per version), so only the most recent few stay in memory. */
const cache = new Map<string, Promise<Track>>();
const MAX_TRACKS = 4;
function remember(id: string, job: Promise<Track>) {
  cache.delete(id);
  cache.set(id, job);
  while (cache.size > MAX_TRACKS) cache.delete(cache.keys().next().value as string);
}

/**
 * Download a video's audio through the local server, decode it once at full quality for
 * playback, and in parallel resample a mono copy for the analysis worker. Cached per video.
 */
export function loadTrack(id: string, ctx: AudioContext, onProgress?: (p: number | null) => void): Promise<Track> {
  const hit = cache.get(id);
  if (hit) {
    remember(id, hit); // most recently used
    return hit;
  }
  const job = (async () => {
    const r = await fetch(api.audioUrl(id));
    if (r.status === 501) throw new AudioUnavailable('yt-dlp not installed');
    if (!r.ok || !r.body) throw new Error(`audio ${r.status}`);
    const total = Number(r.headers.get('content-length')) || 0;
    const reader = r.body.getReader();
    const chunks: Uint8Array[] = [];
    let got = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(value);
      got += value.length;
      onProgress?.(total ? got / total : null);
    }
    const bytes = new Uint8Array(got);
    let o = 0;
    for (const c of chunks) {
      bytes.set(c, o);
      o += c.length;
    }
    const buffer = await ctx.decodeAudioData(bytes.buffer);
    const analysis = (async () => {
      const off = new OfflineAudioContext(1, Math.ceil(buffer.duration * ANALYSIS_RATE), ANALYSIS_RATE);
      const src = off.createBufferSource();
      src.buffer = buffer;
      src.connect(off.destination);
      src.start();
      const mono = new Float32Array((await off.startRendering()).getChannelData(0));
      return rpc<Analysis>({ type: 'analyze', channels: [mono] }, [mono.buffer]);
    })();
    return { id, buffer, analysis };
  })();
  remember(id, job);
  job.catch(() => cache.delete(id));
  return job;
}

/** Seconds to add to a time in `a` to land on the same musical moment in `b`. */
export function alignAnalyses(a: Analysis, b: Analysis) {
  return rpc<{ offset: number; confidence: number }>({
    type: 'align',
    a: { perc: a.perc, shape: a.shape },
    b: { perc: b.perc, shape: b.shape },
    fps: a.fps,
  });
}

interface VoiceArgs {
  original: Analysis;
  karaoke?: Analysis;
  /** karaoke time = original time + this */
  karaokeOffset: number;
}
const voiceInput = (v: VoiceArgs) => ({
  voiceO: v.original.voice,
  voiceK: v.karaoke?.voice,
  offK: v.karaokeOffset,
  fps: v.original.fps,
  t0: v.original.t0,
});

/** Seconds the lyrics' timeline sits later in the original recording (positive = intro is longer). */
export function alignLyricsToVoice(v: VoiceArgs, lines: { t: number; text: string }[]) {
  return rpc<{ offset: number; confidence: number; strength: number }>({ type: 'alignLyrics', input: { ...voiceInput(v), lines } });
}

/** Start times for untimed lines, from where the singing happens. */
export function timePlainLyrics(v: VoiceArgs, lines: string[]) {
  return rpc<number[]>({ type: 'autoTime', input: { ...voiceInput(v), lines } });
}
