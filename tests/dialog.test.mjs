import assert from 'node:assert/strict';
import test from 'node:test';
import { isBackdropClick } from '../src/dialog.ts';

const dialog = { getBoundingClientRect: () => ({ left: 100, right: 500, top: 80, bottom: 600 }) };
const click = (clientX, clientY, extra = {}) => ({ target: dialog, currentTarget: dialog, clientX, clientY, detail: 1, ...extra });

test('dialog padding, content, and border clicks do not dismiss a modal', () => {
  for (const point of [[101, 81], [300, 400], [100, 80], [500, 600]])
    assert.equal(isBackdropClick(click(...point)), false);
  assert.equal(isBackdropClick(click(0, 0, { target: {} })), false);
});

test('only actual pointer clicks outside the dialog dismiss it', () => {
  for (const point of [[99, 400], [501, 400], [300, 79], [300, 601]])
    assert.equal(isBackdropClick(click(...point)), true);
  assert.equal(isBackdropClick(click(0, 0, { detail: 0 })), false);
});
