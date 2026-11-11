import assert from 'node:assert/strict';
import test from 'node:test';
import { loadDocumentState, saveDocuments, STORAGE_KEY, ACTIVE_KEY } from '../src/document.ts';

const draft = (id = 'synthetic-draft') => ({ id, title: 'Synthetic draft', updated: 1, mode: 'x', content: {
  type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Keep these synthetic words.' }] }],
} });
function storage(raw, extra = {}) {
  const values = new Map(Object.entries(extra));
  if (raw !== undefined) values.set(STORAGE_KEY, raw);
  const writes = [];
  return { values, writes, getItem: key => values.get(key) ?? null,
    setItem(key, value) { writes.push(key); values.set(key, value); } };
}

test('valid collections and first use need no backup and preserve draft contents', () => {
  for (const raw of [undefined, '[]', JSON.stringify([draft()])]) {
    const store = storage(raw);
    const load = loadDocumentState(store);
    assert.equal(load.recovery, null);
    assert.equal(load.writeBlocked, false);
    assert.deepEqual(store.writes, []);
    if (raw?.includes('synthetic-draft')) assert.deepEqual(load.documents[0].content, draft().content);
  }
});

for (const [name, bad] of [
  ['null record', null], ['invalid shape', { id: 'bad' }],
  ['invalid schema node', { ...draft('bad'), content: { type: 'doc', content: [{ type: 'unknown_node' }] } }],
  ['duplicate identifier', { ...draft(), title: 'Distinct rejected content' }],
]) test(`recovers valid drafts alongside ${name}, preserving exact original before autosave`, () => {
  const raw = JSON.stringify([draft(), bad, draft('another-valid')]);
  const store = storage(raw);
  const load = loadDocumentState(store);
  assert.deepEqual(load.documents.map(d => d.id), ['synthetic-draft', 'another-valid']);
  assert.equal(store.values.get(load.recovery.backupKey), raw);
  assert.equal(store.values.get(STORAGE_KEY), raw);
  assert.equal(load.recovery.raw, raw);
  assert.equal(load.writeBlocked, false);
  saveDocuments(store, load, load.documents, load.documents[0].id);
  assert.equal(store.writes[0], load.recovery.backupKey);
  assert.equal(store.values.get(load.recovery.backupKey), raw);
  assert.equal(JSON.parse(store.values.get(STORAGE_KEY)).length, 2);
});

test('malformed JSON, invalid collection and all-invalid drafts are backed up before blank fallback can save', () => {
  for (const raw of ['{ broken synthetic JSON', 'null', '{}', '[null,{}]']) {
    const store = storage(raw);
    const load = loadDocumentState(store);
    assert.equal(load.documents[0].id, 'first-page');
    assert.equal(store.values.get(load.recovery.backupKey), raw);
    assert.equal(store.values.get(STORAGE_KEY), raw);
    saveDocuments(store, load, load.documents, 'first-page');
    assert.equal(store.values.get(load.recovery.backupKey), raw);
  }
});

test('distinct backups are retained and identical initialization reuses its existing backup', () => {
  const prefix = `${STORAGE_KEY}.recovery`;
  const store = storage('[null]', { [prefix]: 'earlier original', [`${prefix}.1`]: 'another original' });
  const first = loadDocumentState(store);
  const second = loadDocumentState(store);
  assert.equal(first.recovery.backupKey, `${prefix}.2`);
  assert.equal(second.recovery.backupKey, first.recovery.backupKey);
  assert.deepEqual(store.writes, [`${prefix}.2`]);
  assert.equal(store.values.get(prefix), 'earlier original');
  assert.equal(store.values.get(`${prefix}.1`), 'another original');
});

test('backup failure blocks both collection and active-ID writes but retains download bytes', () => {
  const raw = JSON.stringify([draft(), null]);
  const store = storage(raw);
  store.setItem = () => { throw new Error('Synthetic quota failure'); };
  const load = loadDocumentState(store);
  assert.equal(load.writeBlocked, true);
  assert.equal(load.recovery.raw, raw);
  assert.equal(load.documents[0].id, draft().id);
  // Even if storage becomes writable later, this session must not bypass protection.
  store.setItem = (key, value) => { store.writes.push(key); store.values.set(key, value); };
  assert.throws(() => saveDocuments(store, load, [draft('new')], 'new'));
  assert.deepEqual(store.writes, []);
  assert.equal(store.values.get(STORAGE_KEY), raw);
  assert.equal(store.values.has(ACTIVE_KEY), false);
});

test('unreadable storage also blocks canonical writes without pretending data is missing', () => {
  const store = { getItem() { throw new Error('Synthetic access denied'); }, setItem() { assert.fail('Must not write'); } };
  const load = loadDocumentState(store);
  assert.equal(load.recovery.raw, null);
  assert.equal(load.writeBlocked, true);
  assert.throws(() => saveDocuments(store, load, load.documents, 'first-page'));
});

test('malformed references do not hide their drafts and their original bytes are retained', () => {
  const raw = JSON.stringify([{ ...draft(), reference: { text: 'Synthetic incomplete reference' } }]);
  const store = storage(raw);
  const load = loadDocumentState(store);
  assert.deepEqual(load.documents[0].content, draft().content);
  assert.equal(load.documents[0].reference, undefined);
  assert.equal(store.values.get(load.recovery.backupKey), raw);
});
