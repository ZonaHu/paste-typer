if (typeof globalThis.PT_DEBUG === "undefined") {
  globalThis.PT_DEBUG = false;
  globalThis.debug = {
    log: (...a) => { if (globalThis.PT_DEBUG) console.log(...a); },
    warn: (...a) => { if (globalThis.PT_DEBUG) console.warn(...a); }
  };
}

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
            chrome.tabs.sendMessage(tab.id, {
              action: 'startTyping',
              text: clipboardText,
              targetElement: true
            });
          }
        } catch (error) {
          console.error('Failed to read clipboard:', error);
        }
      }
    });
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