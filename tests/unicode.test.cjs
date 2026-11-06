const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const root = path.resolve(__dirname, '..');
const longCluster = 'e' + '\u0301'.repeat(80);

function engine() {
  const listeners = [], payloads = [];
  const element = { tagName: 'TEXTAREA' };
  const adapter = { getTarget: async () => ({ element }), focus: async () => {},
    typeCharacter: async (_, text) => { payloads.push(text); return { success: true }; } };
  const context = vm.createContext({ console: { ...console, error() {} }, setTimeout, clearTimeout,
    window: { addEventListener() {} }, document: { addEventListener() {}, activeElement: element },
    chrome: { runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } },
      storage: { local: { get(_, callback) { callback({}); } } } },
    adapterManager: { getAdapter: () => adapter } });
  for (const file of ['content/graphemes.js', 'content.js']) {
    if (fs.existsSync(path.join(root, file))) vm.runInContext(fs.readFileSync(path.join(root, file), 'utf8'), context);
  }
  const typer = vm.runInContext('pasteTyper', context);
  typer.typoChance = 0; typer.pauseChance = 0;
  typer.sleep = () => new Promise(resolve => setImmediate(resolve));
  return { typer, adapter, payloads, progress: () => {
    let result; listeners[0]({ action: 'getTypingProgress' }, {}, value => { result = value; });
    return result;
  } };
}

test('engine sends complete graphemes and reports grapheme progress', async () => {
  const { typer, payloads, progress } = engine();
  await typer.startTyping('A😀Be\u0301🇨🇦👨‍👩‍👧‍👦' + longCluster);
  while (typer.isTyping) await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(payloads, ['A', '😀', 'B', 'e\u0301', '🇨🇦', '👨‍👩‍👧‍👦', longCluster]);
  assert.equal(progress().position, 7);
  assert.equal(progress().total, 7);
});

test('engine rejects malformed UTF-16 before emitting any input payload', async () => {
  const { typer, payloads } = engine();
  await assert.rejects(typer.startTyping('A\ud83dB'), /incomplete Unicode/);
  assert.deepEqual(payloads, []);
  assert.equal(typer.isTyping, false);
});

test('pause and resume retain the next complete grapheme', async () => {
  const state = engine();
  const insert = state.adapter.typeCharacter;
  state.adapter.typeCharacter = async (...args) => {
    const result = await insert(...args);
    if (state.payloads.length === 1) state.typer.pauseTyping();
    return result;
  };
  await state.typer.startTyping('A😀B');
  while (state.progress().position === 0) await new Promise(resolve => setImmediate(resolve));
  const paused = state.progress(), pausedPayloads = [...state.payloads];
  state.typer.resumeTyping();
  while (state.typer.isTyping) await new Promise(resolve => setImmediate(resolve));
  assert.equal(paused.position, 1); assert.equal(paused.total, 3);
  assert.deepEqual(pausedPayloads, ['A']);
  assert.deepEqual(state.payloads, ['A', '😀', 'B']);
  assert.equal(state.progress().position, 3);
});

test('combining graphemes do not invent physical letter or digit key codes in adapters', () => {
  const context = vm.createContext({});
  for (const file of ['inputAdapter.js', 'standardInputAdapter.js', 'googleDocsAdapter.js']) {
    vm.runInContext(fs.readFileSync(path.join(root, 'content', file), 'utf8'), context);
  }
  for (const adapter of vm.runInContext('[new StandardInputAdapter(), new GoogleDocsAdapter()]', context)) {
    for (const text of ['e\u0301', '1\u0301', longCluster]) assert.equal(adapter._getKeyInfo(text).code, 'Unidentified');
  }
});

function monacoListener() {
  const listeners = [], injected = [];
  const context = vm.createContext({ URL, console, chrome: {
    runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } }, tabs: {},
    scripting: { executeScript: async options => { injected.push(options); return [{ result: { success: true } }]; } }
  } });
  vm.runInContext(fs.readFileSync(path.join(root, 'frameRouter.js'), 'utf8'), context);
  return { listener: listeners[0], injected };
}

test('Monaco permits a single grapheme of any valid length, never lone surrogates or multiple graphemes', async () => {
  const { listener, injected } = monacoListener();
  const sender = { tab: { id: 1 }, documentId: 'editor', url: 'https://editor.test/' };
  for (const text of ['😀', 'e\u0301', '🇨🇦', '👨‍👩‍👧‍👦', longCluster, '\n', '\t']) {
    const result = await new Promise(resolve => {
      assert.equal(listener({ action: 'ptMonacoInput', token: 'selected', text }, sender, resolve), true);
    });
    assert.equal(result.success, true);
    assert.equal(injected.at(-1).args[1], text);
  }
  const count = injected.length;
  for (const text of ['', 'AB', '\ud83d', '\udc00', 'x\ud83d', '\udc00\u0301']) {
    assert.equal(listener({ action: 'ptMonacoInput', token: 'selected', text }, sender, () => {}), undefined);
  }
  assert.equal(injected.length, count);
});
