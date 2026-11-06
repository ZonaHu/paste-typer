const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

test('context-menu typing uses the saved typo percentage, including zero', async () => {
  let onClick;
  let savedRate;
  const routed = [];
  const chrome = {
    contextMenus: {
      onClicked: { addListener(fn) { onClick = fn; } },
      removeAll(callback) { callback(); },
      create() {}
    },
    runtime: { onInstalled: { addListener() {} }, lastError: null },
    tabs: { query: async () => [{ id: 7 }] },
    scripting: { executeScript: async () => [{ result: 'clipboard text' }] },
    storage: { local: { get: async () => ({ pasteTyperSettings: { typoChance: savedRate } }) } }
  };
  const context = vm.createContext({ chrome, console,
    importScripts() {}, frameRouter: { async route(tabId, message, frameId) {
      routed.push({ tabId, message, frameId });
    } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../content/typoRate.js'), 'utf8'), context);
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), context);
  for (const rate of [0, 5, 10]) {
    savedRate = String(rate);
    await onClick({ menuItemId: 'pasteTyper', frameId: 3 }, { id: 7 });
    assert.equal(routed.at(-1).message.typoChance, rate / 100);
    assert.equal(routed.at(-1).frameId, 3);
  }
  savedRate = 'invalid';
  await onClick({ menuItemId: 'pasteTyper', frameId: 3 }, { id: 7 });
  assert.equal(routed.at(-1).message.typoChance, 0.05);
});
