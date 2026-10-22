// Build JustMusic as a desktop app you can hand to someone as a zip.
//   npm run package:win        → release/JustMusic-windows.zip   (JustMusic.exe inside)
//   npm run package:mac        → release/JustMusic-mac.zip       (Apple Silicon)
//   npm run package:mac-intel  → release/JustMusic-mac-intel.zip
// Mac zips are best built on a Mac (or Linux); Windows zips build anywhere.
import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { build } from 'esbuild';
import { packager } from '@electron/packager';

const TARGETS = {
  win: { platform: 'win32', arch: 'x64', label: 'windows' },
  mac: { platform: 'darwin', arch: 'arm64', label: 'mac' },
  'mac-intel': { platform: 'darwin', arch: 'x64', label: 'mac-intel' },
  linux: { platform: 'linux', arch: 'x64', label: 'linux' },
  dev: { platform: process.platform, arch: process.arch, label: 'dev' },
};
const which = process.argv[2] ?? 'dev';
const t = TARGETS[which];
if (!t) throw new Error(`target: ${Object.keys(TARGETS).join(' | ')}`);

const root = path.resolve(import.meta.dirname, '..');
const out = (...p) => path.join(root, 'build', ...p);
const run = (cmd) => execSync(cmd, { cwd: root, stdio: 'inherit' });

const BINS = {
  'win32-x64': { 'yt-dlp.exe': 'yt-dlp/yt-dlp/releases/latest/download/yt-dlp.exe', 'qjs.exe': 'quickjs-ng/quickjs/releases/latest/download/qjs-windows-x86_64.exe' },
  'darwin-arm64': { 'yt-dlp': 'yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos', qjs: 'quickjs-ng/quickjs/releases/latest/download/qjs-darwin-arm64' },
  'darwin-x64': { 'yt-dlp': 'yt-dlp/yt-dlp/releases/latest/download/yt-dlp_macos', qjs: 'quickjs-ng/quickjs/releases/latest/download/qjs-darwin-x86_64' },
  'linux-x64': { 'yt-dlp': 'yt-dlp/yt-dlp/releases/latest/download/yt-dlp_linux', qjs: 'quickjs-ng/quickjs/releases/latest/download/qjs-linux-x86_64' },
};

async function fetchBins(key) {
  const dir = out('bin', key);
  fs.mkdirSync(dir, { recursive: true });
  for (const [name, src] of Object.entries(BINS[key] ?? {})) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) continue;
    process.stdout.write(`  downloading ${name}… `);
    const r = await fetch(`https://github.com/${src}`);
    if (!r.ok) throw new Error(`${src}: ${r.status}`);
    fs.writeFileSync(file, Buffer.from(await r.arrayBuffer()));
    fs.chmodSync(file, 0o755);
    console.log(`${(fs.statSync(file).size / 1e6).toFixed(1)} MB`);
  }
  return dir;
}

console.log('1/4  building the interface');
run('npx vite build');

console.log('2/4  building the app shell');
const app = out('app');
fs.rmSync(app, { recursive: true, force: true });
fs.mkdirSync(app, { recursive: true });
await build({
  entryPoints: [path.join(root, 'electron/main.ts')],
  bundle: true,
  platform: 'node',
  format: 'cjs',
  target: 'node20',
  outfile: path.join(app, 'main.cjs'),
  external: ['electron'],
});
fs.cpSync(path.join(root, 'dist'), path.join(app, 'dist'), { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
fs.writeFileSync(path.join(app, 'package.json'), JSON.stringify({ name: 'justmusic', productName: 'JustMusic', version: pkg.version, main: 'main.cjs' }, null, 2));

console.log('3/4  bundling yt-dlp and QuickJS');
const key = `${t.platform}-${t.arch}`;
const bins = await fetchBins(key);

if (which === 'dev') {
  // run straight from build/app; the shell finds the tools in build/bin
  console.log(`ready (${bins}): npx electron build/app`);
  process.exit(0);
}

console.log('4/4  packaging');
const stage = out('stage', key, 'bin');
fs.rmSync(path.dirname(stage), { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
fs.cpSync(bins, stage, { recursive: true });
const [appPath] = await packager({
  dir: app,
  out: out('pkg'),
  name: 'JustMusic',
  platform: t.platform,
  arch: t.arch,
  overwrite: true,
  asar: true,
  extraResource: [stage],
  appBundleId: 'app.justmusic',
  appCategoryType: 'public.app-category.music',
  extendInfo: { NSMicrophoneUsageDescription: 'JustMusic escucha la sala para que la pared siga el ritmo.' },
  win32metadata: undefined,
});

// Windows/Linux: drop Chromium's other UI languages (~40 MB). Never touch a macOS bundle: its signature would break.
if (t.platform !== 'darwin') {
  const loc = path.join(appPath, 'locales');
  for (const f of fs.existsSync(loc) ? fs.readdirSync(loc) : []) {
    if (!/^(en-US|es|es-419)\.pak$/.test(f)) fs.rmSync(path.join(loc, f));
  }
}

const release = path.join(root, 'release');
fs.mkdirSync(release, { recursive: true });
const zip = path.join(release, `JustMusic-${t.label}.zip`);
fs.rmSync(zip, { force: true });
const folder = path.basename(appPath);
const readme = path.join(appPath, 'LEEME.txt');
fs.writeFileSync(
  readme,
  t.platform === 'win32'
    ? 'Abre JustMusic.exe.\r\nSi Windows muestra "Windows protegió tu PC": Más información → Ejecutar de todas formas (solo la primera vez).\r\n'
    : 'Arrastra JustMusic.app a Aplicaciones y ábrela.\nSi macOS dice que está dañada o que no se puede verificar, abre Terminal y pega:\n  xattr -cr /Applications/JustMusic.app\nLuego ábrela de nuevo (solo la primera vez).\n',
);
// keep symlinks and permissions (macOS apps depend on both)
if (process.platform === 'darwin') run(`ditto -c -k --keepParent "${appPath}" "${zip}"`);
else if (process.platform === 'win32') run(`powershell -NoProfile -Command "Compress-Archive -Path '${appPath}' -DestinationPath '${zip}'"`);
else execSync(`zip -qry "${zip}" "${folder}"`, { cwd: path.dirname(appPath), stdio: 'inherit' });
console.log(`\n✓ ${path.relative(root, zip)}  (${(fs.statSync(zip).size / 1e6).toFixed(0)} MB)`);
