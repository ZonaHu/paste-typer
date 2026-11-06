const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function setup({ savedSettings, delaySettings = false } = {}) {
  const commands = [], writes = [], pageListeners = [], elements = new Map();
  let clipboardReads = 0;
  let clipboardValue = 'clipboard text';
  let saved = savedSettings || { text: 'selected text', speed: '50', typoChance: '5' };
  let releaseSettings;
  const settingsDelay = delaySettings ? new Promise(resolve => { releaseSettings = resolve; }) : Promise.resolve();
  const storageListeners = [];
  const messageListeners = [];
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
      onMessage: { addListener(fn) { messageListeners.push(fn); } },
      getURL: p => `chrome-extension://test/${p}`,
      sendMessage: async request => {
        if (request.action === 'ptSettings') {
          const response = await new Promise(resolve => messageListeners.forEach(fn => fn(request, { url: 'chrome-extension://test/popup.html' }, resolve)));
          if (request.operation === 'get') await settingsDelay;
          return response;
        }
        assert.equal(request.action, 'ptRoute');
        return vm.runInContext('frameRouter', context).route(1, request.message);
      }
    },
    storage: { onChanged: { addListener(fn) { storageListeners.push(fn); } }, local: {
      get(keys, callback) { const value = { pasteTyperSettings: structuredClone(saved) };
        callback?.(value); return Promise.resolve(value); },
      async set(value) {
        const oldValue = saved;
        saved = structuredClone(value.pasteTyperSettings);
        writes.push(value);
        storageListeners.forEach(fn => fn({ pasteTyperSettings: { oldValue, newValue: saved } }, 'local'));
      }
    } },
    permissions: { contains: async () => true },
    scripting: { executeScript: async ({ target }) => target.allFrames ? [
      { frameId: 0, documentId: 'parent', result: { url: 'https://parent.test/', embeddedUrls: ['https://editor.test/'] } },
      { frameId: 7, documentId: 'editor', result: { url: 'https://editor.test/', embeddedUrls: [] } }
    ] : [{ result: { hasTyper: true, hasFloating: true, legacyBridge: false } }] },
    tabs: { sendMessage: async (tabId, message, target) => {
      if (message.action === 'getTargetInfo') return { hasTarget: target.frameId === 7,
        changedAt: target.frameId === 7 ? 100 : 0, isTyping: false };
      commands.push({ message, target }); return { success: true };
    } }
  };
  const context = vm.createContext({ chrome, window, document: { addEventListener() {} },
    root, container, URL, Map, Set, console, setTimeout() {},
    navigator: { clipboard: { async readText() { clipboardReads++; return clipboardValue; } } } });
  // Exercise the production controller, content-script initialization and router.
  for (const file of ['frameRouter.js', 'settings.js', 'floating-ui.js', 'content.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  }
  const controller = vm.runInContext('new FloatingUIController(root, container)', context);
  return { commands, writes, window, root, container, controller,
    releaseSettings,
    deferClipboard() { let resolve; clipboardValue = new Promise(done => { resolve = done; }); return resolve; },
    clipboardReads: () => clipboardReads,
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
  for (const id of ['startTyping', 'stopTyping', 'loadClipboard', 'closeBtn', 'deleteSavedText']) await state.emit(id, 'click', false);
  for (const id of ['textInput', 'speedSlider', 'typoChanceSlider']) await state.emit(id, 'input', false);
  await state.emit('rememberText', 'change', false);
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


test('deleting saved text cancels a clipboard read that was already pending', async () => {
  const state = setup();
  await state.controller.settingsReady;
  const resolveRead = state.deferClipboard();
  const pending = state.controller.loadFromClipboard({ isTrusted: true });
  await new Promise(resolve => setImmediate(resolve));
  await state.controller.updateTextPrivacy('clearText');
  resolveRead('old clipboard secret');
  await pending;
  assert.equal(state.root.getElementById('textInput').value, '');
  assert.equal(state.writes.at(-1).pasteTyperSettings.text, undefined);
});

test('closing the floating panel discards private drafts and pending clipboard reads', async () => {
  const state = setup();
  await state.controller.settingsReady;
  await state.controller.updateTextPrivacy('save', { rememberText: false });
  state.root.getElementById('textInput').value = 'private draft';
  const resolveRead = state.deferClipboard();
  const pending = state.controller.loadFromClipboard({ isTrusted: true });
  await new Promise(resolve => setImmediate(resolve));
  await state.emit('closeBtn', 'click', true);
  resolveRead('private clipboard');
  await pending;
  assert.equal(state.root.getElementById('textInput').value, '');
});

test('closing before disabled privacy settings load still discards the private draft', async () => {
  const state = setup({ savedSettings: { rememberText: false }, delaySettings: true });
  await new Promise(resolve => setImmediate(resolve));
  const input = state.root.getElementById('textInput');
  input.value = 'private draft entered before settings loaded';
  input.listeners.get('input')({ isTrusted: true });
  state.controller.close({ isTrusted: true });
  // Reopening must not retain the closed draft, even before settings arrive.
  state.container.style.display = 'block';
  state.releaseSettings();
  await state.controller.settingsReady;
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(input.value, '');
  assert.equal(state.writes.at(-1).pasteTyperSettings.text, undefined);
});
