const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function setup() {
  const document = { activeElement: null, addEventListener() {} };
  const context = vm.createContext({ document, Date, window: { getSelection() { return { rangeCount: 0 }; } } });
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
