// Disposable Chrome/profile only. PT_TEST_DEPS supplies test-only Playwright.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(path.join(process.env.PT_TEST_DEPS, 'node_modules/playwright'));
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-typer-rate-'));
const extension = path.join(scratch, 'extension');
fs.mkdirSync(extension);
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && /\.(js|html|json|png)$/.test(entry.name)) {
    fs.copyFileSync(path.join(root, entry.name), path.join(extension, entry.name));
  }
}
fs.cpSync(path.join(root, 'content'), path.join(extension, 'content'), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
manifest.host_permissions = ['http://127.0.0.1/*'];
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<textarea id="target"></textarea>');
});

(async () => {
  let context;
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
      headless: true, channel: 'chrome', ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging']
    });
    context.setDefaultTimeout(5000);
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    await worker.evaluate(() => chrome.storage.local.set({ pasteTyperSettings: {
      text: 'saved source', speed: '50', typoChance: '5'
    } }));
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url?.startsWith('http://127.0.0.1:')).id);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.waitForFunction(() => document.getElementById('textInput').value === 'saved source');
    assert.equal(await popup.locator('#typoChanceValue').textContent(), '5%');
    await popup.evaluate(tabId => { chrome.tabs.query = async () => [{ id: tabId }]; }, tabId);
    await worker.evaluate(tabId => frameRouter.route(tabId, { action: 'toggleFloatingUI' }), tabId);
    const panel = page.locator('#paste-typer-floating-ui');
    await panel.locator('#textInput').waitFor();
    await page.waitForFunction(() => document.getElementById('paste-typer-floating-ui').shadowRoot.getElementById('textInput').value === 'saved source');
    assert.equal(await panel.locator('#typoChanceValue').textContent(), '5%');
    for (const view of [popup, panel]) {
      for (const rate of ['0', '5', '10']) {
        await view.locator('#typoChanceSlider').fill(rate);
        // Range fill dispatches synthetic input; physical keys exercise the
        // floating controller's trusted-event boundary.
        await view.locator('#typoChanceSlider').press('ArrowRight');
        await view.locator('#typoChanceSlider').press('ArrowLeft');
        assert.equal(await view.locator('#typoChanceValue').textContent(), `${rate}%`);
        await popup.waitForFunction(async rate => (await chrome.storage.local.get('pasteTyperSettings')).pasteTyperSettings.typoChance === rate, rate);
      }
    }
    console.log('PASS saved 5 remains 5%, and both real controls display/save 0%, 5%, 10%');
    await page.locator('#target').focus();
    await panel.locator('#textInput').fill('OK');
    await panel.locator('#typoChanceSlider').fill('0');
    await panel.locator('#typoChanceSlider').press('ArrowRight');
    await panel.locator('#typoChanceSlider').press('ArrowLeft');
    await popup.waitForFunction(async () => (await chrome.storage.local.get('pasteTyperSettings')).pasteTyperSettings.typoChance === '0');
    await panel.locator('#startTyping').click();
    await page.waitForFunction(() => document.getElementById('target').value === 'OK');
    assert.equal(await worker.evaluate(async tabId => (await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: () => pasteTyper.typoChance
    }))[0].result, tabId), 0);
    // Repair just the helper while the existing class instances remain alive.
    await worker.evaluate(async tabId => chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: () => {
        globalThis.ptFixtureTyper = pasteTyper;
        delete globalThis.PTTypoRate;
      }
    }), tabId);
    await worker.evaluate(tabId => frameRouter.prepare(tabId), tabId);
    assert.equal(await worker.evaluate(async tabId => (await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] }, world: 'ISOLATED',
      func: () => pasteTyper === globalThis.ptFixtureTyper && PTTypoRate.toProbability('5') === 0.05
    }))[0].result, tabId), true);
    await popup.reload();
    await popup.waitForFunction(() => document.getElementById('typoChanceSlider').value === '0');
    assert.equal(await popup.locator('#typoChanceValue').textContent(), '0%');
    console.log('PASS zero-rate typing, popup reload, and missing-helper repair without class redeclaration');
  } finally {
    await context?.close();
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
