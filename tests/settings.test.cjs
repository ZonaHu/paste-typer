const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup(saved = {}) {
  const storage = { pasteTyperSettings: structuredClone(saved), floatingUIPosition: { x: 12, y: 34 } };
  const listeners = [];
  const context = vm.createContext({ console, URL, Map, Set, chrome: {
    runtime: { getURL: p => `chrome-extension://test/${p}`, onInstalled: { addListener() {} },
      onMessage: { addListener(fn) { listeners.push(fn); } } },
    contextMenus: { onClicked: { addListener() {} } },
    commands: { onCommand: { addListener() {} } },
    storage: { local: {
      async get() { await new Promise(resolve => setImmediate(resolve)); return structuredClone(storage); },
      async set(values) { Object.assign(storage, structuredClone(values)); }
    } }, tabs: {},
  } });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), context);
  return { storage, async request(operation, settings, sender = { url: 'chrome-extension://test/popup.html' }, textRevision = storage.pasteTyperSettings.textRevision || 0) {
    let reply;
    const response = new Promise(resolve => { reply = resolve; });
    const handled = listeners.some(fn => fn({ action: 'ptSettings', operation, settings, textRevision }, sender, reply) === true);
    assert.equal(handled, true, 'the background must handle settings requests');
    return response;
  }, listeners };
}

test('existing saved text is restored with Remember text enabled by default', async () => {
  const state = setup({ text: 'saved source', speed: '75' });
  const result = await state.request('get');
  assert.equal(result.settings.text, 'saved source');
  assert.equal(result.settings.rememberText, true);
});

test('disabling persistence removes old source and rejects later stale UI text writes', async () => {
  const state = setup({ text: 'secret', speed: '75', typoChance: '3', futureSetting: 'keep' });
  await state.request('save', { rememberText: false });
  await Promise.all([state.request('save', { text: 'stale popup' }), state.request('save', { text: 'clipboard secret', speed: '90' })]);
  assert.equal('text' in state.storage.pasteTyperSettings, false);
  assert.equal(state.storage.pasteTyperSettings.rememberText, false);
  assert.equal(state.storage.pasteTyperSettings.speed, '90');
  assert.equal(state.storage.pasteTyperSettings.futureSetting, 'keep');
});

test('concurrent preference changes preserve unrelated fields and queue survives errors', async () => {
  const state = setup({ text: 'source', speed: '50', typoChance: '5' });
  await Promise.all([state.request('save', { speed: '90' }), state.request('save', { typoChance: '2' })]);
  assert.equal(state.storage.pasteTyperSettings.speed, '90');
  assert.equal(state.storage.pasteTyperSettings.typoChance, '2');
  assert.equal(state.storage.pasteTyperSettings.text, 'source');
  const invalid = await state.request('save', { rememberText: 'false' });
  assert.equal(invalid.success, false);
  assert.equal((await state.request('get')).success, true);
});

test('delete saved text preserves preferences and position, including after reload', async () => {
  const state = setup({ text: 'secret', speed: '80', typoChance: '0', rememberText: true });
  await state.request('clearText');
  assert.deepEqual(state.storage.pasteTyperSettings, { speed: '80', typoChance: '0', rememberText: true, textRevision: 1 });
  assert.deepEqual(state.storage.floatingUIPosition, { x: 12, y: 34 });
  assert.equal((await state.request('get')).settings.text, undefined);
});

test('loading disabled legacy settings purges source and re-enabling stores only newly entered text', async () => {
  const state = setup({ rememberText: false, text: 'legacy secret' });
  assert.equal((await state.request('get')).settings.text, undefined);
  assert.equal('text' in state.storage.pasteTyperSettings, false);
  await state.request('save', { rememberText: true });
  assert.equal('text' in state.storage.pasteTyperSettings, false);
  await state.request('save', { text: 'new source' });
  assert.equal((await state.request('get')).settings.text, 'new source');
});


test('a stale clipboard save cannot undo remote deletion before change events arrive', async () => {
  const state = setup({ text: 'old secret', rememberText: true });
  const capturedRevision = (await state.request('get')).settings.textRevision || 0;
  await state.request('clearText');
  const result = await state.request('save', { text: 'late clipboard secret' }, undefined, capturedRevision);
  assert.equal(result.settings.text, undefined);
  assert.equal(state.storage.pasteTyperSettings.text, undefined);
});
