async (page) => {
  const browser = page.context().browser();
  if (!browser) throw new Error('An isolated browser context is required.');
  const base = new URL(page.url()).origin;
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const checks = [];
  for (const failBackup of [false, true]) {
    const context = await browser.newContext({ acceptDownloads: true });
    const testPage = await context.newPage();
    const errors = [];
    testPage.on('pageerror', error => errors.push(error.message));
    await context.addInitScript(({ failBackup }) => {
      const raw = JSON.stringify([{
        id: 'recovery-fixture', title: 'Recovery fixture', mode: 'document', updated: 1,
        content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Synthetic words to recover.' }] }] },
      }, null]);
      // Initialize this fresh context once; reload must exercise persisted data.
      if (localStorage.getItem('synthetic-original') === null) {
        localStorage.setItem('between.documents.v1', raw);
        localStorage.setItem('between.active.v1', 'recovery-fixture');
        localStorage.setItem('synthetic-original', raw);
      }
      if (failBackup) {
        const originalSetItem = Storage.prototype.setItem;
        Storage.prototype.setItem = function(key, value) {
          if (key.startsWith('between.documents.v1.recovery')) throw new DOMException('Synthetic quota failure', 'QuotaExceededError');
          return originalSetItem.call(this, key, value);
        };
      }
    }, { failBackup });
    await context.route('**/*', route => {
      const url = new URL(route.request().url());
      if (url.origin !== base) return route.abort();
      if (url.pathname === '/api/health') return route.fulfill({ json: { configured: false } });
      if (url.pathname.startsWith('/api/')) return route.abort();
      return route.continue();
    });
    try {
      await testPage.goto(base);
      const body = testPage.getByRole('textbox', { name: 'Document body', exact: true });
      assert((await body.innerText()).includes('Synthetic words to recover.'), 'Readable draft was not recovered');
      const warning = testPage.getByRole('alert').filter({ hasText: 'Some saved drafts could not be opened' });
      await warning.waitFor({ state: 'visible' });
      assert((await warning.innerText()).includes(failBackup ? 'Saving is paused' : 'backed up on this device'), 'Wrong recovery status');
      const downloadPromise = testPage.waitForEvent('download');
      await warning.getByRole('button', { name: 'Download original data' }).click();
      const download = await downloadPromise;
      assert(download.suggestedFilename() === 'between-original-drafts.json', 'Recovery download missing');
      // Read the actual Playwright download stream: run-code has Buffer but no
      // Node require/filesystem access. This checks bytes, not just its filename.
      const original = await testPage.evaluate(() => localStorage.getItem('synthetic-original'));
      const stream = await download.createReadStream();
      assert(stream !== null, 'Recovery download stream missing');
      const chunks = [];
      for await (const chunk of stream) chunks.push(chunk);
      assert(Buffer.concat(chunks).equals(Buffer.from(original, 'utf8')), 'Recovery download changed original bytes');
      await body.fill('New synthetic writing.');
      await testPage.waitForTimeout(500);
      await testPage.evaluate(() => window.dispatchEvent(new Event('pagehide')));
      const state = await testPage.evaluate(() => ({
        raw: localStorage.getItem('synthetic-original'),
        current: localStorage.getItem('between.documents.v1'),
        backup: localStorage.getItem('between.documents.v1.recovery'),
      }));
      if (failBackup) {
        assert(state.current === state.raw, 'Autosave or pagehide overwrote unbacked original data');
        assert(state.backup === null, 'Failure fixture unexpectedly created a backup');
      } else {
        assert(state.backup === state.raw, 'Recovery backup did not preserve original bytes');
        assert(JSON.parse(state.current)[0].content.content[0].content[0].text === 'New synthetic writing.', 'Recovered document did not save');
      }
      await testPage.screenshot({ path: `output/playwright/storage-recovery-${failBackup ? 'blocked' : 'saved'}.png`, fullPage: true });
      await testPage.reload();
      await body.waitFor({ state: 'visible' });
      await testPage.waitForTimeout(500);
      const reloaded = await testPage.evaluate(() => ({
        current: localStorage.getItem('between.documents.v1'),
        backup: localStorage.getItem('between.documents.v1.recovery'),
        backupCount: Object.keys(localStorage).filter(key => key.startsWith('between.documents.v1.recovery')).length,
      }));
      if (failBackup) {
        assert(reloaded.current === state.raw, 'Reload overwrote unbacked original data');
        assert(reloaded.backup === null && reloaded.backupCount === 0, 'Reload bypassed backup failure');
        assert((await body.innerText()).includes('Synthetic words to recover.'), 'Reload did not recover original readable draft');
        assert(!(await body.innerText()).includes('New synthetic writing.'), 'Paused session unexpectedly saved new writing');
        await warning.waitFor({ state: 'visible' });
        assert((await warning.innerText()).includes('Saving is paused'), 'Reload lost backup failure warning');
      } else {
        assert(reloaded.current === state.current, 'Repaired collection changed after reload');
        assert(reloaded.backup === state.raw && reloaded.backupCount === 1, 'Reload replaced or duplicated original backup');
        assert((await body.innerText()).includes('New synthetic writing.'), 'Reload lost saved recovered draft edits');
        await warning.waitFor({ state: 'hidden' });
      }
      assert(errors.length === 0, errors.join('\n'));
      checks.push(failBackup
        ? 'Exact recovery download; failed backup blocks autosave, pagehide, and reload writes'
        : 'Exact recovery download; repaired collection and original backup survive reload');
    } finally {
      await context.close();
    }
  }
  return { ok: true, checks };
}
