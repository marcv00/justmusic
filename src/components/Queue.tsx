import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Song } from '../services/api';

export interface QueueView {
  key: string;
  song: Song;
  karaoke: boolean;
}

const Plus = ({ size = 18 }: { size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" aria-hidden="true">
    <path d="M12 5v14M5 12h14" />
  </svg>
);

/** Spotify-style queue glyph: three lines and a small play mark. */
export const QueueIcon = () => (
  <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d="M4 6h11M4 11h11M4 16h6" />
    <path d="M15 14.5v5l4-2.5z" fill="currentColor" stroke="none" />
  </svg>
);

const Icon = ({ children, size = 17 }: { children: ReactNode; size?: number }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    {children}
  </svg>
);
/** in order: two arrows pointing right */
const OrderIcon = () => (
  <Icon>
    <path d="M4 8h13M14 5l3 3-3 3" />
    <path d="M4 16h13M14 13l3 3-3 3" />
  </Icon>
);
/** shuffle: crossed arrows */
const ShuffleIcon = () => (
  <Icon>
    <path d="M4 7h3.5c2 0 3.1 1 4.2 2.7l1.6 2.6c1.1 1.7 2.2 2.7 4.2 2.7H20" />
    <path d="M17.5 12.5L20 15l-2.5 2.5" />
    <path d="M4 17h3.5c1.3 0 2.2-.4 3-1.2M13.6 8.2c.8-.8 1.7-1.2 3-1.2H20" />
    <path d="M17.5 4.5L20 7l-2.5 2.5" />
  </Icon>
);
/** repeat the playlist: a loop */
const RepeatIcon = () => (
  <Icon>
    <path d="M17 3l3 3-3 3" />
    <path d="M4 11V9a3 3 0 0 1 3-3h13" />
    <path d="M7 21l-3-3 3-3" />
    <path d="M20 13v2a3 3 0 0 1-3 3H4" />
  </Icon>
);

type Kind = 'past' | 'now' | 'next';

function Row({
  it, kind, dim, leaving, delay, dragging, onPlay, onRemove, onGrab,
}: {
  it: QueueView;
  kind: Kind;
  dim: boolean;
  leaving?: boolean;
  delay: number;
  dragging: boolean;
  onPlay?: () => void;
  onRemove?: () => void;
  onGrab: (e: React.PointerEvent<HTMLLIElement>) => void;
}) {
  return (
    <li
      className={`${kind}${dim ? ' dim' : ''}${leaving ? ' leaving' : ''}${dragging ? ' dragging' : ''}`}
      style={{ ['--d' as string]: `${delay}ms` }}
      data-key={it.key}
      data-kind={kind}
      onPointerDown={onGrab}
    >
      <button
        className="queue-row"
        onClick={onPlay}
        tabIndex={kind === 'now' ? -1 : 0}
        title={kind === 'past' ? 'Volver a cantarla' : kind === 'next' ? 'Reproducir ahora' : undefined}
      >
        <span className="queue-art">
          {it.song.art ? <img src={it.song.art.replace('600x600', '120x120')} alt="" draggable={false} /> : <i />}
          {kind === 'now' ? (
            <span className="queue-eq" aria-label="Sonando">
              <i />
              <i />
              <i />
            </span>
          ) : (
            <span className="queue-play" aria-hidden="true">
              <svg viewBox="0 0 24 24" width="16" height="16"><path d="M8 5.5v13l10.5-6.5z" fill="currentColor" /></svg>
            </span>
          )}
        </span>
        <span className="queue-text">
          <b>{it.song.title}</b>
          <span>
            {it.song.artist}
            {it.karaoke ? ' · karaoke' : ''}
          </span>
        </span>
      </button>
      {onRemove && (
        <button className="queue-x" onClick={onRemove} aria-label={`Quitar ${it.song.title}`}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      )}
      <span className="queue-grip" aria-hidden="true">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="9" cy="7" r="1.4" /><circle cx="15" cy="7" r="1.4" /><circle cx="9" cy="12" r="1.4" /><circle cx="15" cy="12" r="1.4" /><circle cx="9" cy="17" r="1.4" /><circle cx="15" cy="17" r="1.4" /></svg>
      </span>
    </li>
  );
}

/**
 * The playlist in place above its button: played songs (dimmed until the playlist is over),
 * the one playing (centred when it opens), and what's next. Rows drag to reorder, the playing
 * one included. Top right: play in order or shuffle, and repeat the playlist.
 */
export function QueuePopover({
  items, cursor, finished, playing, shuffle, repeat, onShuffle, onRepeat, onAdd, onRemove, onPlay, onReorder, onClose,
}: {
  items: QueueView[];
  cursor: number;
  finished: boolean;
  /** the equalizer only moves while something is actually playing */
  playing: boolean;
  shuffle: boolean;
  repeat: boolean;
  onShuffle: (on: boolean) => void;
  onRepeat: (on: boolean) => void;
  onAdd: () => void;
  onRemove: (key: string) => void;
  onPlay: (key: string) => void;
  onReorder: (key: string, to: number) => void;
  onClose: () => void;
}) {
  const box = useRef<HTMLDivElement>(null);
  const scroller = useRef<HTMLOListElement>(null);
  const [leaving, setLeaving] = useState<Set<string>>(new Set());
  const [closing, setClosing] = useState(false);
  // while dragging, the list is shown in its tentative order
  const [order, setOrder] = useState<string[] | null>(null);
  const [dragKey, setDragKey] = useState<string | null>(null);
  const drag = useRef<{ key: string; startY: number; grabY: number; moved: boolean; pointer: number } | null>(null);
  const rects = useRef(new Map<string, number>());

  const close = () => {
    setClosing(true);
    setTimeout(onClose, 180);
  };
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('.queue-btn')) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  });

  // open with the song that's playing in the middle
  useLayoutEffect(() => {
    const list = scroller.current;
    const now = list?.querySelector<HTMLElement>('li.now');
    if (!list || !now) return;
    list.scrollTop = now.offsetTop - (list.clientHeight - now.offsetHeight) / 2;
  }, []);

  const byKey = new Map(items.map((it) => [it.key, it]));
  const shown = (order ?? items.map((it) => it.key)).map((k) => byKey.get(k)!).filter(Boolean);
  const playingKey = cursor >= 0 ? items[cursor]?.key : undefined;
  const playingIndex = shown.findIndex((it) => it.key === playingKey);

  // FLIP: rows glide to their new places when the order changes
  useLayoutEffect(() => {
    const list = scroller.current;
    if (!list) return;
    list.querySelectorAll<HTMLElement>('li[data-key]').forEach((li) => {
      const k = li.dataset.key!;
      const top = li.offsetTop;
      const before = rects.current.get(k);
      if (before !== undefined && before !== top && k !== dragKey) {
        li.animate([{ transform: `translateY(${before - top}px)` }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      }
      rects.current.set(k, top);
    });
  });

  const grab = (key: string) => (e: React.PointerEvent<HTMLLIElement>) => {
    if ((e.target as HTMLElement).closest('.queue-x') || e.button !== 0) return;
    const li = e.currentTarget;
    drag.current = { key, startY: e.clientY, grabY: e.clientY - li.getBoundingClientRect().top, moved: false, pointer: e.pointerId };
  };

  useEffect(() => {
    const onMove = (e: PointerEvent) => {
      const d = drag.current;
      const list = scroller.current;
      if (!d || !list) return;
      if (!d.moved) {
        if (Math.abs(e.clientY - d.startY) < 5) return;
        d.moved = true;
        setDragKey(d.key);
        setOrder(items.map((it) => it.key));
      }
      e.preventDefault();
      // keep near the edges scrolling
      const lr = list.getBoundingClientRect();
      if (e.clientY < lr.top + 28) list.scrollTop -= 8;
      else if (e.clientY > lr.bottom - 28) list.scrollTop += 8;
      // where would it land?
      const rows = [...list.querySelectorAll<HTMLElement>('li[data-key]')].filter((li) => li.dataset.key !== d.key);
      let to = rows.length;
      for (let i = 0; i < rows.length; i++) {
        const r = rows[i].getBoundingClientRect();
        if (e.clientY < r.top + r.height / 2) {
          to = i;
          break;
        }
      }
      setOrder((cur) => {
        const base = (cur ?? items.map((it) => it.key)).filter((k) => k !== d.key);
        base.splice(to, 0, d.key);
        return cur && cur.join() === base.join() ? cur : base;
      });
      // the dragged row follows the pointer
      const li = list.querySelector<HTMLElement>(`li[data-key="${CSS.escape(d.key)}"]`);
      if (li) {
        const natural = li.getBoundingClientRect().top - (parseFloat(li.dataset.dy || '0') || 0);
        const dy = e.clientY - d.grabY - natural;
        li.dataset.dy = String(dy);
        li.style.transform = `translateY(${dy}px) scale(1.02)`;
      }
    };
    const onUp = () => {
      const d = drag.current;
      drag.current = null;
      if (!d) return;
      const list = scroller.current;
      const li = list?.querySelector<HTMLElement>(`li[data-key="${CSS.escape(d.key)}"]`);
      if (!d.moved) return;
      // swallow the click that follows a drag
      window.addEventListener('click', (ev) => ev.stopPropagation(), { capture: true, once: true });
      if (li) {
        const dy = parseFloat(li.dataset.dy || '0');
        li.style.transform = '';
        li.dataset.dy = '0';
        li.animate([{ transform: `translateY(${dy}px) scale(1.02)` }, { transform: 'none' }], { duration: 220, easing: 'cubic-bezier(0.22, 1, 0.36, 1)' });
      }
      const final = order ?? items.map((it) => it.key);
      const to = final.indexOf(d.key);
      setDragKey(null);
      setOrder(null);
      if (to >= 0 && to !== items.findIndex((it) => it.key === d.key)) onReorder(d.key, to);
    };
    window.addEventListener('pointermove', onMove, { passive: false });
    window.addEventListener('pointerup', onUp);
    window.addEventListener('pointercancel', onUp);
    return () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
      window.removeEventListener('pointercancel', onUp);
    };
  });

  const remove = (key: string) => {
    setLeaving((s) => new Set(s).add(key));
    setTimeout(() => onRemove(key), 260);
  };
  const next = items.length - cursor - 1;

  return (
    <div ref={box} className={`queue-pop${closing ? ' closing' : ''}${dragKey ? ' sorting' : ''}${playing ? '' : ' paused'}`} role="dialog" aria-label="Cola">
      <header>
        <div>
          <b>Cola</b>
          <span>{finished ? 'Terminó la lista' : next <= 0 ? 'Nada a continuación' : next === 1 ? '1 a continuación' : `${next} a continuación`}</span>
        </div>
        <div className="queue-modes">
          <div className="queue-cell" role="radiogroup" aria-label="Orden">
            <button role="radio" aria-checked={!shuffle} className={!shuffle ? 'on' : ''} onClick={() => onShuffle(false)} title="En orden">
              <OrderIcon />
            </button>
            <button role="radio" aria-checked={shuffle} className={shuffle ? 'on' : ''} onClick={() => onShuffle(true)} title="Aleatorio">
              <ShuffleIcon />
            </button>
          </div>
          <div className="queue-cell">
            <button
              aria-pressed={repeat && !shuffle}
              className={repeat && !shuffle ? 'on' : ''}
              onClick={() => onRepeat(!repeat)}
              disabled={shuffle}
              title={shuffle ? 'Repetir no aplica en aleatorio' : 'Repetir la lista'}
            >
              <RepeatIcon />
            </button>
          </div>
        </div>
      </header>
      <ol ref={scroller} className="queue-scroll">
        {shown.map((it, i) => {
          const kind: Kind = playingIndex < 0 ? 'next' : i < playingIndex ? 'past' : i === playingIndex ? 'now' : 'next';
          return (
            <Row
              key={it.key}
              it={it}
              kind={kind}
              dim={kind === 'past' && !finished && !shuffle}
              delay={i * 20}
              leaving={leaving.has(it.key)}
              dragging={dragKey === it.key}
              onPlay={kind === 'now' ? undefined : () => onPlay(it.key)}
              onRemove={kind === 'now' ? undefined : () => remove(it.key)}
              onGrab={grab(it.key)}
            />
          );
        })}
      </ol>
      <button className="queue-add" onClick={onAdd}>
        <Plus /> Añadir canción
      </button>
    </div>
  );
}

/** The side panel: 45% of the width, full height, the whole add-a-song flow inside. */
export function QueueSide({
  title, canBack, stepKey, onBack, onClose, children,
}: {
  title: string;
  canBack: boolean;
  stepKey: string;
  onBack: () => void;
  onClose: () => void;
  children: ReactNode;
}) {
  const [closing, setClosing] = useState(false);
  const close = () => {
    setClosing(true);
    setTimeout(onClose, 380);
  };
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || (e.target as HTMLElement).matches('input')) return;
      if (canBack) onBack();
      else close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });
  return (
    <aside className={`queue-side${closing ? ' closing' : ''}`} aria-label="Añadir a la cola">
      <header className="queue-side-head">
        <button className={`queue-side-back${canBack ? '' : ' hidden'}`} onClick={onBack} aria-label="Atrás" tabIndex={canBack ? 0 : -1}>
          <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"><path d="M15 5l-7 7 7 7" /></svg>
        </button>
        <b key={title}>{title}</b>
        <button className="queue-side-close" onClick={close} aria-label="Cerrar">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
        </button>
      </header>
      <div className="queue-side-body" key={stepKey}>
        {children}
      </div>
    </aside>
  );
}

/** Before the show: the songs already saved, and a way to start them. */
export function QueueChip({ items, onStart, onClear }: { items: QueueView[]; onStart: () => void; onClear: () => void }) {
  return (
    <div className="queue-chip ui" role="status">
      <span className="queue-chip-arts" aria-hidden="true">
        {items.slice(0, 3).map((it, i) =>
          it.song.art ? <img key={it.key} src={it.song.art.replace('600x600', '120x120')} alt="" style={{ zIndex: 3 - i }} /> : <i key={it.key} />,
        )}
      </span>
      <span className="queue-chip-text">
        <b>{items.length === 1 ? '1 canción en cola' : `${items.length} canciones en cola`}</b>
        <span>{items[0]?.song.title}{items.length > 1 ? ` y ${items.length - 1} más` : ''}</span>
      </span>
      <button className="btn solid" onClick={onStart}>Empezar</button>
      <button className="queue-chip-x" onClick={onClear} aria-label="Vaciar la cola" title="Vaciar la cola">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
    </div>
  );
}

/** Confirm leaving: it stops the music and clears the playlist. Same family as the queue card. */
export function ExitConfirm({ count, onConfirm, onClose }: { count: number; onConfirm: () => void; onClose: () => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [closing, setClosing] = useState(false);
  const close = () => {
    setClosing(true);
    setTimeout(onClose, 180);
  };
  useEffect(() => {
    const onDown = (e: PointerEvent) => {
      if (!box.current?.contains(e.target as Node) && !(e.target as HTMLElement).closest('.exit-btn')) close();
    };
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && close();
    window.addEventListener('pointerdown', onDown);
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('pointerdown', onDown);
      window.removeEventListener('keydown', onKey);
    };
  });
  return (
    <div ref={box} className={`queue-pop exit-pop${closing ? ' closing' : ''}`} role="alertdialog" aria-labelledby="exit-title" aria-describedby="exit-text">
      <button className="exit-x" onClick={close} aria-label="Cerrar">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round"><path d="M6 6l12 12M18 6L6 18" /></svg>
      </button>
      <b id="exit-title">¿Salir?</b>
      <p id="exit-text">
        Se detiene la música y se elimina la playlist actual
        {count > 1 ? ` (${count} canciones)` : ''}. Para volver tendrás que buscar las canciones otra vez.
      </p>
      <button className="exit-go" onClick={onConfirm}>
        Salir de todos modos
      </button>
    </div>
  );
}
