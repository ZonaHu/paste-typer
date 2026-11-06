// Floating UI Controller
// Loaded as a content script in the isolated world. The host page has no
// message bridge to this controller or to extension storage/runtime APIs.

class FloatingUIController {
  // Shadow DOM isolates styles, not authority. Only trusted user events may
  // trigger privileged actions through these shared DOM controls.
  constructor(root, container) {
    this.root = root;
    this.container = container;
    this.textVersion = 0;
    this.sourceRevision = 0;
    // Until settings arrive, closing must discard a potentially private draft.
    this.rememberSourceText = null;
    this.textInput = root.getElementById('textInput');
    this.rememberText = root.getElementById('rememberText');
    this.deleteSavedText = root.getElementById('deleteSavedText');
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
    this.settingsReady = this.loadSettings().catch(error => this.showStatus('Failed to load settings: ' + error.message, 'error'));
  }

  setupEventListeners() {
    // Synthetic checkbox/label clicks can generate a trusted change event.
    // Cancel their default action before it reaches the preference handler.
    this.root.getElementById('textPrivacy').addEventListener('click', event => {
      if (event.isTrusted !== true) event.preventDefault();
    }, true);
    this.rememberText.addEventListener('change', event => {
      if (event.isTrusted !== true) return;
      this.updateTextPrivacy('save', { rememberText: this.rememberText.checked });
    });
    this.deleteSavedText.addEventListener('click', event => {
      if (event.isTrusted !== true) return;
      this.updateTextPrivacy('clearText');
    });
    chrome.storage.onChanged.addListener((changes, area) => {
      const change = changes.pasteTyperSettings;
      if (area !== 'local' || !change) return;
      this.sourceRevision = change.newValue?.textRevision || 0;
      const remember = change.newValue?.rememberText !== false;
      if (this.rememberSourceText !== remember) this.textVersion++;
      this.rememberSourceText = this.rememberText.checked = remember;
      if (change.oldValue?.textRevision !== change.newValue?.textRevision ||
          (change.oldValue && 'text' in change.oldValue && !('text' in (change.newValue || {}))) ||
          (change.oldValue?.rememberText !== false && change.newValue?.rememberText === false)) {
        this.textVersion++;
        this.textInput.value = '';
      }
    });
    this.speedSlider.addEventListener('input', event => {
      if (event.isTrusted !== true) return;
      const speed = this.speedSlider.value;
      this.speedValue.textContent = `${speed}ms`;
      this.saveSettings(event, 'speed');
    });

    this.typoChanceSlider.addEventListener('input', event => {
      if (event.isTrusted !== true) return;
      const value = parseInt(this.typoChanceSlider.value);
      const percentage = (value / 100).toFixed(1);
      this.typoChanceValue.textContent = `${percentage}%`;
      this.saveSettings(event, 'typoChance');
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
      if (event.isTrusted !== true) return;
      this.textEdited = true;
      this.textVersion++;
      this.saveSettings(event, 'text');
    });
  }

  async loadFromClipboard(event) {
    if (event?.isTrusted !== true) return;
    try {
      const version = this.textVersion;
      await this.settingsReady;
      const revision = this.sourceRevision;
      this.showStatus('Loading from clipboard...', 'info');
      const text = await navigator.clipboard.readText();
      if (version !== this.textVersion) return;
      const saved = await this.settingsRequest('save', { text }, revision);
      if (version !== this.textVersion || (saved.textRevision || 0) !== revision) return;
      this.textInput.value = text;
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
    this.hide();
  }

  hide() {
    this.textVersion++;
    if (!this.rememberSourceText) this.textInput.value = '';
    this.container.style.display = 'none';
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
    this.status.textContent = message;
    this.status.className = `status ${type} show`;

    if (type === 'success' || type === 'info') {
      setTimeout(() => {
        this.status.classList.remove('show');
      }, 3000);
    }
  }

  async settingsRequest(operation, settings, textRevision = this.sourceRevision) {
    const response = await chrome.runtime.sendMessage({ action: 'ptSettings', operation, settings, textRevision });
    if (!response?.success) throw new Error(response?.error || 'Settings are unavailable.');
    return response.settings;
  }

  async updateTextPrivacy(operation, settings) {
    this.textVersion++;
    try {
      const saved = await this.settingsRequest(operation, settings);
      this.rememberSourceText = this.rememberText.checked = saved.rememberText;
      if (operation === 'clearText' || !saved.rememberText) this.textInput.value = '';
      this.showStatus(operation === 'clearText' ? 'Saved text deleted' :
        saved.rememberText ? 'New text will be remembered' : 'Text will no longer be saved', 'info');
    } catch (error) {
      this.showStatus('Failed to change text privacy: ' + error.message, 'error');
    }
  }

  async saveSettings(event, field = 'text') {
    if (event?.isTrusted !== true) return;
    try {
      await this._saveSettings(field);
    } catch (error) {
      this.showStatus('Failed to save settings: ' + error.message, 'error');
    }
  }

  async _saveSettings(field) {
    const values = { text: this.textInput.value, speed: this.speedSlider.value,
      typoChance: this.typoChanceSlider.value };
    const version = this.textVersion;
    await this.settingsReady;
    if (field === 'text' && version !== this.textVersion) return;
    await this.settingsRequest('save', { [field]: values[field] });
  }

  async loadSettings() {
    const settings = await this.settingsRequest('get');
    // A privacy change can arrive while the initial response is in flight.
    const currentSource = (settings.textRevision || 0) >= this.sourceRevision;
    if (currentSource) {
      this.sourceRevision = settings.textRevision || 0;
      this.rememberSourceText = this.rememberText.checked = settings.rememberText;
    }
    this.rememberText.disabled = this.deleteSavedText.disabled = false;

    if (settings) {
      if (currentSource && settings.rememberText && settings.text && !this.textEdited) {
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
