if (typeof globalThis.PT_DEBUG === "undefined") {
  globalThis.PT_DEBUG = false;
  globalThis.debug = {
    log: (...a) => { if (globalThis.PT_DEBUG) console.log(...a); },
    warn: (...a) => { if (globalThis.PT_DEBUG) console.warn(...a); }
  };
}

/**
 * Google Docs Input Adapter
 *
 * Modern Google Docs (since ~2021) renders the document to a <canvas>; the DOM
 * holds no editable text. Keystrokes are delivered through a hidden input sink:
 * the `.docs-texteventtarget-iframe` iframe. Docs only reacts to an event
 * sequence dispatched INTO that iframe's document — writing into the visible
 * `.kix-*` editor does nothing.
 *
 * Verified working sequence per character (against live canvas Docs):
 *   keydown → keypress → textInput (legacy TextEvent) → keyup
 * dispatched on the iframe document's active element, using the iframe's own
 * window/document constructors. The legacy `textInput` event is the one Docs
 * consumes to insert the character; the surrounding key events keep its input
 * model in sync. `beforeinput`/`execCommand` into the main editor do NOT work.
 */

class GoogleDocsAdapter extends InputAdapter {
  constructor() {
    super();
  }

  /**
   * 检测是否为 Google Docs / Slides 环境。
   * Docs 和 Slides 共用同一套 canvas 编辑器基建（隐藏的
   * .docs-texteventtarget-iframe 输入层），逐字输入序列完全相同。
   */
  static detect() {
    const hostname = window.location.hostname;
    const pathname = window.location.pathname;

    const isEditorPage = hostname === 'docs.google.com' &&
      (pathname.startsWith('/document/') || pathname.startsWith('/presentation/'));
    if (!isEditorPage) return false;

    // 优先看共用的输入靶 iframe；Docs 还有 kix 编辑器可作后备判据。
    const hasEditor = document.querySelector('.docs-texteventtarget-iframe') ||
                      document.querySelector('#docs-editor') ||
                      document.querySelector('[class*="kix-"]');
    const detected = !!hasEditor;
    debug.log('[GoogleDocsAdapter] detect():', { hostname, pathname, detected });
    return detected;
  }

  /**
   * 返回 Google Docs 的输入靶：隐藏的事件目标 iframe。
   * 存储这个稳定的页面级元素，实际输入时再解析它的 contentDocument。
   */
  async getTarget() {
    const iframe = document.querySelector('.docs-texteventtarget-iframe');
    if (iframe && iframe.contentDocument) {
      debug.log('[GoogleDocsAdapter] Using texteventtarget iframe');
      return { element: iframe };
    }

    // 兜底：旧版 Docs 或未加载的极少数情况，退回到可编辑元素。
    const editable = document.querySelector('.kix-page-content-wrapper [contenteditable="true"]') ||
                     document.querySelector('[contenteditable="true"]');
    if (editable) {
      debug.warn('[GoogleDocsAdapter] Falling back to contenteditable target');
      return { element: editable };
    }

    return {
      element: null,
      error: '无法定位 Google Docs 输入层。请先点击文档正文区域，把光标放进文档。'
    };
  }

  /**
   * 聚焦文档，使 iframe 的输入靶获得焦点。
   * 用户通常已经点进文档；这里尽力补一次，不保证。
   */
  async focus(element) {
    try {
      if (this._isEventIframe(element)) {
        element.contentWindow.focus();
      } else if (element && element.focus) {
        element.focus();
      }
    } catch (e) {
      debug.warn('[GoogleDocsAdapter] focus failed:', e.message);
    }
  }

  /**
   * Google Docs 不清空文档——那会破坏用户内容。只在当前光标处插入。
   */
  async clear() {
    debug.log('[GoogleDocsAdapter] clear() is a no-op on Google Docs');
  }

  /**
   * 在 Google Docs 中输入单个字符。
   */
  async typeCharacter(element, char) {
    const ctx = this._resolveTarget(element);
    if (!ctx) {
      return { success: false, error: '无法解析 Google Docs 输入靶' };
    }

    // 回车/换行：发送 Enter 键（新建段落），不走 textInput。
    if (char === '\n' || char === '\r') {
      this._dispatchKey(ctx, 'Enter', { code: 'Enter', keyCode: 13, withTextInput: false });
      return { success: true };
    }
    if (char === '\t') {
      this._dispatchKey(ctx, 'Tab', { code: 'Tab', keyCode: 9, withTextInput: false });
      return { success: true };
    }

    const info = this._getKeyInfo(char);
    this._dispatchKey(ctx, char, {
      code: info.code,
      keyCode: info.keyCode,
      charCode: info.charCode,
      withTextInput: true
    });
    return { success: true };
  }

  /**
   * 模拟退格（用于 typo 纠正）。
   */
  async simulateBackspace(element) {
    const ctx = this._resolveTarget(element);
    if (!ctx) {
      return { success: false, error: '无法解析 Google Docs 输入靶' };
    }
    this._dispatchKey(ctx, 'Backspace', { code: 'Backspace', keyCode: 8, withTextInput: false });
    return { success: true };
  }

  // --- 内部工具 -----------------------------------------------------------

  _isEventIframe(element) {
    return element && element.tagName === 'IFRAME' &&
      element.classList && element.classList.contains('docs-texteventtarget-iframe');
  }

  /**
   * 把存储的目标元素解析成一次派发所需的 { win, doc, target }。
   * target 优先取 iframe 文档里被聚焦的元素（聚焦后是一个 DIV），否则退回 body。
   */
  _resolveTarget(element) {
    // 存储的可能是 iframe 本身；若不是，实时再找一次 iframe。
    let iframe = this._isEventIframe(element)
      ? element
      : document.querySelector('.docs-texteventtarget-iframe');

    if (iframe && iframe.contentDocument) {
      const doc = iframe.contentDocument;
      const active = doc.activeElement;
      const target = (active && active !== doc.body) ? active : doc.body;
      return { win: iframe.contentWindow, doc, target };
    }

    // 兜底：直接对传入的可编辑元素派发。
    if (element && element.dispatchEvent) {
      return { win: window, doc: document, target: element };
    }
    return null;
  }

  /**
   * 按 Docs 认可的顺序派发一次按键：keydown → keypress → textInput → keyup。
   * 用目标 realm 自己的构造器，否则跨 frame 事件可能被忽略。
   */
  _dispatchKey(ctx, key, opts) {
    const { win, doc, target } = ctx;
    const code = opts.code || 'Unidentified';
    const keyCode = opts.keyCode || 0;
    const KE = win.KeyboardEvent || KeyboardEvent;

    target.dispatchEvent(new KE('keydown', {
      key, code, keyCode, which: keyCode, bubbles: true, cancelable: true
    }));

    if (opts.withTextInput) {
      const charCode = opts.charCode || key.charCodeAt(0);
      target.dispatchEvent(new KE('keypress', {
        key, code, keyCode: charCode, which: charCode, charCode, bubbles: true, cancelable: true
      }));
      // Docs 真正消费的是 legacy textInput 事件。
      try {
        const ti = doc.createEvent('TextEvent');
        ti.initTextEvent('textInput', true, true, win, key);
        target.dispatchEvent(ti);
      } catch (e) {
        // 极少数不支持 TextEvent 的情况：退回 beforeinput + input。
        try {
          const IE = win.InputEvent || InputEvent;
          target.dispatchEvent(new IE('beforeinput', { inputType: 'insertText', data: key, bubbles: true, cancelable: true }));
          target.dispatchEvent(new IE('input', { inputType: 'insertText', data: key, bubbles: true, cancelable: false }));
        } catch (e2) { /* 无能为力 */ }
      }
    }

    target.dispatchEvent(new KE('keyup', {
      key, code, keyCode, which: keyCode, bubbles: true, cancelable: true
    }));
  }

  /**
   * 字符的 DOM `code`、传统 `keyCode` 与 `charCode`。
   */
  _getKeyInfo(char) {
    const charCode = char.length ? char.codePointAt(0) : 32;
    if (char === ' ' || char.length === 0) return { code: 'Space', keyCode: 32, charCode: 32 };

    if (/[a-zA-Z]/.test(char)) {
      const upper = char.toUpperCase();
      return { code: `Key${upper}`, keyCode: upper.charCodeAt(0), charCode };
    }
    if (/[0-9]/.test(char)) {
      return { code: `Digit${char}`, keyCode: char.charCodeAt(0), charCode };
    }

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
    if (punct[char]) return { code: punct[char].code, keyCode: punct[char].keyCode, charCode };

    return { code: 'Unidentified', keyCode: charCode, charCode };
  }
}
