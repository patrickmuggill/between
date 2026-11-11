import assert from 'node:assert/strict';
import test from 'node:test';
import { readBookmarks, writeBookmarks, BOOKMARKS_KEY } from '../src/bookmarks.ts';
const bookmark = (id = 'one') => ({ id, savedAt: 123, reference: { url: '', text: 'Synthetic reference.', authorName: 'Test author', source: 'manual' } });
function store(raw = null) { const data = new Map(raw === null ? [] : [[BOOKMARKS_KEY, raw]]); return { data, getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }; }
test('bookmarks persist without modifying draft storage', () => {
 const storage = store(); storage.data.set('between.documents.v1', 'drafts');
 const saved = writeBookmarks(storage, readBookmarks(storage), [bookmark()]);
 assert.deepEqual(readBookmarks(storage), saved);
 assert.equal(storage.data.get('between.documents.v1'), 'drafts');
});
test('link-only bookmarks and full 60,000 character references persist intact', () => {
 const storage = store(); const link = bookmark('link'); link.reference.url = 'https://x.com/example/status/12345'; link.reference.text = '';
 const full = bookmark('full'); full.reference.text = 'A'.repeat(60000);
 const saved = writeBookmarks(storage, readBookmarks(storage), [link, full]);
 assert.deepEqual(readBookmarks(storage).items, saved.items);
});
for (const [name, raw] of [
 ['invalid JSON', '{broken'], ['non-array', '{}'], ['null member', '[null]'],
 ['duplicate IDs', JSON.stringify([bookmark(), bookmark()])],
 ['unsafe URL', JSON.stringify([{ ...bookmark(), reference: { ...bookmark().reference, url: 'javascript:alert(1)' } }])],
 ['invalid author', JSON.stringify([{ ...bookmark(), reference: { ...bookmark().reference, authorName: {} } }])],
 ['invalid note', JSON.stringify([{ ...bookmark(), reference: { ...bookmark().reference, note: {} } }])],
 ['oversized text', JSON.stringify([{ ...bookmark(), reference: { ...bookmark().reference, text: 'A'.repeat(60001) } }])],
 ['empty reference', JSON.stringify([{ ...bookmark(), reference: { ...bookmark().reference, text: '' } }])],
]) test(`${name} blocks writes and preserves original bytes`, () => {
 const storage = store(raw); const load = readBookmarks(storage);
 assert.equal(load.blocked, true); assert.equal(load.raw, raw);
 assert.throws(() => writeBookmarks(storage, load, [bookmark('new')]));
 assert.equal(storage.getItem(BOOKMARKS_KEY), raw);
});
test('another tab changing bookmarks is never overwritten', () => {
 const storage = store(); const load = readBookmarks(storage);
 const other = JSON.stringify([bookmark('other')]); storage.setItem(BOOKMARKS_KEY, other);
 assert.throws(() => writeBookmarks(storage, load, [bookmark()]));
 assert.equal(storage.getItem(BOOKMARKS_KEY), other);
});
test('storage failures block reads or propagate writes', () => {
 const inaccessible = { getItem() { throw new Error('denied'); }, setItem() {} };
 assert.equal(readBookmarks(inaccessible).blocked, true);
 const quota = { getItem() { return null; }, setItem() { throw new Error('quota'); } };
 assert.throws(() => writeBookmarks(quota, readBookmarks(quota), [bookmark()]), /quota/);
});
test('remove and undo preserve exact reference content', () => {
 const storage = store(); const original = bookmark();
 let state = writeBookmarks(storage, readBookmarks(storage), [original]);
 state = writeBookmarks(storage, state, []);
 state = writeBookmarks(storage, state, [original]);
 assert.deepEqual(readBookmarks(storage).items, [original]);
});
