// All tab messages are addressed to one frame; broadcasting would start typing
// in unrelated inputs and allow multiple frames to race when answering.
const PT_CONTENT_FILES = [
  'content/inputAdapter.js', 'content/targetTracker.js',
  'content/googleDocsAdapter.js', 'content/standardInputAdapter.js',
  'content/monacoAdapter.js', 'content/codeMirrorAdapter.js', 'content/adapterManager.js', 'floating-ui.js', 'content.js'
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
    // activeTab grants access to the invoked page. Scripting returns only
    // frames we may actually address, without a browsing-history permission.
    const results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true }, world: 'ISOLATED',
      func: () => ({ url: location.href,
        embeddedUrls: Array.from(document.querySelectorAll('iframe[src]'), iframe => iframe.src) })
    });
    return (results || []).filter(({ result }) => result && typeof result.url === 'string')
      .map(({ frameId, documentId, result }) => ({
        frameId, documentId, url: result.url, embeddedUrls: result.embeddedUrls
      }));
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
    for (const frame of frames) {
      for (const url of frame.embeddedUrls || []) {
        let origin;
        try { origin = new URL(url).origin; } catch { continue; }
        if (!/^https?:/.test(url) || origin === topOrigin || origin === 'null') continue;
        const pattern = `${origin}/*`;
        if (!await chrome.permissions.contains({ origins: [pattern] })) missing.add(pattern);
      }
    }
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

// CodeMirror 6.36 exposes cmView; 6.41 uses cmTile. These page-owned DOM
// expandos are hidden from isolated content scripts. Resolve the public view
// API from that one element, then verify its identity before dispatching.
async function editCodeMirror(token, operation, text) {
  try {
    const resolveTarget = () => {
      const matches = Array.from(document.querySelectorAll('.cm-content'))
        .filter(element => element.getAttribute('data-paste-typer-target') === token);
      const element = matches.length === 1 ? matches[0] : null;
      const candidate = element?.cmView?.rootView?.view || element?.cmTile?.root?.view;
      const view = candidate?.constructor?.findFromDOM?.(element);
      return element?.isConnected && element.ownerDocument === document && view && view === candidate &&
        view.contentDOM === element && view.dom === element.closest('.cm-editor') && view.root === document
        ? { element, view } : null;
    };
    const selected = resolveTarget();
    if (!selected) {
      return { success: false, error: 'Cannot access the selected CodeMirror editor. No text was inserted.' };
    }
    const { element, view } = selected;
    const isCurrent = () => {
      const current = resolveTarget();
      return current?.element === element && current.view === view;
    };
    const unavailable = () => ({ success: false,
      error: 'The selected CodeMirror editor changed or was removed before the edit was confirmed.' });
    let state = view.state;
    if (state.readOnly || !element.isContentEditable) {
      return { success: false, error: 'The selected CodeMirror editor is not editable.' };
    }
    if (operation === 'focus') {
      // Model selection survives blur. Restoring a DOM Range could overwrite it
      // or point at a line CodeMirror replaced during its last redraw.
      view.focus();
      await Promise.resolve();
      return isCurrent() ? { success: true } : unavailable();
    }
    let spec;
    if (operation === 'type') {
      spec = state.replaceSelection(text === '\n' ? state.lineBreak : text);
    } else if (operation === 'backspace') {
      spec = state.changeByRange(range => {
        const from = range.empty ? view.moveByChar(range, false).head : range.from;
        return { changes: { from, to: range.to, insert: '' }, range: state.selection.constructor.cursor(from) };
      });
    } else {
      // Match Select All followed by deletion. The explicit selection also
      // keeps Clear separate from the preceding typing group in native history.
      const selection = state.selection.constructor.single(0, state.doc.length);
      view.dispatch({ selection, userEvent: 'select' });
      await Promise.resolve();
      if (!isCurrent()) return unavailable();
      if (!view.state.selection.eq(selection)) {
        return { success: false, error: 'The selected CodeMirror editor did not accept Select All.' };
      }
      state = view.state;
      spec = state.replaceSelection('');
    }
    const expectedDoc = state.changes(spec.changes).apply(state.doc);
    const expectedSelection = spec.selection;
    const userEvent = operation === 'type' ? 'input.type' : operation === 'backspace' ? 'delete.backward' : 'delete.selection';
    view.dispatch({ ...spec, userEvent, scrollIntoView: true });
    // Hosts may restore controlled state or remove this view in a microtask.
    // Confirm after that work, before the typing engine advances its progress.
    await Promise.resolve();
    if (!isCurrent()) return unavailable();
    // Respect transaction filters and host dispatchers, but do not report an
    // ignored/rewritten edit as successful and advance past missing text.
    if (!view.state.doc.eq(expectedDoc) || !view.state.selection.eq(expectedSelection)) {
      return { success: false, error: 'The selected CodeMirror editor did not accept the requested edit.' };
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message || 'CodeMirror input failed.' };
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

function isCodeMirrorCharacter(text) {
  // Unicode mode rejects lone UTF-16 surrogates while accepting complete pairs.
  // Chrome 106 supports Segmenter but predates String.prototype.isWellFormed.
  return typeof text === 'string' && text.length > 0 && !/[\uD800-\uDFFF]/u.test(text) &&
    Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(text)).length === 1;
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== 'ptCodeMirrorInput') return;
  if (!sender.tab || !sender.documentId || !/^(https?:|about:)/.test(sender.url || '') ||
      typeof request.token !== 'string' || !request.token || request.token.length > 128 ||
      !['focus', 'type', 'backspace', 'clear'].includes(request.operation) ||
      (request.operation === 'type' ? !isCodeMirrorCharacter(request.text) : request.text !== undefined)) return;
  // Only the isolated content script can invoke this bridge. Page messages and
  // caller-provided tab/frame IDs never route edits into a different document.
  chrome.scripting.executeScript({
    target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
    world: 'MAIN', func: editCodeMirror, args: [request.token, request.operation, request.text || '']
  }).then(results => sendResponse(results[0]?.result ||
    { success: false, error: 'The selected CodeMirror editor is no longer available.' }))
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
