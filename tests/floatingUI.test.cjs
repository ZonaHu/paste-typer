const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function setup() {
  const commands = [], writes = [], pageListeners = [], elements = new Map(), intervals = new Map();
  let nextInterval = 1;
  let progress = { position: 0, total: 0, isTyping: false, isPaused: false, error: null };
  let clipboardReads = 0;
  const window = {
    addEventListener(type, fn) { if (type === 'message') pageListeners.push(fn); },
    async postMessage(data) {
      await Promise.all(pageListeners.map(fn => fn({ source: window, data, isTrusted: true })));
    }
  };
  const container = { style: { display: 'block' } };
  const root = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, {
      value: id === 'textInput' ? 'selected text' : id === 'speedSlider' ? '50' : '5',
      textContent: '', classList: { remove() {} }, listeners: new Map(),
      addEventListener(type, fn) { this.listeners.set(type, fn); }
    });
    return elements.get(id);
  } };
  const chrome = {
    runtime: {
      onMessage: { addListener() {} },
      sendMessage: async request => {
        assert.equal(request.action, 'ptRoute');
        return vm.runInContext('frameRouter', context).route(1, request.message);
      }
    },
    storage: { local: {
      get(keys, callback) { const value = { pasteTyperSettings: { text: 'selected text', speed: '50', typoChance: '5' } };
        callback?.(value); return Promise.resolve(value); },
      async set(value) { writes.push(value); }
    } },
    permissions: { contains: async () => true },
    scripting: { executeScript: async ({ target }) => target.allFrames ? [
      { frameId: 0, documentId: 'parent', result: { url: 'https://parent.test/', embeddedUrls: ['https://editor.test/'] } },
      { frameId: 7, documentId: 'editor', result: { url: 'https://editor.test/', embeddedUrls: [] } }
    ] : [{ result: { hasTyper: true, hasFloating: true, legacyBridge: false } }] },
    tabs: { sendMessage: async (tabId, message, target) => {
      if (message.action === 'getTargetInfo') return { hasTarget: target.frameId === 7,
        changedAt: target.frameId === 7 ? 100 : 0, isTyping: false };
      if (message.action === 'getTypingProgress') return progress;
      commands.push({ message, target }); return { success: true };
    } }
  };
  const context = vm.createContext({ chrome, window, document: { addEventListener() {} },
    root, container, URL, Map, Set, console, setTimeout() {}, clearTimeout() {},
    setInterval(fn) { const id = nextInterval++; intervals.set(id, fn); return id; },
    clearInterval(id) { intervals.delete(id); },
    navigator: { clipboard: { async readText() { clipboardReads++; return 'clipboard text'; } } } });
  // Exercise the production controller, content-script initialization and router.
  for (const file of ['content/typoRate.js', 'frameRouter.js', 'floating-ui.js', 'content.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  }
  const controller = vm.runInContext('new FloatingUIController(root, container)', context);
  return { commands, writes, window, root, container, controller,
    clipboardReads: () => clipboardReads,
    setProgress(value) { progress = value; },
    async tick() { await Promise.all([...intervals.values()].map(fn => fn())); },
    activeIntervals: () => intervals.size,
    async emit(id, type, isTrusted) {
      root.getElementById(id).listeners.get(type)({ isTrusted });
      // DOM dispatch does not await async handlers; drain their mocked API work.
      await new Promise(resolve => setImmediate(resolve));
    }
  };
}

test('forged page messages cannot route typing or read/write extension settings', async () => {
  const state = setup();
  for (const action of ['startTyping', 'stopTyping', 'saveSettings', 'loadSettings', 'floatingUIClosed']) {
    await state.window.postMessage({ source: 'paste-typer-floating-ui', direction: 'to-content',
      requestId: 'forged', action, payload: { text: 'forged', settings: { text: 'forged' } } });
  }
  assert.equal(state.commands.length, 0);
  assert.equal(state.writes.length, 0);
  assert.equal(state.container.style.display, 'block');
});

test('untrusted clicks/input and missing events cannot invoke privileged handlers', async () => {
  const state = setup();
  for (const id of ['startTyping', 'stopTyping', 'loadClipboard', 'closeBtn']) await state.emit(id, 'click', false);
  for (const id of ['textInput', 'speedSlider', 'typoChanceSlider']) await state.emit(id, 'input', false);
  await state.controller.startTyping(); await state.controller.stopTyping();
  await state.controller.loadFromClipboard(); await state.controller.saveSettings(); state.controller.close();
  assert.equal(state.commands.length, 0); assert.equal(state.writes.length, 0);
  assert.equal(state.clipboardReads(), 0); assert.equal(state.container.style.display, 'block');
});

test('trusted Start and Stop route to the selected cross-origin document', async () => {
  const state = setup();
  await state.emit('startTyping', 'click', true); await state.emit('stopTyping', 'click', true);
  assert.deepEqual(state.commands.map(command => command.message.action), ['startTyping', 'stopTyping']);
  assert.deepEqual(state.commands.map(command => command.target.documentId), ['editor', 'editor']);
  assert.equal(state.commands[0].message.text, 'selected text');
  assert.equal(state.commands[0].message.speed, 50);
  assert.equal(state.commands[0].message.typoChance, 0.05);
});

test('trusted clipboard, settings and close retain existing behavior', async () => {
  const state = setup();
  await state.emit('loadClipboard', 'click', true);
  assert.equal(state.clipboardReads(), 1);
  assert.equal(state.root.getElementById('textInput').value, 'clipboard text');
  await state.emit('textInput', 'input', true);
  assert.equal(state.writes.length, 2);
  assert.equal(state.writes[0].pasteTyperSettings.text, 'clipboard text');
  await state.emit('closeBtn', 'click', true); assert.equal(state.container.style.display, 'none');
});

test('floating status reports an asynchronous typing failure and keeps it visible', async () => {
  const state = setup();
  await state.emit('startTyping', 'click', true);
  assert.equal(state.activeIntervals(), 1);
  state.setProgress({ position: 0, total: 3, isTyping: false, isPaused: false,
    error: 'The page changed or rejected the typed text.' });
  await state.tick();
  assert.equal(state.activeIntervals(), 0);
  assert.equal(state.root.getElementById('status').textContent,
    'The page changed or rejected the typed text.');
  assert.match(state.root.getElementById('status').className, /error/);
});

test('floating status does not claim verified completion for a canvas editor', async () => {
  const state = setup();
  await state.emit('startTyping', 'click', true);
  state.setProgress({ position: 2, total: 2, isTyping: false, isPaused: false,
    error: null, deliveryVerified: false });
  await state.tick();
  assert.equal(state.root.getElementById('status').textContent,
    'Keystrokes sent. Check the document for missing text.');
  assert.match(state.root.getElementById('status').className, /info/);
});

test('floating status follows pause and stop without stale polling', async () => {
  const state = setup();
  await state.emit('startTyping', 'click', true);
  state.setProgress({ position: 1, total: 3, isTyping: true, isPaused: true, error: null });
  await state.tick();
  assert.equal(state.root.getElementById('status').textContent, 'Typing paused');
  await state.emit('stopTyping', 'click', true);
  assert.equal(state.activeIntervals(), 0);
  assert.equal(state.root.getElementById('status').textContent, 'Stopped');
});

test('typo slider displays the probability sent to the engine at 0, 5 and 10 percent', async () => {
  for (const rate of [0, 5, 10]) {
    const state = setup();
    await new Promise(resolve => setImmediate(resolve));
    state.root.getElementById('typoChanceSlider').value = String(rate);
    await state.emit('typoChanceSlider', 'input', true);
    assert.equal(state.root.getElementById('typoChanceValue').textContent, `${rate}%`);
    await state.emit('startTyping', 'click', true);
    assert.equal(state.commands[0].message.typoChance, rate / 100);
  }
});
