# JustMusic

Karaoke y lipsync para la sala. Una sola búsqueda; la pared de luz lee cada canción en tu equipo
y se enciende con su ritmo.

## Instalar

1. **Node 18+**
2. **yt-dlp**, para que la pared pueda analizar cada canción:
   - macOS: `brew install yt-dlp`
   - Windows: `winget install yt-dlp`
   - Linux / cualquiera con Python: `pip install -U yt-dlp`

   Mantenlo al día (`yt-dlp -U` o el mismo comando de instalación); YouTube cambia seguido.

```bash
npm install
npm run dev          # abre http://localhost:5173
```

Para usarla en la tele o el proyector, `npm run dev` también la publica en tu red local
(mira la dirección "Network" en la terminal). `npm start` compila y sirve la versión optimizada.

> JustMusic necesita su servidor local (viene dentro de Vite), así que no funciona subiendo `dist/`
> a un hosting estático.

## App de escritorio (para compartir)

JustMusic se puede empaquetar como una app que se pasa en un zip: quien la recibe descomprime y la abre,
sin instalar Node, npm ni yt-dlp. Adentro van la interfaz, el servidor local, yt-dlp y QuickJS (el
motor de JavaScript que yt-dlp necesita para YouTube). yt-dlp se actualiza solo una vez al día.

Para construirla (una vez, en tu computadora):

```bash
npm install
npm run package:win        # release/JustMusic-windows.zip
npm run package:mac        # release/JustMusic-mac.zip (Apple Silicon)
npm run package:mac-intel  # release/JustMusic-mac-intel.zip (Mac con Intel)
```

El zip de Windows se puede construir desde cualquier sistema. Los de Mac, constrúyelos en una Mac.
Para probar la app sin empaquetar: `npm run app`.

**Primera vez que se abre.** La app no está firmada con un certificado de desarrollador (cuesta
dinero), así que el sistema avisa una sola vez:
- Windows: "Windows protegió tu PC" → **Más información** → **Ejecutar de todas formas**.
- Mac: si dice que está dañada o no se puede verificar, en Terminal: `xattr -cr /Applications/JustMusic.app`,
  y ábrela de nuevo.

Cada zip trae un `LEEME.txt` con estas instrucciones.

## Cómo funciona

**Eliges tú las versiones.** Tras elegir la canción aparece un selector con dos columnas: la
versión para lipsync (con voz) y la versión karaoke (sin voz), ambas de YouTube, más la fuente de la
letra. JustMusic sugiere una de cada lado y marca las oficiales y las que duran lo mismo que la letra;
mientras eliges, ya va bajando lo seleccionado, así que Empezar es casi instantáneo.

**Letras de dos fuentes.** LRCLIB, buscando varias escrituras del título, y los subtítulos del propio
video de YouTube (muchos videos oficiales traen la letra como subtítulos, sincronizada con ese video).
Si hay letra sin tiempos, JustMusic la cronometra con la voz. También puedes buscar otra letra a mano.

**Duraciones distintas, resuelto.** Comparando la versión con voz y la karaoke, JustMusic obtiene dónde
se canta. Con eso alinea la letra de catálogo con la grabación elegida (por ejemplo, si el video
oficial tiene una intro de 20 s) y cronometra letras sin tiempos. La karaoke se alinea con la original
por su ritmo, así que la letra cuadra en los dos modos.

**Matcher de sincronía.** Después de elegir, JustMusic baja las dos versiones, las alinea y alinea la
letra con la voz. Si todo coincide, empieza solo. Si no, abre el matcher: tres filas (letra, lipsync
como referencia, karaoke) con la onda completa de cada grabación y sus compases. La franja de la
letra baja por las tres filas y marca en qué segundo de cada grabación cae. Arrastra la letra o la
karaoke (se pegan a la posición automática), escucha cualquiera desde el cursor (1 y 2), y acerca
con Ctrl + rueda o los botones. Durante la canción, la tecla S o el botón Sincronía lo vuelven a abrir.

**Cola de canciones.** En la pantalla de sincronía, el botón + guarda la canción con su sincronía y
te lleva a buscar la siguiente; "Empezar la cola" reproduce desde la primera. Mientras suena, el botón
de cola (o la tecla Q) muestra lo que viene; desde ahí se quita, se adelanta o se agrega una canción en
un panel lateral con todo el flujo (buscar, versiones, sincronía) sin parar la música. Al terminar una
canción empieza la siguiente sola; la app deja lista la próxima mientras suena la actual.

**Salir.** El botón Salir pide confirmación: detiene la música y elimina la playlist actual.

**Lista de reproducción.** La cola es una sola lista ordenada: arriba lo que ya sonó, al centro lo que
suena, abajo lo que viene. Todas las filas se arrastran para reordenar, incluida la que suena. Arriba a
la derecha: en orden o aleatorio, y repetir la lista (no aplica en aleatorio). En aleatorio nada se atenúa y, al llegar al final, sigue con otra canción al
azar. Los ajustes de "Letra antes/después" y de Sincronía se guardan en cada canción. Con más de una canción
aparecen anterior y siguiente en la tarjeta, deshabilitados cuando no hay hacia dónde ir.

**Historial y modo rápido.** La lista de la cola muestra también lo que ya sonó (atenuado, arriba) y
abre centrada en la canción actual; tocar una ya cantada la vuelve a poner. En el panel lateral, el modo
rápido agrega una canción con un toque: mejor versión con voz, mejor letra y sincronía automática, sin
versión karaoke. En la pantalla de versiones, tocar la portada permite elegir otra entre las miniaturas.

**Búsqueda única.** Escribes artista y canción y buscas en el catálogo de iTunes (nombres limpios
y portadas cuadradas). Al elegir, el servidor local encuentra en YouTube, sin API key, la versión
original y la versión karaoke, y LRCLIB da la letra sincronizada (`/api/get` con artista, canción,
álbum y duración; `/api/search` solo como respaldo). También puedes pegar un link de YouTube en la
misma caja.

**JustMusic reproduce el audio él mismo.** Con yt-dlp, cada pista se baja una vez y suena por Web Audio.
El reloj es el del hardware de audio (`getOutputTimestamp`): luces y letra siguen exactamente lo que
sale por el parlante. YouTube solo muestra el video, en silencio y sincronizado (tecla V).
Sin yt-dlp, el sonido vuelve a venir de YouTube y la pared escucha con el micrófono.

**Cambio de modo sin cortes.** Las dos versiones quedan cargadas en memoria; karaoke ↔ lipsync es un
crossfade de igual potencia de medio segundo, al mismo punto de la canción. Las versiones se alinean
comparando su ritmo y su forma de energía, así que la letra sigue en tiempo aunque la karaoke tenga
otra intro. Si la pista elegida no es la correcta, toca la etiqueta Karaoke/Original de la tarjeta
para elegir otra.

**Análisis en el equipo.** `yt-dlp` baja el audio a una caché temporal, el navegador lo decodifica
y un Web Worker calcula: tempo, grilla de beats y compases, golpes de graves, medios y agudos por
separado, y las secciones de la canción con sus subidas de energía. Toma uno o dos segundos.

**La pared.** El análisis calcula un "bombeo" del bajo medido contra el rango reciente de la canción:
en cada golpe la pared pasa de penumbra a luz plena y vuelve, tanto en una estrofa suave como en el
coro. Además, las luces se disparan sobre la música, no sobre el micrófono:
- los graves y los kicks levantan toda la pared y lanzan ondas;
- cada beat avanza una persecución por zonas (columnas, filas, anillos, diagonales, tramas, mitades),
  que cambia de patrón por compás según la energía;
- los agudos encienden destellos sueltos;
- antes de un drop la pared se oscurece y tensa, y en el drop explota y cambia de escena.

Cada sección trae su escena de color: la primera sale de la portada de la canción, las demás
recorren la paleta completa según la energía. La misma canción siempre se ilumina igual.

Sin `yt-dlp`, o si un video no se puede bajar, la pared respira sola o sigue la sala con el
micrófono (tecla M).

## Estructura

```
server/justMusicApi.ts     API local: catálogo, YouTube, LRCLIB, audio con yt-dlp, proxy de imágenes
src/engine/
  analysis.worker.ts   FFT, bandas, onsets, tempo, beats (programación dinámica), secciones, alineación
  conductor.ts         director de luces: convierte análisis + tiempo en estado de luz por cuadro
  palettes.ts          escenas de color y paleta extraída de la portada
  playback.ts          motor Web Audio con reloj del hardware y crossfades; YouTube como espejo de video
  spectrum.ts          espectro en vivo para la onda
  WallScene.ts         escena Three.js: pared, neblina, polvo, bloom, etalonaje
  shaders.ts           GLSL de la celosía, zonas, destellos y el grade final
src/components/        Search, NowPlaying, Lyrics, Controls, Settings, VideoDock, Backdrop
```

**Coreografía.** La base de la pared son zonas de luz que se encienden y apagan despacio, una
desvaneciéndose mientras nace la siguiente (duración ajustable en Ajustes, 6,5 s por defecto). Encima,
figuras que nacen en el centro y crecen hasta salir de cuadro, pero solo cuando la música lo pide: un
bajo contundente (un golpe grave que sale de un momento más quieto) dispara un círculo; un pico nítido
(caja, palmas, platillo) dispara un cuadrado. Entre figura y figura hay un descanso mínimo, así que
nunca salen en ráfaga. El ánimo de cada sección se mide en golpes nítidos por segundo, una medida
absoluta: una balada sigue tranquila en su parte más fuerte, y los efectos de baile (barrido, columnas,
damero, radar, a la mitad de velocidad) quedan para canciones con pulso de verdad.

**Forma de la pared** (Ajustes): celosía, círculos (anillo con un punto central) o hexágonos.

**Ajustes visuales.** Pared u Onda (el espectro en vivo de lo que suena, o del micrófono);
Cristal, un vidrio esmerilado delante de la luz con su difusión ajustable; y Sincronía de las luces,
para parlantes Bluetooth, que suenan 150 a 250 ms después.

## Para proyectar

Activa **Modo proyector** en ajustes: negros más profundos, color más denso, sin grano.
Pantalla completa con F, y H deja solo la pared.
