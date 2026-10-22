/** Client for the local JustMusic API (see server/justMusicApi.ts). */

export interface Song {
  key: string;
  title: string;
  artist: string;
  album?: string;
  duration?: number;
  art?: string;
}

export interface Video {
  id: string;
  title: string;
  channel: string;
  duration: number;
  thumb: string;
}

export interface LyricCandidate {
  key: string;
  source: 'lrclib' | 'youtube';
  title: string;
  artist: string;
  duration?: number;
  lrc?: string;
  plain?: string;
  auto?: boolean;
  lang?: string;
}

async function get<T>(path: string, signal?: AbortSignal): Promise<T> {
  const r = await fetch(path, { signal });
  if (!r.ok) throw new Error(`${path} → ${r.status}`);
  return r.json() as Promise<T>;
}

export const api = {
  health: () => get<{ ytdlp: string | null }>('/api/health'),
  songs: (q: string, signal?: AbortSignal) => get<Song[]>(`/api/songs?q=${encodeURIComponent(q)}`, signal),
  search: (q: string, signal?: AbortSignal) =>
    get<{ songs: Song[]; videos: Video[] }>(`/api/search?q=${encodeURIComponent(q)}`, signal),
  videos: (q: string, signal?: AbortSignal) => get<Video[]>(`/api/videos?q=${encodeURIComponent(q)}`, signal),
  video: (id: string, signal?: AbortSignal) => get<Video>(`/api/video?id=${id}`, signal),
  lyrics: (s: Song, signal?: AbortSignal) =>
    get<LyricCandidate[]>(
      `/api/lyrics?${new URLSearchParams({
        track: s.title,
        artist: s.artist,
        album: s.album ?? '',
        duration: s.duration ? String(Math.round(s.duration)) : '',
      })}`,
      signal,
    ),
  lyricsQuery: (q: string, signal?: AbortSignal) => get<LyricCandidate[]>(`/api/lyrics?q=${encodeURIComponent(q)}`, signal),
  captions: (id: string, signal?: AbortSignal) => get<LyricCandidate[]>(`/api/captions?id=${id}`, signal),
  audioUrl: (id: string) => `/api/audio?id=${id}`,
  imageUrl: (url: string) => `/api/image?url=${encodeURIComponent(url)}`,
};

export function parseYouTubeId(s: string): string | null {
  const m = s.match(/(?:youtu\.be\/|[?&]v=|\/embed\/|\/shorts\/|\/live\/)([\w-]{11})/);
  return m ? m[1] : null;
}

export const videoArt = (id: string) => `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
