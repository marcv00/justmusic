/**
 * The light designer.
 *
 * Base layer: soft zones of the wall that rise and fall slowly, one fading out while the next
 * fades in (the default for everything, and all a calm song ever gets).
 * Accents: shapes born in the centre that grow out of frame, fired by what the music actually
 * does (a punchy bass hit → circle, a sharp peak like a snare or crash → square), with a rest
 * between them so they never pile up.
 * Dance looks (sweep, columns, checker, radar) appear only in sections with real drive, i.e.
 * many sharp hits per second, which a ballad never has however loud it gets.
 */

export const LOOK = { BREATHE: 0, RINGS: 1, SWEEP: 2, RADAR: 3, CHECKER: 4, COLUMNS: 5, DRIFT: 6 } as const;
export const SHAPE = { CIRCLE: 0, SQUARE: 1, DIAMOND: 2 } as const;
export const RING_SLOTS = 10;

export type Tier = 'calm' | 'groove' | 'peak';

const POOLS: Record<Tier, number[]> = {
  calm: [LOOK.DRIFT],
  groove: [LOOK.DRIFT, LOOK.DRIFT, LOOK.SWEEP],
  peak: [LOOK.DRIFT, LOOK.COLUMNS, LOOK.SWEEP, LOOK.CHECKER, LOOK.RADAR],
};

/** How accents behave per mood: minimum rest between shapes, travel time, how strong a hit must be. */
const ACCENT: Record<Tier, { rest: number; travel: number; bass: number; peak: number }> = {
  calm: { rest: 5, travel: 7, bass: 0.9, peak: 2 },
  groove: { rest: 2.4, travel: 4.8, bass: 0.72, peak: 0.88 },
  peak: { rest: 1.3, travel: 3.4, bass: 0.6, peak: 0.8 },
};

/** Sharp hits per second → mood. Absolute, so a quiet ballad stays calm at its loudest. */
export function tierFor(drive: number, energy: number, bpm: number): Tier {
  if (drive < 1.6 || (bpm < 80 && drive < 2.2)) return 'calm';
  if (drive > 2.6 && energy > 0.5) return 'peak';
  return 'groove';
}

export class Choreo {
  /** look A, look B, mix 0..1 */
  look: [number, number, number] = [LOOK.DRIFT, LOOK.DRIFT, 1];
  /** beat phase, slow phase (over 2 bars), beat index, bar index */
  beatInfo: [number, number, number, number] = [0, 0, 0, 0];
  /** beat period (s), light decay (s) */
  timing: [number, number] = [0.6, 0.6];
  /** per shape: birth (clock s), strength, shape, travel (s) */
  rings = new Float32Array(RING_SLOTS * 4).fill(-1000);
  tier: Tier = 'calm';

  private a = LOOK.DRIFT as number;
  private b = LOOK.DRIFT as number;
  private mixT = 1;
  private mixDur = 2;
  private ringIdx = 0;
  private beatIdx = 0;
  private barIdx = 0;
  private barBeat = 0;
  private lastAccent = -100;
  private rand: () => number = Math.random;

  setRandom(r: () => number) {
    this.rand = r;
  }

  private cut(look: number, seconds: number) {
    if (look === this.b && this.mixT >= 1) return;
    this.a = this.b;
    this.b = look;
    this.mixT = 0;
    this.mixDur = Math.max(0.1, seconds);
  }

  private pick() {
    const pool = POOLS[this.tier];
    const options = pool.length > 1 ? pool.filter((l) => l !== this.b) : pool;
    return options[Math.floor(this.rand() * options.length)];
  }

  setTier(t: Tier) {
    if (t === this.tier) return;
    this.tier = t;
    if (!POOLS[t].includes(this.b)) this.cut(this.pick(), 3);
  }

  ring(birth: number, strength: number, shape: number, travel: number) {
    const k = this.ringIdx * 4;
    this.rings[k] = birth;
    this.rings[k + 1] = strength;
    this.rings[k + 2] = shape;
    this.rings[k + 3] = Math.max(0.5, travel);
    this.ringIdx = (this.ringIdx + 1) % RING_SLOTS;
  }

  /** A new section began: settle into its mood; a drop gets one big, slow bloom from the centre. */
  section(tier: Tier, drop: boolean, clock: number) {
    this.setTier(tier);
    if (drop) {
      this.ring(clock, 1.5, SHAPE.CIRCLE, ACCENT[tier].travel * 1.2);
      this.lastAccent = clock;
      if (tier === 'peak') this.cut(this.pick(), 0.6);
    }
  }

  /**
   * Something happened in the music. `kind` says what, `strength` how hard (0..1, relative to
   * this song). Only strong enough hits, and only after a rest, become a shape.
   */
  accent(kind: 'bass' | 'peak', strength: number, clock: number) {
    const cfg = ACCENT[this.tier];
    if (strength < (kind === 'bass' ? cfg.bass : cfg.peak)) return;
    if (clock - this.lastAccent < cfg.rest) return;
    this.lastAccent = clock;
    const shape = kind === 'bass' ? SHAPE.CIRCLE : this.tier === 'peak' && this.rand() < 0.4 ? SHAPE.DIAMOND : SHAPE.SQUARE;
    this.ring(clock, 0.65 + 0.45 * strength, shape, cfg.travel * (1.15 - 0.3 * strength));
  }

  /** The beat grid: only advances counters and changes looks on long phrases. */
  beat(downbeat: boolean) {
    this.beatIdx++;
    if (downbeat) {
      this.barIdx++;
      this.barBeat = 0;
      if (this.barIdx % 8 === 0 && POOLS[this.tier].length > 1) this.cut(this.pick(), this.timing[0] * 4);
    } else this.barBeat = (this.barBeat + 1) % 4;
  }

  frame(dt: number, beatPhase: number, period: number, energy: number) {
    this.mixT = Math.min(1, this.mixT + dt / this.mixDur);
    const eased = this.mixT * this.mixT * (3 - 2 * this.mixT);
    this.look = [this.a, this.b, eased];
    // dance looks move on a two-bar cycle and step every two beats: deliberate, not frantic
    const slow = ((this.barIdx % 2) * 4 + this.barBeat + beatPhase) / 8;
    this.beatInfo = [beatPhase, slow, Math.floor(this.beatIdx / 2), Math.floor(this.barIdx / 2)];
    const tierMul = this.tier === 'calm' ? 2 : this.tier === 'groove' ? 1.1 : 0.6;
    this.timing = [period, Math.min(3, Math.max(0.2, period * tierMul * (1.2 - 0.3 * energy)))];
  }
}
