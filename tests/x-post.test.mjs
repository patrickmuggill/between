import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import express from 'express';
import { createXPostRouter, lookupXPost, parseXEmbed, parseXPostUrl, parseXPublicPage } from '../server/x-post.mjs';

const POST_URL = 'https://x.com/thoughtful/status/123456789';
const SAMPLE = {
  url: POST_URL,
  author_name: 'Thoughtful Person',
  author_url: 'https://x.com/thoughtful',
  html: '<blockquote class="twitter-tweet"><p lang="en">A useful thought.<br><br>What happens next?</p>&mdash; Thoughtful Person (@thoughtful) <a href="https://x.com/thoughtful/status/123456789">October 7, 2026</a></blockquote><script src="https://platform.x.com/widgets.js"></script>',
};
const json = (value = SAMPLE, init = {}) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' }, ...init });
const shortened = { ...SAMPLE, html: '<blockquote class="twitter-tweet"><p>A useful thought… <a href="https://t.co/example">https://t.co/example</a></p></blockquote>' };
const fullText = 'A useful thought that continues all the way to the end.';
const tweetObject = (text = fullText, rest_id = '123456789', handle = 'thoughtful') => ({ __typename: 'Tweet', rest_id, core: { user_results: { result: { core: { screen_name: handle } } } }, note_tweet: { note_tweet_results: { result: { __typename: 'NoteTweet', text } } } });
const publicPage = value => `<html><script>const state = ${JSON.stringify(value).replaceAll('<', '\\u003c')};</script></html>`;
const htmlResponse = body => new Response(body, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });

async function fixture(t, options = {}) {
  const calls = [];
  const app = express();
  app.use('/api/x', createXPostRouter({ fetchImpl: async (...args) => { calls.push(args); return json(); }, ...options }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (body = { url: POST_URL }, init = {}) => fetch(`${base}/api/x/reference`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...init.headers },
    body: JSON.stringify(body),
    ...init,
  });
  return { base, post, calls };
}

test('post URL normalization accepts supported X/Twitter variants and strips tracking', () => {
  for (const host of ['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']) {
    assert.deepEqual(parseXPostUrl(`https://${host}/thoughtful/status/123456789/?s=20#fragment`), { url: POST_URL, postId: '123456789', authorHandle: 'thoughtful' });
  }
  assert.equal(parseXPostUrl('http://twitter.com/thoughtful/status/123456789').url, POST_URL);
  assert.deepEqual(parseXPostUrl('https://x.com/i/web/status/123456789'), { url: 'https://x.com/i/web/status/123456789', postId: '123456789', authorHandle: '' });
});

test('rejects SSRF targets, credential URLs, ambiguous paths, and oversized input before fetching', async () => {
  const invalid = [
    null, {}, '', 'x.com/thoughtful/status/123456789', 'https://127.0.0.1/status/12',
    'http://169.254.169.254/latest/meta-data', 'https://x.com.evil.invalid/thoughtful/status/12',
    'https://evil.invalid/?url=https://x.com/thoughtful/status/12', 'https://x.com@evil.invalid/thoughtful/status/12',
    'https://evil@x.com/thoughtful/status/12', 'https://x.com:8443/thoughtful/status/12',
    'file:///etc/passwd', 'data:text/html,test', 'ftp://x.com/thoughtful/status/12',
    'https://x.com/thoughtful', 'https://x.com/thoughtful/status/nope',
    'https://x.com/thoughtful/status/123456789012345678901', 'https://x.com/thoughtful/status/0',
    'https://x.com/thoughtful/status/12/other', 'https://x.com/toolongusernamehere/status/12',
    'https://x.com/%74houghtful/status/12', 'https://x.com\\@evil.invalid/thoughtful/status/12',
    'https://x.com/thoughtful/status/12\n', 'https://x.com/thoughtful/status/12?' + 'x'.repeat(2_000),
  ];
  for (const value of invalid) {
    await assert.rejects(lookupXPost(value, { fetchImpl: () => assert.fail('Unsafe URL reached fetch') }), error => error.status === 400 && error.code === 'invalid_url', String(value));
  }
});

test('oEmbed parser decodes text entities and line breaks without returning HTML, scripts, or attribution footer', () => {
  const result = parseXEmbed({ ...SAMPLE, html: '<script>stolen</script><blockquote class="twitter-tweet"><p>A &amp; B &#39;agree&#39; &lt;literal&gt;<br>🙂 <a href="javascript:alert(1)">visible text</a><script>steal()</script><style>hide</style><iframe>ignore</iframe><svg><text>invisible</text></svg></p>&mdash; footer</blockquote>' }, parseXPostUrl(POST_URL), 0);
  assert.equal(result.text, "A & B 'agree' <literal>\n🙂 visible text");
  assert.equal(result.source, 'x');
  assert.equal(result.fetchedAt, '1970-01-01T00:00:00.000Z');
  assert.match(result.note, /incomplete/);
  assert.equal(result.textStatus, 'unverified');
  assert.deepEqual(Object.keys(result).sort(), ['authorHandle', 'authorName', 'fetchedAt', 'note', 'postId', 'source', 'text', 'textStatus', 'url']);
});

test('keeps returned ellipses and links exactly as available instead of inventing complete text', () => {
  const result = parseXEmbed({ ...SAMPLE, html: '<blockquote class="twitter-tweet"><p>I can prompt… <a href="https://t.co/example">https://t.co/example</a></p></blockquote>' }, parseXPostUrl(POST_URL));
  assert.equal(result.text, 'I can prompt… https://t.co/example');
  assert.equal(result.textStatus, 'possibly_truncated');
  assert.match(result.note, /shortened/);
});

test('author is derived from upstream author URL, not an untrusted pasted handle', () => {
  const result = parseXEmbed(SAMPLE, parseXPostUrl('https://x.com/somebodyelse/status/123456789'));
  assert.equal(result.authorHandle, 'thoughtful');
  assert.equal(result.url, POST_URL);
});

test('rejects unrelated posts, missing authors, wrong markup, empty text, and oversized content', () => {
  const variants = [
    null, {}, { ...SAMPLE, url: 'https://x.com/thoughtful/status/999' },
    { ...SAMPLE, url: 'https://evil.invalid/thoughtful/status/123456789' },
    { ...SAMPLE, author_url: 'https://evil.invalid/thoughtful' },
    { ...SAMPLE, author_url: 'javascript:evil' }, { ...SAMPLE, author_name: null },
    { ...SAMPLE, html: '<p>Unrelated text</p>' },
    { ...SAMPLE, html: '<blockquote class="twitter-tweet"><p><script>evil</script></p></blockquote>' },
    { ...SAMPLE, html: 'x'.repeat(512_001) },
  ];
  for (const payload of variants) assert.throws(() => parseXEmbed(payload, parseXPostUrl(POST_URL)), error => error.code === 'unreadable_post');
});

test('fetched reference text shares the 60,000-character AI limit without silent truncation', () => {
  const embed = length => ({ ...SAMPLE, html: '<blockquote class="twitter-tweet"><p>' + 'x'.repeat(length) + '</p></blockquote>' });
  assert.equal(parseXEmbed(embed(60_000), parseXPostUrl(POST_URL)).text.length, 60_000);
  assert.throws(() => parseXEmbed(embed(60_001), parseXPostUrl(POST_URL)), error => error.status === 422 && error.code === 'post_too_long' && /60,000.*paste/.test(error.message));
});

test('lookup uses only the hardcoded official endpoint and omits credentials and redirects', async () => {
  const calls = [];
  const result = await lookupXPost(POST_URL + '?s=20', { fetchImpl: async (...args) => { calls.push(args); return json(); }, now: () => 0 });
  assert.equal(result.text, 'A useful thought.\n\nWhat happens next?');
  const endpoint = new URL(calls[0][0]);
  assert.equal(endpoint.origin + endpoint.pathname, 'https://publish.x.com/oembed');
  assert.deepEqual(Object.fromEntries(endpoint.searchParams), { url: POST_URL, omit_script: 'true', dnt: 'true', hide_thread: 'true' });
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].credentials, 'omit');
  assert.equal(calls[0][1].headers.Authorization, undefined);
  assert.equal(calls[0][1].signal instanceof AbortSignal, true);
});

test('maps unavailable, throttled, failed, and redirect responses to actionable safe errors', async () => {
  for (const [upstreamStatus, expectedStatus, code] of [[401, 422, 'unavailable_post'], [403, 422, 'unavailable_post'], [404, 422, 'unavailable_post'], [410, 422, 'unavailable_post'], [429, 429, 'x_rate_limit'], [500, 502, 'x_unavailable'], [302, 502, 'x_unavailable']]) {
    await assert.rejects(lookupXPost(POST_URL, { fetchImpl: async () => new Response('private upstream details', { status: upstreamStatus }) }), error => error.status === expectedStatus && error.code === code && /paste/i.test(error.message) && !error.message.includes('private upstream details'));
  }
  await assert.rejects(lookupXPost(POST_URL, { fetchImpl: async () => { throw new Error('private stack'); } }), error => error.status === 502 && !error.message.includes('private stack'));
});

test('rejects malformed or overlarge upstream bodies including missing content-length', async () => {
  for (const response of [new Response('<html>Login</html>'), new Response('x'.repeat(512_001)), new Response('{}', { headers: { 'content-length': '9999999' } }), new Response(null)]) {
    await assert.rejects(lookupXPost(POST_URL, { fetchImpl: async () => response }), error => error.status === 502 && error.code === 'unreadable_post');
  }
});

test('timeout caps a stalled upstream lookup and aborts its signal', async () => {
  let signal;
  await assert.rejects(lookupXPost(POST_URL, { timeoutMs: 10, fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } }), error => error.status === 504 && error.code === 'timeout');
  assert.equal(signal.aborted, true);
});

test('caller cancellation aborts upstream request', async () => {
  const controller = new AbortController();
  let signal;
  const pending = lookupXPost(POST_URL, { signal: controller.signal, fetchImpl: async (_url, options) => { signal = options.signal; return new Promise(() => {}); } });
  controller.abort();
  await assert.rejects(pending, error => error.code === 'cancelled');
  assert.equal(signal.aborted, true);
});

test('router returns the narrow post reference contract and exact same-origin requests work', async t => {
  const { post, base } = await fixture(t);
  const response = await post({ url: POST_URL }, { headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const value = await response.json();
  assert.equal(value.authorHandle, 'thoughtful');
  assert.equal(value.html, undefined);
});

test('router blocks cross-site, opaque origins, other localhost ports, and DNS-rebinding hosts', async t => {
  const { post, base, calls } = await fixture(t);
  for (const extra of [{ Origin: 'https://evil.invalid' }, { Origin: 'null' }, { Origin: 'http://127.0.0.1:9999' }, { 'Sec-Fetch-Site': 'cross-site' }]) {
    const response = await post({ url: POST_URL }, { headers: { 'Content-Type': 'application/json', ...extra } });
    assert.equal(response.status, 403);
  }
  for (const host of ['evil.invalid', 'localhost@evil.invalid']) {
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(`${base}/api/x/reference`, { method: 'POST', headers: { Host: host, 'Content-Type': 'application/json' } }, response => { response.resume(); resolve(response.statusCode); });
      request.on('error', reject);
      request.end(JSON.stringify({ url: POST_URL }));
    });
    assert.equal(status, 403);
  }
  assert.equal(calls.length, 0);
});

test('router validates request size, JSON, content type, and missing URLs before fetching', async t => {
  const { post, calls } = await fixture(t);
  for (const [body, init, status] of [
    [{}, {}, 400], [[], {}, 400], [null, {}, 400],
    [{ url: POST_URL }, { headers: { 'Content-Type': 'text/plain' } }, 415],
    [{ url: 'x'.repeat(5_000) }, {}, 413],
    [{}, { body: '{invalid' }, 400],
  ]) {
    const response = await post(body, init);
    assert.equal(response.status, status);
    assert.equal(typeof (await response.json()).error, 'string');
  }
  assert.equal(calls.length, 0);
});

test('cache reuses post IDs and expires without a background fetch', async t => {
  let clock = 0;
  const { post, calls } = await fixture(t, { now: () => clock, cacheTtlMs: 100 });
  assert.equal((await post()).status, 200);
  assert.equal((await post({ url: 'https://twitter.com/another/status/123456789?s=20' })).status, 200);
  assert.equal(calls.length, 1);
  clock = 101;
  assert.equal((await post()).status, 200);
  assert.equal(calls.length, 2);
});

test('cache size is bounded and evicted posts are fetched again', async t => {
  let count = 0;
  const { post } = await fixture(t, { cacheSize: 1, fetchImpl: async endpoint => {
    count += 1;
    const url = new URL(endpoint).searchParams.get('url');
    return json({ ...SAMPLE, url });
  } });
  for (const id of ['123456789', '123456790', '123456789']) assert.equal((await post({ url: `https://x.com/thoughtful/status/${id}` })).status, 200);
  assert.equal(count, 3);
});

test('local request rate limit rejects additional outbound requests and recovers after its window', async t => {
  let clock = 0;
  const { post, calls } = await fixture(t, { cacheSize: 0, rateLimit: 1, rateWindowMs: 100, now: () => clock });
  assert.equal((await post()).status, 200);
  const rejected = await post();
  assert.equal(rejected.status, 429);
  assert.equal((await rejected.json()).code, 'local_rate_limit');
  clock = 101;
  assert.equal((await post()).status, 200);
  assert.equal(calls.length, 2);
});

test('concurrency guard releases capacity after a completed request', async t => {
  let completeFirst;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  let calls = 0;
  const { post } = await fixture(t, { maxConcurrent: 1, cacheSize: 0, fetchImpl: async () => {
    calls += 1;
    if (calls > 1) return json();
    markStarted();
    return new Promise(resolve => { completeFirst = () => resolve(json()); });
  } });
  const first = post();
  await started;
  const blocked = await post();
  assert.equal(blocked.status, 429);
  assert.equal((await blocked.json()).code, 'local_rate_limit');
  completeFirst();
  assert.equal((await first).status, 200);
  assert.equal((await post()).status, 200);
  assert.equal(calls, 2);
});

test('failed fetches are not cached and a later lookup can recover', async t => {
  let calls = 0;
  const { post } = await fixture(t, { fetchImpl: async () => {
    calls += 1;
    return calls === 1 ? new Response('unavailable', { status: 503 }) : json();
  } });
  assert.equal((await post()).status, 502);
  assert.equal((await post()).status, 200);
  assert.equal(calls, 2);
});

test('public-page extraction requires an explicit NoteTweet on the exact post and author', () => {
  const reference = parseXEmbed(shortened, parseXPostUrl(POST_URL));
  const result = parseXPublicPage(publicPage(tweetObject()), reference);
  assert.equal(result.text, fullText);
  assert.equal(result.textStatus, 'full_text');
  assert.equal(result.postId, reference.postId);
  assert.match(result.note, /Full post text/);
  assert.equal(parseXPublicPage(publicPage(tweetObject(fullText, '999')), reference), null);
  assert.equal(parseXPublicPage(publicPage(tweetObject(fullText, '123456789', 'different')), reference), null);
  assert.equal(parseXPublicPage(publicPage({ rest_id: '123456789', result: tweetObject(fullText, '999') }), reference), null);
});

test('public-page extraction handles serializer assignments without executing script code', () => {
  const reference = parseXEmbed(shortened, parseXPostUrl(POST_URL));
  const serialized = JSON.stringify(tweetObject()).replaceAll(':{', ':$R[42]={');
  const html = `<script>globalThis.__betweenMustNotExecute = 'executed'; const state = ${serialized};</script>`;
  assert.equal(parseXPublicPage(html, reference).text, fullText);
  assert.equal(globalThis.__betweenMustNotExecute, undefined);
});

test('quoted tweets and replies cannot supply the reference full text', () => {
  const reference = parseXEmbed(shortened, parseXPostUrl(POST_URL));
  const quoteOnly = { __typename: 'Tweet', rest_id: '123456789', quoted_tweet_results: { result: tweetObject('Wrong quoted text', '999') } };
  const reply = { ...tweetObject('Wrong reply text', '888'), reply_to_results: { rest_id: '123456789' } };
  assert.equal(parseXPublicPage(publicPage([quoteOnly, reply]), reference), null);
  assert.equal(parseXPublicPage(publicPage([quoteOnly, reply, tweetObject()]), reference).text, fullText);
});

test('malformed serialization, dynamic text, conflicting versions, and oversized HTML never imply completeness', () => {
  const reference = parseXEmbed(shortened, parseXPostUrl(POST_URL));
  const dynamicText = JSON.stringify(tweetObject()).replace(JSON.stringify(fullText), 'getText()');
  const duplicateId = JSON.stringify(tweetObject()).replace('"rest_id":"123456789"', '"rest_id":"123456789","rest_id":"999"');
  for (const html of [
    '<script>const note_tweet = broken syntax 123456789</script>',
    `<script>const state = ${dynamicText}</script>`,
    `<script>const state = ${duplicateId}</script>`,
    publicPage([tweetObject(), tweetObject('Conflicting version')]),
    'x'.repeat(512_001),
    '<html>Login to continue</html>',
    publicPage({ note_tweet: JSON.stringify(tweetObject()) }),
  ]) assert.equal(parseXPublicPage(html, reference), null);
});

test('complete long posts preserve all text and reject over-limit content explicitly', () => {
  const reference = parseXEmbed(shortened, parseXPostUrl(POST_URL));
  const text = '🙂'.repeat(25_000);
  assert.equal(parseXPublicPage(publicPage(tweetObject(text)), reference).text, text);
  assert.throws(() => parseXPublicPage(publicPage(tweetObject('x'.repeat(60_001))), reference), error => error.code === 'post_too_long');
});

test('shortened oEmbed lookup retrieves the exact canonical public page without credentials or redirects', async () => {
  const calls = [];
  const result = await lookupXPost(POST_URL, { fetchImpl: async (...args) => {
    calls.push(args);
    return calls.length === 1 ? json(shortened) : htmlResponse(publicPage(tweetObject()));
  } });
  assert.equal(result.text, fullText);
  assert.equal(result.textStatus, 'full_text');
  assert.equal(calls.length, 2);
  assert.equal(calls[1][0], POST_URL);
  assert.equal(calls[1][1].redirect, 'error');
  assert.equal(calls[1][1].credentials, 'omit');
  assert.deepEqual(calls[1][1].headers, { Accept: 'text/html' });
});

test('unavailable, redirected, malformed, or oversized public pages retain the clearly marked excerpt', async () => {
  for (const page of [new Response('Login', { status: 403 }), new Response('', { status: 302 }), htmlResponse(publicPage(tweetObject(fullText, '999'))), htmlResponse('x'.repeat(512_001)), json({ unrelated: true })]) {
    let calls = 0;
    const result = await lookupXPost(POST_URL, { fetchImpl: async () => ++calls === 1 ? json(shortened) : page });
    assert.equal(result.textStatus, 'possibly_truncated');
    assert.equal(result.text, 'A useful thought… https://t.co/example');
    assert.match(result.note, /paste the full text/);
  }
});

test('public-page timeout returns the excerpt promptly and aborts the optional fetch', async () => {
  let calls = 0;
  let pageSignal;
  const result = await lookupXPost(POST_URL, { pageTimeoutMs: 10, fetchImpl: async (_url, options) => {
    if (++calls === 1) return json(shortened);
    pageSignal = options.signal;
    return new Promise(() => {});
  } });
  assert.equal(result.textStatus, 'possibly_truncated');
  assert.equal(pageSignal.aborted, true);
});

test('caller cancellation also aborts an in-progress public-page fetch', async () => {
  const controller = new AbortController();
  let calls = 0;
  let pageSignal;
  let markStarted;
  const started = new Promise(resolve => { markStarted = resolve; });
  const pending = lookupXPost(POST_URL, { signal: controller.signal, fetchImpl: async (_url, options) => {
    if (++calls === 1) return json(shortened);
    pageSignal = options.signal;
    markStarted();
    return new Promise(() => {});
  } });
  await started;
  controller.abort();
  await assert.rejects(pending, error => error.code === 'cancelled');
  assert.equal(pageSignal.aborted, true);
});

test('possibly truncated results are not cached, allowing an immediate full-text retry', async t => {
  let embedCalls = 0;
  let pageCalls = 0;
  const { post } = await fixture(t, { fetchImpl: async url => {
    if (url.startsWith('https://publish.x.com/')) { embedCalls += 1; return json(shortened); }
    pageCalls += 1;
    return pageCalls === 1 ? new Response('Unavailable', { status: 503 }) : htmlResponse(publicPage(tweetObject()));
  } });
  const first = await (await post()).json();
  assert.equal(first.textStatus, 'possibly_truncated');
  const second = await (await post()).json();
  assert.equal(second.textStatus, 'full_text');
  assert.equal(second.text, fullText);
  const cached = await (await post()).json();
  assert.equal(cached.textStatus, 'full_text');
  assert.equal(embedCalls, 2);
  assert.equal(pageCalls, 2);
});

test('deeply nested embed markup stays bounded without recursive stack overflow', () => {
  const html = '<blockquote class="twitter-tweet"><p>' + '<span>'.repeat(10_000) + 'Complete text.' + '</span>'.repeat(10_000) + '</p></blockquote>';
  const reference = parseXEmbed({ ...SAMPLE, html }, parseXPostUrl(POST_URL));
  assert.equal(reference.text, 'Complete text.');
});
