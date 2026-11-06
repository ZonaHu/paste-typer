// A code widget is a contiguous run of sibling, one-character text inputs.
// Capture that run once: auto-focus must never redirect typing into another form.
class SplitCodeInputAdapter extends StandardInputAdapter {
  static isCodeInput(element) {
    if (!element || element.tagName !== 'INPUT' || element.maxLength !== 1 ||
        !['text', 'tel', 'password'].includes(element.type) || !element.isConnected ||
        element.disabled || element.readOnly || element.matches(':disabled') ||
        element.closest('#paste-typer-floating-ui, [hidden], [inert]') ||
        !element.getClientRects().length) return false;
    for (let ancestor = element; ancestor; ancestor = ancestor.parentElement) {
      const style = window.getComputedStyle(ancestor);
      if (style.visibility === 'hidden' || style.visibility === 'collapse' ||
          style.opacity === '0' || style.contentVisibility === 'hidden') return false;
    }
    return true;
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

  async _edit(element, char, deleting = false) {
    const key = deleting ? 'Backspace' : char;
    const expected = deleting ? '' : char;
    const original = element.value;
    const inputType = deleting ? 'deleteContentBackward' : 'insertText';
    let sawInput = false;
    const observeInput = () => { sawInput = true; };
    element.addEventListener('input', observeInput);
    // Widgets may implement the edit and auto-advance inside a canceled key or
    // beforeinput handler. Do not insert again after the page accepted it.
    const pageHandled = () => element.value === expected && (element.value !== original || sawInput);
    try {
      let allowed = this._key(element, 'keydown', key);
      await Promise.resolve();
      if (!pageHandled() && !deleting && allowed) {
        allowed = this._key(element, 'keypress', key);
        await Promise.resolve();
      }
      if (!pageHandled() && allowed) {
        allowed = element.dispatchEvent(new InputEvent('beforeinput', {
          data: deleting ? null : char, inputType, bubbles: true, cancelable: true
        }));
        await Promise.resolve();
      }
      let edited = pageHandled();
      // A page handler may disable, remove or redirect the field during events.
      if (!edited && allowed && this._available(element) && document.activeElement === element) {
        // Native editing preserves Chrome's selection and Undo history. Fall
        // back only when the command produced neither a change nor an input.
        const previous = element.value;
        const commandAccepted = document.execCommand(deleting ? 'delete' : 'insertText', false, deleting ? null : char);
        await Promise.resolve();
        if (!commandAccepted && !sawInput && element.value === previous &&
            this._available(element) && document.activeElement === element) {
          this._setNativeValue(element, expected);
          element.setSelectionRange(expected.length, expected.length);
          element.dispatchEvent(new InputEvent('input', {
            data: deleting ? null : char, inputType, bubbles: true
          }));
        }
        edited = true;
      }
      this._key(element, 'keyup', key);
      // Framework input/keyup handlers may restore a rejected value in a
      // microtask; report that rejection before advancing to another box.
      await Promise.resolve();
      return edited && this._available(element) && element.value === expected;
    } finally {
      element.removeEventListener('input', observeInput);
    }
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
    if (!await this._edit(target, char)) return { success: false, error: 'The code input did not accept the character.' };
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
    if (!await this._edit(target, '', true)) return { success: false, error: 'The code input did not accept backspace.' };
    this.history.pop();
    this.index = index;
    return { success: true };
  }
}
