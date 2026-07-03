if (typeof globalThis.PT_DEBUG === "undefined") {
  globalThis.PT_DEBUG = false;
  globalThis.debug = {
    log: (...a) => { if (globalThis.PT_DEBUG) console.log(...a); },
    warn: (...a) => { if (globalThis.PT_DEBUG) console.warn(...a); }
  };
}

class PasteTyper {
  constructor() {
    this.isTyping = false;
    this.isPaused = false;
    this.currentText = '';
    this.currentPosition = 0;
    this.targetElement = null;
    this.currentAdapter = null; // 当前使用的适配器
    this.typingSpeed = 50; // Base delay between characters in ms
    this.speedVariation = 20; // Random variation in typing speed
    this.pauseChance = 0.1; // Chance of pausing during typing
    this.pauseDuration = 200; // Duration of pauses in ms
    
    // Enhanced human-like typing features
    this.typoChance = 0.005; // 0.5% chance of making a typo
    this.typoCorrectionDelay = 300; // Delay before correcting typo
    
    // Input field navigation
    this.availableInputs = [];
    this.selectedInputIndex = -1;
    this.navigationMode = false;
    
    this.setupMessageListener();
    this.setupFloatingUIBridge();
    this.setupKeyboardNavigation();
    this.loadTypoChanceSetting();
  }

  setupFloatingUIBridge() {
    const TAG = 'paste-typer-floating-ui';
    window.addEventListener('message', async (event) => {
      if (event.source !== window) return;
      const data = event.data;
      if (!data || data.source !== TAG || data.direction !== 'to-content') return;

      const { requestId, action, payload = {} } = data;
      const reply = (response) => {
        window.postMessage({ source: TAG, direction: 'to-floating-ui', requestId, response }, '*');
      };

      try {
        if (action === 'startTyping') {
          if (payload.typoChance !== undefined) this.typoChance = payload.typoChance;
          // Await the start so a missing target rejects to the outer catch and
          // replies success:false, rather than reporting a false success.
          await this.startTyping(payload.text, payload.targetElement);
          reply({ success: true });
        } else if (action === 'stopTyping') {
          this.stopTyping();
          reply({ success: true });
        } else if (action === 'floatingUIClosed') {
          reply({ success: true });
        } else if (action === 'saveSettings') {
          chrome.storage.local.set({ pasteTyperSettings: payload.settings }, () => reply({ success: true }));
        } else if (action === 'loadSettings') {
          chrome.storage.local.get(['pasteTyperSettings'], (result) => {
            reply({ success: true, settings: result.pasteTyperSettings || null });
          });
        } else {
          reply({ success: false, error: 'unknown action' });
        }
      } catch (error) {
        reply({ success: false, error: error.message });
      }
    });
  }

  loadTypoChanceSetting() {
    chrome.storage.local.get(['pasteTyperSettings'], (result) => {
      if (result.pasteTyperSettings && result.pasteTyperSettings.typoChance !== undefined) {
        const sliderValue = parseInt(result.pasteTyperSettings.typoChance);
        this.typoChance = sliderValue / 100;
      }
    });
  }

  setupMessageListener() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'startTyping') {
        // Update typoChance if provided
        if (request.typoChance !== undefined) {
          this.typoChance = request.typoChance;
        }
        // startTyping resolves once typing has started (target found, focused,
        // cleared); report the real outcome so the popup can show "no input
        // field found" instead of a false success.
        this.startTyping(request.text, request.targetElement)
          .then(() => sendResponse({success: true}))
          .catch((error) => sendResponse({success: false, error: error.message}));
      } else if (request.action === 'stopTyping') {
        this.stopTyping();
        sendResponse({success: true});
      } else if (request.action === 'pauseTyping') {
        this.pauseTyping();
        sendResponse({success: true, isPaused: this.isPaused});
      } else if (request.action === 'resumeTyping') {
        this.resumeTyping();
        sendResponse({success: true, isPaused: this.isPaused});
      } else if (request.action === 'resetTyping') {
        this.resetTyping().then(() => {
          sendResponse({success: true});
        }).catch((error) => {
          sendResponse({success: false, error: error.message});
        });
      } else if (request.action === 'getActiveElement') {
        const element = document.activeElement;
        if (!element) {
          sendResponse({ tagName: '', type: '', id: '', className: '', isEditable: false });
        } else {
          sendResponse({
            tagName: element.tagName,
            type: element.type,
            id: element.id,
            className: element.className,
            isEditable: this.isEditableElement(element)
          });
        }
      } else if (request.action === 'findAndHighlightInputs') {
        const count = this.findAndHighlightInputs();
        sendResponse({count: count});
      } else if (request.action === 'getTypingProgress') {
        sendResponse({
          position: this.currentPosition,
          total: this.currentText.length,
          isTyping: this.isTyping,
          isPaused: this.isPaused
        });
      } else if (request.action === 'startInputNavigation') {
        this.startInputNavigation();
        sendResponse({
          success: true,
          count: this.availableInputs.length,
          selectedIndex: this.selectedInputIndex
        });
      } else if (request.action === 'stopInputNavigation') {
        this.stopInputNavigation();
        sendResponse({success: true});
      } else if (request.action === 'selectCurrentInput') {
        const success = this.selectCurrentInput();
        sendResponse({success: success});
      } else if (request.action === 'navigatePrevious') {
        this.navigateToPrevious();
        sendResponse({
          success: true,
          selectedIndex: this.selectedInputIndex,
          total: this.availableInputs.length
        });
      } else if (request.action === 'navigateNext') {
        this.navigateToNext();
        sendResponse({
          success: true,
          selectedIndex: this.selectedInputIndex,
          total: this.availableInputs.length
        });
      } else if (request.action === 'toggleFloatingUI') {
        this.toggleFloatingUI();
        sendResponse({success: true});
      } else if (request.action === 'floatingUIClosed') {
        // Floating UI was closed, do cleanup if needed
        sendResponse({success: true});
      }
      return true;
    });
  }

  toggleFloatingUI() {
    // Check if Floating UI already exists
    let floatingContainer = document.getElementById('paste-typer-floating-ui');
    
    if (floatingContainer) {
      // Toggle visibility
      if (floatingContainer.style.display === 'none') {
        floatingContainer.style.display = 'block';
        this.loadFloatingUIPosition(floatingContainer);
      } else {
        floatingContainer.style.display = 'none';
      }
      return;
    }
    
    // Create Floating UI container with Shadow DOM (for style isolation and drag support)
    floatingContainer = document.createElement('div');
    floatingContainer.id = 'paste-typer-floating-ui';
    floatingContainer.style.cssText = `
      position: fixed;
      top: 100px;
      right: 20px;
      width: 350px;
      z-index: 2147483647;
      display: block;
    `;
    
    // Create shadow root
    const shadowRoot = floatingContainer.attachShadow({ mode: 'open' });
    
    // Load Floating UI content
    this._loadFloatingUIContent(shadowRoot, floatingContainer);
    
    // Ensure body exists before appending
    if (document.body) {
      document.body.appendChild(floatingContainer);
    } else {
      document.addEventListener('DOMContentLoaded', () => {
        document.body.appendChild(floatingContainer);
      });
    }
    
    // Load saved position
    this.loadFloatingUIPosition(floatingContainer);
  }

  async _loadFloatingUIContent(shadowRoot, container) {
    try {
      const response = await fetch(chrome.runtime.getURL('floating-ui.html'));
      const html = await response.text();

      // Parse the extension-owned HTML safely (no innerHTML assignment on live DOM).
      const parsed = new DOMParser().parseFromString(html, 'text/html');

      const styles = parsed.querySelector('style');
      if (styles) {
        shadowRoot.appendChild(styles.cloneNode(true));
      }

      const bodyContent = parsed.body;
      if (bodyContent) {
        // .pt-root takes over the visual role of <body> inside the shadow tree
        // (the stylesheet targets `body, .pt-root`).
        const contentDiv = document.createElement('div');
        contentDiv.className = 'pt-root';
        for (const node of Array.from(bodyContent.childNodes)) {
          contentDiv.appendChild(document.importNode(node, true));
        }
        shadowRoot.appendChild(contentDiv);

        const script = document.createElement('script');
        script.src = chrome.runtime.getURL('floating-ui.js');
        shadowRoot.appendChild(script);
      }

      this._setupFloatingUIDrag(container, shadowRoot);
    } catch (error) {
      console.error('[PasteTyper] Failed to load Floating UI:', error);
      this._createInlineFloatingUI(shadowRoot, container);
    }
  }

  _setupFloatingUIDrag(container, shadowRoot) {
    // Find header in shadow DOM
    const findHeader = () => {
      return shadowRoot.querySelector('.floating-header') || 
             shadowRoot.querySelector('#header');
    };
    
    const setupDrag = () => {
      const header = findHeader();
      if (!header) {
        // Wait a bit for content to load
        setTimeout(setupDrag, 100);
        return;
      }
      
      // Use object to store drag state (accessible in closures)
      const dragState = {
        isDragging: false,
        dragOffset: { x: 0, y: 0 }
      };
      
      header.style.cursor = 'move';
      header.style.userSelect = 'none';
      
      const handleMouseDown = (e) => {
        // Don't drag if clicking close button
        const target = e.target;
        if (target.classList && target.classList.contains('close-btn')) return;
        if (target.id === 'closeBtn') return;
        
        dragState.isDragging = true;
        const rect = container.getBoundingClientRect();
        dragState.dragOffset.x = e.clientX - rect.left;
        dragState.dragOffset.y = e.clientY - rect.top;
        
        // Use capture phase to ensure we catch events even if they bubble
        document.addEventListener('mousemove', handleDrag, true);
        document.addEventListener('mouseup', handleMouseUp, true);
        e.preventDefault();
        e.stopPropagation();
      };
      
      const handleDrag = (e) => {
        if (!dragState.isDragging) return;
        
        const x = e.clientX - dragState.dragOffset.x;
        const y = e.clientY - dragState.dragOffset.y;
        
        // Constrain to viewport
        const maxX = window.innerWidth - container.offsetWidth;
        const maxY = window.innerHeight - container.offsetHeight;
        
        container.style.left = `${Math.max(0, Math.min(x, maxX))}px`;
        container.style.top = `${Math.max(0, Math.min(y, maxY))}px`;
        container.style.right = 'auto';
        e.preventDefault();
      };
      
      const handleMouseUp = (e) => {
        if (!dragState.isDragging) return;
        
        dragState.isDragging = false;
        document.removeEventListener('mousemove', handleDrag, true);
        document.removeEventListener('mouseup', handleMouseUp, true);
        
        // Save position
        const savedX = parseInt(container.style.left) || 0;
        const savedY = parseInt(container.style.top) || 0;
        chrome.storage.local.set({
          floatingUIPosition: { x: savedX, y: savedY }
        });
      };
      
      header.addEventListener('mousedown', handleMouseDown);
    };
    
    setupDrag();
  }

  _createInlineFloatingUI(shadowRoot, container) {
    // Fallback inline UI — built without innerHTML/onclick to comply with extension CSP.
    const style = document.createElement('style');
    style.textContent = `
      * { margin: 0; padding: 0; box-sizing: border-box; }
      .floating-header { background: #202124; color: white; padding: 12px 16px; cursor: move; }
      .floating-container { padding: 16px; }
      .btn { padding: 10px; margin: 5px; border: none; border-radius: 4px; cursor: pointer; }
      .btn-primary { background: #202124; color: white; }
    `;

    const header = document.createElement('div');
    header.className = 'floating-header';
    header.textContent = 'Paste Typer';

    const body = document.createElement('div');
    body.className = 'floating-container';

    const note = document.createElement('p');
    note.textContent = 'Floating UI loaded';

    const closeBtn = document.createElement('button');
    closeBtn.className = 'btn btn-primary';
    closeBtn.textContent = 'Close';
    closeBtn.addEventListener('click', () => {
      container.style.display = 'none';
    });

    body.appendChild(note);
    body.appendChild(closeBtn);

    shadowRoot.appendChild(style);
    shadowRoot.appendChild(header);
    shadowRoot.appendChild(body);

    this._setupFloatingUIDrag(container, shadowRoot);
  }

  loadFloatingUIPosition(container) {
    chrome.storage.local.get(['floatingUIPosition'], (result) => {
      if (result.floatingUIPosition) {
        container.style.left = `${result.floatingUIPosition.x}px`;
        container.style.top = `${result.floatingUIPosition.y}px`;
        container.style.right = 'auto';
      }
    });
  }


  isEditableElement(element) {
    const editableTags = ['INPUT', 'TEXTAREA'];
    const editableTypes = ['text', 'email', 'password', 'search', 'url', 'tel'];
    
    return editableTags.includes(element.tagName) ||
           (element.tagName === 'INPUT' && editableTypes.includes(element.type)) ||
           element.contentEditable === 'true' ||
           element.isContentEditable;
  }

  async startTyping(text, useActiveElement = true) {
    if (this.isTyping) {
      debug.log('[PasteTyper] Already typing, ignoring request');
      return;
    }

    // 使用适配器系统
    if (typeof adapterManager !== 'undefined' && adapterManager) {
      try {
        this.currentAdapter = adapterManager.getAdapter();
        debug.log('[PasteTyper] Using adapter:', this.currentAdapter.constructor.name);
        
        const targetResult = await this.currentAdapter.getTarget(useActiveElement);
        
        if (!targetResult.element) {
          const errorMsg = targetResult.error || '未找到可编辑的输入框';
          console.error('[PasteTyper]', errorMsg);
          throw new Error(errorMsg);
        }

        const targetElement = targetResult.element;
        debug.log('[PasteTyper] Target element:', targetElement.tagName, targetElement.className);
        debug.log('[PasteTyper] Element contentEditable:', targetElement.contentEditable);
        debug.log('[PasteTyper] Element isContentEditable:', targetElement.isContentEditable);
        
        this.isTyping = true;
        this.isPaused = false;
        this.currentText = text;
        this.currentPosition = 0;
        this.targetElement = targetElement;

        // 使用适配器聚焦
        await this.currentAdapter.focus(targetElement);
        debug.log('[PasteTyper] Focused element, activeElement:', document.activeElement.tagName);
        
        // Google Docs 不清空内容，只移动光标
        await this.currentAdapter.clear(targetElement);
        debug.log('[PasteTyper] Cleared/prepared element');

        // 开始逐字输入（不等待完成，异步执行）
        this.continueTyping().catch(err => {
          console.error('[PasteTyper] Typing error:', err);
          this.isTyping = false;
        });
        return;
      } catch (error) {
        console.error('[PasteTyper] Adapter error:', error);
        this.isTyping = false;
        throw error; // 重新抛出错误，让 popup 知道失败了
      }
    } else {
      throw new Error('Adapter manager not available');
    }
  }

  async continueTyping() {
    const CHUNK_SIZE = 50; // 长文本分块输入，避免页面卡死
    
    while (this.currentPosition < this.currentText.length && this.isTyping) {
      // Check if paused
      if (this.isPaused) {
        await this.sleep(100);
        continue;
      }
      
      // 对于长文本，分块输入以避免页面卡死
      const remaining = this.currentText.length - this.currentPosition;
      const chunkSize = remaining > CHUNK_SIZE ? CHUNK_SIZE : remaining;
      
      for (let i = 0; i < chunkSize && this.currentPosition < this.currentText.length && this.isTyping; i++) {
        if (this.isPaused) break;
        
        const char = this.currentText[this.currentPosition];
        
        // Check for typo (before typing the character)
        if (this.typoChance > 0 && Math.random() < this.typoChance && this.shouldMakeTypo(char)) {
          await this.makeTypoAndCorrect(char);
          continue; // Skip normal typing for this character
        }
        
        // Get delay based on character type
        const delay = this.getRandomDelay();
        await this.sleep(delay);
        
        // Random pause simulation
        if (Math.random() < this.pauseChance) {
          await this.sleep(this.pauseDuration);
        }
        
        // Type the character using the adapter
        const result = await this.currentAdapter.typeCharacter(this.targetElement, char);
        if (!result.success) {
          debug.warn('[PasteTyper] Failed to type character:', char, result.error);
          // 继续尝试下一个字符，不中断整个流程
        }
        this.currentPosition++;
      }
      
      // 每处理一个 chunk 后稍作休息，避免页面卡死
      if (this.currentPosition < this.currentText.length) {
        await this.sleep(10);
      }
    }
    
    if (this.currentPosition >= this.currentText.length) {
      this.isTyping = false;
      this.isPaused = false;
    }
  }

  shouldMakeTypo(char) {
    // Don't make typos on spaces, newlines, or very short text
    if (char === ' ' || char === '\n' || char === '\t') {
      return false;
    }
    // Don't make typos if we're near the end
    if (this.currentPosition > this.currentText.length - 5) {
      return false;
    }
    // Only make typos on letters and numbers
    return /[a-zA-Z0-9]/.test(char);
  }

  async makeTypoAndCorrect(correctChar) {
    // Generate a realistic typo (adjacent key on keyboard)
    const typoChar = this.generateTypo(correctChar);
    
    if (!typoChar) {
      // If we can't generate a typo, just type the character normally
      await this.currentAdapter.typeCharacter(this.targetElement, correctChar);
      this.currentPosition++;
      return;
    }

    // Type the typo character
    await this.currentAdapter.typeCharacter(this.targetElement, typoChar);

    // Wait a bit (human realizes the mistake)
    await this.sleep(this.typoCorrectionDelay);

    // Delete the typo (backspace)
    await this.currentAdapter.simulateBackspace(this.targetElement);

    // Small pause before typing correct character
    await this.sleep(50 + Math.random() * 50);

    // Type the correct character
    await this.currentAdapter.typeCharacter(this.targetElement, correctChar);

    // Move position forward
    this.currentPosition++;
  }

  generateTypo(char) {
    // Common keyboard layout for adjacent key typos
    const keyboardLayout = {
      'q': ['w', 'a'], 'w': ['q', 'e', 's'], 'e': ['w', 'r', 'd'], 'r': ['e', 't', 'f'],
      't': ['r', 'y', 'g'], 'y': ['t', 'u', 'h'], 'u': ['y', 'i', 'j'], 'i': ['u', 'o', 'k'],
      'o': ['i', 'p', 'l'], 'p': ['o', 'l'],
      'a': ['q', 's', 'z'], 's': ['a', 'd', 'w', 'x'], 'd': ['s', 'f', 'e', 'c'],
      'f': ['d', 'g', 'r', 'v'], 'g': ['f', 'h', 't', 'b'], 'h': ['g', 'j', 'y', 'n'],
      'j': ['h', 'k', 'u', 'm'], 'k': ['j', 'l', 'i'], 'l': ['k', 'o'],
      'z': ['a', 'x'], 'x': ['z', 'c', 's'], 'c': ['x', 'v', 'd'], 'v': ['c', 'b', 'f'],
      'b': ['v', 'n', 'g'], 'n': ['b', 'm', 'h'], 'm': ['n', 'j'],
      '1': ['2', 'q'], '2': ['1', '3', 'w'], '3': ['2', '4', 'e'], '4': ['3', '5', 'r'],
      '5': ['4', '6', 't'], '6': ['5', '7', 'y'], '7': ['6', '8', 'u'], '8': ['7', '9', 'i'],
      '9': ['8', '0', 'o'], '0': ['9', 'p']
    };
    
    const lowerChar = char.toLowerCase();
    if (keyboardLayout[lowerChar]) {
      const adjacentKeys = keyboardLayout[lowerChar];
      const typo = adjacentKeys[Math.floor(Math.random() * adjacentKeys.length)];
      // Preserve case
      return char === char.toUpperCase() ? typo.toUpperCase() : typo;
    }
    
    return null;
  }

  getRandomDelay() {
    // Generate human-like typing delays
    const baseDelay = this.typingSpeed;
    const variation = (Math.random() - 0.5) * this.speedVariation;
    return Math.max(10, baseDelay + variation);
  }

  findBestEditableElement() {
    // Try to find the most likely input element with broader search
    const selectors = [
      'input[type="text"]',
      'input[type="email"]', 
      'input[type="password"]',
      'input[type="search"]',
      'input[type="url"]',
      'input[type="tel"]',
      'input:not([type])', // Default input type is text
      'textarea',
      '[contenteditable="true"]',
      '[contenteditable=""]', // Sometimes contenteditable has empty value
      'div[contenteditable]',
      'p[contenteditable]',
      'span[contenteditable]'
    ];
    
    const inputs = document.querySelectorAll(selectors.join(', '));
    
    if (inputs.length === 0) {
      // Last resort: look for any element with contenteditable
      const editables = document.querySelectorAll('[contenteditable]');
      if (editables.length > 0) {
        return editables[0];
      }
      return null;
    }
    
    // Scoring system to find the best input
    let bestElement = null;
    let bestScore = -1;
    
    for (let input of inputs) {
      let score = 0;
      const rect = input.getBoundingClientRect();
      
      // Skip invisible elements
      if (rect.width === 0 && rect.height === 0) continue;
      
      // Prioritize focused element
      if (input === document.activeElement) score += 100;
      
      // Prioritize visible elements
      if (rect.width > 0 && rect.height > 0) score += 50;
      
      // Prioritize larger elements
      score += Math.min(rect.width * rect.height / 1000, 20);
      
      // Prioritize elements in viewport
      if (rect.top >= 0 && rect.left >= 0 && 
          rect.bottom <= window.innerHeight && 
          rect.right <= window.innerWidth) {
        score += 30;
      }
      
      // Prioritize standard input types
      if (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA') {
        score += 20;
      }
      
      // Prefer elements that look like text input fields
      const placeholder = input.placeholder || input.getAttribute('aria-label') || '';
      if (placeholder.toLowerCase().includes('text') || 
          placeholder.toLowerCase().includes('message') ||
          placeholder.toLowerCase().includes('comment') ||
          placeholder.toLowerCase().includes('write')) {
        score += 10;
      }
      
      if (score > bestScore) {
        bestScore = score;
        bestElement = input;
      }
    }
    
    return bestElement;
  }

  stopTyping() {
    this.isTyping = false;
    this.isPaused = false;
  }

  pauseTyping() {
    if (this.isTyping) {
      this.isPaused = true;
    }
  }

  resumeTyping() {
    if (this.isTyping) {
      this.isPaused = false;
    }
  }

  async resetTyping() {
    this.stopTyping();
    this.currentPosition = 0;
    this.currentText = '';
    
    // Try multiple strategies to find the element to clear
    let elementToClear = null;
    let fromAdapter = false;

    // Strategy 0: Ask the active adapter to resolve the target. Site-specific
    // adapters (e.g. Google Docs) locate editors that the generic DOM queries
    // below cannot find.
    const adapter = this.currentAdapter ||
      (typeof adapterManager !== 'undefined' && adapterManager ? adapterManager.getAdapter() : null);
    if (adapter) {
      try {
        const targetResult = await adapter.getTarget(true);
        if (targetResult && targetResult.element) {
          elementToClear = targetResult.element;
          fromAdapter = true;
          this.currentAdapter = adapter;
          debug.log('Using adapter-resolved target:', elementToClear);
        }
      } catch (e) {
        debug.warn('Adapter getTarget failed during reset:', e);
      }
    }

    // Strategy 1: Use the stored target element
    if (!elementToClear && this.targetElement && this.isEditableElement(this.targetElement)) {
      elementToClear = this.targetElement;
      debug.log('Using stored target element:', elementToClear);
    }

    // Strategy 2: Use the currently active element
    if (!elementToClear) {
      const activeElement = document.activeElement;
      if (activeElement && this.isEditableElement(activeElement)) {
        elementToClear = activeElement;
        debug.log('Using active element:', elementToClear);
      }
    }

    // Strategy 3: Find the best editable element
    if (!elementToClear) {
      elementToClear = this.findBestEditableElement();
      debug.log('Using best editable element:', elementToClear);
    }

    if (elementToClear && (fromAdapter || this.isEditableElement(elementToClear))) {
      // Check if this is a Monaco editor or similar complex editor
      const isMonacoEditor = this.isMonacoEditor(elementToClear);
      debug.log('Is Monaco editor:', isMonacoEditor);
      
      if (isMonacoEditor) {
        await this.clearMonacoEditor(elementToClear);
      } else {
        // Focus the element first and ensure it's ready
        elementToClear.focus();
        await this.sleep(100); // Give focus time to settle
        
        // Get current text content
        let currentText = '';
        if (elementToClear.tagName === 'INPUT' || elementToClear.tagName === 'TEXTAREA') {
          currentText = elementToClear.value;
        } else if (elementToClear.contentEditable === 'true' || elementToClear.isContentEditable) {
          currentText = elementToClear.textContent || elementToClear.innerText || '';
        }
        
        debug.log('Element to clear:', elementToClear.tagName, 'Current text length:', currentText.length);
        
        // Always try to clear, even if text appears empty (might be hidden content)
        await this.simulateHumanDeletion(elementToClear, Math.max(currentText.length, 1));
      }
      
      // Store this as our target element for future operations
      this.targetElement = elementToClear;
    } else {
      debug.warn('No suitable element found to clear');
      throw new Error('No editable input field found to reset');
    }
  }

  async simulateHumanDeletion(element, textLength) {
    debug.log('Starting deletion for element:', element, 'Text length:', textLength);
    element.focus();
    await this.sleep(50);
    
    // Get initial content
    let initialContent = this.getElementContent(element);
    debug.log('Initial content:', initialContent);
    
    // Try method 1: Ctrl+A then Delete
    debug.log('Trying Ctrl+A + Delete method...');
    await this.simulateSelectAllAndDelete(element);
    
    // Check if content was cleared
    let remainingContent = this.getElementContent(element);
    debug.log('After Ctrl+A+Delete, remaining content:', remainingContent);
    
    // If content still exists, try method 2: Character-by-character backspace
    if (remainingContent.length > 0) {
      debug.log('Ctrl+A+Delete failed, trying backspace loop...');
      await this.simulateBackspaceLoop(element, remainingContent.length);
      
      // Check again
      remainingContent = this.getElementContent(element);
      debug.log('After backspace loop, remaining content:', remainingContent);
    }
    
    // If still not cleared, try method 3: Direct clearing
    if (remainingContent.length > 0) {
      debug.log('Backspace loop failed, trying direct clear...');
      await this.directClear(element);
    }
    
    debug.log('Deletion complete. Final content:', this.getElementContent(element));
  }

  getElementContent(element) {
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      return element.value;
    } else if (element.contentEditable === 'true' || element.isContentEditable) {
      return element.textContent || element.innerText || '';
    }
    return '';
  }

  async simulateSelectAllAndDelete(element) {
    // Simulate Ctrl+A (Select All)
    const ctrlAEvent = new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    });
    element.dispatchEvent(ctrlAEvent);
    
    // Select all content programmatically
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      element.setSelectionRange(0, element.value.length);
    } else if (element.contentEditable === 'true' || element.isContentEditable) {
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
    }
    
    // Small delay to make selection visible
    await this.sleep(50);
    
    // Simulate Delete key
    const deleteEvent = new KeyboardEvent('keydown', {
      key: 'Delete',
      code: 'Delete',
      keyCode: 46,
      bubbles: true,
      cancelable: true
    });
    element.dispatchEvent(deleteEvent);
    
    // Actually clear the content
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      this._setNativeValue(element, '');
    } else if (element.contentEditable === 'true' || element.isContentEditable) {
      element.textContent = '';
    }

    // Dispatch input event
    const inputEvent = new Event('input', { bubbles: true, cancelable: true });
    element.dispatchEvent(inputEvent);
    
    // Dispatch keyup events
    const ctrlAUpEvent = new KeyboardEvent('keyup', {
      key: 'a',
      code: 'KeyA',
      ctrlKey: true,
      bubbles: true,
      cancelable: true
    });
    element.dispatchEvent(ctrlAUpEvent);
    
    const deleteUpEvent = new KeyboardEvent('keyup', {
      key: 'Delete',
      code: 'Delete',
      keyCode: 46,
      bubbles: true,
      cancelable: true
    });
    element.dispatchEvent(deleteUpEvent);
  }

  async simulateBackspaceLoop(element, textLength) {
    // Simulate rapid backspace deletion (character by character)
    for (let i = 0; i < textLength + 5; i++) { // Add extra iterations to be sure
      // Check current content
      const currentContent = this.getElementContent(element);
      if (currentContent.length === 0) {
        debug.log('Content cleared after', i, 'backspaces');
        break;
      }
      
      // Simulate Backspace keydown
      const backspaceDown = new KeyboardEvent('keydown', {
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        bubbles: true,
        cancelable: true
      });
      element.dispatchEvent(backspaceDown);
      
      // Actually remove one character
      if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
        const currentValue = element.value;
        if (currentValue.length > 0) {
          this._setNativeValue(element, currentValue.slice(0, -1));
          element.setSelectionRange(element.value.length, element.value.length);
        }
      } else if (element.contentEditable === 'true' || element.isContentEditable) {
        const currentText = element.textContent || '';
        if (currentText.length > 0) {
          element.textContent = currentText.slice(0, -1);
          // Set cursor to end
          const selection = window.getSelection();
          const range = document.createRange();
          if (element.childNodes.length > 0) {
            range.setStartAfter(element.lastChild);
          } else {
            range.setStart(element, 0);
          }
          range.collapse(true);
          selection.removeAllRanges();
          selection.addRange(range);
        }
      }
      
      // Dispatch input event
      const inputEvent = new Event('input', { bubbles: true, cancelable: true });
      element.dispatchEvent(inputEvent);
      
      // Simulate Backspace keyup
      const backspaceUp = new KeyboardEvent('keyup', {
        key: 'Backspace',
        code: 'Backspace',
        keyCode: 8,
        bubbles: true,
        cancelable: true
      });
      element.dispatchEvent(backspaceUp);
      
      // Small delay between backspaces (faster than typing)
      await this.sleep(10);
    }
  }

  isMonacoEditor(element) {
    // Check for Monaco editor indicators
    if (element.classList.contains('inputarea') || 
        element.classList.contains('monaco-mouse-cursor-text') ||
        element.getAttribute('aria-label')?.includes('Editor content') ||
        element.closest('.monaco-editor') ||
        element.closest('.monaco-editor-background') ||
        element.closest('.view-lines')) {
      return true;
    }
    
    // Check parent elements for Monaco indicators
    let parent = element.parentElement;
    while (parent) {
      if (parent.classList.contains('monaco-editor') ||
          parent.classList.contains('monaco-editor-background') ||
          parent.classList.contains('view-lines') ||
          parent.classList.contains('editor-container')) {
        return true;
      }
      parent = parent.parentElement;
    }
    
    return false;
  }

  async clearMonacoEditor(textarea) {
    debug.log('Detected Monaco editor, using specialized clearing...');
    
    // Focus the textarea first
    textarea.focus();
    await this.sleep(100);
    
    // Method 1: Try to find the actual editor instance and use its API first
    debug.log('Trying Monaco API access...');
    const apiSuccess = await this.tryMonacoAPI(textarea);
    if (apiSuccess) {
      debug.log('Monaco API clearing successful');
      return;
    }
    
    // Method 2: Enhanced Ctrl+A and Delete with multiple attempts
    debug.log('Trying enhanced Ctrl+A + Delete for Monaco...');
    await this.simulateEnhancedMonacoSelectAllDelete(textarea);
    
    // Check if cleared
    await this.sleep(200);
    let content = this.getMonacoContent(textarea);
    debug.log('After enhanced select all delete, content length:', content.length);
    
    if (content.length > 0) {
      // Method 3: Super aggressive keyboard clearing
      debug.log('Trying super aggressive keyboard clearing...');
      await this.simulateSuperAggressiveMonacoClear(textarea);
    }
    
    // Method 4: Last resort - try direct DOM manipulation
    await this.sleep(200);
    content = this.getMonacoContent(textarea);
    if (content.length > 0) {
      debug.log('Trying direct DOM manipulation...');
      await this.directMonacoManipulation(textarea);
    }
  }

  async tryMonacoAPI(textarea) {
    try {
      // Multiple strategies to find Monaco editor instance
      const strategies = [
        // Strategy 1: Look for closest monaco-editor
        () => {
          const editorElement = textarea.closest('.monaco-editor');
          if (editorElement && window.monaco) {
            return window.monaco.editor.getEditors().find(e => 
              e.getDomNode() === editorElement || 
              e.getDomNode().contains(textarea)
            );
          }
          return null;
        },
        
        // Strategy 2: Search all Monaco editors
        () => {
          if (window.monaco) {
            return window.monaco.editor.getEditors().find(e => 
              e.getDomNode().contains(textarea)
            );
          }
          return null;
        },
        
        // Strategy 3: Look for editor instance in DOM data
        () => {
          let element = textarea;
          while (element) {
            if (element._monacoEditor) {
              return element._monacoEditor;
            }
            if (element.editor) {
              return element.editor;
            }
            element = element.parentElement;
          }
          return null;
        }
      ];
      
      for (const strategy of strategies) {
        const editor = strategy();
        if (editor) {
          debug.log('Found Monaco editor instance via strategy, clearing...');
          editor.setValue('');
          editor.focus();
          await this.sleep(100);
          
          // Also try model operations
          const model = editor.getModel();
          if (model) {
            model.setValue('');
          }
          
          return true;
        }
      }
    } catch (e) {
      debug.log('Monaco API access failed:', e);
    }
    return false;
  }

  getMonacoContent(textarea) {
    // Try multiple ways to get Monaco content
    if (textarea.value) return textarea.value;
    if (textarea.textContent) return textarea.textContent;
    if (textarea.innerText) return textarea.innerText;
    
    // Try to find view lines content
    const editorElement = textarea.closest('.monaco-editor');
    if (editorElement) {
      const viewLines = editorElement.querySelector('.view-lines');
      if (viewLines) {
        return viewLines.textContent || viewLines.innerText || '';
      }
    }
    
    return '';
  }

  async simulateMonacoSelectAllDelete(textarea) {
    // Focus and ensure Monaco is active
    textarea.focus();
    await this.sleep(50);
    
    // Simulate Ctrl+A
    const selectAllEvent = new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      ctrlKey: true,
      metaKey: false,
      bubbles: true,
      cancelable: true
    });
    textarea.dispatchEvent(selectAllEvent);
    
    // On Mac, try Cmd+A as well
    const selectAllMacEvent = new KeyboardEvent('keydown', {
      key: 'a',
      code: 'KeyA',
      ctrlKey: false,
      metaKey: true,
      bubbles: true,
      cancelable: true
    });
    textarea.dispatchEvent(selectAllMacEvent);
    
    await this.sleep(100);
    
    // Simulate Delete
    const deleteEvent = new KeyboardEvent('keydown', {
      key: 'Delete',
      code: 'Delete',
      bubbles: true,
      cancelable: true
    });
    textarea.dispatchEvent(deleteEvent);
    
    // Also try Backspace
    const backspaceEvent = new KeyboardEvent('keydown', {
      key: 'Backspace',
      code: 'Backspace',
      bubbles: true,
      cancelable: true
    });
    textarea.dispatchEvent(backspaceEvent);
    
    await this.sleep(50);
    
    // Dispatch keyup events
    const selectAllUpEvent = new KeyboardEvent('keyup', {
      key: 'a',
      code: 'KeyA',
      ctrlKey: true,
      bubbles: true
    });
    textarea.dispatchEvent(selectAllUpEvent);
    
    const deleteUpEvent = new KeyboardEvent('keyup', {
      key: 'Delete',
      code: 'Delete',
      bubbles: true
    });
    textarea.dispatchEvent(deleteUpEvent);
  }

  async simulateEnhancedMonacoSelectAllDelete(textarea) {
    // Multiple rounds of Ctrl+A and Delete for stubborn Monaco editors
    textarea.focus();
    
    for (let round = 0; round < 5; round++) {
      debug.log(`Monaco select all attempt ${round + 1}/5`);
      
      // Try both Ctrl+A and Cmd+A multiple times
      const selectEvents = [
        new KeyboardEvent('keydown', {
          key: 'a', code: 'KeyA', ctrlKey: true, metaKey: false,
          bubbles: true, cancelable: true
        }),
        new KeyboardEvent('keydown', {
          key: 'a', code: 'KeyA', ctrlKey: false, metaKey: true,
          bubbles: true, cancelable: true
        })
      ];
      
      for (const selectEvent of selectEvents) {
        textarea.dispatchEvent(selectEvent);
        await this.sleep(50);
      }
      
      // Multiple delete attempts
      const deleteEvents = [
        new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true }),
        new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', bubbles: true }),
        new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', ctrlKey: true, bubbles: true }), // Ctrl+X
        new KeyboardEvent('keydown', { key: 'x', code: 'KeyX', metaKey: true, bubbles: true })  // Cmd+X
      ];
      
      for (const deleteEvent of deleteEvents) {
        textarea.dispatchEvent(deleteEvent);
        await this.sleep(30);
        
        // Dispatch corresponding input and keyup events
        textarea.dispatchEvent(new Event('input', { bubbles: true }));
        textarea.dispatchEvent(new KeyboardEvent('keyup', {
          key: deleteEvent.key, code: deleteEvent.code,
          ctrlKey: deleteEvent.ctrlKey, metaKey: deleteEvent.metaKey,
          bubbles: true
        }));
        await this.sleep(30);
      }
      
      await this.sleep(100);
    }
  }

  async simulateSuperAggressiveMonacoClear(textarea) {
    debug.log('Starting super aggressive Monaco clearing...');
    textarea.focus();
    
    // Combined approach: rapid fire multiple key combinations
    const clearingMethods = [
      // Method 1: Rapid Ctrl+A + Delete
      async () => {
        for (let i = 0; i < 20; i++) {
          textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'a', code: 'KeyA', ctrlKey: true, bubbles: true }));
          await this.sleep(10);
          textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true }));
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          await this.sleep(10);
        }
      },
      
      // Method 2: Home + Shift+End + Delete (select all alternative)
      async () => {
        for (let i = 0; i < 10; i++) {
          textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', code: 'Home', ctrlKey: true, bubbles: true }));
          await this.sleep(5);
          textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', code: 'End', ctrlKey: true, shiftKey: true, bubbles: true }));
          await this.sleep(5);
          textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', code: 'Delete', bubbles: true }));
          textarea.dispatchEvent(new Event('input', { bubbles: true }));
          await this.sleep(10);
        }
      },
      
      // Method 3: Massive backspace spam
      async () => {
        for (let i = 0; i < 1000; i++) {
          textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Backspace', code: 'Backspace', bubbles: true }));
          if (i % 50 === 0) {
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            await this.sleep(5);
          }
        }
      }
    ];
    
    // Run all methods
    for (const method of clearingMethods) {
      await method();
      await this.sleep(100);
    }
  }

  async directMonacoManipulation(textarea) {
    debug.log('Attempting safe Monaco manipulation...');
    
    try {
      // Method 1: Try advanced keyboard combinations that Monaco should handle
      await this.advancedMonacoKeyboardClear(textarea);
      
      // Method 2: Try to trigger Monaco's own clear commands
      await this.triggerMonacoCommands(textarea);
      
      // Method 3: Safe textarea manipulation only (avoid DOM manipulation)
      await this.safeTextareaClear(textarea);
      
    } catch (e) {
      debug.log('Safe Monaco manipulation failed:', e);
    }
  }

  async advancedMonacoKeyboardClear(textarea) {
    debug.log('Trying advanced Monaco keyboard combinations...');
    textarea.focus();
    
    // Try different selection and clearing approaches
    const clearingSequences = [
      // Sequence 1: Triple-click + Delete
      async () => {
        // Triple click to select all
        textarea.dispatchEvent(new MouseEvent('click', { detail: 3, bubbles: true }));
        await this.sleep(100);
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
        await this.sleep(50);
      },
      
      // Sequence 2: Ctrl+L (select line) + Delete repeatedly
      async () => {
        for (let i = 0; i < 20; i++) {
          textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', code: 'KeyL', ctrlKey: true, bubbles: true }));
          await this.sleep(10);
          textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
          await this.sleep(10);
        }
      },
      
      // Sequence 3: Home, Shift+Ctrl+End, Delete
      async () => {
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Home', ctrlKey: true, bubbles: true }));
        await this.sleep(50);
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'End', ctrlKey: true, shiftKey: true, bubbles: true }));
        await this.sleep(50);
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
        await this.sleep(50);
      }
    ];
    
    for (const sequence of clearingSequences) {
      await sequence();
      await this.sleep(100);
    }
  }

  async triggerMonacoCommands(textarea) {
    debug.log('Trying to trigger Monaco commands...');
    
    // Try to trigger common Monaco editor commands
    const commands = [
      // Select All + Delete
      { key: 'a', ctrlKey: true },
      { key: 'Delete' },
      
      // Clear via cut
      { key: 'a', ctrlKey: true },
      { key: 'x', ctrlKey: true },
      
      // Try undo/redo cycles to force refresh
      { key: 'z', ctrlKey: true },
      { key: 'y', ctrlKey: true },
    ];
    
    for (const cmd of commands) {
      const event = new KeyboardEvent('keydown', {
        key: cmd.key,
        ctrlKey: cmd.ctrlKey || false,
        bubbles: true,
        cancelable: true
      });
      
      textarea.dispatchEvent(event);
      await this.sleep(50);
      
      // Also dispatch to the Monaco container
      const editorElement = textarea.closest('.monaco-editor');
      if (editorElement) {
        editorElement.dispatchEvent(event);
      }
      
      await this.sleep(50);
    }
  }

  async safeTextareaClear(textarea) {
    debug.log('Trying safe textarea clearing...');
    
    // Focus and clear textarea properties safely
    textarea.focus();
    await this.sleep(100);
    
    // Clear all text properties
    textarea.value = '';
    if (textarea.textContent !== undefined) textarea.textContent = '';
    
    // Dispatch events in proper sequence
    const eventSequence = [
      new Event('focus', { bubbles: true }),
      new KeyboardEvent('keydown', { key: 'a', ctrlKey: true, bubbles: true }),
      new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }),
      new Event('input', { bubbles: true }),
      new Event('change', { bubbles: true }),
      new KeyboardEvent('keyup', { key: 'Delete', bubbles: true }),
      new KeyboardEvent('keyup', { key: 'a', ctrlKey: true, bubbles: true })
    ];
    
    for (const event of eventSequence) {
      textarea.dispatchEvent(event);
      await this.sleep(20);
    }
    
    // Force cursor to beginning
    try {
      textarea.setSelectionRange(0, 0);
    } catch (e) {
      // Ignore if selection range not supported
    }
    
    debug.log('Safe textarea clearing completed');
  }

  async directClear(element) {
    debug.log('Using direct clear method');
    
    // Focus and select all
    element.focus();
    
    if (element.tagName === 'INPUT' || element.tagName === 'TEXTAREA') {
      // Set selection to entire content
      element.setSelectionRange(0, element.value.length);
      // Clear value via native setter (React/Vue safe)
      this._setNativeValue(element, '');
      // Set cursor to beginning
      element.setSelectionRange(0, 0);
    } else if (element.contentEditable === 'true' || element.isContentEditable) {
      // Select all content
      const selection = window.getSelection();
      const range = document.createRange();
      range.selectNodeContents(element);
      selection.removeAllRanges();
      selection.addRange(range);
      
      // Clear content
      element.textContent = '';
      element.innerHTML = '';
      
      // Reset cursor
      const newRange = document.createRange();
      newRange.setStart(element, 0);
      newRange.collapse(true);
      selection.removeAllRanges();
      selection.addRange(newRange);
    }
    
    // Dispatch events to notify the page
    const events = [
      new Event('input', { bubbles: true, cancelable: true }),
      new Event('change', { bubbles: true, cancelable: true }),
      new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }),
      new KeyboardEvent('keyup', { key: 'Delete', bubbles: true })
    ];
    
    events.forEach(event => element.dispatchEvent(event));
    
    debug.log('Direct clear completed');
  }

  findAndHighlightInputs() {
    // Remove existing highlights
    document.querySelectorAll('.paste-typer-highlight').forEach(el => {
      el.classList.remove('paste-typer-highlight');
    });
    
    // Find all editable inputs using the same logic as findBestEditableElement
    const selectors = [
      'input[type="text"]',
      'input[type="email"]', 
      'input[type="password"]',
      'input[type="search"]',
      'input[type="url"]',
      'input[type="tel"]',
      'input:not([type])',
      'textarea',
      '[contenteditable="true"]',
      '[contenteditable=""]',
      'div[contenteditable]',
      'p[contenteditable]',
      'span[contenteditable]'
    ];
    
    const inputs = document.querySelectorAll(selectors.join(', '));
    let count = 0;
    
    // Add CSS for highlighting if not already added
    if (!document.getElementById('paste-typer-highlight-style')) {
      const style = document.createElement('style');
      style.id = 'paste-typer-highlight-style';
      style.textContent = `
        .paste-typer-highlight {
          outline: 3px solid #FF9800 !important;
          outline-offset: 2px !important;
          background-color: rgba(255, 152, 0, 0.1) !important;
        }
      `;
      document.head.appendChild(style);
    }
    
    inputs.forEach(input => {
      const rect = input.getBoundingClientRect();
      // Only highlight visible elements
      if (rect.width > 0 && rect.height > 0) {
        input.classList.add('paste-typer-highlight');
        count++;
      }
    });
    
    // Remove highlights after 5 seconds
    setTimeout(() => {
      document.querySelectorAll('.paste-typer-highlight').forEach(el => {
        el.classList.remove('paste-typer-highlight');
      });
    }, 5000);
    
    return count;
  }

  setupKeyboardNavigation() {
    document.addEventListener('keydown', (e) => {
      if (!this.navigationMode) return;
      
      // Prevent default behavior for arrow keys during navigation
      if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
        e.preventDefault();
        e.stopPropagation();
        
        if (e.key === 'ArrowRight' || e.key === 'ArrowDown') {
          this.navigateToNext();
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') {
          this.navigateToPrevious();
        }
      } else if (e.key === 'Enter') {
        e.preventDefault();
        e.stopPropagation();
        this.selectCurrentInput();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        this.stopInputNavigation();
      }
    }, true); // Use capture phase to ensure we get the event first
  }

  startInputNavigation() {
    // Find all input fields
    const selectors = [
      'input[type="text"]',
      'input[type="email"]', 
      'input[type="password"]',
      'input[type="search"]',
      'input[type="url"]',
      'input[type="tel"]',
      'input:not([type])',
      'textarea',
      '[contenteditable="true"]',
      '[contenteditable=""]',
      'div[contenteditable]',
      'p[contenteditable]',
      'span[contenteditable]'
    ];
    
    const inputs = document.querySelectorAll(selectors.join(', '));
    this.availableInputs = Array.from(inputs).filter(input => {
      const rect = input.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0; // Only visible inputs
    });
    
    this.selectedInputIndex = 0;
    this.navigationMode = true;
    
    this.addNavigationStyles();
    this.highlightAllInputs();
    this.highlightSelectedInput();
    
    return this.availableInputs.length;
  }

  stopInputNavigation() {
    this.navigationMode = false;
    this.selectedInputIndex = -1;
    
    // Remove all highlights
    document.querySelectorAll('.paste-typer-input-available, .paste-typer-input-selected').forEach(el => {
      el.classList.remove('paste-typer-input-available', 'paste-typer-input-selected');
    });
    
    // Remove navigation indicator
    const indicator = document.getElementById('paste-typer-navigation-indicator');
    if (indicator) {
      indicator.remove();
    }
  }

  navigateToNext() {
    if (this.availableInputs.length === 0) return;
    
    this.selectedInputIndex = (this.selectedInputIndex + 1) % this.availableInputs.length;
    this.highlightSelectedInput();
  }

  navigateToPrevious() {
    if (this.availableInputs.length === 0) return;
    
    this.selectedInputIndex = this.selectedInputIndex <= 0 
      ? this.availableInputs.length - 1 
      : this.selectedInputIndex - 1;
    this.highlightSelectedInput();
  }

  selectCurrentInput() {
    if (this.selectedInputIndex >= 0 && this.selectedInputIndex < this.availableInputs.length) {
      const selectedInput = this.availableInputs[this.selectedInputIndex];
      
      // Store as target element BEFORE stopping navigation
      this.targetElement = selectedInput;
      debug.log('Selected input element:', selectedInput);
      
      // Focus the element
      selectedInput.focus();
      
      // Stop navigation mode
      this.stopInputNavigation();
      
      // Scroll into view if needed
      selectedInput.scrollIntoView({ behavior: 'smooth', block: 'center' });
      
      // Add a temporary highlight to show selection
      selectedInput.style.outline = '3px solid #4CAF50';
      selectedInput.style.outlineOffset = '2px';
      setTimeout(() => {
        selectedInput.style.outline = '';
        selectedInput.style.outlineOffset = '';
      }, 2000);
      
      return true;
    }
    return false;
  }

  addNavigationStyles() {
    if (!document.getElementById('paste-typer-navigation-style')) {
      const style = document.createElement('style');
      style.id = 'paste-typer-navigation-style';
      style.textContent = `
        .paste-typer-input-available {
          outline: 2px solid #2196F3 !important;
          outline-offset: 2px !important;
          background-color: rgba(33, 150, 243, 0.1) !important;
        }
        
        .paste-typer-input-selected {
          outline: 3px solid #FF5722 !important;
          outline-offset: 2px !important;
          background-color: rgba(255, 87, 34, 0.2) !important;
          box-shadow: 0 0 10px rgba(255, 87, 34, 0.5) !important;
        }
        
        .paste-typer-navigation-indicator {
          position: fixed;
          top: 10px;
          left: 50%;
          transform: translateX(-50%);
          z-index: 10000;
          background: rgba(0, 0, 0, 0.8);
          color: white;
          padding: 10px 15px;
          border-radius: 6px;
          font-family: Arial, sans-serif;
          font-size: 14px;
          box-shadow: 0 4px 12px rgba(0,0,0,0.3);
        }
      `;
      document.head.appendChild(style);
    }
  }

  highlightAllInputs() {
    this.availableInputs.forEach(input => {
      input.classList.add('paste-typer-input-available');
    });
  }

  highlightSelectedInput() {
    // Remove previous selection highlight
    document.querySelectorAll('.paste-typer-input-selected').forEach(el => {
      el.classList.remove('paste-typer-input-selected');
    });
    
    // Add selection highlight to current input
    if (this.selectedInputIndex >= 0 && this.selectedInputIndex < this.availableInputs.length) {
      const selectedInput = this.availableInputs[this.selectedInputIndex];
      selectedInput.classList.add('paste-typer-input-selected');
      
      // Update or create navigation indicator
      this.updateNavigationIndicator();
    }
  }

  updateNavigationIndicator() {
    let indicator = document.getElementById('paste-typer-navigation-indicator');
    
    if (!indicator) {
      indicator = document.createElement('div');
      indicator.id = 'paste-typer-navigation-indicator';
      indicator.className = 'paste-typer-navigation-indicator';
      document.body.appendChild(indicator);
    }
    
    const current = this.selectedInputIndex + 1;
    const total = this.availableInputs.length;
    indicator.textContent = `Input ${current}/${total}  ·  Left/Right arrows to navigate  ·  Enter to select  ·  Esc to exit`;
  }

  // 通过原型上的原生 value setter 写入值，避免绕过 React/Vue 的 _valueTracker
  // 导致清空后状态不同步。详见 StandardInputAdapter._setNativeValue。
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

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}

// Initialize the paste typer
const pasteTyper = new PasteTyper();

// Visual "active" indicator, created lazily on first typing so we don't inject
// a DOM node into every page the user visits.
let indicator = null;
let indicatorHideTimer = null;

function showActiveIndicator() {
  if (!document.body) return;

  if (!indicator) {
    indicator = document.createElement('div');
    indicator.id = 'paste-typer-indicator';
    indicator.style.cssText = `
      position: fixed;
      top: 10px;
      right: 10px;
      z-index: 10000;
      background: #4CAF50;
      color: white;
      padding: 8px 12px;
      border-radius: 4px;
      font-family: Arial, sans-serif;
      font-size: 12px;
      display: none;
      box-shadow: 0 2px 8px rgba(0,0,0,0.2);
    `;
    indicator.textContent = 'Paste Typer Active';
    document.body.appendChild(indicator);
  }

  indicator.style.display = 'block';
  clearTimeout(indicatorHideTimer);
  indicatorHideTimer = setTimeout(() => {
    indicator.style.display = 'none';
  }, 3000);
}

// Show indicator when typing starts
chrome.runtime.onMessage.addListener((request) => {
  if (request.action === 'startTyping') {
    showActiveIndicator();
  }
});