// Floating UI Controller
// Runs in the page's main world (loaded via <script> injected into shadow DOM).
// chrome.* APIs are NOT available here — communicate with the content script via window.postMessage.

const PT_MSG_TAG = 'paste-typer-floating-ui';
const pendingResponses = new Map();
let requestSeq = 0;

function sendToContentScript(action, payload = {}) {
  const requestId = `${Date.now()}-${++requestSeq}`;
  return new Promise((resolve) => {
    pendingResponses.set(requestId, resolve);
    window.postMessage({ source: PT_MSG_TAG, direction: 'to-content', requestId, action, payload }, '*');
    // Safety timeout so callers don't hang forever
    setTimeout(() => {
      if (pendingResponses.has(requestId)) {
        pendingResponses.delete(requestId);
        resolve({ success: false, error: 'timeout' });
      }
    }, 5000);
  });
}

window.addEventListener('message', (event) => {
  const data = event.data;
  if (!data || data.source !== PT_MSG_TAG || data.direction !== 'to-floating-ui') return;
  const resolve = pendingResponses.get(data.requestId);
  if (resolve) {
    pendingResponses.delete(data.requestId);
    resolve(data.response || { success: false });
  }
});

class FloatingUIController {
  // `root` is the shadow root hosting the UI (or `document` when the page is
  // opened standalone). document.getElementById cannot see into a shadow tree,
  // so every lookup must go through the root.
  constructor(root) {
    this.root = root;
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
    this.loadSettings();
  }

  setupEventListeners() {
    this.speedSlider.addEventListener('input', () => {
      const speed = this.speedSlider.value;
      this.speedValue.textContent = `${speed}ms`;
      this.saveSettings();
    });

    this.typoChanceSlider.addEventListener('input', () => {
      const value = parseInt(this.typoChanceSlider.value);
      const percentage = (value / 100).toFixed(1);
      this.typoChanceValue.textContent = `${percentage}%`;
      this.saveSettings();
    });

    this.loadClipboardButton.addEventListener('click', () => {
      this.loadFromClipboard();
    });

    this.startButton.addEventListener('click', () => {
      this.startTyping();
    });

    this.stopButton.addEventListener('click', () => {
      this.stopTyping();
    });

    this.closeBtn.addEventListener('click', () => {
      this.close();
    });

    this.textInput.addEventListener('input', () => {
      this.saveSettings();
    });
  }

  async loadFromClipboard() {
    try {
      this.showStatus('Loading from clipboard...', 'info');
      const text = await navigator.clipboard.readText();
      this.textInput.value = text;
      this.saveSettings();
      this.showStatus('Clipboard text loaded', 'success');
    } catch (error) {
      this.showStatus('Failed to read clipboard: ' + error.message, 'error');
    }
  }

  async startTyping() {
    const text = this.textInput.value.trim();

    if (!text) {
      this.showStatus('Please enter some text to type', 'error');
      return;
    }

    this.showStatus('Starting typing...', 'info');
    const typoChance = parseInt(this.typoChanceSlider.value) / 100;

    const response = await sendToContentScript('startTyping', {
      text,
      targetElement: true,
      typoChance
    });

    if (response && response.success) {
      this.showStatus('Typing started!', 'success');
    } else {
      this.showStatus('Failed to start typing' + (response && response.error ? ': ' + response.error : ''), 'error');
    }
  }

  async stopTyping() {
    const response = await sendToContentScript('stopTyping');
    if (response && response.success) {
      this.showStatus('Stopped', 'info');
    } else {
      this.showStatus('Error stopping' + (response && response.error ? ': ' + response.error : ''), 'error');
    }
  }

  close() {
    // The host element lives in the page document; the UI lives in its shadow root.
    const host = document.getElementById('paste-typer-floating-ui');
    if (host) {
      host.style.display = 'none';
    } else if (document.body) {
      document.body.style.display = 'none'; // standalone page fallback
    }
    sendToContentScript('floatingUIClosed');
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

  async saveSettings() {
    const settings = {
      text: this.textInput.value,
      speed: this.speedSlider.value,
      typoChance: this.typoChanceSlider.value
    };
    await sendToContentScript('saveSettings', { settings });
  }

  async loadSettings() {
    const response = await sendToContentScript('loadSettings');
    const settings = response && response.settings;

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

// This script is appended to the shadow root AFTER the UI markup, so the
// elements already exist — initialize immediately. Waiting for DOMContentLoaded
// would never fire here (the page finished loading long before the panel opens).
(() => {
  const host = document.getElementById('paste-typer-floating-ui');
  const root = (host && host.shadowRoot) || document;
  if (root.getElementById('textInput')) {
    new FloatingUIController(root);
  } else {
    // Standalone page where the script loads before the DOM is parsed.
    document.addEventListener('DOMContentLoaded', () => {
      new FloatingUIController(document);
    });
  }
})();
