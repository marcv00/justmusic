import { createContext, useContext, useLayoutEffect, useRef, useState } from 'react';

/** Drift speed for long titles, in px/s (set from Ajustes). */
export const MarqueeSpeed = createContext(16);

/**
 * Text that fits stays still. Text that doesn't drifts to its end, rests, and drifts back,
 * like a now-playing title on a phone. Speed is constant whatever the length.
 */
export function Marquee({ text, className, as: Tag = 'span' }: { text: string; className?: string; as?: 'span' | 'b' }) {
  const box = useRef<HTMLSpanElement>(null);
  const inner = useRef<HTMLSpanElement>(null);
  const [dist, setDist] = useState(0);
  const speed = useContext(MarqueeSpeed);

  useLayoutEffect(() => {
    const b = box.current, i = inner.current;
    if (!b || !i) return;
    const measure = () => setDist(Math.max(0, Math.ceil(i.scrollWidth - b.clientWidth)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(b);
    ro.observe(i);
    void document.fonts?.ready.then(measure);
    return () => ro.disconnect();
  }, [text]);

  const moving = dist > 2;
  // each one-way drift is 27% of the cycle and each rest 18% (see @keyframes marquee),
  // so a slower speed stretches the drift and the pauses together
  const travel = dist / speed;
  const total = Math.max(96 / speed, travel / 0.27);
  return (
    <Tag className={`marquee${moving ? ' moving' : ''}${className ? ` ${className}` : ''}`} title={moving ? text : undefined}>
      <span className="marquee-box" ref={box}>
        <span
          className="marquee-inner"
          ref={inner}
          key={text}
          style={
            moving
              ? ({
                  ['--dist' as string]: `-${dist}px`,
                  ['--dur' as string]: `${total.toFixed(2)}s`,
                  ['--wait' as string]: `${(total * 0.18).toFixed(2)}s`,
                } as React.CSSProperties)
              : undefined
          }
        >
          {text}
        </span>
      </span>
    </Tag>
  );
}
