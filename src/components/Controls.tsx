import { QueueIcon } from './Queue';

interface Props {
  queueActive: boolean;
  exitOpen: boolean;
  queueOpen: boolean;
  onQueue: () => void;
  offset: number;
  showLyrics: boolean;
  showVideo: boolean;
  onNudge: (d: number) => void;
  onLyrics: () => void;
  onVideo: () => void;
  onSync: () => void;
  onExit: () => void;
}

export function Controls(p: Props) {
  return (
    <div className="controls ui">
      <div className="offset" role="group" aria-label="Sincronía de la letra">
        <button onClick={() => p.onNudge(-0.2)} title="Tecla [">Letra antes</button>
        <output>{`${p.offset > 0 ? '+' : ''}${p.offset.toFixed(1)} s`}</output>
        <button onClick={() => p.onNudge(0.2)} title="Tecla ]">Letra después</button>
      </div>
      <span className="sep" />
      <button aria-pressed={p.showLyrics} onClick={p.onLyrics} title="Tecla L">Letra</button>
      <button aria-pressed={p.showVideo} onClick={p.onVideo} title="Tecla V">Video</button>
      <button onClick={p.onSync} title="Tecla S">Sincronía</button>
      <span className="sep" />
      <button
        className={`queue-btn${p.queueOpen ? ' open' : ''}${p.queueActive ? ' on' : ''}`}
        onClick={p.onQueue}
        aria-label="Cola"
        aria-expanded={p.queueOpen}
        title="Cola (Q)"
      >
        <QueueIcon />
      </button>
      <span className="sep" />
      <button className={`exit-btn${p.exitOpen ? ' open' : ''}`} onClick={p.onExit} title="Esc" aria-expanded={p.exitOpen}>
        Salir
      </button>
    </div>
  );
}
