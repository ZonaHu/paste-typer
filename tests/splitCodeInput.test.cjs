const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function setup({ autoAdvance = false } = {}) {
  const document = { activeElement: null, execCommand: () => false };
  class Input {
    constructor(options = {}) {
      Object.assign(this, { tagName: 'INPUT', type: 'text', maxLength: 1,
        isConnected: true, disabled: false, readOnly: false, hidden: false,
        selectionStart: 0, selectionEnd: 0, events: [], _value: '' }, options);
    }
    get value() { return this._value; }
    set value(value) { this._value = value; }
    get previousElementSibling() { return this.parentElement.children[this.parentElement.children.indexOf(this) - 1] || null; }
    get nextElementSibling() { return this.parentElement.children[this.parentElement.children.indexOf(this) + 1] || null; }
    closest(selector) { return selector.includes('hidden') && this.hidden ? this : null; }
    matches() { return this.disabled; }
    getClientRects() { return this.hidden ? [] : [{}]; }
    focus() { document.activeElement = this; }
    setSelectionRange(start, end) { this.selectionStart = start; this.selectionEnd = end; }
    dispatchEvent(event) {
      this.events.push(event);
      if (autoAdvance && event.type === 'input' && event.inputType === 'insertText') this.nextElementSibling?.focus();
      return !event.defaultPrevented;
    }
  }
  class DOMEvent {
    constructor(type, options = {}) { Object.assign(this, { type, defaultPrevented: false }, options); }
    preventDefault() { this.defaultPrevented = true; }
  }
  const group = (...options) => {
    const parent = { children: options.map(value => new Input(value)) };
    for (const input of parent.children) input.parentElement = parent;
    return parent.children;
  };
  const tracker = { getTarget: () => document.activeElement, restore: input => input.focus() };
  const context = vm.createContext({ document, targetTracker: tracker,
    window: { HTMLInputElement: Input, getComputedStyle: () => ({ visibility: 'visible' }) },
    Event: DOMEvent, InputEvent: DOMEvent, KeyboardEvent: DOMEvent, setTimeout,
    GoogleDocsAdapter: { detect: () => false }, MonacoAdapter: { detect: () => false } });
  for (const file of ['inputAdapter', 'standardInputAdapter', 'splitCodeInputAdapter', 'adapterManager']) {
    const source = path.join(__dirname, `../content/${file}.js`);
    vm.runInContext(fs.readFileSync(source, 'utf8'), context);
  }
  return { group, document, adapter(input) {
    input.focus();
    return vm.runInContext('adapterManager.getAdapter()', context);
  } };
}

test('typing a code fills a bounded sibling run with per-character notifications', async () => {
  const { group, adapter } = setup();
  const inputs = group({}, {}, {}, {}, {}, {});
  const active = adapter(inputs[0]);
  await active.focus(inputs[0]);
  for (const char of '483920') assert.equal((await active.typeCharacter(inputs[0], char)).success, true);
  assert.deepEqual(inputs.map(input => input.value), ['4', '8', '3', '9', '2', '0']);
  for (const input of inputs) {
    assert.deepEqual(input.events.map(event => event.type), ['keydown', 'keypress', 'beforeinput', 'input', 'keyup']);
    assert.equal(input.events.find(event => event.type === 'input').data, input.value);
  }
});

test('page auto-advance does not skip a box and typo backspace returns to the inserted box', async () => {
  const { group, adapter } = setup({ autoAdvance: true });
  const inputs = group({}, {}, {});
  const active = adapter(inputs[0]);
  await active.focus(inputs[0]);
  await active.typeCharacter(inputs[0], '5');
  await active.simulateBackspace(inputs[0]);
  await active.typeCharacter(inputs[0], '4');
  await active.typeCharacter(inputs[0], '8');
  assert.deepEqual(inputs.map(input => input.value), ['4', '8', '']);
  assert.equal(inputs[0].events.filter(event => event.inputType === 'deleteContentBackward').length, 2);
});

test('a partial start replaces the selected digit and refuses overflow', async () => {
  const { group, adapter } = setup();
  const inputs = group({ _value: '4' }, { _value: '8' }, { _value: 'x', selectionStart: 0, selectionEnd: 1 }, {});
  const active = adapter(inputs[2]);
  await active.focus(inputs[2]);
  await active.typeCharacter(inputs[2], '3');
  await active.typeCharacter(inputs[2], '9');
  assert.equal((await active.typeCharacter(inputs[2], '2')).success, false);
  assert.deepEqual(inputs.map(input => input.value), ['4', '8', '3', '9']);
});

test('only adjacent editable visible single-character inputs form a group', () => {
  const { group, adapter } = setup();
  for (const boundary of [{ tagName: 'BUTTON' }, { maxLength: 2 }, { disabled: true },
    { readOnly: true }, { hidden: true }, { type: 'hidden' }, { type: 'number' }]) {
    const inputs = group({}, boundary, {});
    assert.equal(adapter(inputs[0]).constructor.name, 'StandardInputAdapter');
    assert.equal(adapter(inputs[2]).constructor.name, 'StandardInputAdapter');
  }
  assert.equal(adapter(group({}, {})[0]).constructor.name, 'SplitCodeInputAdapter');
});

test('a box becoming disabled stops the captured run without skipping ahead', async () => {
  const { group, adapter } = setup();
  const inputs = group({}, {}, {});
  const active = adapter(inputs[0]);
  await active.focus(inputs[0]);
  await active.typeCharacter(inputs[0], '4');
  inputs[1].disabled = true;
  assert.equal((await active.typeCharacter(inputs[0], '8')).success, false);
  assert.deepEqual(inputs.map(input => input.value), ['4', '', '']);
});
