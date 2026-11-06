// ProseMirror observes browser edits and owns the resulting model/history.
// A CSS match only chooses this safe path; the frame helper also verifies the
// real document description before editing. Do not infer an editor from a URL.
class ProseMirrorAdapter extends InputAdapter {
  static root(element) {
    if (!element || element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') return null;
    const root = element.closest?.('.ProseMirror');
    const boundary = element.closest?.('[contenteditable="false"]');
    return root && (!boundary || boundary === root || !root.contains(boundary)) ? root : null;
  }

  static detect(element) {
    return !!ProseMirrorAdapter.root(element);
  }

  async getTarget() {
    const root = ProseMirrorAdapter.root(targetTracker.getTarget() || document.activeElement);
    return root && targetTracker.isEditable(root) ? { element: root }
      : { element: null, error: 'Click inside an editable ProseMirror editor, then try again.' };
  }

  async focus(element) {
    if (!targetTracker.isEditable(element)) throw new Error('The selected editor is no longer editable.');
    const remembered = targetTracker.getTarget();
    targetTracker.restore(remembered && element.contains(remembered) ? remembered : element);
    element.focus({ preventScroll: true });
  }

  async clear(element) {
    await this.reset(element);
  }

  async typeCharacter(element, char) {
    return this._input(element, char, 'type');
  }

  async simulateBackspace(element) {
    return this._input(element, '', 'backspace');
  }

  async reset(element) {
    await this.focus(element);
    const result = await this._input(element, '', 'clear');
    if (!result?.success) throw new Error(result?.error || 'The editor did not accept Clear.');
  }

  async _input(element, text, operation) {
    if (!targetTracker.isEditable(element)) return { success: false, error: 'The selected editor is no longer editable.' };
    const token = crypto.randomUUID();
    element.setAttribute('data-paste-typer-prosemirror-target', token);
    try {
      return await chrome.runtime.sendMessage({ action: 'ptProseMirrorInput', token, text, operation });
    } finally {
      element.removeAttribute('data-paste-typer-prosemirror-target');
    }
  }
}
