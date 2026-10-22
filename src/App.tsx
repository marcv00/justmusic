import { useCallback, useEffect, useRef, useState } from 'react';
import { Backdrop } from './components/Backdrop';
import { Search, type QuickJob } from './components/Search';
import { Picker, type Choice } from './components/Picker';
import { QueuePopover, QueueSide, QueueChip, ExitConfirm, type QueueView } from './components/Queue';
import { Slicer, type SlicerTrack, type SlicerValues } from './components/Slicer';
import type { LyricOption } from './services/lyricOptions';
import { NowPlaying, type Status } from './components/NowPlaying';
import { MarqueeSpeed } from './components/Marquee';
import { Lyrics } from './components/Lyrics';
import { Controls } from './components/Controls';
import { Settings } from './components/Settings';
import { VideoDock } from './components/VideoDock';
import { audio } from './engine/audio';
import { playback } from './engine/playback';
import { conductor } from './engine/conductor';
import { loadTrack, alignAnalyses, alignLyricsToVoice, timePlainLyrics, AudioUnavailable, type Track } from './engine/analysis';
import type { Analysis } from './engine/analysisTypes';
import { paletteFromArt } from './engine/palettes';
import { api, videoArt, type Song, type Video } from './services/api';
import type { LyricLine } from './services/lyrics';
import { songFromVideo, rankVersions, type Kind } from './services/resolve';
import { catalogueOptions, rankOptions } from './services/lyricOptions';
import { usePersistent, useIdle, useToast } from './hooks';
import { kindFor, type Mode, type Settings as SettingsT } from './model';
import * as PL from './playlist';

const DEFAULT_SETTINGS: SettingsT = {
  intensity: 1,
  projector: false,
  visual: 'wall',
  glass: false,
  glassAmount: 0.55,
  lightDelay: 0,
  marqueeSpeed: 16,
  wallShape: 'lattice',
  zoneSeconds: 6.5,
};
interface Prepared {
  video: Video;
  track: Track;
  analysis: Analysis;
}
interface Session {
  song: Song;
  choice?: Choice;
  live: boolean;
  resume?: boolean;
  loading: { text: string; progress?: number } | null;
  lip?: Prepared;
  kar?: Prepared;
  lines: LyricLine[];
  lyricDuration?: number;
  lyricLabel?: string;
  initial: SlicerValues;
  auto: { offK?: number; offKSure?: boolean; shift?: number; shiftSure?: boolean };
}
/** A song waiting its turn: only light data (choices, analysis, timing). Audio is reloaded when it plays. */
export interface QueueItem {
  key: string;
  song: Song;
  choice: Choice;
  values: SlicerValues;
  lines: LyricLine[];
  lyricDuration?: number;
  lyricLabel?: string;
  auto: Session['auto'];
  lipA: Analysis;
  /** "Letra antes / después" adjustments made while it played, kept for its next turn */
  nudge?: number;
  karA?: Analysis;
}
const toItem = (sess: Session, v: SlicerValues): QueueItem => ({
  key: `${sess.song.key}:${Date.now()}`,
  song: sess.song,
  choice: sess.choice!,
  values: v,
  lines: sess.lines,
  lyricDuration: sess.lyricDuration,
  lyricLabel: sess.lyricLabel,
  auto: sess.auto,
  lipA: sess.lip!.analysis,
  karA: sess.kar?.analysis,
});

const baseSession = (s: Song, c: Choice): Session => {
  const opt = c.lyric;
  return {
    song: { ...s, art: c.art ?? s.art ?? videoArt(c.lip.id) },
    choice: c,
    live: false,
    loading: { text: 'Preparando las versiones', progress: 0 },
    lines: opt && opt.kind !== 'plain' ? opt.lines : [],
    lyricDuration: opt?.kind === 'reference' ? opt.duration : undefined,
    lyricLabel: opt?.label,
    initial: { offK: 0, shift: 0 },
    auto: {},
  };
};

/**
 * Download both versions, read them, and line everything up. Reports progress through
 * `update`; `alive()` lets the caller abandon it (another song was chosen meanwhile).
 */
async function computeSession(base: Session, c: Choice, update: (patch: Partial<Session>) => void, alive: () => boolean) {
  const opt = c.lyric;
  const prog: Record<string, number> = {};
  const report = (id: string) => (x: number | null) => {
    prog[id] = x ?? 0;
    const sum = Object.values(prog).reduce((a, b) => a + b, 0);
    if (alive()) update({ loading: { text: 'Bajando las versiones', progress: sum / (c.kar ? 2 : 1) } });
  };
  const [lipT, karT] = await Promise.all([
    loadTrack(c.lip.id, playback.ctx, report(c.lip.id)),
    c.kar ? loadTrack(c.kar.id, playback.ctx, report(c.kar.id)) : Promise.resolve(undefined),
  ]);
  if (!alive()) return null;
  update({ loading: { text: 'Leyendo el ritmo y la voz', progress: 1 } });
  const [lipA, karA] = await Promise.all([lipT.analysis, karT?.analysis]);
  if (!alive()) return null;
  let offK = 0;
  let offKSure: boolean | undefined;
  if (karA) {
    const al = await alignAnalyses(lipA, karA);
    offKSure = al.confidence > 2.2 && Math.abs(al.offset) < 35;
    if (offKSure) offK = al.offset;
  }
  let lines = base.lines;
  let shift = 0;
  let shiftSure: boolean | undefined;
  const voice = { original: lipA, karaoke: karA, karaokeOffset: offK };
  if (opt?.kind === 'reference') {
    const r = await alignLyricsToVoice(voice, opt.lines);
    shiftSure = r.confidence > 3 && Math.abs(r.offset) < 60;
    if (shiftSure) shift = r.offset;
  } else if (opt?.kind === 'plain' && opt.plain) {
    const times = await timePlainLyrics(voice, opt.plain);
    lines = opt.plain.map((text, i) => ({ t: times[i], text }));
    shiftSure = false; // timed from the voice: worth a look
  } else if (opt?.kind === 'video') {
    shiftSure = true;
  }
  if (!alive()) return null;
  const auto = { offK: karA ? offK : undefined, offKSure, shift: lines.length ? shift : undefined, shiftSure };
  const patch: Partial<Session> = {
    loading: null,
    lip: { video: c.lip, track: lipT, analysis: lipA },
    kar: karT && karA && c.kar ? { video: c.kar, track: karT, analysis: karA } : undefined,
    lines,
    lyricDuration: opt?.kind === 'reference' ? opt.duration : opt?.kind === 'video' ? lipT.buffer.duration : undefined,
    initial: { offK, shift },
    auto,
  };
  update(patch);
  return patch;
}

type Side = { step: 'search' } | { step: 'pick'; song: Song; preset?: { kind: Kind; video: Video } } | { step: 'sync'; session: Session };

const barsOf = (a?: Analysis) => (a ? Array.from(a.beats).filter((_, i) => a.downbeats[i]) : undefined);
const slicerTrack = (p?: Prepared): SlicerTrack | undefined =>
  p ? { title: p.video.title, channel: p.video.channel, buffer: p.track.buffer, bars: barsOf(p.analysis) } : undefined;

const label = (k: Kind) => (k === 'karaoke' ? 'la versión karaoke' : 'la canción');

export default function App() {
  const [settings, setSettings] = usePersistent<SettingsT>('justmusic.settings', DEFAULT_SETTINGS);
  const [prefs, setPrefs] = usePersistent('justmusic.prefs', { panelLyrics: false, quickAdd: false, shuffle: false, repeat: false });
  const modeRef = useRef<PL.PlayMode>({ shuffle: false, repeat: false });
  modeRef.current = { shuffle: prefs.shuffle, repeat: prefs.repeat };
  const [jobs, setJobs] = useState<QuickJob[]>([]);
  const prefsRef = useRef(prefs);
  prefsRef.current = prefs;
  const quickAddRef = useRef<(s: Song, v?: Video) => Promise<void>>(async () => undefined);
  const [mode, setMode] = useState<Mode>('karaoke');
  const [song, setSong] = useState<Song | null>(null);
  const [lines, setLines] = useState<LyricLine[]>([]);
  const [kind, setKind] = useState<Kind>('karaoke');
  const [playing, setPlaying] = useState(false);
  const [ready, setReady] = useState(false);
  const [offset, setOffset] = useState(0);
  const [showVideo, setShowVideo] = useState(false);
  const [showLyrics, setShowLyrics] = useState(true);
  const [micOn, setMicOn] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [status, setStatus] = useState<Status | null>(null);
  const [glow, setGlow] = useState('#ff3324');
  const [ytdlp, setYtdlp] = useState<boolean | null>(null);
  const [versions, setVersions] = useState<Record<Kind, Video[]>>({ original: [], karaoke: [] });
  const [current, setCurrent] = useState<Partial<Record<Kind, string>>>({});
  const [picking, setPicking] = useState<{ song: Song; preset?: { kind: Kind; video: Video } } | null>(null);
  const [lyricShift, setLyricShift] = useState(0);
  const lyric = useRef<{ option?: LyricOption; level: number }>({ level: 0 });
  const [session, setSession] = useState<Session | null>(null);
  const autoRef = useRef<Session['auto']>({});

  const performing = !!song;
  const [pl, setPl] = useState<PL.Playlist<QueueItem>>(PL.empty<QueueItem>());
  const plRef = useRef(pl);
  plRef.current = pl;
  const queue = PL.upcoming(pl);
  const [queueOpen, setQueueOpen] = useState(false);
  const [exitAsk, setExitAsk] = useState(false);
  const openSideRef = useRef<() => void>(() => undefined);
  const [side, setSide] = useState<Side | null>(null);
  const sideRun = useRef(0);
  const [idle, setIdle] = useIdle(performing && !settingsOpen && !queueOpen && !side);
  const [toast, showToast] = useToast();

  const run = useRef(0);
  const analyses = useRef<Partial<Record<Kind, Analysis>>>({});
  const wantKind = useRef<Kind>('karaoke');
  const ytdlpRef = useRef<boolean | null>(null);
  ytdlpRef.current = ytdlp;

  useEffect(() => {
    api.health().then((h) => setYtdlp(!!h.ytdlp)).catch(() => setYtdlp(false));
  }, []);
  useEffect(() => {
    playback.userLatency = settings.lightDelay / 1000;
  }, [settings.lightDelay]);

  /* ---------- lights follow whichever version is playing ---------- */
  const attachLights = useCallback((k: Kind) => {
    conductor.setTrack(analyses.current[k] ?? null, playback.videoIds[k] ?? 'free');
  }, []);

  useEffect(() => {
    playback.events = {
      onPlayingChange: setPlaying,
      onActiveChange: (k) => {
        setKind(k);
        attachLights(k);
      },
      onEnded: () => {
        const r = PL.advance(plRef.current, modeRef.current);
        if (r) {
          setPl(r.pl);
          void beginItemRef.current(r.pl.items[r.index]);
        } else {
          setPl((p) => ({ ...p, finished: true }));
          setStatus(null);
        }
      },
      onVideoError: () => showToast('Ese video no se puede mostrar fuera de YouTube'),
    };
  }, [attachLights, showToast]);

  /**
   * Fit the lyrics to the recording that's playing. Catalogue lyrics are lined up with the
   * singer; untimed lyrics are timed from the singing. Runs once with the original alone and
   * again, better, once the karaoke version (and its offset) is known.
   */
  const fitLyrics = useCallback(async (token: number) => {
    const opt = lyric.current.option;
    const o = analyses.current.original;
    if (!opt || !o || opt.kind === 'video') return;
    const k = analyses.current.karaoke;
    const level = k ? 2 : 1;
    if (lyric.current.level >= level) return;
    lyric.current.level = level;
    const v = { original: o, karaoke: k, karaokeOffset: playback.offsets.karaoke };
    try {
      if (opt.kind === 'reference') {
        const r = await alignLyricsToVoice(v, opt.lines);
        if (run.current !== token) return;
        if (r.confidence > 3 && Math.abs(r.offset) < 60) {
          setLyricShift(r.offset);
          if (Math.abs(r.offset) >= 0.3) setStatus({ text: `Letra alineada con la voz (${r.offset > 0 ? '+' : ''}${r.offset.toFixed(1)} s)`, busy: false });
        }
      } else if (opt.plain) {
        const times = await timePlainLyrics(v, opt.plain);
        if (run.current !== token) return;
        setLines(opt.plain.map((text, i) => ({ t: times[i], text })));
        setStatus({ text: level === 2 ? 'Letra cronometrada con la voz' : 'Letra cronometrada (aproximada)', busy: false });
      }
    } catch {
      /* keep the lyrics as they are */
    }
  }, []);

  const realign = useCallback(
    async (token: number) => {
      const o = analyses.current.original, k = analyses.current.karaoke;
      if (o && k) {
        const { offset: off, confidence } = await alignAnalyses(o, k);
        if (run.current !== token) return;
        if (confidence > 2.2 && Math.abs(off) < 35) playback.setOffset('karaoke', off);
      }
      void fitLyrics(token);
    },
    [fitLyrics],
  );

  /** Download + decode a version, hand it to the player, then read its rhythm. */
  const prepare = useCallback(
    async (k: Kind, v: Video, token: number, foreground: boolean) => {
      const track = await loadTrack(v.id, playback.ctx, (prog) => {
        if (!foreground || run.current !== token) return;
        setStatus({ text: `Preparando ${label(k)}${prog !== null ? ` ${Math.round(prog * 100)}%` : ''}`, busy: true });
      });
      if (run.current !== token) return null;
      playback.setBuffer(k, track.buffer);
      track.analysis
        .then((a) => {
          if (run.current !== token) return;
          analyses.current[k] = a;
          if (playback.active === k) {
            attachLights(k);
            setStatus({ text: `${Math.round(a.bpm)} BPM`, busy: false });
          }
          void realign(token);
        })
        .catch(() => {
          if (run.current === token && playback.active === k) setStatus({ text: 'No pude leer el ritmo; la pared respira sola', busy: false });
        });
      return track;
    },
    [attachLights, realign],
  );

  /* ---------- after the picker: prepare both versions and line everything up ---------- */
  const prepareSession = useCallback(
    async (s: Song, c: Choice) => {
      playback.unlock(); // inside the click: lets audio start later
      const token = ++run.current;
      setPicking(null);
      const base = baseSession(s, c);
      if (ytdlpRef.current === false) {
        void beginYouTube(base, token);
        return;
      }
      setSession(base);
      try {
        const done = await computeSession(
          base,
          c,
          (patch) => setSession((cur) => (cur && run.current === token ? { ...cur, ...patch } : cur)),
          () => run.current === token,
        );
        if (done?.auto) autoRef.current = done.auto;
      } catch (e) {
        if (run.current !== token) return;
        if (e instanceof AudioUnavailable) {
          setYtdlp(false);
          void beginYouTube(base, token);
        } else {
          setSession(null);
          setPicking({ song: s });
          showToast('No pude bajar esas versiones. Prueba con otras.');
        }
      }
    },
    [showToast],
  );

  /** Start the show with the values the person confirmed in the matcher. */
  const begin = useCallback(
    async (sess: Session, v: SlicerValues, nudgeSaved = 0) => {
      const token = run.current;
      const c = sess.choice!;
      setSession(null);
      analyses.current = { original: sess.lip?.analysis, karaoke: sess.kar?.analysis };
      lyric.current = { option: c.lyric, level: 2 };
      playback.reset();
      if (sess.lip) playback.setBuffer('original', sess.lip.track.buffer);
      if (sess.kar) playback.setBuffer('karaoke', sess.kar.track.buffer);
      playback.setVideoId('original', c.lip.id);
      if (c.kar) playback.setVideoId('karaoke', c.kar.id);
      playback.setOffset('karaoke', v.offK);
      setLyricShift(v.shift);
      setLines(sess.lines);
      setOffset(nudgeSaved);
      setSong(sess.song);
      setReady(false);
      setShowVideo(false);
      setVersions({ original: c.lipList, karaoke: c.karList });
      setCurrent({ original: c.lip.id, karaoke: c.kar?.id });
      conductor.setPerforming(true);
      conductor.setTrack(null, sess.song.key);
      if (sess.song.art)
        paletteFromArt(sess.song.art).then((r) => {
          if (run.current !== token || !r) return;
          conductor.setArtPalette(r.palette);
          setGlow(r.glow);
        });
      const startKind: Kind = wantKind.current === 'karaoke' && sess.kar ? 'karaoke' : 'original';
      if (wantKind.current === 'karaoke' && !sess.kar) showToast('Sin versión karaoke: suena la de lipsync');
      await playback.start(startKind);
      if (run.current !== token) return;
      setReady(true);
      attachLights(startKind);
      const a = analyses.current[startKind];
      setStatus(a ? { text: `${Math.round(a.bpm)} BPM`, busy: false } : null);
    },
    [attachLights, showToast],
  );

  /** Play a queued song: reload its audio (usually already prefetched) and start with its saved timing. */
  const beginItem = useCallback(
    async (item: QueueItem) => {
      const token = ++run.current;
      playback.unlock();
      setSong(item.song);
      setReady(false);
      setStatus({ text: 'Preparando la siguiente', busy: true });
      try {
        const [lipT, karT] = await Promise.all([
          loadTrack(item.choice.lip.id, playback.ctx),
          item.choice.kar ? loadTrack(item.choice.kar.id, playback.ctx) : Promise.resolve(undefined),
        ]);
        if (run.current !== token) return;
        autoRef.current = item.auto;
        const sess: Session = {
          song: item.song,
          choice: item.choice,
          live: false,
          loading: null,
          lip: { video: item.choice.lip, track: lipT, analysis: item.lipA },
          kar: karT && item.karA && item.choice.kar ? { video: item.choice.kar, track: karT, analysis: item.karA } : undefined,
          lines: item.lines,
          lyricDuration: item.lyricDuration,
          lyricLabel: item.lyricLabel,
          initial: item.values,
          auto: item.auto,
        };
        await begin(sess, item.values, item.nudge ?? 0);
      } catch {
        if (run.current !== token) return;
        showToast(`No pude preparar «${item.song.title}». Paso a la siguiente.`);
        const r = PL.advance(plRef.current, { ...modeRef.current, repeat: false });
        if (r) {
          setPl(r.pl);
          void beginItem(r.pl.items[r.index]);
        } else exitRef.current();
      }
    },
    [showToast],
  );
  const beginItemRef = useRef(beginItem);
  beginItemRef.current = beginItem;

  const playAt = useCallback(
    (index: number) => {
      const p = plRef.current;
      const item = p.items[index];
      if (!item) return;
      setPl({ ...p, cursor: index, finished: false });
      void beginItem(item);
    },
    [beginItem],
  );
  const goNext = useCallback(() => {
    const r = PL.advance(plRef.current, modeRef.current);
    if (!r) return;
    setPl(r.pl);
    void beginItem(r.pl.items[r.index]);
  }, [beginItem]);
  const goPrev = useCallback(() => {
    const r = PL.back(plRef.current);
    if (!r) return;
    setPl(r.pl);
    void beginItem(r.pl.items[r.index]);
  }, [beginItem]);

  /** Without yt-dlp: YouTube plays the sound, lyrics stay as written. */
  const beginYouTube = useCallback(
    async (sess: Session, token: number) => {
      const c = sess.choice!;
      setSession(null);
      playback.reset();
      playback.setVideoId('original', c.lip.id);
      if (c.kar) playback.setVideoId('karaoke', c.kar.id);
      setSong(sess.song);
      setLines(sess.lines);
      setLyricShift(0);
      setVersions({ original: c.lipList, karaoke: c.karList });
      setCurrent({ original: c.lip.id, karaoke: c.kar?.id });
      conductor.setPerforming(true);
      const startKind: Kind = wantKind.current === 'karaoke' && c.kar ? 'karaoke' : 'original';
      await playback.startYouTube(startKind).catch(() => showToast('YouTube no cargó'));
      if (run.current !== token) return;
      setReady(true);
      setStatus({ text: 'Sonido desde YouTube: la pared escucha con M', busy: false });
    },
    [showToast],
  );

  /** Reopen the matcher in the middle of a song. */
  const openAdjust = useCallback(() => {
    if (!song || playback.engine !== 'audio' || !playback.buffers.original) {
      showToast('El ajuste fino necesita yt-dlp');
      return;
    }
    const resume = playback.playing;
    if (resume) playback.toggle();
    const vid = (k: Kind) => versions[k].find((v) => v.id === current[k]);
    const prep = (k: Kind): Prepared | undefined => {
      const buffer = playback.buffers[k];
      const video = vid(k);
      const analysis = analyses.current[k];
      if (!buffer || !video || !analysis) return undefined;
      return { video, analysis, track: { id: video.id, buffer, analysis: Promise.resolve(analysis) } };
    };
    setSession({
      song,
      live: true,
      resume,
      loading: null,
      lip: prep('original'),
      kar: prep('karaoke'),
      lines,
      lyricDuration: lyric.current.option?.kind === 'reference' ? lyric.current.option.duration : undefined,
      lyricLabel: lyric.current.option?.label,
      initial: { offK: playback.offsets.karaoke, shift: lyricShift },
      auto: autoRef.current,
    });
  }, [song, versions, current, lines, lyricShift, showToast]);

  const closeAdjust = useCallback((v?: SlicerValues) => {
    setSession((sess) => {
      if (!sess) return null;
      if (v) {
        playback.setOffset('karaoke', v.offK);
        setLyricShift(v.shift);
        patchCurrent({ values: v });
      }
      if (sess.resume) playback.toggle();
      return null;
    });
  }, []);

  const pickVersion = useCallback(
    async (k: Kind, v: Video) => {
      const token = run.current;
      setCurrent((c) => ({ ...c, [k]: v.id }));
      playback.setVideoId(k, v.id);
      delete analyses.current[k];
      lyric.current.level = 0;
      if (playback.engine === 'youtube') {
        if (playback.active === k) await playback.startYouTube(k);
        return;
      }
      try {
        setStatus({ text: `Preparando ${label(k)}`, busy: true });
        await prepare(k, v, token, playback.active === k);
        if (run.current === token && playback.active !== k) setStatus(null);
      } catch {
        if (run.current === token) setStatus({ text: 'No pude bajar esa pista', busy: false });
      }
    },
    [prepare],
  );

  const playVideo = useCallback(
    async (id: string) => {
      playback.unlock();
      try {
        const v = await api.video(id);
        const { song: s, kind: k } = await songFromVideo(v);
        setPicking({ song: s, preset: { kind: k, video: v } });
      } catch {
        showToast('No pude leer ese video');
      }
    },
    [showToast],
  );

  const exit = useCallback(() => {
    run.current++;
    setPl((p) => ({ items: PL.upcoming(p), cursor: -1, finished: false }));
    playback.reset();
    conductor.setPerforming(false);
    setSong(null);
    setStatus(null);
    setReady(false);
    setGlow('#ff3324');
  }, []);
  const exitRef = useRef(exit);
  exitRef.current = exit;

  /* ---------- modes ---------- */
  const changeMode = useCallback(
    (m: Mode) => {
      setMode(m);
      const k = kindFor(m);
      wantKind.current = k;
      if (!performing || !ready) return;
      playback.unlock();
      if (playback.has(k)) void playback.switchTo(k);
      else showToast(k === 'karaoke' ? 'Preparando la versión karaoke…' : 'Preparando la original…');
    },
    [performing, ready, showToast],
  );

  const toggleMic = useCallback(async () => {
    if (audio.micOn) {
      audio.disableMic();
      setMicOn(false);
      showToast('Micrófono apagado');
    } else {
      const ok = await audio.enableMic();
      setMicOn(ok);
      showToast(ok ? 'La pared escucha la sala' : 'No pude usar el micrófono. Revisa el permiso del navegador.');
    }
  }, [showToast]);

  /** Patch the song that's playing in the playlist, so its next turn starts the same way. */
  const patchCurrent = useCallback((patch: Partial<QueueItem>) => {
    setPl((p) => {
      const cur = PL.current(p);
      if (!cur) return p;
      const items = p.items.map((x, i) => (i === p.cursor ? { ...x, ...patch } : x));
      return { ...p, items };
    });
  }, []);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;
  const nudge = (d: number) => {
    const next = Math.round((offsetRef.current + d) * 10) / 10;
    offsetRef.current = next;
    setOffset(next);
    patchCurrent({ nudge: next });
  };
  const togglePanel = useCallback(() => setPrefs((p) => ({ ...p, panelLyrics: !p.panelLyrics })), [setPrefs]);

  /* ---------- keyboard ---------- */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (settingsOpen || picking || session || side || (e.target as HTMLElement).matches('input, textarea')) return;
      const k = e.key.toLowerCase();
      if (e.code === 'Space' && performing) {
        e.preventDefault();
        playback.toggle();
      } else if (k === 'k') changeMode(mode === 'karaoke' ? 'lipsync' : 'karaoke');
      else if (k === '[') nudge(-0.2);
      else if (k === ']') nudge(0.2);
      else if (k === 'arrowleft' && performing) playback.seekBy(-5);
      else if (k === 'arrowright' && performing) playback.seekBy(5);
      else if (k === 'm') void toggleMic();
      else if (k === 't') {
        if (e.shiftKey) {
          audio.clearTempo();
          showToast('Ritmo manual apagado');
        } else {
          const bpm = audio.tap(performance.now());
          if (bpm) showToast(`${Math.round(bpm)} BPM`);
        }
      } else if (k === 'v' && performing) setShowVideo((v) => !v);
      else if (k === 'l') {
        if (mode === 'lipsync') togglePanel();
        else setShowLyrics((v) => !v);
      } else if (k === 'h' && performing) setIdle(true);
      else if (k === 'f') {
        if (document.fullscreenElement) void document.exitFullscreen();
        else void document.documentElement.requestFullscreen?.();
      } else if (k === 'escape' && performing && !document.fullscreenElement && !exitAsk && !queueOpen) {
        setQueueOpen(false);
        setExitAsk(true);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [performing, settingsOpen, picking, session, side, openAdjust, exitAsk, queueOpen, mode, changeMode, toggleMic, togglePanel, showToast, exit, setIdle]);

  // keep the next song's audio ready so the change is immediate
  useEffect(() => {
    const next = prefs.shuffle ? undefined : queue[0];
    if (!performing || !ready || !next || ytdlp === false) return;
    const t = setTimeout(() => {
      void loadTrack(next.choice.lip.id, playback.ctx).catch(() => undefined);
      if (next.choice.kar) void loadTrack(next.choice.kar.id, playback.ctx).catch(() => undefined);
    }, 4000);
    return () => clearTimeout(t);
  }, [pl, prefs.shuffle, performing, ready, ytdlp, song]);

  /* ---------- queue: the side panel flow (search → versions → timing → add) ---------- */
  const openSide = useCallback(() => {
    if (ytdlp === false) {
      showToast('La cola necesita yt-dlp para preparar cada canción');
      return;
    }
    setQueueOpen(false);
    setSide({ step: 'search' });
  }, [ytdlp, showToast]);
  openSideRef.current = openSide;
  const closeSide = useCallback(() => {
    sideRun.current++;
    playback.duck(false);
    setSide(null);
  }, []);
  const sidePickVideo = useCallback(
    async (id: string) => {
      try {
        const v = await api.video(id);
        const { song: s, kind: k } = await songFromVideo(v);
        if (prefsRef.current.quickAdd && k === 'original') void quickAddRef.current(s, v);
        else setSide({ step: 'pick', song: s, preset: { kind: k, video: v } });
      } catch {
        showToast('No pude leer ese video');
      }
    },
    [showToast],
  );
  const sideStart = useCallback(
    async (s: Song, c: Choice) => {
      const token = ++sideRun.current;
      const base = baseSession(s, c);
      setSide({ step: 'sync', session: base });
      try {
        await computeSession(
          base,
          c,
          (patch) =>
            setSide((cur) => (cur?.step === 'sync' && sideRun.current === token ? { ...cur, session: { ...cur.session, ...patch } } : cur)),
          () => sideRun.current === token,
        );
      } catch {
        if (sideRun.current !== token) return;
        setSide({ step: 'pick', song: s });
        showToast('No pude bajar esas versiones. Prueba con otras.');
      }
    },
    [showToast],
  );
  /** Quick mode: best version with vocals + best lyrics, timing aligned automatically, straight to the queue. */
  const quickAdd = useCallback(
    async (s: Song, preset?: Video) => {
      const key = `${s.key}:${Date.now()}`;
      const setState = (state: QuickJob['state']) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, state } : j)));
      setJobs((js) => [...js, { key, title: s.title, artist: s.artist, art: s.art, state: 'working' }]);
      try {
        const lipList = preset ? [preset] : await rankVersions(s, 'original');
        const lip = lipList[0];
        if (!lip) throw new Error('no version');
        const lyric = rankOptions(await catalogueOptions(s).catch(() => []), lip.duration)[0];
        const c: Choice = { lip, lyric, lipList, karList: [] };
        let sess = baseSession(s, c);
        const patch = await computeSession(sess, c, (p) => (sess = { ...sess, ...p }), () => true);
        if (!patch) throw new Error('cancelled');
        sess = { ...sess, ...patch };
        setPl((p) => PL.append(p, toItem(sess, sess.initial)));
        setState('done');
      } catch {
        setState('error');
      }
      // finished jobs fade away after a moment
      setTimeout(() => setJobs((js) => js.filter((j) => j.key !== key || j.state === 'working')), 4000);
    },
    [],
  );

  quickAddRef.current = quickAdd;
  const sideAdd = useCallback(
    (sess: Session, v: SlicerValues) => {
      setPl((p) => PL.append(p, toItem(sess, v)));
      showToast(`«${sess.song.title}» va en la cola`);
      setSide({ step: 'search' });
    },
    [showToast],
  );

  // the exit card goes away with the rest of the interface when the mouse rests
  useEffect(() => {
    if (idle) setExitAsk(false);
  }, [idle]);

  // settled messages fade after a moment
  useEffect(() => {
    if (!status || status.busy) return;
    const t = setTimeout(() => setStatus(null), 3500);
    return () => clearTimeout(t);
  }, [status]);

  const view = (x: QueueItem): QueueView => ({ key: x.key, song: x.song, karaoke: !!x.choice.kar });
  const queueViews: QueueView[] = queue.map(view);
  const panelOpen = mode === 'lipsync' && prefs.panelLyrics && lines.length > 0;
  const classes = [
    'app',
    `mode-${mode}`,
    performing && 'performing',
    idle && 'idle',
    settings.projector && 'projector',
    panelOpen && 'panel-open',
    side && 'side-open',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <MarqueeSpeed.Provider value={settings.marqueeSpeed}>
    <div className={classes}>
      <Backdrop
        intensity={settings.intensity}
        projector={settings.projector}
        visual={settings.visual}
        glass={settings.glass ? settings.glassAmount : 0}
        shape={settings.wallShape}
        zone={settings.zoneSeconds}
        artColor={performing && glow !== '#ff3324' ? glow : null}
        performing={performing}
      />
      <div className="scrim" aria-hidden="true" />

      <header className="top ui">
        <div className="brand">JustMusic</div>
        <div className="modes" role="group" aria-label="Modo">
          {(['lipsync', 'karaoke'] as Mode[]).map((m) => (
            <button key={m} aria-pressed={mode === m} onClick={() => changeMode(m)}>
              {m === 'karaoke' ? 'Karaoke' : 'Lipsync'}
            </button>
          ))}
        </div>
        <button className="icon" onClick={() => setSettingsOpen(true)} aria-label="Ajustes">
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
            <path d="M4 7h10M18 7h2M4 17h4M12 17h8" />
            <circle cx="16" cy="7" r="2" />
            <circle cx="10" cy="17" r="2" />
          </svg>
        </button>
      </header>

      {session && (
        <Slicer
          key={`${session.song.key}${session.live ? ':live' : ''}`}
          song={session.song}
          loading={session.loading}
          lip={slicerTrack(session.lip)}
          kar={slicerTrack(session.kar)}
          lines={session.lines}
          lyricDuration={session.lyricDuration}
          lyricLabel={session.lyricLabel}
          initial={session.initial}
          auto={session.auto}
          mode={session.live ? 'live' : 'start'}
          queued={queue.length}
          onAdd={(v) => {
            setPl((p) => PL.append(p, toItem(session, v)));
            showToast(`«${session.song.title}» va en la cola. Busca la siguiente.`);
            run.current++;
            setSession(null);
          }}
          onConfirm={(v) => {
            if (session.live) return closeAdjust(v);
            const item = toItem(session, v);
            const pending = plRef.current.cursor < 0 ? plRef.current.items : PL.upcoming(plRef.current);
            if (!pending.length) {
              setPl({ items: [item], cursor: 0, finished: false });
              return void begin(session, v);
            }
            // play the saved songs from the first; this one goes at the end
            const items = [...pending, item];
            setPl({ items, cursor: 0, finished: false });
            void beginItem(items[0]);
          }}
          onBack={() => {
            if (session.live) closeAdjust();
            else {
              run.current++;
              setSession(null);
              setPicking({ song: session.song });
            }
          }}
        />
      )}
      {!performing && !session && picking && (
        <Picker
          key={picking.song.key}
          song={picking.song}
          preset={picking.preset}
          canPrefetch={ytdlp !== false}
          onStart={(c) => void prepareSession(picking.song, c)}
          onBack={() => setPicking(null)}
        />
      )}
      {!performing && !picking && !session && (
        <>
          <Search mode={mode} onPickSong={(s) => setPicking({ song: s })} onPickVideo={(id) => void playVideo(id)} />
          {ytdlp === false && (
            <p className="setup-note ui">
              Sin <b>yt-dlp</b> el sonido viene de YouTube y la pared no puede leer el ritmo. Instálalo y reinicia la app.
            </p>
          )}
        </>
      )}

      {performing && mode === 'karaoke' && showLyrics && <Lyrics lines={lines} offset={offset + lyricShift} variant="stage" />}
      {performing && mode === 'lipsync' && lines.length > 0 && (
        <Lyrics lines={lines} offset={offset + lyricShift} variant="panel" open={panelOpen} />
      )}

      {song && (
        <NowPlaying
          song={song}
          mode={mode}
          kind={kind}
          playing={playing}
          ready={ready}
          glow={glow}
          status={status}
          lyricsOpen={panelOpen}
          hasLyrics={lines.length > 0}
          versions={versions[kind]}
          currentVideo={current[kind]}
          onToggle={() => playback.toggle()}
          playlist={pl.items.length > 1}
          canPrev={PL.canPrev(pl)}
          canNext={PL.canNext(pl, { shuffle: prefs.shuffle, repeat: prefs.repeat })}
          onPrev={goPrev}
          onNext={goNext}
          onLyrics={togglePanel}
          onPickVersion={(v) => void pickVersion(kind, v)}
        />
      )}

      <VideoDock visible={performing && showVideo} />

      {performing && (
        <Controls
          offset={offset}
          showLyrics={mode === 'lipsync' ? panelOpen : showLyrics}
          showVideo={showVideo}
          onNudge={nudge}
          onLyrics={() => (mode === 'lipsync' ? togglePanel() : setShowLyrics((v) => !v))}
          onVideo={() => setShowVideo((v) => !v)}
          onSync={openAdjust}
          onExit={() => {
            setQueueOpen(false);
            setExitAsk((a) => !a);
          }}
          exitOpen={exitAsk}
          queueActive={queue.length > 0}
          queueOpen={queueOpen}
          onQueue={() => {
            setExitAsk(false);
            if (pl.items.length <= (pl.cursor >= 0 ? 1 : 0)) openSide();
            else setQueueOpen((o) => !o);
          }}
        />
      )}

      {performing && queueOpen && !side && (
        <QueuePopover
          items={pl.items.length ? pl.items.map(view) : song ? [{ key: 'now', song, karaoke: kind === 'karaoke' }] : []}
          cursor={pl.items.length ? pl.cursor : 0}
          finished={pl.finished}
          playing={playing}
          shuffle={prefs.shuffle}
          repeat={prefs.repeat}
          onShuffle={(on) => setPrefs((p) => ({ ...p, shuffle: on, repeat: on ? false : p.repeat }))}
          onRepeat={(on) => setPrefs((p) => ({ ...p, repeat: on }))}
          onAdd={openSide}
          onRemove={(key) => setPl((p) => PL.remove(p, key))}
          onReorder={(key, to) => setPl((p) => PL.move(p, key, to))}
          onPlay={(key) => {
            const i = plRef.current.items.findIndex((x) => x.key === key);
            if (i < 0) return;
            setQueueOpen(false);
            playAt(i);
          }}
          onClose={() => setQueueOpen(false)}
        />
      )}

      {performing && exitAsk && !side && (
        <ExitConfirm
          count={pl.items.length}
          onClose={() => setExitAsk(false)}
          onConfirm={() => {
            setExitAsk(false);
            exit();
            setPl(PL.empty<QueueItem>());
          }}
        />
      )}

      {side && (
        <QueueSide
          title={side.step === 'search' ? 'Añadir a la cola' : side.step === 'pick' ? side.song.title : 'Sincroniza'}
          canBack={side.step !== 'search'}
          stepKey={side.step}
          onBack={() => {
            if (side.step === 'sync') {
              sideRun.current++;
              playback.duck(false);
              setSide({ step: 'pick', song: side.session.song });
            } else if (side.step === 'pick') setSide({ step: 'search' });
          }}
          onClose={closeSide}
        >
          {side.step === 'search' && (
            <Search
              mode={mode}
              embedded
              quick={prefs.quickAdd}
              onQuick={(on) => setPrefs((p) => ({ ...p, quickAdd: on }))}
              jobs={jobs}
              onPickSong={(s) => (prefs.quickAdd ? void quickAdd(s) : setSide({ step: 'pick', song: s }))}
              onPickVideo={(id) => void sidePickVideo(id)}
            />
          )}
          {side.step === 'pick' && (
            <Picker
              key={side.song.key}
              song={side.song}
              preset={side.preset}
              canPrefetch={ytdlp !== false}
              actionLabel="Continuar"
              onStart={(c) => void sideStart(side.song, c)}
              onBack={() => setSide({ step: 'search' })}
            />
          )}
          {side.step === 'sync' && (
            <Slicer
              key={side.session.song.key}
              song={side.session.song}
              loading={side.session.loading}
              lip={slicerTrack(side.session.lip)}
              kar={slicerTrack(side.session.kar)}
              lines={side.session.lines}
              lyricDuration={side.session.lyricDuration}
              lyricLabel={side.session.lyricLabel}
              initial={side.session.initial}
              auto={side.session.auto}
              mode="queue"
              onConfirm={(v) => sideAdd(side.session, v)}
              onBack={() => setSide({ step: 'pick', song: side.session.song })}
            />
          )}
        </QueueSide>
      )}

      {!performing && !session && !picking && queue.length > 0 && (
        <QueueChip
          items={queueViews}
          onStart={() => {
            const items = PL.upcoming(pl);
            setPl({ items, cursor: 0, finished: false });
            void beginItem(items[0]);
          }}
          onClear={() => setPl(PL.empty<QueueItem>())}
        />
      )}

      <Settings
        open={settingsOpen}
        micOn={micOn}
        onMic={() => void toggleMic()}
        settings={settings}
        onChange={setSettings}
        onClose={() => setSettingsOpen(false)}
      />

      <div className={`toast${toast ? ' show' : ''}`} role="status">
        {toast?.text}
      </div>
    </div>
    </MarqueeSpeed.Provider>
  );
}
