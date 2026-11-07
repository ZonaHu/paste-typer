// Disposable Docs-shaped page: verifies frame routing without touching a user document.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { chromium } = require(path.join(process.env.PT_TEST_DEPS, 'node_modules/playwright'));

const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-typer-docs-routing-'));
const extension = path.join(scratch, 'extension');
fs.mkdirSync(extension);
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && /\.(js|html|json|png)$/.test(entry.name)) {
    fs.copyFileSync(path.join(root, entry.name), path.join(extension, entry.name));
  }
}
fs.cpSync(path.join(root, 'content'), path.join(extension, 'content'), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
manifest.host_permissions = ['https://docs.google.com/*'];
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));

const fixture = `<!doctype html><html><body>
  <div id="docs-editor"></div><div id="delivered"></div>
  <iframe class="docs-texteventtarget-iframe" style="width:300px;height:100px"></iframe>
  <script>
    const iframe = document.querySelector('iframe');
    const sink = iframe.contentDocument.createElement('div');
    sink.id = 'sink'; sink.contentEditable = 'true'; sink.textContent = 'Click here';
    iframe.contentDocument.body.append(sink);
    sink.addEventListener('textInput', event => {
      document.getElementById('delivered').textContent += event.data;
    });
  </script>
</body></html>`;

(async () => {
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
      headless: true, channel: 'chrome', ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging']
    });
    context.setDefaultTimeout(10000);
    await context.route('https://docs.google.com/**', route => route.fulfill({
      status: 200, contentType: 'text/html', body: fixture
    }));
    const cdp = await context.browser().newBrowserCDPSession();
    await cdp.send('Extensions.loadUnpacked', { path: extension });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const url = 'https://docs.google.com/document/d/local-fixture/edit';
    await page.goto(url);
    const tabId = await worker.evaluate(async url =>
      (await chrome.tabs.query({})).find(tab => tab.url === url)?.id, url);
    assert.ok(tabId);
    const route = message => worker.evaluate(({ tabId, message }) =>
      frameRouter.route(tabId, message), { tabId, message });
    const frames = await worker.evaluate(tabId => frameRouter.frames(tabId), tabId);
    await worker.evaluate(tabId => frameRouter.prepare(tabId), tabId);
    await page.frameLocator('iframe.docs-texteventtarget-iframe').locator('#sink').click();
    const prepared = await worker.evaluate(tabId => frameRouter.prepare(tabId), tabId);
    const started = await route({ action: 'startTyping', text: 'A中B', speed: 1,
      typoChance: 0, targetElement: true });
    assert.equal(started.success, true, started.error);
    await page.waitForFunction(() => document.getElementById('delivered').textContent === 'A中B',
      null, { timeout: 3000 });
    assert.ok(frames.some(frame => frame.googleDocsInputSink),
      'Chrome must identify the Docs keyboard-event iframe from its frame element');
    assert.deepEqual(prepared.available.map(frame => frame.frameId), [0],
      'the input sink must not compete as an ordinary editable frame');
    const progress = await route({ action: 'getTypingProgress' });
    assert.equal(progress.error, null);
    assert.equal(progress.position, 3);
    assert.equal(progress.deliveryVerified, false);
    console.log('PASS Docs-shaped canvas editor receives input from top-frame adapter, not the hidden iframe');
  } finally {
    await context?.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
