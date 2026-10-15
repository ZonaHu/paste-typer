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

    this.setupEventListeners();
    this.loadSettings().catch(error => this.showStatus('Failed to load settings: ' + error.message, 'error'));
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
      const value = parseInt(this.typoChanceSlider.value);
      const percentage = (value / 100).toFixed(1);
      this.typoChanceValue.textContent = `${percentage}%`;
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
    const typoChance = parseInt(this.typoChanceSlider.value) / 100;
    const speed = parseInt(this.speedSlider.value);

    const response = await this.sendCommand({ action: 'startTyping',
      text,
      targetElement: true,
      typoChance,
      speed
    });

    if (response && response.success) {
      this.showStatus('Typing started!', 'success');
    } else {
      this.showStatus('Failed to start typing' + (response && response.error ? ': ' + response.error : ''), 'error');
    }
  }

  async stopTyping(event) {
    if (event?.isTrusted !== true) return;
    const response = await this.sendCommand({ action: 'stopTyping' });
    if (response && response.success) {
      this.showStatus('Stopped', 'info');
    } else {
      this.showStatus('Error stopping' + (response && response.error ? ': ' + response.error : ''), 'error');
    }
  }

  close(event) {
    if (event?.isTrusted !== true) return;
    this.container.style.display = 'none';
  }

  async sendCommand(message) {
    try {
      return await chrome.runtime.sendMessage({ action: 'ptRoute', message });
    } catch (error) {
      return { success: false, error: error.message };
    }
  }

  showStatus(message, type) {
    this.status.textContent = message;
    this.status.className = `status ${type} show`;

    if (type === 'success' || type === 'info') {
      setTimeout(() => {
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
      typoChance: this.typoChanceSlider.value
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

      if (settings.typoChance !== undefined) {
        this.typoChanceSlider.value = settings.typoChance;
        const percentage = (parseInt(settings.typoChance) / 100).toFixed(1);
        this.typoChanceValue.textContent = `${percentage}%`;
      } else {
        this.typoChanceSlider.value = 5;
        this.typoChanceValue.textContent = '0.5%';
      }
    } else {
      this.typoChanceSlider.value = 5;
      this.typoChanceValue.textContent = '0.5%';
    }
  }
}
