// CodeMirror owns its document and undo history. Its rendered contenteditable
// is only a view, so edits go through the selected view's transaction API.
class CodeMirrorAdapter extends InputAdapter {
  static detect(element) {
    const content = element?.closest('.cm-content');
    // Widgets may contain independent native fields or editing hosts. Their
    // nearest owner must remain the target, rather than the surrounding model.
    return !!content?.closest('.cm-editor') &&
      element.closest('input, textarea, select, [contenteditable]') === content;
  }

  async getTarget() {
    const remembered = targetTracker.getTarget();
    const element = CodeMirrorAdapter.detect(remembered) ? remembered.closest('.cm-content') : null;
    return element ? { element }
      : { element: null, error: 'Click inside the CodeMirror editor, then try again.' };
  }

  async focus(element) {
    const result = await this._request(element, 'focus');
    if (!result?.success) throw new Error(result?.error || 'Cannot focus the selected CodeMirror editor.');
  }

  async typeCharacter(element, char) {
    return this._request(element, 'type', char);
  }

  async simulateBackspace(element) {
    return this._request(element, 'backspace');
  }

  async reset(element) {
    const result = await this._request(element, 'clear');
    if (!result?.success) throw new Error(result?.error || 'Cannot clear the selected CodeMirror editor.');
  }

  async clear(element) {
    await this.reset(element);
  }

  async _request(element, operation, text) {
    if (!element?.isConnected) return { success: false, error: 'The selected CodeMirror editor was removed.' };
    const token = crypto.randomUUID();
    element.setAttribute('data-paste-typer-target', token);
    try {
      return await chrome.runtime.sendMessage({ action: 'ptCodeMirrorInput', token, operation,
        ...(operation === 'type' ? { text } : {}) }) ||
        { success: false, error: 'The selected CodeMirror editor did not accept the input request.' };
    } finally {
      if (element.getAttribute('data-paste-typer-target') === token) element.removeAttribute('data-paste-typer-target');
    }
  }
}
