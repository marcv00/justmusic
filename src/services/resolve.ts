import { api, videoArt, type Song, type Video } from './api';

export type Kind = 'original' | 'karaoke';
export type Sources = Partial<Record<Kind, Video>>;

const KARAOKE = /\b(karaoke|instrumental|backing track|sin voz|pista|minus one|off vocal)\b/i;
const BAD = /\b(live|en vivo|ao vivo|cover|remix|sped ?up|slowed|reverb|8d|nightcore|reaction|tutorial|lesson|acoustic|ac[uú]stic[oa]|edit|extended|mashup|loop|1 hour)\b/i;
const OFFICIAL = /\b(official audio|audio oficial|official video|video oficial|official music video|visualizer|lyric video)\b/i;

const norm = (s: string) =>
  s
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length > 1);

/** Share of the song's own words that appear in the video title (and channel). */
function overlap(song: Song, v: Video) {
  const hay = new Set(norm(`${v.title} ${v.channel}`));
  const titleWords = norm(song.title);
  const artistWords = norm(song.artist);
  const t = titleWords.filter((w) => hay.has(w)).length / Math.max(1, titleWords.length);
  const a = artistWords.filter((w) => hay.has(w)).length / Math.max(1, artistWords.length);
  return t * 0.65 + a * 0.35;
}

const durPenalty = (song: Song, v: Video, scale: number) =>
  song.duration && v.duration ? Math.min(6, Math.abs(song.duration - v.duration) / scale) : 0;

// a title that names a remix/live/etc. is fine when the song itself has that word
const badFor = (song: Song, v: Video) => BAD.test(v.title) && !BAD.test(song.title);

function scoreOriginal(song: Song, v: Video) {
  let s = overlap(song, v) * 6 - durPenalty(song, v, 3);
  if (KARAOKE.test(v.title)) s -= 8;
  if (badFor(song, v)) s -= 4;
  if (OFFICIAL.test(v.title)) s += 0.8;
  if (/ - Topic$/.test(v.channel)) s += 1.6;
  return s;
}

// re-recorded or thin karaoke tracks: these are what make a karaoke version sound "off"
const LOFI = /\b(midi|piano|guitar|guitarra|acoustic|ac[uú]stic[oa]|cover|8.?bit|ringtone|lower key|higher key|tono (m[aá]s )?(bajo|alto)|female key|male key)\b/i;

function scoreKaraoke(song: Song, v: Video) {
  const hay = new Set(norm(v.title));
  const t = norm(song.title).filter((w) => hay.has(w)).length / Math.max(1, norm(song.title).length);
  const a = norm(song.artist).filter((w) => hay.has(w)).length / Math.max(1, norm(song.artist).length);
  // karaoke edits often have a different intro or ending, so length matters less here
  let s = t * 5 + a * 1.5 - Math.min(3, durPenalty(song, v, 12));
  s += KARAOKE.test(v.title) ? 4 : -8;
  if (badFor(song, v)) s -= 2;
  if (LOFI.test(v.title) && !LOFI.test(song.title)) s -= 4;
  if (/sing king|karafun|zzang|lugn|cc karaoke|musisi|global karaoke|sing2music|stingray/i.test(v.channel)) s += 1.5;
  return s;
}

/** Candidate videos for one version of a song, best first. Empty if nothing is close enough. */
export async function findVersions(song: Song, kind: Kind, signal?: AbortSignal): Promise<Video[]> {
  const q = kind === 'karaoke' ? `${song.artist} ${song.title} karaoke` : `${song.artist} ${song.title} audio`;
  const list = await api.videos(q, signal);
  const score = kind === 'karaoke' ? (v: Video) => scoreKaraoke(song, v) : (v: Video) => scoreOriginal(song, v);
  const min = kind === 'karaoke' ? 3 : 2;
  return list
    .map((v) => ({ v, s: score(v) }))
    .filter((x) => x.s >= min)
    .sort((a, b) => b.s - a.s)
    .slice(0, 6)
    .map((x) => x.v);
}

const bareTitle = (t: string) => norm(t.replace(/[([{][^)\]}]*[)\]}]/g, ' ')).join(' ');

/**
 * Turn a YouTube video into a Song. The video you picked decides the title and artist
 * ("Radiohead - Creep" stays "Creep", never a catalogue match like "Creep (Acoustic)"),
 * so the karaoke and lyric searches look for the right recording. The catalogue only
 * lends its square cover art when the artist matches.
 */
export async function songFromVideo(v: Video, signal?: AbortSignal): Promise<{ song: Song; kind: Kind }> {
  const kind: Kind = KARAOKE.test(v.title) ? 'karaoke' : 'original';
  let raw = v.title.split(/\s+[|•]\s+/)[0];
  const quoted = raw.match(/["“”«]([^"“”»]{2,80})["“”»]/);
  let artist: string;
  let title: string;
  if (raw.includes(' - ') || raw.includes(' – ')) {
    [artist, title] = raw.split(/\s+[-–]\s+/, 2);
  } else if (quoted) {
    title = quoted[1];
    artist = v.channel;
  } else {
    artist = v.channel;
    title = raw;
  }
  const clean = (x: string) =>
    x
      .replace(/[([{][^)\]}]*[)\]}]/g, ' ')
      .replace(/\b(official|video|audio|oficial|lyrics?|letra|karaoke|instrumental|version|versi[oó]n|hd|4k|mv|visualizer|remastered)\b/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  artist = clean(artist).replace(/\s*-\s*Topic$|VEVO$/i, '').trim() || v.channel.replace(/ - Topic$|VEVO$/i, '');
  title = clean(title) || raw;

  const song: Song = {
    key: `yt:${v.id}`,
    title,
    artist,
    duration: kind === 'original' ? v.duration : undefined,
    art: videoArt(v.id),
  };
  try {
    const hits = await api.songs(`${artist} ${title}`, signal);
    const artistWords = norm(artist);
    const byArtist = hits.filter((h) => {
      const hw = new Set(norm(h.artist));
      return artistWords.length > 0 && artistWords.filter((w) => hw.has(w)).length / artistWords.length >= 0.5;
    });
    const want = bareTitle(title);
    // prefer the exact title, then the same song in another edition (its cover is still right)
    const pick =
      byArtist.find((h) => norm(h.title).join(' ') === norm(title).join(' ')) ??
      byArtist.find((h) => bareTitle(h.title) === want);
    if (pick?.art) song.art = pick.art;
    if (pick && norm(pick.title).join(' ') === norm(title).join(' ')) song.album = pick.album;
  } catch {
    /* the video thumbnail is fine */
  }
  return { song, kind };
}

export interface Ranked extends Video {
  official: boolean;
  karaokeTagged: boolean;
  recommended: boolean;
}

/** Every result for one version, best first, marked so the picker can explain itself. */
export async function rankVersions(song: Song, kind: Kind, signal?: AbortSignal): Promise<Ranked[]> {
  const q = kind === 'karaoke' ? `${song.artist} ${song.title} karaoke` : `${song.artist} ${song.title}`;
  const list = await api.videos(q, signal);
  const score = kind === 'karaoke' ? (v: Video) => scoreKaraoke(song, v) : (v: Video) => scoreOriginal(song, v);
  const min = kind === 'karaoke' ? 3 : 2;
  const ranked = list.map((v) => ({ v, s: score(v) })).sort((a, b) => b.s - a.s);
  return ranked.slice(0, 10).map(({ v, s }, i) => ({
    ...v,
    official: OFFICIAL.test(v.title) || / - Topic$/.test(v.channel) || /vevo$/i.test(v.channel),
    karaokeTagged: KARAOKE.test(v.title),
    recommended: i === 0 && s >= min,
  }));
}
