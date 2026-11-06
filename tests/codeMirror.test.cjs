const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function setupAdapter() {
  const requests = [];
  let tokenNumber = 0;
  const attributes = new Map();
  const content = { isConnected: true, isContentEditable: true,
    closest: selector => selector === '.cm-content' ? content : selector === '.cm-editor' ? {} : null,
    setAttribute: (name, value) => attributes.set(name, value),
    getAttribute: name => attributes.get(name),
    removeAttribute: name => attributes.delete(name) };
  const child = { closest: selector => content.closest(selector) };
  const context = vm.createContext({ console, setTimeout, crypto: { randomUUID: () => `target-${++tokenNumber}` },
    document: { activeElement: content },
    targetTracker: { getTarget: () => child },
    chrome: { runtime: { sendMessage: async request => { requests.push(request); return { success: true }; } } },
    GoogleDocsAdapter: class { static detect() { return false; } },
    StandardInputAdapter: class { static detect() { return true; } }, MonacoAdapter: class { static detect() { return false; } } });
  for (const name of ['inputAdapter.js', 'codeMirrorAdapter.js', 'adapterManager.js']) {
    const file = path.join(__dirname, '../content', name);
    if (fs.existsSync(file)) vm.runInContext(fs.readFileSync(file, 'utf8'), context);
  }
  return { context, content, child, requests, attributes,
    adapter: vm.runInContext('adapterManager.getAdapter()', context) };
}

test('selected CodeMirror descendants resolve to their editor content, not the standard DOM adapter', async () => {
  const { adapter, content } = setupAdapter();
  assert.equal(adapter.constructor.name, 'CodeMirrorAdapter');
  assert.equal((await adapter.getTarget()).element, content);
});

test('CodeMirror operations use fresh scoped runtime requests and always remove the target marker', async () => {
  const { adapter, content, requests, attributes, context } = setupAdapter();
  assert.equal(adapter.constructor.name, 'CodeMirrorAdapter');
  await adapter.focus(content);
  assert.equal((await adapter.typeCharacter(content, '😀')).success, true);
  assert.equal((await adapter.simulateBackspace(content)).success, true);
  await adapter.reset(content);
  assert.deepEqual(requests.map(request => request.operation), ['focus', 'type', 'backspace', 'clear']);
  assert.equal(requests[1].text, '😀');
  assert.ok(requests.every(request => request.action === 'ptCodeMirrorInput'));
  assert.equal(new Set(requests.map(request => request.token)).size, 4);
  assert.equal(attributes.size, 0);
  context.chrome.runtime.sendMessage = async () => undefined;
  assert.equal((await adapter.typeCharacter(content, 'a')).success, false);
  context.chrome.runtime.sendMessage = async () => { throw new Error('document gone'); };
  await assert.rejects(adapter.typeCharacter(content, 'a'), /document gone/);
  assert.equal(attributes.size, 0);
  content.isConnected = false;
  const result = await adapter.typeCharacter(content, 'a');
  assert.equal(result.success, false);
  assert.equal(requests.length, 4);
});

function setupRouter() {
  const listeners = [];
  const injected = [];
  const chrome = { runtime: { onMessage: { addListener: listener => listeners.push(listener) } },
    scripting: { executeScript: async options => { injected.push(options); return [{ result: { success: true } }]; } },
    tabs: {} };
  const context = vm.createContext({ chrome, URL, Map, Set, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frameRouter.js'), 'utf8'), context);
  return { listeners, injected };
}

test('CodeMirror bridge edits only the trusted sending document, ignoring page-provided routing', async () => {
  const { listeners, injected } = setupRouter();
  let response;
  const request = { action: 'ptCodeMirrorInput', operation: 'type', token: 'unique-target', text: '😀',
    tabId: 999, frameId: 999, documentId: 'unrelated' };
  const sender = { tab: { id: 1 }, documentId: 'selected', url: 'https://editor.test/' };
  for (const listener of listeners) listener(request, sender, result => { response = result; });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(response?.success, true);
  assert.equal(injected.length, 1);
  assert.equal(injected[0].world, 'MAIN');
  assert.deepEqual({ ...injected[0].target }, { tabId: 1, documentIds: injected[0].target.documentIds });
  assert.deepEqual([...injected[0].target.documentIds], ['selected']);
});

test('CodeMirror bridge accepts one complete grapheme, including long combining and ZWJ sequences', async () => {
  const { listeners, injected } = setupRouter();
  for (const text of ['e\u0301', '👩‍👩‍👧‍👦', 'a' + '\u0301'.repeat(80)]) {
    for (const listener of listeners) listener({ action: 'ptCodeMirrorInput', operation: 'type', token: 'unique-target', text },
      { tab: { id: 1 }, documentId: 'selected', url: 'https://editor.test/' }, () => {});
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(injected.length, 3);
});

test('CodeMirror focus and deletion requests have serializable scripting arguments', async () => {
  const { listeners, injected } = setupRouter();
  for (const operation of ['focus', 'backspace', 'clear']) {
    const request = { action: 'ptCodeMirrorInput', operation, token: 'unique-target' };
    for (const listener of listeners) listener(request,
      { tab: { id: 1 }, documentId: 'selected', url: 'https://editor.test/' }, () => {});
  }
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(injected.length, 3);
  assert.ok(injected.every(injection => injection.args.every(value => value !== undefined)));
});

test('CodeMirror bridge rejects extension pages, missing document identity and malformed operations', async () => {
  const { listeners, injected } = setupRouter();
  const request = { action: 'ptCodeMirrorInput', operation: 'type', token: 'unique-target', text: 'x' };
  const sender = { tab: { id: 1 }, documentId: 'selected', url: 'https://editor.test/' };
  for (const [message, origin] of [
    [request, { ...sender, url: 'chrome-extension://id/popup.html' }],
    [request, { ...sender, documentId: undefined }],
    [request, { ...sender, tab: undefined }],
    [{ ...request, operation: 'route' }, sender],
    [{ ...request, text: 'whole document' }, sender],
    [{ ...request, text: '' }, sender],
    [{ ...request, text: '\ud83d' }, sender],
    [{ ...request, text: '\udc00' }, sender],
    [{ ...request, token: '' }, sender]
  ]) for (const listener of listeners) listener(message, origin, () => assert.fail('invalid request answered'));
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(injected.length, 0);
});
