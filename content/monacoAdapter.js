// Monaco owns the document and undo history. Its textarea/EditContext is an
// input surface, not the document: never replace it with the full code.
class MonacoAdapter extends InputAdapter {
  static detect(element) {
    return !!(element && element.closest('.monaco-editor') &&
      ((element.tagName === 'TEXTAREA' && element.classList.contains('inputarea')) ||
       (element.classList.contains('native-edit-context') && typeof EditContext === 'function' &&
        element.editContext instanceof EditContext)));
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
    return this._input(element, char);
  }

  async _input(element, text, command = 'type') {
    if (!element.isConnected) return { success: false, error: 'The selected editor was removed.' };
    if (document.activeElement !== element) element.focus({ preventScroll: true });
    // Simulate keyboard/text input. The frame-local helper temporarily prevents
    // Monaco from adding indentation and paired characters, then restores its
    // options immediately. No paste event or direct model edit is used.
    const token = crypto.randomUUID();
    element.setAttribute('data-paste-typer-target', token);
    try {
      return await chrome.runtime.sendMessage({ action: 'ptMonacoInput', token, text, command });
    } finally {
      element.removeAttribute('data-paste-typer-target');
    }
  }

  async simulateBackspace(element) {
    return this._input(element, '', 'backspace');
  }

  async reset(element) {
    await this.focus(element);
    const result = await this._input(element, '', 'clear');
    if (!result?.success) throw Error(result?.error || 'Monaco did not accept Clear.');
  }
}
