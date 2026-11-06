// One service-worker queue owns read/modify/write so a stale panel cannot undo
// another panel's privacy preference or overwrite an unrelated slider change.
let settingsQueue = Promise.resolve();
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== 'ptSettings') return;
  const extensionPage = sender.url?.startsWith(chrome.runtime.getURL(''));
  if (!extensionPage && !sender.tab) return;
  if (!['get', 'save', 'clearText'].includes(request.operation)) return;
  const operation = settingsQueue.then(async () => {
    const result = await chrome.storage.local.get('pasteTyperSettings');
    const saved = result.pasteTyperSettings || {};
    const settings = { ...saved, rememberText: saved.rememberText !== false };
    if (request.operation === 'save') {
      const patch = request.settings;
      if (!patch || typeof patch !== 'object' || Array.isArray(patch)) throw new Error('Invalid settings.');
      for (const [key, value] of Object.entries(patch)) {
        if (!['text', 'speed', 'typoChance', 'rememberText'].includes(key) ||
            (key === 'rememberText' ? typeof value !== 'boolean' : typeof value !== 'string')) {
          throw new Error('Invalid setting: ' + key);
        }
        // A deletion must win even before another context receives onChanged.
        if (key === 'text' && (request.textRevision ?? 0) !== (saved.textRevision || 0)) continue;
        settings[key] = value;
      }
    }
    if (request.operation === 'clearText' || settings.rememberText !== (saved.rememberText !== false)) {
      // Change even when no source is saved, so every open panel cancels old
      // clipboard reads and forgets drafts after a privacy action.
      settings.textRevision = (saved.textRevision || 0) + 1;
    }
    if (!settings.rememberText || request.operation === 'clearText') delete settings.text;
    if (request.operation !== 'get' || (!settings.rememberText && 'text' in saved)) {
      await chrome.storage.local.set({ pasteTyperSettings: settings });
    }
    return { success: true, settings };
  });
  settingsQueue = operation.catch(() => {});
  operation.then(sendResponse).catch(error => sendResponse({ success: false, error: error.message }));
  return true;
});
