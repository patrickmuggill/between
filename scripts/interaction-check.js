async (page) => {
  const browser = page.context().browser();
  if (!browser) throw new Error('An independent browser context is required.');
  const base = new URL(page.url()).origin;
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: 'reduce' });
  const testPage = await context.newPage();
  const errors = [];
  const passes = [];
  testPage.on('pageerror', error => errors.push(error.message));
  await context.addInitScript(() => {
    localStorage.setItem('between.documents.v1', JSON.stringify([{
      id: 'interaction-fixture', title: 'Interaction fixture', mode: 'x', updated: 1,
      content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Synthetic draft.' }] }] },
      reference: { url: '', text: 'Saved synthetic reference.', authorName: 'Fixture', source: 'manual' },
    }]));
    localStorage.setItem('between.active.v1', 'interaction-fixture');
  });
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    if (url.pathname === '/api/health') return route.fulfill({ json: { configured: false } });
    if (url.pathname.startsWith('/api/')) return route.abort();
    return route.continue();
  });
  const assert = (value, message) => { if (!value) throw new Error(message); };
  try {
    await testPage.goto(base);
    const toggle = testPage.getByRole('button', { name: 'Edit reference text', exact: true });
    await toggle.click();
    const input = testPage.getByRole('textbox', { name: 'Original post text', exact: true });
    assert(await input.evaluate(node => node === document.activeElement), 'Opening manual entry must focus its text');
    await input.fill('Unfinished synthetic changes.');
    await testPage.getByRole('textbox', { name: 'Reference author', exact: true }).fill('Changed author');
    await testPage.getByRole('button', { name: 'Close text entry', exact: true }).click();
    await toggle.click();
    assert(await input.inputValue() === 'Unfinished synthetic changes.', 'Reopening manual entry discarded unsaved text');
    assert(await testPage.getByRole('textbox', { name: 'Reference author', exact: true }).inputValue() === 'Changed author', 'Reopening discarded unsaved author');
    await testPage.getByRole('button', { name: 'Use as reference', exact: true }).click();
    assert(await toggle.evaluate(node => node === document.activeElement), 'Saving manual reference must restore focus');
    passes.push('Manual reference preserves unsaved text/author across close and reopen, with focus restored on save');

    await testPage.locator('.connection-button').click();
    const dialog = testPage.getByRole('dialog', { name: 'Connect OpenAI', exact: true });
    await dialog.waitFor({ state: 'visible' });
    await dialog.click({ position: { x: 5, y: 5 } });
    assert(await dialog.isVisible(), 'Clicking dialog padding dismissed the settings');
    await testPage.keyboard.press('Escape');
    await dialog.waitFor({ state: 'hidden' });
    passes.push('Settings padding is safe to click and Escape still dismisses');

    await toggle.click();
    assert(await input.evaluate(node => parseFloat(getComputedStyle(node).fontSize) >= 16), 'Touch textarea text must avoid auto-zoom');
    assert(await testPage.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), 'Mobile layout overflows');
    await testPage.screenshot({ path: 'output/playwright/interaction-mobile.png', fullPage: true });
    passes.push('Touch entry remains readable without horizontal overflow');
    assert(errors.length === 0, errors.join('\n'));
    return { ok: true, passes };
  } finally {
    await context.close();
  }
}
