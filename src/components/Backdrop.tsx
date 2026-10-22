import { useEffect, useRef, useState } from 'react';
import { WallScene } from '../engine/WallScene';

interface Props {
  intensity: number;
  projector: boolean;
  visual: 'wall' | 'wave';
  glass: number;
  shape: 'lattice' | 'rings' | 'hex';
  zone: number;
  /** the cover's colour while a song plays */
  artColor?: string | null;
  performing: boolean;
}

export function Backdrop({ intensity, projector, visual, glass, shape, zone, artColor = null, performing }: Props) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const scene = useRef<WallScene | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let s: WallScene;
    try {
      s = new WallScene(canvas.current!);
    } catch {
      setFailed(true);
      return;
    }
    const root = document.documentElement;
    s.onFrame = (k) => root.style.setProperty('--pulse', k.toFixed(3));
    scene.current = s;
    return () => {
      s.dispose();
      scene.current = null;
    };
  }, []);

  useEffect(() => scene.current?.setLook({ intensity, projector, visual, glass, shape, zone }), [intensity, projector, visual, glass, shape, zone]);
  useEffect(() => scene.current?.setStage(performing), [performing]);
  useEffect(() => scene.current?.setArtColor(artColor), [artColor]);

  return (
    <>
      <canvas ref={canvas} className="backdrop" aria-hidden="true" />
      {failed && <div className="backdrop-fallback" aria-hidden="true" />}
    </>
  );
}
