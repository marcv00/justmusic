import { useEffect, useMemo, useRef, useState } from 'react';
import type { Song, Video } from '../services/api';
import { rankVersions, type Ranked } from '../services/resolve';
import { captionOptions, catalogueOptions, queryOptions, rankOptions, type LyricOption } from '../services/lyricOptions';
import { formatTime } from '../services/lyrics';
import { loadTrack } from '../engine/analysis';
import { playback } from '../engine/playback';

export interface Choice {
  /** the cover the person chose in the picker, if they changed it */
  art?: string;
  lip: Video;
  kar?: Video;
  lyric?: LyricOption;
  lipList: Video[];
  karList: Video[];
}

interface Props {
  song: Song;
  preset?: { kind: 'original' | 'karaoke'; video: Video };
  canPrefetch: boolean;
  actionLabel?: string;
  onStart: (c: Choice) => void;
  onBack: () => void;
}

type Load = 'loading' | 'ready' | 'error';

function VersionList({
  title, hint, state, list, selected, onSelect, ready, lyricDuration, allowNone, noneLabel, coverMode, onCover,
}: {
  title: string;
  hint: string;
  state: Load;
  list: Ranked[];
  selected: string | null;
  onSelect: (id: string | null) => void;
  ready: Set<string>;
  lyricDuration?: number;
  allowNone?: boolean;
  noneLabel?: string;
  coverMode?: boolean;
  onCover?: (v: Ranked) => void;
}) {
  return (
    <section className={`pick-col${coverMode ? ' cover-mode' : ''}`}>
      <header>
        <h2>{title}</h2>
        <p>{hint}</p>
      </header>
      <ul role="radiogroup" aria-label={title}>
        {state === 'loading' && Array.from({ length: 4 }, (_, i) => <li key={i} className="pick-skel" style={{ animationDelay: `${i * 90}ms` }} />)}
        {state === 'error' && <li className="pick-empty">No pude buscar en YouTube.</li>}
        {state === 'ready' && !list.length && <li className="pick-empty">Sin resultados.</li>}
        {list.map((v, i) => {
          const match = lyricDuration && v.duration ? Math.abs(v.duration - lyricDuration) < 2.5 : false;
          return (
            <li key={v.id}>
              <button
                role="radio"
                aria-checked={selected === v.id}
                className={`pick-item${selected === v.id ? ' on' : ''}`}
                style={{ animationDelay: `${i * 40}ms` }}
                onClick={() => (coverMode ? onCover?.(v) : onSelect(v.id))}
              >
                <span className="pick-thumb">
                  <img src={v.thumb || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`} alt="" loading="lazy" />
                  {v.duration ? <span className="pick-dur">{formatTime(v.duration)}</span> : null}
                </span>
                <span className="pick-text">
                  <b>{v.title}</b>
                  <span className="muted">{v.channel}</span>
                  <span className="pick-tags">
                    {v.recommended && <i className="tag rec">Sugerida</i>}
                    {v.official && <i className="tag">Oficial</i>}
                    {match && <i className="tag ok">Dura lo mismo que la letra</i>}
                    {ready.has(v.id) && <i className="tag ready">Lista</i>}
                  </span>
                </span>
                <span className="pick-radio" aria-hidden="true" />
              </button>
            </li>
          );
        })}
        {allowNone && state === 'ready' && (
          <li>
            <button role="radio" aria-checked={selected === null} className={`pick-item none${selected === null ? ' on' : ''}`} onClick={() => onSelect(null)}>
              <span className="pick-text">
                <b>{noneLabel}</b>
              </span>
              <span className="pick-radio" aria-hidden="true" />
            </button>
          </li>
        )}
      </ul>
    </section>
  );
}

/** Before a song starts: pick the version with vocals, the karaoke version, and the lyrics. */
export function Picker({ song, preset, canPrefetch, actionLabel = 'Empezar', onStart, onBack }: Props) {
  const [lipState, setLipState] = useState<Load>('loading');
  const [karState, setKarState] = useState<Load>('loading');
  const [lip, setLip] = useState<Ranked[]>([]);
  const [kar, setKar] = useState<Ranked[]>([]);
  const [selLip, setSelLip] = useState<string | null>(null);
  const [selKar, setSelKar] = useState<string | null>(null);
  const [catalogue, setCatalogue] = useState<LyricOption[]>([]);
  const [captions, setCaptions] = useState<LyricOption[]>([]);
  const [extra, setExtra] = useState<LyricOption[]>([]);
  const [lyrState, setLyrState] = useState<Load>('loading');
  const [capState, setCapState] = useState<Load | 'idle'>('idle');
  const [selLyric, setSelLyric] = useState<string | null | undefined>(undefined);
  const [query, setQuery] = useState(`${song.artist} ${song.title}`);
  const [ready, setReady] = useState<Set<string>>(new Set());
  const [art, setArt] = useState(song.art);
  const [coverMode, setCoverMode] = useState(false);
  const thumbArt = (id: string) => `https://i.ytimg.com/vi/${id}/maxresdefault.jpg`;
  const pickCover = (v: Ranked) => {
    setArt(thumbArt(v.id));
    setCoverMode(false);
  };
  // cover mode ends with any click that isn't on a result (the result's own click picks it)
  useEffect(() => {
    if (!coverMode) return;
    const onDown = (e: PointerEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('.pick-item:not(.none)') || t.closest('.pick-cover')) return;
      setCoverMode(false);
    };
    window.addEventListener('pointerdown', onDown, true);
    return () => window.removeEventListener('pointerdown', onDown, true);
  }, [coverMode]);
  const startBtn = useRef<HTMLButtonElement>(null);

  // both lists and the catalogue lyrics, in parallel
  useEffect(() => {
    const ac = new AbortController();
    const presetRanked = (k: 'original' | 'karaoke'): Ranked[] =>
      preset?.kind === k ? [{ ...preset.video, official: false, karaokeTagged: k === 'karaoke', recommended: false }] : [];
    rankVersions(song, 'original', ac.signal)
      .then((l) => {
        const list = [...presetRanked('original'), ...l.filter((v) => v.id !== preset?.video.id)];
        setLip(list);
        setSelLip((s) => s ?? list[0]?.id ?? null);
        setLipState('ready');
      })
      .catch(() => !ac.signal.aborted && setLipState('error'));
    rankVersions(song, 'karaoke', ac.signal)
      .then((l) => {
        const list = [...presetRanked('karaoke'), ...l.filter((v) => v.id !== preset?.video.id)];
        setKar(list);
        // only preselect a karaoke track we're confident about
        setSelKar((s) => s ?? (list[0] && (list[0].karaokeTagged || preset?.kind === 'karaoke') ? list[0].id : null));
        setKarState('ready');
      })
      .catch(() => !ac.signal.aborted && setKarState('error'));
    catalogueOptions(song, ac.signal)
      .then((o) => {
        setCatalogue(o);
        setLyrState('ready');
      })
      .catch(() => !ac.signal.aborted && setLyrState('error'));
    return () => ac.abort();
  }, [song, preset]);

  // the chosen video's own subtitles
  useEffect(() => {
    if (!selLip || !canPrefetch) return;
    const ac = new AbortController();
    setCapState('loading');
    setCaptions([]);
    const t = setTimeout(() => {
      captionOptions(selLip, ac.signal)
        .then((o) => {
          setCaptions(o);
          setCapState('ready');
        })
        .catch(() => !ac.signal.aborted && setCapState('error'));
    }, 500);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [selLip, canPrefetch]);

  // start downloading what's selected, so "Empezar" is instant
  useEffect(() => {
    if (!canPrefetch) return;
    const ids = [selLip, selKar].filter((x): x is string => !!x);
    const t = setTimeout(() => {
      for (const id of ids) {
        loadTrack(id, playback.ctx)
          .then(() => setReady((r) => new Set(r).add(id)))
          .catch(() => undefined);
      }
    }, 650);
    return () => clearTimeout(t);
  }, [selLip, selKar, canPrefetch]);

  const lipVideo = lip.find((v) => v.id === selLip);
  const options = useMemo(
    () => rankOptions([...captions, ...extra, ...catalogue], lipVideo?.duration),
    [captions, extra, catalogue, lipVideo?.duration],
  );
  // follow the best option until the person chooses one themselves
  const chosenLyric = selLyric === undefined ? options[0] : selLyric === null ? undefined : options.find((o) => o.key === selLyric);
  const lyricDuration = chosenLyric?.kind === 'reference' ? chosenLyric.duration : undefined;

  const searchLyrics = () => {
    if (!query.trim()) return;
    setLyrState('loading');
    queryOptions(query.trim())
      .then((o) => {
        setExtra(o);
        setLyrState('ready');
        if (o[0]) setSelLyric(o[0].key);
      })
      .catch(() => setLyrState('error'));
  };

  const start = () => {
    if (!lipVideo) return;
    onStart({ art: art !== song.art ? art : undefined, lip: lipVideo, kar: kar.find((v) => v.id === selKar), lyric: chosenLyric, lipList: lip, karList: kar });
  };

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement).matches('input')) return;
      if (e.key === 'Escape' && coverMode) {
        e.stopImmediatePropagation();
        setCoverMode(false);
        return;
      }
      if (e.key === 'Enter' && lipVideo) start();
      if (e.key === 'Escape') onBack();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  return (
    <main className="picker ui">
      <header className="pick-head">
        <button className="pick-back" onClick={onBack} aria-label="Volver a buscar">
          <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        <button
          className={`pick-cover${coverMode ? ' picking' : ''}`}
          onClick={() => setCoverMode((m) => !m)}
          aria-pressed={coverMode}
          aria-label="Cambiar la portada"
          title="Cambiar la portada"
        >
          {art ? (
            <img key={art} className="pick-art" src={art} alt="" onError={() => art.includes('maxresdefault') && setArt(art.replace('maxresdefault', 'mqdefault'))} />
          ) : (
            <span className="pick-art empty" />
          )}
          <span className="pick-cover-edit" aria-hidden="true">
            <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M4 20h4L19 9l-4-4L4 16z" /></svg>
          </span>
        </button>
        <div>
          <b>{song.title}</b>
          <span className="muted pick-sub" key={coverMode ? 'hint' : 'artist'}>
            {coverMode ? 'Toca una miniatura para usarla de portada' : song.artist}
          </span>
        </div>
      </header>

      <div className="pick-cols">
        <VersionList
          title="Lipsync"
          hint="La versión con voz. Su duración manda sobre la letra."
          state={lipState}
          list={lip}
          selected={selLip}
          onSelect={(id) => setSelLip(id)}
          ready={ready}
          lyricDuration={lyricDuration}
          coverMode={coverMode}
          onCover={pickCover}
        />
        <VersionList
          title="Karaoke"
          hint="La pista sin voz. JustMusic la alinea con la de lipsync."
          state={karState}
          list={kar}
          selected={selKar}
          onSelect={setSelKar}
          ready={ready}
          allowNone
          noneLabel="Sin versión karaoke"
          coverMode={coverMode}
          onCover={pickCover}
        />
      </div>

      <footer className="pick-foot">
        <div className="pick-lyrics">
          <div className="pick-lyrics-head">
            <h2>Letra</h2>
            <form
              className="pick-lyrics-search"
              onSubmit={(e) => {
                e.preventDefault();
                searchLyrics();
              }}
            >
              <input value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Buscar otra letra" placeholder="Buscar otra letra" />
              <button type="submit">Buscar</button>
            </form>
          </div>
          <div
            className="chips"
            role="radiogroup"
            aria-label="Fuente de la letra"
            onWheel={(e) => {
              if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) e.currentTarget.scrollLeft += e.deltaY;
            }}
          >
            {(lyrState === 'loading' || capState === 'loading') && <span className="chip skel">Buscando letras…</span>}
            {options.map((o) => (
              <button
                key={o.key}
                role="radio"
                aria-checked={chosenLyric?.key === o.key}
                className={`chip${chosenLyric?.key === o.key ? ' on' : ''}`}
                onClick={() => setSelLyric(o.key)}
                title={o.detail}
              >
                <b>{o.label}</b>
                <span>{o.detail}</span>
              </button>
            ))}
            <button role="radio" aria-checked={!chosenLyric} className={`chip${!chosenLyric ? ' on' : ''}`} onClick={() => setSelLyric(null)}>
              <b>Sin letra</b>
            </button>
            {lyrState === 'ready' && capState !== 'loading' && !options.length && (
              <span className="chip-note">No encontré letra. Prueba buscando con otras palabras.</span>
            )}
          </div>
        </div>
        <button ref={startBtn} className="btn solid pick-start" disabled={!lipVideo} onClick={start}>
          {actionLabel}
        </button>
      </footer>
    </main>
  );
}
