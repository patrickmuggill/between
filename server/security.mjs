import { randomBytes } from 'node:crypto';

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

/** Check the actual Host and Origin, never proxy-supplied forwarding headers. */
export function isLocalRequest(req) {
  const host = req.headers.host;
  if (typeof host !== 'string') return false;
  let parsed;
  try { parsed = new URL(`http://${host}`); } catch { return false; }
  if (!LOOPBACK_HOSTS.has(parsed.hostname) || parsed.host !== host) return false;
  const site = req.headers['sec-fetch-site'];
  if (site && !['same-origin', 'none'].includes(site)) return false;
  const origin = req.headers.origin;
  return !origin || origin === `http://${host}`;
}

export function localRequestOnly(req, res, next) {
  if (!isLocalRequest(req)) return res.status(403).json({ error: 'Only requests from this local app are allowed.' });
  if (req.method === 'POST' && !req.is('application/json')) return res.status(415).json({ error: 'Use application/json for this request.' });
  next();
}

/** Apply to every route, including Vite, assets, errors, and the document. */
export function securityHeaders({ development = false } = {}) {
  return (req, res, next) => {
    const nonce = randomBytes(18).toString('base64');
    res.locals.nonce = nonce;
    const policy = [
      "default-src 'none'",
      `script-src 'self'${development ? ` 'nonce-${nonce}'` : ''}`,
      `style-src 'self'${development ? ` 'nonce-${nonce}'` : ''}`,
      "style-src-attr 'none'",
      "img-src 'self' data:",
      "font-src 'self'",
      `connect-src 'self'${development && isLocalRequest(req) ? ` ws://${req.headers.host}` : ''}`,
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
      "frame-ancestors 'none'",
    ];
    res.set({
      'Content-Security-Policy': policy.join('; '),
      'X-Content-Type-Options': 'nosniff',
      'X-Frame-Options': 'DENY',
      'Referrer-Policy': 'no-referrer',
      'Cross-Origin-Opener-Policy': 'same-origin',
      'Cross-Origin-Resource-Policy': 'same-origin',
      'Permissions-Policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
      'Cache-Control': 'no-store',
    });
    next();
  };
}

/** Development serves browser code, never server/config/test/source-key files. */
export function browserPathOnly(root, { development = false } = {}) {
  const normalizedRoot = root.replaceAll('\\', '/').replace(/\/$/, '');
  return (req, res, next) => {
    let pathname;
    try {
      pathname = req.url.split('?')[0];
      // Reject encoded traversal and alternate separators before Vite sees it.
      for (let pass = 0; pass < 4; pass += 1) {
        const decoded = decodeURIComponent(pathname);
        if (decoded === pathname) break;
        pathname = decoded;
      }
    } catch { return res.status(400).json({ error: 'Invalid local path.' }); }
    if (/[\\\u0000-\u001f\u007f%]/.test(pathname) || pathname.split('/').some(part => part === '..' || part === '.')) return res.status(403).json({ error: 'This file is not served by the app.' });
    if (development && pathname.startsWith('/@fs/')) {
      const absolute = pathname.slice(4);
      if (!absolute.startsWith(`${normalizedRoot}/`)) return res.status(403).json({ error: 'This file is not served by the app.' });
      pathname = absolute.slice(normalizedRoot.length);
    }
    const browserFile = pathname === '/' || pathname === '/index.html' || pathname === '/favicon.svg' || pathname.startsWith('/assets/');
    const developmentFile = development && (
      pathname.startsWith('/src/') || pathname.startsWith('/node_modules/') ||
      ['/@vite/client', '/@vite/env', '/@react-refresh'].includes(pathname) ||
      pathname.startsWith('/@id/')
    );
    // Vite's own .vite dependency cache is necessary; other hidden files are not.
    const hidden = pathname.split('/').some((part, index, parts) => part.startsWith('.') && !(part === '.vite' && parts[index - 1] === 'node_modules'));
    if (hidden || (!browserFile && !developmentFile)) return res.status(404).json({ error: 'This file is not served by the app.' });
    if (!['GET', 'HEAD'].includes(req.method)) return res.set('Allow', 'GET, HEAD').status(405).json({ error: 'This route is read only.' });
    next();
  };
}
