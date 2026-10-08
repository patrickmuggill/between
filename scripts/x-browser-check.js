async (page) => {
  // playwright-cli run-code --filename=scripts/x-browser-check.js
  // Synthetic fixtures only, with every API route intercepted in a new context.
  const browser = page.context().browser();
  if (!browser) throw new Error('An independent browser context is required.');
  const sourceUrl = page.url();
  const base = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(sourceUrl)
    ? new URL(sourceUrl).origin : 'http://127.0.0.1:4173';
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(15000);
  context.setDefaultNavigationTimeout(15000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const testPage = await context.newPage();
  const passes = [];
  const screenshots = [];
  const pageErrors = [];
  const releases = [];
  const requests = { health: 0, decide: [], generate: [], reference: [], unexpected: [], external: [] };
  let stage = 'setup';
  let decisionHandler = () => ({ intent: 'writing', action: 'insert' });
  let generationHandler = () => ({ text: 'Synthetic generated fixture.' });
  const reference = {
    url: 'https://x.com/fixture/status/12345',
    postId: '12345', authorName: 'Fixture Author', authorHandle: 'fixture',
    text: 'Synthetic source fixture: a useful tool makes the next action easier to see.',
    source: 'x', textStatus: 'full_text', fetchedAt: '2026-10-07T12:00:00.000Z',
    note: 'Synthetic browser-test source. This is not a real post.',
  };
  let referenceHandler = () => reference;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (predicate, message, timeout = 10000) => {
    const deadline = Date.now() + Math.min(timeout, 15000);
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await testPage.waitForTimeout(25);
    }
    throw new Error(message);
  };
  const deferred = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    releases.push(resolve);
    return { promise, resolve };
  };
  const screenshot = async name => {
    const path = `output/playwright/x-mode-${name}.png`;
    await testPage.screenshot({ path, fullPage: true });
    screenshots.push(path);
  };
  testPage.on('pageerror', error => pageErrors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) {
      requests.external.push(request.url());
      await route.abort();
      return;
    }
    if (!url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    try {
      if (url.pathname === '/api/health') {
        requests.health += 1;
        await route.fulfill({ json: { configured: true, decisionModel: 'browser-mock', generationModel: 'browser-mock' } });
      } else if (url.pathname === '/api/decide') {
        const input = request.postDataJSON();
        requests.decide.push(input);
        const result = await decisionHandler(input);
        await route.fulfill({ json: { confidence: 0.99, latencyMs: 12, model: 'browser-mock', ...result } });
      } else if (url.pathname === '/api/generate') {
        const input = request.postDataJSON();
        requests.generate.push(input);
        const result = await generationHandler(input);
        const frames = [{ type: 'delta', text: result.text }, { type: 'done', latencyMs: 24, model: 'browser-mock' }];
        await route.fulfill({ contentType: 'text/event-stream', body: frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') });
      } else if (url.pathname === '/api/x/reference') {
        const input = request.postDataJSON();
        requests.reference.push(input);
        const result = await referenceHandler(input);
        await route.fulfill({ status: result.status || 200, json: result.error ? { error: result.error } : result });
      } else {
        requests.unexpected.push(url.pathname);
        await route.abort();
      }
    } catch (error) {
      // Intentional cancellation may dispose an intercepted request.
      if (!/closed|disposed|intercept|abort|cancel/i.test(String(error))) pageErrors.push(String(error));
    }
  });
  const body = testPage.getByRole('textbox', { name: 'Document body', exact: true });
  const title = testPage.getByRole('textbox', { name: 'Document title', exact: true });
  const picker = testPage.getByRole('combobox', { name: 'Choose document', exact: true });
  const xMode = testPage.getByRole('button', { name: 'X post', exact: true });
  const documentMode = testPage.getByRole('button', { name: 'Document', exact: true });
  const sidebar = testPage.getByRole('complementary', { name: 'Reference post', exact: true });
  const sourceInput = testPage.getByRole('textbox', { name: 'X post link', exact: true });
  const sourceCheckbox = testPage.getByRole('checkbox', { name: 'Include source link', exact: true });
  const copyButton = testPage.getByRole('button', { name: /^(Copy post|Copied)$/ });
  // The disabled handoff intentionally has no href, so it has no link role.
  const composer = testPage.locator('a.open-x');
  const promptButton = testPage.getByRole('button', { name: /Make it happen/ });
  const text = async () => (await body.innerText()).trim();
  const editable = async () => until(async () => await body.getAttribute('contenteditable') === 'true', 'Editor stayed locked');
  const clipboard = async () => testPage.evaluate(() => navigator.clipboard.readText());
  const copyAndRead = async () => {
    await testPage.bringToFront();
    await copyButton.click();
    await testPage.getByText('Ready to paste into X.', { exact: true }).waitFor({ state: 'visible' });
    return clipboard();
  };
  const loadReference = async url => {
    await sourceInput.fill(url);
    await testPage.getByRole('button', { name: 'Load reference post', exact: true }).click();
  };
  const assertCount = async expected => {
    await until(async () => await testPage.locator('.character-count').getAttribute('aria-label') === `${expected} of 280 weighted characters`, `Expected weighted count ${expected}`);
  };
  try {
    await testPage.goto(base, { waitUntil: 'domcontentloaded' });
    await body.waitFor({ state: 'visible' });
    await documentMode.click();
    await testPage.getByRole('button', { name: 'New document', exact: true }).click();
    await title.fill('Browser fixture: original document');
    const originalText = 'Synthetic document fixture. This writing should survive a mode change.';
    await body.fill(originalText);
    const originalId = await picker.inputValue();

    stage = 'mode isolation and empty-state controls';
    await xMode.click();
    await sidebar.waitFor({ state: 'visible' });
    const firstXId = await picker.inputValue();
    assert(firstXId !== originalId, 'X mode reused and altered the original document');
    assert(await text() === '', 'New X post inherited document text');
    assert(await xMode.getAttribute('aria-pressed') === 'true', 'X mode is not selected');
    assert(await copyButton.isDisabled(), 'Empty post can be copied');
    assert(await composer.getAttribute('aria-disabled') === 'true', 'Empty post can open a composer');
    assert(await sourceCheckbox.isDisabled(), 'Source option is enabled without a source URL');
    assert(await testPage.getByRole('button', { name: /^Find my takeaway/ }).isDisabled(), 'Angle prompt is enabled without thoughts or source');
    await documentMode.click();
    assert(await picker.inputValue() === originalId, 'Document mode did not restore the previous document');
    assert(await text() === originalText, 'Switching modes lost original prose');
    await xMode.click();
    assert(await picker.inputValue() === firstXId, 'X mode did not restore its draft');
    passes.push('X mode creates a separate draft and preserves the original document; empty actions are disabled');

    stage = 'public source attachment and separate context';
    await title.fill('Browser fixture: response draft');
    await loadReference('https://twitter.com/fixture/status/12345?s=20');
    await sidebar.getByText(reference.text, { exact: true }).waitFor({ state: 'visible' });
    assert(requests.reference[0].url === reference.url, 'Source lookup did not normalize the pasted URL');
    assert(await sidebar.getByRole('link', { name: /^Open original/ }).getAttribute('href') === reference.url, 'Source attribution points to the wrong URL');
    assert(await text() === '', 'Source text leaked into the writing surface');
    assert(await copyButton.isDisabled(), 'Source-only empty draft can be copied');
    assert(await testPage.getByRole('button', { name: /^Find my takeaway/ }).isEnabled(), 'Reference did not enable an angle prompt');
    assert(await testPage.getByRole('button', { name: /^Disagree well/ }).isDisabled(), 'Draft-dependent prompt is enabled without a draft');
    const ownDraft = 'Synthetic draft: a useful tool makes the next decision easier.';
    await body.fill(ownDraft);
    await screenshot('writing');
    passes.push('pasted post URL loads an attributed source card without inserting source text into the draft');

    stage = 'actual clipboard, optional source, weighted count, and composer link';
    const withSource = `${ownDraft}\n\n${reference.url}`;
    assert(await sourceCheckbox.isChecked(), 'Source link is not included by default');
    await assertCount(ownDraft.length + 25);
    assert(await copyAndRead() === withSource, 'Clipboard did not contain exact draft plus source link');
    await sourceCheckbox.uncheck();
    await assertCount(ownDraft.length);
    assert(await copyAndRead() === ownDraft, 'Turning source link off did not copy only the draft');
    assert(!(await clipboard()).includes(reference.text), 'Clipboard copied the reference post text');
    await sourceCheckbox.check();
    const href = await composer.getAttribute('href');
    assert(Boolean(href), 'Composer link is missing');
    const intent = new URL(href);
    assert(intent.origin === 'https://x.com' && intent.pathname === '/intent/tweet', 'Composer target is not the X compose intent');
    assert(intent.searchParams.get('text') === withSource, 'Composer URL did not encode the exact copied text');
    assert(testPage.url().startsWith(base), 'Check unexpectedly navigated to X');
    passes.push('clipboard contains exact plain text; source toggle changes text and weighted count; X compose URL encodes the same text without posting');

    stage = 'typed intent and generation receive the reference';
    const typedPrompt = 'Make this more concise while keeping my point';
    decisionHandler = input => input.text === typedPrompt
      ? { intent: 'prompting', action: 'rewrite' }
      : { intent: 'writing', action: 'insert' };
    const typedOutput = 'Synthetic revision: a useful tool makes the next decision clear.';
    generationHandler = input => {
      assert(input.prompt === typedPrompt, 'Generation did not receive the typed instruction');
      assert(input.mode === 'x', 'Typed generation lost X mode');
      assert(input.reference?.text === reference.text && input.reference?.url === reference.url, 'Typed generation lost source context');
      assert(input.postBudget === 255, 'Typed generation did not reserve the source-link budget');
      assert(input.context.includes(ownDraft), 'Typed generation lost the draft');
      assert(!input.context.includes(reference.text), 'Source text was mixed into the user draft');
      return { text: typedOutput };
    };
    await body.press('ControlOrMeta+End');
    await body.press('Enter');
    await testPage.keyboard.insertText(typedPrompt);
    await promptButton.waitFor({ state: 'visible' });
    const typedDecision = requests.decide.find(input => input.text === typedPrompt);
    assert(typedDecision?.mode === 'x', 'Decisions request lost X mode');
    assert(typedDecision?.reference?.text === reference.text && typedDecision.reference.url === reference.url, 'Decisions request lost reference context');
    assert(typedDecision.postBudget === 255, 'Decisions request lost the post budget');
    assert(await copyAndRead() === withSource, 'Pending inline instruction leaked into copied post');
    await promptButton.click();
    await until(async () => await text() === typedOutput, 'Typed rewrite was not applied');
    await editable();
    passes.push('typed Decisions and generation include separate reference context; pending instructions are excluded from copied text');

    stage = 'copywriting prompt chip performs a reversible full-post rewrite';
    const chipOutput = 'Synthetic edited fixture: make the next useful decision easier.';
    generationHandler = input => {
      assert(input.mode === 'x', 'Prompt chip lost X mode');
      assert(input.action === 'rewrite', 'Prompt chip did not rewrite the existing draft');
      assert(input.prompt.includes('Improve the opening'), 'Prompt chip sent the wrong editing instruction');
      assert(input.context === typedOutput, 'Prompt chip lost the current complete draft');
      assert(input.reference?.text === reference.text, 'Prompt chip lost the reference');
      return { text: chipOutput };
    };
    await testPage.getByRole('button', { name: 'Sharpen the draft', exact: true }).click();
    await testPage.getByRole('button', { name: /^Lead with the point/ }).click();
    await until(async () => await text() === chipOutput, 'Prompt chip did not apply the rewrite');
    await editable();
    assert(!(await text()).includes('Improve the opening'), 'Prompt chip instruction was inserted into the finished post');
    await testPage.getByRole('toolbar', { name: 'Text formatting', exact: true }).getByRole('button', { name: 'Undo', exact: true }).click();
    assert(await text() === typedOutput, 'One Undo did not restore the pre-chip draft');
    passes.push('copywriting chip passes separate source context, replaces the complete post, and supports one-step Undo');

    stage = 'over-limit guidance and clipboard fallback';
    await sourceCheckbox.uncheck();
    await body.fill('a'.repeat(281));
    await assertCount(281);
    await testPage.getByText(/1 over the standard post limit/).waitFor({ state: 'visible' });
    assert(await copyButton.isEnabled(), 'Longer draft cannot be copied');
    await testPage.getByRole('button', { name: 'Make it yours', exact: true }).click();
    assert(await testPage.getByRole('button', { name: /^Fit one post/ }).isEnabled(), 'Over-limit draft cannot use Fit one post');
    const manualCopyText = 'Synthetic fixture for the manual clipboard fallback.';
    await body.fill(manualCopyText);
    await testPage.evaluate(() => Object.defineProperty(navigator.clipboard, 'writeText', {
      configurable: true, value: async () => { throw new Error('Controlled clipboard denial'); },
    }));
    await copyButton.click();
    const copyDialog = testPage.getByRole('dialog', { name: 'Copy your post', exact: true });
    await copyDialog.waitFor({ state: 'visible' });
    const manualCopy = copyDialog.getByRole('textbox', { name: 'Post text to copy', exact: true });
    assert(await manualCopy.inputValue() === manualCopyText, 'Manual copy fallback has the wrong text');
    assert(await manualCopy.evaluate(element => document.activeElement === element && element.selectionStart === 0 && element.selectionEnd === element.value.length), 'Manual copy fallback did not focus and select all text');
    await screenshot('clipboard-fallback');
    await testPage.getByRole('button', { name: 'Close copy dialog', exact: true }).click();
    await body.fill(typedOutput);
    await sourceCheckbox.check();
    passes.push('281-character draft shows over-limit guidance; clipboard denial opens a focused, fully selected manual copy field');

    stage = 'unavailable source supports manual text';
    await testPage.getByRole('button', { name: 'New document', exact: true }).click();
    await title.fill('Browser fixture: manual reference');
    const manualId = await picker.inputValue();
    const manualUrl = 'https://x.com/fixture/status/23456';
    const manualSourceText = 'Synthetic manually entered reference about making space for a first draft.';
    const manualDraft = 'Synthetic response fixture: room for a rough first draft matters.';
    referenceHandler = () => ({ status: 502, error: 'Controlled source fetch failure. Paste the source text instead.' });
    await loadReference(manualUrl);
    await testPage.getByRole('alert').filter({ hasText: 'Controlled source fetch failure.' }).waitFor({ state: 'visible' });
    await testPage.getByRole('textbox', { name: 'Reference author', exact: true }).fill('Fixture Manual Author');
    await testPage.getByRole('textbox', { name: 'Original post text', exact: true }).fill(manualSourceText);
    await testPage.getByRole('button', { name: /^Use as reference/ }).click();
    await sidebar.getByText(manualSourceText, { exact: true }).waitFor({ state: 'visible' });
    assert(await sidebar.getByText('Pasted by you', { exact: true }).isVisible(), 'Manual source is not identified as pasted text');
    await body.fill(manualDraft);
    await sourceCheckbox.uncheck();
    await screenshot('manual-reference');
    passes.push('failed source lookup offers manual entry and labels the resulting reference as pasted text');

    stage = 'per-document persistence and mode restoration';
    await testPage.reload({ waitUntil: 'domcontentloaded' });
    await body.waitFor({ state: 'visible' });
    assert(await picker.inputValue() === manualId, 'Reload did not restore the active X draft');
    assert(await xMode.getAttribute('aria-pressed') === 'true', 'Reload did not restore X mode');
    assert(await text() === manualDraft, 'Reload lost the last draft edit');
    assert(await sidebar.getByText(manualSourceText, { exact: true }).isVisible(), 'Reload lost the manual reference');
    assert(!(await sourceCheckbox.isChecked()), 'Reload lost the source-link preference');
    await picker.selectOption(firstXId);
    assert(await text() === typedOutput, 'Switching X drafts lost the earlier writing');
    assert(await sidebar.getByText(reference.text, { exact: true }).isVisible(), 'Reference from another X draft leaked into the earlier draft');
    assert(await sourceCheckbox.isChecked(), 'Per-document source-link preferences were merged');
    await documentMode.click();
    assert(await picker.inputValue() === originalId && await text() === originalText, 'Document mode did not preserve original content after X operations');
    assert(await sidebar.count() === 0, 'X sidebar remains in document mode');
    await xMode.click();
    assert(await picker.inputValue() === firstXId && await text() === typedOutput, 'X mode did not return to its last active draft');
    passes.push('reload and document switches preserve each draft, mode, reference, and source-link preference independently');

    stage = 'late source response cannot attach after document switch';
    await testPage.getByRole('button', { name: 'New document', exact: true }).click();
    await title.fill('Browser fixture: cancelled reference');
    const staleId = await picker.inputValue();
    const staleGate = deferred();
    let staleStarted = false;
    let staleReturned = false;
    referenceHandler = async () => {
      staleStarted = true;
      await staleGate.promise;
      staleReturned = true;
      return { ...reference, url: 'https://x.com/fixture/status/34567', text: 'Synthetic stale source that must never attach.' };
    };
    await loadReference('https://x.com/fixture/status/34567');
    await until(() => staleStarted, 'Delayed source request never reached the mock');
    await picker.selectOption(firstXId);
    staleGate.resolve();
    await until(() => staleReturned, 'Delayed source request did not resume');
    await testPage.waitForTimeout(150);
    assert(await sidebar.getByText(reference.text, { exact: true }).isVisible(), 'Delayed request replaced the active document reference');
    assert(await sidebar.getByText('Synthetic stale source that must never attach.', { exact: true }).count() === 0, 'Stale reference attached to another document');
    await picker.selectOption(staleId);
    assert(await sidebar.locator('.reference-card').count() === 0, 'Cancelled source attached to its old document after switching away');
    assert(await copyButton.isDisabled(), 'Empty cancelled draft can be copied');
    passes.push('late reference response is discarded after switching documents');

    stage = 'responsive screenshot and request audit';
    await picker.selectOption(firstXId);
    await testPage.setViewportSize({ width: 390, height: 844 });
    await testPage.evaluate(() => document.fonts.ready);
    assert(await testPage.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1), 'X mode overflows horizontally at mobile width');
    await screenshot('mobile');
    assert(requests.external.length === 0, `Unexpected external requests: ${requests.external.join(', ')}`);
    assert(requests.unexpected.length === 0, `Unexpected API routes: ${requests.unexpected.join(', ')}`);
    assert(pageErrors.length === 0, `Browser exceptions: ${pageErrors.join('; ')}`);
    return { ok: true, mocked: true, liveApiCalls: 0, passes, apiRequests: { health: requests.health, decide: requests.decide.length, generate: requests.generate.length, reference: requests.reference.length }, screenshots, userPageUnchanged: true };
  } catch (error) {
    await testPage.screenshot({ path: 'output/playwright/x-mode-failure.png', fullPage: true }).catch(() => {});
    throw new Error(JSON.stringify({ ok: false, stage, error: String(error), passes, pageErrors, unexpectedApi: requests.unexpected, externalRequests: requests.external, screenshot: 'output/playwright/x-mode-failure.png', userPageUnchanged: true }));
  } finally {
    for (const release of releases) release();
    await context.close();
  }
}
