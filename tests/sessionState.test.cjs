const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function setup() {
  const listeners = [], events = [], waits = [];
  const context = vm.createContext({ console, setTimeout, clearTimeout,
    document: { addEventListener() {} },
    chrome: { storage: { local: { get(keys, callback) { callback({}); } } },
      runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../content.js'), 'utf8'), context);
  const typer = vm.runInContext('pasteTyper', context);
  Object.assign(typer, { sessionId: 1, sessionState: 'running', isTyping: true,
    currentText: 'abcdef', currentPosition: 0, pauseChance: 0, typoChance: 0,
    currentAdapter: { async typeCharacter(el, char) { events.push(char); return { success: true }; },
      async simulateBackspace() { events.push('backspace'); return { success: true }; } },
    generateTypo: () => 's', sleep() { return new Promise(resolve => waits.push(resolve)); } });
  const drain = () => new Promise(resolve => setImmediate(resolve));
  return { typer, events, waits, drain, context,
    progress() { let result; listeners[0]({ action: 'getTypingProgress' }, {}, value => { result = value; }); return result; } };
}

test('Stop during correction acknowledges a stopped session and prevents later input', async () => {
  const state = setup();
  const pending = state.typer.makeTypoAndCorrect('a', 1);
  await state.drain(); assert.deepEqual(state.events, ['s']);
  state.typer.stopTyping(); state.waits.shift()(); await state.drain();
  while (state.waits.length) { state.waits.shift()(); await state.drain(); }
  await pending;
  assert.deepEqual(state.events, ['s']);
  assert.equal(state.progress().state, 'stopped');
});

test('Pause holds correction before backspace and Resume continues it', async () => {
  const state = setup(); const pending = state.typer.makeTypoAndCorrect('a', 1);
  await state.drain(); state.typer.pauseTyping(); state.waits.shift()(); await state.drain();
  assert.deepEqual(state.events, ['s']);
  assert.equal(state.progress().state, 'paused');
  state.typer.resumeTyping();
  while (state.waits.length) { state.waits.shift()(); await state.drain(); }
  await pending;
  assert.deepEqual(state.events, ['s', 'backspace', 'a']);
});

test('Stop then restart invalidates the old normal-delay continuation', async () => {
  const state = setup(); const old = state.typer.continueTyping(1);
  await state.drain(); state.typer.stopTyping();
  state.typer.isTyping = true; state.typer.sessionState = 'running'; state.typer.sessionId++;
  state.typer.currentText = 'XYZ'; state.typer.currentPosition = 0;
  state.waits.shift()(); await state.drain();
  assert.deepEqual(state.events, []);
  // Stop the fresh session so the old loop cannot remain pending in the fixture.
  state.typer.stopTyping();
  while (state.waits.length) { state.waits.shift()(); await state.drain(); }
  await old;
});

test('Stop acknowledgement waits for an in-flight adapter edit', async () => {
  const state = setup(); let release;
  state.typer.currentAdapter.typeCharacter = () => new Promise(resolve => { release = () => {
    state.events.push('settled input'); resolve({ success: true });
  }; });
  const input = state.typer.applyInput('typeCharacter', null, 'a');
  let acknowledged = false;
  const stop = state.typer.stopTyping().then(() => { acknowledged = true; });
  await state.drain(); assert.equal(acknowledged, false);
  assert.equal(state.progress().state, 'stopping');
  release(); await input; await stop;
  assert.equal(state.progress().state, 'stopped');
  assert.deepEqual(state.events, ['settled input']);
});


test('Stop during pending target discovery prevents a late session start', async () => {
  const state = setup(); let found;
  state.typer.isTyping = false;
  state.typer.sessionState = 'idle';
  const element = { tagName: 'TEXTAREA', className: '', isContentEditable: false };
  state.context.document.activeElement = element;
  state.context.adapterManager = { getAdapter() { return {
    getTarget: () => new Promise(resolve => { found = resolve; }),
    async focus() {}, async typeCharacter(el, char) { state.events.push(char); return {success:true}; }
  }; } };
  const starting = state.typer.startTyping('NEW');
  await state.drain(); await state.typer.stopTyping();
  found({ element }); await state.drain();
  state.typer.isTyping = false;
  while (state.waits.length) { state.waits.shift()(); await state.drain(); }
  await starting;
  assert.equal(state.progress().state, 'stopped');
  assert.deepEqual(state.events, []);
});
