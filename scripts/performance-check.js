async (page) => {
  // Instrument a synthetic document in an isolated context. This checks work
  // avoided on the typing path, rather than brittle machine-speed thresholds.
  const browser = page.context().browser();
  if (!browser) throw new Error('An independent browser context is required.');
  const base = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(page.url())
    ? new URL(page.url()).origin : 'http://127.0.0.1:4173';
  const context = await browser.newContext({ reducedMotion: 'reduce' });
  const testPage = await context.newPage();
  const errors = [];
  const decisions = [];
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  testPage.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) {
      errors.push(`Unexpected external request: ${url.origin}`);
      await route.abort();
      return;
    }
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (pathname === '/api/health') {
      await route.fulfill({ json: { configured: true } });
    } else if (pathname === '/api/decide') {
      decisions.push(route.request().postDataJSON());
      await route.fulfill({ json: { intent: 'writing', action: 'insert', confidence: 0.99, latencyMs: 1, model: 'browser-mock' } });
    } else {
      errors.push(`Unexpected API call: ${pathname}`);
      await route.abort();
    }
  });
  await context.addInitScript(() => {
    const content = [{
      type: 'paragraph', content: [
        { type: 'text', text: 'Bold opening.', marks: [{ type: 'bold' }] },
        { type: 'text', text: ' A plain continuation.' },
      ],
    }, ...Array.from({ length: 120 }, (_, index) => ({
      type: 'paragraph', content: [{ type: 'text', text: `Synthetic paragraph ${index}: A thoughtful draft should stay responsive while the cursor moves through it.` }],
    }))];
    localStorage.setItem('between.documents.v1', JSON.stringify([{ id: 'performance-fixture', mode: 'x', title: 'Synthetic performance fixture', updated: 1, content: { type: 'doc', content } }]));
    localStorage.setItem('between.active.v1', 'performance-fixture');
  });
  const body = testPage.getByRole('textbox', { name: 'Document body', exact: true });
  const serializeCount = () => testPage.evaluate(() => window.__betweenSerializations);
  const resetCount = () => testPage.evaluate(() => { window.__betweenSerializations = 0; });
  try {
    await testPage.goto(base, { waitUntil: 'domcontentloaded' });
    await body.waitFor();
    await testPage.getByRole('button', { name: 'Auto-detect on', exact: true }).click();
    await testPage.evaluate(() => {
      const node = document.querySelector('.ProseMirror').pmViewDesc.node;
      const prototype = Object.getPrototypeOf(node);
      const original = prototype.toJSON;
      window.__betweenSerializations = 0;
      prototype.toJSON = function (...args) {
        if (this.type.name === 'doc') window.__betweenSerializations += 1;
        return original.apply(this, args);
      };
    });

    // Moving between differently formatted text must refresh toolbar state
    // without serializing the document for copy, word count, or AI context.
    await testPage.evaluate(() => {
      const node = document.querySelector('.ProseMirror strong').firstChild;
      const range = document.createRange();
      range.setStart(node, 2);
      range.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
      document.querySelector('.ProseMirror').focus();
    });
    await testPage.locator('button[aria-label="Bold"][aria-pressed="true"]').waitFor();
    await testPage.evaluate(() => {
      const node = document.querySelector('.ProseMirror p:last-child').firstChild;
      const range = document.createRange();
      range.setStart(node, node.textContent.length);
      range.collapse(true);
      getSelection().removeAllRanges();
      getSelection().addRange(range);
    });
    await testPage.locator('button[aria-label="Bold"][aria-pressed="false"]').waitFor();
    for (let i = 0; i < 16; i++) await body.press('ArrowLeft');
    const cursorSerializations = await serializeCount();
    assert(cursorSerializations === 0, `Cursor movement serialized the full draft ${cursorSerializations} times`);

    // Compare the exact same typing with detection off and on. Before the
    // debounce optimization, enabling detection serialized AI context twice
    // on every keystroke in X mode.
    const sample = ' Thoughtful editing';
    await body.press('End');
    await resetCount();
    await body.pressSequentially(sample, { delay: 1 });
    const writingSerializations = await serializeCount();
    await testPage.getByRole('button', { name: 'Auto-detect off', exact: true }).click();
    await body.press('End');
    await resetCount();
    await body.pressSequentially(sample, { delay: 1 });
    const detectingSerializations = await serializeCount();
    assert(decisions.length === 0, 'Detection fired before the typing pause');
    assert(detectingSerializations <= writingSerializations + 4,
      `Typing eagerly serialized AI context: off=${writingSerializations}, on=${detectingSerializations}`);
    await testPage.waitForResponse(response => response.url().endsWith('/api/decide'));
    assert(decisions.length === 1, 'Typing did not produce one debounced decision');
    assert(decisions[0].context.includes('Synthetic paragraph 0'), 'Deferred classification lost the surrounding draft');
    assert(!errors.length, `Browser errors: ${errors.join('; ')}`);
    return {
      ok: true, mocked: true, liveApiCalls: 0, userPageUnchanged: true,
      passes: [
        'cursor and formatting changes do not serialize the full document',
        'auto-detection builds long-document context once after the pause',
      ],
      measurements: { cursorSerializations, writingSerializations, detectingSerializations, decisions: decisions.length },
    };
  } finally {
    await context.close();
  }
}
