// Floating UI Controller
// Loaded as a content script in the isolated world. The host page has no
// message bridge to this controller or to extension storage/runtime APIs.

class FloatingUIController {
  // Shadow DOM isolates styles, not authority. Only trusted user events may
  // trigger privileged actions through these shared DOM controls.
  constructor(root, container) {
    this.root = root;
    this.container = container;
    this.textInput = root.getElementById('textInput');
    this.speedSlider = root.getElementById('speedSlider');
    this.speedValue = root.getElementById('speedValue');
    this.typoChanceSlider = root.getElementById('typoChanceSlider');
    this.typoChanceValue = root.getElementById('typoChanceValue');
    this.startButton = root.getElementById('startTyping');
    this.stopButton = root.getElementById('stopTyping');
    this.loadClipboardButton = root.getElementById('loadClipboard');
    this.closeBtn = root.getElementById('closeBtn');
    this.header = root.getElementById('header');
    this.status = root.getElementById('status');
    this.progressInterval = null;
    this.statusTimeout = null;

    this.setupEventListeners();
    this.loadSettings().catch(error => this.showStatus('Failed to load settings: ' + error.message, 'error'));
    this.syncTypingState();
  }

  setupEventListeners() {
    this.speedSlider.addEventListener('input', event => {
      if (event.isTrusted !== true) return;
      const speed = this.speedSlider.value;
      this.speedValue.textContent = `${speed}ms`;
      this.saveSettings(event);
    });

    this.typoChanceSlider.addEventListener('input', event => {
      if (event.isTrusted !== true) return;
      this.typoChanceValue.textContent = PTTypoRate.formatPercent(this.typoChanceSlider.value);
      this.saveSettings(event);
    });

    this.loadClipboardButton.addEventListener('click', event => {
      this.loadFromClipboard(event);
    });

    this.startButton.addEventListener('click', event => {
      this.startTyping(event);
    });

    this.stopButton.addEventListener('click', event => {
      this.stopTyping(event);
    });

    this.closeBtn.addEventListener('click', event => {
      this.close(event);
    });

    this.textInput.addEventListener('input', event => {
      this.saveSettings(event);
    });
  }

  async loadFromClipboard(event) {
    if (event?.isTrusted !== true) return;
    try {
      this.showStatus('Loading from clipboard...', 'info');
      const text = await navigator.clipboard.readText();
      this.textInput.value = text;
      await this._saveSettings();
      this.showStatus('Clipboard text loaded', 'success');
    } catch (error) {
      this.showStatus('Failed to read clipboard: ' + error.message, 'error');
    }
  }

  async startTyping(event) {
    if (event?.isTrusted !== true) return;
    const text = this.textInput.value;

    if (!text) {
      this.showStatus('Please enter some text to type', 'error');
      return;
    }

    this.showStatus('Starting typing...', 'info');
    const typoChance = PTTypoRate.toProbability(this.typoChanceSlider.value);
    const speed = parseInt(this.speedSlider.value);

    const response = await this.sendCommand({ action: 'startTyping',
      text,
      targetElement: true,
      typoChance,
      speed
    });

    if (response && response.success) {
      this.showStatus('Typing started!', 'success');
      this.startProgressTracking();
    } else {
      this.showStatus('Failed to start typing' + (response && response.error ? ': ' + response.error : ''), 'error');
    }
  }

  async stopTyping(event) {
    if (event?.isTrusted !== true) return;
    const response = await this.sendCommand({ action: 'stopTyping' });
    if (response && response.success) {
      this.stopProgressTracking();
      this.showStatus('Stopped', 'info');
    } else {
      this.showStatus('Error stopping' + (response && response.error ? ': ' + response.error : ''), 'error');
    }
  }

  close(event) {
    if (event?.isTrusted !== true) return;
    this.container.style.display = 'none';
    this.stopProgressTracking();
  }

  startProgressTracking() {
    this.stopProgressTracking();
    const interval = setInterval(async () => {
      const response = await this.sendCommand({ action: 'getTypingProgress' });
      if (this.progressInterval !== interval) return;
      if (!response || response.success === false) {
        this.stopProgressTracking();
        this.showStatus(response?.error || 'Lost connection to typing session. Refresh this page.', 'error');
      } else if (!response.isTyping) {
        this.stopProgressTracking();
        const unverified = response.deliveryVerified === false;
        this.showStatus(response.error || (unverified
          ? 'Keystrokes sent. Check the document for missing text.' : 'Typing complete'),
        response.error ? 'error' : unverified ? 'info' : 'success');
      } else if (response.isPaused) {
        this.showStatus('Typing paused', 'info');
      } else {
        this.showStatus(`Typing ${response.position} / ${response.total}`, 'info');
      }
    }, 500);
    this.progressInterval = interval;
  }

  async syncTypingState() {
    const response = await this.sendCommand({ action: 'getTypingProgress' });
    if (this.container.style.display === 'none' || this.progressInterval) return;
    if (response?.isTyping) this.startProgressTracking();
    else if (response?.error) this.showStatus(response.error, 'error');
  }

  stopProgressTracking() {
    if (this.progressInterval) clearInterval(this.progressInterval);
    this.progressInterval = null;
  }

  async sendCommand(message) {
    try {
      return await chrome.runtime.sendMessage({ action: 'ptRoute', message });
    } catch (error) {
      return { success: false, error: /Could not establish connection|Receiving end does not exist/.test(error.message)
        ? 'Paste Typer lost its connection. Refresh this page and reopen the extension.'
        : error.message };
    }
  }

  showStatus(message, type) {
    if (this.statusTimeout) clearTimeout(this.statusTimeout);
    this.status.textContent = message;
    this.status.className = `status ${type} show`;

    if (type === 'success' || type === 'info') {
      this.statusTimeout = setTimeout(() => {
        this.status.classList.remove('show');
      }, 3000);
    }
  }

  async saveSettings(event) {
    if (event?.isTrusted !== true) return;
    try {
      await this._saveSettings();
    } catch (error) {
      this.showStatus('Failed to save settings: ' + error.message, 'error');
    }
  }

  async _saveSettings() {
    const settings = {
      text: this.textInput.value,
      speed: this.speedSlider.value,
      typoChance: String(PTTypoRate.normalizePercent(this.typoChanceSlider.value))
    };
    await chrome.storage.local.set({ pasteTyperSettings: settings });
  }

  async loadSettings() {
    const result = await chrome.storage.local.get(['pasteTyperSettings']);
    const settings = result.pasteTyperSettings;

    if (settings) {
      if (settings.text) {
        this.textInput.value = settings.text;
      }

      if (settings.speed) {
        this.speedSlider.value = settings.speed;
        this.speedValue.textContent = `${settings.speed}ms`;
      }

      this.typoChanceSlider.value = PTTypoRate.normalizePercent(settings.typoChance);
      this.typoChanceValue.textContent = PTTypoRate.formatPercent(settings.typoChance);
    } else {
      this.typoChanceSlider.value = PTTypoRate.normalizePercent();
      this.typoChanceValue.textContent = PTTypoRate.formatPercent();
    }
  }
}
