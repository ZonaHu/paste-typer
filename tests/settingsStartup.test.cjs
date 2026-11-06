const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(kind) {
  let saved = { text: 'old source', rememberText: true, textRevision: 3, speed: '75', typoChance: '5' };
  const listeners = [], storageListeners = [], elements = new Map();
  let releaseSettings;
  const initialRead = new Promise(resolve => { releaseSettings = resolve; });
  const root = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, {
      value: id === 'speedSlider' ? '50' : id === 'typoChanceSlider' ? '5' : '',
      style: {}, classList: { remove() {} }, listeners: new Map(),
      addEventListener(type, callback) { this.listeners.set(type, callback); }
    });
    return elements.get(id);
  } };
  const request = message => new Promise(resolve => {
    for (const listener of listeners) listener(message, { url: 'chrome-extension://test/popup.html' }, resolve);
  });
  const chrome = {
    runtime: {
      getURL: file => 'chrome-extension://test/' + file,
      onMessage: { addListener(listener) { listeners.push(listener); } },
      async sendMessage(message) {
        const response = await request(message);
        if (message.operation === 'get') await initialRead;
        return response;
      }
    },
    storage: {
      onChanged: { addListener(listener) { storageListeners.push(listener); } },
      local: {
        async get() { return { pasteTyperSettings: structuredClone(saved) }; },
        async set(values) {
          const oldValue = saved;
          saved = structuredClone(values.pasteTyperSettings);
          if (JSON.stringify(oldValue) !== JSON.stringify(saved)) {
            for (const listener of storageListeners) {
              listener({ pasteTyperSettings: { oldValue, newValue: saved } }, 'local');
            }
          }
        }
      }
    }
  };
  const context = vm.createContext({ chrome, root, console, setTimeout() {},
    document: { getElementById: root.getElementById, addEventListener() {} } });
  for (const file of ['settings.js', 'popup.js', 'floating-ui.js']) {
    vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
  }
  // Skip unrelated frame discovery; use the real settings initialization and
  // event listeners from both controllers against the production worker queue.
  const controller = vm.runInContext(kind === 'popup'
    ? 'Object.create(PopupController.prototype)' : 'Object.create(FloatingUIController.prototype)', context);
  Object.assign(controller, { root, container: { style: { display: 'block' } },
    sourceRevision: 0, textVersion: 0, rememberSourceText: kind === 'popup' ? true : null });
  const ids = ['textInput', 'rememberText', 'deleteSavedText', 'speedSlider', 'speedValue',
    'typoChanceSlider', 'typoChanceValue', 'startButton', 'stopButton', 'pauseButton',
    'resetButton', 'loadClipboardButton', 'openFloatingUIButton', 'findInputsButton',
    'prevInputButton', 'nextInputButton', 'selectInputButton', 'exitNavigationButton',
    'closeBtn', 'header', 'status'];
  for (const id of ids) controller[id] = root.getElementById(id);
  controller.setupEventListeners();
  controller.settingsReady = controller.loadSettings();
  return { controller, releaseSettings, saved: () => saved,
    async edit(text) {
      controller.textInput.value = text;
      controller.textInput.listeners.get('input')({ isTrusted: true });
      await new Promise(resolve => setImmediate(resolve));
    },
    async privacy(operation, settings) {
      return request({ action: 'ptSettings', operation, settings, textRevision: saved.textRevision });
    },
    async settle() { await controller.settingsReady; await new Promise(resolve => setImmediate(resolve)); }
  };
}

for (const kind of ['popup', 'floating']) {
  test(`${kind} saves text entered before nonzero-revision settings finish loading`, async () => {
    const state = setup(kind);
    await state.edit('fresh draft');
    state.releaseSettings();
    await state.settle();
    assert.equal(state.controller.textInput.value, 'fresh draft');
    assert.equal(state.saved().text, 'fresh draft');
    assert.equal(state.saved().textRevision, 3);
  });

  for (const operation of ['clearText', 'disable']) {
    test(`${kind} ${operation} cancels a startup draft waiting for settings`, async () => {
      const state = setup(kind);
      await state.edit('draft entered before deletion');
      await state.privacy(operation === 'disable' ? 'save' : operation,
        operation === 'disable' ? { rememberText: false } : undefined);
      state.releaseSettings();
      await state.settle();
      assert.equal(state.saved().text, undefined);
      assert.equal(state.controller.textInput.value, '');
      assert.equal(state.controller.sourceRevision, 4);
      assert.equal(state.controller.rememberText.checked, operation !== 'disable');
      if (operation === 'clearText') {
        await state.edit('new draft after deletion');
        assert.equal(state.saved().text, 'new draft after deletion');
      }
    });
  }
}
