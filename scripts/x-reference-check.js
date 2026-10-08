async (page) => {
  // Isolated browser context, synthetic source fixtures, and no live API calls.
  const browser = page.context().browser();
  if (!browser) throw new Error('An independent browser context is required.');
  const base = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(page.url())
    ? new URL(page.url()).origin : 'http://127.0.0.1:4173';
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  await context.addInitScript({ path: 'node_modules/axe-core/axe.min.js' });
  context.setDefaultTimeout(15000);
  context.setDefaultNavigationTimeout(15000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const testPage = await context.newPage();
  const passes = [];
  const errors = [];
  const accessibility = [];
  const screenshots = [];
  const requests = { reference: [], decide: 0, generate: 0, unexpected: [], external: [] };
  const tail = '\nEND OF FULL REFERENCE. This synthetic final sentence must remain visible.';
  const longText = 'Synthetic reference fixture. Each sentence belongs to the complete source. '.repeat(400).slice(0, 25000 - tail.length) + tail;
  const emojiText = '🦊'.repeat(25000);
  const overLimitText = 'A'.repeat(60001);
  const source = {
    url: 'https://x.com/fixture/status/45678', authorName: 'Fixture Author', authorHandle: 'fixture',
    text: longText, source: 'x', textStatus: 'full_text',
    note: 'Synthetic browser-test source, not a real post.',
  };
  const legacySource = { ...source, url: 'https://x.com/fixture/status/56789', text: 'Synthetic legacy excerpt.' };
  delete legacySource.textStatus;
  const upgradedText = 'Synthetic full legacy source. The final sentence was absent from the earlier excerpt.';
  let referenceHandler = input => input.url === legacySource.url
    ? { ...source, url: legacySource.url, text: upgradedText } : source;
  const seed = [
    { id: 'reference-fixture', title: 'Full reference browser fixture', mode: 'x', updated: 1, content: { type: 'doc', content: [{ type: 'paragraph' }] }, includeSource: true },
    { id: 'reference-legacy', title: 'Legacy reference browser fixture', mode: 'x', updated: 2, content: { type: 'doc', content: [{ type: 'paragraph' }] }, reference: legacySource, includeSource: true },
  ];
  await context.addInitScript(({ documents }) => {
    if (sessionStorage.getItem('reference-check-seeded')) return;
    localStorage.setItem('between.documents.v1', JSON.stringify(documents));
    localStorage.setItem('between.active.v1', 'reference-fixture');
    sessionStorage.setItem('reference-check-seeded', 'true');
  }, { documents: seed });
  testPage.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== base) {
      requests.external.push(url.href);
      return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/health') return route.fulfill({ json: { configured: true, decisionModel: 'fixture', generationModel: 'fixture' } });
    if (url.pathname === '/api/x/reference') {
      const input = request.postDataJSON();
      requests.reference.push(input);
      return route.fulfill({ json: await referenceHandler(input) });
    }
    if (url.pathname === '/api/decide') {
      requests.decide += 1;
      return route.fulfill({ json: { intent: 'writing', action: 'insert', confidence: 1, latencyMs: 1, model: 'fixture' } });
    }
    if (url.pathname === '/api/generate') {
      requests.generate += 1;
      return route.fulfill({ status: 500, json: { error: 'Generation is not part of this reference check.' } });
    }
    requests.unexpected.push(url.pathname);
    return route.abort();
  });
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (predicate, message) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await testPage.waitForTimeout(25);
    }
    throw new Error(message);
  };
  const sidebar = testPage.getByRole('complementary', { name: 'Reference post', exact: true });
  const quote = sidebar.locator('.reference-card blockquote');
  const sourceInput = testPage.getByRole('textbox', { name: 'X post link', exact: true });
  const manualInput = testPage.getByRole('textbox', { name: 'Original post text', exact: true });
  const picker = testPage.getByRole('combobox', { name: 'Choose document', exact: true });
  const loadReference = async url => {
    await sourceInput.fill(url);
    await testPage.getByRole('button', { name: 'Load reference post', exact: true }).click();
  };
  const paste = async value => {
    await testPage.bringToFront();
    await testPage.evaluate(text => navigator.clipboard.writeText(text), value);
    await manualInput.click();
    await manualInput.press('ControlOrMeta+A');
    await manualInput.press('ControlOrMeta+V');
    await until(async () => await manualInput.inputValue() === value, 'Pasted reference text was shortened or changed');
  };
  const checkFullSource = async viewport => {
    assert(await quote.textContent() === longText, `${viewport}: full source text or its final sentence was changed`);
    assert(await quote.innerText() === longText, `${viewport}: rendered source text differs from the supplied source`);
    const geometry = await quote.evaluate((element, tailLength) => {
      const style = getComputedStyle(element);
      const clipped = [];
      for (let ancestor = element; ancestor && !['BODY', 'HTML'].includes(ancestor.tagName); ancestor = ancestor.parentElement) {
        const css = getComputedStyle(ancestor);
        if (ancestor.scrollHeight > ancestor.clientHeight + 2 && ['hidden', 'clip', 'auto', 'scroll'].includes(css.overflowY))
          clipped.push({ tag: ancestor.tagName, className: ancestor.className, overflowY: css.overflowY });
      }
      const node = element.firstChild;
      const range = document.createRange();
      range.setStart(node, node.textContent.length - tailLength);
      range.setEnd(node, node.textContent.length);
      const last = range.getBoundingClientRect();
      const box = element.getBoundingClientRect();
      return {
        maxHeight: style.maxHeight, overflowY: style.overflowY, clipped,
        scrollHeight: element.scrollHeight, clientHeight: element.clientHeight,
        tailFits: last.top >= box.top - 2 && last.bottom <= box.bottom + 2,
        horizontalOverflow: document.documentElement.scrollWidth > window.innerWidth + 1,
      };
    }, tail.length);
    assert(geometry.maxHeight === 'none', `${viewport}: source has a max-height (${geometry.maxHeight})`);
    assert(geometry.scrollHeight <= geometry.clientHeight + 2, `${viewport}: source has an inner vertical scrollbar or clipping`);
    assert(geometry.clipped.length === 0, `${viewport}: source is clipped by ${JSON.stringify(geometry.clipped)}`);
    assert(geometry.tailFits, `${viewport}: final source sentence falls outside its rendered block`);
    assert(!geometry.horizontalOverflow, `${viewport}: page overflows horizontally`);
  };
  const captureTail = async name => {
    await quote.evaluate(element => {
      const range = document.createRange();
      const node = element.firstChild;
      range.setStart(node, Math.max(0, node.textContent.length - 80));
      range.setEnd(node, node.textContent.length);
      window.scrollBy(0, range.getBoundingClientRect().bottom - window.innerHeight + 180);
    });
    const path = `output/playwright/x-reference-${name}.png`;
    await testPage.screenshot({ path });
    screenshots.push(path);
  };
  const axe = async state => {
    const violations = await testPage.evaluate(async () => {
      let timeout;
      try {
        return await Promise.race([
          window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } }).then(result => result.violations.map(item => ({ id: item.id, impact: item.impact, targets: item.nodes.map(node => node.target) }))),
          new Promise((_, reject) => { timeout = setTimeout(() => reject(new Error('axe exceeded 15 seconds')), 15000); }),
        ]);
      } finally { clearTimeout(timeout); }
    });
    accessibility.push({ state, violations });
  };
  let stage = 'initial load';
  try {
    assert(longText.length === 25000 && emojiText.length === 50000, 'Long-source fixtures have the wrong lengths');
    await testPage.goto(base, { waitUntil: 'domcontentloaded' });
    await sidebar.waitFor();

    stage = 'complete 25k source at desktop and mobile';
    await loadReference(source.url);
    await until(async () => await quote.count() === 1 && await quote.textContent() === longText, 'Complete 25k source was not loaded');
    await testPage.evaluate(() => document.fonts.ready);
    await checkFullSource('desktop 1440');
    await captureTail('desktop-tail');
    await axe('desktop full source');
    await testPage.setViewportSize({ width: 390, height: 844 });
    await checkFullSource('mobile 390');
    await captureTail('mobile-tail');
    await axe('mobile full source');
    passes.push('25,000-character source retains all text and its tail, with no max-height, inner clipping, or horizontal overflow at 1440px and 390px');

    stage = 'manual 25k emoji paste is not truncated';
    await testPage.setViewportSize({ width: 1440, height: 1100 });
    await testPage.getByRole('button', { name: 'Edit reference text', exact: true }).click();
    assert(await manualInput.getAttribute('maxlength') === null, 'Manual reference textarea has a truncating maxlength attribute');
    await paste(emojiText);
    assert((await manualInput.inputValue()).length === 50000, 'Manual 25k emoji paste lost UTF-16 units');
    await axe('manual full text entry');
    await testPage.getByRole('button', { name: /^Use as reference/ }).click();
    await until(async () => await quote.textContent() === emojiText, 'Saved manual emoji reference differs from the pasted text');
    assert(await sidebar.getByText('Pasted by you', { exact: true }).isVisible(), 'Manual source attribution was lost');
    await until(async () => testPage.evaluate(expected => JSON.parse(localStorage.getItem('between.documents.v1')).find(doc => doc.id === 'reference-fixture').reference.text === expected, emojiText), 'Complete manual reference was not persisted');
    passes.push('25,000 emoji (50,000 UTF-16 units) survive actual clipboard paste, rendering, and persistence; textarea has no maxlength');

    stage = 'oversized paste remains intact and does not overwrite saved source';
    await testPage.getByRole('button', { name: 'Edit reference text', exact: true }).click();
    await paste(overLimitText);
    await testPage.getByRole('alert').filter({ hasText: 'Your pasted text is intact' }).waitFor();
    await testPage.getByRole('button', { name: /^Use as reference/ }).click();
    await testPage.getByRole('alert').filter({ hasText: 'Nothing has been shortened or saved' }).waitFor();
    assert(await manualInput.inputValue() === overLimitText, 'Rejected oversized text was cut off in the entry field');
    assert(await quote.textContent() === emojiText, 'Rejected oversized text replaced the current source');
    assert(await testPage.evaluate(expected => JSON.parse(localStorage.getItem('between.documents.v1')).find(doc => doc.id === 'reference-fixture').reference.text === expected, emojiText), 'Rejected oversized text overwrote the saved source');
    passes.push('60,001-character paste remains intact and receives an explicit rejection without replacing the current or saved reference');

    stage = 'incomplete source warning and complete pasted replacement';
    await testPage.getByRole('button', { name: 'New document', exact: true }).click();
    const incomplete = { ...source, url: 'https://x.com/fixture/status/67890', text: 'Synthetic shortened source…', textStatus: 'possibly_truncated' };
    referenceHandler = () => incomplete;
    await loadReference(incomplete.url);
    await sidebar.getByText('X may have shortened this post.', { exact: true }).waitFor();
    await axe('incomplete source warning');
    await testPage.getByRole('button', { name: /^Paste complete text/ }).click();
    assert(await manualInput.inputValue() === incomplete.text, 'Complete-text action lost the available source');
    await until(async () => await manualInput.evaluate(element => document.activeElement === element), 'Complete-text action did not focus the input');
    const replacement = 'Synthetic complete source.\nThis second line was absent from the excerpt.\n\nThe final thought stays intact. 🦊';
    await paste(replacement);
    await testPage.getByRole('button', { name: /^Use as reference/ }).click();
    await until(async () => await quote.textContent() === replacement, 'Pasted replacement was shortened or reformatted');
    assert(await sidebar.locator('.source-incomplete').count() === 0, 'Incomplete warning remained after full manual replacement');
    assert(await sidebar.getByText('Pasted by you', { exact: true }).isVisible(), 'Replacement falsely claims to be fetched source text');
    passes.push('possibly truncated source has a clear warning and focused paste action; complete replacement retains exact text and line breaks');

    stage = 'legacy saved reference upgrades on mount';
    referenceHandler = input => {
      assert(input.url === legacySource.url, 'Legacy upgrade fetched the wrong source URL');
      return { ...source, url: legacySource.url, text: upgradedText };
    };
    const beforeUpgrade = requests.reference.length;
    await picker.selectOption('reference-legacy');
    await until(async () => await quote.textContent() === upgradedText, 'Legacy reference did not upgrade to full text after mounting');
    assert(requests.reference.length > beforeUpgrade, 'Legacy reference was not fetched automatically');
    assert(await sidebar.getByText('Post text from X', { exact: true }).isVisible(), 'Upgraded reference is not marked as fetched full text');
    await until(async () => testPage.evaluate(() => {
      const saved = JSON.parse(localStorage.getItem('between.documents.v1')).find(doc => doc.id === 'reference-legacy').reference;
      return saved.textStatus === 'full_text' && saved.text.endsWith('earlier excerpt.');
    }), 'Upgraded reference was not persisted');
    const afterUpgrade = requests.reference.length;
    await testPage.reload({ waitUntil: 'domcontentloaded' });
    await quote.waitFor();
    await testPage.waitForTimeout(200);
    assert(await quote.textContent() === upgradedText, 'Reload lost the upgraded reference');
    assert(requests.reference.length === afterUpgrade, 'Already upgraded source was fetched again on reload');
    passes.push('legacy saved X excerpt without textStatus is fetched on mount, persisted as full text, and retained on reload');

    assert(requests.unexpected.length === 0 && requests.external.length === 0, `Unexpected requests: ${JSON.stringify({ api: requests.unexpected, external: requests.external })}`);
    assert(requests.generate === 0, 'Reference checks unexpectedly requested generation');
    assert(errors.length === 0, `Browser exceptions: ${errors.join('; ')}`);
    assert(accessibility.every(result => result.violations.length === 0), `Accessibility violations: ${JSON.stringify(accessibility.filter(result => result.violations.length))}`);
    return { ok: true, checks: passes.length, passes, accessibility: accessibility.map(result => ({ state: result.state, violations: result.violations.length })), apiRequests: { reference: requests.reference.length, decide: requests.decide, generate: requests.generate }, liveApiCalls: 0, screenshots, userPageUnchanged: true };
  } catch (error) {
    await testPage.screenshot({ path: 'output/playwright/x-reference-failure.png' }).catch(() => {});
    throw new Error(JSON.stringify({ ok: false, stage, error: String(error), passes, accessibility, errors, userPageUnchanged: true }));
  } finally {
    await context.close();
  }
}
