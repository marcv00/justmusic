import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { api, parseYouTubeId, type Song, type Video } from '../services/api';
import { formatTime } from '../services/lyrics';
import type { Mode } from '../model';

export interface QuickJob {
  key: string;
  title: string;
  artist: string;
  art?: string;
  state: 'working' | 'done' | 'error';
}

interface Props {
  mode: Mode;
  /** inside the queue panel: a quieter heading */
  embedded?: boolean;
  /** queue panel only: quick mode adds the song straight away */
  quick?: boolean;
  onQuick?: (on: boolean) => void;
  jobs?: QuickJob[];
  onPickSong: (s: Song) => void;
  onPickVideo: (id: string) => void;
}

const heroText: Record<Mode, string> = { karaoke: 'Canta.', lipsync: 'Mueve los labios.' };

/** One box for everything: type to search the catalogue, or paste a YouTube link. */
export function Search({ mode, embedded, quick, onQuick, jobs = [], onPickSong, onPickVideo }: Props) {
  const [q, setQ] = useState('');
  const [results, setResults] = useState<Song[]>([]);
  const [videos, setVideos] = useState<Video[]>([]);
  const [state, setState] = useState<'idle' | 'loading' | 'done' | 'error'>('idle');
  const [sel, setSel] = useState(0);
  const input = useRef<HTMLInputElement>(null);
  const videoId = parseYouTubeId(q);

  useEffect(() => input.current?.focus(), []);

  useEffect(() => {
    if (videoId || q.trim().length < 2) {
      setResults([]);
      setVideos([]);
      setState('idle');
      return;
    }
    const ac = new AbortController();
    setState('loading');
    const t = setTimeout(() => {
      api
        .search(q.trim(), ac.signal)
        .then((r) => {
          setResults(r.songs);
          setVideos(r.videos);
          setSel(0);
          setState('done');
        })
        .catch(() => !ac.signal.aborted && setState('error'));
    }, 280);
    return () => {
      clearTimeout(t);
      ac.abort();
    };
  }, [q, videoId]);

  const onKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSel((s) => Math.min(results.length + videos.length - 1, s + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSel((s) => Math.max(0, s - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      if (videoId) onPickVideo(videoId);
      else if (results[sel]) onPickSong(results[sel]);
      else if (videos[sel - results.length]) onPickVideo(videos[sel - results.length].id);
    }
  };

  return (
    <main className={`home ui${embedded ? ' embedded' : ''}`}>
      {embedded ? (
        <h2 className="hero-small">¿Qué sigue?</h2>
      ) : (
        <h1 className="hero" key={mode}>
          {heroText[mode]}
        </h1>
      )}

      <div className="search">
        <input
          ref={input}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          onKeyDown={onKey}
          placeholder="Busca una canción o pega un link de YouTube"
          aria-label="Busca una canción o pega un link de YouTube"
          autoComplete="off"
          spellCheck={false}
        />
        <span className={`search-dot${state === 'loading' ? ' on' : ''}`} aria-hidden="true" />
      </div>

      {embedded && (
        <div className="quick">
          <label className="quick-toggle">
            <span>
              <b>Modo rápido</b>
              <small>
                Solo busca la versión con voz y la letra; no habrá versión karaoke y la sincronía se ajusta sola. Tocas la canción y va
                directo a la cola.
              </small>
            </span>
            <input type="checkbox" role="switch" checked={!!quick} onChange={(e) => onQuick?.(e.target.checked)} />
          </label>
          {jobs.length > 0 && (
            <ul className="quick-jobs" aria-live="polite">
              {jobs.map((j) => (
                <li key={j.key} className={j.state}>
                  {j.art ? <img src={j.art.replace('600x600', '120x120')} alt="" /> : <i />}
                  <span>
                    <b>{j.title}</b>
                    <small>{j.state === 'working' ? 'Preparando…' : j.state === 'done' ? 'En la cola' : 'No pude prepararla'}</small>
                  </span>
                  <em aria-hidden="true">{j.state === 'working' ? '' : j.state === 'done' ? '✓' : '!'}</em>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}

      {videoId && (
        <button className="song paste-hit" onClick={() => onPickVideo(videoId)}>
          <img src={`https://i.ytimg.com/vi/${videoId}/mqdefault.jpg`} alt="" />
          <span>
            <b>Video de YouTube</b>
            <span className="muted">Enter para empezar; busco la letra y la otra versión</span>
          </span>
        </button>
      )}

      {!videoId && state === 'error' && <p className="hint warn">No pude buscar. Revisa que la app esté corriendo con npm run dev.</p>}
      {!videoId && state === 'done' && !results.length && !videos.length && <p className="hint">Nada con ese nombre. Prueba con el artista y la canción, o pega un link.</p>}
      {!videoId && state === 'idle' && !q && (
        <p className="hint">Escribe artista y canción. Encuentro la pista original, la versión karaoke y la letra; cambias de modo cuando quieras.</p>
      )}

      {!videoId && (results.length > 0 || videos.length > 0) && (
        <ul className="songs" role="listbox" aria-label="Resultados">
          {results.map((s, i) => (
            <li key={s.key} role="option" aria-selected={i === sel}>
              <button className={`song${i === sel ? ' sel' : ''}`} style={{ animationDelay: `${i * 35}ms` }} onClick={() => onPickSong(s)} onMouseEnter={() => setSel(i)}>
                {s.art ? <img src={s.art.replace('600x600', '120x120')} alt="" loading="lazy" /> : <span className="thumb" aria-hidden="true">♪</span>}
                <span>
                  <b>{s.title}</b>
                  <span className="muted">
                    {s.artist}
                    {s.album ? ` · ${s.album}` : ''}
                  </span>
                </span>
                {s.duration ? <span className="dur">{formatTime(s.duration)}</span> : null}
              </button>
            </li>
          ))}
          {videos.length > 0 && <li className="songs-label">En YouTube</li>}
          {videos.map((v, i) => (
            <li key={v.id} role="option" aria-selected={results.length + i === sel}>
              <button
                className={`song video-hit${results.length + i === sel ? ' sel' : ''}`}
                style={{ animationDelay: `${(results.length + i) * 35}ms` }}
                onClick={() => onPickVideo(v.id)}
                onMouseEnter={() => setSel(results.length + i)}
              >
                <img src={v.thumb || `https://i.ytimg.com/vi/${v.id}/mqdefault.jpg`} alt="" loading="lazy" />
                <span>
                  <b>{v.title}</b>
                  <span className="muted">{v.channel}</span>
                </span>
                {v.duration ? <span className="dur">{formatTime(v.duration)}</span> : null}
              </button>
            </li>
          ))}
        </ul>
      )}
    </main>
  );
}
