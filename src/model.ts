export type Mode = 'karaoke' | 'lipsync';

export interface Settings {
  intensity: number;
  projector: boolean;
  visual: 'wall' | 'wave';
  glass: boolean;
  glassAmount: number;
  /** extra delay of your speakers, ms (Bluetooth is often 150–250) */
  lightDelay: number;
  /** how fast long titles drift, px/s */
  marqueeSpeed: number;
  /** casting of the wall */
  wallShape: 'lattice' | 'rings' | 'hex';
  /** seconds a drifting zone of light takes to rise and fall */
  zoneSeconds: number;
}

export const kindFor = (m: Mode) => (m === 'karaoke' ? 'karaoke' : 'original') as 'karaoke' | 'original';
