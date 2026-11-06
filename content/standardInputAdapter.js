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
    if (!this._isEditableElement(element)) {
      return { success: false, error: 'The selected input is no longer editable. Click another input and try again.' };
    }

    const nativeField = element.tagName === 'INPUT' || element.tagName === 'TEXTAREA';
    const previousValue = nativeField ? element.value : element.textContent;
    const selection = nativeField ? null : window.getSelection();
    const hasSelection = nativeField && typeof element.selectionStart === 'number';
    let start = hasSelection ? element.selectionStart : previousValue.length;
    let end = hasSelection ? element.selectionEnd : start;
    let range;
    if (!nativeField) {
      range = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : document.createRange();
      if (!selection.rangeCount || !element.contains(range.startContainer) || !element.contains(range.endContainer)) {
        range.selectNodeContents(element);
        range.collapse(false);
      }
      // Capture text offsets before page key handlers can mutate the document.
      const prefix = document.createRange();
      prefix.selectNodeContents(element);
      prefix.setEnd(range.startContainer, range.startOffset);
      start = prefix.toString().length;
      prefix.setEnd(range.endContainer, range.endOffset);
      end = prefix.toString().length;
      selection.removeAllRanges();
      selection.addRange(range);
    }
    const expectedValue = previousValue.substring(0, start) + char + previousValue.substring(end);
    const mismatch = () => ({ success: false,
      error: 'The page changed or rejected the typed text. Check the input and try again.' });
    const readValue = () => nativeField ? element.value : element.textContent;
    const keyInfo = this._getKeyInfo(char);
    const keyboard = (type, code) => new KeyboardEvent(type, {
      key: char, code: keyInfo.code, keyCode: code, which: code,
      bubbles: true, cancelable: true
    });
    const keydownAccepted = element.dispatchEvent(keyboard('keydown', keyInfo.keyCode));
    const keypressAccepted = element.dispatchEvent(keyboard('keypress', keyInfo.charCode));
    if (!this._isEditableElement(element)) return mismatch();
    const afterKeys = readValue();
    if (afterKeys !== previousValue && afterKeys !== expectedValue) return mismatch();
    if (afterKeys === previousValue) {
      if (!keydownAccepted || !keypressAccepted) return mismatch();
      if (nativeField) {
        this._setNativeValue(element, expectedValue);
        if (hasSelection) element.selectionStart = element.selectionEnd = start + 1;
      } else {
        try {
          range.deleteContents();
          const textNode = document.createTextNode(char);
          range.insertNode(textNode);
          range.setStartAfter(textNode);
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
        } catch {
          document.execCommand('insertText', false, char);
        }
      }
    }
    // A page may handle the key itself. Its accepted insertion must not be doubled.
    element.dispatchEvent(new InputEvent('input', {
      data: char, inputType: 'insertText', bubbles: true, cancelable: true
    }));
    element.dispatchEvent(keyboard('keyup', keyInfo.keyCode));
    // Framework handlers can apply their response in the event's microtask queue.
    await Promise.resolve();
    return this._isEditableElement(element) && readValue() === expectedValue ? { success: true } : mismatch();
  }

  /**
   * 模拟退格键（标准输入）
   */
  async simulateBackspace(element) {
    if (!element) {
      return { success: false, error: '目标元素无效' };
    }

    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      const currentValue = element.value;
      let expected = currentValue;
      if (currentValue.length > 0) {
        const start = element.selectionStart;
        const end = element.selectionEnd;
        
        if (start === end && start > 0) {
          expected = currentValue.substring(0, start - 1) + currentValue.substring(start);
          this._setNativeValue(element, expected);
          element.selectionStart = element.selectionEnd = start - 1;
        } else if (start !== end) {
          expected = currentValue.substring(0, start) + currentValue.substring(end);
          this._setNativeValue(element, expected);
          element.selectionStart = element.selectionEnd = start;
        }
      }
      
      const backspaceDown = new KeyboardEvent('keydown', {
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        bubbles: true,
        cancelable: true
      });
      element.dispatchEvent(backspaceDown);
      
      const inputEvent = new InputEvent('input', {
        inputType: 'deleteContentBackward',
        bubbles: true,
        cancelable: false
      });
      element.dispatchEvent(inputEvent);
      
      const backspaceUp = new KeyboardEvent('keyup', {
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        bubbles: true,
        cancelable: true
      });
      element.dispatchEvent(backspaceUp);
      
      await this._sleep(10);
      await Promise.resolve();
      if (!element.isConnected || element.value !== expected) {
        return { success: false, error: 'The page changed or rejected backspace. Typing stopped.' };
      }
      return { success: true };
    }
    
    if (element.contentEditable === 'true' || element.isContentEditable) {
      const selection = window.getSelection();
      const currentValue = element.textContent;
      let expected = currentValue;
      
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        
        if (range.collapsed && range.startOffset > 0) {
          range.setStart(range.startContainer, range.startOffset - 1);
        }
        if (!range.collapsed) {
          const prefix = document.createRange();
          prefix.selectNodeContents(element);
          prefix.setEnd(range.startContainer, range.startOffset);
          const start = prefix.toString().length;
          prefix.setEnd(range.endContainer, range.endOffset);
          const end = prefix.toString().length;
          expected = currentValue.substring(0, start) + currentValue.substring(end);
          range.deleteContents();
        }
        
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      }
      
      const backspaceDown = new KeyboardEvent('keydown', {
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        bubbles: true,
        cancelable: true
      });
      element.dispatchEvent(backspaceDown);
      
      const inputEvent = new InputEvent('input', {
        inputType: 'deleteContentBackward',
        bubbles: true,
        cancelable: false
      });
      element.dispatchEvent(inputEvent);
      
      const backspaceUp = new KeyboardEvent('keyup', {
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        bubbles: true,
        cancelable: true
      });
      element.dispatchEvent(backspaceUp);
      
      await this._sleep(10);
      await Promise.resolve();
      if (!element.isConnected || element.textContent !== expected) {
        return { success: false, error: 'The page changed or rejected backspace. Typing stopped.' };
      }
      return { success: true };
    }
    
    return { success: false, error: '不支持的元素类型' };
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

