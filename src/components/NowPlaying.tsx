import { useEffect, useLayoutEffect, useRef, useState, type PointerEvent } from 'react';
import type { Song, Video } from '../services/api';
import type { Kind } from '../services/resolve';
import type { Mode } from '../model';
import { playback } from '../engine/playback';
import { formatTime } from '../services/lyrics';
import { Marquee } from './Marquee';

export interface Status {
  text: string;
  busy: boolean;
}

interface Props {
  song: Song;
  mode: Mode;
  kind: Kind;
  playing: boolean;
  ready: boolean;
  glow: string;
  status: Status | null;
  lyricsOpen: boolean;
  hasLyrics: boolean;
  versions: Video[];
  currentVideo?: string;
  onToggle: () => void;
  /** a playlist is loaded: show previous / next */
  playlist?: boolean;
  canPrev?: boolean;
  canNext?: boolean;
  onPrev?: () => void;
  onNext?: () => void;
  onLyrics: () => void;
  onPickVersion: (v: Video) => void;
}

const fallbackArt = (url: string) => url.replace('maxresdefault', 'mqdefault');

/** A ripple like a drop on still water: restart the animation on every press. */
const ripple = (e: React.PointerEvent<HTMLButtonElement>) => {
  const b = e.currentTarget;
  if (b.disabled) return;
  b.classList.remove('ripple');
  void b.offsetWidth;
  b.classList.add('ripple');
};

const Icon = ({ d, size = 22 }: { d: string; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={d} />
  </svg>
);

/** Lock-screen style now playing: big and centred for lipsync, a compact card for karaoke. */
export function NowPlaying(p: Props) {
  const { song, mode } = p;
  const art = useRef<HTMLDivElement>(null);
  const fill = useRef<HTMLDivElement>(null);
  const elapsed = useRef<HTMLSpanElement>(null);
  const remain = useRef<HTMLSpanElement>(null);
  const lastRect = useRef<DOMRect | null>(null);
  const [src, setSrc] = useState(song.art);
  const [scrub, setScrub] = useState<number | null>(null);
  const [menu, setMenu] = useState(false);
  const scrubRef = useRef<number | null>(null);
  scrubRef.current = scrub;

  useEffect(() => setSrc(song.art), [song.art]);
  useEffect(() => setMenu(false), [mode, p.kind]);

  useEffect(() => {
    let raf = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const dur = playback.duration();
      const t = scrubRef.current !== null ? scrubRef.current * dur : playback.deckTime(now);
      const f = dur ? Math.min(1, t / dur) : 0;
      fill.current?.style.setProperty('--p', f.toFixed(5));
      if (elapsed.current) elapsed.current.textContent = formatTime(t);
      if (remain.current) remain.current.textContent = dur ? `-${formatTime(dur - t)}` : '';
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  // the artwork glides between the two layouts
  useLayoutEffect(() => {
    const el = art.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    if (mode === 'lipsync') {
      document.documentElement.style.setProperty('--art-cy', `${r.top + r.height / 2}px`);
      // the card may still be gliding into place; measure again once it has landed
      window.setTimeout(() => {
        const r2 = el.getBoundingClientRect();
        if (el.closest('.np.big')) document.documentElement.style.setProperty('--art-cy', `${r2.top + r2.height / 2}px`);
      }, 1100);
    }
    const prev = lastRect.current;
    lastRect.current = r;
    if (!prev || (prev.width === r.width && prev.left === r.left && prev.top === r.top)) return;
    el.animate(
      [{ transform: `translate(${prev.left - r.left}px, ${prev.top - r.top}px) scale(${prev.width / r.width})` }, { transform: 'none' }],
      { duration: 820, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' },
    );
  }, [mode]);
  useEffect(() => {
    const el = art.current;
    if (!el) return;
    // keep the reference rect current while the card moves for other reasons (lyrics panel, resize)
    const keep = () => {
      const r = el.getBoundingClientRect();
      lastRect.current = r;
      if (el.closest('.np.big')) document.documentElement.style.setProperty('--art-cy', `${r.top + r.height / 2}px`);
    };
    el.closest('.np')?.addEventListener('transitionend', keep);
    window.addEventListener('resize', keep);
    return () => {
      el.closest('.np')?.removeEventListener('transitionend', keep);
      window.removeEventListener('resize', keep);
    };
  }, []);

  const fracAt = (e: PointerEvent<HTMLDivElement>) => {
    const r = e.currentTarget.getBoundingClientRect();
    return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
  };

  const big = mode === 'lipsync';
  const cls = ['np', big ? 'big' : 'mini', big && p.lyricsOpen ? 'with-lyrics' : '', p.ready ? '' : 'loading'].filter(Boolean).join(' ');

  return (
    <section className={cls} style={{ ['--glow' as string]: p.glow }} aria-label="Reproduciendo">
      <div className="np-art" ref={art}>
        {src ? <img src={src} alt="" onError={() => src && setSrc(fallbackArt(src))} /> : <div className="np-art-empty" />}
      </div>

      <div className="np-meta" key={mode}>
        <div className="np-titles">
          <Marquee as="b" text={song.title} />
          <Marquee text={song.artist} className="np-artist" />
        </div>
        <div className="np-version">
          <button className="np-kind" onClick={() => setMenu((m) => !m)} aria-expanded={menu} disabled={p.versions.length < 2}>
            {p.kind === 'karaoke' ? 'Karaoke' : 'Original'}
            {p.versions.length > 1 && <Icon d="M7 10l5 5 5-5" size={14} />}
          </button>
          {menu && (
            <ul className="np-menu" role="listbox" aria-label="Elegir otra pista">
              {p.versions.map((v) => (
                <li key={v.id}>
                  <button
                    aria-selected={v.id === p.currentVideo}
                    onClick={() => {
                      setMenu(false);
                      if (v.id !== p.currentVideo) p.onPickVersion(v);
                    }}
                  >
                    <b>{v.title}</b>
                    <span>
                      {v.channel}
                      {v.duration ? ` · ${formatTime(v.duration)}` : ''}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      <div className="np-progress">
        <div
          className={`np-bar${scrub !== null ? ' scrubbing' : ''}`}
          ref={fill}
          role="slider"
          aria-label="Posición"
          aria-valuemin={0}
          aria-valuemax={100}
          tabIndex={0}
          onPointerDown={(e) => {
            e.currentTarget.setPointerCapture(e.pointerId);
            setScrub(fracAt(e));
          }}
          onPointerMove={(e) => scrub !== null && setScrub(fracAt(e))}
          onPointerUp={(e) => {
            if (scrub === null) return;
            playback.seekDeck(fracAt(e) * playback.duration());
            setScrub(null);
          }}
        >
          <i />
        </div>
        <div className="np-times">
          <span ref={elapsed}>0:00</span>
          <span ref={remain} />
        </div>
      </div>

      <div className={`np-controls${p.playlist ? ' with-playlist' : ''}`}>
        {big && <span className="np-spacer" />}
        {p.playlist && (
          <button className="np-track" onPointerDown={ripple} onClick={p.onPrev} disabled={!p.canPrev} aria-label="Canción anterior" title="Canción anterior">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M6 5v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <path d="M18.5 5.6v12.8c0 .8-.9 1.3-1.6.8L8.4 13a1.2 1.2 0 0 1 0-2l8.5-6.2c.7-.5 1.6 0 1.6.8z" fill="currentColor" />
            </svg>
          </button>
        )}
        <button className="np-skip" onPointerDown={ripple} onClick={() => playback.seekBy(-10)} aria-label="Atrás 10 segundos">
          <Icon d="M4 12a8 8 0 1 0 2.4-5.7L4 8.5M4 4v4.5h4.5" />
        </button>
        <button className="np-play" onPointerDown={ripple} onClick={p.onToggle} aria-label={p.playing ? 'Pausar' : 'Reproducir'}>
          <svg viewBox="0 0 24 24" width="30" height="30" aria-hidden="true">
            {p.playing ? (
              <g fill="currentColor">
                <rect x="6" y="4.5" width="4" height="15" rx="1.2" />
                <rect x="14" y="4.5" width="4" height="15" rx="1.2" />
              </g>
            ) : (
              <path d="M7 4.8v14.4c0 .8.9 1.3 1.6.9l11.3-7.2c.6-.4.6-1.3 0-1.7L8.6 3.9C7.9 3.5 7 4 7 4.8z" fill="currentColor" />
            )}
          </svg>
        </button>
        <button className="np-skip" onPointerDown={ripple} onClick={() => playback.seekBy(10)} aria-label="Adelante 10 segundos">
          <Icon d="M20 12a8 8 0 1 1-2.4-5.7L20 8.5M20 4v4.5h-4.5" />
        </button>
        {p.playlist && (
          <button className="np-track" onPointerDown={ripple} onClick={p.onNext} disabled={!p.canNext} aria-label="Canción siguiente" title="Canción siguiente">
            <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
              <path d="M18 5v14" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
              <path d="M5.5 5.6v12.8c0 .8.9 1.3 1.6.8l8.5-6.2a1.2 1.2 0 0 0 0-2L7.1 4.8c-.7-.5-1.6 0-1.6.8z" fill="currentColor" />
            </svg>
          </button>
        )}
        {big && (
          <button
            className={`np-lyrics${p.lyricsOpen ? ' on' : ''}`}
            onClick={p.onLyrics}
            aria-pressed={p.lyricsOpen}
            aria-label="Letra"
            title="Letra (L)"
            disabled={!p.hasLyrics}
          >
            <Icon d="M4 6h11M4 10h16M4 14h9M4 18h13" size={20} />
          </button>
        )}
      </div>

      {p.status && (
        <div className={`np-status${p.status.busy ? ' busy' : ''}`} role="status" key={p.status.text.replace(/\d+%$/, '')}>
          {p.status.text}
        </div>
      )}
    </section>
  );
}
