if (typeof globalThis.PT_DEBUG === "undefined") {
  globalThis.PT_DEBUG = false;
  globalThis.debug = {
    log: (...a) => { if (globalThis.PT_DEBUG) console.log(...a); },
    warn: (...a) => { if (globalThis.PT_DEBUG) console.warn(...a); }
  };
}

// Content script files, in dependency order. Injected on demand (the extension
// uses activeTab, not an <all_urls> auto-registered content script).
const CONTENT_FILES = [
  'content/inputAdapter.js',
  'content/googleDocsAdapter.js',
  'content/standardInputAdapter.js',
  'content/adapterManager.js',
  'content.js'
];

class BackgroundService {
  constructor() {
    this.setupContextMenu();
    this.setupMessageHandlers();
  }

  setupContextMenu() {
    chrome.runtime.onInstalled.addListener(() => {
      chrome.contextMenus.create({
        id: 'pasteTyper',
        title: 'Paste as typed text',
        contexts: ['editable']
      });
    });

    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
      if (info.menuItemId === 'pasteTyper') {
        try {
          const clipboardText = await this.readClipboard();
          if (clipboardText) {
            await this.sendToTabWithInjection(tab.id, {
              action: 'startTyping',
              text: clipboardText,
              targetElement: true
            });
          }
        } catch (error) {
          console.error('Failed to start typing from context menu:', error);
        }
      }
    });
  }

  // Send a message to the tab, injecting the content script first if it isn't
  // there yet. Sending first acts as the presence check, so we never inject
  // twice (re-injecting would re-declare the shared content-script classes).
  async sendToTabWithInjection(tabId, message) {
    try {
      return await chrome.tabs.sendMessage(tabId, message);
    } catch (e) {
      await chrome.scripting.executeScript({ target: { tabId }, files: CONTENT_FILES });
      return await chrome.tabs.sendMessage(tabId, message);
    }
  }

  setupMessageHandlers() {
    chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
      if (request.action === 'readClipboard') {
        this.readClipboard()
          .then(text => sendResponse({success: true, text}))
          .catch(error => sendResponse({success: false, error: error.message}));
        return true; // Indicates we will send a response asynchronously
      }
    });
  }

  async readClipboard() {
    try {
      // Use the chrome.action API to create a temporary tab for clipboard access
      const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      const tab = tabs[0];
      
      // Inject a script to read clipboard in the content context
      const result = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: async () => {
          try {
            return await navigator.clipboard.readText();
          } catch (error) {
            throw new Error('Clipboard access denied. Please grant clipboard permissions.');
          }
        }
      });
      
      return result[0].result;
    } catch (error) {
      console.error('Failed to read clipboard:', error);
      throw new Error('Could not access clipboard. Make sure you have granted clipboard permissions.');
    }
  }
}

// Initialize the background service
const backgroundService = new BackgroundService();