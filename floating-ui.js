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
    this.pauseButton = root.getElementById('pauseTyping');
    this.progressInterval = null;
    this.sessionState = 'idle';
    this.loadClipboardButton = root.getElementById('loadClipboard');
    this.closeBtn = root.getElementById('closeBtn');
    this.header = root.getElementById('header');
    this.status = root.getElementById('status');
    this.progressInterval = null;
    this.statusTimeout = null;

    this.setupEventListeners();
    this.settingsReady = this.loadSettings().catch(error => this.showStatus('Failed to load settings: ' + error.message, 'error'));
    this.syncTypingState();
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
      this.typoChanceValue.textContent = PTTypoRate.formatPercent(this.typoChanceSlider.value);
      this.saveSettings(event, 'typoChance');
    });

    this.loadClipboardButton.addEventListener('click', event => {
      this.loadFromClipboard(event);
    });

    this.startButton.addEventListener('click', event => {
      this.startTyping(event);
    });

    this.pauseButton.addEventListener('click', event => this.togglePause(event));

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
    this.hide();
  }

  hide() {
    this.textVersion++;
    if (!this.rememberSourceText) this.textInput.value = '';
    this.container.style.display = 'none';
    this.stopProgressTracking();
  }

  async togglePause(event) {
    if (event?.isTrusted !== true) return;
    const response = await this.sendCommand({ action: this.sessionState === 'paused' ? 'resumeTyping' : 'pauseTyping' });
    if (!response?.success) this.showStatus(response?.error || 'Could not change pause state', 'error');
    await this.syncTypingState();
  }

  renderTypingState(progress) {
    const state = progress.state || (progress.isTyping ? progress.isPaused ? 'paused' : 'running' : 'idle');
    const changed = state !== this.sessionState || progress.sessionId !== this.lastSessionId;
    this.sessionState = state;
    this.lastSessionId = progress.sessionId;
    const active = state === 'running' || state === 'paused';
    const clearing = state === 'clearing';
    this.startButton.disabled = active || clearing || state === 'stopping';
    this.stopButton.disabled = !(active || clearing);
    this.pauseButton.disabled = !active;
    this.pauseButton.textContent = state === 'paused' ? 'Resume' : 'Pause';
    if (!changed && state !== 'running') return;
    if (state === 'error') this.showStatus(progress.error || 'Typing failed', 'error');
    else if (state === 'stopped') this.showStatus('Stopped', 'info');
    else if (state === 'stopping') this.showStatus('Stopping...', 'info');
    else if (state === 'clearing') this.showStatus('Clearing selected field...', 'info');
    else if (state === 'completed') this.showStatus(progress.deliveryVerified === false
      ? 'Keystrokes sent. Check the document for missing text.' : 'Typing complete',
    progress.deliveryVerified === false ? 'info' : 'success');
    else if (state === 'paused') this.showStatus('Typing paused', 'info');
    else if (state === 'running') this.showStatus(`Typing ${progress.position} / ${progress.total}`, 'info');
  }

  async syncTypingState() {
    if (this.container.style.display === 'none') return;
    const response = await this.sendCommand({ action: 'getTypingProgress' });
    if (this.container.style.display === 'none') return;
    if (!response || response.success === false) {
      this.stopProgressTracking();
      this.showStatus(response?.error || 'Lost connection to typing session. Refresh this page.', 'error');
      return;
    }
    this.renderTypingState(response);
    if (!this.progressInterval) this.startProgressTracking();
  }

  startProgressTracking() {
    if (this.progressInterval) return;
    this.progressInterval = setInterval(() => this.syncTypingState(), 250);
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

      this.typoChanceSlider.value = PTTypoRate.normalizePercent(settings.typoChance);
      this.typoChanceValue.textContent = PTTypoRate.formatPercent(settings.typoChance);
    } else {
      this.typoChanceSlider.value = PTTypoRate.normalizePercent();
      this.typoChanceValue.textContent = PTTypoRate.formatPercent();
    }
  }
}
