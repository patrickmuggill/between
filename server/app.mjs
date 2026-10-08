import express from 'express';
import { createServer as createHttpServer } from 'node:http';
import { readFile, access } from 'node:fs/promises';
import path from 'node:path';
import { createApiRouter } from './api.mjs';
import { createXPostRouter } from './x-post.mjs';
import { browserPathOnly, isLocalRequest, localRequestOnly, securityHeaders } from './security.mjs';

const NONCE_PLACEHOLDER = '__BETWEEN_CSP_NONCE__';

export async function createApp({ root, production = false, apiOptions, xOptions } = {}) {
  if (!root) throw new Error('A project root is required.');
  const app = express();
  app.disable('x-powered-by');
  app.disable('etag');
  app.set('trust proxy', false);
  const server = createHttpServer({ requestTimeout: 15_000, headersTimeout: 10_000, keepAliveTimeout: 5_000, maxHeaderSize: 16_384 }, app);
  server.maxRequestsPerSocket = 1_000;
  // WebSocket upgrades bypass Express. Use the same boundary before Vite's HMR.
  server.on('upgrade', (req, socket) => {
    if (!isLocalRequest(req)) {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      socket.destroy();
    }
  });
  app.use(securityHeaders({ development: !production }));
  app.use(localRequestOnly);
  app.use('/api/x', createXPostRouter(xOptions));
  app.use('/api', createApiRouter(apiOptions));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Unknown API route.' }));
  app.use(browserPathOnly(root, { development: !production }));
  let vite;
  if (production) {
    const dist = path.join(root, 'dist');
    try { await access(path.join(dist, 'index.html')); } catch { throw new Error('Build the app first with npm run build, then run npm start.'); }
    app.get('/', (_req, res) => res.sendFile(path.join(dist, 'index.html')));
    app.use('/assets', express.static(path.join(dist, 'assets'), { dotfiles: 'deny', immutable: true, maxAge: '1y', fallthrough: false, setHeaders: res => res.setHeader('Cache-Control', 'public, max-age=31536000, immutable') }));
    app.use(express.static(dist, { dotfiles: 'deny', index: false, fallthrough: false, setHeaders: res => res.setHeader('Cache-Control', 'no-store') }));
  } else {
    const { createServer } = await import('vite');
    vite = await createServer({
      root,
      appType: 'custom',
      envPrefix: [],
      html: { cspNonce: NONCE_PLACEHOLDER },
      server: {
        host: '127.0.0.1',
        middlewareMode: { server },
        ws: { server },
        cors: false,
        allowedHosts: ['localhost', '127.0.0.1'],
        fs: { strict: true, allow: [root], deny: ['.env', '.env.*', '**/.git/**', '**/server/**', '**/server.mjs', '**/scripts/**', '**/tests/**', '**/*.pem', '**/*.key', '**/*.p12'] },
        watch: { usePolling: true, interval: 200 },
      },
    });
    // Handle HTML ourselves so each document gets a fresh CSP nonce.
    app.get(['/', '/index.html'], async (req, res, next) => {
      try {
        const template = await readFile(path.join(root, 'index.html'), 'utf8');
        const html = await vite.transformIndexHtml(req.originalUrl, template);
        res.type('html').send(html.replaceAll(NONCE_PLACEHOLDER, res.locals.nonce));
      } catch (error) { next(error); }
    });
    app.use(vite.middlewares);
  }
  app.use((_req, res) => res.status(404).json({ error: 'This local route does not exist.' }));
  app.use((error, _req, res, _next) => {
    if (res.headersSent) return res.destroy();
    const status = error.status === 404 ? 404 : error.status === 403 ? 403 : 500;
    res.status(status).json({ error: status === 500 ? 'The local app could not complete this request.' : 'This file is not served by the app.' });
  });
  return { app, server, close: async () => { await vite?.close(); server.closeAllConnections(); if (server.listening) await new Promise(resolve => server.close(resolve)); } };
}
