async (page) => {
  // Run through playwright-cli run-code --filename=scripts/browser-check.js.
  // All API calls are mocked in a fresh context. The user's page is never changed.
  const browser = page.context().browser();
  if (!browser) throw new Error('An independent browser context is required for this check.');
  const base = new URL(page.url()).origin;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 }, reducedMotion: 'reduce' });
  const testPage = await context.newPage();
  const passes = [];
  const requests = { decide: [], generate: [], unexpected: [] };
  const pageErrors = [];
  const releases = [];
  let decisionHandler = () => ({ intent: 'prompting', action: 'insert' });
  let generationHandler = () => ({ text: 'A useful sentence.' });
  let stage = 'setup';
  const assert = (condition, message) => { if (!condition) throw new Error(message); };
  const deferred = () => {
    let resolve;
    const promise = new Promise(r => { resolve = r; });
    releases.push(resolve);
    return { promise, resolve };
  };
  const until = async (predicate, message, timeout = 7000) => {
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) {
      if (await predicate()) return;
      await testPage.waitForTimeout(25);
    }
    throw new Error(message);
  };
  testPage.on('pageerror', error => pageErrors.push(error.message));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) {
      requests.unexpected.push(url.origin);
      return route.abort();
    }
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) return route.continue();
    try {
      if (pathname === '/api/health') {
        await route.fulfill({ json: { configured: true, decisionModel: 'browser-mock', generationModel: 'browser-mock' } });
      } else if (pathname === '/api/decide') {
        const input = route.request().postDataJSON();
        requests.decide.push(input);
        const response = await decisionHandler(input);
        await route.fulfill({ status: response.status || 200, json: response.error ? { error: response.error } : { confidence: 0.99, latencyMs: 12, model: 'browser-mock', ...response } });
      } else if (pathname === '/api/generate') {
        const input = route.request().postDataJSON();
        requests.generate.push(input);
        const response = await generationHandler(input);
        if (response.error) await route.fulfill({ status: response.status || 500, json: { error: response.error } });
        else {
          const frames = [{ type: 'delta', text: response.text }];
          if (!response.incomplete) frames.push({ type: 'done', latencyMs: 24, model: 'browser-mock' });
          await route.fulfill({ contentType: 'text/event-stream', body: frames.map(frame => `data: ${JSON.stringify(frame)}\n\n`).join('') });
        }
      } else {
        requests.unexpected.push(pathname);
        await route.abort();
      }
    } catch (error) {
      // An intentional browser AbortController cancellation can close this route.
      if (!/closed|disposed|intercept|abort|cancel/i.test(String(error))) pageErrors.push(String(error));
    }
  });
  const body = testPage.getByRole('textbox', { name: 'Document body', exact: true });
  const title = testPage.getByRole('textbox', { name: 'Document title', exact: true });
  const picker = testPage.getByRole('combobox', { name: 'Choose document', exact: true });
  const toolbar = testPage.getByRole('toolbar', { name: 'Text formatting', exact: true });
  const undo = toolbar.getByRole('button', { name: 'Undo', exact: true });
  const redo = toolbar.getByRole('button', { name: 'Redo', exact: true });
  const promptButton = testPage.getByRole('button', { name: /Make it happen/ });
  const newDocument = async name => {
    await testPage.getByRole('button', { name: 'New document', exact: true }).click();
    await title.fill(name);
    assert(await undo.isDisabled(), `Fresh document ${name} inherited undo history`);
    return picker.inputValue();
  };
  const runPrompt = async () => {
    await promptButton.waitFor({ state: 'visible', timeout: 7000 });
    await body.press('Enter');
  };
  const editable = async () => until(async () => await body.getAttribute('contenteditable') === 'true', 'Editor stayed locked after request');
  const visibleText = async () => (await body.innerText()).trim();
  const waitForText = async text => until(async () => (await visibleText()).includes(text), `Missing editor text: ${text}`);
  try {
    await testPage.goto(base, { waitUntil: 'domcontentloaded' });
    await testPage.getByRole('button', { name: 'Document', exact: true }).click();
    await body.waitFor({ state: 'visible' });
    await testPage.locator('body').ariaSnapshot();
    assert(await testPage.getByRole('button', { name: 'New document', exact: true }).count() === 1, 'Expected editor UI was not found');

    stage = 'automatic rewrite, formatting, undo and redo';
    const rewriteId = await newDocument('Browser check: rewrite');
    await body.fill('First fact. Second fact.');
    decisionHandler = () => ({ intent: 'prompting', action: 'rewrite' });
    generationHandler = input => {
      assert(input.action === 'rewrite', 'Rewrite classification did not reach generation');
      assert(input.context.includes('First fact.'), 'Rewrite lost existing context');
      assert(!input.context.includes('Turn this into a bullet list'), 'Prompt leaked into surrounding context');
      return { text: '- **First fact.**\n- Second fact.' };
    };
    await testPage.getByRole('button', { name: 'Turn this into a bullet list', exact: false }).click();
    await runPrompt();
    await until(async () => await body.locator('ul > li').count() === 2, 'Rewrite did not create a real two-item list');
    assert(await body.locator('strong').innerText() === 'First fact.', 'Rewrite did not create actual bold formatting');
    assert(!(await visibleText()).includes('Turn this into'), 'Rewrite retained its prompt');
    await editable();
    await undo.click();
    await waitForText('First fact. Second fact.');
    assert((await visibleText()).includes('Turn this into a bullet list'), 'One undo did not restore original writing and prompt');
    await redo.click();
    await until(async () => await body.locator('ul > li').count() === 2, 'Redo did not restore generated structure');
    await testPage.screenshot({ path: 'output/playwright/browser-check-rewrite.png', fullPage: true });
    passes.push('automatic rewrite produces lists and bold; one-step undo/redo');

    stage = 'automatic insertion';
    await newDocument('Browser check: insertion');
    await body.fill('The garden was quiet.');
    decisionHandler = () => ({ intent: 'prompting', action: 'insert' });
    generationHandler = input => {
      assert(input.action === 'insert', 'Insertion did not preserve classified action');
      return { text: 'Then the **rain** arrived.' };
    };
    await testPage.getByRole('button', { name: 'Continue the thought', exact: false }).click();
    await runPrompt();
    await waitForText('Then the rain arrived.');
    assert((await visibleText()).includes('The garden was quiet.'), 'Insertion replaced pre-existing writing');
    assert(!(await visibleText()).includes('Continue the thought'), 'Insertion retained the prompt');
    assert(await body.locator('strong').innerText() === 'rain', 'Insertion did not preserve bold');
    passes.push('automatic insertion preserves existing prose and replaces only prompt');

    stage = 'nested paragraph prompting';
    await editable();
    await newDocument('Browser check: nested paragraph');
    await body.fill('Give me a garden idea');
    await toolbar.getByRole('button', { name: 'Bullet list', exact: true }).click();
    assert(await body.locator('li').count() === 1, 'Nested prompt fixture is not a list');
    generationHandler = () => ({ text: 'Try a **small herb garden**.' });
    await runPrompt();
    await waitForText('Try a small herb garden.');
    assert(!(await visibleText()).includes('Give me a garden idea'), 'Nested prompt was not replaced');
    assert(await body.locator('strong').innerText() === 'small herb garden', 'Nested replacement lost formatting');
    passes.push('prompting inside a nested list paragraph');

    stage = 'document history isolation';
    await editable();
    await picker.selectOption(rewriteId);
    assert(await undo.isDisabled(), 'Switching documents retained previous undo history');
    assert(await redo.isDisabled(), 'Switching documents retained previous redo history');
    const rewriteText = await visibleText();
    const independentId = await newDocument('Browser check: independent');
    await body.fill('Only this page owns this sentence.');
    await picker.selectOption(rewriteId);
    assert(await visibleText() === rewriteText, 'Editing another page changed the rewrite page');
    assert(await undo.isDisabled(), 'Returning to document exposed cross-document undo');
    await picker.selectOption(independentId);
    assert(await visibleText() === 'Only this page owns this sentence.', 'Document switching lost the independent page');
    assert(await undo.isDisabled(), 'Independent page retained history from another page');
    passes.push('new documents and document switches isolate undo and preserve contents');

    stage = 'immediate reload persistence';
    await body.fill('Immediate reload must retain this exact last edit.');
    await testPage.reload({ waitUntil: 'domcontentloaded' });
    await body.waitFor({ state: 'visible' });
    await picker.selectOption(independentId);
    assert(await visibleText() === 'Immediate reload must retain this exact last edit.', 'Reload before debounce lost the most recent writing');
    passes.push('immediate reload persists the latest edit');

    stage = 'cancel preserves document';
    await newDocument('Browser check: cancellation');
    await body.fill('Write a calm opening sentence');
    const cancelGate = deferred();
    let generationStarted = false;
    generationHandler = async () => { generationStarted = true; await cancelGate.promise; return { text: 'This cancelled output must not appear.' }; };
    await runPrompt();
    await until(() => generationStarted, 'Cancellation request never reached mock');
    await testPage.getByRole('button', { name: /^Stop/ }).click();
    await testPage.getByText('Stopped. Your writing is unchanged.', { exact: true }).waitFor({ state: 'visible' });
    cancelGate.resolve();
    await editable();
    assert(await visibleText() === 'Write a calm opening sentence', 'Cancellation changed the document');
    passes.push('cancel unlocks editor and keeps original writing');

    stage = 'API error preserves document';
    await newDocument('Browser check: API error');
    await body.fill('Write three opening ideas');
    generationHandler = () => ({ status: 429, error: 'Controlled quota error. Your writing is unchanged.' });
    await runPrompt();
    await testPage.getByText('Controlled quota error. Your writing is unchanged.', { exact: true }).waitFor({ state: 'visible' });
    await editable();
    assert(await visibleText() === 'Write three opening ideas', 'API error changed original writing');
    passes.push('API errors unlock editor and preserve writing');

    stage = 'incomplete stream preserves document';
    await newDocument('Browser check: incomplete stream');
    await body.fill('Write a short ending');
    generationHandler = () => ({ text: 'Unfinished draft', incomplete: true });
    await runPrompt();
    await testPage.getByText('The response was incomplete. Your writing is unchanged.', { exact: true }).waitFor({ state: 'visible' });
    await editable();
    assert(await visibleText() === 'Write a short ending', 'Incomplete stream replaced original writing');
    passes.push('incomplete streams never replace writing');

    stage = 'stale classification';
    await newDocument('Browser check: stale classification');
    const staleGate = deferred();
    let staleStarted = false;
    let newDecisionReturned = false;
    decisionHandler = async input => {
      if (input.text === 'Write a vivid opening') { staleStarted = true; await staleGate.promise; return { intent: 'prompting', action: 'insert' }; }
      newDecisionReturned = true;
      return { intent: 'writing', action: 'insert' };
    };
    await body.fill('Write a vivid opening');
    await until(() => staleStarted, 'Old classification never reached mock');
    await body.fill('Rain softened the edges of the garden.');
    await until(() => newDecisionReturned, 'New writing was never classified');
    staleGate.resolve();
    await testPage.waitForTimeout(150);
    assert(await promptButton.count() === 0, 'Stale response incorrectly turned new writing into a prompt');
    assert(await body.locator('.is-prompt').count() === 0, 'Stale response decorated the new writing');
    assert(await visibleText() === 'Rain softened the edges of the garden.', 'Stale decision mutated writing');
    passes.push('stale classification cannot override newer writing');

    stage = 'generated HTML sanitization and safe links';
    await newDocument('Browser check: safe output');
    decisionHandler = () => ({ intent: 'prompting', action: 'insert' });
    generationHandler = () => ({ text: 'Read the [source](https://example.com/report).\n\n<script>window.__betweenUnsafe=true</script><img src=x onerror="window.__betweenUnsafe=true"><a href="javascript:alert(1)">Unsafe link</a>' });
    await body.fill('Add a source link');
    await runPrompt();
    await waitForText('Read the source.');
    await editable();
    assert(await body.locator('script, img, [onerror], [onclick], a[href^="javascript:"]').count() === 0, 'Unsafe generated markup survived sanitization');
    assert(await body.getByRole('link', { name: 'source', exact: true }).getAttribute('href') === 'https://example.com/report', 'Safe source link was stripped');
    assert(await testPage.evaluate(() => !window.__betweenUnsafe), 'Generated script executed');
    await testPage.screenshot({ path: 'output/playwright/browser-check-safe-output.png', fullPage: true });
    passes.push('generated HTML is sanitized while safe links remain');

    stage = 'safe link survives a rewrite round trip';
    decisionHandler = () => ({ intent: 'prompting', action: 'rewrite' });
    generationHandler = input => {
      assert(input.context.includes('[source](https://example.com/report)'), 'Existing hyperlink destination was lost before the rewrite request');
      return { text: 'Please read the [source](https://example.com/report).' };
    };
    await testPage.getByRole('button', { name: 'Make this a little warmer', exact: false }).click();
    await runPrompt();
    await waitForText('Please read the source.');
    await editable();
    assert(await body.getByRole('link', { name: 'source', exact: true }).getAttribute('href') === 'https://example.com/report', 'Rewrite round trip stripped a safe link destination');
    passes.push('existing safe hyperlinks survive serialization and rewrite insertion');

    stage = 'immediate Enter runs an undetected prompt';
    await newDocument('Browser check: immediate prompt');
    const immediatePromptGate = deferred();
    let immediatePromptStarted = false;
    decisionHandler = async input => {
      assert(input.text === 'Write a sentence about spring', 'Immediate Enter classified the wrong paragraph');
      immediatePromptStarted = true;
      await immediatePromptGate.promise;
      return { intent: 'prompting', action: 'insert' };
    };
    generationHandler = input => {
      assert(input.prompt === 'Write a sentence about spring', 'Immediate Enter generated from the new empty paragraph');
      return { text: 'Spring arrived with **quiet light**.' };
    };
    await body.fill('Write a sentence about spring');
    await body.press('Enter');
    await until(() => immediatePromptStarted, 'Enter did not immediately classify the submitted prompt', 1500);
    assert(await body.locator('p').count() >= 2, 'Immediate Enter did not create its native newline while classification was pending');
    assert(await promptButton.count() === 0, 'Immediate prompt unexpectedly depended on a previously detected prompt button');
    immediatePromptGate.resolve();
    await waitForText('Spring arrived with quiet light.');
    await editable();
    assert(!(await visibleText()).includes('Write a sentence about spring'), 'Immediate prompt was not replaced');
    assert(await body.locator('strong').innerText() === 'quiet light', 'Immediate prompt lost generated formatting');
    passes.push('Enter before detection creates a newline immediately, then runs a confirmed prompt');

    stage = 'immediate Enter keeps prose and its newline';
    await newDocument('Browser check: immediate prose');
    const proseGate = deferred();
    let proseDecisionStarted = false;
    const proseGenerationCount = requests.generate.length;
    decisionHandler = async () => {
      proseDecisionStarted = true;
      await proseGate.promise;
      return { intent: 'writing', action: 'insert' };
    };
    await body.fill('The windows were bright in the morning.');
    await body.press('Enter');
    await until(() => proseDecisionStarted, 'Enter did not classify the submitted prose', 1500);
    const proseWithNewline = await body.innerHTML();
    assert(await body.locator('p').count() === 2, 'Prose Enter did not create exactly one paragraph break');
    proseGate.resolve();
    await until(async () => (await testPage.getByText('Reading the room', { exact: true }).count()) === 0, 'Prose classification stayed pending');
    assert(await body.innerHTML() === proseWithNewline, 'Prose classification changed writing or removed its newline');
    assert(requests.generate.length === proseGenerationCount, 'Prose Enter triggered generation');
    passes.push('Enter before detection leaves prose and its newline unchanged');

    stage = 'new typing invalidates the immediate Enter request';
    await newDocument('Browser check: immediate stale prompt');
    const immediateStaleGate = deferred();
    let submittedRequestStarted = false;
    let nextParagraphClassified = false;
    const immediateStaleGenerationCount = requests.generate.length;
    decisionHandler = async input => {
      if (input.text === 'Write a stormy opening') {
        submittedRequestStarted = true;
        await immediateStaleGate.promise;
        return { intent: 'prompting', action: 'insert' };
      }
      nextParagraphClassified = true;
      return { intent: 'writing', action: 'insert' };
    };
    generationHandler = () => ({ text: 'This stale generation must never appear.' });
    await body.fill('Write a stormy opening');
    await body.press('Enter');
    await until(() => submittedRequestStarted, 'Immediate stale prompt did not start its decision request', 1500);
    await testPage.keyboard.insertText('I decided to keep writing this myself.');
    const newerWriting = await body.innerHTML();
    immediateStaleGate.resolve();
    await until(() => nextParagraphClassified, 'Typing on the next paragraph was not classified');
    await testPage.waitForTimeout(150);
    assert(await body.innerHTML() === newerWriting, 'Late immediate-Enter result overwrote new typing');
    assert((await visibleText()).includes('I decided to keep writing this myself.'), 'Next paragraph typing was lost');
    assert(requests.generate.length === immediateStaleGenerationCount, 'Stale submitted paragraph still triggered generation');
    assert(await promptButton.count() === 0, 'Stale submitted paragraph surfaced a prompt action after new typing');
    passes.push('typing after immediate Enter invalidates its pending result and preserves both paragraphs');

    assert(requests.unexpected.length === 0, `Unexpected API routes: ${requests.unexpected.join(', ')}`);
    assert(pageErrors.length === 0, `Browser exceptions: ${pageErrors.join('; ')}`);
    return { ok: true, mocked: true, liveApiCalls: 0, passes, apiRequests: { decide: requests.decide.length, generate: requests.generate.length }, screenshots: ['output/playwright/browser-check-rewrite.png', 'output/playwright/browser-check-safe-output.png'], userPageUnchanged: true };
  } catch (error) {
    await testPage.screenshot({ path: 'output/playwright/browser-check-failure.png', fullPage: true }).catch(() => {});
    throw new Error(JSON.stringify({ ok: false, stage, error: String(error), passes, pageErrors, apiRequests: { decide: requests.decide.length, generate: requests.generate.length }, screenshot: 'output/playwright/browser-check-failure.png', userPageUnchanged: true }));
  } finally {
    for (const release of releases) release();
    await context.close();
  }
}
