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
    context.setDefaultTimeout(7000);
    const route = message => worker.evaluate(({ tabId, message }) => frameRouter.route(tabId, message, 0), { tabId, message });
    await route({ action: 'getTypingProgress' });
    await worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: () => {
      pasteTyper.pauseChance = 0;
      pasteTyper.typoCorrectionDelay = 1200;
      Math.random = () => 0;
    } }), tabId);
    await page.locator('#textarea').focus();
    await route({ action: 'toggleFloatingUI' });
    const panel = page.locator('#paste-typer-floating-ui');
    await panel.locator('#pauseTyping').waitFor();
    let popup;
    const openPopup = async () => {
      popup = await context.newPage();
      await popup.addInitScript(tabId => { chrome.tabs.query = async () => [{ id: tabId }]; }, tabId);
      await popup.goto(`chrome-extension://${id}/popup.html`);
    };
    await openPopup();
    await popup.locator('#textInput').fill('abcdefghij');
    await popup.locator('#typoChanceSlider').fill('50');
    await popup.locator('#startTyping').click();
    await page.waitForFunction(() => document.getElementById('textarea').value.length > 0);
    await panel.locator('#pauseTyping').click();
    await popup.locator('#pauseTyping').filter({ hasText: 'Resume' }).waitFor();
    await panel.locator('#pauseTyping').filter({ hasText: 'Resume' }).waitFor();
    assert.equal((await route({ action: 'getTypingProgress' })).state, 'paused');
    assert.equal(await popup.locator('#startTyping').isDisabled(), true);
    assert.equal(await panel.locator('#startTyping').isDisabled(), true);
    const pausedText = await page.locator('#textarea').inputValue();
    await new Promise(resolve => setTimeout(resolve, 1400));
    assert.equal(await page.locator('#textarea').inputValue(), pausedText, 'paused correction cannot backspace or type');
    await popup.close(); await openPopup();
    await popup.locator('#pauseTyping').filter({ hasText: 'Resume' }).waitFor();
    await popup.locator('#pauseTyping').click();
    await panel.locator('#pauseTyping').filter({ hasText: 'Pause' }).waitFor();
    await worker.evaluate(({tabId}) => backgroundService.handleCommand('stop-typing', {id:tabId}), {tabId});
    await popup.locator('#status').filter({ hasText: 'Typing stopped' }).waitFor();
    await panel.locator('#status').filter({ hasText: 'Stopped' }).waitFor();
    const stopped = await page.locator('#textarea').inputValue();
    await new Promise(resolve => setTimeout(resolve, 1400));
    assert.equal(await page.locator('#textarea').inputValue(), stopped);
    assert.equal((await route({ action: 'getTypingProgress' })).state, 'stopped');
    await panel.locator('#textInput').fill('XYZ');
    await panel.locator('#typoChanceSlider').press('Home');
    await panel.locator('#startTyping').click();
    await popup.locator('#status').filter({ hasText: 'Typing complete' }).waitFor();
    await panel.locator('#status').filter({ hasText: 'Typing complete' }).waitFor();
    assert.equal((await route({ action: 'getTypingProgress' })).state, 'completed');
    assert.equal(await page.locator('#textarea').inputValue(), stopped + 'XYZ');
    // A second short run can complete entirely between UI polls.
    await panel.locator('#textInput').fill('!');
    await panel.locator('#startTyping').click();
    await panel.locator('#status').filter({ hasText: 'Typing complete' }).waitFor();
    await popup.locator('#status').filter({ hasText: 'Typing complete' }).waitFor();
    assert.equal(await page.locator('#textarea').inputValue(), stopped + 'XYZ!');
    // Stop and Clear must keep the open popup observing sessions from the panel.
    for (const action of ['stopTyping', 'resetTyping']) {
      await route({ action: 'startTyping', text: 'long enough to stop', typoChance: 0 });
      await popup.locator('#stopTyping').waitFor({ state: 'visible' });
      await popup.locator('#' + action).click();
      await popup.locator('#status').filter({ hasText: action === 'stopTyping' ? 'Typing stopped' : 'cleared' }).waitFor();
      await panel.locator('#textInput').fill('R');
      await panel.locator('#startTyping').click();
      await popup.locator('#status').filter({ hasText: 'Typing complete' }).waitFor();
      assert.equal((await route({ action: 'getTypingProgress' })).state, 'completed');
    }
    console.log('PASS cross-UI Pause/Resume, popup reopen, shortcut Stop during correction, quick completion, and external restart after popup Stop/Clear');
  } finally {
    await context?.close(); server.close(); fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
