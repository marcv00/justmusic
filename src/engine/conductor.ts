import type { Analysis, BandEvents } from './analysisTypes';
import { audio } from './audio';
import { Choreo, tierFor } from './choreo';
import { EMBER, PALETTES, seeded, type Palette } from './palettes';

export type Hit = 'kick' | 'snare' | 'drop';

export interface LightState {
  low: number;
  mid: number;
  high: number;
  kick: number;
  snare: number;
  energy: number;
  riser: number;
  flash: number;
  palA: Palette;
  palB: Palette;
  palMix: number;
  /** true when lights follow a pre-analysed track */
  locked: boolean;
  /** seconds; the clock ring births are measured on */
  clock: number;
  bpm: number;
}

const LOOKAHEAD = 0.012; // the clock is what you hear; this only covers the frame being drawn
const follow = (cur: number, target: number, dt: number, up: number, down: number) =>
  cur + (target - cur) * (1 - Math.exp(-dt / (target > cur ? up : down)));

function upper(arr: Float32Array, t: number) {
  let lo = 0, hi = arr.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (arr[m] <= t) lo = m + 1;
    else hi = m;
  }
  return lo;
}

/**
 * The lighting director. With an analysed track it reads the song's beat grid, onsets and
 * sections ahead of time and fires them on the music; without one it follows the mic, or
 * breathes on its own. It owns the colour scenes; the choreography (which shapes move
 * where, and when) lives in Choreo.
 */
export class Conductor {
  state: LightState = {
    low: 0.1, mid: 0, high: 0, kick: 0, snare: 0, energy: 0.3, riser: 0, flash: 0,
    palA: EMBER, palB: EMBER, palMix: 1, locked: false, clock: 0, bpm: 75,
  };
  choreo = new Choreo();

  private analysis: Analysis | null = null;
  private rand = seeded('justmusic');
  private lastT = -1;
  private lastNow = 0;
  private cur = { beat: 0, section: -1 };
  private sectionEnergy = 0.3;
  private schedule: Palette[] = [];
  private artPalette: Palette | null = null;
  private performing = false;
  private freeBeats = 0;
  private freeClock = 0;
  private freeLast = 0;
  private freeIntervals: number[] = [];
  private epoch = performance.now();
  private listeners = new Set<(h: Hit, s: number) => void>();

  constructor() {
    audio.onBeat((s) => {
      if (!this.state.locked) this.freeBeat(s);
    });
  }

  onHit(fn: (h: Hit, s: number) => void) {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }
  private emit(h: Hit, s: number) {
    this.listeners.forEach((f) => f(h, s));
  }

  setPerforming(on: boolean) {
    this.performing = on;
    if (!on) {
      this.setTrack(null, 'home');
      this.artPalette = null;
      this.crossfade(EMBER, 2.5);
    }
  }

  setArtPalette(p: Palette | null) {
    this.artPalette = p;
    if (p && this.performing && this.cur.section <= 0) this.crossfade(p, 1.8);
  }

  /** Attach the analysis of the version that is playing (null = follow mic / breathe). */
  setTrack(a: Analysis | null, seed: string) {
    this.analysis = a;
    this.rand = seeded(seed);
    this.choreo.setRandom(seeded(seed + ':cues'));
    this.lastT = -1;
    this.cur = { beat: 0, section: -1 };
    if (a) {
      this.schedule = this.buildSchedule(a);
      this.state.bpm = a.bpm;
    }
  }

  private buildSchedule(a: Analysis): Palette[] {
    const out: Palette[] = [];
    let prev: Palette | null = null;
    a.sections.forEach((s, i) => {
      if (i === 0 && this.artPalette) {
        out.push(this.artPalette);
        prev = this.artPalette;
        return;
      }
      const ranked = PALETTES.filter((p) => p !== prev)
        .map((p) => ({ p, d: Math.abs(p.heat - s.energy) + this.rand() * 0.35 }))
        .sort((x, y) => x.d - y.d);
      const pick = s.energy > 0.55 && this.artPalette && i % 3 === 0 && prev !== this.artPalette ? this.artPalette : ranked[0].p;
      out.push(pick);
      prev = pick;
    });
    return out;
  }

  private palClock = 0;
  private palDur = 1;
  private crossfade(p: Palette, seconds: number) {
    const st = this.state;
    if (p === st.palB && st.palMix >= 1) return;
    st.palA = st.palMix >= 0.5 ? st.palB : st.palA;
    st.palB = p;
    st.palMix = 0;
    this.palClock = 0;
    this.palDur = Math.max(0.05, seconds);
  }

  private beatAt(strength: number, downbeat: boolean) {
    this.state.kick = Math.max(this.state.kick, strength * 0.35);
    this.choreo.beat(downbeat);
  }

  private fireEv(ev: BandEvents, from: number, to: number, fn: (s: number, r: number, at: number) => void) {
    for (let i = upper(ev.t, from); i < ev.t.length && ev.t[i] <= to; i++) fn(ev.s[i], ev.r?.[i] ?? 3, ev.t[i]);
  }

  private sample(a: Analysis, arr: Float32Array, t: number) {
    const f = Math.min(arr.length - 1, Math.max(0, Math.round((t - a.t0) * a.fps)));
    return arr[f];
  }

  update(dt: number, now: number, trackTime: number | null, playing: boolean) {
    const st = this.state;
    const a = this.analysis;
    audio.update(now, dt);
    st.clock = (now - this.epoch) / 1000;
    st.locked = !!a && trackTime !== null;
    let beatPhase = 0;
    let period = 60 / st.bpm;

    if (a && trackTime !== null) {
      const t = trackTime + LOOKAHEAD;
      // a jump is a seek or a version switch: the song moved by something other than elapsed time
      // (compare with real elapsed time: the frame dt is capped for smooth animation)
      const moved = t - this.lastT;
      const elapsed = (now - this.lastNow) / 1000;
      const jumped = this.lastT < 0 || Math.abs(moved - (playing ? elapsed : 0)) > 0.35;
      if (jumped) {
        this.cur.beat = upper(a.beats, t);
        const si = Math.max(0, a.sections.findIndex((s) => t >= s.start && t < s.end));
        if (si !== this.cur.section) this.enterSection(si, true);
      } else if (playing && t > this.lastT) {
        const from = this.lastT;
        // punchy bass: a strong low hit that comes out of a quieter moment
        this.fireEv(a.events.low, from, t, (s, r, at) => {
          st.kick = Math.max(st.kick, s);
          if (s > 0.45) this.emit('kick', s);
          const before = this.sample(a, a.pump, at - 0.15);
          if (r > 2 && before < 0.55) this.choreo.accent('bass', s, st.clock);
        });
        // sharp peaks: snare, clap, crash
        this.fireEv(a.events.mid, from, t, (s, r) => {
          st.snare = Math.max(st.snare, s);
          if (s > 0.7 && this.sectionEnergy > 0.5) this.emit('snare', s);
          if (r > 2.6) this.choreo.accent('peak', s, st.clock);
        });
        this.fireEv(a.events.high, from, t, (s, r) => {
          if (r > 3.2 && s > 0.9) this.choreo.accent('peak', s * 0.95, st.clock);
        });
        while (this.cur.beat < a.beats.length && a.beats[this.cur.beat] <= t) {
          this.beatAt(0.85, a.downbeats[this.cur.beat] === 1);
          this.cur.beat++;
        }
        const next = a.sections[this.cur.section + 1];
        if (next && t >= next.start) this.enterSection(this.cur.section + 1, false);
      }
      this.lastT = t;
      this.lastNow = now;

      const f = Math.min(a.low.length - 1, Math.max(0, (t - a.t0) * a.fps));
      const i0 = Math.floor(f), k = f - i0, i1 = Math.min(a.low.length - 1, i0 + 1);
      const lerp = (arr: Float32Array) => arr[i0] + (arr[i1] - arr[i0]) * k;
      const gate = playing ? 1 : 0.15;
      st.low = follow(st.low, lerp(a.pump) * gate, dt, 0.006, 0.05);
      st.mid = follow(st.mid, lerp(a.mid) * gate, dt, 0.03, 0.18);
      st.high = follow(st.high, lerp(a.high) * gate, dt, 0.02, 0.1);

      const b = Math.max(1, this.cur.beat) - 1;
      const b0 = a.beats[b] ?? 0, b1 = a.beats[b + 1] ?? b0 + period;
      period = Math.max(0.2, b1 - b0);
      beatPhase = playing ? Math.min(1, Math.max(0, (t - b0) / period)) : 0;
      const nx = a.sections[this.cur.section + 1];
      const curS = a.sections[this.cur.section];
      if (nx && curS && (nx.drop || nx.energy - curS.energy > 0.2)) {
        const win = (8 * 60) / a.bpm;
        st.riser = Math.pow(Math.min(1, Math.max(0, 1 - (nx.start - t) / win)), 2);
      } else st.riser = follow(st.riser, 0, dt, 0.1, 0.3);
    } else {
      this.lastT = -1;
      st.low = follow(st.low, audio.bass, dt, 0.03, 0.2);
      st.mid = follow(st.mid, audio.mid, dt, 0.05, 0.3);
      st.high = follow(st.high, audio.high, dt, 0.03, 0.2);
      st.riser = follow(st.riser, 0, dt, 0.1, 0.5);
      if (!audio.micOn && !audio.bpm) {
        // nothing to listen to: a slow, steady pulse so the room is never still
        const p = this.performing ? 1.4 : 2.2;
        this.freeClock += dt;
        if (this.freeClock >= p) {
          this.freeClock -= p;
          this.freeBeat(0.45);
        }
        st.bpm = 60 / p;
        period = p;
        beatPhase = this.freeClock / p;
      } else {
        period = 60 / st.bpm;
        beatPhase = Math.min(1, (now - this.freeLast) / 1000 / period);
      }
      this.sectionEnergy = this.performing ? Math.max(0.3, Math.min(0.9, audio.level * 1.1)) : 0.25;
    }

    st.kick *= Math.exp(-dt * 8);
    st.snare *= Math.exp(-dt * 6);
    st.flash *= Math.exp(-dt * 3.5);
    st.energy = follow(st.energy, this.sectionEnergy, dt, 0.6, 2.5);
    if (!st.locked) {
      // without an analysed track: calm unless the mic hears a steady, quick beat
      const hearing = audio.micOn || audio.bpm;
      this.choreo.setTier(hearing && st.bpm > 95 && audio.level > 0.45 ? 'groove' : 'calm');
    }
    this.choreo.frame(dt, beatPhase, period, st.energy);

    this.palClock += dt;
    st.palMix = Math.min(1, this.palClock / this.palDur);
  }

  private enterSection(i: number, immediate: boolean) {
    const a = this.analysis;
    if (!a) return;
    this.cur.section = i;
    const s = a.sections[i];
    this.sectionEnergy = s.energy;
    const pal = this.schedule[i] ?? EMBER;
    const drop = !immediate && s.drop;
    if (immediate) this.crossfade(pal, 0.8);
    else if (drop) {
      this.crossfade(pal, 0.12);
      this.state.flash = 1;
      this.state.riser = 0;
      this.emit('drop', 1);
    } else this.crossfade(pal, 1.8);
    this.choreo.section(tierFor(s.drive ?? 2, s.energy, a.bpm), drop, this.state.clock);
  }

  /** Beats without an analysed track (mic, tap tempo, or breathing). New colour scene every 32 beats. */
  private freeBeat(strength: number) {
    const now = performance.now();
    if (this.freeLast) {
      // estimate the tempo from recent beats so fades and travel follow it
      this.freeIntervals.push((now - this.freeLast) / 1000);
      if (this.freeIntervals.length > 8) this.freeIntervals.shift();
      const sorted = [...this.freeIntervals].sort((x, y) => x - y);
      const med = sorted[sorted.length >> 1];
      if (med > 0.25 && med < 2.5) this.state.bpm = 60 / med;
    }
    this.freeLast = now;
    const n = this.freeBeats++;
    this.beatAt(strength, n % 4 === 0);
    // heard beats (mic or tapped) can still call a shape, if they're hard enough
    if (audio.micOn || audio.bpm) this.choreo.accent('bass', strength, this.state.clock);
    if (this.performing && n > 0 && n % 32 === 0) {
      const options = PALETTES.filter((p) => p !== this.state.palB);
      const pool = this.artPalette ? [...options, this.artPalette, this.artPalette] : options;
      this.crossfade(pool[Math.floor(this.rand() * pool.length)], 2);
    }
  }
}

export const conductor = new Conductor();
