import type { Kind } from '../services/resolve';

/* ------------------------------------------------------------------ */
/* YouTube player (video mirror, or audio fallback without yt-dlp)     */
/* ------------------------------------------------------------------ */

let apiPromise: Promise<void> | null = null;
export function loadYouTubeApi(): Promise<void> {
  if (apiPromise) return apiPromise;
  apiPromise = new Promise<void>((resolve, reject) => {
    if (window.YT?.Player) return resolve();
    const prev = window.onYouTubeIframeAPIReady;
    window.onYouTubeIframeAPIReady = () => {
      prev?.();
      resolve();
    };
    const s = document.createElement('script');
    s.src = 'https://www.youtube.com/iframe_api';
    s.onerror = () => {
      apiPromise = null;
      reject(new Error('youtube-api'));
    };
    document.head.append(s);
  });
  return apiPromise;
}

class Deck {
  player: YT.Player | null = null;
  ready = false;
  videoId = '';
  host: HTMLElement | null = null;
  onState?: (s: number) => void;
  onError?: (code: number) => void;
  private waiters: (() => void)[] = [];

  async load(id: string, opts: { autoplay: boolean; start: number; muted: boolean }) {
    await loadYouTubeApi();
    if (!this.host) throw new Error('no host');
    const start = Math.max(0, opts.start);
    if (!this.player) {
      this.videoId = id;
      this.host.replaceChildren();
      const el = document.createElement('div');
      this.host.append(el);
      this.player = new YT.Player(el, {
        videoId: id,
        playerVars: { autoplay: 0, playsinline: 1, rel: 0, controls: 0, disablekb: 1, iv_load_policy: 3, fs: 0, start: Math.floor(start) },
        events: {
          onReady: () => {
            this.ready = true;
            this.waiters.splice(0).forEach((f) => f());
          },
          onStateChange: (e) => this.onState?.(e.data),
          onError: (e) => this.onError?.(Number(e.data)),
        },
      });
      await new Promise<void>((r) => (this.ready ? r() : this.waiters.push(r)));
    }
    const p = this.player!;
    if (opts.muted) p.mute();
    else p.unMute();
    if (this.videoId !== id || !opts.autoplay) {
      this.videoId = id;
      if (opts.autoplay) p.loadVideoById({ videoId: id, startSeconds: start });
      else p.cueVideoById({ videoId: id, startSeconds: start });
    } else {
      p.seekTo(start, true);
      p.playVideo();
    }
  }

  time() {
    return this.ready ? this.player?.getCurrentTime?.() ?? 0 : 0;
  }
}

/* ------------------------------------------------------------------ */
/* Playback                                                            */
/* ------------------------------------------------------------------ */

interface Voice {
  src: AudioBufferSourceNode;
  gain: GainNode;
}

const FADE = 0.5; // seconds, version crossfade
const equalPower = (n: number, up: boolean) =>
  Float32Array.from({ length: n }, (_, i) => {
    const x = i / (n - 1);
    return up ? Math.sin((x * Math.PI) / 2) : Math.cos((x * Math.PI) / 2);
  });

/**
 * JustMusic plays the audio itself through Web Audio. The clock is the audio hardware's:
 * getOutputTimestamp() says which sample is leaving the speakers right now, so lights and
 * lyrics follow what you hear, not an estimate. Switching versions schedules a sample-accurate
 * equal-power crossfade at the same musical moment. YouTube is used only as a muted video
 * mirror, or as the sound itself when yt-dlp isn't available.
 */
export class Playback {
  engine: 'audio' | 'youtube' = 'audio';
  ctx: AudioContext;
  analyser: AnalyserNode;
  private master: GainNode;

  buffers: Partial<Record<Kind, AudioBuffer>> = {};
  videoIds: Partial<Record<Kind, string>> = {};
  active: Kind = 'original';
  /** seconds to add to an original-version time to land on the same moment in each version */
  offsets: Record<Kind, number> = { original: 0, karaoke: 0 };
  playing = false;
  /** extra delay of your speakers (e.g. Bluetooth), seconds */
  userLatency = 0;

  events: {
    onPlayingChange?: (p: boolean) => void;
    onActiveChange?: (k: Kind) => void;
    onEnded?: () => void;
    onVideoError?: () => void;
  } = {};

  private voice: Voice | null = null;
  private anchorCtx = 0;
  private anchorDeck = 0;

  private deck = new Deck();
  private mirror = false;
  private ytLastRaw = -1;
  private ytAnchorTime = 0;
  private ytAnchorAt = 0;

  constructor() {
    this.ctx = new AudioContext({ latencyHint: 'interactive' });
    this.master = this.ctx.createGain();
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 2048;
    this.analyser.smoothingTimeConstant = 0.6;
    this.master.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.deck.onState = (s) => {
      if (this.engine === 'youtube') {
        this.setPlaying(s === 1);
        this.ytLastRaw = -1;
        if (s === 0) this.events.onEnded?.();
      }
    };
    this.deck.onError = () => this.events.onVideoError?.();
  }

  /** Lower what's playing while something else is being auditioned, and bring it back after. */
  duck(on: boolean) {
    const g = this.master.gain;
    const t = this.ctx.currentTime;
    g.cancelScheduledValues(t);
    g.setValueAtTime(g.value, t);
    g.linearRampToValueAtTime(on ? 0.14 : 1, t + (on ? 0.35 : 0.6));
  }

  setVideoHost(el: HTMLElement | null) {
    this.deck.host = el;
  }

  /** Call from a click: browsers only let audio start after a user gesture. */
  unlock() {
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  reset() {
    this.stopVoice(0.15);
    try {
      this.deck.player?.pauseVideo();
    } catch {
      /* not ready */
    }
    this.buffers = {};
    this.videoIds = {};
    this.offsets = { original: 0, karaoke: 0 };
    this.anchorDeck = 0;
    this.engine = 'audio';
    this.setPlaying(false);
  }

  has(kind: Kind) {
    return this.engine === 'audio' ? !!this.buffers[kind] : !!this.videoIds[kind];
  }

  setVideoId(kind: Kind, id: string) {
    this.videoIds[kind] = id;
  }

  setOffset(kind: Kind, s: number) {
    this.offsets[kind] = s;
  }

  /* ---------- audio engine ---------- */

  setBuffer(kind: Kind, buffer: AudioBuffer) {
    const replacing = this.engine === 'audio' && kind === this.active && this.voice && this.playing;
    this.buffers[kind] = buffer;
    if (replacing) {
      // a different take of the same version: continue where we are
      const t = this.deckTime(performance.now());
      this.offsets[kind] = 0;
      this.startVoice(kind, t, 0.25);
    }
  }

  async start(kind: Kind, at = 0) {
    this.engine = 'audio';
    this.active = kind;
    this.events.onActiveChange?.(kind);
    await this.ctx.resume();
    this.startVoice(kind, at, 0.02);
    this.setPlaying(true);
    this.syncMirror(true);
  }

  private startVoice(kind: Kind, deckTime: number, fadeIn: number) {
    const buffer = this.buffers[kind];
    if (!buffer) return;
    const ctx = this.ctx;
    const when = ctx.currentTime + 0.03;
    const old = this.voice;
    const gain = ctx.createGain();
    gain.connect(this.master);
    const src = ctx.createBufferSource();
    src.buffer = buffer;
    src.connect(gain);
    if (fadeIn > 0.05) {
      gain.gain.setValueCurveAtTime(equalPower(64, true), when, fadeIn);
    } else {
      gain.gain.setValueAtTime(0, when);
      gain.gain.linearRampToValueAtTime(1, when + 0.015);
    }
    const startAt = Math.max(0, Math.min(deckTime, buffer.duration - 0.05));
    src.start(when, startAt);
    const voice = { src, gain };
    src.onended = () => {
      if (this.voice === voice) {
        this.voice = null;
        this.anchorDeck = buffer.duration;
        this.setPlaying(false);
        this.events.onEnded?.();
      }
    };
    this.voice = voice;
    this.anchorCtx = when;
    this.anchorDeck = startAt;
    if (old) this.fadeOut(old, Math.max(0.015, fadeIn), when);
  }

  private fadeOut(v: Voice, seconds: number, when = this.ctx.currentTime) {
    v.src.onended = null;
    const g = v.gain.gain;
    g.cancelScheduledValues(when);
    if (seconds > 0.05) g.setValueCurveAtTime(equalPower(64, false), when, seconds);
    else {
      g.setValueAtTime(g.value, when);
      g.linearRampToValueAtTime(0, when + seconds);
    }
    v.src.stop(when + seconds + 0.02);
  }

  private stopVoice(seconds: number) {
    if (this.voice) this.fadeOut(this.voice, seconds);
    this.voice = null;
  }

  /** The audio context's time for the sample you are hearing right now. */
  private heard(now: number) {
    const ts = this.ctx.getOutputTimestamp?.();
    let t: number;
    if (ts && ts.contextTime !== undefined && ts.performanceTime) {
      t = ts.contextTime + (now - ts.performanceTime) / 1000;
    } else {
      t = this.ctx.currentTime - (this.ctx.outputLatency || this.ctx.baseLatency || 0);
    }
    return t - this.userLatency;
  }

  /* ---------- transport (both engines) ---------- */

  async switchTo(kind: Kind): Promise<boolean> {
    if (kind === this.active) return true;
    if (this.engine === 'youtube') return this.ytSwitch(kind);
    if (!this.buffers[kind]) return false;
    const target = this.songTime(performance.now()) + this.offsets[kind];
    this.active = kind;
    if (this.playing) this.startVoice(kind, target, FADE);
    else this.anchorDeck = Math.max(0, target);
    this.events.onActiveChange?.(kind);
    this.syncMirror(true);
    return true;
  }

  toggle() {
    if (this.engine === 'youtube') {
      const p = this.deck.player;
      if (!p || !this.deck.ready) return;
      if (this.playing) p.pauseVideo();
      else p.playVideo();
      return;
    }
    this.unlock();
    if (this.playing) {
      this.anchorDeck = this.deckTime(performance.now());
      this.stopVoice(0.04);
      this.setPlaying(false);
    } else if (this.buffers[this.active]) {
      const d = this.buffers[this.active]!.duration;
      this.startVoice(this.active, this.anchorDeck >= d - 0.1 ? 0 : this.anchorDeck, 0.04);
      this.setPlaying(true);
    }
    this.syncMirror(true);
  }

  seekDeck(t: number) {
    if (this.engine === 'youtube') {
      this.deck.player?.seekTo(Math.max(0, t), true);
      this.ytLastRaw = -1;
      return;
    }
    if (this.playing) this.startVoice(this.active, t, 0.03);
    else this.anchorDeck = Math.max(0, t);
    this.syncMirror(true);
  }

  seekBy(d: number) {
    this.seekDeck(this.deckTime(performance.now()) + d);
  }

  /** Time in the playing version's own clock, as heard. */
  deckTime(now: number): number {
    if (this.engine === 'youtube') return this.ytTime(now);
    if (!this.playing || !this.voice) return this.anchorDeck;
    const t = this.anchorDeck + (this.heard(now) - this.anchorCtx);
    return Math.max(this.anchorDeck, t);
  }

  /** Time in the original version's clock (lyrics are written against it). */
  songTime(now: number) {
    return this.deckTime(now) - this.offsets[this.active];
  }

  duration() {
    if (this.engine === 'youtube') return this.deck.ready ? this.deck.player?.getDuration?.() ?? 0 : 0;
    return this.buffers[this.active]?.duration ?? 0;
  }

  /* ---------- YouTube: fallback sound, or muted mirror for the video panel ---------- */

  async startYouTube(kind: Kind) {
    this.engine = 'youtube';
    this.active = kind;
    this.events.onActiveChange?.(kind);
    await this.deck.load(this.videoIds[kind]!, { autoplay: true, start: 0, muted: false });
  }

  private async ytSwitch(kind: Kind) {
    const id = this.videoIds[kind];
    if (!id) return false;
    const target = this.songTime(performance.now()) + this.offsets[kind];
    this.active = kind;
    this.ytLastRaw = -1;
    await this.deck.load(id, { autoplay: this.playing, start: target, muted: false });
    this.events.onActiveChange?.(kind);
    return true;
  }

  private ytTime(now: number) {
    if (!this.deck.ready) return 0;
    const raw = this.deck.time();
    if (raw !== this.ytLastRaw) {
      this.ytLastRaw = raw;
      this.ytAnchorTime = raw;
      this.ytAnchorAt = now;
    }
    if (!this.playing) return raw;
    return Math.min(this.ytAnchorTime + (now - this.ytAnchorAt) / 1000, raw + 0.5);
  }

  /** Show the video panel: a muted YouTube player kept in step with our audio. */
  setMirror(on: boolean) {
    this.mirror = on;
    this.syncMirror(true);
  }

  /** Called every frame by the scene; cheap unless the mirror drifted. */
  syncMirror(force = false) {
    if (this.engine !== 'audio') return;
    const id = this.videoIds[this.active];
    if (!this.mirror || !id) {
      if (force) {
        try {
          this.deck.player?.pauseVideo();
        } catch {
          /* not ready */
        }
      }
      return;
    }
    const want = this.deckTime(performance.now());
    if (this.deck.videoId !== id || !this.deck.ready) {
      if (force) void this.deck.load(id, { autoplay: this.playing, start: want, muted: true }).catch(() => undefined);
      return;
    }
    const p = this.deck.player!;
    if (force) {
      p.mute();
      if (this.playing) p.playVideo();
      else p.pauseVideo();
    }
    if (Math.abs(this.deck.time() - want) > 0.35) p.seekTo(want, true);
  }

  private setPlaying(p: boolean) {
    if (p === this.playing) return;
    this.playing = p;
    this.events.onPlayingChange?.(p);
  }
}

export const playback = new Playback();
