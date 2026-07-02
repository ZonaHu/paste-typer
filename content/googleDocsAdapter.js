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
 * 专门处理 Google Docs (docs.google.com/document) 的输入逻辑。
 * 
 * Google Docs 使用自定义编辑器，不依赖标准的 DOM input/contenteditable：
 * - 使用 Canvas 渲染文档内容
 * - 通过隐藏的 iframe 或特殊事件处理输入
 * - 需要特殊的事件序列来触发文本插入
 * 
 * 实现策略（按优先级）：
 * 1. beforeinput + InputEvent (insertText) - 最可靠
 * 2. execCommand('insertText') - 备选方案
 * 3. KeyboardEvent 序列 - 兜底方案
 */

class GoogleDocsAdapter extends InputAdapter {
  constructor() {
    super();
    this.inputStrategy = null; // 运行时探测的最佳输入策略
    this.detectionCache = null; // 缓存检测结果
  }

  /**
   * 检测是否为 Google Docs 环境
   * 仅在 docs.google.com/document/* 路径下返回 true
   */
  static detect() {
    const hostname = window.location.hostname;
    const pathname = window.location.pathname;
    
    // 严格匹配：只在 docs.google.com/document/* 路径下
    const isDocsPage = hostname === 'docs.google.com' && pathname.startsWith('/document/');
    
    if (isDocsPage) {
      // 进一步验证是否有 Google Docs 特定的 DOM 元素
      // 这可以避免误判其他 Google 页面
      const hasDocsEditor = document.querySelector('#docs-editor') || 
                           document.querySelector('.kix-appview-editor') ||
                           document.querySelector('[class*="kix-"]');
      const detected = !!hasDocsEditor;
      debug.log('[GoogleDocsAdapter] detect() called:', {
        hostname,
        pathname,
        isDocsPage,
        hasDocsEditor,
        detected
      });
      return detected;
    }
    
    return false;
  }

  /**
   * 检查元素是否为搜索框或其他非编辑器元素
   */
  _isNonEditorElement(element) {
    if (!element) return true;
    
    // 排除搜索框
    if (element.classList) {
      const classes = Array.from(element.classList);
      if (classes.some(cls => 
        cls.includes('omnibox') || 
        cls.includes('search') || 
        cls.includes('toolbar') ||
        cls.includes('menu')
      )) {
        return true;
      }
    }
    
    // 排除 INPUT 元素（Google Docs 的编辑器是 contenteditable，不是 input）
    if (element.tagName === 'INPUT') {
      return true;
    }
    
    // 排除小的元素（可能是按钮或工具栏）
    const rect = element.getBoundingClientRect();
    if (rect.width < 200 || rect.height < 100) {
      return true;
    }
    
    return false;
  }

  /**
   * 获取 Google Docs 编辑器元素
   * 
   * 策略：
   * 1. 查找主编辑器（#docs-editor 或 .kix-appview-editor）- 最可靠
   * 2. 查找 iframe 中的编辑器
   * 3. 查找任何大的 contenteditable 元素（排除搜索框等）
   * 4. 如果都失败，返回错误
   */
  async getTarget(useActiveElement = true) {
    debug.log('[GoogleDocsAdapter] getTarget called, useActiveElement:', useActiveElement);
    
    // 策略 1: 查找主编辑器（最可靠，优先）
    const mainEditor = this._findMainEditor();
    if (mainEditor && !this._isNonEditorElement(mainEditor)) {
      debug.log('[GoogleDocsAdapter] Found main editor:', mainEditor.tagName, mainEditor.className);
      return { element: mainEditor };
    }
    debug.log('[GoogleDocsAdapter] Main editor not found or is non-editor element');

    // 策略 2: 如果 activeElement 已在 Docs 编辑区，直接使用（但要排除搜索框）
    if (useActiveElement && document.activeElement) {
      const activeEl = document.activeElement;
      debug.log('[GoogleDocsAdapter] Checking activeElement:', activeEl.tagName, activeEl.className);
      
      // 明确排除搜索框
      if (this._isNonEditorElement(activeEl)) {
        debug.log('[GoogleDocsAdapter] ActiveElement is non-editor (e.g., search box), skipping');
      } else if (this._isGoogleDocsEditor(activeEl)) {
        const editable = await this._findEditableInElement(activeEl);
        if (editable && !this._isNonEditorElement(editable)) {
          debug.log('[GoogleDocsAdapter] Found editable in activeElement');
          return { element: editable };
        }
      }
    }

    // 策略 3: 查找 iframe 中的编辑器
    const iframeEditor = await this._findIframeEditor();
    if (iframeEditor && !this._isNonEditorElement(iframeEditor)) {
      debug.log('[GoogleDocsAdapter] Found iframe editor');
      return { element: iframeEditor };
    }

    // 策略 4: 尝试查找任何大的 contenteditable 元素（排除搜索框等）
    const allEditables = document.querySelectorAll('[contenteditable="true"]');
    debug.log('[GoogleDocsAdapter] Found', allEditables.length, 'contenteditable elements');
    
    for (const el of allEditables) {
      if (el === document.body || el.tagName === 'IFRAME') continue;
      if (this._isNonEditorElement(el)) {
        debug.log('[GoogleDocsAdapter] Skipping non-editor element:', el.className);
        continue;
      }
      
      // 检查是否在可见区域
      const rect = el.getBoundingClientRect();
      if (rect.width > 200 && rect.height > 200) {
        debug.log('[GoogleDocsAdapter] Found large editable element:', el.tagName, el.className, 'size:', rect.width, 'x', rect.height);
        // 可能是主编辑器
        return { element: el };
      }
    }

    // 所有策略都失败，返回明确错误
    console.error('[GoogleDocsAdapter] All strategies failed, no editor found');
    return {
      element: null,
      error: '无法定位 Google Docs 编辑器。请确保文档已加载，并点击文档正文区域（不是搜索框）。'
    };
  }

  /**
   * 在 Google Docs 中输入单个字符
   * 
   * 使用多策略输入，运行时自动选择最可靠的方法：
   * 1. beforeinput + InputEvent (首选)
   * 2. execCommand('insertText') (次选)
   * 3. KeyboardEvent 序列 (兜底)
   */
  async typeCharacter(element, char) {
    if (!element) {
      return { success: false, error: '目标元素无效' };
    }

    // 如果元素是 IFRAME 或 BODY，尝试找到真正的编辑器
    if (element.tagName === 'IFRAME' || element.tagName === 'BODY') {
      debug.warn('[GoogleDocsAdapter] Element is IFRAME/BODY, trying to find real editor');
      const realEditor = this._findMainEditor();
      if (realEditor) {
        element = realEditor;
        debug.log('[GoogleDocsAdapter] Using real editor:', realEditor.tagName);
      } else {
        return { success: false, error: '无法找到真正的编辑器元素' };
      }
    }

    // 确保元素有焦点（但不频繁切换）
    if (document.activeElement !== element && element !== document.body) {
      try {
        element.focus();
        await this._sleep(200);
      } catch (e) {
        debug.warn('[GoogleDocsAdapter] Focus failed:', e);
      }
    }

    // 确保光标在正确位置（但不强制移动到末尾）
    await this._ensureCursorAtEnd(element);

    // 如果还没有探测过输入策略，进行运行时能力探测
    if (!this.inputStrategy) {
      this.inputStrategy = await this._detectInputStrategy(element);
      debug.log('[GoogleDocsAdapter] Detected input strategy:', this.inputStrategy);
    }

    // 尝试所有策略，直到有一个成功
    // 策略 1: execCommand（通常最可靠）
    let result = await this._typeWithExecCommand(element, char);
    if (result.success) {
      if (this.inputStrategy !== 'execCommand') {
        this.inputStrategy = 'execCommand';
      }
      return result;
    }

    // 策略 2: beforeinput
    result = await this._typeWithBeforeInput(element, char);
    if (result.success) {
      if (this.inputStrategy !== 'beforeinput') {
        this.inputStrategy = 'beforeinput';
      }
      return result;
    }

    // 策略 3: KeyboardEvent（兜底）
    result = await this._typeWithKeyboardEvents(element, char);
    if (result.success) {
      if (this.inputStrategy !== 'keyboard') {
        this.inputStrategy = 'keyboard';
      }
    } else {
      console.error('[GoogleDocsAdapter] All input strategies failed for char:', char, 'element:', element.tagName);
    }
    return result;
  }

  /**
   * 运行时探测最佳输入策略
   * 不实际插入测试字符，只检查 API 可用性
   */
  async _detectInputStrategy(element) {
    // 策略 1: 检查 execCommand 是否可用（不实际测试插入）
    // execCommand 在大多数现代浏览器中仍然可用，但可能被标记为废弃
    // 我们直接尝试使用它，如果失败会回退到其他策略
    if (document.execCommand && typeof document.execCommand === 'function') {
      // 检查是否支持 insertText 命令
      try {
        // 不实际执行，只检查命令是否存在
        // 实际上我们会在使用时测试，这里只是优先选择
        return 'execCommand';
      } catch (e) {
        // 继续尝试其他策略
      }
    }

    // 策略 2: 检查 beforeinput 事件支持（现代标准）
    // 检查浏览器是否支持 InputEvent 和 beforeinput
    if (typeof InputEvent !== 'undefined') {
      try {
        // 创建一个测试事件但不派发，只检查 API 是否存在
        const testEvent = new InputEvent('beforeinput', {
          inputType: 'insertText',
          data: '',
          bubbles: true,
          cancelable: true
        });
        
        // 如果能够创建事件对象，说明浏览器支持
        if (testEvent && testEvent.type === 'beforeinput') {
          return 'beforeinput';
        }
      } catch (e) {
        // beforeinput 不支持，继续
      }
    }

    // 兜底：使用键盘事件（总是可用）
    return 'keyboard';
  }

  /**
   * 策略 1: 使用 beforeinput + InputEvent 输入（首选）
   * 
   * 这是现代浏览器的标准输入事件，Google Docs 应该支持
   */
  async _typeWithBeforeInput(element, char) {
    try {
      // 确保有有效的选择范围
      const selection = window.getSelection();
      let range;
      
      if (selection.rangeCount === 0) {
        range = document.createRange();
        const textNodes = this._getAllTextNodes(element);
        if (textNodes.length > 0) {
          const lastNode = textNodes[textNodes.length - 1];
          range.setStart(lastNode, lastNode.textContent.length);
        } else {
          range.selectNodeContents(element);
        }
        range.collapse(false);
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        range = selection.getRangeAt(0);
        if (!range.collapsed) {
          range.collapse(false);
        }
        selection.removeAllRanges();
        selection.addRange(range);
      }

      // 派发 beforeinput 事件
      const beforeInputEvent = new InputEvent('beforeinput', {
        inputType: 'insertText',
        data: char,
        bubbles: true,
        cancelable: true
      });

      const notPrevented = element.dispatchEvent(beforeInputEvent);

      // 如果事件没有被阻止，手动插入文本
      if (notPrevented && !beforeInputEvent.defaultPrevented) {
        // 重新获取选择（可能在事件处理中改变了）
        const currentSelection = window.getSelection();
        if (currentSelection.rangeCount > 0) {
          const currentRange = currentSelection.getRangeAt(0);
          const textNode = document.createTextNode(char);
          currentRange.insertNode(textNode);
          currentRange.setStartAfter(textNode);
          currentRange.collapse(true);
          currentSelection.removeAllRanges();
          currentSelection.addRange(currentRange);
        }

        // 派发 input 事件（通知 Google Docs 内容已改变）
        const inputEvent = new InputEvent('input', {
          inputType: 'insertText',
          data: char,
          bubbles: true,
          cancelable: false
        });
        element.dispatchEvent(inputEvent);

        await this._sleep(10);
        return { success: true };
      }
    } catch (e) {
      // 如果失败，返回 false 让上层尝试其他策略
    }
    return { success: false, error: 'beforeinput 方法失败' };
  }

  /**
   * 策略 2: 使用 execCommand('insertText') 输入（首选，通常最可靠）
   * 
   * execCommand 是较老的 API，但在 Google Docs 中通常仍然有效
   */
  async _typeWithExecCommand(element, char) {
    try {
      // 确保元素有焦点
      if (document.activeElement !== element && element !== document.body) {
        try {
          element.focus();
          await this._sleep(200);
        } catch (e) {
          debug.warn('[GoogleDocsAdapter] Focus failed in execCommand:', e);
        }
      }

      const selection = window.getSelection();
      let range;
      
      // 确保有有效的选择范围
      if (selection.rangeCount === 0) {
        range = document.createRange();
        const textNodes = this._getAllTextNodes(element);
        if (textNodes.length > 0) {
          const lastNode = textNodes[textNodes.length - 1];
          range.setStart(lastNode, lastNode.textContent.length);
        } else {
          range.selectNodeContents(element);
          range.collapse(false);
        }
        selection.removeAllRanges();
        selection.addRange(range);
      } else {
        range = selection.getRangeAt(0);
        // 确保是光标位置（折叠的）
        if (!range.collapsed) {
          range.collapse(false);
        }
        selection.removeAllRanges();
        selection.addRange(range);
      }

      // 等待一下确保选择已设置
      await this._sleep(100);

      // 尝试 execCommand
      const result = document.execCommand('insertText', false, char);
      if (result) {
        await this._sleep(20);
        return { success: true };
      } else {
        debug.warn('[GoogleDocsAdapter] execCommand returned false for:', char);
      }
    } catch (e) {
      console.error('[GoogleDocsAdapter] execCommand error:', e);
    }
    return { success: false, error: 'execCommand 方法失败' };
  }

  /**
   * 策略 3: 使用 KeyboardEvent 序列输入（兜底方案）
   * 
   * 如果前两种方法都失败，使用完整的键盘事件序列
   */
  async _typeWithKeyboardEvents(element, char) {
    try {
      // 创建完整的键盘事件序列
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
        cancelable: false
      });

      const keyupEvent = new KeyboardEvent('keyup', {
        key: char,
        code: keyInfo.code,
        keyCode: keyInfo.keyCode,
        which: keyInfo.keyCode,
        bubbles: true,
        cancelable: true
      });

      // 按顺序派发事件
      element.dispatchEvent(keydownEvent);
      element.dispatchEvent(keypressEvent);
      element.dispatchEvent(inputEvent);
      element.dispatchEvent(keyupEvent);

      await this._sleep(10);
      return { success: true };
    } catch (e) {
      return { success: false, error: 'KeyboardEvent 方法失败: ' + e.message };
    }
  }

  /**
   * 查找主编辑器
   * 
   * Google Docs 的主编辑器通常在 #docs-editor 或 .kix-appview-editor 中
   */
  _findMainEditor() {
    // 策略 1: 在 #docs-editor 中查找
    const docsEditor = document.querySelector('#docs-editor');
    if (docsEditor) {
      const editable = docsEditor.querySelector('[contenteditable="true"]');
      if (editable) {
        const rect = editable.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          debug.log('[GoogleDocsAdapter] Found editor in #docs-editor');
          return editable;
        }
      }
    }

    // 策略 2: 在 .kix-appview-editor 中查找
    const appViewEditor = document.querySelector('.kix-appview-editor');
    if (appViewEditor) {
      const editable = appViewEditor.querySelector('[contenteditable="true"]');
      if (editable) {
        const rect = editable.getBoundingClientRect();
        if (rect.width > 0 && rect.height > 0) {
          debug.log('[GoogleDocsAdapter] Found editor in .kix-appview-editor');
          return editable;
        }
      }
    }

    // 策略 3: 查找所有 contenteditable，选择最大的（通常是主编辑器）
    const allEditables = document.querySelectorAll('[contenteditable="true"]');
    debug.log('[GoogleDocsAdapter] Searching through', allEditables.length, 'contenteditable elements');
    
    let bestElement = null;
    let bestSize = 0;

    for (const el of allEditables) {
      if (el === document.body || el.tagName === 'IFRAME') continue;
      
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 && rect.height === 0) continue;

      const size = rect.width * rect.height;
      if (size > bestSize) {
        // 检查是否在 Google Docs 容器中
        let parent = el.parentElement;
        let depth = 0;
        let hasGoogleDocsParent = false;

        while (parent && depth < 10) {
          if (parent.classList) {
            const classes = Array.from(parent.classList);
            if (classes.some(cls => cls.includes('kix-') || cls.includes('docs-'))) {
              hasGoogleDocsParent = true;
              break;
            }
          }
          parent = parent.parentElement;
          depth++;
        }

        if (hasGoogleDocsParent) {
          bestElement = el;
          bestSize = size;
        }
      }
    }

    if (bestElement) {
      debug.log('[GoogleDocsAdapter] Found best editor, size:', bestSize);
    }
    return bestElement;
  }

  /**
   * 查找 iframe 中的编辑器
   * 
   * Google Docs 可能使用隐藏的 iframe 处理输入
   * 注意：docs-texteventtarget-iframe 是隐藏的，不应该作为目标
   */
  async _findIframeEditor() {
    const iframes = document.querySelectorAll('iframe');
    debug.log('[GoogleDocsAdapter] Checking', iframes.length, 'iframes');
    
    for (const iframe of iframes) {
      // 跳过隐藏的输入处理 iframe
      if (iframe.classList && iframe.classList.contains('docs-texteventtarget-iframe')) {
        debug.log('[GoogleDocsAdapter] Skipping hidden input iframe');
        continue;
      }
      
      try {
        // 尝试访问 iframe 内容（可能跨域失败）
        if (iframe.contentDocument) {
          const editable = iframe.contentDocument.querySelector('[contenteditable="true"]');
          if (editable) {
            const rect = editable.getBoundingClientRect();
            if (rect.width > 0 && rect.height > 0) {
              debug.log('[GoogleDocsAdapter] Found editable in iframe');
              return editable;
            }
          }
        }
      } catch (e) {
        // 跨域 iframe，跳过
        continue;
      }
    }
    return null;
  }

  /**
   * 检查元素是否为 Google Docs 编辑器
   */
  _isGoogleDocsEditor(element) {
    if (!element) return false;

    // 检查类名
    if (element.classList) {
      const classes = Array.from(element.classList);
      if (classes.some(cls => cls.includes('docs-') || cls.includes('kix-'))) {
        return true;
      }
    }

    // 检查父元素
    let parent = element.parentElement;
    let depth = 0;
    while (parent && depth < 5) {
      if (parent.classList) {
        const classes = Array.from(parent.classList);
        if (classes.some(cls => cls.includes('docs-') || cls.includes('kix-'))) {
          return true;
        }
      }
      parent = parent.parentElement;
      depth++;
    }

    return false;
  }

  /**
   * 在元素中查找可编辑元素
   */
  async _findEditableInElement(element) {
    if (element.contentEditable === 'true' || element.isContentEditable) {
      return element;
    }
    const editable = element.querySelector('[contenteditable="true"]');
    return editable || null;
  }

  /**
   * 确保光标在文档末尾
   * 
   * 这对于正确插入文本很重要
   * 注意：在 Google Docs 中，我们不应该强制移动光标到末尾
   * 应该使用用户当前的光标位置
   */
  async _ensureCursorAtEnd(element) {
    try {
      const selection = window.getSelection();
      
      // 如果已经有有效的选择，保持它（不强制移动到末尾）
      if (selection.rangeCount > 0) {
        const range = selection.getRangeAt(0);
        // 确保选择是折叠的（光标位置）
        if (!range.collapsed) {
          range.collapse(false);
        }
        selection.removeAllRanges();
        selection.addRange(range);
        await this._sleep(20);
        return;
      }
      
      // 如果没有选择，创建到末尾的选择
      const range = document.createRange();
      const textNodes = this._getAllTextNodes(element);
      
      if (textNodes.length > 0) {
        const lastNode = textNodes[textNodes.length - 1];
        range.setStart(lastNode, lastNode.textContent.length);
      } else {
        range.selectNodeContents(element);
      }
      
      range.collapse(false);
      selection.removeAllRanges();
      selection.addRange(range);
      await this._sleep(50);
    } catch (e) {
      // 忽略错误，继续尝试输入
    }
  }

  /**
   * 获取所有文本节点
   */
  _getAllTextNodes(element) {
    const textNodes = [];
    const walker = document.createTreeWalker(
      element,
      NodeFilter.SHOW_TEXT,
      null
    );

    let node;
    while ((node = walker.nextNode())) {
      textNodes.push(node);
    }

    return textNodes;
  }

  /**
   * 清空目标元素内容（可选）
   * Google Docs 不清空，只移动光标到末尾
   */
  async clear(element) {
    // Google Docs 不清空内容，只确保光标在末尾
    await this._ensureCursorAtEnd(element);
  }

  /**
   * 模拟退格键删除一个字符（Google Docs）
   */
  async simulateBackspace(element) {
    if (!element) {
      return { success: false, error: '目标元素无效' };
    }

    // 策略 1: execCommand
    try {
      const sel = window.getSelection();
      if (sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (!range.collapsed && range.startOffset > 0) {
          range.setStart(range.startContainer, Math.max(0, range.startOffset - 1));
          range.deleteContents();
        }
        range.collapse(true);
        sel.removeAllRanges();
        sel.addRange(range);
        
        if (document.execCommand('delete', false, null)) {
          await this._sleep(10);
          return { success: true };
        }
      }
    } catch (e) {
      // 继续尝试
    }

    // 策略 2: beforeinput
    try {
      const beforeInputEvent = new InputEvent('beforeinput', {
        inputType: 'deleteContentBackward',
        bubbles: true,
        cancelable: true
      });
      
      if (element.dispatchEvent(beforeInputEvent) && !beforeInputEvent.defaultPrevented) {
        const sel = window.getSelection();
        if (sel.rangeCount > 0) {
          const range = sel.getRangeAt(0);
          if (range.collapsed && range.startOffset > 0) {
            range.setStart(range.startContainer, range.startOffset - 1);
            range.deleteContents();
            range.collapse(true);
            sel.removeAllRanges();
            sel.addRange(range);
          }
        }
        await this._sleep(10);
        return { success: true };
      }
    } catch (e) {
      // 继续尝试
    }

    // 策略 3: KeyboardEvent
    try {
      const backspaceDown = new KeyboardEvent('keydown', {
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        bubbles: true,
        cancelable: true
      });
      
      element.dispatchEvent(backspaceDown);
      
      const sel = window.getSelection();
      if (sel.rangeCount > 0) {
        const range = sel.getRangeAt(0);
        if (range.collapsed && range.startOffset > 0) {
          range.setStart(range.startContainer, range.startOffset - 1);
          range.deleteContents();
          range.collapse(true);
          sel.removeAllRanges();
          sel.addRange(range);
        }
      }
      
      await this._sleep(10);
      return { success: true };
    } catch (e) {
      return { success: false, error: '删除失败: ' + e.message };
    }
  }

  /**
   * 获取字符的按键信息：DOM `code`、传统 `keyCode`（虚拟键码）与 `charCode`。
   * keyCode 用于 keydown/keyup，charCode 用于 keypress。
   */
  _getKeyInfo(char) {
    const charCode = char.length ? char.codePointAt(0) : 32;

    if (char === ' ' || char.length === 0) return { code: 'Space', keyCode: 32, charCode: 32 };
    if (char === '\n' || char === '\r') return { code: 'Enter', keyCode: 13, charCode: 13 };
    if (char === '\t') return { code: 'Tab', keyCode: 9, charCode: 9 };

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
    if (punct[char]) {
      return { code: punct[char].code, keyCode: punct[char].keyCode, charCode };
    }

    return { code: 'Unidentified', keyCode: charCode, charCode };
  }
}
