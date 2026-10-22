import { app, BrowserWindow, session, shell } from 'electron';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { startServer } from '../server/standalone';

/**
 * JustMusic as a desktop app: everything it needs travels inside it (the interface, the local
 * server, yt-dlp and a small JavaScript engine for yt-dlp). Nothing to install.
 */

const isWin = process.platform === 'win32';
const exe = (name: string) => (isWin ? `${name}.exe` : name);

// let audio start without an extra click, and look like a browser to YouTube's player
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');
app.userAgentFallback = app.userAgentFallback.replace(/\s*(Electron|justmusic)\/\S+/gi, '');

/**
 * The bundled tools are copied to a writable folder on first run, so yt-dlp can update
 * itself there (YouTube changes often; an old yt-dlp stops working).
 */
function prepareTools() {
  const bundled = app.isPackaged
    ? path.join(process.resourcesPath, 'bin')
    : path.join(__dirname, '..', 'bin', `${process.platform}-${process.arch}`);
  const dir = path.join(app.getPath('userData'), 'bin');
  fs.mkdirSync(dir, { recursive: true });
  if (fs.existsSync(bundled)) {
    for (const f of fs.readdirSync(bundled)) {
      const dst = path.join(dir, f);
      if (!fs.existsSync(dst)) {
        fs.copyFileSync(path.join(bundled, f), dst);
        if (!isWin) fs.chmodSync(dst, 0o755);
        // a downloaded, unsigned tool would be blocked by Gatekeeper the first time it runs
        if (process.platform === 'darwin') spawnSync('xattr', ['-d', 'com.apple.quarantine', dst]);
      }
    }
  }
  const ytdlp = path.join(dir, exe('yt-dlp'));
  const qjs = path.join(dir, exe('qjs'));
  if (fs.existsSync(ytdlp)) process.env.YTDLP_PATH = ytdlp;
  if (fs.existsSync(qjs)) process.env.JUSTMUSIC_JS_RUNTIME = `quickjs:${qjs}`;

  // self-update at most once a day, quietly, after start-up
  const stamp = path.join(dir, '.updated');
  const last = fs.existsSync(stamp) ? fs.statSync(stamp).mtimeMs : 0;
  if (fs.existsSync(ytdlp) && Date.now() - last > 24 * 3600 * 1000) {
    setTimeout(() => {
      const p = spawn(ytdlp, ['-U'], { stdio: 'ignore' });
      p.on('close', () => fs.writeFileSync(stamp, new Date().toISOString()));
      p.on('error', () => undefined);
    }, 4000);
  }
}

async function createWindow() {
  const dist = path.join(__dirname, 'dist');
  const port = await startServer(dist);

  session.defaultSession.setPermissionRequestHandler((_wc, permission, done) => {
    done(['media', 'fullscreen', 'clipboard-sanitized-write'].includes(permission));
  });

  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 900,
    minHeight: 600,
    backgroundColor: '#0a0001',
    title: 'JustMusic',
    autoHideMenuBar: true,
    show: false,
    webPreferences: { backgroundThrottling: false },
  });
  win.once('ready-to-show', () => win.show());
  // links like "Buscar en YouTube" open in the normal browser
  win.webContents.setWindowOpenHandler(({ url }) => {
    void shell.openExternal(url);
    return { action: 'deny' };
  });
  await win.loadURL(`http://127.0.0.1:${port}/`);
}

app.whenReady().then(() => {
  prepareTools();
  void createWindow();
  app.on('activate', () => BrowserWindow.getAllWindows().length === 0 && void createWindow());
});
app.on('window-all-closed', () => app.quit());
