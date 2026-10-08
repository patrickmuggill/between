import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request } from 'node:http';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createApp } from '../server/app.mjs';

const marker = 'THIS_IS_FAKE_PRIVATE_SERVER_DATA';

async function fixture(t, production = true) {
  const root = await mkdtemp(path.join(tmpdir(), 'between-security-'));
  await Promise.all(['src', 'dist/assets', 'node_modules/.vite/deps', 'server'].map(folder => mkdir(path.join(root, folder), { recursive: true })));
  await Promise.all([
    writeFile(path.join(root, 'index.html'), '<!doctype html><html><head></head><body><script type="module" src="/src/main.js"></script></body></html>'),
    writeFile(path.join(root, 'src/main.js'), 'document.body.dataset.loaded = "true";'),
    writeFile(path.join(root, 'dist/index.html'), '<!doctype html><html><body>Between test</body></html>'),
    writeFile(path.join(root, 'dist/assets/app-abc12345.js'), 'console.log("Between test")'),
    writeFile(path.join(root, 'server.mjs'), marker),
    writeFile(path.join(root, 'server/private.mjs'), marker),
    writeFile(path.join(root, '.env.local'), `OPENAI_API_KEY=${marker}`),
  ]);
  const noNetwork = () => assert.fail('Security test must not make outbound requests');
  const instance = await createApp({ root, production, apiOptions: { apiKey: '', fetchImpl: noNetwork }, xOptions: { fetchImpl: noNetwork } });
  instance.server.listen(0, '127.0.0.1');
  await once(instance.server, 'listening');
  t.after(async () => { await instance.close(); await rm(root, { recursive: true, force: true }); });
  return { ...instance, root, base: `http://127.0.0.1:${instance.server.address().port}` };
}

function raw(base, route, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = request(`${base}${route}`, { headers }, res => {
      let body = '';
      res.setEncoding('utf8').on('data', chunk => { body += chunk; }).on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    });
    req.on('error', reject);
    req.end();
  });
}

test('production documents, assets, API errors, and missing routes carry strict security headers', async t => {
  const { base } = await fixture(t);
  for (const route of ['/', '/index.html', '/assets/app-abc12345.js', '/api/health', '/api/missing', '/no-such-file']) {
    const response = await fetch(base + route);
    const policy = response.headers.get('content-security-policy');
    assert.match(policy, /default-src 'none'/);
    assert.match(policy, /script-src 'self'/);
    assert.match(policy, /style-src-attr 'none'/);
    assert.match(policy, /connect-src 'self'/);
    assert.match(policy, /frame-ancestors 'none'/);
    assert.doesNotMatch(policy, /unsafe-inline|unsafe-eval|https:|ws:/);
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('referrer-policy'), 'no-referrer');
    assert.equal(response.headers.get('cross-origin-resource-policy'), 'same-origin');
    assert.equal(response.headers.get('x-powered-by'), null);
    assert.doesNotMatch(await response.text(), new RegExp(marker));
  }
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/api/missing')).status, 404);
});

test('production caches fingerprinted assets but never the HTML document or API', async t => {
  const { base } = await fixture(t);
  assert.match((await fetch(base + '/assets/app-abc12345.js')).headers.get('cache-control'), /max-age=31536000.*immutable/);
  assert.equal((await fetch(base + '/')).headers.get('cache-control'), 'no-store');
  assert.equal((await fetch(base + '/api/health')).headers.get('cache-control'), 'no-store');
});

test('all app routes reject hostile origins, same-site sibling apps, and DNS rebinding', async t => {
  const { base } = await fixture(t);
  for (const route of ['/', '/assets/app-abc12345.js', '/api/health']) {
    for (const headers of [{ Host: 'attacker.invalid' }, { Origin: 'http://localhost:12345' }, { Origin: 'null' }, { 'Sec-Fetch-Site': 'cross-site' }, { 'Sec-Fetch-Site': 'same-site' }, { Host: 'localhost@attacker.invalid' }]) {
      const response = await raw(base, route, headers);
      assert.equal(response.status, 403, `${route} ${JSON.stringify(headers)}`);
      assert.doesNotMatch(response.body, /Between test|OPENAI_API_KEY/);
    }
    assert.equal((await fetch(base + route, { headers: { Origin: base, 'Sec-Fetch-Site': 'same-origin' } })).status, 200);
  }
});

test('forwarding headers cannot bypass the real host and origin boundary', async t => {
  const { base } = await fixture(t);
  const response = await raw(base, '/', { Host: 'attacker.invalid', 'X-Forwarded-Host': 'localhost', 'X-Forwarded-Proto': 'http' });
  assert.equal(response.status, 403);
});

test('production does not serve server files, secrets, arbitrary paths, or source code', async t => {
  const { base, root } = await fixture(t);
  for (const route of ['/.env.local', '/%2eenv.local', '/.git/config', '/server.mjs?raw', '/server/private.mjs', '/package.json', '/src/main.js', '/scripts/setup.mjs', '/@fs' + root + '/.env.local', '/assets/%252e%252e/server.mjs', '/assets/%00server.mjs']) {
    const response = await raw(base, route);
    assert.ok([400, 403, 404].includes(response.status), `${route}: ${response.status}`);
    assert.doesNotMatch(response.body, new RegExp(marker));
  }
  const method = await fetch(base + '/', { method: 'PUT' });
  assert.equal(method.status, 405);
});

test('development retains Vite with per-document nonces and same-port HMR', async t => {
  const { base } = await fixture(t, false);
  const first = await fetch(base);
  const firstPolicy = first.headers.get('content-security-policy');
  const firstNonce = firstPolicy.match(/'nonce-([^']+)'/)[1];
  assert.match(firstPolicy, new RegExp(`connect-src 'self' ws://${new URL(base).host}`));
  const html = await first.text();
  assert.equal(html.includes(`nonce="${firstNonce}"`), true);
  assert.doesNotMatch(html, /__BETWEEN_CSP_NONCE__|unsafe-inline/);
  const secondPolicy = (await fetch(base)).headers.get('content-security-policy');
  assert.notEqual(firstPolicy, secondPolicy);
  assert.equal((await fetch(base + '/@vite/client')).status, 200);
  assert.equal((await fetch(base + '/src/main.js')).status, 200);
});

test('development blocks private files even through raw, filesystem, and encoded routes', async t => {
  const { base, root } = await fixture(t, false);
  for (const route of ['/.env.local', '/.env.local?raw', '/server.mjs?raw', '/server/private.mjs?import', '/package.json', '/@fs' + root + '/.env.local?raw', '/@fs' + root + '/server/private.mjs?raw', '/@fs/etc/passwd?raw', '/src/%252e%252e/.env.local', '/src/%5c..%5c.env.local']) {
    const response = await raw(base, route);
    assert.ok([400, 403, 404].includes(response.status), `${route}: ${response.status}`);
    assert.doesNotMatch(response.body, new RegExp(marker));
  }
});

test('development HMR upgrade rejects a foreign origin before the Vite listener', async t => {
  const { base } = await fixture(t, false);
  const response = await raw(base, '/', { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Key': 'AAAAAAAAAAAAAAAAAAAAAA==', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Protocol': 'vite-hmr', Origin: 'https://attacker.invalid' });
  assert.equal(response.status, 403);
});
