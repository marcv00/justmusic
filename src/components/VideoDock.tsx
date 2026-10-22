import { useCallback, useEffect } from 'react';
import { playback } from '../engine/playback';

/** The video panel: a muted YouTube mirror kept in step with the audio (or the sound itself as a fallback). */
export function VideoDock({ visible }: { visible: boolean }) {
  const host = useCallback((el: HTMLDivElement | null) => playback.setVideoHost(el), []);
  useEffect(() => playback.setMirror(visible), [visible]);
  return (
    <div className={`video${visible ? '' : ' tucked'}`} aria-hidden={!visible}>
      <div ref={host} className="video-mount" />
    </div>
  );
}
