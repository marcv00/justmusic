export const ANALYSIS_RATE = 22050;

export interface BandEvents {
  /** seconds */
  t: Float32Array;
  /** 0..1 */
  s: Float32Array;
  /** sharpness: how far the onset stands above its surroundings */
  r: Float32Array;
}

export interface Section {
  start: number;
  end: number;
  /** 0..1 relative to the rest of the song */
  energy: number;
  /** a big rise in energy from the previous section */
  drop: boolean;
  /** sharp hits per second (absolute, comparable across songs) */
  drive?: number;
}

export interface Analysis {
  fps: number;
  /** time of frame 0's centre; envelope index = (t - t0) * fps */
  t0: number;
  duration: number;
  low: Float32Array;
  mid: Float32Array;
  high: Float32Array;
  perc: Float32Array;
  shape: Float32Array;
  /** bass loudness against its recent range, 0..1: what makes the lights pump */
  pump: Float32Array;
  /** log energy of the voice band (300–3400 Hz), raw, for lining lyrics up with the singer */
  voice: Float32Array;
  bpm: number;
  beats: Float32Array;
  downbeats: Uint8Array;
  sections: Section[];
  events: { low: BandEvents; mid: BandEvents; high: BandEvents };
}

export type AnalysisStage = 'downloading' | 'decoding' | 'analyzing';
