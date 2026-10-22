import { useCallback, useEffect, useRef, useState } from 'react';

export function usePersistent<T>(key: string, initial: T) {
  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      return raw ? { ...initial, ...JSON.parse(raw) } : initial;
    } catch {
      return initial;
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(value));
    } catch {
      /* storage can be unavailable; settings just won't persist */
    }
  }, [key, value]);
  return [value, setValue] as const;
}

/** True after `ms` without pointer or key activity, only while `active`. */
export function useIdle(active: boolean, ms = 2800) {
  const [idle, setIdle] = useState(false);
  const timer = useRef<number>();
  const wake = useCallback(() => {
    setIdle(false);
    window.clearTimeout(timer.current);
    if (active) timer.current = window.setTimeout(() => setIdle(true), ms);
  }, [active, ms]);
  useEffect(() => {
    wake();
    window.addEventListener('pointermove', wake);
    window.addEventListener('keydown', wake);
    return () => {
      window.clearTimeout(timer.current);
      window.removeEventListener('pointermove', wake);
      window.removeEventListener('keydown', wake);
    };
  }, [wake]);
  return [idle, setIdle] as const;
}

export function useToast() {
  const [msg, setMsg] = useState<{ text: string; id: number } | null>(null);
  const timer = useRef<number>();
  const show = useCallback((text: string) => {
    setMsg({ text, id: Date.now() });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setMsg(null), 2600);
  }, []);
  return [msg, show] as const;
}
