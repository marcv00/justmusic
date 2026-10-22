import { api, type LyricCandidate, type Song } from './api';
import { parseLRC, formatTime, type LyricLine } from './lyrics';

/**
 * A lyric source the person can pick. Its timeline is either the reference recording
 * (catalogue lyrics: JustMusic lines it up with the singer automatically), a specific video
 * (that video's own subtitles: exact as is), or nothing yet (plain text: JustMusic times it).
 */
export interface LyricOption {
  key: string;
  label: string;
  detail: string;
  kind: 'reference' | 'video' | 'plain';
  lines: LyricLine[];
  plain?: string[];
  duration?: number;
  videoId?: string;
  rank: number;
}

export function toOption(c: LyricCandidate, videoId?: string): LyricOption | null {
  if (c.source === 'youtube') {
    const lines = parseLRC(c.lrc);
    if (lines.length < 4) return null;
    return {
      key: c.key,
      label: c.auto ? 'Subtítulos automáticos del video' : 'Subtítulos del video',
      detail: c.auto ? 'Generados por YouTube; pueden fallar' : 'Sincronizados con este video',
      kind: 'video',
      lines,
      videoId,
      rank: c.auto ? 5 : 1,
    };
  }
  if (c.lrc) {
    const lines = parseLRC(c.lrc);
    if (!lines.length) return null;
    return {
      key: c.key,
      label: `LRCLIB · ${c.artist} – ${c.title}`,
      detail: `Sincronizada${c.duration ? ` · ${formatTime(c.duration)}` : ''} · la alineo con la voz`,
      kind: 'reference',
      lines,
      duration: c.duration,
      rank: 2,
    };
  }
  if (c.plain) {
    const plain = c.plain.split(/\r?\n/).map((l) => l.trim());
    if (plain.filter(Boolean).length < 4) return null;
    return {
      key: c.key,
      label: `LRCLIB · ${c.artist} – ${c.title}`,
      detail: 'Sin tiempos · la cronometro con la voz (aproximada)',
      kind: 'plain',
      lines: [],
      plain,
      duration: c.duration,
      rank: 4,
    };
  }
  return null;
}

export async function catalogueOptions(song: Song, signal?: AbortSignal) {
  const list = await api.lyrics(song, signal);
  return list.map((c) => toOption(c)).filter((o): o is LyricOption => !!o);
}

export async function queryOptions(q: string, signal?: AbortSignal) {
  const list = await api.lyricsQuery(q, signal);
  return list.map((c) => toOption(c)).filter((o): o is LyricOption => !!o);
}

export async function captionOptions(videoId: string, signal?: AbortSignal) {
  const list = await api.captions(videoId, signal);
  return list.map((c) => toOption(c, videoId)).filter((o): o is LyricOption => !!o);
}

/** Best first: a reference lyric whose length matches the chosen recording is the safest bet. */
export function rankOptions(opts: LyricOption[], videoDuration?: number) {
  const score = (o: LyricOption) => {
    let s = o.rank;
    if (o.kind === 'reference' && videoDuration && o.duration) {
      const d = Math.abs(o.duration - videoDuration);
      s += d < 3 ? -1.5 : d < 15 ? -0.5 : 0.5;
    }
    return s;
  };
  return [...opts].sort((a, b) => score(a) - score(b));
}
