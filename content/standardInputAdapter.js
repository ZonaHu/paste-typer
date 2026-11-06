/**
 * Standard Input Adapter
 * 
 * 处理标准的 HTML input/textarea/contenteditable 元素。
 */

class StandardInputAdapter extends InputAdapter {
  constructor() {
    super();
  }

  /**
   * 检测是否为标准输入环境
   */
  static detect() {
    // 标准适配器作为默认适配器，总是返回 true
    return true;
  }

  /**
   * 获取标准输入目标
   */
  async getTarget(useActiveElement = true) {
    let targetElement = null;

    if (useActiveElement && targetTracker.element && !targetTracker.getTarget()) {
      return { element: null, error: 'The selected input is no longer editable. Click another input and try again.' };
    }

    if (useActiveElement) {
      targetElement = targetTracker.getTarget() || document.activeElement;
      
      if (this._isEditableElement(targetElement)) {
        return { element: targetElement };
      }
    }

    targetElement = this._findBestEditableElement();

    if (!targetElement) {
      return {
        element: null,
        error: '未找到可编辑的输入框。请点击输入框后再试。'
      };
    }

    return { element: targetElement };
  }

  async focus(element) {
    targetTracker.restore(element);
    await this._sleep(50);
  }

  /**
   * 清空目标元素。覆写基类，用原生 setter 写入以兼容 React/Vue（基类直接
   * element.value='' 会绕过框架的 _valueTracker）。
   */
  async clear(element) {
    if (!element) return;
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      this._setNativeValue(element, '');
      element.dispatchEvent(new Event('input', { bubbles: true }));
    } else if (element.contentEditable === 'true' || element.isContentEditable) {
      element.textContent = '';
    }
  }

  /**
   * 在标准元素中输入单个字符
   */
  async typeCharacter(element, char) {
    return this._edit(element, char);
  }

  async simulateBackspace(element) {
    return this._edit(element, '', true);
  }

  // Keep page-owned edits and our fallback in one sequence. A canceled hook,
  // moved caret or protected target must never be followed by a forced edit.
  async _edit(element, char, deleting = false) {
    const mismatch = () => ({ success: false, error: deleting
      ? 'The page changed or rejected backspace. Typing stopped.'
      : 'The page changed or rejected the typed text. Check the input and try again.' });
    const available = () => this._isEditableElement(element) && !element.matches(':disabled') &&
      !element.closest('[inert]') && document.activeElement === element;
    if (!available()) return mismatch();
    const nativeField = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA';
    const readValue = () => nativeField ? element.value : element.textContent;
    const previousValue = readValue();
    const original = this._editSelection(element, nativeField);
    if (!original) return mismatch();
    const markup = nativeField ? null : element.innerHTML;
    let from = original.start, to = original.end;
    if (deleting) {
      // The Unicode change supplies this helper; the independent adapter also
      // works without it, using the existing UTF-16 deletion convention.
      [from, to] = typeof PTGraphemes !== 'undefined'
        ? PTGraphemes.deletionRange(previousValue, from, to)
        : [from === to ? Math.max(0, from - 1) : from, to];
    }
    const expectedValue = previousValue.slice(0, from) + char + previousValue.slice(to);
    const expectedCaret = from + char.length;
    const keyInfo = deleting ? { code: 'Backspace', keyCode: 8, charCode: 8 } : this._getKeyInfo(char);
    const keyboard = type => new KeyboardEvent(type, {
      key: deleting ? 'Backspace' : char, code: keyInfo.code,
      keyCode: type === 'keypress' ? keyInfo.charCode : keyInfo.keyCode,
      which: type === 'keypress' ? keyInfo.charCode : keyInfo.keyCode,
      bubbles: true, cancelable: true
    });
    let sawInput = false, mutated = false, keydownSent = false, succeeded = false;
    const observeInput = () => { sawInput = true; };
    const observer = nativeField ? null : new MutationObserver(() => { mutated = true; });
    observer?.observe(element, { childList: true, characterData: true, attributes: true, subtree: true });
    element.addEventListener('input', observeInput, true);
    const atExpectedCaret = selected => selected && selected.start === expectedCaret && selected.end === expectedCaret;
    const accepted = () => available() && readValue() === expectedValue &&
      atExpectedCaret(this._editSelection(element, nativeField));
    const sameRange = selected => selected && selected.start === original.start && selected.end === original.end &&
      (nativeField ? selected.direction === original.direction :
        selected.startNode === original.startNode && selected.startOffset === original.startOffset &&
        selected.endNode === original.endNode && selected.endOffset === original.endOffset);
    const inspect = () => {
      if (!available()) return 'changed';
      const selected = this._editSelection(element, nativeField);
      const changedEdit = expectedValue !== previousValue || original.start !== original.end ||
        expectedCaret !== original.start || sawInput;
      if (changedEdit && readValue() === expectedValue && atExpectedCaret(selected)) return 'handled';
      if (readValue() === previousValue && sameRange(selected) && !sawInput &&
          (nativeField || element.innerHTML === markup && !mutated && !observer.takeRecords().length)) return 'unchanged';
      return 'changed';
    };
    const dispatch = async event => {
      const allowed = element.dispatchEvent(event);
      await Promise.resolve();
      const state = inspect();
      // A hook can implement a literal edit and cancel the browser default.
      // It owns that attempt, including the input event it already emitted.
      if (state === 'handled') return true;
      if (!allowed || state !== 'unchanged') throw new Error('Input intercepted');
      return false;
    };
    try {
      keydownSent = true;
      let handled = await dispatch(keyboard('keydown'));
      if (!handled && !deleting) handled = await dispatch(keyboard('keypress'));
      if (!handled) handled = await dispatch(new InputEvent('beforeinput', {
        data: deleting ? null : char, inputType: deleting ? 'deleteContentBackward' : 'insertText',
        bubbles: true, cancelable: true
      }));
      if (!handled) {
        if (inspect() !== 'unchanged') throw new Error('Input target changed');
        if (nativeField) {
          this._setNativeValue(element, expectedValue);
          if (original.hasSelection) element.setSelectionRange(expectedCaret, expectedCaret);
        } else {
          const range = document.createRange();
          // Equal text offsets can sit on different sides of a paragraph or
          // formatting boundary. Keep the actual DOM endpoints unless backspace
          // expands that endpoint to include the preceding grapheme.
          const first = from === original.start
            ? { node: original.startNode, offset: original.startOffset } : this._textPoint(element, from);
          const last = to === original.end
            ? { node: original.endNode, offset: original.endOffset } : this._textPoint(element, to);
          range.setStart(first.node, first.offset); range.setEnd(last.node, last.offset);
          range.deleteContents();
          if (!deleting) {
            const node = document.createTextNode(char); range.insertNode(node); range.setStartAfter(node);
          }
          range.collapse(true);
          const selection = window.getSelection(); selection.removeAllRanges(); selection.addRange(range);
        }
      }
      if (!sawInput) element.dispatchEvent(new InputEvent('input', {
        data: deleting ? null : char, inputType: deleting ? 'deleteContentBackward' : 'insertText', bubbles: true
      }));
      await Promise.resolve();
      succeeded = accepted();
    } catch {
      // No retry: an intercepted or partly accepted edit may already be visible.
    } finally {
      if (keydownSent) { element.dispatchEvent(keyboard('keyup')); await Promise.resolve(); }
      observer?.disconnect();
      element.removeEventListener('input', observeInput, true);
    }
    return succeeded && accepted() ? { success: true } : mismatch();
  }

  _editSelection(element, nativeField) {
    if (nativeField) {
      const hasSelection = typeof element.selectionStart === 'number';
      return { hasSelection, start: hasSelection ? element.selectionStart : element.value.length,
        end: hasSelection ? element.selectionEnd : element.value.length, direction: element.selectionDirection };
    }
    const selection = window.getSelection();
    if (!selection?.rangeCount) return null;
    const range = selection.getRangeAt(0);
    if (!element.contains(range.startContainer) || !element.contains(range.endContainer)) return null;
    const prefix = document.createRange(); prefix.selectNodeContents(element);
    prefix.setEnd(range.startContainer, range.startOffset); const start = prefix.toString().length;
    prefix.setEnd(range.endContainer, range.endOffset); const end = prefix.toString().length;
    return { start, end, startNode: range.startContainer, startOffset: range.startOffset,
      endNode: range.endContainer, endOffset: range.endOffset };
  }

  // Map text offsets back into the existing DOM without flattening its markup.
  _textPoint(element, offset) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    let node;
    while ((node = walker.nextNode())) {
      if (offset <= node.data.length) return { node, offset };
      offset -= node.data.length;
    }
    return { node: element, offset: element.childNodes.length };
  }

  /**
   * 通过原型上的原生 value setter 写入值。
   *
   * React/Vue 会在 input 实例上覆写 value setter 并用 _valueTracker 跟踪值。
   * 直接 `element.value =` 会绕过框架跟踪器，导致 onChange 不触发、状态不同步。
   * 调用原生原型 setter 可让跟踪器在随后的 input 事件中检测到变化。
   */
  _setNativeValue(element, value) {
    const proto = element.tagName === 'TEXTAREA'
      ? window.HTMLTextAreaElement.prototype
      : window.HTMLInputElement.prototype;
    const descriptor = Object.getOwnPropertyDescriptor(proto, 'value');
    if (descriptor && descriptor.set) {
      descriptor.set.call(element, value);
    } else {
      element.value = value;
    }
  }

  /**
   * 检查元素是否可编辑
   */
  _isEditableElement(element) {
    if (!element || !element.isConnected || element.closest('#paste-typer-floating-ui')) return false;

    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      return element.type !== 'hidden' && !element.disabled && !element.readOnly;
    }

    if (element.contentEditable === 'true' || element.isContentEditable) {
      return true;
    }

    return false;
  }

  /**
   * 查找最佳可编辑元素
   */
  _findBestEditableElement() {
    const inputs = document.querySelectorAll('input, textarea');
    for (const input of inputs) {
      if (this._isEditableElement(input)) {
        return input;
      }
    }

    const editables = document.querySelectorAll('[contenteditable="true"]');
    for (const editable of editables) {
      if (editable !== document.body && editable.offsetWidth > 0 && editable.offsetHeight > 0) {
        return editable;
      }
    }

    return null;
  }

  /**
   * 获取字符的按键信息：DOM `code`、传统 `keyCode`（虚拟键码）与 `charCode`。
   * keyCode 用于 keydown/keyup，charCode 用于 keypress。
   */
  _getKeyInfo(char) {
    const charCode = char.length ? char.codePointAt(0) : 32;

    // 特殊键
    if (char === ' ' || char.length === 0) return { code: 'Space', keyCode: 32, charCode: 32 };
    if (char === '\n' || char === '\r') return { code: 'Enter', keyCode: 13, charCode: 13 };
    if (char === '\t') return { code: 'Tab', keyCode: 9, charCode: 9 };

    // 字母
    if (/[a-zA-Z]/.test(char)) {
      const upper = char.toUpperCase();
      return { code: `Key${upper}`, keyCode: upper.charCodeAt(0), charCode };
    }

    // 数字
    if (/[0-9]/.test(char)) {
      return { code: `Digit${char}`, keyCode: char.charCodeAt(0), charCode };
    }

    // 常见标点，映射到对应的物理键 code 与传统 keyCode
    const punct = {
      ';': { code: 'Semicolon', keyCode: 186 }, ':': { code: 'Semicolon', keyCode: 186 },
      '=': { code: 'Equal', keyCode: 187 }, '+': { code: 'Equal', keyCode: 187 },
      ',': { code: 'Comma', keyCode: 188 }, '<': { code: 'Comma', keyCode: 188 },
      '-': { code: 'Minus', keyCode: 189 }, '_': { code: 'Minus', keyCode: 189 },
      '.': { code: 'Period', keyCode: 190 }, '>': { code: 'Period', keyCode: 190 },
      '/': { code: 'Slash', keyCode: 191 }, '?': { code: 'Slash', keyCode: 191 },
      '`': { code: 'Backquote', keyCode: 192 }, '~': { code: 'Backquote', keyCode: 192 },
      '[': { code: 'BracketLeft', keyCode: 219 }, '{': { code: 'BracketLeft', keyCode: 219 },
      '\\': { code: 'Backslash', keyCode: 220 }, '|': { code: 'Backslash', keyCode: 220 },
      ']': { code: 'BracketRight', keyCode: 221 }, '}': { code: 'BracketRight', keyCode: 221 },
      "'": { code: 'Quote', keyCode: 222 }, '"': { code: 'Quote', keyCode: 222 },
      ')': { code: 'Digit0', keyCode: 48 }, '!': { code: 'Digit1', keyCode: 49 },
      '@': { code: 'Digit2', keyCode: 50 }, '#': { code: 'Digit3', keyCode: 51 },
      '$': { code: 'Digit4', keyCode: 52 }, '%': { code: 'Digit5', keyCode: 53 },
      '^': { code: 'Digit6', keyCode: 54 }, '&': { code: 'Digit7', keyCode: 55 },
      '*': { code: 'Digit8', keyCode: 56 }, '(': { code: 'Digit9', keyCode: 57 }
    };
    if (punct[char]) {
      return { code: punct[char].code, keyCode: punct[char].keyCode, charCode };
    }

    // 其他（含 Unicode）：无物理键 code，keyCode 退回到码点
    return { code: 'Unidentified', keyCode: charCode, charCode };
  }
}

