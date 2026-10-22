/**
 * The playlist is one ordered list and a cursor on the song that's playing.
 * Above the cursor: what already played. Below: what's next. Dragging a song above the
 * cursor makes it "played"; dragging the playing song moves the cursor with it.
 * cursor = -1 means nothing has started yet (everything is upcoming).
 */
export interface Playlist<T extends { key: string }> {
  items: T[];
  cursor: number;
  /** the last song ended and nothing followed: nothing is shown as "played" any more */
  finished: boolean;
}

export interface PlayMode {
  shuffle: boolean;
  repeat: boolean;
}

export const empty = <T extends { key: string }>(): Playlist<T> => ({ items: [], cursor: -1, finished: false });

export const upcoming = <T extends { key: string }>(p: Playlist<T>) => p.items.slice(p.cursor + 1);
export const current = <T extends { key: string }>(p: Playlist<T>) => (p.cursor >= 0 ? p.items[p.cursor] ?? null : null);

export function append<T extends { key: string }>(p: Playlist<T>, item: T): Playlist<T> {
  return { ...p, items: [...p.items, item], finished: false };
}

export function remove<T extends { key: string }>(p: Playlist<T>, key: string): Playlist<T> {
  const i = p.items.findIndex((x) => x.key === key);
  if (i < 0 || i === p.cursor) return p;
  const items = p.items.filter((x) => x.key !== key);
  return { ...p, items, cursor: i < p.cursor ? p.cursor - 1 : p.cursor };
}

/** Move a song to a new position; the cursor follows the song that is playing. */
export function move<T extends { key: string }>(p: Playlist<T>, key: string, to: number): Playlist<T> {
  const from = p.items.findIndex((x) => x.key === key);
  if (from < 0) return p;
  const playingKey = p.cursor >= 0 ? p.items[p.cursor]?.key : undefined;
  const items = [...p.items];
  const [it] = items.splice(from, 1);
  items.splice(Math.max(0, Math.min(items.length, to)), 0, it);
  const cursor = playingKey ? items.findIndex((x) => x.key === playingKey) : -1;
  return { ...p, items, cursor };
}

export const canPrev = <T extends { key: string }>(p: Playlist<T>) => p.cursor > 0;

export const canNext = <T extends { key: string }>(p: Playlist<T>, m: PlayMode) =>
  upcoming(p).length > 0 || (m.shuffle && p.items.length > 1) || (m.repeat && !m.shuffle && p.items.length > 1);

/**
 * What plays after the current song. Shuffle picks a random upcoming song and moves it right
 * after the cursor, so the list always shows the real play order. Repeat wraps to the top.
 * Returns null when the playlist is over.
 */
export function advance<T extends { key: string }>(p: Playlist<T>, m: PlayMode, rand = Math.random): { pl: Playlist<T>; index: number } | null {
  const next = p.cursor + 1;
  // shuffle never runs out: at the bottom it picks any other song and moves it after the cursor
  if (m.shuffle && next >= p.items.length && p.items.length > 1) {
    const others = p.items.map((_, i) => i).filter((i) => i !== p.cursor);
    const j = others[Math.floor(rand() * others.length)];
    const items = [...p.items];
    const [it] = items.splice(j, 1);
    const cursor = j < p.cursor ? p.cursor - 1 : p.cursor;
    items.splice(cursor + 1, 0, it);
    return { pl: { items, cursor: cursor + 1, finished: false }, index: cursor + 1 };
  }
  if (next < p.items.length) {
    if (m.shuffle && p.items.length - next > 1) {
      const j = next + Math.floor(rand() * (p.items.length - next));
      const items = [...p.items];
      const [it] = items.splice(j, 1);
      items.splice(next, 0, it);
      return { pl: { items, cursor: next, finished: false }, index: next };
    }
    return { pl: { ...p, cursor: next, finished: false }, index: next };
  }
  if (m.repeat && !m.shuffle && p.items.length > 0) return { pl: { ...p, cursor: 0, finished: false }, index: 0 };
  return null;
}

export function back<T extends { key: string }>(p: Playlist<T>): { pl: Playlist<T>; index: number } | null {
  if (p.cursor <= 0) return null;
  return { pl: { ...p, cursor: p.cursor - 1, finished: false }, index: p.cursor - 1 };
}
