const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function setup({ paused = false, noTab = false, disconnected = false } = {}) {
  const listeners = [], sent = [];
  let queries = 0;
  const chrome = {
    runtime: { onInstalled: { addListener() {} }, onMessage: { addListener() {} } },
    contextMenus: { onClicked: { addListener() {} } },
    commands: { onCommand: { addListener(fn) { listeners.push(fn); } } },
    tabs: {
      async query(query) { queries++; assert.deepEqual({ ...query }, { active: true, currentWindow: true }); return noTab ? [] : [{ id: 42 }]; },
      async sendMessage(tabId, message, options) {
        if (disconnected) throw new Error('Receiving end does not exist.');
        if (message.action === 'getTargetInfo') return {
          hasTarget: true, changedAt: options.frameId === 7 ? 1 : 100,
          isTyping: options.frameId === 7, isPaused: paused
        };
        sent.push({ tabId, message, options });
        return { success: true };
      }
    },
    scripting: { async executeScript({ target }) {
      if (target.allFrames) return [
        { frameId: 0, documentId: 'top', result: { url: 'https://parent.test/', embeddedUrls: ['https://editor.test/'] } },
        { frameId: 7, documentId: 'running-editor', result: { url: 'https://editor.test/', embeddedUrls: [] } }
      ];
      return [{ result: { hasTyper: true, hasFloating: true, legacyBridge: false } }];
    } },
    permissions: { contains: async () => true }
  };
  const context = vm.createContext({ chrome, URL, Map, Set, console });
  context.importScripts = (...files) => files.forEach(file => vm.runInContext(fs.readFileSync(path.join(__dirname, '..', file), 'utf8'), context));
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../background.js'), 'utf8'), context);
  return { sent, queries: () => queries, async command(name, tab) {
    assert.equal(listeners.length, 1, 'register the Chrome command handler');
    await listeners[0](name, tab);
  } };
}

for (const paused of [false, true]) test(`stop shortcut reaches the ${paused ? 'paused' : 'running'} iframe session`, async () => {
  const state = setup({ paused });
  await state.command('stop-typing');
  assert.equal(state.sent.length, 1);
  assert.equal(state.sent[0].tabId, 42);
  assert.equal(state.sent[0].message.action, 'stopTyping');
  assert.deepEqual({ ...state.sent[0].options }, { documentId: 'running-editor' });
});

test('unrelated commands do not touch any tab', async () => {
  const state = setup();
  await state.command('other-command');
  assert.equal(state.queries(), 0);
  assert.equal(state.sent.length, 0);
});

test('missing tabs and unavailable receivers do not cause unhandled command failures', async () => {
  for (const options of [{ noTab: true }, { disconnected: true }]) {
    const state = setup(options);
    await state.command('stop-typing');
    assert.equal(state.sent.length, 0);
  }
});


test('the command uses its originating tab instead of a later active-tab query', async () => {
  const state = setup();
  await state.command('stop-typing', { id: 99 });
  assert.equal(state.queries(), 0);
  assert.equal(state.sent[0].tabId, 99);
});
