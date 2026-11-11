import assert from 'node:assert/strict';
import test from 'node:test';
import { AILifecycle } from '../src/ai-lifecycle.ts';

test('new detection cancels its predecessor and rejects late completion', () => {
  const machine = new AILifecycle();
  const old = machine.begin('detecting');
  const latest = machine.begin('detecting');
  assert.equal(old.controller.signal.aborted, true);
  assert.equal(machine.owns(old), false);
  assert.equal(machine.finish(old), false);
  assert.equal(machine.phase, 'detecting');
  assert.equal(machine.finish(latest), true);
  assert.equal(machine.phase, 'idle');
});

test('generation replaces detection and ignores repeated run or detect actions', () => {
  const machine = new AILifecycle();
  const detection = machine.begin('detecting');
  const generation = machine.begin('generating');
  assert.equal(detection.controller.signal.aborted, true);
  assert.equal(machine.begin('generating'), null);
  assert.equal(machine.begin('detecting'), null);
  assert.equal(machine.cancel('detecting'), false);
  assert.equal(machine.owns(generation), true);
  assert.equal(machine.finish(detection), false);
  assert.equal(machine.phase, 'generating');
});

test('Stop releases editing immediately and an old finally cannot finish the next run', () => {
  const machine = new AILifecycle();
  const old = machine.begin('generating');
  assert.equal(machine.cancel('generating'), true);
  assert.equal(machine.phase, 'idle');
  assert.equal(machine.cancel('generating'), false);
  const latest = machine.begin('generating');
  assert.equal(machine.finish(old), false);
  assert.equal(machine.owns(old), false);
  assert.equal(machine.phase, 'generating');
  assert.equal(machine.owns(latest), true);
});

test('navigation, undo, and unmount cancellation revoke ownership before abort listeners run', () => {
  for (const phase of ['detecting', 'generating']) {
    const machine = new AILifecycle();
    const request = machine.begin(phase);
    let observed;
    request.controller.signal.addEventListener('abort', () => {
      observed = [machine.phase, machine.owns(request)];
    });
    machine.cancel();
    assert.deepEqual(observed, ['idle', false]);
    assert.equal(machine.finish(request), false);
  }
});

test('a request cannot complete twice or cancel a later owner', () => {
  const machine = new AILifecycle();
  const completed = machine.begin('generating');
  assert.equal(machine.finish(completed), true);
  const next = machine.begin('detecting');
  assert.equal(machine.finish(completed), false);
  assert.equal(machine.owns(next), true);
});
