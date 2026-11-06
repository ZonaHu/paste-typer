const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const path = require('node:path');
function setup() {
  const listeners = [], events = [], waits = [];
  const context = vm.createContext({ console, setTimeout, clearTimeout,
    document: { addEventListener() {}, hasFocus: () => false },
    chrome: { storage: { local: { get(keys, callback) { callback({}); } } },
      runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } } } });
  for (const file of ['content/typoRate.js', 'content/graphemes.js', 'content.js']) {
    const source = path.join(__dirname, '..', file);
    if (fs.existsSync(source)) vm.runInContext(fs.readFileSync(source, 'utf8'), context);
  }
  const typer = vm.runInContext('pasteTyper', context);
  Object.assign(typer, { sessionId: 1, sessionState: 'running', isTyping: true,
    currentText: 'abcdef', currentGraphemes: ['a', 'b', 'c', 'd', 'e', 'f'], currentPosition: 0, pauseChance: 0, typoChance: 0,
    currentAdapter: { async typeCharacter(el, char) { events.push(char); return { success: true }; },
      async simulateBackspace() { events.push('backspace'); return { success: true }; } },
    generateTypo: () => 's', sleep() { return new Promise(resolve => waits.push(resolve)); } });
  const drain = () => new Promise(resolve => setImmediate(resolve));
  return { typer, events, waits, drain, context,
    info() { let result; listeners[0]({ action: 'getTargetInfo' }, {}, value => { result = value; }); return result; },
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
  state.typer.currentGraphemes = ['X', 'Y', 'Z'];
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

function clearFixture() {
  const state = setup();
  const element = { tagName: 'TEXTAREA', className: '', value: 'OLD', focus() {} };
  state.context.document.activeElement = element;
  state.context.targetTracker = { element: null, getTarget: () => element };
  state.context.MonacoAdapter = class {};
  let resolveTarget, calls = 0;
  const adapter = { async focus() {}, getTarget() {
    return calls++ === 0 ? new Promise(resolve => { resolveTarget = resolve; }) : Promise.resolve({ element });
  } };
  state.context.adapterManager = { getAdapter: () => adapter };
  state.typer.sleep = async () => {};
  state.typer.isMonacoEditor = () => false;
  state.typer.continueTyping = async () => { element.value += 'NEW'; };
  state.typer.simulateHumanDeletion = async () => { element.value = ''; };
  return { ...state, element, resolveTarget: () => resolveTarget({ element }) };
}

test('Clear is exclusive while target discovery is pending', async () => {
  const state = clearFixture();
  const clearing = state.typer.resetTyping();
  await state.drain();
  try {
    assert.equal(state.progress().state, 'clearing');
    assert.equal(state.info().isTyping, true, 'router must retain the busy Clear frame');
    await assert.rejects(state.typer.startTyping('NEW'), /clear|progress|running/i);
    await assert.rejects(state.typer.resetTyping(), /clear|progress/i);
  } finally { state.resolveTarget(); await clearing; }
  assert.equal(state.element.value, '');
  assert.equal(state.progress().state, 'stopped');
});

test('Stop cancels a delayed Clear before it can erase a restarted session', async () => {
  const state = clearFixture();
  const clearing = state.typer.resetTyping();
  const canceled = assert.rejects(clearing, /cancel|stopped/i);
  await state.drain();
  await state.typer.stopTyping();
  await state.typer.startTyping('NEW');
  assert.equal(state.element.value, 'OLDNEW');
  state.resolveTarget();
  await canceled;
  assert.equal(state.element.value, 'OLDNEW');
  assert.equal(state.progress().state, 'running');
});

test('Stop waits for a Clear edit already dispatched before acknowledging', async () => {
  const state = clearFixture();
  let finishDeletion;
  state.typer.simulateHumanDeletion = () => new Promise(resolve => { finishDeletion = () => {
    state.element.value = ''; resolve();
  }; });
  const clearing = state.typer.resetTyping();
  const settled = clearing.catch(() => {});
  await state.drain(); state.resolveTarget(); await state.drain();
  assert.equal(typeof finishDeletion, 'function');
  let acknowledged = false;
  const stopping = state.typer.stopTyping().then(() => { acknowledged = true; });
  await state.drain();
  try { assert.equal(acknowledged, false); }
  finally { finishDeletion(); await settled; await stopping; }
  assert.equal(state.progress().state, 'stopped');
});

test('Stop cancels undispatched Clear deletion after an inner helper delay', async () => {
  const state = clearFixture();
  delete state.typer.simulateHumanDeletion;
  state.context.KeyboardEvent = state.context.Event = class { constructor(type, values) { Object.assign(this, { type }, values); } };
  state.element.dispatchEvent = () => true;
  state.element.setSelectionRange = () => {};
  state.typer._setNativeValue = (element, value) => { element.value = value; };
  const delays = [];
  state.typer.sleep = ms => new Promise(resolve => delays.push({ ms, resolve }));
  const clearing = state.typer.resetTyping();
  const canceled = assert.rejects(clearing, /cancel|stopped/i);
  await state.drain(); state.resolveTarget(); await state.drain();
  assert.equal(delays[0].ms, 100);
  delays.shift().resolve(); await state.drain();
  assert.equal(delays[0].ms, 50);
  const stopping = state.typer.stopTyping();
  while (delays.length) { delays.shift().resolve(); await state.drain(); }
  await canceled; await stopping;
  assert.equal(state.element.value, 'OLD');
});
