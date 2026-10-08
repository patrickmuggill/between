import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import test from 'node:test';
import express from 'express';
import { buildDecisionRequest, createApiRouter, parseDecision, readSseData } from '../server/api.mjs';

const FAKE_KEY = 'test-only-private-key';
const decision = (choice = 'prompting', confidence = 0.98, rewrite = 0.02) => ({
  answers: [
    { type: 'choice', name: 'intent', choice, confidence },
    { type: 'predicate', name: 'rewrite', probability: rewrite },
  ],
});
const json = value => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
const event = value => `data: ${JSON.stringify(value)}\n\n`;
const completed = { type: 'response.completed', response: { status: 'completed', output: [] } };

function streamResponse(content, chunkSize = 19) {
  const bytes = new TextEncoder().encode(content);
  let offset = 0;
  return new Response(new ReadableStream({
    pull(controller) {
      if (offset >= bytes.length) return controller.close();
      controller.enqueue(bytes.slice(offset, offset += chunkSize));
    },
  }), { headers: { 'Content-Type': 'text/event-stream' } });
}

async function fixture(t, options = {}) {
  const calls = [];
  const app = express();
  app.use('/api', createApiRouter({
    apiKey: FAKE_KEY,
    fetchImpl: async (...args) => { calls.push(args); return json(decision()); },
    ...options,
  }));
  const server = app.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path = '/decide', body = { text: 'Write a short ending.', context: 'A story.' }, init = {}) => fetch(`${base}/api${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...init.headers },
    body: JSON.stringify(body),
    ...init,
  });
  return { base, post, calls };
}

async function readEvents(response) {
  const events = [];
  for await (const data of readSseData(response.body)) events.push(JSON.parse(data));
  return events;
}

test('decision contract uses documented choice and predicate questions with quoted evidence', () => {
  const payload = buildDecisionRequest('Make "fast" bold.', 'It is fast.');
  assert.equal(payload.model, 'gpt-6-luna');
  assert.deepEqual(JSON.parse(payload.input), { document: 'It is fast.', active_paragraph: 'Make "fast" bold.' });
  assert.equal(payload.questions[0].type, 'choice');
  assert.deepEqual(payload.questions[0].choices.map(item => item.value), ['writing', 'prompting', 'uncertain']);
  assert.equal(payload.questions[1].type, 'predicate');
});

test('low confidence, missing context, and prose do not request a rewrite', () => {
  assert.deepEqual(parseDecision(decision('prompting', 0.69, 0.99), true), { intent: 'uncertain', confidence: 0.69, action: 'insert' });
  assert.equal(parseDecision(decision('prompting', 0.99, 0.99), false).action, 'insert');
  assert.equal(parseDecision(decision('writing', 0.99, 0.99), true).action, 'insert');
  assert.equal(parseDecision(decision('prompting', 0.99, 0.84), true).action, 'insert');
  assert.equal(parseDecision(decision('prompting', 0.99, 0.99), true).action, 'rewrite');
});

test('refusal and malformed decisions produce explicit errors rather than guesses', () => {
  assert.throws(() => parseDecision({ answers: [{ name: 'intent', type: 'refusal' }] }), /could not classify/);
  for (const payload of [null, {}, { answers: [] }, decision('invented'), decision('prompting', '1'), decision('writing', 1.2), decision('prompting', 0.9, -1)]) {
    assert.throws(() => parseDecision(payload), /unreadable decision/);
  }
});

test('health exposes configuration status and model names, never credentials', async t => {
  const { base } = await fixture(t);
  const response = await fetch(`${base}/api/health`);
  assert.deepEqual(await response.json(), { configured: true, decisionModel: 'gpt-6-luna', generationModel: 'gpt-6-luna' });
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('decide calls the actual API route and returns the narrow public contract', async t => {
  const { post, calls } = await fixture(t);
  const response = await post();
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.deepEqual(Object.keys(body).sort(), ['action', 'confidence', 'intent', 'latencyMs', 'model']);
  assert.equal(body.intent, 'prompting');
  assert.equal(body.model, 'gpt-6-luna');
  assert.equal(typeof body.latencyMs, 'number');
  assert.equal(calls[0][0], 'https://api.openai.com/v1/decisions');
  assert.equal(calls[0][1].headers.Authorization, `Bearer ${FAKE_KEY}`);
  assert.equal(calls[0][1].signal instanceof AbortSignal, true);
});

test('the same local origin is allowed', async t => {
  const { post, base } = await fixture(t);
  const response = await post('/decide', { text: 'Write a line.' }, { headers: { 'Content-Type': 'application/json', Origin: base, 'Sec-Fetch-Site': 'same-origin' } });
  assert.equal(response.status, 200);
});

test('cross-origin requests, opaque origins, and rebinding hosts are blocked before the API', async t => {
  const { post, calls, base } = await fixture(t);
  for (const headers of [
    { Origin: 'https://attacker.invalid' },
    { Origin: 'null' },
    { Origin: 'http://localhost:9999' },
    { 'Sec-Fetch-Site': 'cross-site' },
  ]) {
    const response = await post('/decide', { text: 'Write a line.' }, { headers: { 'Content-Type': 'application/json', ...headers } });
    assert.equal(response.status, 403, JSON.stringify(headers));
  }
  // Node fetch normalizes Host; use HTTP directly to exercise DNS-rebinding protection.
  for (const host of ['attacker.invalid', 'localhost@attacker.invalid']) {
    const status = await new Promise((resolve, reject) => {
      const request = httpRequest(`${base}/api/decide`, { method: 'POST', headers: { Host: host, 'Content-Type': 'application/json' } }, response => {
        response.resume();
        resolve(response.statusCode);
      });
      request.on('error', reject);
      request.end(JSON.stringify({ text: 'Write a line.' }));
    });
    assert.equal(status, 403, host);
  }
  assert.equal(calls.length, 0);
});

test('form/text submissions cannot spend the local API key', async t => {
  const { post, calls } = await fixture(t);
  for (const contentType of ['text/plain', 'application/x-www-form-urlencoded', 'multipart/form-data']) {
    const response = await post('/decide', { text: 'Write a line.' }, { headers: { 'Content-Type': contentType } });
    assert.equal(response.status, 415);
  }
  assert.equal(calls.length, 0);
});

test('input validation enforces text, context, action, and request-size limits', async t => {
  const { post, calls, base } = await fixture(t);
  for (const body of [{}, { text: 2 }, { text: '  ' }, { text: 'a'.repeat(6_001) }, { text: 'hi', context: {} }, { text: 'hi', context: 'a'.repeat(24_001) }, []]) {
    assert.equal((await post('/decide', body)).status, 400);
  }
  for (const body of [{ prompt: 'Write.', action: 'delete' }, { prompt: 'Revise.', action: 'rewrite', context: '' }, { prompt: 'Write.' }]) {
    assert.equal((await post('/generate', body)).status, 400);
  }
  const malformed = await fetch(`${base}/api/decide`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{private-unparseable' });
  assert.equal(malformed.status, 400);
  assert.doesNotMatch(await malformed.text(), /private-unparseable|SyntaxError|stack/);
  const tooLarge = await post('/decide', { text: 'x'.repeat(600_000) });
  assert.equal(tooLarge.status, 413);
  assert.equal(calls.length, 0);
});

test('a missing key leaves health available and provides an actionable error', async t => {
  const { post, base, calls } = await fixture(t, { apiKey: '' });
  assert.equal((await (await fetch(`${base}/api/health`)).json()).configured, false);
  const response = await post();
  assert.equal(response.status, 503);
  assert.match((await response.json()).error, /OPENAI_API_KEY.*\.env\.local/);
  assert.equal(calls.length, 0);
});

test('upstream HTTP failures are translated without returning private response bodies', async t => {
  for (const [status, expected] of [[401, 503], [403, 503], [404, 503], [429, 429], [400, 502], [500, 502]]) {
    await t.test(String(status), async t => {
      const { post } = await fixture(t, { fetchImpl: async () => new Response(`Do not leak ${FAKE_KEY}`, { status }) });
      const response = await post();
      assert.equal(response.status, expected);
      assert.doesNotMatch(await response.text(), /Do not leak|test-only-private-key/);
    });
  }
});

test('decision refusals and invalid upstream JSON are surfaced safely', async t => {
  const { post } = await fixture(t, { fetchImpl: async () => json({ answers: [{ name: 'intent', type: 'refusal' }] }) });
  assert.equal((await post()).status, 422);
  const invalid = await fixture(t, { fetchImpl: async () => new Response('secret invalid json') });
  const response = await invalid.post();
  assert.equal(response.status, 502);
  assert.doesNotMatch(await response.text(), /secret invalid json/);
});

test('quota failures produce an actionable billing message for Decisions and streaming Responses', async t => {
  const quotaError = { type: 'insufficient_quota', message: FAKE_KEY };
  const { post } = await fixture(t, { fetchImpl: async () => new Response(JSON.stringify({ error: quotaError }), { status: 429 }) });
  const response = await post();
  assert.equal(response.status, 429);
  const payload = await response.json();
  assert.match(payload.error, /API billing or credits/);
  assert.doesNotMatch(payload.error, /test-only-private-key/);
  const streaming = await fixture(t, { fetchImpl: async () => streamResponse(event({ type: 'error', error: quotaError })) });
  const events = await readEvents(await streaming.post('/generate', { prompt: 'Write.', action: 'insert' }));
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).error, /API billing or credits/);
  assert.doesNotMatch(JSON.stringify(events), /test-only-private-key/);
});

test('decision timeout aborts the upstream request and returns 504', async t => {
  let aborted = false;
  const { post } = await fixture(t, {
    decisionTimeoutMs: 15,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => { aborted = true; reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    }),
  });
  const response = await post();
  assert.equal(response.status, 504);
  assert.equal(aborted, true);
});

test('local request rate is bounded', async t => {
  const { post, calls } = await fixture(t, { rateLimit: 2 });
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 200);
  assert.equal((await post()).status, 429);
  assert.equal(calls.length, 2);
});

test('inflight requests are bounded and browser disconnect aborts upstream work', async t => {
  const entered = Promise.withResolvers();
  const aborted = Promise.withResolvers();
  const { post } = await fixture(t, {
    maxConcurrent: 1,
    fetchImpl: (url, { signal }) => new Promise((resolve, reject) => {
      entered.resolve();
      signal.addEventListener('abort', () => { aborted.resolve(); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
    }),
  });
  const controller = new AbortController();
  const pending = post('/decide', { text: 'Write a line.' }, { signal: controller.signal }).catch(error => error);
  await entered.promise;
  assert.equal((await post()).status, 429);
  controller.abort();
  await aborted.promise;
  assert.equal((await pending).name, 'AbortError');
});

test('SSE parser preserves Unicode split across bytes, CRLF, and multi-line events', async () => {
  const response = streamResponse(': heartbeat\r\ndata: {"text":\r\ndata: "café ☀️"}\r\n\r\ndata: last', 1);
  const events = [];
  for await (const value of readSseData(response.body)) events.push(value);
  assert.deepEqual(events, ['{"text":\n"café ☀️"}', 'last']);
});

test('generation streams only text and a verified completion, uses Responses with store false', async t => {
  let sent;
  const { post } = await fixture(t, {
    fetchImpl: async (url, init) => {
      sent = { url, body: JSON.parse(init.body) };
      return streamResponse(event({ type: 'response.created' }) + event({ type: 'response.output_text.delta', delta: '**café** ' }) + event({ type: 'response.output_text.delta', delta: '☀️' }) + event(completed), 1);
    },
  });
  const response = await post('/generate', { prompt: 'Make café bold.', context: 'café ☀️', action: 'rewrite' });
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/event-stream/);
  const events = await readEvents(response);
  assert.deepEqual(events.slice(0, 2), [{ type: 'delta', text: '**café** ' }, { type: 'delta', text: '☀️' }]);
  assert.equal(events[2].type, 'done');
  assert.equal(events[2].model, 'gpt-6-luna');
  assert.equal(typeof events[2].latencyMs, 'number');
  assert.equal(sent.url, 'https://api.openai.com/v1/responses');
  assert.equal(sent.body.store, false);
  assert.equal(sent.body.stream, true);
  assert.match(sent.body.instructions, /complete revised document/);
  assert.match(sent.body.instructions, /Markdown/);
  assert.deepEqual(JSON.parse(sent.body.input[0].content), { document: 'café ☀️', instruction: 'Make café bold.' });
});

test('generation inserts new content without requesting the whole document', async t => {
  let instructions;
  const { post } = await fixture(t, { fetchImpl: async (url, init) => {
    instructions = JSON.parse(init.body).instructions;
    return streamResponse(event({ type: 'response.output_text.delta', delta: 'A new line.' }) + event(completed));
  } });
  const response = await post('/generate', { prompt: 'Add a line.', context: 'A draft.', action: 'insert' });
  assert.equal((await readEvents(response)).at(-1).type, 'done');
  assert.match(instructions, /only the new text/);
});

test('stream errors, refusals, truncated streams, malformed data, and empty drafts never report done', async t => {
  const cases = [
    ['refusal', event({ type: 'response.refusal.delta', delta: 'Private refusal reason' }) + event(completed)],
    ['completed refusal', event({ type: 'response.completed', response: { output: [{ content: [{ type: 'refusal', refusal: 'Private reason' }] }] } })],
    ['upstream error', event({ type: 'error', message: FAKE_KEY })],
    ['failed', event({ type: 'response.failed', response: { error: { message: FAKE_KEY } } })],
    ['incomplete', event({ type: 'response.incomplete' })],
    ['truncated', event({ type: 'response.output_text.delta', delta: 'Part' })],
    ['bare done', 'data: [DONE]\n\n'],
    ['malformed', 'data: private invalid json\n\n'],
    ['wrong delta type', event({ type: 'response.output_text.delta', delta: 5 })],
    ['empty', event(completed)],
  ];
  for (const [name, content] of cases) {
    await t.test(name, async t => {
      const { post } = await fixture(t, { fetchImpl: async () => streamResponse(content) });
      const response = await post('/generate', { prompt: 'Write.', context: '', action: 'insert' });
      const events = await readEvents(response);
      assert.equal(events.at(-1).type, 'error');
      assert.equal(events.some(item => item.type === 'done'), false);
      assert.doesNotMatch(JSON.stringify(events), /test-only-private-key|private invalid json|Private refusal reason|Private reason/);
    });
  }
});

test('a generation stream timeout emits a terminal error, never completion', async t => {
  const { post } = await fixture(t, {
    generationTimeoutMs: 20,
    fetchImpl: async (url, { signal }) => new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode(event({ type: 'response.output_text.delta', delta: 'Partial draft' })));
        signal.addEventListener('abort', () => controller.error(new DOMException('Aborted', 'AbortError')), { once: true });
      },
    })),
  });
  const response = await post('/generate', { prompt: 'Write.', action: 'insert' });
  const events = await readEvents(response);
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).error, /too long/);
  assert.equal(events.some(item => item.type === 'done'), false);
});

test('OpenAI requests refuse redirects and never attach browser cookies', async t => {
  const { post, calls } = await fixture(t);
  assert.equal((await post()).status, 200);
  assert.equal(calls[0][1].redirect, 'error');
  assert.equal(calls[0][1].credentials, 'omit');
});

test('decision JSON and upstream error bodies have strict byte bounds', async t => {
  for (const upstream of [
    new Response('x'.repeat(65_537)),
    new Response('{}', { headers: { 'Content-Length': '99999999' } }),
    new Response('x'.repeat(20_000) + FAKE_KEY, { status: 500 }),
  ]) {
    const { post } = await fixture(t, { fetchImpl: async () => upstream });
    const response = await post();
    assert.equal(response.status, 502);
    assert.doesNotMatch(await response.text(), /test-only-private-key|xxxxx/);
  }
});

test('a non-cooperative fetch deadline releases capacity for the next request', async t => {
  let calls = 0;
  const { post } = await fixture(t, { decisionTimeoutMs: 15, maxConcurrent: 1, fetchImpl: () => ++calls === 1 ? new Promise(() => {}) : Promise.resolve(json(decision())) });
  assert.equal((await post()).status, 504);
  assert.equal((await post()).status, 200);
});

test('a stalled decision body deadline cancels its reader and releases capacity', async t => {
  let cancelled = false;
  let calls = 0;
  const { post } = await fixture(t, { decisionTimeoutMs: 15, maxConcurrent: 1, fetchImpl: async () => ++calls === 1 ? new Response(new ReadableStream({ cancel() { cancelled = true; } })) : json(decision()) });
  assert.equal((await post()).status, 504);
  assert.equal(cancelled, true);
  assert.equal((await post()).status, 200);
});

test('SSE caps total transport bytes and event counts, including non-output events', async () => {
  for (const [body, options, pattern] of [
    [':'.repeat(101), { maxBytes: 100 }, /oversized response stream/],
    ['data: {}\n\n'.repeat(3), { maxEvents: 2 }, /too many stream events/],
  ]) {
    await assert.rejects(async () => {
      for await (const _event of readSseData(streamResponse(body).body, options)) { /* consume */ }
    }, pattern);
  }
});

test('generation deadline handles an uncooperative body and never reports completion', async t => {
  let cancelled = false;
  const { post } = await fixture(t, { generationTimeoutMs: 15, fetchImpl: async () => new Response(new ReadableStream({
    start(controller) { controller.enqueue(new TextEncoder().encode(event({ type: 'response.output_text.delta', delta: 'Partial draft' }))); },
    cancel() { cancelled = true; },
  })) });
  const response = await post('/generate', { prompt: 'Write.', action: 'insert' });
  assert.equal(response.headers.get('cache-control'), 'no-store, no-transform');
  const events = await readEvents(response);
  assert.equal(events.at(-1).type, 'error');
  assert.match(events.at(-1).error, /too long/);
  assert.equal(cancelled, true);
  assert.equal(events.some(item => item.type === 'done'), false);
});

test('compressed request bodies are rejected before parsing or outbound calls', async t => {
  const { post, calls } = await fixture(t);
  const response = await post('/decide', { text: 'Write.' }, { headers: { 'Content-Type': 'application/json', 'Content-Encoding': 'gzip' } });
  assert.equal(response.status, 415);
  assert.equal(calls.length, 0);
});
