importScripts('frameRouter.js');

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
  }

  setupContextMenu() {
    chrome.runtime.onInstalled.addListener(() => {
      // onInstalled also fires on reload/update, and the previously registered
      // menu item survives — clear it first to avoid "duplicate id".
      chrome.contextMenus.removeAll(() => {
        chrome.contextMenus.create({
          id: 'pasteTyper',
          title: 'Paste as typed text',
          contexts: ['editable']
        }, () => {
          if (chrome.runtime.lastError) {
            debug.warn('contextMenus.create:', chrome.runtime.lastError.message);
          }
        });
      });
    });

    chrome.contextMenus.onClicked.addListener(async (info, tab) => {
      if (info.menuItemId === 'pasteTyper') {
        try {
          const clipboardText = await this.readClipboard();
          if (clipboardText) {
            await frameRouter.route(tab.id, {
              action: 'startTyping',
              text: clipboardText,
              targetElement: true
            }, info.frameId);
          }
        } catch (error) {
          console.error('Failed to start typing from context menu:', error);
        }
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
