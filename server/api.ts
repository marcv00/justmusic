import type { Plugin, Connect } from 'vite';
import type { ServerResponse } from 'node:http';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * JustMusic's local backend. It runs inside the Vite dev/preview server, so there is
 * nothing extra to deploy: search the music catalogue, find videos on YouTube without
 * an API key, proxy lyrics and artwork, and fetch a song's audio with yt-dlp so the
 * browser can analyse it on device.
 */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const YT_HEADERS = { 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9', cookie: 'CONSENT=YES+cb; SOCS=CAI' };
const LRCLIB = 'https://lrclib.net/api';
const LRCLIB_HEADERS = { 'Lrclib-Client': 'JustMusic/1.0 (in-home karaoke)', 'user-agent': 'JustMusic/1.0 (in-home karaoke)' };
const CACHE_DIR = path.join(os.tmpdir(), 'justmusic-audio');
const ID_RE = /^[\w-]{11}$/;

/* ---------------- helpers ---------------- */

function send(res: ServerResponse, code: number, body: unknown) {
  res.statusCode = code;
  res.setHeader('content-type', 'application/json; charset=utf-8');
  res.end(JSON.stringify(body));
}

const clock = (s?: string) => (s ? s.split(':').reduce((a, p) => a * 60 + Number(p), 0) : 0);

/** Extract the JSON object that starts at `from`, respecting strings and escapes. */
function sliceJson(src: string, from: number): string {
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = from; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === '\\') esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return src.slice(from, i + 1);
  }
  throw new Error('unterminated json');
}

function embeddedJson(html: string, markers: string[]) {
  for (const m of markers) {
    const i = html.indexOf(m);
    if (i < 0) continue;
    const j = html.indexOf('{', i);
    if (j < 0) continue;
    try {
      return JSON.parse(sliceJson(html, j));
    } catch {
      /* try next marker */
    }
  }
  return null;
}

function collect(node: unknown, key: string, out: any[]) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) {
    for (const n of node) collect(n, key, out);
    return;
  }
  for (const [k, v] of Object.entries(node as Record<string, unknown>)) {
    if (k === key) out.push(v);
    else collect(v, key, out);
  }
}

/* ---------------- yt-dlp ---------------- */

let ytdlpVersion: string | null | undefined;
function ytdlp(): string | null {
  if (ytdlpVersion !== undefined) return ytdlpVersion;
  const r = spawnSync(ytdlpBin(), ['--version'], { encoding: 'utf8' });
  ytdlpVersion = r.status === 0 ? r.stdout.trim() : null;
  return ytdlpVersion;
}
const ytdlpBin = () => process.env.YTDLP_PATH || 'yt-dlp';
/** Arguments every yt-dlp call gets: ignore stray config files, and use the bundled JS runtime if the app ships one. */
const ytArgs = (...args: string[]) => [
  '--no-config',
  ...(process.env.JUSTMUSIC_JS_RUNTIME ? ['--js-runtimes', process.env.JUSTMUSIC_JS_RUNTIME] : []),
  ...args,
];

const inflight = new Map<string, Promise<string>>();

function cachedAudio(id: string): string | null {
  if (!fs.existsSync(CACHE_DIR)) return null;
  const f = fs.readdirSync(CACHE_DIR).find((n) => n.startsWith(id + '.') && !n.endsWith('.part'));
  return f ? path.join(CACHE_DIR, f) : null;
}

function downloadAudio(id: string): Promise<string> {
  const hit = cachedAudio(id);
  if (hit) return Promise.resolve(hit);
  const running = inflight.get(id);
  if (running) return running;
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  const p = new Promise<string>((resolve, reject) => {
    const args = [
      '-f', 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio',
      '--no-playlist', '--no-progress', '-q',
      '-o', path.join(CACHE_DIR, `${id}.%(ext)s`),
      `https://www.youtube.com/watch?v=${id}`,
    ];
    const child = spawn(ytdlpBin(), ytArgs(...args));
    let err = '';
    child.stderr.on('data', (d) => (err += d));
    child.on('error', reject);
    child.on('close', (code) => {
      const f = cachedAudio(id);
      if (code === 0 && f) resolve(f);
      else reject(new Error(err.trim() || `yt-dlp exited ${code}`));
    });
  }).finally(() => inflight.delete(id));
  inflight.set(id, p);
  return p;
}

const MIME: Record<string, string> = { '.m4a': 'audio/mp4', '.mp4': 'audio/mp4', '.webm': 'audio/webm', '.opus': 'audio/ogg', '.mp3': 'audio/mpeg' };

/* ---------------- sources ---------------- */

interface Video { id: string; title: string; channel: string; duration: number; thumb: string }

async function youtubeSearch(q: string): Promise<Video[]> {
  const r = await fetch(`https://www.youtube.com/results?search_query=${encodeURIComponent(q)}&sp=EgIQAQ%3D%3D`, { headers: YT_HEADERS });
  const data = embeddedJson(await r.text(), ['var ytInitialData =', 'ytInitialData =', 'window["ytInitialData"] =']);
  if (!data) throw new Error('youtube search parse failed');
  const found: any[] = [];
  collect(data, 'videoRenderer', found);
  return found
    .filter((v) => v?.videoId)
    .map((v) => ({
      id: v.videoId,
      title: (v.title?.runs ?? []).map((x: any) => x.text).join('') || v.title?.simpleText || '',
      channel: v.ownerText?.runs?.[0]?.text ?? '',
      duration: clock(v.lengthText?.simpleText),
      thumb: `https://i.ytimg.com/vi/${v.videoId}/mqdefault.jpg`,
    }));
}

async function youtubeVideo(id: string): Promise<Video> {
  try {
    const r = await fetch(`https://www.youtube.com/watch?v=${id}&hl=en`, { headers: YT_HEADERS });
    const pr = embeddedJson(await r.text(), ['var ytInitialPlayerResponse =', 'ytInitialPlayerResponse =']);
    const d = pr?.videoDetails;
    if (d?.title) {
      return { id, title: d.title, channel: d.author ?? '', duration: Number(d.lengthSeconds) || 0, thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` };
    }
  } catch {
    /* fall through to yt-dlp */
  }
  if (!ytdlp()) throw new Error('video info unavailable');
  const out = spawnSync(ytdlpBin(), ytArgs('-J', '--skip-download', '--no-playlist', `https://www.youtube.com/watch?v=${id}`), { encoding: 'utf8', maxBuffer: 64 << 20 });
  const j = JSON.parse(out.stdout);
  return { id, title: j.title, channel: j.channel ?? j.uploader ?? '', duration: j.duration ?? 0, thumb: `https://i.ytimg.com/vi/${id}/mqdefault.jpg` };
}

const normKey = (title: string, artist: string) =>
  `${title} ${artist}`
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/\((feat|ft|with)[^)]*\)|\[(feat|ft|with)[^\]]*\]| - (remaster|remastered|single|radio)[^,]*/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();

interface SongHit { key: string; title: string; artist: string; album?: string; duration?: number; art?: string }

async function itunes(q: string, country: string): Promise<SongHit[]> {
  try {
    const r = await fetch(`https://itunes.apple.com/search?term=${encodeURIComponent(q)}&media=music&entity=song&limit=25&country=${country}`);
    const j = (await r.json()) as { results: any[] };
    return j.results
      .filter((s) => s.trackName && s.artistName)
      .map((s) => ({
        key: `it:${s.trackId}`,
        title: s.trackName,
        artist: s.artistName,
        album: s.collectionName,
        duration: s.trackTimeMillis ? s.trackTimeMillis / 1000 : undefined,
        art: typeof s.artworkUrl100 === 'string' ? s.artworkUrl100.replace(/\/\d+x\d+bb\./, '/600x600bb.') : undefined,
      }));
  } catch {
    return [];
  }
}

async function lrclibSongs(q: string): Promise<SongHit[]> {
  try {
    const r = await fetch(`${LRCLIB}/search?q=${encodeURIComponent(q)}`, { headers: LRCLIB_HEADERS });
    const list = r.ok ? ((await r.json()) as any[]) : [];
    return list
      .filter((x) => x.trackName && x.artistName)
      .map((x) => ({ key: `lrc:${x.id}`, title: x.trackName, artist: x.artistName, album: x.albumName || undefined, duration: x.duration || undefined }));
  } catch {
    return [];
  }
}

/** Catalogue (two storefronts, for Latin releases) + LRCLIB's community catalogue + YouTube, merged. */
async function search(q: string) {
  const [us, pe, lrc, vids] = await Promise.all([
    itunes(q, 'us'),
    itunes(q, 'pe'),
    lrclibSongs(q),
    youtubeSearch(q).catch(() => [] as Video[]),
  ]);
  const seen = new Map<string, SongHit>();
  // interleave storefronts so the best match of either comes first
  const catalogue: SongHit[] = [];
  for (let i = 0; i < Math.max(us.length, pe.length); i++) {
    if (us[i]) catalogue.push(us[i]);
    if (pe[i]) catalogue.push(pe[i]);
  }
  for (const s of [...catalogue, ...lrc]) {
    const k = normKey(s.title, s.artist);
    const prev = seen.get(k);
    if (!prev) seen.set(k, s);
    else if (!prev.art && s.art) seen.set(k, { ...s, duration: prev.duration ?? s.duration });
  }
  return { songs: [...seen.values()].slice(0, 14), videos: vids.slice(0, 4) };
}

/* ---------------- lyrics: every candidate we can find ---------------- */

interface LyricCandidate {
  key: string;
  source: 'lrclib' | 'youtube';
  title: string;
  artist: string;
  duration?: number;
  /** LRC text with timestamps */
  lrc?: string;
  /** untimed text, one line per row (JustMusic can time it against the vocals) */
  plain?: string;
  auto?: boolean;
  lang?: string;
}

/** Title variants: as given, without (feat…)/[…]/" - Remastered", and without accents. */
function titleVariants(t: string) {
  const out = new Set<string>([t.trim()]);
  const bare = t.replace(/\s*[([{][^)\]}]*[)\]}]/g, '').replace(/\s+-\s+.*$/, '').trim();
  if (bare) out.add(bare);
  const plain = bare.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
  if (plain) out.add(plain);
  return [...out];
}

async function lrclibGet(qs: Record<string, string>) {
  const r = await fetch(`${LRCLIB}/get?${new URLSearchParams(qs)}`, { headers: LRCLIB_HEADERS });
  return r.ok ? ((await r.json()) as any) : null;
}
async function lrclibSearch(qs: Record<string, string>) {
  const r = await fetch(`${LRCLIB}/search?${new URLSearchParams(qs)}`, { headers: LRCLIB_HEADERS });
  return r.ok ? ((await r.json()) as any[]) : [];
}

/**
 * LRCLIB, as its docs recommend: /api/get with the exact signature first, then /api/search,
 * here with several spellings of the title so "Amorfoda" and "AMORFODA (Video Oficial)" both land.
 */
async function lyricCandidates(p: URLSearchParams): Promise<LyricCandidate[]> {
  const track = p.get('track') ?? '';
  const artist = p.get('artist') ?? '';
  const album = p.get('album') ?? '';
  const duration = Number(p.get('duration')) || 0;
  const q = p.get('q') ?? '';
  const raw: any[] = [];
  const tasks: Promise<unknown>[] = [];
  if (q) tasks.push(lrclibSearch({ q }).then((l) => raw.push(...l)));
  if (track) {
    const base = { track_name: track, artist_name: artist };
    if (duration) tasks.push(lrclibGet({ ...base, ...(album ? { album_name: album } : {}), duration: String(Math.round(duration)) }).then((h) => h && raw.push(h)));
    tasks.push(lrclibGet(base).then((h) => h && raw.push(h)));
    for (const t of titleVariants(track)) {
      tasks.push(lrclibSearch({ track_name: t, artist_name: artist }).then((l) => raw.push(...l)));
      tasks.push(lrclibSearch({ q: `${artist} ${t}` }).then((l) => raw.push(...l)));
    }
    tasks.push(lrclibSearch({ track_name: titleVariants(track).at(-1)! }).then((l) => raw.push(...l.slice(0, 8))));
  }
  await Promise.allSettled(tasks);

  const seen = new Set<string>();
  const out: LyricCandidate[] = [];
  for (const x of raw) {
    if (!x?.id || seen.has(String(x.id)) || x.instrumental) continue;
    if (!x.syncedLyrics && !x.plainLyrics) continue;
    seen.add(String(x.id));
    out.push({
      key: `lrclib:${x.id}`,
      source: 'lrclib',
      title: x.trackName,
      artist: x.artistName,
      duration: x.duration || undefined,
      lrc: x.syncedLyrics || undefined,
      plain: x.syncedLyrics ? undefined : x.plainLyrics || undefined,
    });
  }
  // the same text uploaded twice is one option
  const byText = new Map<string, LyricCandidate>();
  for (const c of out) {
    const k = (c.lrc ?? c.plain ?? '').replace(/\[[^\]]*\]/g, '').replace(/\s+/g, ' ').trim().toLowerCase().slice(0, 400);
    if (!byText.has(k)) byText.set(k, c);
  }
  return [...byText.values()].slice(0, 12);
}

/** Subtitles of a specific video, through yt-dlp: manual ones first (often the real lyrics), else automatic. */
async function captions(id: string): Promise<LyricCandidate[]> {
  if (!ytdlp()) return [];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'justmusic-subs-'));
  const run = (auto: boolean) =>
    new Promise<void>((resolve) => {
      const args = [
        '--skip-download', '--no-playlist', '-q',
        auto ? '--write-auto-subs' : '--write-subs',
        '--sub-langs', auto ? 'es-orig,es,en-orig,en' : 'es.*,es,en.*,en,pt.*',
        '--sub-format', 'json3',
        '-o', path.join(dir, `${auto ? 'auto' : 'manual'}.%(ext)s`),
        `https://www.youtube.com/watch?v=${id}`,
      ];
      const c = spawn(ytdlpBin(), ytArgs(...args));
      c.on('close', () => resolve());
      c.on('error', () => resolve());
    });
  const parse = (file: string, auto: boolean): LyricCandidate | null => {
    try {
      const j = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8')) as { events?: any[] };
      const lines: string[] = [];
      for (const e of j.events ?? []) {
        const text = (e.segs ?? []).map((s: any) => s.utf8 ?? '').join('').replace(/\s+/g, ' ').trim();
        if (!text || /^\[[^\]]*\]$|^[♪♫\s]+$/.test(text)) continue;
        const t = (e.tStartMs ?? 0) / 1000;
        const mm = Math.floor(t / 60), ss = (t % 60).toFixed(2).padStart(5, '0');
        lines.push(`[${String(mm).padStart(2, '0')}:${ss}] ${text.replace(/[♪♫]/g, '').trim()}`);
      }
      if (lines.length < 4) return null;
      const lang = file.split('.').slice(-2, -1)[0];
      return { key: `yt:${id}:${auto ? 'auto' : 'cc'}:${lang}`, source: 'youtube', title: '', artist: '', lrc: lines.join('\n'), auto, lang };
    } catch {
      return null;
    }
  };
  try {
    await run(false);
    let files = fs.readdirSync(dir).filter((f) => f.endsWith('.json3'));
    let auto = false;
    if (!files.length) {
      await run(true);
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json3'));
      auto = true;
    }
    return files.map((f) => parse(f, auto)).filter((c): c is LyricCandidate => !!c).slice(0, 2);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const IMAGE_HOSTS = ['mzstatic.com', 'ytimg.com', 'ggpht.com', 'googleusercontent.com'];

/* ---------------- router ---------------- */

export const handler: Connect.NextHandleFunction = async (req, res, next) => {
  if (!req.url?.startsWith('/api/')) return next();
  const u = new URL(req.url, 'http://local');
  const q = u.searchParams;
  try {
    switch (u.pathname) {
      case '/api/health':
        return send(res, 200, { ytdlp: ytdlp() });
      case '/api/search':
        return send(res, 200, await search(q.get('q') ?? ''));
      case '/api/songs':
        return send(res, 200, (await search(q.get('q') ?? '')).songs);
      case '/api/videos':
        return send(res, 200, (await youtubeSearch(q.get('q') ?? '')).slice(0, 12));
      case '/api/video': {
        const id = q.get('id') ?? '';
        if (!ID_RE.test(id)) return send(res, 400, { error: 'bad id' });
        return send(res, 200, await youtubeVideo(id));
      }
      case '/api/lyrics':
        return send(res, 200, await lyricCandidates(q));
      case '/api/captions': {
        const id = q.get('id') ?? '';
        if (!ID_RE.test(id)) return send(res, 400, { error: 'bad id' });
        return send(res, 200, await captions(id));
      }
      case '/api/image': {
        const target = new URL(q.get('url') ?? '');
        if (!IMAGE_HOSTS.some((h) => target.hostname.endsWith(h))) return send(res, 400, { error: 'host not allowed' });
        const r = await fetch(target, { headers: { 'user-agent': UA } });
        if (!r.ok) return send(res, r.status, { error: 'image failed' });
        res.setHeader('content-type', r.headers.get('content-type') ?? 'image/jpeg');
        res.setHeader('cache-control', 'public, max-age=86400');
        return res.end(Buffer.from(await r.arrayBuffer()));
      }
      case '/api/audio': {
        const id = q.get('id') ?? '';
        if (!ID_RE.test(id)) return send(res, 400, { error: 'bad id' });
        if (!ytdlp()) return send(res, 501, { error: 'yt-dlp not installed' });
        const file = await downloadAudio(id);
        const stat = fs.statSync(file);
        res.setHeader('content-type', MIME[path.extname(file)] ?? 'application/octet-stream');
        res.setHeader('content-length', String(stat.size));
        res.setHeader('cache-control', 'private, max-age=86400');
        fs.createReadStream(file).pipe(res);
        return;
      }
      default:
        return send(res, 404, { error: 'unknown endpoint' });
    }
  } catch (e) {
    send(res, 502, { error: e instanceof Error ? e.message : String(e) });
  }
};

export function justMusicApi(): Plugin {
  return {
    name: 'justmusic-api',
    configureServer(server) {
      server.middlewares.use(handler);
    },
    configurePreviewServer(server) {
      server.middlewares.use(handler);
    },
  };
}
