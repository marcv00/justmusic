import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { handler } from './api';

/**
 * JustMusic without Vite: one small HTTP server for the built app and the local API.
 * Used by the desktop app; binds to this computer only.
 */

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.woff': 'font/woff',
  '.wasm': 'application/wasm',
};

function serveStatic(root: string, req: IncomingMessage, res: ServerResponse) {
  const url = new URL(req.url ?? '/', 'http://local');
  let rel = decodeURIComponent(url.pathname);
  if (rel.endsWith('/')) rel += 'index.html';
  const file = path.normalize(path.join(root, rel));
  if (!file.startsWith(root)) {
    res.statusCode = 403;
    return res.end();
  }
  const target = fs.existsSync(file) && fs.statSync(file).isFile() ? file : path.join(root, 'index.html');
  res.setHeader('content-type', MIME[path.extname(target)] ?? 'application/octet-stream');
  // hashed assets never change; the page itself always revalidates
  res.setHeader('cache-control', target.includes(`${path.sep}assets${path.sep}`) ? 'public, max-age=31536000, immutable' : 'no-cache');
  fs.createReadStream(target).pipe(res);
}

/** Start on the preferred port (stable, so settings saved in the browser survive restarts), or the next free one. */
export function startServer(distDir: string, preferred = 47821): Promise<number> {
  const root = path.resolve(distDir);
  const server = http.createServer((req, res) => {
    void handler(req as any, res as any, () => serveStatic(root, req, res));
  });
  return new Promise((resolve, reject) => {
    let port = preferred;
    const tryListen = () => {
      server.once('error', (e: NodeJS.ErrnoException) => {
        if (e.code === 'EADDRINUSE' && port < preferred + 20) {
          port++;
          tryListen();
        } else reject(e);
      });
      server.listen(port, '127.0.0.1', () => resolve(port));
    };
    tryListen();
  });
}
