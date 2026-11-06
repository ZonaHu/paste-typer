// All tab messages are addressed to one frame; broadcasting would start typing
// in unrelated inputs and allow multiple frames to race when answering.
const PT_CONTENT_FILES = [
  'content/inputAdapter.js', 'content/targetTracker.js',
  'content/googleDocsAdapter.js', 'content/standardInputAdapter.js',
  'content/monacoAdapter.js', 'content/proseMirrorAdapter.js',
  'content/adapterManager.js', 'floating-ui.js', 'content.js'
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

// MAIN world only to read ProseMirror's document description. Its internal
// pmViewDesc is a read-only compatibility check, never a model mutation API.
// Browser editing commands feed the editor's normal DOM observer, input hooks,
// transaction filters and history. No clipboard/paste or document replacement.
async function simulateProseMirrorInput(token, text, operation) {
  const element = Array.from(document.querySelectorAll('.ProseMirror'))
    .find(candidate => candidate.getAttribute('data-paste-typer-prosemirror-target') === token);
  const unavailable = () => ({ success: false, error: 'Cannot access the selected ProseMirror editor. No text was inserted.' });
  const description = element?.pmViewDesc;
  if (!element?.isConnected || !element.isContentEditable || !description?.node ||
      description.dom !== element || typeof description.posFromDOM !== 'function' ||
      typeof description.node.eq !== 'function' || typeof description.node.textBetween !== 'function' ||
      typeof description.node.resolve !== 'function' || typeof description.node.cut !== 'function') return unavailable();
  const before = description.node;
  const selection = window.getSelection();
  if (!selection?.rangeCount || !element.contains(selection.anchorNode) || !element.contains(selection.focusNode)) {
    return { success: false, error: 'The selected editor lost its caret. Click inside it and try again.' };
  }
  const from = description.posFromDOM(selection.anchorNode, selection.anchorOffset, 1);
  const to = description.posFromDOM(selection.focusNode, selection.focusOffset, 1);
  const start = Math.min(from, to), end = Math.max(from, to);
  if (start < 0 || end > before.content.size) return unavailable();
  // ProseMirror's normal-whitespace parser converts tabs to spaces. Refuse
  // before editing rather than silently changing the user's source text.
  if (operation === 'type' && text === '\t' && before.resolve(start).parent.type.whitespace !== 'pre') {
    return { success: false, error: 'This ProseMirror block normalizes tabs to spaces. Use a code block for literal tabs.' };
  }
  const existing = before.textBetween(start, end);
  let deletionStart = start;
  if (operation === 'backspace' && start === end) {
    const resolved = before.resolve(start);
    const preceding = before.textBetween(resolved.start(), start, '', '\ufffc');
    const previous = preceding && new Intl.Segmenter(undefined, { granularity: 'grapheme' })
      .segment(preceding).containing(preceding.length - 1).segment;
    deletionStart = Math.max(0, start - (previous ? previous.length : 2));
  }
  element.focus({ preventScroll: true });
  if (operation === 'clear') {
    const range = document.createRange();
    range.selectNodeContents(element);
    selection.removeAllRanges(); selection.addRange(range);
  }
  const key = operation === 'type' ? text === '\n' ? 'Enter' : text : 'Backspace';
  const keyCode = key === 'Enter' ? 13 : key === 'Backspace' ? 8
    : /^[a-z]$/i.test(key) ? key.toUpperCase().charCodeAt(0) : 0;
  const keyboard = type => {
    const charCode = type === 'keypress' ? text.charCodeAt(0) : 0;
    return new KeyboardEvent(type, {
      key, code: key === 'Enter' || key === 'Backspace' ? key : '',
      keyCode: charCode || keyCode, which: charCode || keyCode, charCode,
      bubbles: true, cancelable: true
    });
  };
  const settle = () => new Promise(resolve => setTimeout(resolve, 0));
  const caret = () => {
    const desc = element.pmViewDesc, selected = window.getSelection();
    if (!element.isConnected || !element.isContentEditable || document.activeElement !== element ||
        !desc?.node || !selected?.rangeCount || !element.contains(selected.anchorNode) || !element.contains(selected.focusNode)) {
      throw new Error('The selected editor or caret changed. Typing stopped before further input.');
    }
    const anchor = desc.posFromDOM(selected.anchorNode, selected.anchorOffset, 1);
    const head = desc.posFromDOM(selected.focusNode, selected.focusOffset, 1);
    return { doc: desc.node, from: Math.min(anchor, head), to: Math.max(anchor, head) };
  };
  const expected = caret();
  const handled = () => {
    const current = caret();
    if (!before.eq(current.doc)) return true;
    if (operation === 'clear') return false;
    if (current.from === expected.from && current.to === expected.to) return false;
    if (operation === 'type' && existing === text && current.from === start + text.length && current.to === current.from) return true;
    throw new Error('The editor moved the selected caret. Typing stopped before further input.');
  };
  let eventMutated = false;
  const observer = new MutationObserver(records => { if (records.length) eventMutated = true; });
  observer.observe(element, { childList: true, characterData: true, subtree: true });
  const dispatch = async event => {
    eventMutated = false; observer.takeRecords();
    const accepted = element.dispatchEvent(event);
    // Hooks can perform their own browser edit or move focus. Let ProseMirror
    // observe those effects, then verify ownership before any default edit.
    await settle();
    const edited = eventMutated || observer.takeRecords().length > 0;
    const changed = handled();
    if (!accepted && !changed) throw new Error('The editor rejected the simulated input.');
    // A hook's edit may have been rejected and redrawn already. It still owned
    // this input attempt; do not send the same character a second time.
    return changed || edited;
  };
  let failure, keydownSent = false;
  try {
    // Clear uses the explicit DOM selection above. A synthetic Backspace can
    // make a keymap delete its still-pending old model selection instead.
    let consumed = false;
    if (operation !== 'clear') {
      keydownSent = true;
      consumed = await dispatch(keyboard('keydown'));
      // Native composed input has no one-code-unit keypress. For ordinary
      // characters, preserve PM's handleKeyPress hook (including its own edit).
      if (!consumed && operation === 'type' && text !== '\n' && text.length === 1) {
        consumed = await dispatch(keyboard('keypress'));
      }
    }
    if (!consumed) {
      const inputType = operation === 'type' ? text === '\n' ? 'insertParagraph' : 'insertText'
        : 'deleteContentBackward';
      consumed = await dispatch(new InputEvent('beforeinput', {
        data: operation === 'type' && text !== '\n' ? text : null,
        inputType, bubbles: true, cancelable: true
      }));
    }
    if (!consumed && !handled()) {
      if (operation === 'clear') {
        // Selectionchange may normalize the full-root range while hooks run.
        // Clear explicitly owns the whole editor, so select it again only after
        // verifying focus/model and immediately before native deletion.
        const range = document.createRange(); range.selectNodeContents(element);
        selection.removeAllRanges(); selection.addRange(range);
      }
      const command = operation !== 'type' ? 'delete' : text === '\n' ? 'insertParagraph' : 'insertText';
      const accepted = document.execCommand(command, false, operation === 'type' ? text : null);
      await settle();
      if (!accepted) throw new Error('The editor did not accept browser text input.');
    }
  } catch (error) {
    failure = error.message;
  } finally {
    if (keydownSent) { element.dispatchEvent(keyboard('keyup')); await settle(); }
    observer.disconnect();
  }
  if (failure) return { success: false, error: failure };
  try {
    const current = caret(), after = current.doc;
    const emptyBoundary = node => node.isTextblock ? node.content.size === 0
      : node.childCount === 1 && emptyBoundary(node.firstChild);
    const samePrefix = (left, right) => left.eq(right) ||
      left.content.size === 0 && emptyBoundary(right) || right.content.size === 0 && emptyBoundary(left);
    const sameSuffix = (left, right) => {
      if (samePrefix(left, right)) return true;
      // Enter and cross-block replacement can change the surviving boundary
      // textblock's wrapper. Its content/marks and complete later nodes remain
      // exact; newly created schema-required empty wrappers are allowed too.
      if (left.isTextblock && right.isTextblock) return left.content.eq(right.content);
      if (!left.sameMarkup(right) || left.childCount !== right.childCount || !left.childCount) return false;
      for (let i = 1; i < left.childCount; i++) if (!left.child(i).eq(right.child(i))) return false;
      return sameSuffix(left.firstChild, right.firstChild);
    };
    if (operation === 'type') {
      const insertedEnd = current.from;
      const leafText = node => node.type.name === 'hard_break' ? '\n' : '\ufffc';
      const lengths = text === '\n' ? [1, 2] : [text.length];
      const literal = current.to === insertedEnd && lengths.some(length => {
        const insertedStart = insertedEnd - length;
        return insertedStart >= 0 && after.textBetween(insertedStart, insertedEnd, '\n', leafText) === text &&
          samePrefix(before.cut(0, start), after.cut(0, insertedStart)) && sameSuffix(before.cut(end), after.cut(insertedEnd));
      });
      if (!literal) {
        return { success: false, error: 'The editor rejected or transformed the simulated character. Typing stopped.' };
      }
    } else if (operation === 'backspace' &&
        (after.content.size !== before.content.size - (end - deletionStart) ||
          current.from !== deletionStart || current.to !== deletionStart ||
          !samePrefix(before.cut(0, deletionStart), after.cut(0, deletionStart)) || !sameSuffix(before.cut(end), after.cut(deletionStart)))) {
      return { success: false, error: 'The editor rejected or transformed Backspace. Typing stopped.' };
    } else if (before.eq(after) || operation === 'clear' && after.textBetween(0, after.content.size, '\n', '\ufffc') !== '') {
      return { success: false, error: 'The editor rejected the simulated deletion. Typing stopped.' };
    }
    return { success: true };
  } catch (error) {
    return { success: false, error: error.message };
  }
}

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== 'ptProseMirrorInput') return;
  if (!sender.tab || !sender.documentId || !/^https?:|^about:/.test(sender.url || '') ||
      typeof request.token !== 'string' || typeof request.text !== 'string' ||
      !['type', 'backspace', 'clear'].includes(request.operation)) return;
  if (request.operation === 'type') {
    if (!request.text || request.text.length > 128 ||
        Array.from(new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(request.text)).length !== 1) return;
  } else if (request.text !== '') return;
  chrome.scripting.executeScript({
    target: { tabId: sender.tab.id, documentIds: [sender.documentId] },
    world: 'MAIN', func: simulateProseMirrorInput, args: [request.token, request.text, request.operation]
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
