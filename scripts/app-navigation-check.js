async (page) => {
  const browser = page.context().browser();
  if (!browser) throw new Error('An isolated browser context is required.');
  const base = new URL(page.url()).origin;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(12000);
  await context.addInitScript({ path: 'node_modules/axe-core/axe.min.js' });
  // Deferred synthetic fetch ignores abort deliberately: the app must reject a
  // stale completion even if a provider responds after route cancellation.
  await context.addInitScript(() => {
    const nativeFetch = window.fetch.bind(window);
    window.__navigationFixture = { pending: [], unexpected: [] };
    window.fetch = (input, init) => {
      const url = new URL(typeof input === 'string' ? input : input.url || input, location.href);
      const fixture = window.__navigationFixture;
      if (url.origin !== location.origin) {
        fixture.unexpected.push(url.href);
        return Promise.reject(new Error('External fixture request blocked'));
      }
      if (!url.pathname.startsWith('/api/')) return nativeFetch(input, init);
      if (url.pathname === '/api/health') return Promise.resolve(new Response(JSON.stringify({ configured: true })));
      if (url.pathname === '/api/decide') return Promise.resolve(new Response(JSON.stringify({ intent: 'writing', action: 'insert', confidence: 1, latencyMs: 1, model: 'fixture' })));
      if (url.pathname === '/api/generate') return new Promise(resolve => fixture.pending.push({ resolve, signal: init.signal }));
      fixture.unexpected.push(url.pathname);
      return Promise.reject(new Error('Unexpected fixture API'));
    };
  });
  const p = await context.newPage();
  const errors = [];
  const passes = [];
  const screenshots = [];
  p.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base || url.pathname.startsWith('/api/')) {
      errors.push(`Unexpected network request: ${url.href}`);
      return route.abort();
    }
    return route.continue();
  });
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const until = async (predicate, message) => {
    const deadline = Date.now() + 10000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await p.waitForTimeout(25);
    }
    throw new Error(message);
  };
  const audit = async name => {
    const violations = await p.evaluate(async () => (await window.axe.run(document, {
      runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] },
    })).violations.map(v => ({ id: v.id, targets: v.nodes.map(n => n.target) })));
    assert(violations.length === 0, `${name} accessibility: ${JSON.stringify(violations)}`);
  };
  const body = p.getByRole('textbox', { name: 'Document body', exact: true });
  const assertEditorFocus = async label => {
    const heading = p.getByRole('heading', { name: 'Writing workspace', exact: true });
    await until(async () => await heading.count() === 1 && await heading.evaluate(element => element === document.activeElement), `${label}: editor entry did not focus its workspace heading`);
  };
  const nav = route => p.locator(`header a[href="#/${route}"]:visible`);
  const go = async route => {
    await nav(route).click();
    await until(() => p.evaluate(route => location.hash === `#/${route}`, route), `Did not navigate to ${route}`);
  };
  const capture = async name => {
    const path = `output/playwright/navigation-${name}.png`;
    await p.screenshot({ path, fullPage: true });
    screenshots.push(path);
  };
  const layout = async name => {
    for (const width of [1440, 390, 320]) {
      await p.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `${name} overflows at ${width}px`);
      await audit(`${name} ${width}px`);
      if (width !== 320 || name === 'editor') await capture(`${name}-${width}`);
    }
    await p.setViewportSize({ width: 1440, height: 1000 });
  };
  let stage = 'fresh landing';
  try {
    await p.goto(base);
    await p.locator('main:visible h1').waitFor();
    assert(!await body.isVisible(), 'Fresh entry skips the landing page');
    const logo = p.locator('header a[href="#/"]:visible img');
    await logo.waitFor();
    const logoSource = await logo.getAttribute('src');
    assert(await logo.evaluate(img => img.complete && img.naturalWidth > 0), 'Generated logo failed to load');
    const hero = p.locator('main:visible img').first();
    await hero.waitFor();
    await until(() => hero.evaluate(img => img.complete && img.naturalWidth >= 600), 'Generated watercolor hero failed to load');
    assert(await p.locator('.hero-actions a.primary-link[href="#/editor"]').count() === 1, 'Landing should offer one clear primary writing CTA');
    await layout('landing');
    await p.keyboard.press('Tab');
    assert(await p.evaluate(() => document.activeElement?.matches('a,button,input,textarea,[tabindex="0"]')), 'Keyboard cannot reach landing controls');
    const focus = await p.evaluate(() => {
      const css = getComputedStyle(document.activeElement);
      return css.outlineStyle !== 'none' && parseFloat(css.outlineWidth) > 0 || css.boxShadow !== 'none';
    });
    assert(focus, 'Focused landing control has no visible focus indicator');
    assert(await p.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches), 'Reduced motion fixture not active');
    const moving = await p.evaluate(() => document.getAnimations().filter(a => a.playState === 'running' && a.effect?.getTiming().iterations === Infinity).length);
    assert(moving === 0, 'Reduced motion still has perpetual animation');
    passes.push('Fresh landing, loaded shared logo and watercolor, single primary CTA, keyboard focus and reduced motion');

    stage = 'editor and history';
    await p.locator('.hero-actions a.primary-link[href="#/editor"]').focus();
    await p.keyboard.press('Enter');
    await body.waitFor();
    await assertEditorFocus('Keyboard landing CTA');
    await p.getByRole('button', { name: 'Auto-detect on', exact: true }).click();
    await p.getByRole('button', { name: 'Or paste the post’s text', exact: true }).click();
    await p.getByRole('textbox', { name: 'Original post text', exact: true }).fill('Synthetic original source, kept separate from my draft.');
    await p.getByRole('textbox', { name: 'Reference author', exact: true }).fill('Synthetic author');
    // Unsaved source entry is distinct from the saved reference: leave before
    // pressing Use as reference and verify both fields survive intact.
    await go('bookmarks');
    await go('editor');
    await assertEditorFocus('Return with unfinished reference');
    assert(await p.getByRole('textbox', { name: 'Original post text', exact: true }).inputValue() === 'Synthetic original source, kept separate from my draft.', 'Route change discarded unfinished manual reference text');
    assert(await p.getByRole('textbox', { name: 'Reference author', exact: true }).inputValue() === 'Synthetic author', 'Route change discarded unfinished manual reference author');
    await p.getByRole('button', { name: 'Use as reference', exact: true }).click();
    const quote = p.locator('.reference-card blockquote');
    const draft = 'Synthetic words preserved through every route.';
    await body.fill(draft);
    // Do not wait for autosave: this transition must preserve the current edit.
    await go('bookmarks');
    await p.goBack();
    await body.waitFor();
    await assertEditorFocus('Browser Back');
    assert((await body.innerText()).trim() === draft, 'Immediate route change lost the latest draft');
    assert(await quote.textContent() === 'Synthetic original source, kept separate from my draft.', 'Route switch lost or changed the reference');
    await p.goForward();
    assert(p.url().endsWith('#/bookmarks'), 'Browser Forward failed');
    await go('editor');
    await assertEditorFocus('Navigation from bookmarks');
    assert(await logo.getAttribute('src') === logoSource, 'Editor uses a different logo');
    await body.press('End');
    await body.press('Enter');
    await p.keyboard.type('Second synthetic thought.');
    await go('');
    await go('editor');
    await p.getByRole('toolbar', { name: 'Text formatting' }).getByRole('button', { name: 'Undo', exact: true }).click();
    assert(!(await body.innerText()).includes('Second synthetic thought.'), 'Route switch discarded editor undo history');
    await body.fill(draft);
    await layout('editor');
    await p.getByRole('button', { name: 'Focus mode', exact: true }).click();
    for (const width of [1440, 390]) {
      await p.setViewportSize({ width, height: width === 1440 ? 1000 : 844 });
      assert(await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), `Focus mode overflows at ${width}px`);
      await audit(`editor focus mode ${width}px`);
      await capture(`editor-focus-${width}`);
    }
    await p.getByRole('button', { name: 'Exit focus mode', exact: true }).click();
    await p.setViewportSize({ width: 1440, height: 1000 });
    passes.push('Keyboard and direct editor entry focus, Back/Forward focus, unfinished reference fields, immediate draft/source navigation and editor undo preservation');

    stage = 'route cancellation';
    await body.fill('Write a synthetic greeting');
    await body.press('Control+Enter');
    await until(() => p.evaluate(() => window.__navigationFixture.pending.length === 1), 'Synthetic generation did not start');
    await go('bookmarks');
    await until(() => p.evaluate(() => window.__navigationFixture.pending[0].signal.aborted), 'Leaving editor failed to cancel generation');
    await p.evaluate(() => window.__navigationFixture.pending[0].resolve(new Response(
      'data: {"type":"delta","text":"Obsolete route response"}\n\ndata: {"type":"done"}\n\n',
      { headers: { 'Content-Type': 'text/event-stream' } },
    )));
    await go('editor');
    await p.waitForTimeout(100);
    assert((await body.innerText()).trim() === 'Write a synthetic greeting', 'Late response changed draft after route cancellation');
    assert(await body.getAttribute('contenteditable') === 'true', 'Route cancellation left editor locked');
    passes.push('Leaving editor cancels generation and ignores late provider response');

    stage = 'bookmark form and empty state';
    await go('bookmarks');
    await p.getByRole('heading', { name: 'Your next thought starts here.', exact: true }).waitFor();
    assert(await logo.getAttribute('src') === logoSource, 'Bookmarks uses a different logo');
    assert(await p.getByRole('heading', { name: 'Thoughts to return to.', exact: true }).evaluate(el => el === document.activeElement), 'Route navigation did not focus the page heading');
    await layout('bookmarks-empty');
    const save = p.getByRole('button', { name: 'Save bookmark', exact: true });
    await save.click();
    await p.getByRole('alert').filter({ hasText: 'Add a post link or its text.' }).waitFor();
    await audit('bookmark empty validation');
    await p.locator('#bookmark-url').fill('https://example.com/not-an-x-post');
    await save.click();
    assert(await p.getByRole('alert').isVisible(), 'Invalid reference URL is not explained');
    assert(await p.locator('.bookmark-card').count() === 0, 'Invalid source was saved');
    await p.locator('#bookmark-url').fill('');
    const savedText = 'Synthetic saved reference.\nIts complete second line stays intact.';
    await p.locator('#bookmark-author').fill('Navigation fixture author');
    await p.locator('#bookmark-text').fill(savedText);
    await save.click();
    const card = p.locator('.bookmark-card').filter({ hasText: 'Navigation fixture author' });
    await card.waitFor();
    assert(await card.locator('.bookmark-text').textContent() === savedText, 'Saved reference text changed');
    await layout('bookmarks-saved');
    await p.reload();
    await card.waitFor();
    assert(await card.locator('.bookmark-text').textContent() === savedText, 'Reload lost saved reference');
    await card.getByRole('button', { name: 'Remove bookmark by Navigation fixture author', exact: true }).click();
    assert(await card.count() === 0, 'Remove bookmark did not remove it');
    await p.getByRole('button', { name: 'Undo', exact: true }).click();
    await card.waitFor();
    assert(await card.locator('.bookmark-text').textContent() === savedText, 'Undo did not restore exact bookmark');
    await card.getByRole('button', { name: 'Write a response', exact: true }).click();
    await body.waitFor();
    assert((await body.innerText()).trim() === '', 'Bookmark open did not create a new blank draft');
    assert(await p.locator('.reference-card blockquote').textContent() === savedText, 'Bookmark open lost its reference');
    const picker = p.getByRole('combobox', { name: 'Choose document', exact: true });
    const options = await picker.locator('option').evaluateAll(items => items.map(item => item.value));
    assert(options.length >= 2, 'Opening a bookmark replaced the existing draft');
    const newId = await picker.inputValue();
    await picker.selectOption(options.find(id => id !== newId));
    assert((await body.innerText()).trim() === 'Write a synthetic greeting', 'Opening a bookmark destroyed the previous draft');
    await p.getByRole('button', { name: 'Save to bookmarks', exact: true }).click();
    await p.getByRole('button', { name: 'Save to bookmarks', exact: true }).click();
    await go('bookmarks');
    assert(await p.locator('.bookmark-card').count() === 2, 'Editor reference save failed or duplicate save created another bookmark');
    assert(await p.locator('.bookmark-card').filter({ hasText: 'Synthetic original source, kept separate from my draft.' }).count() === 1, 'Editor bookmark lost the original source');
    await p.reload();
    await card.waitFor();
    passes.push('Bookmark empty/error form, exact save/reload, reversible removal, new response without replacing old draft');

    stage = 'direct route entry and blocked storage';
    await p.goto(`${base}/#/editor`);
    await body.waitFor();
    await assertEditorFocus('Direct editor route');
    await p.goto(`${base}/#/bookmarks`);
    await card.waitFor();
    // Corrupt only this isolated context. Loading must preserve exact original
    // bytes and prohibit overwriting them, rather than silently showing success.
    await p.evaluate(() => localStorage.setItem('between.bookmarks.v1', '{synthetic unreadable bookmark collection'));
    await p.reload();
    await p.getByRole('alert').filter({ hasText: 'Saved bookmarks could not be read.' }).waitFor();
    assert(await save.isDisabled(), 'Unreadable bookmark storage still permits overwrite');
    assert(await p.evaluate(() => localStorage.getItem('between.bookmarks.v1')) === '{synthetic unreadable bookmark collection', 'Unreadable bookmark data was overwritten');
    await audit('bookmark storage recovery');
    passes.push('Direct editor/bookmark entry and safe unreadable bookmark recovery state');

    assert(errors.length === 0, errors.join('\n'));
    assert((await p.evaluate(() => window.__navigationFixture.unexpected)).length === 0, 'Unexpected API request');
    return { ok: true, passes, screenshots, liveApiCalls: 0, userPageUnchanged: true };
  } catch (error) {
    await capture('failure').catch(() => {});
    throw new Error(JSON.stringify({ ok: false, stage, error: String(error), passes, errors }));
  } finally { await context.close(); }
}
