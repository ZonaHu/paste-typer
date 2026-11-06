// A code widget is a contiguous run of sibling, one-character text inputs.
// Capture that run once: auto-focus must never redirect typing into another form.
class SplitCodeInputAdapter extends StandardInputAdapter {
  static isCodeInput(element) {
    if (!element || element.tagName !== 'INPUT' || element.maxLength !== 1 ||
        !['text', 'tel', 'password'].includes(element.type) || !element.isConnected ||
        element.disabled || element.readOnly || element.matches(':disabled') ||
        element.closest('#paste-typer-floating-ui, [hidden], [inert]') ||
        !element.getClientRects().length) return false;
    const visibility = window.getComputedStyle(element).visibility;
    return visibility !== 'hidden' && visibility !== 'collapse';
  }

  static groupFor(element) {
    if (!this.isCodeInput(element)) return [];
    const group = [element];
    let sibling = element.previousElementSibling;
    while (this.isCodeInput(sibling)) {
      group.unshift(sibling);
      sibling = sibling.previousElementSibling;
    }
    sibling = element.nextElementSibling;
    while (this.isCodeInput(sibling)) {
      group.push(sibling);
      sibling = sibling.nextElementSibling;
    }
    return group.length > 1 ? group : [];
  }

  static detect(element) {
    return this.groupFor(element).length > 1;
  }

  async focus(element) {
    this.group = SplitCodeInputAdapter.groupFor(element);
    this.index = this.group.indexOf(element);
    this.history = [];
    if (this.index < 0) throw new Error('The selected code inputs are no longer available.');
    await super.focus(element);
  }

  _available(element) {
    return SplitCodeInputAdapter.isCodeInput(element) && this.group.every((input, index) =>
      input.isConnected && input.parentElement === element.parentElement &&
      (!index || input.previousElementSibling === this.group[index - 1]));
  }

  _key(element, type, char) {
    const backspace = char === 'Backspace';
    const info = backspace ? { code: 'Backspace', keyCode: 8, charCode: 8 } : this._getKeyInfo(char);
    return element.dispatchEvent(new KeyboardEvent(type, { key: char, code: info.code,
      keyCode: type === 'keypress' ? info.charCode : info.keyCode,
      which: type === 'keypress' ? info.charCode : info.keyCode,
      bubbles: true, cancelable: true }));
  }

  _edit(element, char, deleting = false) {
    const key = deleting ? 'Backspace' : char;
    let accepted = this._key(element, 'keydown', key);
    if (!deleting && accepted) accepted = this._key(element, 'keypress', key);
    const inputType = deleting ? 'deleteContentBackward' : 'insertText';
    if (accepted) accepted = element.dispatchEvent(new InputEvent('beforeinput', {
      data: deleting ? null : char, inputType, bubbles: true, cancelable: true
    }));
    // A page handler may disable, remove or redirect the field during key events.
    if (accepted && this._available(element) && document.activeElement === element) {
      // Native editing preserves Chrome's selection and Undo history. Some pages
      // reject execCommand; the native setter retains framework notifications there.
      const previous = element.value;
      const edited = document.execCommand(deleting ? 'delete' : 'insertText', false, deleting ? null : char);
      if (!edited && element.value === previous) {
        this._setNativeValue(element, deleting ? '' : char);
        element.setSelectionRange(element.value.length, element.value.length);
        element.dispatchEvent(new InputEvent('input', {
          data: deleting ? null : char, inputType, bubbles: true
        }));
      }
    } else {
      accepted = false;
    }
    this._key(element, 'keyup', key);
    return accepted && element.value === (deleting ? '' : char);
  }

  async typeCharacter(element, char) {
    const target = this.group?.[this.index];
    if (!target) return { success: false, error: 'The code input group is full. Remaining text was not inserted.' };
    if (!this._available(target) || !this.group.includes(document.activeElement)) {
      return { success: false, error: 'The selected code input is no longer available. Click it and try again.' };
    }
    if (char.length !== 1 || /[\r\n\t]/.test(char)) {
      return { success: false, error: 'Code inputs accept one character per box.' };
    }
    target.focus({ preventScroll: true });
    target.setSelectionRange(0, target.value.length);
    if (!this._edit(target, char)) return { success: false, error: 'The code input did not accept the character.' };
    this.history.push(this.index);
    this.index++;
    const next = this.group[this.index];
    // Honor the page's own auto-advance; only advance ourselves if it stayed put.
    if (next && document.activeElement === target && this._available(next)) next.focus({ preventScroll: true });
    return { success: true };
  }

  async simulateBackspace() {
    const index = this.history[this.history.length - 1];
    const target = this.group?.[index];
    if (!target || !this._available(target) || !this.group.includes(document.activeElement)) {
      return { success: false, error: 'The code input is no longer available for correction.' };
    }
    // Auto-advance may already have focused the next box. Correct the last
    // inserted digit, rather than deleting a pre-existing neighbouring digit.
    target.focus({ preventScroll: true });
    target.setSelectionRange(0, target.value.length);
    if (!this._edit(target, '', true)) return { success: false, error: 'The code input did not accept backspace.' };
    this.history.pop();
    this.index = index;
    return { success: true };
  }
}
