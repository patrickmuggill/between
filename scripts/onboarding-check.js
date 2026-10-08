async (page) => {
  const browser = page.context().browser();
  const base = new URL(page.url()).origin;
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, reducedMotion: 'reduce' });
  context.setDefaultTimeout(15000);
  await context.addInitScript({ path: 'node_modules/axe-core/axe.min.js' });
  await context.addInitScript(() => {
    window.securityEvents = [];
    document.addEventListener('securitypolicyviolation', event => window.securityEvents.push(event.violatedDirective));
  });
  await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin: base });
  const p = await context.newPage();
  const errors = [];
  const passes = [];
  const requests = { decide: 0, generate: 0 };
  let configured = false;
  p.on('pageerror', error => errors.push(error.message));
  await context.route('**/*', async route => {
    const url = new URL(route.request().url());
    if (url.origin !== base) { errors.push('Unexpected external request'); return route.abort(); }
    if (url.pathname === '/api/health') return route.fulfill({ json: { configured, decisionModel: 'fixture', generationModel: 'fixture' } });
    if (url.pathname === '/api/decide') {
      requests.decide += 1;
      return route.fulfill({ json: { intent: 'writing', action: 'insert', confidence: 1, latencyMs: 1, model: 'fixture' } });
    }
    if (url.pathname === '/api/generate') { requests.generate += 1; errors.push('Unexpected generation'); return route.abort(); }
    return route.continue();
  });
  const assert = (value, message) => { if (!value) throw new Error(message); };
  const audit = async name => {
    const violations = await p.evaluate(async () => (await window.axe.run(document, { runOnly: { type: 'tag', values: ['wcag2a', 'wcag2aa', 'wcag21aa'] } })).violations.map(v => ({ id: v.id, nodes: v.nodes.map(n => n.target) })));
    assert(!violations.length, name + ' accessibility: ' + JSON.stringify(violations));
  };
  let stage = 'fresh X workspace';
  try {
    await p.goto(base);
    const body = p.getByRole('textbox', { name: 'Document body', exact: true });
    await p.getByRole('button', { name: 'Set up OpenAI', exact: true }).waitFor();
    assert(await p.getByRole('button', { name: 'X post', exact: true }).getAttribute('aria-pressed') === 'true', 'Fresh install did not start in X mode');
    assert((await body.innerText()).trim() === '', 'Fresh draft contains unwanted demo writing');
    assert(!await p.getByText(/THE SPARK|YOUR TAKE|A LITTLE EDITORIAL HELP|local demo/).count(), 'Decorative labels returned');
    await body.fill('A thoughtful post starts with an idea worth keeping.');
    await body.press('End');
    await body.press('Enter');
    await p.waitForTimeout(800);
    assert(requests.decide === 0 && requests.generate === 0, 'Writing without a key attempted AI requests');
    await p.getByRole('button', { name: 'Copy post', exact: true }).click();
    await p.getByText('Ready to paste into X.', { exact: true }).waitFor();
    assert(await p.evaluate(() => navigator.clipboard.readText()) === 'A thoughtful post starts with an idea worth keeping.', 'Key-free copy changed the draft');
    passes.push('fresh X mode, quiet interface, editing and copying work without a key or API calls');

    stage = 'safe setup dialog';
    await p.getByRole('button', { name: 'Set up OpenAI', exact: true }).click();
    const dialog = p.getByRole('dialog', { name: 'Connect OpenAI' });
    await dialog.waitFor();
    assert(await dialog.locator('code').innerText() === 'npm run setup', 'Setup command missing');
    assert(await dialog.locator('input').count() === 0, 'A browser secret-entry field was added');
    await audit('desktop connection dialog');
    await p.setViewportSize({ width: 390, height: 844 });
    await audit('mobile connection dialog');
    assert(!await p.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), 'Mobile dialog overflows');
    await p.screenshot({ path: 'output/playwright/onboarding-mobile.png', fullPage: true });
    passes.push('accessible setup dialog uses a hidden terminal prompt, without a browser key field');

    stage = 'configuration refresh';
    configured = true;
    await dialog.getByRole('button', { name: 'Check connection', exact: true }).click();
    await dialog.getByText('A key is configured.', { exact: false }).waitFor();
    await p.getByRole('button', { name: 'Close OpenAI settings' }).click();
    await p.getByRole('button', { name: 'Auto-detect on', exact: true }).waitFor();
    await body.fill('A newly configured writing session.');
    await p.waitForTimeout(900);
    assert(requests.decide === 1, 'Configuration refresh did not enable exactly one debounced decision');
    assert(!errors.length, JSON.stringify(errors));
    assert((await p.evaluate(() => window.securityEvents)).length === 0, 'Normal UI violated Content Security Policy');
    await audit('mobile configured workspace');
    passes.push('configuration refresh enables detection, with no runtime or CSP violations');
    return { ok: true, passes, mocked: true, liveApiCalls: 0, userPageUnchanged: true };
  } catch (error) {
    await p.screenshot({ path: 'output/playwright/onboarding-failure.png', fullPage: true });
    throw new Error(JSON.stringify({ ok: false, stage, error: String(error), errors }));
  } finally { await context.close(); }
}
