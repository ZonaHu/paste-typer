const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
class FixtureEditContext {}

function setup() {
  const document = { activeElement: null, addEventListener() {} };
  const context = vm.createContext({ document, Date, EditContext: FixtureEditContext,
    window: { getSelection() { return { rangeCount: 0 }; } } });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../content/targetTracker.js'), 'utf8'), context);
  return vm.runInContext('targetTracker', context);
}
function input({ controls = false } = {}) {
  return { tagName: 'TEXTAREA', type: 'textarea', isConnected: true,
    selectionStart: 3, selectionEnd: 5, selectionDirection: 'backward',
    closest: () => controls ? {} : null,
    focus(options) { this.focusOptions = options; this.selectionStart = this.selectionEnd = 0; },
    setSelectionRange(start, end, direction) { Object.assign(this, { selectionStart: start, selectionEnd: end, selectionDirection: direction }); }
  };
}
test('controls do not replace the remembered editor or selection', () => {
  const tracker = setup(); const editor = input();
  tracker.capture(editor); tracker.capture(input({ controls: true }));
  assert.equal(tracker.getTarget(), editor);
  tracker.restore(editor);
  assert.equal(editor.selectionStart, 3); assert.equal(editor.selectionEnd, 5);
  assert.equal(editor.selectionDirection, 'backward');
  assert.equal(editor.focusOptions.preventScroll, true);
});
test('removed or read-only targets are invalidated', () => {
  const tracker = setup(); const editor = input();
  tracker.capture(editor); editor.isConnected = false; assert.equal(tracker.getTarget(), null);
  editor.isConnected = true; editor.readOnly = true; assert.equal(tracker.getTarget(), null);
});

test('native Monaco targets are retained without replacing their editor-managed selection', () => {
  const tracker = setup();
  const editor = { tagName: 'DIV', isConnected: true, editContext: new FixtureEditContext(),
    classList: { contains: name => name === 'native-edit-context' },
    closest: selector => selector === '.monaco-editor' ? {} : null,
    focus() { this.focused = true; } };
  tracker.capture(editor);
  assert.equal(tracker.getTarget(), editor);
  tracker.restore(editor);
  assert.equal(editor.focused, true);
  editor.editContext = null;
  assert.equal(tracker.getTarget(), null);
});

test('a native-editor class without an actual EditContext is not an editable target', () => {
  const tracker = setup();
  const impostor = { tagName: 'DIV', isConnected: true,
    classList: { contains: () => true }, closest: () => null };
  tracker.capture(impostor);
  assert.equal(tracker.getTarget(), null);
});

test('native caret geometry uses its visible editor owner, ordinary fields keep their own bounds', () => {
  const tracker = setup();
  const owner = { getBoundingClientRect: () => ({ width: 500, height: 200 }) };
  const input = { classList: { contains: () => true }, editContext: new FixtureEditContext(),
    closest: () => owner, getBoundingClientRect: () => ({ width: 0, height: 18 }) };
  assert.deepEqual(tracker.getEditableRect(input), { width: 500, height: 200 });
  input.editContext = null;
  assert.deepEqual(tracker.getEditableRect(input), { width: 0, height: 18 });
});
