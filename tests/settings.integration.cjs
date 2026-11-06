// Run with PT_TEST_DEPS pointing at a directory containing playwright.
// Uses a disposable extension copy and Chrome profile, never personal state.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(path.join(process.env.PT_TEST_DEPS, 'node_modules/playwright'));
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-typer-standard-'));
const extension = path.join(scratch, 'extension');
fs.mkdirSync(extension);
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && /\.(js|html|json|png)$/.test(entry.name)) {
    fs.copyFileSync(path.join(root, entry.name), path.join(extension, entry.name));
  }
}
fs.cpSync(path.join(root, 'content'), path.join(extension, 'content'), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
manifest.host_permissions = ['http://127.0.0.1/*']; // Disposable fixture only.
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end('<input id="input"><textarea id="textarea"></textarea><div id="rich" contenteditable="true"></div><textarea id="other">UNTOUCHED</textarea>');
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
    await page.evaluate(port => {
      const iframe = document.createElement('iframe');
      iframe.src = `http://localhost:${port}/`;
      document.body.appendChild(iframe);
    }, server.address().port);
    const discovery = await worker.evaluate(tabId => frameRouter.prepare(tabId), tabId);
    assert.ok(discovery.missingOrigins.includes(`http://localhost:${server.address().port}/*`));
    assert.ok(discovery.available.some(frame => frame.frameId === 0));
    console.log('PASS ungranted embedded site is discoverable without webNavigation permission');
    await worker.evaluate(tabId => frameRouter.prepare(tabId), tabId);
    context.setDefaultTimeout(5000);
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    assert.equal(await popup.locator('#rememberText').count(), 1, 'popup offers Remember text');
    await popup.locator('#textInput').fill('saved source');
    const settings = () => worker.evaluate(async () => (await chrome.storage.local.get('pasteTyperSettings')).pasteTyperSettings);
    const waitFor = async predicate => {
      for (let i = 0; i < 100; i++) {
        if (await predicate()) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Settings did not settle');
    };
    await waitFor(async () => (await settings())?.text === 'saved source');
    await worker.evaluate(tabId => frameRouter.route(tabId, { action: 'toggleFloatingUI' }), tabId);
    const panel = page.locator('#paste-typer-floating-ui');
    await panel.locator('#rememberText').waitFor();
    await waitFor(async () => await panel.locator('#textInput').inputValue() === 'saved source');
    await panel.locator('#rememberText').uncheck();
    await waitFor(async () => (await settings()).rememberText === false);
    await waitFor(async () => !(await popup.locator('#rememberText').isChecked()));
    assert.equal((await settings()).text, undefined);
    await popup.locator('#textInput').fill('private popup draft');
    await panel.locator('#textInput').fill('private floating draft');
    await popup.locator('#speedSlider').press('End');
    await panel.locator('#typoChanceSlider').press('Home');
    await waitFor(async () => (await settings()).speed === '200' && (await settings()).typoChance === '0');
    assert.equal((await settings()).text, undefined);
    // A disabled draft remains usable for typing in the current UI.
    await page.locator('#textarea').focus();
    await panel.locator('#textInput').fill('OK');
    await panel.locator('#startTyping').click();
    await waitFor(async () => await page.locator('#textarea').inputValue() === 'OK');
    await panel.locator('#textInput').fill('private draft before close');
    await panel.locator('#closeBtn').click();
    await worker.evaluate(tabId => frameRouter.route(tabId, { action: 'toggleFloatingUI' }), tabId);
    assert.equal(await panel.locator('#textInput').inputValue(), '');
    await panel.locator('#textInput').fill('private draft before toggle');
    await worker.evaluate(tabId => frameRouter.route(tabId, { action: 'toggleFloatingUI' }), tabId);
    await worker.evaluate(tabId => frameRouter.route(tabId, { action: 'toggleFloatingUI' }), tabId);
    assert.equal(await panel.locator('#textInput').inputValue(), '');
    await popup.reload();
    await waitFor(async () => !(await popup.locator('#rememberText').isChecked()));
    assert.equal(await popup.locator('#textInput').inputValue(), '');
    await popup.locator('#rememberText').check();
    await waitFor(async () => (await settings()).rememberText === true);
    await waitFor(async () => await panel.locator('#rememberText').isChecked());
    assert.equal((await settings()).text, undefined, 'enabling does not save old drafts');
    await popup.locator('#textInput').fill('delete me');
    await waitFor(async () => (await settings()).text === 'delete me');
    await popup.locator('#deleteSavedText').click();
    await waitFor(async () => (await settings()).text === undefined);
    await waitFor(async () => await panel.locator('#textInput').inputValue() === '');
    assert.equal(await popup.locator('#textInput').inputValue(), '');
    assert.equal((await settings()).speed, '200');
    assert.equal((await settings()).typoChance, '0');
    await popup.reload();
    await popup.locator('#rememberText:checked').waitFor();
    assert.equal(await popup.locator('#textInput').inputValue(), '');
    await panel.locator('#textInput').fill('floating saved');
    await waitFor(async () => (await settings()).text === 'floating saved');
    await panel.locator('#deleteSavedText').click();
    await waitFor(async () => (await settings()).text === undefined);
    await popup.reload();
    await popup.locator('#rememberText:checked').waitFor();
    assert.equal(await popup.locator('#textInput').inputValue(), '');
    for (const [reader, deleter, holder] of [[popup, panel, popup]]) {
      await holder.evaluate(() => {
        navigator.clipboard.readText = () => new Promise(resolve => { window.resolveClipboard = resolve; });
      });
      await reader.locator('#loadClipboard').click();
      await holder.waitForFunction(() => typeof window.resolveClipboard === 'function');
      await deleter.locator('#deleteSavedText').click();
      await waitFor(async () => (await settings()).text === undefined);
      await holder.evaluate(() => window.resolveClipboard('stale clipboard secret'));
      await new Promise(resolve => setTimeout(resolve, 50));
      assert.equal((await settings()).text, undefined);
      assert.equal(await reader.locator('#textInput').inputValue(), '');
    }
    // Host-page scripts cannot change the preference or delete saved source.
    await panel.locator('#textInput').fill('protected source');
    await waitFor(async () => (await settings()).text === 'protected source');
    await page.evaluate(() => {
      const root = document.querySelector('#paste-typer-floating-ui').shadowRoot;
      root.getElementById('rememberText').click();
      root.getElementById('rememberText').closest('label').click();
      root.getElementById('deleteSavedText').click();
    });
    assert.equal((await settings()).rememberText, true);
    assert.equal((await settings()).text, 'protected source');
    console.log('PASS Remember text, both deletion controls, disabled typing, reload, concurrent UI updates and forged clicks');

    const delayInitialSettings = () => {
      const send = chrome.runtime.sendMessage.bind(chrome.runtime);
      let delayed = false;
      chrome.runtime.sendMessage = async request => {
        const response = await send(request);
        if (!delayed && request.action === 'ptSettings' && request.operation === 'get') {
          delayed = true;
          await new Promise(resolve => { globalThis.releaseStartupSettings = resolve; });
        }
        return response;
      };
    };
    for (const kind of ['popup', 'floating']) {
      for (const action of ['save', 'clearText', 'disable']) {
        await worker.evaluate(() => chrome.storage.local.set({ pasteTyperSettings: {
          text: 'old startup source', rememberText: true, textRevision: 3, speed: '50', typoChance: '0'
        } }));
        await waitFor(async () => await popup.locator('#rememberText').isChecked());
        const startupPage = await context.newPage();
        let startupUI, release;
        if (kind === 'popup') {
          await startupPage.addInitScript(delayInitialSettings);
          await startupPage.goto(`chrome-extension://${id}/popup.html`);
          await startupPage.waitForFunction(() => typeof globalThis.releaseStartupSettings === 'function');
          startupUI = startupPage;
          release = () => startupPage.evaluate(() => globalThis.releaseStartupSettings());
        } else {
          await startupPage.goto(`http://127.0.0.1:${server.address().port}/?startup=${action}`);
          const startupTabId = await worker.evaluate(async url =>
            (await chrome.tabs.query({})).find(tab => tab.url === url).id, startupPage.url());
          await worker.evaluate(tabId => frameRouter.prepare(tabId), startupTabId);
          await worker.evaluate(tabId => chrome.scripting.executeScript({
            target: { tabId }, world: 'ISOLATED', func: () => {
              const send = chrome.runtime.sendMessage.bind(chrome.runtime);
              let delayed = false;
              chrome.runtime.sendMessage = async request => {
                const response = await send(request);
                if (!delayed && request.action === 'ptSettings' && request.operation === 'get') {
                  delayed = true;
                  await new Promise(resolve => { globalThis.releaseStartupSettings = resolve; });
                }
                return response;
              };
            }
          }), startupTabId);
          await worker.evaluate(tabId => frameRouter.route(tabId, { action: 'toggleFloatingUI' }), startupTabId);
          startupUI = startupPage.locator('#paste-typer-floating-ui');
          await waitFor(async () => worker.evaluate(async tabId => {
            const [{ result }] = await chrome.scripting.executeScript({
              target: { tabId }, world: 'ISOLATED', func: () => typeof globalThis.releaseStartupSettings === 'function'
            });
            return result;
          }, startupTabId));
          release = () => worker.evaluate(tabId => chrome.scripting.executeScript({
            target: { tabId }, world: 'ISOLATED', func: () => globalThis.releaseStartupSettings()
          }), startupTabId);
        }
        await startupUI.locator('#textInput').fill('fresh startup draft');
        if (action === 'clearText') await popup.locator('#deleteSavedText').click();
        if (action === 'disable') await popup.locator('#rememberText').uncheck();
        if (action !== 'save') await waitFor(async () => (await settings()).text === undefined);
        await release();
        await startupUI.locator('#rememberText:enabled').waitFor();
        if (action === 'save') {
          await waitFor(async () => (await settings()).text === 'fresh startup draft');
          assert.equal(await startupUI.locator('#textInput').inputValue(), 'fresh startup draft');
        } else {
          assert.equal(await startupUI.locator('#textInput').inputValue(), '');
          assert.equal(await startupUI.locator('#rememberText').isChecked(), action !== 'disable');
          assert.equal((await settings()).text, undefined);
          if (action === 'clearText') {
            await startupUI.locator('#textInput').fill('new source after deletion');
            await waitFor(async () => (await settings()).text === 'new source after deletion');
          }
        }
        await startupPage.close();
        console.log(`PASS ${kind} startup ${action}: delayed revision read preserves fresh text and privacy actions`);
      }
    }
  } finally {
    await context?.close(); server.close(); fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
