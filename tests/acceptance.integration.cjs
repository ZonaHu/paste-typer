// Test-only Playwright/Monaco packages live outside this dependency-free extension.
// Uses its own temporary extension and Chrome profile; no personal browser state.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const dependencies = process.env.PT_TEST_DEPS;
const { chromium } = require(path.join(dependencies, 'node_modules/playwright'));
const monacoRoot = path.join(process.env.PT_MONACO_DEPS || dependencies, 'node_modules/monaco-editor');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-typer-acceptance-'));
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
  if (req.url.startsWith('/vs/')) {
    const file = path.join(monacoRoot, 'min', req.url.split('?')[0]);
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : 'text/css');
    fs.createReadStream(file).pipe(res); return;
  }
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/monaco') {
    res.end(`<div id="editor" style="height:400px"></div><script src="/vs/loader.js"></script><script>
require.config({paths:{vs:'/vs'}});require(['vs/editor/editor.main'],()=>{
window.editor=monaco.editor.create(document.getElementById('editor'),{value:'first\\r\\nlast',language:'plaintext',editContext:false});
editor.getModel().setEOL(monaco.editor.EndOfLineSequence.CRLF);editor.setPosition({lineNumber:1,column:6});editor.focus();window.ready=true;
});</script>`); return;
  }
  res.end('<input id="input"><textarea id="textarea"></textarea><div id="rich" contenteditable="true"></div><input id="email" type="email"><input id="url" type="url"><input id="tel" type="tel"><textarea id="other">UNTOUCHED</textarea>');
});
(async () => {
  let context;
  const failures = [];
  const check = async (name, run) => {
    try { await run(); console.log('PASS ' + name); }
    catch (error) { failures.push(name); console.error('FAIL ' + name + ': ' + error.message); }
  };
  try {
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
      headless: true, channel: 'chrome', ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging']
    });
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const url = `http://127.0.0.1:${server.address().port}`;
    await page.goto(url);
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url?.startsWith('http://127.0.0.1:')).id);
    const route = message => worker.evaluate(({ tabId, message }) => frameRouter.route(tabId, message, 0), { tabId, message });
    const state = async () => {
      for (let count = 0; count < 100; count++) {
        const result = await route({ action: 'getTypingProgress' });
        if (!result.isTyping) return result;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Typing timed out');
    };
    const prepare = async (field, behavior) => {
      await page.goto(url);
      await route({ action: 'getTypingProgress' });
      await page.evaluate(({ field, behavior }) => {
        const element = document.getElementById(field);
        if (element.isContentEditable) {
          element.innerHTML = '<b>abc</b><span>DEF</span><i>ghi</i>';
          element.focus();
          const range = document.createRange();
          range.selectNodeContents(element.children[1]);
          getSelection().removeAllRanges(); getSelection().addRange(range);
        } else {
          element.value = 'abcDEFghi'; element.focus();
          if (typeof element.selectionStart === 'number') element.setSelectionRange(3, 6);
        }
        document.dispatchEvent(new Event('selectionchange'));
        const write = value => {
          if (element.isContentEditable) element.textContent = value;
          else element.value = value;
        };
        if (behavior === 'handles-key') element.addEventListener('keydown', event => {
          if (element.isContentEditable) document.execCommand('insertText', false, event.key);
          else {
            const start = element.selectionStart; const end = element.selectionEnd;
            element.value = element.value.slice(0, start) + event.key + element.value.slice(end);
            element.setSelectionRange(start + event.key.length, start + event.key.length);
          }
        }, { once: true });
        if (behavior === 'rejects-key') element.addEventListener('keydown', event => event.preventDefault(), { once: true });
        if (behavior === 'transforms-key') element.addEventListener('keydown', () => write('TRANSFORMED'), { once: true });
        if (behavior === 'rejects-input') element.addEventListener('input', () => write('REJECTED'), { once: true });
        if (behavior === 'removes-input') element.addEventListener('input', () => element.remove(), { once: true });
        if (behavior === 'microtask-input') element.addEventListener('input', () => queueMicrotask(() => write('REJECTED')), { once: true });
      }, { field, behavior });
    };
    const type = async text => { await route({ action: 'startTyping', text, speed: 1, typoChance: 0, targetElement: true }); return state(); };
    for (const field of ['input', 'textarea', 'rich']) {
      await check(field + ' verifies selected-range insertion', async () => {
        await prepare(field); const result = await type('XYZ');
        assert.equal(result.error, null);
        assert.equal(await page.locator('#' + field).evaluate(el => el.value ?? el.textContent), 'abcXYZghi');
        assert.equal(result.deliveryVerified, true);
      });
      await check(field + ' avoids duplicate page-handled key', async () => {
        await prepare(field, 'handles-key'); const result = await type('X');
        assert.equal(result.error, null);
        assert.equal(await page.locator('#' + field).evaluate(el => el.value ?? el.textContent), 'abcXghi');
      });
      for (const behavior of ['rejects-key', 'transforms-key', 'rejects-input', 'microtask-input', 'removes-input']) {
        await check(field + ' reports ' + behavior + ' and preserves source/position', async () => {
          await prepare(field, behavior);
          const source = behavior === 'removes-input' ? 'X' : 'XYZ';
          const result = await type(source);
          assert.match(result.error || '', /changed|rejected|intercepted/i);
          assert.equal(result.position, 0);
          const retained = await worker.evaluate(async tabId => (await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: () => pasteTyper.currentText }))[0].result, tabId);
          assert.equal(retained, source);
          assert.equal(await page.locator('#other').inputValue(), 'UNTOUCHED');
        });
      }
    }
    for (const field of ['email', 'url', 'tel']) await check(field + ' appends without selection API errors', async () => {
      await prepare(field); const result = await type('X');
      assert.equal(result.error, null);
      assert.equal(await page.locator('#' + field).inputValue(), field === 'email' ? 'abcDEFghiX' : 'abcXghi');
    });
    await check('Monaco accepts CRLF newlines and verifies transformed input', async () => {
      await page.goto(url + '/monaco'); await page.waitForFunction(() => window.ready);
      await route({ action: 'getTypingProgress' });
      await page.locator('textarea.inputarea').focus();
      let result = await type('\nX');
      assert.equal(result.error, null);
      assert.equal(await page.evaluate(() => editor.getValue()), 'first\r\nX\r\nlast');
      await page.evaluate(() => document.querySelector('textarea.inputarea').addEventListener('keyup', () => editor.trigger('fixture', 'undo'), { once: true }));
      result = await type('Y');
      assert.match(result.error || '', /changed|rejected/i);
      assert.equal(result.position, 0);
    });
    await check('Monaco avoids duplicate page-handled printable key', async () => {
      await page.goto(url + '/monaco'); await page.waitForFunction(() => window.ready);
      await route({ action: 'getTypingProgress' }); await page.locator('textarea.inputarea').focus();
      await page.evaluate(() => document.querySelector('textarea.inputarea').addEventListener('keydown', event => editor.trigger('fixture', 'type', { text: event.key }), { once: true }));
      const result = await type('X'); assert.equal(result.error, null);
      assert.equal(await page.evaluate(() => editor.getValue()), 'firstX\r\nlast');
    });
    await check('Monaco detects microtask text rejection', async () => {
      await page.goto(url + '/monaco'); await page.waitForFunction(() => window.ready);
      await route({ action: 'getTypingProgress' }); await page.locator('textarea.inputarea').focus();
      await page.evaluate(() => document.querySelector('textarea.inputarea').addEventListener('keyup', () => queueMicrotask(() => editor.trigger('fixture', 'undo')), { once: true }));
      const result = await type('Y');
      assert.match(result.error || '', /changed|rejected/i); assert.equal(result.position, 0);
    });
    await check('canvas delivery is explicitly unverified in engine and popup', async () => {
      await page.goto(url);
      await page.evaluate(async () => {
        const iframe = document.createElement('iframe'); iframe.className = 'docs-texteventtarget-iframe';
        iframe.srcdoc = '<body contenteditable="true"></body>'; document.body.appendChild(iframe);
        await new Promise(resolve => iframe.addEventListener('load', resolve, { once: true }));
        window.canvasDelivery = '';
        iframe.contentDocument.addEventListener('textInput', event => { window.canvasDelivery += event.data; });
      });
      await route({ action: 'getTypingProgress' });
      await worker.evaluate(tabId => chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED', func: () => { GoogleDocsAdapter.detect = () => true; } }), tabId);
      const result = await type('X');
      assert.equal(result.error, null); assert.equal(result.deliveryVerified, false);
      assert.equal(await page.evaluate(() => window.canvasDelivery), 'X');
      const popup = await context.newPage(); await popup.goto(`chrome-extension://${id}/popup.html`);
      await popup.evaluate(tabId => {
        chrome.tabs.query = async () => [{ id: tabId }];
        const send = chrome.runtime.sendMessage.bind(chrome.runtime);
        chrome.runtime.sendMessage = request => send(request.action === 'ptRoute' ? { ...request, frameId: 0 } : request);
      }, tabId);
      await popup.locator('#textInput').fill('X'); await popup.locator('#typoChanceSlider').fill('0');
      await popup.locator('#startTyping').click();
      await popup.locator('#status').filter({ hasText: 'Keystrokes sent. Check the document for missing text.' }).waitFor({ timeout: 5000 });
      assert.match(await popup.locator('#status').getAttribute('class'), /info/); await popup.close();
    });
    await check('floating controls expose adapter rejection', async () => {
      await prepare('input', 'rejects-input');
      await route({ action: 'toggleFloatingUI' });
      const panel = page.locator('#paste-typer-floating-ui');
      await panel.locator('#textInput').fill('XYZ'); await panel.locator('#typoChanceSlider').fill('0');
      await panel.locator('#startTyping').click();
      await panel.locator('#status').filter({ hasText: 'The page changed or rejected the typed text.' }).waitFor({ timeout: 5000 });
      assert.match(await panel.locator('#status').getAttribute('class'), /error/);
    });
    assert.deepEqual(failures, [], 'Acceptance regressions failed: ' + failures.join(', '));
  } finally {
    await context?.close(); server.close(); fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
