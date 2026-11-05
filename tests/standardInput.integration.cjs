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
  if (req.url === '/search-like') {
    res.end('<input type="file" hidden><input type="text" hidden><textarea id="search" name="q"></textarea>');
    return;
  }
  res.end('<input id="input"><textarea id="textarea"></textarea><div id="rich" contenteditable="true"></div><textarea id="other">UNTOUCHED</textarea>');
});
(async () => {
  let context;
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
    const route = message => worker.evaluate(({ tabId, message }) => frameRouter.route(tabId, message, 0), { tabId, message });
    const waitDone = async () => {
      for (let i = 0; i < 200; i++) {
        const state = await route({ action: 'getTypingProgress' });
        if (!state.isTyping) { assert.equal(state.error, null); return; }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Typing timed out');
    };
    const prepare = async (field, end = 6) => {
      await page.bringToFront();
      await page.evaluate(({ field, end }) => {
        const el = document.getElementById(field);
        if (el.isContentEditable) {
          el.innerHTML = '<b>abc</b><span>DEF</span><i>ghi</i>';
          el.focus();
          const range = document.createRange();
          range.setStart(el.children[1].firstChild, 0);
          range.setEnd(el.children[1].firstChild, end === 6 ? 3 : 0);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
        } else {
          el.value = 'abcDEFghi'; el.focus(); el.setSelectionRange(3, end);
        }
        // Mimic a framework tracker: input notifications must update model state.
        el.dataset.model = el.value ?? el.textContent;
        el.oninput = () => { el.dataset.model = el.value ?? el.textContent; };
        document.dispatchEvent(new Event('selectionchange'));
      }, { field, end });
    };
    const verify = async (field, expected) => {
      assert.equal(await page.locator(`#${field}`).evaluate(el => el.value ?? el.textContent), expected);
      assert.equal(await page.locator(`#${field}`).getAttribute('data-model'), expected);
      assert.equal(await page.locator('#other').inputValue(), 'UNTOUCHED');
    };
    for (const field of ['input', 'textarea', 'rich']) {
      for (const end of [3, 6]) {
        await prepare(field, end);
        await route({ action: 'startTyping', text: 'XYZ', speed: 10, typoChance: 0, targetElement: true });
        await waitDone();
        await verify(field, end === 3 ? 'abcXYZDEFghi' : 'abcXYZghi');
      }
      if (field === 'rich') {
        assert.equal(await page.locator('#rich b').textContent(), 'abc');
        assert.equal(await page.locator('#rich i').textContent(), 'ghi');
      }
      console.log(`PASS ${field}: insertion, selection replacement, model events, unrelated content`);
    }
    await prepare('textarea');
    await route({ action: 'toggleFloatingUI' });
    const panel = page.locator('#paste-typer-floating-ui');
    await panel.locator('#textInput').fill('XYZ');
    await panel.locator('#typoChanceSlider').fill('0');
    await panel.locator('#startTyping').click();
    await panel.locator('#status').filter({ hasText: 'Typing started!' }).waitFor();
    await waitDone(); await verify('textarea', 'abcXYZghi');
    console.log('PASS floating UI retains selected range');
    await prepare('input');
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.evaluate(tabId => { chrome.tabs.query = async () => [{ id: tabId }]; }, tabId);
    await popup.locator('#textInput').fill('XYZ');
    await popup.locator('#typoChanceSlider').fill('0');
    await popup.locator('#startTyping').click();
    await popup.locator('#status').filter({ hasText: 'Typing started!' }).waitFor();
    await waitDone(); await verify('input', 'abcXYZghi');
    await popup.evaluate(() => {
      chrome.runtime.sendMessage = async () => {
        throw new Error('Could not establish connection. Receiving end does not exist.');
      };
      document.getElementById('findInputs').disabled = false;
    });
    await popup.locator('#findInputs').click();
    await popup.locator('#status').filter({ hasText: 'Paste Typer lost its connection. Refresh this page' }).waitFor();
    await popup.close();
    console.log('PASS popup retains selected range and explains lost connection');
    // Context-menu handler dispatches this same frame-scoped start request.
    await prepare('textarea');
    await route({ action: 'startTyping', text: 'XYZ', targetElement: true, typoChance: 0 });
    await waitDone(); await verify('textarea', 'abcXYZghi');
    console.log('PASS context-menu routing contract (native menu/clipboard not automated)');
    await prepare('textarea');
    await route({ action: 'resetTyping' });
    assert.equal(await page.locator('#textarea').inputValue(), '');
    assert.equal(await page.locator('#other').inputValue(), 'UNTOUCHED');
    console.log('PASS explicit Clear still clears selected field');
    await page.goto(`http://127.0.0.1:${server.address().port}/search-like`);
    await route({ action: 'startTyping', text: 'XYZ', speed: 10, typoChance: 0, targetElement: true });
    await waitDone();
    assert.equal(await page.locator('#search').inputValue(), 'XYZ');
    console.log('PASS fallback skips file and hidden inputs before visible search field');
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    for (const field of ['input', 'textarea', 'rich']) {
      for (const value of ['A😀B', 'e\u0301', '🇨🇦', '👨‍👩‍👧‍👦']) {
        await prepare(field);
        await page.evaluate(field => {
          const el = document.getElementById(field);
          window.ptInputData = [];
          el.oninput = event => {
            window.ptInputData.push(event.data);
            el.dataset.model = el.value ?? el.textContent;
          };
        }, field);
        await route({ action: 'startTyping', text: value, speed: 10, typoChance: 0, targetElement: true });
        await waitDone();
        await verify(field, `abc${value}ghi`);
        const payloads = await page.evaluate(() => window.ptInputData);
        assert.deepEqual(payloads, [...new Intl.Segmenter(undefined, { granularity: 'grapheme' })
          .segment(value)].map(part => part.segment));
      }
      console.log(`PASS ${field}: complete Unicode graphemes and UTF-16 caret offsets`);
    }
    await prepare('input');
    await page.locator('#input').evaluate(el => {
      el.addEventListener('input', () => { el.value = 'rejected'; }, { once: true });
    });
    await route({ action: 'startTyping', text: 'XYZ', speed: 10, typoChance: 0, targetElement: true });
    let rejected;
    for (let i = 0; i < 100; i++) {
      rejected = await route({ action: 'getTypingProgress' });
      if (!rejected.isTyping) break;
      await new Promise(resolve => setTimeout(resolve, 25));
    }
    assert.match(rejected.error, /changed or rejected/);
    assert.equal(rejected.position, 0);
    assert.equal(await page.locator('#input').inputValue(), 'rejected');
    console.log('PASS rejected input stops at first mismatch instead of false completion');
    await prepare('input');
    await route({ action: 'toggleFloatingUI' });
    await panel.locator('#textInput').fill('XYZ');
    await panel.locator('#typoChanceSlider').fill('0');
    await page.locator('#input').evaluate(el => {
      el.addEventListener('input', () => { el.value = 'rejected'; }, { once: true });
    });
    await panel.locator('#startTyping').click();
    await panel.locator('#status').filter({ hasText: 'The page changed or rejected the typed text.' }).waitFor();
    assert.match(await panel.locator('#status').getAttribute('class'), /error/);
    console.log('PASS floating UI shows asynchronous typing error');
    await prepare('input');
    await route({ action: 'startTyping', text: 'xxxxxxxx', speed: 200, typoChance: 0, targetElement: true });
    await assert.rejects(route({ action: 'startTyping', text: 'duplicate', targetElement: true }),
      /already running/);
    await route({ action: 'stopTyping' });
    await route({ action: 'startTyping', text: 'NEW', speed: 10, typoChance: 0, targetElement: true });
    await waitDone();
    await new Promise(resolve => setTimeout(resolve, 300));
    await verify('input', 'abcNEWghi');
    console.log('PASS duplicate Start reports error and stopped session cannot leak into restart');
    await prepare('input');
    await route({ action: 'startTyping', text: 'abcdefghij', speed: 10, typoChance: 1, targetElement: true });
    let beforeStop;
    for (let i = 0; i < 30; i++) {
      beforeStop = await page.locator('#input').inputValue();
      if (beforeStop !== 'abcDEFghi') break;
      await new Promise(resolve => setTimeout(resolve, 10));
    }
    assert.notEqual(beforeStop, 'abcDEFghi');
    await route({ action: 'stopTyping' });
    await new Promise(resolve => setTimeout(resolve, 450));
    assert.equal(await page.locator('#input').inputValue(), beforeStop);
    console.log('PASS Stop during typo correction causes no later field mutation');
  } finally {
    await context?.close(); server.close(); fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
