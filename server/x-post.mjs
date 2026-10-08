import express from 'express';
import { localRequestOnly } from './security.mjs';
import { parseDocument } from 'htmlparser2';
import { parse as parseJavaScript } from 'acorn';

const OEMBED_ENDPOINT = 'https://publish.x.com/oembed';
const X_HOSTS = new Set(['x.com', 'www.x.com', 'mobile.x.com', 'twitter.com', 'www.twitter.com', 'mobile.twitter.com']);
const MAX_RESPONSE_BYTES = 512_000;
const MAX_REFERENCE_LENGTH = 60_000;
const EXCERPT_NOTE = 'Available text from X. Long posts, quoted posts, and media may be incomplete. Open the original for full context.';
const SHORTENED_NOTE = 'This X embed appears to be shortened. Open the original and paste the full text to include the rest.';

class XReferenceError extends Error {
  constructor(status, code, message) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const invalidUrl = () => new XReferenceError(400, 'invalid_url', 'Paste a link to a specific public post on x.com or twitter.com.');
const unreadablePost = () => new XReferenceError(502, 'unreadable_post', 'X did not return readable post text. Open the original and paste its text here.');

/** Accept post links, never an arbitrary fetch target. Drop share tracking. */
export function parseXPostUrl(value) {
  if (typeof value !== 'string' || value.length > 2_000 || /[\\\u0000-\u001f\u007f]/.test(value)) throw invalidUrl();
  let parsed;
  try { parsed = new URL(value.trim()); } catch { throw invalidUrl(); }
  if (!['https:', 'http:'].includes(parsed.protocol) || !X_HOSTS.has(parsed.hostname) || parsed.username || parsed.password || parsed.port) throw invalidUrl();
  const userPost = parsed.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/status\/([1-9][0-9]{0,19})\/?$/);
  const idPost = parsed.pathname.match(/^\/i\/web\/status\/([1-9][0-9]{0,19})\/?$/);
  if (!userPost && !idPost) throw invalidUrl();
  const postId = userPost?.[2] ?? idPost[1];
  const authorHandle = userPost?.[1] ?? '';
  const url = authorHandle ? `https://x.com/${authorHandle}/status/${postId}` : `https://x.com/i/web/status/${postId}`;
  return { url, postId, authorHandle };
}

function findNode(nodes, predicate) {
  const stack = [...(nodes ?? [])].reverse();
  while (stack.length) {
    const node = stack.pop();
    if (predicate(node)) return node;
    if (['script', 'style', 'iframe', 'template', 'noscript', 'svg'].includes(node.name)) continue;
    for (let index = (node.children?.length ?? 0) - 1; index >= 0; index -= 1) stack.push(node.children[index]);
  }
  return null;
}

function plainText(node) {
  const stack = [node];
  const text = [];
  while (stack.length) {
    const current = stack.pop();
    if (current.type === 'text') { text.push(current.data); continue; }
    if (['script', 'style', 'iframe', 'template', 'noscript', 'svg'].includes(current.name)) continue;
    if (current.name === 'br') { text.push('\n'); continue; }
    for (let index = (current.children?.length ?? 0) - 1; index >= 0; index -= 1) stack.push(current.children[index]);
  }
  return text.join('');
}

function cleanText(text) {
  return text.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, '').trim();
}

function parseAuthorHandle(authorUrl) {
  if (typeof authorUrl !== 'string') return '';
  try {
    const parsed = new URL(authorUrl);
    if (parsed.protocol !== 'https:' || !X_HOSTS.has(parsed.hostname) || parsed.username || parsed.password || parsed.port) return '';
    return parsed.pathname.match(/^\/([A-Za-z0-9_]{1,15})\/?$/)?.[1] ?? '';
  } catch { return ''; }
}

/** Extract only the post paragraph. Markup and widget scripts never reach the client. */
export function parseXEmbed(payload, requested, now = Date.now()) {
  if (!payload || typeof payload !== 'object' || typeof payload.html !== 'string' || payload.html.length > MAX_RESPONSE_BYTES) throw unreadablePost();
  let returned;
  try { returned = parseXPostUrl(payload.url); } catch { throw unreadablePost(); }
  if (returned.postId !== requested.postId) throw unreadablePost();
  const authorHandle = parseAuthorHandle(payload.author_url);
  if (!authorHandle || typeof payload.author_name !== 'string' || payload.author_name.length > 200) throw unreadablePost();
  const document = parseDocument(payload.html, { decodeEntities: true });
  const quote = findNode(document.children, node => node.name === 'blockquote' && node.attribs?.class?.split(/\s+/).includes('twitter-tweet'));
  const paragraph = quote && findNode(quote.children, node => node.name === 'p');
  const text = paragraph ? cleanText(plainText(paragraph)) : '';
  if (!text) throw unreadablePost();
  if (text.length > MAX_REFERENCE_LENGTH) throw new XReferenceError(422, 'post_too_long', 'This post exceeds the 60,000-character reference limit. Open the original and paste the passage you want to discuss.');
  // X's long-post fallback ends the prose with an ellipsis followed by its
  // short links. This is only a suspicion: an author can type an ellipsis too.
  const textStatus = /(?:…|\.{3})(?:\s+(?:https?:\/\/\S+|pic\.(?:twitter|x)\.com\/\S+))*\s*$/.test(text) ? 'possibly_truncated' : 'unverified';
  return {
    url: `https://x.com/${authorHandle}/status/${requested.postId}`,
    postId: requested.postId,
    authorName: cleanText(payload.author_name),
    authorHandle,
    text,
    source: 'x',
    textStatus,
    fetchedAt: new Date(now).toISOString(),
    note: textStatus === 'possibly_truncated' ? SHORTENED_NOTE : EXCERPT_NOTE,
  };
}

function unwrapStaticObject(node) {
  // TanStack's public-page serializer writes `$R[42] = { ... }`. Inspect its
  // syntax only. Never execute scripts, evaluate functions, or resolve globals.
  while (node?.type === 'AssignmentExpression' && node.operator === '=' && node.left?.type === 'MemberExpression' && node.left.computed && node.left.object?.type === 'Identifier' && node.left.object.name === '$R' && node.left.property?.type === 'Literal' && Number.isInteger(node.left.property.value)) node = node.right;
  return node?.type === 'ObjectExpression' ? node : null;
}

function staticProperty(object, name) {
  const unwrapped = unwrapStaticObject(object);
  if (!unwrapped) return null;
  const found = unwrapped.properties.filter(property => property.type === 'Property' && !property.computed && property.kind === 'init' && (property.key.type === 'Identifier' ? property.key.name : property.key.value) === name);
  return found.length === 1 ? found[0].value : null;
}

const staticString = node => node?.type === 'Literal' && typeof node.value === 'string' ? node.value : null;

/** Find an explicit full NoteTweet for this exact post and author, without eval. */
export function parseXPublicPage(html, reference) {
  if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > MAX_RESPONSE_BYTES) return null;
  const document = parseDocument(html, { decodeEntities: true });
  const domStack = [...document.children];
  const candidates = new Set();
  while (domStack.length) {
    const node = domStack.pop();
    if (node.name !== 'script') { domStack.push(...node.children ?? []); continue; }
    const script = (node.children ?? []).filter(child => child.type === 'text').map(child => child.data).join('');
    if (!script.includes('note_tweet') || !script.includes(reference.postId)) continue;
    let syntax;
    try { syntax = parseJavaScript(script, { ecmaVersion: 'latest', sourceType: 'script' }); } catch { continue; }
    const stack = [syntax];
    let visited = 0;
    while (stack.length && ++visited < 100_000) {
      const current = stack.pop();
      if (current.type === 'ObjectExpression' && staticString(staticProperty(current, '__typename')) === 'Tweet' && staticString(staticProperty(current, 'rest_id')) === reference.postId) {
        const core = staticProperty(current, 'core');
        const author = staticProperty(staticProperty(staticProperty(core, 'user_results'), 'result'), 'core');
        const handle = staticString(staticProperty(author, 'screen_name'));
        const note = staticProperty(staticProperty(staticProperty(current, 'note_tweet'), 'note_tweet_results'), 'result');
        const text = staticString(staticProperty(note, 'text'));
        if (handle?.toLowerCase() === reference.authorHandle.toLowerCase() && staticString(staticProperty(note, '__typename')) === 'NoteTweet' && text?.trim()) candidates.add(cleanText(text));
      }
      for (const value of Object.values(current)) {
        if (Array.isArray(value)) for (const item of value) { if (item && typeof item.type === 'string') stack.push(item); }
        else if (value && typeof value.type === 'string') stack.push(value);
      }
    }
  }
  // Conflicting versions or ambiguous parse results stay an explicitly marked
  // excerpt. Exact ID and author must agree; quoted tweets and replies cannot win.
  if (candidates.size !== 1) return null;
  const [text] = candidates;
  if (text.length > MAX_REFERENCE_LENGTH) throw new XReferenceError(422, 'post_too_long', 'This post exceeds the 60,000-character reference limit. Open the original and paste the passage you want to discuss.');
  return { ...reference, text, textStatus: 'full_text', note: 'Full post text from X’s public page. Media and quoted posts are not included.' };
}

async function readBoundedText(response) {
  const declaredLength = Number(response.headers.get('content-length'));
  if (declaredLength > MAX_RESPONSE_BYTES || !response.body) throw unreadablePost();
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0;
  let text = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_RESPONSE_BYTES) throw unreadablePost();
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

async function readBoundedJson(response) {
  const text = await readBoundedText(response);
  try { return JSON.parse(text); } catch { throw unreadablePost(); }
}

async function tryFullPublicPost(reference, { fetchImpl, signal, timeoutMs }) {
  const controller = new AbortController();
  let resolveAbort;
  const aborted = new Promise(resolve => { resolveAbort = resolve; });
  const cancel = () => { controller.abort(); resolveAbort(null); };
  signal.addEventListener('abort', cancel, { once: true });
  if (signal.aborted) cancel();
  let timer;
  const timeout = new Promise(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); });
  try {
    const load = async () => {
      if (controller.signal.aborted) return null;
      const response = await fetchImpl(reference.url, { method: 'GET', redirect: 'error', credentials: 'omit', headers: { Accept: 'text/html' }, signal: controller.signal });
      if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return null;
      return parseXPublicPage(await readBoundedText(response), reference);
    };
    return await Promise.race([load(), timeout, aborted]);
  } catch (error) {
    if (error instanceof XReferenceError && error.code === 'post_too_long') throw error;
    return null;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener('abort', cancel);
    controller.abort();
  }
}

/** Official oEmbed plus the same public post's full NoteTweet, with no cookies or redirects. */
export async function lookupXPost(value, { fetchImpl = globalThis.fetch, timeoutMs = 15_000, pageTimeoutMs = 8_000, signal, now = Date.now } = {}) {
  const requested = parseXPostUrl(value);
  const endpoint = new URL(OEMBED_ENDPOINT);
  endpoint.search = new URLSearchParams({ url: requested.url, omit_script: 'true', dnt: 'true', hide_thread: 'true' }).toString();
  const controller = new AbortController();
  let timer;
  let rejectAbort;
  const aborted = new Promise((_, reject) => { rejectAbort = reject; });
  const cancel = () => {
    controller.abort();
    rejectAbort(new XReferenceError(499, 'cancelled', 'Post lookup cancelled.'));
  };
  signal?.addEventListener('abort', cancel, { once: true });
  if (signal?.aborted) cancel();
  timer = setTimeout(() => {
    controller.abort();
    rejectAbort(new XReferenceError(504, 'timeout', 'X took too long to respond. Try again, or paste the post text here.'));
  }, Math.min(Math.max(timeoutMs, 1), 15_000));
  try {
    const operation = async () => {
      if (controller.signal.aborted) throw new XReferenceError(499, 'cancelled', 'Post lookup cancelled.');
      const response = await fetchImpl(endpoint.href, {
        method: 'GET',
        redirect: 'error',
        credentials: 'omit',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      if ([401, 403, 404, 410].includes(response.status)) throw new XReferenceError(422, 'unavailable_post', 'This post is unavailable to X embeds. It may be private or deleted. Open it on X and paste the text you can access.');
      if (response.status === 429) throw new XReferenceError(429, 'x_rate_limit', 'X is limiting post lookups. Wait a moment, or paste the post text here.');
      if (!response.ok) throw new XReferenceError(502, 'x_unavailable', 'X could not load this post right now. Try again, or paste its text here.');
      const reference = parseXEmbed(await readBoundedJson(response), requested, now());
      if (reference.textStatus !== 'possibly_truncated') return reference;
      return await tryFullPublicPost(reference, { fetchImpl, signal: controller.signal, timeoutMs: Math.min(Math.max(pageTimeoutMs, 1), 8_000) }) ?? reference;
    };
    return await Promise.race([operation(), aborted]);
  } catch (error) {
    if (error instanceof XReferenceError) throw error;
    throw new XReferenceError(502, 'x_unavailable', 'Could not reach X. Check your connection, or paste the post text here.');
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', cancel);
    controller.abort();
  }
}


export function createXPostRouter({ fetchImpl = globalThis.fetch, timeoutMs = 15_000, cacheTtlMs = 5 * 60_000, cacheSize = 50, maxConcurrent = 3, rateLimit = 30, rateWindowMs = 60_000, now = Date.now } = {}) {
  const router = express.Router();
  const cache = new Map();
  let inflight = 0;
  let requestTimes = [];
  router.use(localRequestOnly);
  router.use((_req, res, next) => {
    res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    next();
  });
  router.use(express.json({ limit: '4kb', strict: true, inflate: false }));
  router.post('/reference', async (req, res) => {
    let acquired = false;
    const controller = new AbortController();
    const onClose = () => { if (!res.writableEnded) controller.abort(); };
    res.on('close', onClose);
    try {
      const parsed = parseXPostUrl(req.body?.url);
      const timestamp = now();
      for (const [key, entry] of cache) if (timestamp >= entry.expiresAt) cache.delete(key);
      const cached = cache.get(parsed.postId);
      if (cached) return res.json(cached.value);
      requestTimes = requestTimes.filter(time => timestamp - time < rateWindowMs);
      if (requestTimes.length >= rateLimit || inflight >= maxConcurrent) throw new XReferenceError(429, 'local_rate_limit', 'Too many post lookups at once. Wait a moment and try again.');
      requestTimes.push(timestamp);
      inflight += 1;
      acquired = true;
      const value = await lookupXPost(parsed.url, { fetchImpl, timeoutMs, now, signal: controller.signal });
      // A partial result must remain retryable immediately: a slow public page
      // should not strand the user with a cached shortened embed for minutes.
      if (value.textStatus !== 'possibly_truncated' && cacheSize > 0 && cacheTtlMs > 0) {
        while (cache.size >= cacheSize) cache.delete(cache.keys().next().value);
        cache.set(parsed.postId, { value, expiresAt: now() + cacheTtlMs });
      }
      if (!res.destroyed) res.json(value);
    } catch (error) {
      if (!res.destroyed) {
        const safe = error instanceof XReferenceError ? error : unreadablePost();
        res.status(safe.status).json({ error: safe.message, code: safe.code });
      }
    } finally {
      if (acquired) inflight -= 1;
      res.off('close', onClose);
      controller.abort();
    }
  });
  router.use((error, _req, res, next) => {
    if (res.headersSent) return next(error);
    if (error.type === 'entity.too.large') return res.status(413).json({ error: 'This link request is too large.' });
    if (error.type === 'encoding.unsupported') return res.status(415).json({ error: 'Send uncompressed JSON for this request.' });
    res.status(400).json({ error: 'Send a JSON object containing the post URL.' });
  });
  return router;
}
