import { Fragment, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import type { LyricLine } from '../services/lyrics';
import { playback } from '../engine/playback';
import { audio } from '../engine/audio';

interface Props {
  lines: LyricLine[];
  offset: number;
  /** stage: big and centred (karaoke) · panel: beside the cover (lipsync) */
  variant: 'stage' | 'panel';
  open?: boolean;
}

interface Word {
  text: string;
  a: number;
  b: number;
}
interface Row {
  t: number;
  text: string;
  words: Word[];
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/** Split a line into words with their share of the line, weighted by length, so the wipe follows the voice. */
function toWords(text: string): Word[] {
  const parts = text.split(/\s+/).filter(Boolean);
  const total = parts.reduce((s, w) => s + w.length + 1, 0);
  let acc = 0;
  return parts.map((w) => {
    const a = acc / total;
    acc += w.length + 1;
    return { text: w, a, b: acc / total };
  });
}

export function Lyrics({ lines, offset, variant, open = true }: Props) {
  const rows = useMemo<Row[]>(() => {
    const src = lines.length && lines[0].t > 0.8 ? [{ t: 0, text: '' }, ...lines] : lines;
    return src.map((l) => ({ ...l, words: toWords(l.text) }));
  }, [lines]);

  const [idx, setIdx] = useState(-1);
  const [vh, setVh] = useState(window.innerHeight);
  const track = useRef<HTMLDivElement>(null);
  const idxRef = useRef(-1);
  const offsetRef = useRef(offset);
  offsetRef.current = offset;

  useEffect(() => {
    const r = () => setVh(window.innerHeight + window.innerWidth);
    window.addEventListener('resize', r);
    return () => window.removeEventListener('resize', r);
  }, []);

  useEffect(() => {
    idxRef.current = -1;
    setIdx(-1);
    let raf = 0;
    const loop = (now: number) => {
      raf = requestAnimationFrame(loop);
      const el = track.current;
      if (!rows.length || !el) return;
      const t = playback.songTime(now) - offsetRef.current;

      let i = idxRef.current;
      while (i + 1 < rows.length && rows[i + 1].t <= t) i++;
      while (i >= 0 && rows[i].t > t) i--;

      if (i !== idxRef.current) {
        idxRef.current = i;
        setIdx(i);
        if (i >= 0 && rows[i].text) audio.pulse(0.45);
        // sung lines stay lit, upcoming ones go back to dark (matters after a seek)
        el.querySelectorAll<HTMLElement>('.line').forEach((ln, j) => {
          if (j === i) return;
          const v = j < i ? '1' : '0';
          ln.style.setProperty('--p', v);
          ln.querySelectorAll<HTMLElement>('.w').forEach((w) => w.style.setProperty('--w', v));
        });
      }

      if (i < 0) return;
      const row = rows[i];
      const nextT = rows[i + 1]?.t ?? row.t + 5;
      const span = nextT - row.t;
      const dur = row.text ? Math.min(span - 0.12, Math.max(1.1, row.text.length * 0.085)) : span;
      const p = clamp01((t - row.t) / Math.max(0.2, dur));
      const lineEl = el.children[i] as HTMLElement | undefined;
      if (!lineEl) return;
      lineEl.style.setProperty('--p', p.toFixed(4));
      const ws = lineEl.querySelectorAll<HTMLElement>('.w');
      row.words.forEach((w, k) => {
        ws[k]?.style.setProperty('--w', clamp01((p - w.a) / (w.b - w.a)).toFixed(4));
      });
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [rows]);

  // glide the track so the current line sits on the anchor
  useLayoutEffect(() => {
    const el = track.current;
    if (!el) return;
    const line = el.children[Math.max(idx, 0)] as HTMLElement | undefined;
    if (!line) return;
    const y = line.offsetTop + line.offsetHeight / 2;
    el.style.transform = `translate3d(0, ${-y}px, 0)`;
  }, [idx, rows, variant, vh, open]);

  if (!rows.length) return null;

  return (
    <section className={`lyrics lyrics-${variant}${open ? ' open' : ''}`} aria-live="polite" aria-hidden={!open}>
      <div className="lyrics-track" ref={track}>
        {rows.map((r, i) => {
          const d = Math.max(-3, Math.min(4, i - idx));
          return (
            <div key={i} className={`line${i === idx ? ' cur' : ''}`} data-d={d}>
              {r.text ? (
                r.words.map((w, k) => (
                  <Fragment key={k}>
                    <span className="w">{w.text}</span>{' '}
                  </Fragment>
                ))
              ) : (
                <span className="breath" aria-label="instrumental">
                  <i />
                  <i />
                  <i />
                </span>
              )}
            </div>
          );
        })}
      </div>
    </section>
  );
}
