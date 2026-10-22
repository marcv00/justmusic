import { api } from '../services/api';

/** A lighting scene: the colour washing the concrete and three colours behind the openings. */
export interface Palette {
  name: string;
  wall: string;
  lights: [string, string, string];
  /** 0 = cool and calm, 1 = hot; used to match palettes to a section's energy */
  heat: number;
}

export const EMBER: Palette = { name: 'Brasa', wall: '#c4131b', lights: ['#ff3324', '#62d8ff', '#3d6bff'], heat: 0.7 };

export const PALETTES: Palette[] = [
  EMBER,
  { name: 'Abismo', wall: '#14249e', lights: ['#ff2a3c', '#62d8ff', '#ff8a3d'], heat: 0.45 },
  { name: 'Orquídea', wall: '#6a1291', lights: ['#ff4fd8', '#62d8ff', '#ffd166'], heat: 0.8 },
  { name: 'Sodio', wall: '#a8360c', lights: ['#ffb347', '#ff3b2f', '#62d8ff'], heat: 0.85 },
  { name: 'Glaciar', wall: '#0c3c8a', lights: ['#9ff0ff', '#ffffff', '#5a7dff'], heat: 0.2 },
  { name: 'Ácido', wall: '#0b6150', lights: ['#b6ff3b', '#ff3b8d', '#3bd6ff'], heat: 0.95 },
  { name: 'Rosa', wall: '#a3124f', lights: ['#ff9ad5', '#ff3b5c', '#7fe6ff'], heat: 0.6 },
  { name: 'Medianoche', wall: '#2a0f6e', lights: ['#7a5cff', '#ff4fa3', '#62d8ff'], heat: 0.35 },
];

/* ---------------- colour utils ---------------- */
function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}
export function hsl(h: number, s: number, l: number) {
  h = ((h % 360) + 360) % 360;
  const a = s * Math.min(l, 1 - l);
  const f = (n: number) => {
    const k = (n + h / 30) % 12;
    return Math.round(255 * (l - a * Math.max(-1, Math.min(k - 3, 9 - k, 1))));
  };
  return `#${[f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('')}`;
}

/**
 * Build a lighting palette from album art: the most present vivid hues become the lights,
 * the dominant one, darkened and saturated, becomes the wall. Greys and near-blacks are
 * ignored so a dark cover still yields colour. Missing hues are filled with harmonies.
 */
export async function paletteFromArt(url: string): Promise<{ palette: Palette; glow: string } | null> {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = api.imageUrl(url);
  try {
    await img.decode();
  } catch {
    return null;
  }
  const S = 48;
  const c = document.createElement('canvas');
  c.width = c.height = S;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  // sample the centre square (video thumbnails are 16:9)
  const side = Math.min(img.naturalWidth, img.naturalHeight);
  ctx.drawImage(img, (img.naturalWidth - side) / 2, (img.naturalHeight - side) / 2, side, side, 0, 0, S, S);
  const px = ctx.getImageData(0, 0, S, S).data;

  const BINS = 24;
  const weight = new Float32Array(BINS);
  const sat = new Float32Array(BINS);
  for (let i = 0; i < px.length; i += 4) {
    const [h, s, l] = rgbToHsl(px[i], px[i + 1], px[i + 2]);
    if (s < 0.22 || l < 0.1 || l > 0.92) continue;
    const b = Math.floor(h / (360 / BINS)) % BINS;
    const w = s * (1 - Math.abs(l - 0.5) * 1.4);
    weight[b] += w;
    sat[b] += s * w;
  }
  const order = [...weight.keys()].sort((a, b) => weight[b] - weight[a]);
  const hues: number[] = [];
  for (const b of order) {
    if (weight[b] <= 0) break;
    const h = (b + 0.5) * (360 / BINS);
    if (hues.every((x) => Math.min(Math.abs(x - h), 360 - Math.abs(x - h)) > 38)) hues.push(h);
    if (hues.length === 3) break;
  }
  if (!hues.length) return null;
  const main = hues[0];
  while (hues.length < 3) hues.push(main + (hues.length === 1 ? 165 : 205));

  const lights = hues.map((h, i) => hsl(h, 0.92, i === 0 ? 0.58 : 0.62)) as [string, string, string];
  const warm = (h: number) => (h < 70 || h > 300 ? 1 : 0);
  return {
    palette: { name: 'Portada', wall: hsl(main, 0.85, 0.3), lights, heat: 0.4 + 0.4 * warm(main) },
    glow: hsl(main, 0.9, 0.55),
  };
}

/** Deterministic shuffle so the same song always gets the same light show. */
export function seeded(seed: string) {
  let h = 2166136261;
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 16777619);
  return () => {
    h += 0x6d2b79f5;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
