async (page) => {
  const browser = page.context().browser();
  if (!browser) throw new Error('An isolated browser context is required.');
  const base = new URL(page.url()).origin;
  const context = await browser.newContext();
  const testPage = await context.newPage();
  const errors = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (predicate, message) => {
    const deadline = Date.now() + 7000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await testPage.waitForTimeout(25);
    }
    throw new Error(message);
  };
  testPage.on('pageerror', error => errors.push(error.message));
  // Install before application code. These deferred responses deliberately do
  // not subscribe to AbortSignal: a cancelled request remains pending until the
  // test releases it, so its catch/finally really runs during the next request.
  await context.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    const fixture = { requests: [], holdDetection: false, unexpected: [] };
    const decision = { intent: 'prompting', action: 'insert', confidence: 1, latencyMs: 1, model: 'fixture' };
    fixture.release = (index, outcome, text) => {
      const request = fixture.requests[index];
      if (!request || request.settled) throw new Error('Invalid fixture release');
      request.settled = true;
      if (outcome === 'reject') return request.reject(new Error(text));
      if (request.kind === 'decide') return request.resolve(new Response(JSON.stringify(
        outcome === 'quota' ? { error: 'Obsolete quota error' } : decision,
      ), { status: outcome === 'quota' ? 429 : 200, headers: { 'Content-Type': 'application/json' } }));
      request.resolve(new Response(
        `data: ${JSON.stringify({ type: 'delta', text })}\n\ndata: {"type":"done"}\n\n`,
        { headers: { 'Content-Type': 'text/event-stream' } },
      ));
    };
    window.__aiFixture = fixture;
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url || input, location.href);
      if (url.origin !== location.origin) {
        fixture.unexpected.push(url.href);
        return Promise.reject(new Error('Fixture blocks external fetch'));
      }
      if (!url.pathname.startsWith('/api/')) return nativeFetch(input, init);
      if (url.pathname === '/api/health') return Promise.resolve(new Response(JSON.stringify({ configured: true })));
      const kind = url.pathname.slice('/api/'.length);
      if (kind === 'decide' && !fixture.holdDetection)
        return Promise.resolve(new Response(JSON.stringify(decision)));
      if (kind !== 'generate' && kind !== 'decide') {
        fixture.unexpected.push(url.pathname);
        return Promise.reject(new Error('Unexpected fixture API'));
      }
      return new Promise((resolve, reject) => {
        fixture.requests.push({ kind, resolve, reject, signal: init?.signal, settled: false });
      });
    };
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    // No API request should escape the in-page synthetic fetch implementation.
    if (url.origin !== base || url.pathname.startsWith('/api/')) {
      errors.push(`Unexpected network request: ${url.href}`);
      return route.abort();
    }
    return route.continue();
  });
  const count = () => testPage.evaluate(() => window.__aiFixture.requests.length);
  const release = (index, outcome, text) => testPage.evaluate(
    ({ index, outcome, text }) => window.__aiFixture.release(index, outcome, text), { index, outcome, text },
  );
  const state = index => testPage.evaluate(index => {
    const request = window.__aiFixture.requests[index];
    return { settled: request.settled, aborted: request.signal.aborted };
  }, index);
  const body = testPage.getByRole('textbox', { name: 'Document body', exact: true });
  try {
    await testPage.goto(base);
    await testPage.getByRole('button', { name: 'Document', exact: true }).click();
    await testPage.getByRole('button', { name: 'Auto-detect on', exact: true }).click();
    for (const outcome of ['resolve', 'reject']) {
      const offset = await count();
      await body.fill('Write a synthetic greeting');
      await body.press('Control+Enter');
      await until(async () => await count() === offset + 1, 'First generation did not start');
      await testPage.getByRole('button', { name: /Stop/ }).click();
      assert(await body.getAttribute('contenteditable') === 'true', 'Stop did not unlock editing');
      assert((await body.innerText()).trim() === 'Write a synthetic greeting', 'Stop changed the draft');
      await body.press('Control+Enter');
      await until(async () => await count() === offset + 2, 'Immediate retry did not start');
      const obsolete = await state(offset);
      assert(obsolete.aborted && !obsolete.settled, 'Old request must still be pending after Stop and retry');
      await release(offset, outcome, 'Obsolete completion');
      await testPage.waitForTimeout(150);
      assert(await body.getAttribute('contenteditable') === 'false', 'Old cleanup unlocked the new generation');
      assert(await testPage.getByRole('button', { name: /Stop/ }).isVisible(), 'Old cleanup hid the new generation');
      assert(!(await testPage.locator('body').innerText()).includes('Obsolete completion'), 'Obsolete error or preview was shown');
      await release(offset + 1, 'resolve', 'Current completion');
      await until(async () => (await body.innerText()).includes('Current completion'), 'Current result was not applied');
      assert(!(await body.innerText()).includes('Obsolete'), 'Cancelled result was inserted');
      const toolbar = testPage.getByRole('toolbar', { name: 'Text formatting' });
      await toolbar.getByRole('button', { name: 'Undo', exact: true }).click();
      assert((await body.innerText()).trim() === 'Write a synthetic greeting', 'Undo failed to restore the original prompt');
      await toolbar.getByRole('button', { name: 'Redo', exact: true }).click();
      assert((await body.innerText()).includes('Current completion'), 'Redo failed to restore the accepted result');
    }
    const toolbar = testPage.getByRole('toolbar', { name: 'Text formatting' });
    await testPage.getByRole('button', { name: 'X post', exact: true }).click();
    assert(!(await body.innerText()).includes('Current completion'), 'Mode switch leaked document content');
    assert(await toolbar.getByRole('button', { name: 'Undo', exact: true }).isDisabled(), 'Mode switch leaked undo history');
    await testPage.getByRole('button', { name: 'Document', exact: true }).click();
    await body.fill('First synthetic paragraph');
    await body.press('Control+End');
    await body.press('Enter');
    await testPage.keyboard.type('Second synthetic paragraph');
    await testPage.evaluate(() => { window.__aiFixture.holdDetection = true; });
    await testPage.getByRole('button', { name: 'Auto-detect off', exact: true }).click();
    for (const outcome of ['resolve', 'quota']) {
      const index = await count();
      await body.press('Control+End');
      await testPage.keyboard.type('.');
      await until(async () => await count() === index + 1, 'Detection did not start');
      // Move away and back without changing the draft revision. Snapshot checks
      // alone would accept this response after the return to the same paragraph.
      await body.press('Control+Home');
      await body.press('Control+End');
      const obsolete = await state(index);
      assert(obsolete.aborted && !obsolete.settled, 'Leaving a paragraph did not revoke detection');
      await release(index, outcome, '');
      await testPage.waitForTimeout(150);
      assert(await testPage.getByRole('button', { name: /Make it happen/ }).count() === 0, 'Stale detection revived a prompt');
      assert(!(await testPage.locator('body').innerText()).includes('Obsolete quota error'), 'Stale detection displayed its error');
      assert((await testPage.getByRole('button', { name: 'OpenAI settings', exact: true }).innerText()).includes('OpenAI configured'), 'Stale detection changed connection status');
    }
    const unexpected = await testPage.evaluate(() => window.__aiFixture.unexpected);
    assert(unexpected.length === 0, unexpected.join('\n'));
    assert(errors.length === 0, errors.join('\n'));
    return { ok: true, checks: ['Stop and immediate retry', 'late cancelled completion and rejection isolation', 'cursor away/back stale detection and quota error isolation', 'single-step undo/redo', 'mode history isolation'] };
  } finally {
    await context.close();
  }
}
