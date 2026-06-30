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

    if (useActiveElement) {
      targetElement = document.activeElement;
      
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

  /**
   * 在标准元素中输入单个字符
   */
  async typeCharacter(element, char) {
    if (!element) {
      return { success: false, error: '目标元素无效' };
    }

    const keyInfo = this._getKeyInfo(char);

    const keydownEvent = new KeyboardEvent('keydown', {
      key: char,
      code: keyInfo.code,
      keyCode: keyInfo.keyCode,
      which: keyInfo.keyCode,
      bubbles: true,
      cancelable: true
    });

    const keypressEvent = new KeyboardEvent('keypress', {
      key: char,
      code: keyInfo.code,
      keyCode: keyInfo.charCode,
      which: keyInfo.charCode,
      bubbles: true,
      cancelable: true
    });

    const inputEvent = new InputEvent('input', {
      data: char,
      inputType: 'insertText',
      bubbles: true,
      cancelable: true
    });

    const keyupEvent = new KeyboardEvent('keyup', {
      key: char,
      code: keyInfo.code,
      keyCode: keyInfo.keyCode,
      which: keyInfo.keyCode,
      bubbles: true,
      cancelable: true
    });

    element.dispatchEvent(keydownEvent);
    element.dispatchEvent(keypressEvent);

    // 实际插入字符
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      const start = element.selectionStart;
      const end = element.selectionEnd;
      const value = element.value;
      element.value = value.substring(0, start) + char + value.substring(end);
      element.selectionStart = element.selectionEnd = start + 1;
    } else if (element.contentEditable === 'true' || element.isContentEditable) {
      const selection = window.getSelection();
      
      if (selection.rangeCount === 0) {
        const range = document.createRange();
        range.selectNodeContents(element);
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      }

      try {
        const range = selection.getRangeAt(0);
        const textNode = document.createTextNode(char);
        range.insertNode(textNode);
        range.setStartAfter(textNode);
        range.collapse(true);
        selection.removeAllRanges();
        selection.addRange(range);
      } catch (e) {
        document.execCommand('insertText', false, char);
      }
    }

    element.dispatchEvent(inputEvent);
    element.dispatchEvent(keyupEvent);

    return { success: true };
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
      if (currentValue.length > 0) {
        const start = element.selectionStart;
        const end = element.selectionEnd;
        
        if (start === end && start > 0) {
          element.value = currentValue.substring(0, start - 1) + currentValue.substring(start);
          element.selectionStart = element.selectionEnd = start - 1;
        } else if (start !== end) {
          element.value = currentValue.substring(0, start) + currentValue.substring(end);
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
      return { success: true };
    }
    
    if (element.contentEditable === 'true' || element.isContentEditable) {
      const selection = window.getSelection();
      
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        
        if (!range.collapsed) {
          range.deleteContents();
        } else if (range.startOffset > 0) {
          range.setStart(range.startContainer, range.startOffset - 1);
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
      return { success: true };
    }
    
    return { success: false, error: '不支持的元素类型' };
  }

  /**
   * 检查元素是否可编辑
   */
  _isEditableElement(element) {
    if (!element) return false;

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

