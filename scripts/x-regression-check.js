async (page) => {
  // Run through playwright-cli in an isolated context. Every API is mocked;
  // this test never submits a real AI request or opens an X composer.
  const browser = page.context().browser();
  if (!browser) throw new Error('A browser context is required.');
  const base = /^https?:\/\/(127\.0\.0\.1|localhost)(:|\/)/.test(page.url())
    ? new URL(page.url()).origin : 'http://127.0.0.1:4173';
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(15000);
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const testPage = await context.newPage();
  const passes = [];
  const errors = [];
  const requests = [];
  const pendingCommand = 'Make my thought more concise';
  const draft = 'A good tool leaves room for human judgment.';
  const source = {
    url: 'https://x.com/fixture/status/12345', authorName: 'Fixture Author',
    text: 'A synthetic reference about tools.', source: 'x', textStatus: 'full',
  };
  let generationHandler = () => ({ text: 'A synthetic revision.' });
  let referenceHandler = () => source;
  const unblockers = [];
  const deferred = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    unblockers.push(resolve);
    return { promise, resolve };
  };
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const until = async (predicate, message) => {
    const deadline = Date.now() + 12000;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await testPage.waitForTimeout(25);
    }
    throw new Error(message);
  };
  testPage.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) return route.abort();
    if (!url.pathname.startsWith('/api/')) return route.continue();
    if (url.pathname === '/api/health')
      return route.fulfill({ json: { configured: true, decisionModel: 'fixture', generationModel: 'fixture' } });
    const input = route.request().postDataJSON();
    requests.push({ path: url.pathname, input });
    if (url.pathname === '/api/decide')
      return route.fulfill({ json: {
        intent: input.text === pendingCommand ? 'prompting' : 'writing',
        action: input.text === pendingCommand ? 'rewrite' : 'insert',
        confidence: 0.99, latencyMs: 1, model: 'fixture',
      } });
    if (url.pathname === '/api/generate') {
      const output = await generationHandler(input);
      return route.fulfill({ contentType: 'text/event-stream', body: [
        { type: 'delta', text: output.text }, { type: 'done', latencyMs: 1, model: 'fixture' },
      ].map(event => `data: ${JSON.stringify(event)}\n\n`).join('') });
    }
    if (url.pathname === '/api/x/reference') return route.fulfill({ json: await referenceHandler(input) });
    errors.push(`Unexpected API request: ${url.pathname}`);
    return route.abort();
  });
  const seed = [
    { id: 'regression-document', title: 'Document fixture', mode: 'document', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Original document fixture.' }] }] }, updated: 1 },
    { id: 'regression-x-older', title: 'Earlier X draft', mode: 'x', reference: source, includeSource: true, content: { type: 'doc', content: [{ type: 'paragraph' }] }, updated: 2 },
    { id: 'regression-x-newer', title: 'Later X draft', mode: 'x', content: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: pendingCommand }] }] }, updated: 3 },
  ];
  await context.addInitScript(({ docs }) => {
    if (sessionStorage.getItem('x-regression-seeded')) return;
    localStorage.setItem('between.documents.v1', JSON.stringify(docs));
    localStorage.setItem('between.active.v1', 'regression-x-older');
    sessionStorage.setItem('x-regression-seeded', 'true');
  }, { docs: seed });
  const body = testPage.getByRole('textbox', { name: 'Document body', exact: true });
  const picker = testPage.getByRole('combobox', { name: 'Choose document', exact: true });
  const xMode = testPage.getByRole('button', { name: 'X post', exact: true });
  const documentMode = testPage.getByRole('button', { name: 'Document', exact: true });
  const checkbox = testPage.getByRole('checkbox', { name: 'Include source link', exact: true });
  const copy = async () => {
    await testPage.bringToFront();
    await testPage.getByRole('button', { name: /^(Copy post|Copied)$/ }).click();
    await testPage.getByText('Ready to paste into X.', { exact: true }).waitFor();
    return testPage.evaluate(() => navigator.clipboard.readText());
  };
  const isEditable = () => until(async () => await body.getAttribute('contenteditable') === 'true', 'Editor remained locked');
  let stage = 'load';
  try {
    await testPage.goto(base, { waitUntil: 'domcontentloaded' });
    await body.waitFor();

    stage = 'mode remembers the active draft';
    await xMode.click();
    assert(await picker.inputValue() === 'regression-x-older', 'Clicking selected X mode switched drafts');
    await documentMode.click();
    await xMode.click();
    assert(await picker.inputValue() === 'regression-x-older', 'Mode switch restored newest rather than last active X draft');
    await picker.selectOption('regression-x-newer');
    await picker.selectOption('regression-x-older');
    await documentMode.click();
    await xMode.click();
    assert(await picker.inputValue() === 'regression-x-older', 'Last selected X draft was not remembered');
    passes.push('selected mode is a no-op and switching back restores the last active draft');

    stage = 'detect and retain inline prompt exclusion';
    await body.fill(draft);
    await body.press('ControlOrMeta+End');
    await body.press('Enter');
    await testPage.keyboard.insertText(pendingCommand);
    await testPage.getByRole('button', { name: /Make it happen/ }).waitFor();
    assert(await copy() === `${draft}\n\n${source.url}`, 'Detected instruction was copied');
    await body.locator('p').first().click();
    assert(await copy() === `${draft}\n\n${source.url}`, 'Selecting another paragraph leaked the command');
    await checkbox.uncheck();
    assert(await copy() === draft, 'Changing source inclusion leaked the command');
    await checkbox.check();
    assert(await copy() === `${draft}\n\n${source.url}`, 'Re-enabling the source leaked the command');
    await until(async () => testPage.evaluate(command => {
      const docs = JSON.parse(localStorage.getItem('between.documents.v1'));
      return docs.find(doc => doc.id === 'regression-x-older').pendingPrompts?.includes(command);
    }, pendingCommand), 'Remembered command was not saved');
    await testPage.reload({ waitUntil: 'domcontentloaded' });
    await body.waitFor();
    assert(await copy() === `${draft}\n\n${source.url}`, 'Reload lost the command exclusion');
    passes.push('identified instructions stay out of copy after selection changes, source toggles, and reload');

    stage = 'shelf context and exact plaintext generation';
    const literalOutput = 'Keep *literal* marks and <human> judgment.\nA single line break.\n\n# A literal label, not a heading.\n> Still literal text.';
    generationHandler = input => {
      assert(input.context === draft, 'Editorial shelf sent a pending command or Markdown as draft context');
      assert(input.action === 'rewrite', 'Editorial shelf did not request a rewrite');
      assert(input.reference?.text === source.text, 'Editorial shelf lost source context');
      return { text: literalOutput };
    };
    await testPage.getByRole('button', { name: 'Sharpen the draft', exact: true }).click();
    await testPage.getByRole('button', { name: /^Cut the filler/ }).click();
    await isEditable();
    await until(async () => (await body.innerText()).includes('<human>'), 'Literal X output was changed by Markdown/HTML parsing');
    assert(await copy() === `${literalOutput}\n\n${source.url}`, 'X output changed literal markup or line breaks');
    assert(await body.locator('strong, em, h2, h3, blockquote').count() === 0, 'X plain text produced Markdown formatting');
    passes.push('editorial shelf excludes commands; generated X text preserves literal markup and all line breaks');

    stage = 'undo retains safe copy and false positives can be writing';
    await testPage.getByRole('toolbar', { name: 'Text formatting' }).getByRole('button', { name: 'Undo', exact: true }).click();
    assert((await body.innerText()).includes(pendingCommand), 'Undo did not restore the original instruction');
    assert(await copy() === `${draft}\n\n${source.url}`, 'Undo leaked a restored instruction into copy');
    await testPage.getByRole('button', { name: 'Treat as writing', exact: true }).click();
    assert(await copy() === `${draft}\n\n${pendingCommand}\n\n${source.url}`, 'Treat as writing did not restore the intended prose');
    await checkbox.uncheck();
    assert(await copy() === `${draft}\n\n${pendingCommand}`, 'Treated-as-writing paragraph was excluded again');
    assert(await testPage.getByRole('button', { name: 'Treat as writing', exact: true }).count() === 0, 'False-positive override left an exclusion warning');
    passes.push('Undo restores commands without copying them; Treat as writing reverses false positives');

    stage = 'command memory belongs to one document';
    await picker.selectOption('regression-x-newer');
    assert(await copy() === pendingCommand, 'Known command text was excluded in a different document');
    passes.push('identified command memory does not affect another document');

    stage = 'source arriving during generation is deferred, not discarded';
    await picker.selectOption('regression-x-older');
    await body.fill(draft);
    const secondSource = { ...source, url: 'https://x.com/fixture/status/98765', text: 'A different synthetic source, loaded during editing.' };
    const sourceGate = deferred();
    const generationGate = deferred();
    referenceHandler = async () => { await sourceGate.promise; return secondSource; };
    const beforeGeneration = requests.filter(request => request.path === '/api/generate').length;
    generationHandler = async input => {
      assert(input.reference.text === source.text, 'In-flight generation lost its original source snapshot');
      await generationGate.promise;
      return { text: 'A generated thought from the original source.' };
    };
    await testPage.getByRole('textbox', { name: 'X post link', exact: true }).fill(secondSource.url);
    await testPage.getByRole('button', { name: 'Load reference post', exact: true }).click();
    await testPage.getByRole('button', { name: 'Sharpen the draft', exact: true }).click();
    await testPage.getByRole('button', { name: /^Cut the filler/ }).click();
    await until(() => Promise.resolve(requests.filter(request => request.path === '/api/generate').length > beforeGeneration), 'Generation did not begin while source was loading');
    sourceGate.resolve();
    await testPage.getByText('Reference ready. Finishing the current edit…', { exact: true }).waitFor();
    generationGate.resolve();
    await isEditable();
    await testPage.getByRole('complementary', { name: 'Reference post' }).getByText(secondSource.text, { exact: true }).waitFor();
    assert((await body.innerText()).trim() === 'A generated thought from the original source.', 'Deferred source update discarded the completed rewrite');
    await checkbox.check();
    assert(await copy() === `A generated thought from the original source.\n\n${secondSource.url}`, 'Deferred source was not reflected in copy');
    passes.push('source loading during generation waits for completion and then updates the correct draft');

    assert(errors.length === 0, `Browser errors: ${errors.join('; ')}`);
    return { ok: true, mocked: true, liveApiCalls: 0, passed: passes.length, checks: passes, apiRequests: requests.length, errors };
  } catch (error) {
    return { failed: stage, error: String(error), passed: passes, errors };
  } finally {
    for (const unblock of unblockers) unblock();
    await context.close();
  }
}
