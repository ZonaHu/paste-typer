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
const fixtures = {
  file: '<input id="wrong" type="file" hidden>',
  disabled: '<fieldset disabled><input id="wrong"></fieldset>',
  readonly: '<input id="wrong" readonly>',
  hidden: '<input id="wrong" style="visibility:hidden">',
  transparent: '<div style="opacity:0"><input id="wrong"></div>',
  unrendered: '<div style="content-visibility:hidden"><input id="wrong"></div>',
  inert: '<div inert><textarea id="wrong"></textarea></div>',
  rich: '<div id="wrong" contenteditable="false">LOCKED</div>',
};
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end((fixtures[req.url.slice(1)] || fixtures.file) + '<textarea id="target"></textarea>');
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
    const route = message => worker.evaluate(({ tabId, message }) => frameRouter.route(tabId, message, 0), { tabId, message });
    for (const kind of Object.keys(fixtures)) {
      await page.goto(`http://127.0.0.1:${server.address().port}/${kind}`);
      await route({ action: 'startTyping', text: 'SAFE', speed: 10, typoChance: 0, targetElement: true });
      for (let i = 0; i < 200; i++) {
        const progress = await route({ action: 'getTypingProgress' });
        if (!progress.isTyping) { assert.equal(progress.error, null); break; }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      assert.equal(await page.locator('#target').inputValue(), 'SAFE', kind);
      assert.equal(await page.locator('#wrong').evaluate(node => node.value ?? node.textContent), kind === 'rich' ? 'LOCKED' : '', kind + ' stays untouched');
      console.log('PASS Start skips', kind);
    }
  } finally {
    await context?.close(); server.close(); fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
