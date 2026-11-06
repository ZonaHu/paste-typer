// Run with PT_TEST_DEPS pointing at test-only Playwright dependencies.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(path.join(process.env.PT_TEST_DEPS, 'node_modules/playwright'));
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-typer-navigation-'));
const extension = path.join(scratch, 'extension');
fs.mkdirSync(extension);
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && /\.(js|html|json|png)$/.test(entry.name)) {
    fs.copyFileSync(path.join(root, entry.name), path.join(extension, entry.name));
  }
}
fs.cpSync(path.join(root, 'content'), path.join(extension, 'content'), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
manifest.host_permissions = ['http://127.0.0.1/*', 'https://chromewebstore.google.com/*']; // Disposable fixture only.
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const fixtures = {
  invalid: `<input id="disabled" disabled><fieldset disabled><input id="disabled-child"></fieldset>
    <input id="readonly" readonly><input id="css-hidden" style="visibility:hidden">
    <div style="opacity:0"><input id="transparent"></div>
    <div style="content-visibility:hidden"><input id="not-rendered"></div><div inert><textarea id="inert"></textarea></div>
    <div id="not-editable" contenteditable="false">not an editor</div>
    <textarea id="message" aria-label="Message"></textarea>`,
  nested: `<div id="editor" contenteditable="true"><p id="paragraph" contenteditable="true">hello</p>
    <div contenteditable="false">locked <div id="separate" contenteditable="true">inner editor</div></div></div>
    <div id="plain" contenteditable="plaintext-only">plain editor</div>`,
  focused: '<input id="search"><textarea id="message"></textarea>',
  dynamic: '<input id="first"><textarea id="message"></textarea>',
  empty: '<input disabled><textarea readonly></textarea>',
};
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(fixtures[req.url.slice(1)] || fixtures.invalid);
});
(async () => {
  let context;
  try {
    await new Promise(resolve => server.listen(0, resolve));
    context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
      headless: true, channel: 'chrome', ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging']
    });
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url?.startsWith('http://127.0.0.1:')).id);
    context.setDefaultTimeout(5000);
    const route = message => worker.evaluate(({ tabId, message }) => frameRouter.route(tabId, message, 0), { tabId, message });
    const selected = () => page.evaluate(() => document.querySelector('.paste-typer-input-selected')?.id);
    const failed = [];
    const check = async (name, fn) => {
      try { await fn(); console.log('PASS', name); }
      catch (error) { console.error('FAIL', name, error.message); failed.push(name); }
    };
    for (const [fixture, expected] of [['invalid', ['message']], ['nested', ['editor', 'separate', 'plain']]]) {
      await check(fixture + ' navigation targets', async () => {
        await page.goto(`http://127.0.0.1:${server.address().port}/${fixture}`);
        const result = await route({ action: 'startInputNavigation' });
        const actual = await page.locator('.paste-typer-input-available').evaluateAll(nodes => nodes.map(node => node.id));
        console.log('candidates:', actual);
        assert.deepEqual(actual, expected);
        assert.equal(result.count, expected.length);
      });
    }
    await check('starts at the explicitly focused field', async () => {
      await page.goto(`http://127.0.0.1:${server.address().port}/focused`);
      await worker.evaluate(tabId => frameRouter.prepare(tabId), tabId);
      await page.locator('#message').focus();
      await route({ action: 'startInputNavigation' });
      assert.equal(await selected(), 'message');
    });
    await check('removed selection is not reported as selected', async () => {
      await page.goto(`http://127.0.0.1:${server.address().port}/dynamic`);
      await route({ action: 'startInputNavigation' });
      await page.locator('#first').evaluate(node => node.remove());
      const result = await route({ action: 'selectCurrentInput' });
      assert.equal(result.success, false);
      assert.equal(await page.locator('#message').evaluate(node => node === document.activeElement), false);
    });
    await check('Next skips controls disabled after navigation starts', async () => {
      await page.goto(`http://127.0.0.1:${server.address().port}/dynamic`);
      await route({ action: 'startInputNavigation' });
      await page.locator('#message').evaluate(node => { node.disabled = true; });
      const result = await route({ action: 'navigateNext' });
      assert.equal(await selected(), 'first');
      assert.equal(result.total, 1);
    });
    await check('Next discovers newly visible fields', async () => {
      await page.goto(`http://127.0.0.1:${server.address().port}/focused`);
      await route({ action: 'startInputNavigation' });
      await page.locator('#message').evaluate(node => { node.hidden = true; });
      await page.evaluate(() => { const input = document.createElement('input'); input.id = 'new-field'; document.body.appendChild(input); });
      const result = await route({ action: 'navigateNext' });
      assert.equal(await selected(), 'new-field');
      assert.equal(result.total, 2);
    });
    await check('empty navigation does not intercept page keyboard controls', async () => {
      await page.goto(`http://127.0.0.1:${server.address().port}/empty`);
      const result = await route({ action: 'startInputNavigation' });
      assert.equal(result.count, 0);
      assert.equal(result.selectedIndex, -1);
      await page.evaluate(() => document.addEventListener('keydown', event => { window.keyWasPrevented = event.defaultPrevented; }));
      await page.keyboard.press('ArrowRight');
      assert.equal(await page.evaluate(() => window.keyWasPrevented), false);
    });
    await check('Select rejects focus redirected by the page', async () => {
      await page.goto(`http://127.0.0.1:${server.address().port}/dynamic`);
      await route({ action: 'startInputNavigation' });
      await page.locator('#first').evaluate(node => { node.onfocus = () => document.getElementById('message').focus(); });
      assert.equal((await route({ action: 'selectCurrentInput' })).success, false);
      assert.equal(await selected(), 'first', 'failed focus keeps the intended target highlighted');
    });
    await check('Select rejects focus redirected into a different nested editing host', async () => {
      await page.goto(`http://127.0.0.1:${server.address().port}/nested`);
      await route({ action: 'startInputNavigation' });
      await page.locator('#editor').evaluate(node => { node.onfocus = () => document.getElementById('separate').focus(); });
      assert.equal((await route({ action: 'selectCurrentInput' })).success, false);
      assert.equal(await selected(), 'editor');
    });
    await check('popup shows the focused candidate index and types into the selected field', async () => {
      await page.goto(`http://127.0.0.1:${server.address().port}/focused`);
      await worker.evaluate(tabId => frameRouter.prepare(tabId), tabId);
      await page.locator('#message').focus();
      const popup = await context.newPage();
      await popup.addInitScript(tabId => { chrome.tabs.query = async () => [{ id: tabId }]; }, tabId);
      await popup.goto(`chrome-extension://${id}/popup.html`);
      await popup.locator('#findInputs').click();
      await popup.locator('#navigationStatus').filter({ hasText: 'Input 2 / 2' }).waitFor();
      assert.equal(await selected(), 'message');
      await popup.locator('#selectInput').click();
      await popup.locator('#navigationControls').waitFor({ state: 'hidden' });
      assert.equal(await page.locator('#message').evaluate(node => node === document.activeElement), true);
      await popup.locator('#textInput').fill('NAV');
      await popup.locator('#typoChanceSlider').fill('0');
      await popup.locator('#startTyping').click();
      await page.waitForFunction(() => document.getElementById('message').value === 'NAV');
      assert.equal(await page.locator('#search').inputValue(), '');
      await popup.close();
    });
    if (process.env.PT_WEB_STORE_CHECK === '1') await check('Chrome Web Store restriction is explained', async () => {
      const store = await context.newPage();
      await store.goto('https://chromewebstore.google.com/', { waitUntil: 'domcontentloaded', timeout: 20000 });
      await store.bringToFront();
      const storeTabId = await worker.evaluate(async () => (await chrome.tabs.query({ active: true, currentWindow: true }))[0].id);
      const raw = await worker.evaluate(async tabId => {
        try { await chrome.scripting.executeScript({ target: { tabId }, func: () => document.title }); return 'unexpected success'; }
        catch (error) { return error.message; }
      }, storeTabId);
      console.log('Chrome restriction:', raw);
      assert.notEqual(raw, 'unexpected success');
      const message = await worker.evaluate(async tabId => {
        try { await frameRouter.route(tabId, { action: 'startInputNavigation' }); return 'unexpected success'; }
        catch (error) { return error.message; }
      }, storeTabId);
      assert.match(message, /Chrome Web Store.*regular website/);
      await store.close();
    });
    else console.log('SKIP live Chrome Web Store check (set PT_WEB_STORE_CHECK=1 to enable)');
    assert.deepEqual(failed, [], 'navigation regressions');
  } finally {
    await context?.close(); server.close(); fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
