const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(path.join(process.env.PT_TEST_DEPS, 'node_modules/playwright'));
const root = path.resolve(__dirname, '..');
const monacoRoot = path.join(process.env.PT_MONACO_DEPS || process.env.PT_TEST_DEPS, 'node_modules/monaco-editor');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-typer-unicode-'));
const extension = path.join(scratch, 'extension');
fs.mkdirSync(extension);
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && /\.(js|html|json|png)$/.test(entry.name)) {
    fs.copyFileSync(path.join(root, entry.name), path.join(extension, entry.name));
  }
}
fs.cpSync(path.join(root, 'content'), path.join(extension, 'content'), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const server = http.createServer((req, res) => {
  if (req.url.startsWith('/vs/')) {
    const file = path.join(monacoRoot, 'min', req.url.split('?')[0]);
    if (!fs.existsSync(file)) { res.statusCode = 404; res.end(); return; }
    res.setHeader('Content-Type', file.endsWith('.js') ? 'text/javascript' : file.endsWith('.css') ? 'text/css' : 'application/octet-stream');
    fs.createReadStream(file).pipe(res); return;
  }
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  if (req.url === '/editor') {
    res.end(`<!doctype html><div id="editor" style="height:300px"></div><script src="/vs/loader.js"></script><script>
      require.config({paths:{vs:'/vs'}});require(['vs/editor/editor.main'],function(){
        window.editor=monaco.editor.create(document.getElementById('editor'),{value:'leftright',language:'plaintext',editContext:false});
        editor.setPosition({lineNumber:1,column:5});editor.focus();
        window.payloads=[];document.addEventListener('input',event=>{if(event.data!==null)payloads.push(event.data);},true);
        window.ready=true;
      });</script>`); return;
  }
  res.end('<input id="input"><textarea id="textarea"></textarea><div id="rich" contenteditable="true"></div>');
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
    await cdp.send('Extensions.loadUnpacked', { path: extension });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url?.startsWith('http://127.0.0.1:')).id);
    await worker.evaluate(tabId => frameRouter.prepare(tabId), tabId);
    const route = message => worker.evaluate(({ tabId, message }) => frameRouter.route(tabId, message, 0), { tabId, message });
    const isolated = async (operation, field = null) => worker.evaluate(async ({ tabId, operation, field }) => {
      const results = await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] },
        world: 'ISOLATED', func: async (operation, field) => {
          if (operation === 'configure') { pasteTyper.pauseChance = 0; return true; }
          return new StandardInputAdapter().simulateBackspace(document.getElementById(field));
        }, args: [operation, field] });
      return results[0].result;
    }, { tabId, operation, field });
    await isolated('configure');
    const waitDone = async (send = route) => {
      for (let i = 0; i < 300; i++) {
        const state = await send({ action: 'getTypingProgress' });
        if (!state.isTyping) { assert.equal(state.error, null); return state; }
        await new Promise(resolve => setTimeout(resolve, 10));
      }
      throw new Error('Typing timed out');
    };
    const longCluster = 'e' + '\u0301'.repeat(80);
    const text = 'A😀Be\u0301🇨🇦👨‍👩‍👧‍👦' + longCluster;
    const payloads = ['A', '😀', 'B', 'e\u0301', '🇨🇦', '👨‍👩‍👧‍👦', longCluster];
    for (const field of ['input', 'textarea', 'rich']) {
      await page.evaluate(field => {
        const el = document.getElementById(field); el.focus();
        if (el.isContentEditable) {
          el.innerHTML = '<b>left</b><i>right</i>';
          const range = document.createRange(); range.setStart(el, 1); range.collapse(true);
          getSelection().removeAllRanges(); getSelection().addRange(range);
        } else { el.value = 'leftright'; el.setSelectionRange(4, 4); }
        window.inputPayloads = [];
        el.oninput = event => { if (event.data !== null) window.inputPayloads.push(event.data); };
        document.dispatchEvent(new Event('selectionchange'));
      }, field);
      await route({ action: 'startTyping', text, speed: 1, typoChance: 0 });
      const state = await waitDone();
      assert.equal(await page.locator(`#${field}`).evaluate(el => el.value ?? el.textContent), 'left' + text + 'right');
      assert.deepEqual(await page.evaluate(() => window.inputPayloads), payloads);
      assert.equal(state.position, 7); assert.equal(state.total, 7);
      if (field !== 'rich') assert.equal(await page.locator(`#${field}`).evaluate(el => el.selectionStart), 4 + text.length);
      else {
        assert.equal(await page.locator('#rich b').textContent(), 'left');
        assert.equal(await page.locator('#rich i').textContent(), 'right');
      }
      console.log(`PASS ${field}: exact Unicode insertion, full event payloads, UTF-16 caret, grapheme progress`);
    }
    for (const type of ['email', 'url', 'tel']) {
      await page.evaluate(type => {
        const el = document.getElementById('input'); el.type = type; el.value = 'left'; el.focus();
        if (typeof el.selectionStart === 'number') el.setSelectionRange(4, 4);
        document.dispatchEvent(new Event('selectionchange'));
      }, type);
      await route({ action: 'startTyping', text: '😀e\u0301', speed: 1, typoChance: 0 });
      await waitDone();
      assert.equal(await page.locator('#input').inputValue(), 'left😀e\u0301');
      const result = await isolated('backspace', 'input');
      assert.equal(result.success, true);
      assert.equal(await page.locator('#input').inputValue(), 'left😀');
      console.log(`PASS ${type}: Unicode insertion/deletion respects native selection API support`);
    }
    await page.locator('#input').evaluate(el => { el.type = 'text'; });
    // Delete pre-existing clusters, including clusters split across formatting nodes.
    for (const field of ['input', 'textarea', 'rich']) {
      for (const cluster of ['😀', 'e\u0301', '🇨🇦', '👨‍👩‍👧‍👦', longCluster]) {
        for (const mode of ['end', 'inside', 'selected']) {
          await page.evaluate(({ field, cluster, mode }) => {
            const el = document.getElementById(field); el.focus();
            if (el.isContentEditable) {
              el.replaceChildren();
              const left = document.createElement('b'); left.textContent = 'left'; el.appendChild(left);
              // Even a surrogate pair can straddle text nodes in an existing DOM.
              for (let i = 0; i < cluster.length; i++) {
                const span = document.createElement('span'); span.textContent = cluster[i]; el.appendChild(span);
              }
              const right = document.createElement('i'); right.textContent = 'right'; el.appendChild(right);
              const range = document.createRange();
              if (mode === 'end') { range.setStart(right.firstChild, 0); range.collapse(true); }
              else {
                range.setStart(el.children[1].firstChild, mode === 'inside' ? 1 : 0);
                range.setEnd(el.children[1].firstChild, 1);
              }
              getSelection().removeAllRanges(); getSelection().addRange(range);
            } else {
              el.value = 'left' + cluster + 'right';
              el.setSelectionRange(mode === 'end' ? 4 + cluster.length : mode === 'inside' ? 5 : 4,
                mode === 'end' ? 4 + cluster.length : 5);
            }
          }, { field, cluster, mode });
          const result = await isolated('backspace', field);
          assert.equal(result.success, true);
          assert.equal(await page.locator(`#${field}`).evaluate(el => el.value ?? el.textContent), 'leftright');
          if (field === 'rich') {
            assert.equal(await page.locator('#rich b').textContent(), 'left');
            assert.equal(await page.locator('#rich i').textContent(), 'right');
          }
        }
      }
      console.log(`PASS ${field}: backspace removes one existing whole grapheme`);
    }
    const editorNavigation = page.waitForEvent('framenavigated', { predicate: frame => frame.url().endsWith('/editor') });
    await page.evaluate(port => {
      const iframe = document.createElement('iframe'); iframe.src = `http://localhost:${port}/editor`;
      iframe.style = 'width:900px;height:400px'; document.body.appendChild(iframe);
    }, server.address().port);
    const editorFrame = await editorNavigation;
    await editorFrame.waitForFunction(() => window.ready);
    await editorFrame.locator('textarea.inputarea').focus();
    const editorFrameId = await worker.evaluate(async tabId => {
      const discovery = await frameRouter.prepare(tabId);
      return discovery.available.find(frame => frame.url.endsWith('/editor')).frameId;
    }, tabId);
    const editorRoute = message => worker.evaluate(({ tabId, editorFrameId, message }) => frameRouter.route(tabId, message, editorFrameId),
      { tabId, editorFrameId, message });
    await editorRoute({ action: 'startTyping', text, speed: 1, typoChance: 0 });
    const state = await waitDone(editorRoute);
    assert.equal(await editorFrame.evaluate(() => editor.getValue()), 'left' + text + 'right');
    assert.deepEqual(await editorFrame.evaluate(() => payloads), payloads);
    assert.equal(state.position, 7); assert.equal(state.total, 7);
    assert.equal(await editorFrame.evaluate(() => editor.getPosition().column), 5 + text.length);
    console.log('PASS cross-origin Monaco: exact Unicode insertion, full event payloads, UTF-16 caret, grapheme progress');
  } finally {
    await context?.close(); server.close(); fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
