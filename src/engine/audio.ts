type BeatListener = (strength: number) => void;

/** Exponential follower with separate attack and release times (seconds). */
function follow(cur: number, target: number, dt: number, attack: number, release: number) {
  const tau = target > cur ? attack : release;
  return cur + (target - cur) * (1 - Math.exp(-dt / tau));
}

/**
 * Listens to the room through the mic (the music comes out of the speakers),
 * normalises it with a slow auto-gain so mic distance doesn't matter, and
 * detects kicks with spectral flux on the low band against an adaptive threshold.
 * Everything here is read every frame by the scene, so it is plain mutable state, not React state.
 */
export class AudioEngine {
  micOn = false;
  bpm = 0;

  /** 0..1, smoothed, normalised */
  level = 0;
  bass = 0;
  mid = 0;
  high = 0;
  /** beat envelope: jumps on a hit, decays smoothly */
  kick = 0;

  private ctx?: AudioContext;
  private analyser?: AnalyserNode;
  private freq?: Uint8Array<ArrayBuffer>;
  private stream?: MediaStream;
  private peak = 0.15;
  private prevLow = 0;
  private fluxHistory: number[] = [];
  private lastBeat = 0;
  private nextTempoBeat = 0;
  private taps: number[] = [];
  private listeners = new Set<BeatListener>();

  get analyserNode() {
    return this.analyser ?? null;
  }

  onBeat(fn: BeatListener) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  async enableMic(): Promise<boolean> {
    try {
      this.stream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false },
      });
      this.ctx = new AudioContext();
      const src = this.ctx.createMediaStreamSource(this.stream);
      this.analyser = this.ctx.createAnalyser();
      this.analyser.fftSize = 2048;
      this.analyser.smoothingTimeConstant = 0.5;
      src.connect(this.analyser);
      this.freq = new Uint8Array(this.analyser.frequencyBinCount);
      this.fluxHistory = [];
      this.micOn = true;
      return true;
    } catch {
      this.micOn = false;
      return false;
    }
  }

  disableMic() {
    this.stream?.getTracks().forEach((t) => t.stop());
    void this.ctx?.close();
    this.analyser = undefined;
    this.micOn = false;
  }

  /** Returns the bpm once there are enough taps. */
  tap(now: number): number | null {
    if (now - (this.taps[this.taps.length - 1] ?? 0) > 2000) this.taps = [];
    this.taps.push(now);
    this.trigger(now, 1);
    if (this.taps.length < 3) return null;
    const t = this.taps.slice(-8);
    const avg = (t[t.length - 1] - t[0]) / (t.length - 1);
    this.bpm = 60000 / avg;
    this.nextTempoBeat = now + avg;
    return this.bpm;
  }

  clearTempo() {
    this.bpm = 0;
    this.taps = [];
  }

  /** A soft nudge from outside (e.g. a new lyric line) when nothing else drives the beat. */
  pulse(strength: number) {
    if (this.micOn || this.bpm) return;
    this.trigger(performance.now(), strength);
  }

  private trigger(now: number, s: number) {
    this.lastBeat = now;
    this.kick = Math.max(this.kick, s);
    this.listeners.forEach((f) => f(s));
  }

  private band(fromHz: number, toHz: number) {
    const a = this.analyser!;
    const hzPerBin = a.context.sampleRate / a.fftSize;
    const i0 = Math.max(1, Math.floor(fromHz / hzPerBin));
    const i1 = Math.min(this.freq!.length, Math.ceil(toHz / hzPerBin));
    let s = 0;
    for (let i = i0; i < i1; i++) s += this.freq![i];
    return s / ((i1 - i0) * 255);
  }

  update(now: number, dt: number) {
    if (this.micOn && this.analyser && this.freq) {
      this.analyser.getByteFrequencyData(this.freq);
      const low = this.band(40, 160);
      const mid = this.band(300, 2200);
      const high = this.band(4000, 12000);
      const total = low * 0.5 + mid * 0.35 + high * 0.15;

      // slow auto-gain: the loudest recent moment becomes "1"
      this.peak = Math.max(total, this.peak * Math.pow(0.5, dt / 8), 0.06);
      const g = 1 / this.peak;

      this.level = follow(this.level, Math.min(1, total * g), dt, 0.05, 0.4);
      this.bass = follow(this.bass, Math.min(1, low * g * 0.8), dt, 0.03, 0.22);
      this.mid = follow(this.mid, Math.min(1, mid * g * 0.8), dt, 0.06, 0.35);
      this.high = follow(this.high, Math.min(1, high * g), dt, 0.04, 0.3);

      // spectral flux on the low band, adaptive threshold
      const lowN = low * g;
      const flux = Math.max(0, lowN - this.prevLow);
      this.prevLow = lowN;
      const h = this.fluxHistory;
      h.push(flux);
      if (h.length > 50) h.shift();
      let mean = 0;
      for (const v of h) mean += v;
      mean /= h.length;
      let varc = 0;
      for (const v of h) varc += (v - mean) ** 2;
      const std = Math.sqrt(varc / h.length);
      if (h.length > 20 && flux > mean + 1.5 * std && flux > 0.05 && now - this.lastBeat > 270) {
        this.trigger(now, Math.min(1, 0.6 + flux * 2.5));
      }
    } else {
      // idle breathing so the room never feels dead
      const breath = 0.09 + 0.05 * Math.sin(now / 1400) + 0.02 * Math.sin(now / 530);
      this.bass = follow(this.bass, breath, dt, 0.4, 0.8);
      this.level = follow(this.level, breath, dt, 0.4, 0.8);
      this.mid = follow(this.mid, 0.05, dt, 0.5, 1);
      this.high = follow(this.high, 0, dt, 0.5, 1);
      if (this.bpm) {
        const iv = 60000 / this.bpm;
        if (now >= this.nextTempoBeat) {
          this.trigger(now, 0.85);
          this.nextTempoBeat += iv;
          if (this.nextTempoBeat < now) this.nextTempoBeat = now + iv;
        }
      }
    }
    // smooth decay, roughly a quarter note at 120bpm
    this.kick *= Math.exp(-dt * 3.6);
  }
}

export const audio = new AudioEngine();
