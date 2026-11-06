// PT_TEST_DEPS supplies test-only Playwright; Chrome and extension state are disposable.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { chromium } = require(path.join(process.env.PT_TEST_DEPS, 'node_modules/playwright'));
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-typer-split-code-'));
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
  res.end('<div id="code">' + Array.from({ length: 6 }, (_, i) => `<input id="digit${i}" maxlength="1" inputmode="numeric">`).join('') + '</div><input id="other" value="UNTOUCHED">');
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
    await cdp.send('Extensions.loadUnpacked', { path: extension });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(t => t.url?.startsWith('http://127.0.0.1:')).id);
    await worker.evaluate(tabId => frameRouter.prepare(tabId), tabId);
    const route = message => worker.evaluate(({ tabId, message }) => frameRouter.route(tabId, message, 0), { tabId, message });
    const waitDone = async () => {
      for (let i = 0; i < 200; i++) {
        const state = await route({ action: 'getTypingProgress' });
        if (!state.isTyping) return state;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Typing timed out');
    };
    const values = () => page.locator('#code input').evaluateAll(inputs => inputs.map(input => input.value));
    const isolated = action => worker.evaluate(async ({ tabId, action }) => {
      const [{ result }] = await chrome.scripting.executeScript({ target: { tabId }, world: 'ISOLATED',
        func: action => {
          if (action === 'configure') { pasteTyper.pauseChance = 0; pasteTyper.speedVariation = 0; }
          if (action === 'fastCorrection') pasteTyper.typoCorrectionDelay = 0;
          if (action === 'countNative') {
            globalThis.nativeEdits = 0;
            const exec = document.execCommand.bind(document);
            document.execCommand = (...args) => { globalThis.nativeEdits++; return exec(...args); };
          }
          if (action === 'nativeEdits') return globalThis.nativeEdits;
          if (action === 'detect') return SplitCodeInputAdapter.detect(document.getElementById('digit0'));
        }, args: [action] });
      return result;
    }, { tabId, action });
    const prepare = async ({ autoAdvance = false, start = 0, initial = '' } = {}) => {
      await page.goto(`http://127.0.0.1:${server.address().port}/`);
      await worker.evaluate(tabId => frameRouter.prepare(tabId), tabId);
      await isolated('configure');
      await page.evaluate(({ autoAdvance, start, initial }) => {
        window.events = [];
        const inputs = [...document.querySelectorAll('#code input')];
        inputs.forEach((input, i) => {
          input.value = initial[i] || '';
          input.dataset.model = input.value;
          for (const type of ['keydown', 'keypress', 'beforeinput', 'input', 'keyup', 'paste']) {
            input.addEventListener(type, event => {
              window.events.push({ id: input.id, type, data: event.data, inputType: event.inputType });
              if (type === 'input') {
                input.dataset.model = input.value;
                if (autoAdvance && event.inputType === 'insertText' && input.nextElementSibling) input.nextElementSibling.focus();
              }
            });
          }
        });
        inputs[start].focus();
        inputs[start].setSelectionRange(0, inputs[start].value.length);
        document.dispatchEvent(new Event('selectionchange'));
      }, { autoAdvance, start, initial });
    };
    const type = async (text, options = {}) => {
      assert.equal((await route({ action: 'startTyping', text, speed: 5, typoChance: 0,
        targetElement: true, ...options })).success, true);
      return waitDone();
    };
    for (const autoAdvance of [false, true]) {
      await prepare({ autoAdvance });
      assert.equal((await type('483920')).error, null);
      assert.deepEqual(await values(), ['4', '8', '3', '9', '2', '0']);
      assert.deepEqual(await page.locator('#code input').evaluateAll(inputs => inputs.map(input => input.dataset.model)), ['4', '8', '3', '9', '2', '0']);
      const events = await page.evaluate(() => window.events);
      assert.equal(events.filter(event => event.type === 'input').length, 6);
      assert.equal(events.filter(event => event.type === 'paste').length, 0);
      assert.deepEqual(events.filter(event => event.type === 'keydown').map(event => event.id), ['digit0', 'digit1', 'digit2', 'digit3', 'digit4', 'digit5']);
      assert.equal(await page.locator('#other').inputValue(), 'UNTOUCHED');
      console.log(`PASS six sibling fields, ${autoAdvance ? 'page' : 'adapter'} focus advance, model notifications and no paste`);
    }
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+z' : 'Control+z');
    assert.deepEqual(await values(), ['4', '8', '3', '9', '2', '']);
    await page.keyboard.press(process.platform === 'darwin' ? 'Meta+Shift+z' : 'Control+Shift+z');
    assert.deepEqual(await values(), ['4', '8', '3', '9', '2', '0']);
    console.log('PASS native Undo/Redo of the last digit');
    await prepare({ start: 2, initial: '12xxxx' });
    assert.equal((await type('3920')).error, null);
    assert.deepEqual(await values(), ['1', '2', '3', '9', '2', '0']);
    await prepare({ start: 2, initial: '12xxxx' });
    const overflow = await type('39205');
    assert.match(overflow.error, /group is full/);
    assert.equal(await page.locator('#other').inputValue(), 'UNTOUCHED');
    console.log('PASS selected partial start and overflow boundary');
    for (const boundary of ['disabled', 'readOnly', 'hidden', 'button', 'ordinary', 'separate-parent']) {
      await prepare();
      await page.evaluate(boundary => {
        const input = document.getElementById('digit3');
        if (boundary === 'button' || boundary === 'ordinary') {
          const separator = document.createElement(boundary === 'button' ? 'button' : 'input');
          separator.value = 'UNTOUCHED';
          input.before(separator);
        } else if (boundary === 'separate-parent') {
          const wrapper = document.createElement('div');
          input.before(wrapper);
          for (const id of ['digit3', 'digit4', 'digit5']) wrapper.append(document.getElementById(id));
        } else input[boundary] = true;
      }, boundary);
      assert.match((await type('483920')).error, /group is full/);
      const digits = await page.locator('#code input[id^="digit"]').evaluateAll(inputs => inputs.map(input => input.value));
      assert.deepEqual(digits, ['4', '8', '3', '', '', '']);
      assert.equal(await page.locator('#other').inputValue(), 'UNTOUCHED');
    }
    console.log('PASS disabled, read-only, hidden, ordinary-control and parent boundaries');
    await prepare({ autoAdvance: true });
    await isolated('fastCorrection');
    assert.equal((await type('483920', { typoChance: 1 })).error, null);
    assert.deepEqual(await values(), ['4', '8', '3', '9', '2', '0']);
    assert.ok(await page.evaluate(() => window.events.some(event => event.inputType === 'deleteContentBackward')));
    console.log('PASS forced typo/backspace correction with page auto-advance');
    await prepare();
    await route({ action: 'startTyping', text: '483920', speed: 80, typoChance: 0, targetElement: true });
    await page.waitForFunction(() => document.getElementById('digit0').value === '4');
    await route({ action: 'stopTyping' });
    const stopped = await values();
    await new Promise(resolve => setTimeout(resolve, 200));
    assert.deepEqual(await values(), stopped);
    assert.ok(stopped.includes(''));
    console.log('PASS Stop retains partial code and inserts no later digits');
    await prepare();
    await page.evaluate(() => document.getElementById('digit0').addEventListener('input', () => {
      document.getElementById('digit1').disabled = true;
    }));
    assert.match((await type('483920')).error, /no longer available/);
    assert.deepEqual(await values(), ['4', '', '', '', '', '']);
    console.log('PASS dynamically disabled next field stops instead of skipping');
    const reviewFailures = [];
    const checkReview = async (name, run) => {
      try { await run(); console.log(`PASS ${name}`); }
      catch (error) { reviewFailures.push(`${name}: ${error.message}`); console.error(`FAIL ${name}: ${error.message}`); }
    };
    for (const stage of ['keydown', 'beforeinput']) {
      for (const cancel of [false, true]) {
        await checkReview(`page-owned ${stage} insertion (cancel=${cancel}) advances without duplicate editing`, async () => {
          await prepare();
          await isolated('countNative');
          await page.evaluate(({ stage, cancel }) => {
            for (const input of document.querySelectorAll('#code input')) input.addEventListener(stage, event => {
              if (cancel) event.preventDefault();
              const char = stage === 'keydown' ? event.key : event.data;
              input.value = char;
              input.dispatchEvent(new InputEvent('input', { data: char, inputType: 'insertText', bubbles: true }));
              input.nextElementSibling?.focus();
            });
          }, { stage, cancel });
          assert.equal((await type('483920')).error, null);
          assert.deepEqual(await values(), ['4', '8', '3', '9', '2', '0']);
          assert.equal(await isolated('nativeEdits'), 0);
          assert.equal(await page.evaluate(() => events.filter(event => event.type === 'input').length), 6);
        });
      }
    }
    await checkReview('canceled beforeinput without page insertion rejects the character', async () => {
      await prepare();
      await page.evaluate(() => document.getElementById('digit0').addEventListener('beforeinput', event => event.preventDefault()));
      const state = await type('483920');
      assert.match(state.error, /did not accept/);
      assert.equal(state.position, 0);
      assert.deepEqual(await values(), ['', '', '', '', '', '']);
      assert.equal(await page.evaluate(() => events.filter(event => event.type === 'input').length), 0);
    });
    for (const [stage, microtask] of [['input', false], ['input', true], ['keyup', true]]) {
      await checkReview(`${stage} ${microtask ? 'microtask' : 'synchronous'} restoration rejects the character`, async () => {
        await prepare();
        await page.evaluate(({ stage, microtask }) => {
          for (const input of document.querySelectorAll('#code input')) input.addEventListener(stage, () => {
            const restore = () => { input.value = ''; };
            if (microtask) queueMicrotask(restore); else restore();
          });
        }, { stage, microtask });
        const state = await type('483920');
        assert.match(state.error, /did not accept/);
        assert.equal(state.position, 0);
        assert.deepEqual(await values(), ['', '', '', '', '', '']);
      });
    }
    for (const property of ['opacity', 'contentVisibility']) {
      await checkReview(`${property} hidden ancestor excludes the group and interrupts an existing session`, async () => {
        await prepare();
        const eligible = await isolated('detect');
        assert.equal(eligible, true);
        await page.evaluate(property => { document.getElementById('code').style[property] = property === 'opacity' ? '0' : 'hidden'; }, property);
        assert.equal(await isolated('detect'), false);
        await prepare();
        await page.evaluate(property => document.getElementById('digit0').addEventListener('input', () => {
          document.getElementById('code').style[property] = property === 'opacity' ? '0' : 'hidden';
        }), property);
        assert.match((await type('483920')).error, /no longer available/);
        assert.deepEqual(await values(), ['4', '', '', '', '', '']);
      });
    }
    assert.deepEqual(reviewFailures, []);
  } finally {
    await context?.close();
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
