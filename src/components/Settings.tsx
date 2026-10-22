import { useEffect, useRef } from 'react';
import type { Settings as S } from '../model';
import { Marquee, MarqueeSpeed } from './Marquee';

interface Props {
  open: boolean;
  micOn: boolean;
  onMic: () => void;
  settings: S;
  onChange: (s: S) => void;
  onClose: () => void;
}

const keys: [string, string][] = [
  ['Espacio', 'Reproducir o pausar'],
  ['K', 'Cambiar entre karaoke y lipsync'],
  ['S', 'Abrir el ajuste de sincronía'],
  ['Q', 'Ver la cola'],
  ['[  ]', 'Mover la letra antes o después'],
  ['←  →', 'Saltar 5 segundos'],
  ['M', 'Micrófono: la pared sigue el ritmo de la sala'],
  ['T', 'Marcar el ritmo a mano; Shift + T lo apaga'],
  ['V', 'Mostrar u ocultar el video'],
  ['L', 'Mostrar u ocultar la letra'],
  ['H', 'Dejar solo la pared'],
  ['F', 'Pantalla completa'],
  ['Esc', 'Volver a buscar'],
];

export function Settings({ open, micOn, onMic, settings, onChange, onClose }: Props) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const d = ref.current;
    if (!d) return;
    if (open && !d.open) d.showModal();
    if (!open && d.open) d.close();
  }, [open]);

  return (
    <dialog ref={ref} className="settings" onClose={onClose} onClick={(e) => e.target === ref.current && onClose()}>
      <div className="settings-body">
        <h2>Ajustes</h2>

        <div className="field first">
          <b>Visual</b>
          <div className="seg" role="group" aria-label="Visual">
            <button aria-pressed={settings.visual === 'wall'} onClick={() => onChange({ ...settings, visual: 'wall' })}>
              Pared
            </button>
            <button aria-pressed={settings.visual === 'wave'} onClick={() => onChange({ ...settings, visual: 'wave' })}>
              Onda
            </button>
          </div>
          <small>La onda dibuja el espectro de lo que suena; sin canción, el del micrófono.</small>
        </div>

        <div className={`field spaced reveal-shape${settings.visual === 'wall' ? '' : ' off'}`}>
          <b>Forma de la pared</b>
          <div className="shapes" role="radiogroup" aria-label="Forma de la pared">
            {(
              [
                ['lattice', 'Celosía', <path key="l" d="M12 4.5c2.2 2.2 2.2 12.8 0 15M12 4.5c-2.2 2.2-2.2 12.8 0 15M4.5 12c2.2-2.2 12.8-2.2 15 0M4.5 12c2.2 2.2 12.8 2.2 15 0" />],
                ['rings', 'Círculos', <g key="r"><circle cx="12" cy="12" r="6.5" /><circle cx="12" cy="12" r="1.8" fill="currentColor" /></g>],
                ['hex', 'Hexágonos', <path key="h" d="M12 4l6.9 4v8L12 20l-6.9-4V8z" />],
              ] as const
            ).map(([id, name, icon]) => (
              <button
                key={id}
                role="radio"
                aria-checked={settings.wallShape === id}
                className={settings.wallShape === id ? 'on' : ''}
                onClick={() => onChange({ ...settings, wallShape: id })}
              >
                <svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" aria-hidden="true">
                  {icon}
                </svg>
                <span>{name}</span>
              </button>
            ))}
          </div>
        </div>

        <label className={`field spaced${settings.visual === 'wall' ? '' : ' reveal-shape off'}`}>
          <b>Cambio de zonas</b>
          <input
            type="range"
            min={3}
            max={14}
            step={0.5}
            value={settings.zoneSeconds}
            onChange={(e) => onChange({ ...settings, zoneSeconds: Number(e.target.value) })}
          />
          <span className="range-ends">
            <small>Ágil</small>
            <small>{settings.zoneSeconds.toFixed(1)} s</small>
            <small>Pausado</small>
          </span>
          <small>Cuánto tarda cada zona de luz en encenderse y apagarse. Es la base de la pared en canciones tranquilas.</small>
        </label>

        <label className="toggle spaced">
          <span>
            <b>Cristal</b>
            <small>Pone un vidrio esmerilado delante de la luz.</small>
          </span>
          <input type="checkbox" role="switch" checked={settings.glass} onChange={(e) => onChange({ ...settings, glass: e.target.checked })} />
        </label>
        <div className={`reveal${settings.glass ? ' open' : ''}`}>
          <label className="field tight">
            <span className="range-label">
              <b>Difusión</b>
            </span>
            <input
              type="range"
              min={0.15}
              max={1}
              step={0.01}
              value={settings.glassAmount}
              onChange={(e) => onChange({ ...settings, glassAmount: Number(e.target.value) })}
              tabIndex={settings.glass ? 0 : -1}
            />
          </label>
        </div>

        <label className="toggle spaced">
          <span>
            <b>Modo proyector</b>
            <small>Negros más profundos, color más denso y sin grano. Para pantallas grandes o una pared.</small>
          </span>
          <input
            type="checkbox"
            role="switch"
            checked={settings.projector}
            onChange={(e) => onChange({ ...settings, projector: e.target.checked })}
          />
        </label>

        <label className="field spaced">
          <b>Reacción de la pared</b>
          <input
            type="range"
            min={0.3}
            max={1.6}
            step={0.05}
            value={settings.intensity}
            onChange={(e) => onChange({ ...settings, intensity: Number(e.target.value) })}
          />
          <span className="range-ends">
            <small>Serena</small>
            <small>Intensa</small>
          </span>
        </label>

        <label className="field spaced">
          <b>Velocidad de los títulos largos</b>
          <input
            type="range"
            min={6}
            max={64}
            step={1}
            value={settings.marqueeSpeed}
            onChange={(e) => onChange({ ...settings, marqueeSpeed: Number(e.target.value) })}
          />
          <span className="range-ends">
            <small>Lenta</small>
            <small>Rápida</small>
          </span>
          <MarqueeSpeed.Provider value={settings.marqueeSpeed}>
            <div className="marquee-preview" aria-hidden="true">
              <Marquee key={settings.marqueeSpeed} text="02. epitafio ft. facebrooklyn & juicy bae · AKRIILA" />
            </div>
          </MarqueeSpeed.Provider>
        </label>

        <label className="field spaced">
          <b>Sincronía de las luces</b>
          <input
            type="range"
            min={0}
            max={350}
            step={5}
            value={settings.lightDelay}
            onChange={(e) => onChange({ ...settings, lightDelay: Number(e.target.value) })}
          />
          <span className="range-ends">
            <small>Parlante con cable</small>
            <small>{settings.lightDelay} ms</small>
            <small>Bluetooth</small>
          </span>
          <small>Si las luces se adelantan al golpe que escuchas, mueve hacia la derecha.</small>
        </label>

        <label className="toggle spaced">
          <span>
            <b>Escuchar con el micrófono</b>
            <small>Para canciones que no se pudieron analizar: la pared sigue el ritmo de la sala.</small>
          </span>
          <input type="checkbox" role="switch" checked={micOn} onChange={onMic} />
        </label>

        <dl className="keys">
          {keys.map(([k, v]) => (
            <div key={k}>
              <dt>
                <kbd>{k}</kbd>
              </dt>
              <dd>{v}</dd>
            </div>
          ))}
        </dl>

        <div className="settings-actions">
          <button className="btn solid" onClick={onClose}>
            Listo
          </button>
        </div>
      </div>
    </dialog>
  );
}
