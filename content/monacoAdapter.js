// Monaco owns the document and undo history. Its textarea is an input surface,
// not the document: never clear it or assign the full code to textarea.value.
class MonacoAdapter extends InputAdapter {
  static detect(element) {
    return !!(element && element.tagName === 'TEXTAREA' &&
      element.classList.contains('inputarea') && element.closest('.monaco-editor'));
  }

  async getTarget() {
    const remembered = targetTracker.getTarget();
    if (MonacoAdapter.detect(remembered)) return { element: remembered };
    return { element: null, error: 'Click inside the Monaco editor, then try again.' };
  }

  async focus(element) {
    if (!targetTracker.isEditable(element)) throw new Error('The selected editor is no longer available.');
    // Monaco keeps its model selection when blurred. Preserve its native input
    // selection too, without trying to interpret textarea offsets as code offsets.
    targetTracker.restore(element);
    // The popup owns browser focus. focus() on the already-active textarea may
    // not emit an event, leaving Monaco's internal input state blurred.
    if (!document.hasFocus()) element.dispatchEvent(new FocusEvent('focus'));
  }

  async clear() {
    // Starting a typing session inserts at the caret; existing code is retained.
  }

  async typeCharacter(element, char) {
    if (!element.isConnected) return { success: false, error: 'The selected editor was removed.' };
    if (document.activeElement !== element) element.focus({ preventScroll: true });
    // Simulate keyboard/text input. The frame-local helper temporarily prevents
    // Monaco from adding indentation and paired characters, then restores its
    // options immediately. No paste event or direct model edit is used.
    const token = crypto.randomUUID();
    element.setAttribute('data-paste-typer-target', token);
    try {
      return await chrome.runtime.sendMessage({ action: 'ptMonacoInput', token, text: char });
    } finally {
      element.removeAttribute('data-paste-typer-target');
    }
  }

  async simulateBackspace(element) {
    if (!element.isConnected) return { success: false, error: 'The selected editor was removed.' };
    if (document.activeElement !== element) element.focus({ preventScroll: true });
    return document.execCommand('delete', false)
      ? { success: true } : { success: false, error: 'Monaco did not accept backspace.' };
  }

  async reset(element) {
    await this.focus(element);
    element.dispatchEvent(new KeyboardEvent('keydown', {
      key: 'a', code: 'KeyA', keyCode: 65, which: 65,
      ctrlKey: !/Mac/.test(navigator.platform), metaKey: /Mac/.test(navigator.platform),
      bubbles: true, cancelable: true
    }));
    this._key(element, 'Backspace', 8);
  }

  _key(element, key, keyCode) {
    for (const type of ['keydown', 'keyup']) {
      element.dispatchEvent(new KeyboardEvent(type, {
        key, code: key, keyCode, which: keyCode, bubbles: true, cancelable: true
      }));
    }
  }
}
