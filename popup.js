if (typeof globalThis.PT_DEBUG === "undefined") {
  globalThis.PT_DEBUG = false;
  globalThis.debug = {
    log: (...a) => { if (globalThis.PT_DEBUG) console.log(...a); },
    warn: (...a) => { if (globalThis.PT_DEBUG) console.warn(...a); }
  };
}

// Content script files, in dependency order. Injected on demand since the
// extension uses activeTab rather than an <all_urls> auto content script.
const CONTENT_FILES = [
  'content/inputAdapter.js',
  'content/googleDocsAdapter.js',
  'content/standardInputAdapter.js',
  'content/adapterManager.js',
  'content.js'
];

class PopupController {
  constructor() {
    this.textInput = document.getElementById('textInput');
    this.speedSlider = document.getElementById('speedSlider');
    this.speedValue = document.getElementById('speedValue');
    this.typoChanceSlider = document.getElementById('typoChanceSlider');
    this.typoChanceValue = document.getElementById('typoChanceValue');
    this.startButton = document.getElementById('startTyping');
    this.stopButton = document.getElementById('stopTyping');
    this.pauseButton = document.getElementById('pauseTyping');
    this.resetButton = document.getElementById('resetTyping');
    this.loadClipboardButton = document.getElementById('loadClipboard');
    this.openFloatingUIButton = document.getElementById('openFloatingUI');
    this.findInputsButton = document.getElementById('findInputs');
    this.status = document.getElementById('status');
    this.elementInfo = document.getElementById('elementInfo');
    this.progressContainer = document.getElementById('progressContainer');
    this.progressBar = document.getElementById('progressBar');
    this.progressText = document.getElementById('progressText');
    
    // Navigation controls
    this.navigationControls = document.getElementById('navigationControls');
    this.prevInputButton = document.getElementById('prevInput');
    this.nextInputButton = document.getElementById('nextInput');
    this.selectInputButton = document.getElementById('selectInput');
    this.exitNavigationButton = document.getElementById('exitNavigation');
    this.navigationStatus = document.getElementById('navigationStatus');
    
    this.progressInterval = null;
    this.isNavigationMode = false;
    this._injectPromise = null; // dedupes concurrent on-demand injections

    this.setupEventListeners();
    this.loadSettings();
    this.checkCurrentTab();
    this.checkActiveElement();
  }

  setupEventListeners() {
    this.speedSlider.addEventListener('input', () => {
      const speed = this.speedSlider.value;
      this.speedValue.textContent = `${speed}ms`;
      this.saveSettings();
    });

    if (this.typoChanceSlider) {
      this.typoChanceSlider.addEventListener('input', () => {
        const value = parseInt(this.typoChanceSlider.value);
        const percentage = (value / 100).toFixed(1);
        this.typoChanceValue.textContent = `${percentage}%`;
        this.saveSettings();
      });
    }

    this.loadClipboardButton.addEventListener('click', () => {
      this.loadFromClipboard();
    });

    if (this.openFloatingUIButton) {
      this.openFloatingUIButton.addEventListener('click', () => {
        this.openFloatingUI();
      });
    }

    this.startButton.addEventListener('click', () => {
      this.startTyping();
    });

    this.stopButton.addEventListener('click', () => {
      this.stopTyping();
    });

    this.pauseButton.addEventListener('click', () => {
      this.togglePause();
    });

    this.resetButton.addEventListener('click', () => {
      this.resetTyping();
    });

    this.findInputsButton.addEventListener('click', () => {
      this.findInputFields();
    });

    // Navigation control event listeners
    this.prevInputButton.addEventListener('click', () => {
      this.navigatePrevious();
    });

    this.nextInputButton.addEventListener('click', () => {
      this.navigateNext();
    });

    this.selectInputButton.addEventListener('click', () => {
      this.selectCurrentInput();
    });

    this.exitNavigationButton.addEventListener('click', () => {
      this.exitNavigation();
    });

    this.textInput.addEventListener('input', () => {
      this.saveSettings();
    });
  }

  async loadFromClipboard() {
    try {
      this.showStatus('Loading from clipboard...', 'info');
      
      // Try direct clipboard access first (works in popup context)
      try {
        const text = await navigator.clipboard.readText();
        this.textInput.value = text;
        this.saveSettings();
        this.showStatus('Clipboard text loaded', 'success');
        return;
      } catch (directError) {
        debug.log('Direct clipboard access failed, trying background script...');
      }
      
      // Fallback to background script method
      const response = await this.sendMessage({ action: 'readClipboard' });
      
      if (response.success) {
        this.textInput.value = response.text;
        this.saveSettings();
        this.showStatus('Clipboard text loaded', 'success');
      } else {
        this.showStatus('Failed to read clipboard: ' + response.error, 'error');
      }
    } catch (error) {
      this.showStatus('Error: ' + error.message, 'error');
    }
  }

  async startTyping() {
    const text = this.textInput.value.trim();
    
    if (!text) {
      this.showStatus('Please enter some text to type', 'error');
      return;
    }

    try {
      this.showStatus('Looking for input field...', 'info');
      this.startButton.disabled = true;
      
      // Get current settings
      const typoChance = this.typoChanceSlider ? parseInt(this.typoChanceSlider.value) / 100 : 0.005;
      
      const response = await this.sendMessageToTab({
        action: 'startTyping',
        text: text,
        targetElement: true,
        typoChance: typoChance
      });
      
      if (response && response.success) {
        this.showStatus('Typing started!', 'success');
        this.startProgressTracking();
        this.startButton.style.display = 'none';
        this.pauseButton.style.display = 'block';
        this.stopButton.style.display = 'block';
        if (this.helpText) {
          this.helpText.style.display = 'block';
        }
        setTimeout(() => {
          this.startButton.disabled = false;
        }, 2000);
      } else {
        const err = (response && response.error) || '';
        if (err.includes('No editable input field') || err.includes('未找到') || err.includes('编辑器')) {
          this.showStatus('No input field found. Click on the document first!', 'error');
        } else {
          this.showStatus('Failed to start typing' + (err ? ': ' + err : ''), 'error');
        }
        this.startButton.disabled = false;
      }
    } catch (error) {
      if (error.message.includes('No editable input field') || error.message.includes('未找到')) {
        this.showStatus('No input field found. Click on the document first!', 'error');
      } else {
        this.showStatus('Error: ' + error.message, 'error');
      }
      this.startButton.disabled = false;
    }
  }

  async stopTyping() {
    try {
      await this.sendMessageToTab({ action: 'stopTyping' });
      this.showStatus('Typing stopped', 'info');
      this.startButton.disabled = false;
      this.pauseButton.textContent = 'Pause';
      this.pauseButton.style.backgroundColor = '#f59e0b';
      this.stopProgressTracking();
    } catch (error) {
      this.showStatus('Error stopping: ' + error.message, 'error');
    }
  }

  async togglePause() {
    try {
      const isPaused = this.pauseButton.textContent.includes('Resume');
      
      if (isPaused) {
        // Currently paused, so resume
        await this.sendMessageToTab({ action: 'resumeTyping' });
        this.showStatus('Typing resumed', 'info');
        this.pauseButton.textContent = 'Pause';
        this.pauseButton.style.backgroundColor = '#f59e0b';
      } else {
        // Currently typing, so pause
        await this.sendMessageToTab({ action: 'pauseTyping' });
        this.showStatus('Typing paused', 'info');
        this.pauseButton.textContent = 'Resume';
        this.pauseButton.style.backgroundColor = '#16a34a';
      }
    } catch (error) {
      this.showStatus('Error toggling pause: ' + error.message, 'error');
    }
  }

  async resetTyping() {
    try {
      await this.sendMessageToTab({ action: 'resetTyping' });
      this.showStatus('Input field cleared and typing reset', 'info');
      this.startButton.disabled = false;
      this.pauseButton.textContent = 'Pause';
      this.pauseButton.style.backgroundColor = '#f59e0b';
      this.stopProgressTracking();
    } catch (error) {
      this.showStatus('Error resetting: ' + error.message, 'error');
    }
  }

  startProgressTracking() {
    this.progressContainer.style.display = 'block';
    this.progressInterval = setInterval(async () => {
      try {
        const response = await this.sendMessageToTab({ action: 'getTypingProgress' });
        if (response) {
          const { position, total, isTyping, isPaused } = response;
          
          if (!isTyping) {
            this.stopProgressTracking();
            return;
          }
          
          const percentage = total > 0 ? (position / total) * 100 : 0;
          this.progressBar.style.width = percentage + '%';
          this.progressText.textContent = `${position} / ${total}`;
          
          if (isPaused) {
            this.progressBar.style.backgroundColor = '#f59e0b';
          } else {
            this.progressBar.style.backgroundColor = '';
          }
        }
      } catch (error) {
        debug.log('Progress tracking error:', error);
      }
    }, 500);
  }

  stopProgressTracking() {
    if (this.progressInterval) {
      clearInterval(this.progressInterval);
      this.progressInterval = null;
    }
    this.progressContainer.style.display = 'none';
    this.progressBar.style.width = '0%';
    this.progressText.textContent = '0 / 0';
  }

  async findInputFields() {
    try {
      if (this.isNavigationMode) {
        // Already in navigation mode, exit it
        await this.exitNavigation();
        return;
      }

      this.showStatus('Starting input navigation mode...', 'info');
      
      const response = await this.sendMessageToTab({ action: 'startInputNavigation' });
      
      if (response && response.success && response.count > 0) {
        this.isNavigationMode = true;
        this.navigationControls.style.display = 'block';
        this.findInputsButton.textContent = 'Exit';
        this.findInputsButton.style.backgroundColor = '#ef4444';
        this.findInputsButton.style.color = '#fff';
        this.findInputsButton.style.borderColor = '#ef4444';
        
        this.updateNavigationStatus(1, response.count);
        this.showStatus(`Found ${response.count} input field(s)! Use buttons below to navigate.`, 'success');
      } else if (response && response.count === 0) {
        this.showStatus('No input fields found on this page', 'error');
      } else {
        this.showStatus('Failed to start navigation mode', 'error');
      }
    } catch (error) {
      this.showStatus('Error starting navigation: ' + error.message, 'error');
    }
  }

  async navigatePrevious() {
    try {
      const response = await this.sendMessageToTab({ action: 'navigatePrevious' });
      if (response && response.success) {
        this.updateNavigationStatus(response.selectedIndex + 1, response.total);
      }
    } catch (error) {
      console.error('Navigation error:', error);
    }
  }

  async navigateNext() {
    try {
      const response = await this.sendMessageToTab({ action: 'navigateNext' });
      if (response && response.success) {
        this.updateNavigationStatus(response.selectedIndex + 1, response.total);
      }
    } catch (error) {
      console.error('Navigation error:', error);
    }
  }

  async selectCurrentInput() {
    try {
      const response = await this.sendMessageToTab({ action: 'selectCurrentInput' });
      if (response && response.success) {
        this.showStatus('Input field selected!', 'success');
        await this.exitNavigation();
      } else {
        this.showStatus('Failed to select input field', 'error');
      }
    } catch (error) {
      this.showStatus('Error selecting input: ' + error.message, 'error');
    }
  }

  async exitNavigation() {
    try {
      await this.sendMessageToTab({ action: 'stopInputNavigation' });
      this.isNavigationMode = false;
      this.navigationControls.style.display = 'none';
      this.findInputsButton.textContent = 'Navigate';
      this.findInputsButton.style.backgroundColor = '';
      this.findInputsButton.style.color = '';
      this.findInputsButton.style.borderColor = '';
      this.showStatus('Navigation mode exited', 'info');
    } catch (error) {
      console.error('Exit navigation error:', error);
    }
  }

  updateNavigationStatus(current, total) {
    this.navigationStatus.textContent = `Input ${current} / ${total}`;
  }

  async checkCurrentTab() {
    try {
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      const url = (tab && tab.url) || '';

      if (url.startsWith('chrome://') || url.startsWith('chrome-extension://')) {
        this.elementInfo.textContent = 'Extension pages not supported. Navigate to a regular website.';
        this.elementInfo.style.display = 'block';
        this.startButton.disabled = true;
        this.findInputsButton.disabled = true;
      }
    } catch (error) {
      debug.log('Could not check current tab:', error);
    }
  }

  _renderActiveElementInfo({ tagName, type, id, className, isEditable }) {
    let desc = (tagName || '').toLowerCase();
    if (type) desc += `[type="${type}"]`;
    if (id) desc += `#${id}`;
    if (className && typeof className === 'string') {
      const firstClass = className.split(' ').filter(Boolean)[0];
      if (firstClass) desc += `.${firstClass}`;
    }

    // Clear and rebuild via DOM API — page-derived values go to textContent only.
    this.elementInfo.textContent = '';
    const label = document.createElement('span');
    label.textContent = isEditable ? 'Active element: ' : 'Active element: ';
    const code = document.createElement('code');
    code.textContent = desc;
    const trailing = document.createElement('span');
    trailing.textContent = isEditable ? ' (editable)' : ' (not editable)';

    this.elementInfo.appendChild(label);
    this.elementInfo.appendChild(code);
    this.elementInfo.appendChild(trailing);

    if (!isEditable) {
      this.elementInfo.appendChild(document.createElement('br'));
      const hint = document.createElement('small');
      hint.textContent = 'Use "Find Input Fields" to locate text areas';
      this.elementInfo.appendChild(hint);
    }
    this.elementInfo.style.display = 'block';
  }

  async checkActiveElement() {
    try {
      const response = await this.sendMessageToTab({ action: 'getActiveElement' });
      if (response) {
        this._renderActiveElementInfo(response);
      }
    } catch (error) {
      this.elementInfo.textContent = 'Content script not ready. Try refreshing the page.';
      this.elementInfo.style.display = 'block';
      debug.log('Could not check active element:', error);
    }
  }

  sendMessage(message) {
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage(message, (response) => {
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(response);
        }
      });
    });
  }

  // Inject the content script once per popup session. Concurrent callers share
  // the same promise so the script is never injected twice (re-injection would
  // re-declare the shared content-script classes and throw).
  _ensureInjected(tabId) {
    if (!this._injectPromise) {
      this._injectPromise = chrome.scripting.executeScript({
        target: { tabId },
        files: CONTENT_FILES
      });
    }
    return this._injectPromise;
  }

  async sendMessageToTab(message) {
    const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
    const tab = tabs[0];
    const url = (tab && tab.url) || '';

    // Check if tab URL is valid for content scripts
    if (url.startsWith('chrome://') || url.startsWith('chrome-extension://') || url.startsWith('moz-extension://')) {
      throw new Error('Extension cannot run on this page. Please navigate to a regular website.');
    }

    try {
      return await chrome.tabs.sendMessage(tab.id, message);
    } catch (e) {
      const msg = (e && e.message) || '';
      if (!msg.includes('Could not establish connection') && !msg.includes('Receiving end does not exist')) {
        throw e;
      }
      // Content script not present yet — inject it and retry once.
      try {
        await this._ensureInjected(tab.id);
      } catch (injectionError) {
        throw new Error('Content script not loaded. Please refresh the page and try again.');
      }
      return await chrome.tabs.sendMessage(tab.id, message);
    }
  }

  showStatus(message, type) {
    this.status.textContent = message;
    this.status.className = `status ${type}`;
    this.status.style.display = 'block';
    
    if (type === 'success' || type === 'info') {
      setTimeout(() => {
        this.status.style.display = 'none';
      }, 3000);
    }
  }

  saveSettings() {
    const settings = {
      text: this.textInput.value,
      speed: this.speedSlider.value,
      typoChance: this.typoChanceSlider ? this.typoChanceSlider.value : 5
    };
    
    chrome.storage.local.set({ pasteTyperSettings: settings });
  }

  loadSettings() {
    chrome.storage.local.get(['pasteTyperSettings'], (result) => {
      if (result.pasteTyperSettings) {
        const settings = result.pasteTyperSettings;
        
        if (settings.text) {
          this.textInput.value = settings.text;
        }
        
        if (settings.speed) {
          this.speedSlider.value = settings.speed;
          this.speedValue.textContent = `${settings.speed}ms`;
        }
        
        if (this.typoChanceSlider) {
          if (settings.typoChance !== undefined) {
            this.typoChanceSlider.value = settings.typoChance;
            const percentage = (parseInt(settings.typoChance) / 100).toFixed(1);
            this.typoChanceValue.textContent = `${percentage}%`;
          } else {
            this.typoChanceSlider.value = 5;
            this.typoChanceValue.textContent = '0.5%';
          }
        }
      } else {
        if (this.typoChanceSlider) {
          this.typoChanceSlider.value = 5;
          this.typoChanceValue.textContent = '0.5%';
        }
      }
    });
  }

  async openFloatingUI() {
    try {
      // Routes through sendMessageToTab so the content script is injected on
      // demand if it isn't already present.
      await this.sendMessageToTab({ action: 'toggleFloatingUI' });
      this.showStatus('Floating UI opened', 'success');
      window.close(); // Close popup
    } catch (error) {
      this.showStatus('Error: ' + error.message, 'error');
    }
  }
}

// Initialize when DOM is loaded
document.addEventListener('DOMContentLoaded', () => {
  new PopupController();
});