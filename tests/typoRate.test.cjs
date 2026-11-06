const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function load(context, file) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context);
}

function controls(kind, savedRate) {
  const elements = new Map(), messages = [], writes = [], listeners = [], storageListeners = [];
  const root = { getElementById(id) {
    if (!elements.has(id)) elements.set(id, {
      value: id === 'textInput' ? 'source' : id === 'speedSlider' ? '50' : '5',
      textContent: '', style: {}, classList: { remove() {} }, listeners: {},
      addEventListener(type, listener) { this.listeners[type] = listener; }
    });
    return elements.get(id);
  }, addEventListener() {} };
  let settings = { text: 'source', ...(savedRate === undefined ? {} : { typoChance: savedRate }) };
  const chrome = { storage: { onChanged: { addListener(fn) { storageListeners.push(fn); } }, local: {
    get(keys, callback) { const result = { pasteTyperSettings: settings }; callback?.(result); return Promise.resolve(result); },
    async set(value) {
      const oldValue = settings; settings = value.pasteTyperSettings; writes.push(settings);
      storageListeners.forEach(fn => fn({ pasteTyperSettings: { oldValue, newValue: settings } }, 'local'));
    }
  } }, runtime: { onMessage: { addListener(fn) { listeners.push(fn); } }, getURL: p => `chrome-extension://test/${p}`,
    async sendMessage(request) {
      if (request.action === 'ptSettings') return new Promise(resolve => listeners.forEach(fn =>
        fn(request, { url: 'chrome-extension://test/popup.html' }, resolve)));
      if (request.message.action === 'getTypingProgress') return { state: 'idle', isTyping: false, position: 0, total: 0 };
      messages.push(request.message); return { success: true };
    } } };
  const context = vm.createContext({ chrome, document: root, console, setTimeout() {}, clearTimeout() {},
    setInterval() { return 1; }, clearInterval() {} });
  load(context, 'content/typoRate.js');
  // Load optional settings infrastructure when testing alongside the privacy fix.
  if (fs.existsSync(path.join(__dirname, '../settings.js'))) load(context, 'settings.js');
  load(context, kind === 'popup' ? 'popup.js' : 'floating-ui.js');
  let controller;
  if (kind === 'popup') {
    controller = vm.runInContext('Object.create(PopupController.prototype)', context);
    for (const [property, id] of Object.entries({ textInput: 'textInput', speedSlider: 'speedSlider',
      speedValue: 'speedValue', typoChanceSlider: 'typoChanceSlider', typoChanceValue: 'typoChanceValue',
      startButton: 'startTyping', stopButton: 'stopTyping', pauseButton: 'pauseTyping', resetButton: 'resetTyping',
      loadClipboardButton: 'loadClipboard', openFloatingUIButton: 'openFloatingUI', findInputsButton: 'findInputs',
      prevInputButton: 'prevInput', nextInputButton: 'nextInput', selectInputButton: 'selectInput',
      exitNavigationButton: 'exitNavigation', rememberText: 'rememberText', deleteSavedText: 'deleteSavedText' })) controller[property] = root.getElementById(id);
    controller.textVersion = controller.sourceRevision = 0;
    controller.sendMessageToTab = async message => { messages.push(message); return { success: true }; };
    controller.showStatus = controller.startProgressTracking = controller._setControls = () => {};
    controller.setupEventListeners();
    controller.loadSettings();
  } else {
    context.root = root;
    context.container = { style: { display: 'block' } };
    controller = vm.runInContext('new FloatingUIController(root, container)', context);
  }
  return { controller, messages, writes, root };
}

async function contextMenu(rate) {
  let onClick;
  const messages = [];
  const chrome = {
    contextMenus: { onClicked: { addListener(fn) { onClick = fn; } } },
    commands: { onCommand: { addListener() {} } },
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
    tabs: { query: async () => [{ id: 7 }] },
    scripting: { executeScript: async () => [{ result: 'source' }] },
    storage: { local: { get: async () => ({ pasteTyperSettings: { typoChance: rate } }) } }
  };
  const context = vm.createContext({ chrome, console, frameRouter: {
    async route(tabId, message, frameId) { assert.equal(tabId, 7); assert.equal(frameId, 3); messages.push(message); }
  } });
  context.importScripts = (...files) => files.filter(file => file !== 'frameRouter.js').forEach(file => load(context, file));
  load(context, 'background.js');
  await onClick({ menuItemId: 'pasteTyper', frameId: 3 }, { id: 7 });
  return messages[0];
}

function engine(savedRate, sample = 0, deferred) {
  const random = Object.create(Math);
  random.random = () => sample;
  const context = vm.createContext({ Math: random, console, document: { addEventListener() {} },
    chrome: { runtime: { onMessage: { addListener(listener) { deferred?.listeners.push(listener); } } }, storage: { local: {
      get(keys, callback) {
        const complete = () => callback({ pasteTyperSettings: { typoChance: savedRate } });
        if (deferred) deferred.complete = complete;
        else complete();
      }
    } } } });
  load(context, 'content/typoRate.js');
  load(context, 'content.js');
  return vm.runInContext('pasteTyper', context);
}

async function makesTypo(probability, sample) {
  const typer = engine(undefined, sample);
  let backspaces = 0;
  typer.typoChance = probability;
  typer.currentText = 'abcdef';
  typer.currentGraphemes = ['a', 'b', 'c', 'd', 'e', 'f'];
  typer.isTyping = true;
  typer.sleep = async () => {};
  typer.currentAdapter = {
    async typeCharacter(element, char) { if (char === 'a') typer.isTyping = false; return { success: true }; },
    async simulateBackspace() { backspaces++; return { success: true }; }
  };
  await typer.continueTyping(typer.sessionId);
  return backspaces > 0;
}

for (const kind of ['popup', 'floating']) {
  for (const [percent, probability] of [[0, 0], [5, 0.05], [10, 0.1]]) {
    test(`${kind} loads, displays, saves and starts with ${percent}%`, async () => {
      const state = controls(kind, String(percent));
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(String(state.controller.typoChanceSlider.value), String(percent));
      assert.equal(state.controller.typoChanceValue.textContent, `${percent}%`);
      state.controller.typoChanceSlider.value = String(percent);
      state.controller.typoChanceSlider.listeners.input({ isTrusted: true });
      await new Promise(resolve => setImmediate(resolve));
      assert.equal(state.controller.typoChanceValue.textContent, `${percent}%`);
      assert.equal(state.writes.at(-1).typoChance, String(percent));
      await state.controller.startTyping({ isTrusted: true });
      assert.equal(state.messages.at(-1).typoChance, probability);
      assert.equal(await makesTypo(state.messages.at(-1).typoChance, probability), false, 'the probability boundary must not make a typo');
      assert.equal(await makesTypo(state.messages.at(-1).typoChance, Math.max(0, probability - 0.000001)), percent > 0);
    });
  }
  test(`${kind} defaults to 5% when no rate was saved`, async () => {
    const state = controls(kind);
    await new Promise(resolve => setImmediate(resolve));
    assert.equal(state.controller.typoChanceValue.textContent, '5%');
    await state.controller.startTyping({ isTrusted: true });
    assert.equal(state.messages.at(-1).typoChance, 0.05);
  });
}

for (const [percent, probability] of [[0, 0], [5, 0.05], [10, 0.1]]) {
  test(`context menu uses saved ${percent}% and the engine respects its boundary`, async () => {
    const message = await contextMenu(String(percent));
    assert.equal(message.typoChance, probability);
    assert.equal(await makesTypo(message.typoChance, probability), false);
    assert.equal(await makesTypo(message.typoChance, Math.max(0, probability - 0.000001)), percent > 0);
  });
}

test('context menu and engine share a 5% default for absent or invalid settings', async () => {
  for (const rate of [undefined, '', 'invalid', '-1', '51']) {
    assert.equal((await contextMenu(rate)).typoChance, 0.05);
    assert.equal(engine(rate).typoChance, 0.05);
  }
});

test('a delayed saved rate cannot overwrite an explicit Start rate of zero', async () => {
  const deferred = { listeners: [] };
  const typer = engine('10', 0, deferred);
  typer.startTyping = async () => {};
  deferred.listeners[0]({ action: 'startTyping', text: 'source', typoChance: 0 }, {}, () => {});
  deferred.complete();
  assert.equal(typer.typoChance, 0);
});
