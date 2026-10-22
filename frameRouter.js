// All tab messages are addressed to one frame; broadcasting would start typing
// in unrelated inputs and allow multiple frames to race when answering.
const PT_CONTENT_FILES = [
  'content/inputAdapter.js', 'content/targetTracker.js',
  'content/googleDocsAdapter.js', 'content/standardInputAdapter.js',
  'content/monacoAdapter.js', 'content/adapterManager.js', 'floating-ui.js', 'content.js'
];

class FrameRouter {
  constructor() {
    this.pending = new Map();
    this.selections = new Map();
    chrome.tabs.onRemoved?.addListener(tabId => {
      this.selections.delete(tabId);
      chrome.storage.session.remove(`ptSelectedFrame:${tabId}`);
    });
  }

  async frames(tabId) {
    return (await chrome.webNavigation.getAllFrames({ tabId })) || [];
  }

  async ensure(tabId, frameId) {
    const key = `${tabId}:${frameId}`;
    if (this.pending.has(key)) return this.pending.get(key);
    const operation = (async () => {
      // Probe dependencies too: a partial load must not leave a visible panel
      // without its isolated controller or redeclare already-loaded classes.
      const probeState = async () => {
        const results = await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] },
          world: 'ISOLATED',
          func: () => {
            try {
              const hasTyper = typeof pasteTyper !== 'undefined';
              return { hasTyper, hasFloating: typeof FloatingUIController !== 'undefined',
                legacyBridge: hasTyper && typeof pasteTyper.setupFloatingUIBridge === 'function' };
            } catch {
              // A failed top-level const initializer leaves an uninitialized
              // binding: even typeof throws, and reinjection cannot repair it.
              return { initializationFailed: true };
            }
          }
        });
        return results?.[0]?.result;
      };
      let state = await probeState();
      // Chrome can return a null result when an injected function fails. Retry
      // only the read-only probe; never interpret an unknown state as unloaded.
      if (state == null) state = await probeState();
      const verified = state && ['hasTyper', 'hasFloating', 'legacyBridge']
        .every(key => typeof state[key] === 'boolean');
      // Neither an unverifiable installation nor an old instance owning a
      // page-facing listener can be safely repaired by reinjecting classes.
      if (!verified || state.legacyBridge) {
        const error = new Error('Paste Typer scripts changed. Reload the extension and refresh this page.');
        error.code = 'PT_REFRESH_REQUIRED';
        throw error;
      }
      if (!state.hasTyper || !state.hasFloating) {
        const files = state.hasTyper ? ['floating-ui.js']
          : PT_CONTENT_FILES.filter(file => file !== 'floating-ui.js' || !state.hasFloating);
        await chrome.scripting.executeScript({
          target: { tabId, frameIds: [frameId] }, world: 'ISOLATED', files
        });
      }
      return chrome.tabs.sendMessage(tabId, { action: 'getTargetInfo' }, { frameId });
    })();
    this.pending.set(key, operation);
    try { return await operation; } finally { this.pending.delete(key); }
  }

  async prepare(tabId) {
    const frames = await this.frames(tabId);
    const top = frames.find(frame => frame.frameId === 0);
    if (!top) throw new Error('The page is no longer available.');
    const topOrigin = new URL(top.url).origin;
    const missing = new Set();
    const available = [];
    await Promise.all(frames.map(async frame => {
      let origin;
      try { origin = new URL(frame.url).origin; } catch { return; }
      if (!/^https?:/.test(frame.url) && !frame.url.startsWith('about:')) return;
      if (origin !== topOrigin && origin !== 'null') {
        const pattern = `${origin}/*`;
        if (!await chrome.permissions.contains({ origins: [pattern] })) {
          missing.add(pattern);
          return;
        }
      }
      try {
        const info = await this.ensure(tabId, frame.frameId);
        available.push({ ...frame, info });
      } catch (error) {
        // Sandboxed, removed or inaccessible frames must not prevent the main
        // page from working. Failure of the main frame should remain visible.
        if (frame.frameId === 0 || error.code === 'PT_REFRESH_REQUIRED') throw error;
      }
    }));
    return { available, missingOrigins: [...missing].sort() };
  }

  async route(tabId, message, preferredFrameId) {
    const { available } = await this.prepare(tabId);
    if (message.action === 'startTyping' && available.some(candidate => candidate.info.isTyping)) {
      throw new Error('Typing is already running. Stop it before selecting another editor.');
    }
    let frame;
    if (message.action === 'toggleFloatingUI') {
      frame = available.find(candidate => candidate.frameId === 0);
    } else if (preferredFrameId !== undefined) {
      frame = available.find(candidate => candidate.frameId === preferredFrameId);
    } else {
      // Progress and stop/pause/resume stay with the running session. A new
      // start follows the most recently selected editor, not an old session.
      if (message.action !== 'startTyping' && message.action !== 'getActiveElement') {
        frame = available.find(candidate => candidate.info.isTyping);
      }
      if (!frame) {
        const selected = available.filter(candidate => candidate.info.hasTarget || candidate.info.invalidTarget);
        selected.sort((a, b) => b.info.changedAt - a.info.changedAt ||
          Number(b.info.focused) - Number(a.info.focused));
        const top = available.find(candidate => candidate.frameId === 0);
        const selectionKey = `ptSelectedFrame:${tabId}`;
        const stored = chrome.storage?.session ? await chrome.storage.session.get(selectionKey) : {};
        const previous = stored[selectionKey] || this.selections.get(tabId);
        const latest = selected[0];
        if (previous && previous.topDocument === top?.documentId &&
            !available.some(candidate => candidate.documentId === previous.documentId) &&
            (!latest || latest.info.changedAt <= previous.changedAt)) {
          throw new Error('The selected editor was removed or navigated. Click an editor and try again.');
        }
        frame = latest || top;
        if (latest) {
          const selection = { documentId: latest.documentId,
            topDocument: top?.documentId, changedAt: latest.info.changedAt };
          this.selections.set(tabId, selection);
          if (chrome.storage?.session) await chrome.storage.session.set({ [selectionKey]: selection });
        }
      }
    }
    if (!frame) throw new Error('The selected frame is no longer available. Reopen Paste Typer.');
    // documentId prevents a navigation between probe and command from typing
    // into a different document that happens to reuse the same frameId.
    return chrome.tabs.sendMessage(tabId, message,
      frame.documentId ? { documentId: frame.documentId } : { frameId: frame.frameId });
  }
}

const frameRouter = new FrameRouter();

// Runs in the selected frame's MAIN world: content scripts cannot access the
// page's Monaco instances. Never search other frames or fall back to another
// editor when the selected input disappears.
function simulateMonacoInput(token, text) {
  const element = Array.from(document.querySelectorAll('textarea.inputarea'))
    .find(candidate => candidate.getAttribute('data-paste-typer-target') === token);
  const root = element?.closest('.monaco-editor');
  const api = window.monaco;
  const editor = root && api?.editor?.getEditors?.()
    .find(candidate => candidate.getDomNode() === root);
  if (!editor || !element.isConnected) {
    return { success: false, error: 'Cannot access the selected Monaco editor. No text was inserted.' };
  }
  const model = editor.getModel();
  if (!model || editor.getOption(api.editor.EditorOption.readOnly)) {
    return { success: false, error: 'The selected Monaco editor is not editable.' };
  }
  const option = name => editor.getOption(api.editor.EditorOption[name]);
  const saved = {
    autoIndent: ['none', 'keep', 'brackets', 'advanced', 'full'][option('autoIndent')],
    autoClosingBrackets: option('autoClosingBrackets'),
    autoClosingQuotes: option('autoClosingQuotes'),
    autoClosingOvertype: option('autoClosingOvertype'),
    autoSurround: option('autoSurround'),
    formatOnType: option('formatOnType'),
    acceptSuggestionOnEnter: option('acceptSuggestionOnEnter')
  };
  try {
    // Suppress editor-generated characters only during this synchronous input.
    // Restoration does not depend on Stop, navigation or worker lifetime.
    editor.updateOptions({ autoIndent: 'none', autoClosingBrackets: 'never',
      autoClosingQuotes: 'never', autoClosingOvertype: 'never', autoSurround: 'never',
      formatOnType: false, acceptSuggestionOnEnter: 'off' });
    const key = text === '\n' ? 'Enter' : text;
    const keyCode = text === '\n' ? 13 : /^[a-z]$/i.test(text) ? text.toUpperCase().charCodeAt(0)
      : /^[0-9]$/.test(text) ? text.charCodeAt(0) : 0;
    const code = text === '\n' ? 'Enter' : /^[a-z]$/i.test(text) ? `Key${text.toUpperCase()}`
      : /^[0-9]$/.test(text) ? `Digit${text}` : '';
    const keyboard = type => new KeyboardEvent(type, { key, code, keyCode, which: keyCode,
      bubbles: true, cancelable: true });
    const versionBeforeKey = model.getVersionId();
    const accepted = element.dispatchEvent(keyboard('keydown'));
    // Monaco handles Enter in keydown. Printable characters (and literal tabs)
    // need the text-input stage that untrusted KeyboardEvents cannot generate.
    if (accepted) {
      element.setRangeText(text, element.selectionStart, element.selectionEnd, 'end');
      element.dispatchEvent(new InputEvent('input', { data: text,
        inputType: 'insertText', bubbles: true }));
    } else if (text !== '\n' || model.getVersionId() === versionBeforeKey) {
      return { success: false, error: 'The editor intercepted the simulated key.' };
    }
    element.dispatchEvent(keyboard('keyup'));
    return { success: true };
  } finally {
    editor.updateOptions(saved);
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== 'ptMonacoInput') return;
  // Only content scripts in their own document may request these edits. A
  // popup cannot choose a tab, frame, or document through this message.
  if (!sender.tab || !sender.documentId || !/^https?:|^about:/.test(sender.url || '') ||
      typeof request.token !== 'string' || typeof request.text !== 'string' ||
      request.text.length === 0 || request.text.length > 2) return;
  chrome.scripting.executeScript({
    target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
    world: 'MAIN', func: simulateMonacoInput, args: [request.token, request.text]
  }).then(results => sendResponse(results[0]?.result ||
    { success: false, error: 'The selected editor is no longer available.' }))
    .catch(error => sendResponse({ success: false, error: error.message }));
  return true;
});

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (!['ptRoute', 'ptPrepare'].includes(request.action)) return;
  const extensionPage = sender.url && sender.url.startsWith(chrome.runtime.getURL(''));
  if (request.action === 'ptPrepare' && !extensionPage) return;
  if (!extensionPage && !sender.tab) return;
  const tabId = extensionPage ? request.tabId : sender.tab.id;
  if (!Number.isInteger(tabId)) return;
  const actions = ['startTyping', 'stopTyping', 'pauseTyping', 'resumeTyping',
    'resetTyping', 'getActiveElement', 'findAndHighlightInputs', 'getTypingProgress',
    'startInputNavigation', 'stopInputNavigation', 'selectCurrentInput',
    'navigatePrevious', 'navigateNext', 'toggleFloatingUI'];
  if (request.action === 'ptRoute' && !actions.includes(request.message?.action)) return;
  const operation = request.action === 'ptPrepare'
    ? frameRouter.prepare(tabId).then(result => ({ success: true, missingOrigins: result.missingOrigins }))
    : frameRouter.route(tabId, request.message, request.frameId);
  operation.then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
  return true;
});
