export interface LyricLine {
  t: number;
  text: string;
}

export function parseLRC(src: string | null | undefined): LyricLine[] {
  if (!src) return [];
  const out: LyricLine[] = [];
  for (const raw of src.split(/\r?\n/)) {
    const tags = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!tags.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of tags) out.push({ t: Number(m[1]) * 60 + Number(m[2]), text });
  }
  out.sort((a, b) => a.t - b.t);
  // collapse runs of empty lines into one breath
  return out.filter((l, i) => l.text || (i > 0 && out[i - 1].text !== ''));
}

export const formatTime = (s: number) => {
  const v = Math.max(0, Math.floor(s));
  return `${Math.floor(v / 60)}:${String(v % 60).padStart(2, '0')}`;
};
