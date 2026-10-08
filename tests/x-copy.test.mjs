import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeXUrl, plainPost, composePost, postLength, composerUrl } from '../src/x-post.ts';

test('post links canonicalize known hosts and discard tracking parameters', () => {
  assert.equal(normalizeXUrl('https://twitter.com/KaAnDK/status/2107754495132184653?s=20'), 'https://x.com/KaAnDK/status/2107754495132184653');
  assert.equal(normalizeXUrl('https://x.com/i/web/status/12345'), 'https://x.com/i/web/status/12345');
  assert.throws(() => normalizeXUrl('https://x.com.evil.test/user/status/123'));
  assert.throws(() => normalizeXUrl('https://x.com:3000/user/status/123'));
  assert.throws(() => normalizeXUrl('https://x.com/user'));
});

test('plain copy preserves paragraph breaks and actual words without markdown marks', () => {
  const content = { type: 'doc', content: [
    { type: 'paragraph', content: [{ type: 'text', text: 'A real point.', marks: [{ type: 'bold' }] }] },
    { type: 'paragraph', content: [{ type: 'text', text: 'One more thought.' }] },
  ] };
  assert.equal(plainPost(content), 'A real point.\n\nOne more thought.');
});

test('plain copy preserves lists and safe link destinations', () => {
  const text = value => ({ type: 'text', text: value });
  const p = value => ({ type: 'paragraph', content: [text(value)] });
  assert.equal(plainPost({ type: 'bulletList', content: [{ type: 'listItem', content: [p('First')] }, { type: 'listItem', content: [p('Second')] }] }), '• First\n• Second');
  assert.equal(plainPost({ ...text('Report'), marks: [{ type: 'link', attrs: { href: 'https://example.com/report' } }] }), 'Report (https://example.com/report)');
  assert.equal(plainPost({ ...text('Bad'), marks: [{ type: 'link', attrs: { href: 'javascript:alert(1)' } }] }), 'Bad');
});

test('copy includes only the draft and optional source link, never an empty link-only post', () => {
  const url = 'https://x.com/user/status/123';
  assert.equal(composePost(' My own words. ', url), `My own words.\n\n${url}`);
  assert.equal(composePost('My own words.'), 'My own words.');
  assert.equal(composePost('', url), '');
  assert.equal(composePost(`My point.\n\n${url}`, url), `My point.\n\n${url}`);
});

test('standard count handles URLs, emoji, and CJK rather than JS string length', () => {
  assert.equal(postLength('hello').count, 5);
  assert.equal(postLength('https://example.com/a-very-long-link').count, 23);
  assert.equal(postLength('👨‍👩‍👧‍👦').count, 2);
  assert.equal(postLength('你好').count, 4);
  assert.equal(postLength('a'.repeat(281)).remaining, -1);
  assert.equal(postLength('a'.repeat(281)).valid, false);
});

test('X handoff is only a composer URL with exact text, never a publication request', () => {
  const text = 'My own & careful thought.\n\nhttps://x.com/user/status/123';
  const url = new URL(composerUrl(text));
  assert.equal(url.origin, 'https://x.com');
  assert.equal(url.pathname, '/intent/tweet');
  assert.equal(url.searchParams.get('text'), text);
});
