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
    const commands = await worker.evaluate(() => chrome.commands?.getAll() || []);
    assert.ok(commands.some(command => command.name === 'stop-typing' && command.shortcut), 'Chrome registers the stop shortcut');
    await worker.evaluate(tabId => frameRouter.prepare(tabId), tabId);
    const route = message => worker.evaluate(({ tabId, message }) => frameRouter.route(tabId, message, 0), { tabId, message });
    // Unit tests invoke Chrome's registered listener; here exercise its real
    // implementation with actual extension messaging. OS accelerators are manual.
    const stopCommand = () => worker.evaluate(() => backgroundService.handleCommand('stop-typing'));
    for (const paused of [false, true]) {
      await page.bringToFront();
      await page.locator('#textarea').fill('');
      await page.locator('#textarea').focus();
      await route({ action: 'startTyping', text: 'abcdefghijklmnopqrstuvxyz', speed: 200, typoChance: 0, targetElement: true });
      if (paused) await route({ action: 'pauseTyping' });
      await stopCommand();
      const progress = await route({ action: 'getTypingProgress' });
      assert.equal(progress.isTyping, false);
      assert.equal(progress.isPaused, false);
      const accepted = await page.locator('#textarea').inputValue();
      await new Promise(resolve => setTimeout(resolve, 800));
      assert.equal(await page.locator('#textarea').inputValue(), accepted);
      assert.equal(await page.locator('#other').inputValue(), 'UNTOUCHED');
      console.log(`PASS command stops ${paused ? 'paused' : 'running'} session without opening a UI`);
    }
  } finally {
    await context?.close(); server.close(); fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
