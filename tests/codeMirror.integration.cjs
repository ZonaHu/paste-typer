const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const dependencies = path.resolve(process.env.PT_TEST_DEPS || path.join(root, '.local-analysis/harness'));
const editorDependencies = path.resolve(process.env.PT_CODEMIRROR_DEPS || dependencies);
const { chromium } = require(path.join(dependencies, 'node_modules/playwright'));
const esbuild = require(path.join(editorDependencies, 'node_modules/esbuild'));
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-typer-codemirror-'));
const extension = path.join(scratch, 'extension');
fs.mkdirSync(extension);
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && /\.(js|html|json|png)$/.test(entry.name)) {
    fs.copyFileSync(path.join(root, entry.name), path.join(extension, entry.name));
  }
}
fs.cpSync(path.join(root, 'content'), path.join(extension, 'content'), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*'];
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const fixture = esbuild.buildSync({ bundle: true, write: false, format: 'iife',
  nodePaths: [path.join(editorDependencies, 'node_modules')], stdin: { resolveDir: editorDependencies, contents: `
import { EditorState, EditorSelection, Transaction } from '@codemirror/state';
import { EditorView, keymap, Decoration, WidgetType } from '@codemirror/view';
import { history, historyKeymap, undo, redo } from '@codemirror/commands';
class InputWidget extends WidgetType {
  toDOM() {
    const wrapper = document.createElement('span'); wrapper.contentEditable = 'false';
    const input = document.createElement('input'); input.id = 'widget-input'; input.value = 'INPUT';
    const textarea = document.createElement('textarea'); textarea.id = 'widget-textarea'; textarea.value = 'TEXTAREA';
    const rich = document.createElement('span'); rich.id = 'widget-rich'; rich.contentEditable = 'true'; rich.tabIndex = 0;
    rich.innerHTML = '<span>RICH</span>'; wrapper.append(input, textarea, rich); return wrapper;
  }
}
window.makeHostState = doc => EditorState.create({doc});
window.editors = []; window.transactions = [];
window.resetEditor = (index, doc, selection, options = {}) => {
  const extensions = [history(), keymap.of(historyKeymap), EditorState.allowMultipleSelections.of(true),
    EditorState.readOnly.of(!!options.readOnly), EditorView.editable.of(options.editable !== false),
    EditorView.updateListener.of(update => {
      for (const tr of update.transactions) if (tr.docChanged) {
        const changes = []; tr.changes.iterChanges((from, to, _a, _b, inserted) => changes.push({from, to, text: inserted.toString()}));
        transactions.push({index, changes, event: tr.annotation(Transaction.userEvent)});
      }
    })];
  if (options.widgets) extensions.push(EditorView.decorations.of(Decoration.set([
    Decoration.widget({widget: new InputWidget(), side: 1}).range(2)])));
  if (options.reject) extensions.push(EditorState.transactionFilter.of(tr => tr.docChanged ? [] : tr));
  if (options.lineBreak) extensions.push(EditorState.lineSeparator.of(options.lineBreak));
  const state = EditorState.create({doc, selection: Array.isArray(selection)
    ? EditorSelection.create(selection.map(([a,b]) => EditorSelection.range(a,b))) : selection, extensions});
  if (editors[index]) editors[index].setState(state);
  else editors[index] = new EditorView({state, parent: document.getElementById(index ? 'two' : 'one')});
  editors[index].focus(); transactions.length = 0;
};
window.historyAction = (index, action) => (action === 'undo' ? undo : redo)(editors[index]);
resetEditor(1, 'SECOND', {anchor: 0}); resetEditor(0, 'abcdef', {anchor: 3}); window.ready = true;
` } }).outputFiles[0].contents;
const server = http.createServer((req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fixture); return; }
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/editor') {
    res.end('<!doctype html><div id="one"></div><div id="two"></div><script src="/fixture.js"></script>');
  } else {
    res.end(`<!doctype html><textarea id="outside">OUTSIDE</textarea><iframe src="http://localhost:${server.address().port}/editor" style="width:900px;height:600px"></iframe>`);
  }
});
(async () => {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  let context;
  try {
    context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
      headless: true, channel: 'chrome', ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging'] });
    const cdp = await context.browser().newBrowserCDPSession();
    await cdp.send('Extensions.loadUnpacked', { path: extension });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const editor = page.frame({ url: /\/editor$/ });
    await editor.waitForFunction(() => window.ready);
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url?.startsWith('http://127.0.0.1:')).id);
    const frames = await worker.evaluate(tabId => frameRouter.prepare(tabId), tabId);
    const editorFrame = frames.available.find(frame => frame.url.endsWith('/editor'));
    const route = message => worker.evaluate(({ tabId, message }) => frameRouter.route(tabId, message), { tabId, message });
    const isolated = (operation, args = []) => worker.evaluate(async ({ tabId, documentId, operation, args }) => {
      const result = await chrome.scripting.executeScript({ target: { tabId, documentIds: [documentId] }, world: 'ISOLATED',
        func: async (operation, args) => {
          if (operation === 'setup') { pasteTyper.pauseChance = 0; return; }
          if (operation === 'adapterName') return adapterManager.getAdapter().constructor.name;
          if (operation === 'metadata') return typeof document.querySelector('.cm-content').cmView;
          if (operation === 'locked') return new CodeMirrorAdapter().typeCharacter(document.querySelector('#one .cm-content'), 'X');
          if (operation === 'removed') return new CodeMirrorAdapter().typeCharacter(targetTracker.element, 'X');
          const adapter = adapterManager.getAdapter();
          const { element } = await adapter.getTarget();
          if (operation === 'type') return adapter.typeCharacter(element, args[0]);
          if (operation === 'backspace') return adapter.simulateBackspace(element);
          if (operation === 'clear') return adapter.reset(element);
        }, args: [operation, args] });
      return result[0]?.result;
    }, { tabId, documentId: editorFrame.documentId, operation, args });
    await isolated('setup');
    assert.equal(await isolated('adapterName'), 'CodeMirrorAdapter');
    assert.equal(await isolated('metadata'), 'undefined',
      'page editor metadata must not be assumed visible in the isolated world');
    const read = () => editor.evaluate(() => editors.map(view => ({ text: view.state.doc.toString(), selection: view.state.selection.toJSON() })));
    const reset = async (index, text, selection, options) => {
      await editor.evaluate(args => resetEditor(...args), [index, text, selection, options]);
      await editor.locator(`#${index ? 'two' : 'one'} .cm-content`).focus();
    };
    const waitDone = async expectedError => {
      for (let i = 0; i < 300; i++) {
        const progress = await route({ action: 'getTypingProgress' });
        if (!progress.isTyping) {
          if (expectedError) assert.match(progress.error, expectedError); else assert.equal(progress.error, null);
          return progress;
        }
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('typing timed out');
    };
    const start = async text => {
      const result = await route({ action: 'startTyping', text, speed: 10, typoChance: 0, targetElement: true });
      assert.equal(result.success, true, result.error); await waitDone();
    };
    const direct = (operation, text) => isolated(operation, [text]);
    await start('XYZ');
    assert.deepEqual((await read()).map(item => item.text), ['abcXYZdef', 'SECOND']);
    assert.equal((await read())[0].selection.ranges[0].anchor, 6);
    assert.equal(await page.locator('#outside').inputValue(), 'OUTSIDE');
    assert.deepEqual(await editor.evaluate(() => transactions.map(tr => tr.changes[0].text)), ['X', 'Y', 'Z']);
    assert.ok(await editor.evaluate(() => transactions.every(tr => tr.event === 'input.type')));
    assert.equal(await editor.evaluate(() => historyAction(0, 'undo')), true);
    assert.equal((await read())[0].text, 'abcdef');
    assert.equal((await read())[0].selection.ranges[0].anchor, 3);
    assert.equal(await editor.evaluate(() => historyAction(0, 'redo')), true);
    assert.equal((await read())[0].text, 'abcXYZdef');
    console.log('PASS engine types one transaction per character in selected cross-origin editor; Undo/Redo preserve model and caret');

    await reset(0, 'abcdef', { anchor: 3 }, { widgets: true });
    for (const [selector, initial] of [['#widget-input', 'INPUT'], ['#widget-textarea', 'TEXTAREA'], ['#widget-rich', 'RICH']]) {
      await editor.locator(selector).click();
      if (selector === '#widget-rich') {
        await editor.locator(selector).evaluate(element => {
          const range = document.createRange(); range.selectNodeContents(element); range.collapse(true);
          const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range); element.focus();
        });
      } else await editor.locator(selector).press('Home');
      assert.equal(await isolated('adapterName'), 'StandardInputAdapter', selector + ' ' + JSON.stringify(
        await editor.locator(selector).evaluate(element => ({ active: document.activeElement.id, editable: element.isContentEditable,
          nearest: element.closest('input, textarea, select, [contenteditable]')?.id }))));
      await start('X');
      const value = await editor.locator(selector).evaluate(element => element.value ?? element.textContent);
      assert.equal(value, 'X' + initial);
      assert.deepEqual((await read()).map(item => item.text), ['abcdef', 'SECOND']);
    }
    console.log('PASS independent native and contenteditable widget inputs retain their adapter and never edit the CodeMirror model');

    await reset(0, 'a😀bc', { anchor: 4, head: 1 });
    assert.equal((await direct('type', '界')).success, true);
    assert.deepEqual((await read()).map(item => item.text), ['a界c', 'SECOND']);
    assert.equal((await read())[0].selection.ranges[0].anchor, 2);
    assert.equal((await direct('type', '😀')).success, true);
    assert.equal((await read())[0].text, 'a界😀c');
    assert.equal((await read())[0].selection.ranges[0].anchor, 4);
    assert.equal((await direct('backspace')).success, true);
    assert.equal((await read())[0].text, 'a界c');
    assert.equal(await editor.evaluate(() => transactions.at(-1).event), 'delete.backward');
    await start('\n\tcode\n');
    assert.equal((await read())[0].text, 'a界\n\tcode\nc');
    console.log('PASS reversed range replacement, full Unicode code points, UTF-16 offsets, backspace and literal newline/tab');

    await reset(0, 'LR', { anchor: 1 });
    for (const text of ['e\u0301', '👩‍👩‍👧‍👦', 'a' + '\u0301'.repeat(80)]) {
      assert.equal((await direct('type', text)).success, true);
    }
    assert.equal((await read())[0].text, 'Le\u0301👩‍👩‍👧‍👦a' + '\u0301'.repeat(80) + 'R');
    assert.deepEqual(await editor.evaluate(() => transactions.map(tr => tr.changes[0].text)),
      ['e\u0301', '👩‍👩‍👧‍👦', 'a' + '\u0301'.repeat(80)]);
    assert.equal((await direct('backspace')).success, true);
    assert.equal((await read())[0].text, 'Le\u0301👩‍👩‍👧‍👦R');
    console.log('PASS combining, ZWJ and long graphemes stay intact in one transaction with native backspace');

    await reset(0, 'abcd', [[1, 1], [3, 3]]);
    assert.equal((await direct('type', 'Q')).success, true);
    assert.equal((await read())[0].text, 'aQbcQd');
    assert.deepEqual((await read())[0].selection.ranges.map(range => range.anchor), [2, 5]);
    assert.equal((await direct('backspace')).success, true);
    assert.equal((await read())[0].text, 'abcd');
    console.log('PASS multiple native selections retain CodeMirror typing semantics');

    await reset(0, 'one\r\ntwo', { anchor: 3 }, { lineBreak: '\r\n' });
    assert.equal((await direct('type', '\n')).success, true);
    assert.equal((await read())[0].text, 'one\n\ntwo');
    await direct('clear');
    assert.equal((await read())[0].text, '');
    assert.equal(await editor.evaluate(() => historyAction(0, 'undo')), true);
    assert.equal((await read())[0].text, 'one\n\ntwo');
    console.log('PASS configured line separators and explicit Clear remain undoable');

    for (const options of [{ readOnly: true }, { editable: false }]) {
      await reset(0, 'LOCKED', { anchor: 2 }, options);
      const result = await isolated('locked');
      assert.equal(result.success, false);
      assert.match(result.error, /editable/);
      assert.equal((await read())[0].text, 'LOCKED');
    }
    await reset(0, 'FILTERED', { anchor: 2 }, { reject: true });
    assert.equal((await direct('type', 'X')).success, false);
    assert.equal((await read())[0].text, 'FILTERED');
    const rejected = await route({ action: 'startTyping', text: 'X', speed: 10, typoChance: 0, targetElement: true });
    assert.equal(rejected.success, true, rejected.error);
    const failedProgress = await waitDone(/did not accept/);
    assert.equal(failedProgress.position, 0);
    console.log('PASS read-only, non-editable and transaction-filter rejection report failure without corrupting model');

    await reset(0, 'abc', { anchor: 1 });
    await editor.evaluate(() => { window.originalDispatch = editors[0].dispatch; editors[0].dispatch = () => {}; });
    assert.equal((await direct('type', 'X')).success, false);
    assert.equal((await read())[0].text, 'abc');
    await editor.evaluate(() => { editors[0].dispatch = () => { throw Error('interrupted dispatch'); }; });
    const interrupted = await direct('type', 'X');
    assert.equal(interrupted.success, false); assert.match(interrupted.error, /interrupted dispatch/);
    assert.equal(await editor.locator('[data-paste-typer-target]').count(), 0);
    await editor.evaluate(() => { editors[0].dispatch = originalDispatch; });
    console.log('PASS ignored or throwing dispatch fails and removes temporary target marker');

    for (const mode of ['restore', 'rewrite', 'remove']) {
      await reset(0, 'abc', { anchor: 1 });
      await editor.evaluate(mode => {
        const view = editors[0]; window.hostDispatch = view.dispatch;
        view.dispatch = (...specs) => {
          const before = view.state; hostDispatch(...specs);
          if (!view.state.doc.eq(before.doc)) queueMicrotask(() => {
            if (mode === 'restore') view.setState(before);
            if (mode === 'rewrite') view.setState(makeHostState('HOST'));
            if (mode === 'remove') view.dom.remove();
          });
        };
      }, mode);
      const result = await direct('type', 'X');
      assert.equal(result.success, false, mode + ' must not report accepted input');
      if (mode === 'restore') {
        const started = await route({ action: 'startTyping', text: 'X', speed: 10, typoChance: 0, targetElement: true });
        assert.equal(started.success, true, started.error);
        assert.equal((await waitDone(/did not accept/)).position, 0);
      }
      assert.equal((await read())[0].text, mode === 'restore' ? 'abc' : mode === 'rewrite' ? 'HOST' : 'aXbc');
      assert.equal((await read())[1].text, 'SECOND');
      assert.equal(await editor.locator('[data-paste-typer-target]').count(), 0);
      await editor.evaluate(() => {
        editors[0].dispatch = hostDispatch;
        if (!editors[0].dom.isConnected) document.getElementById('one').appendChild(editors[0].dom);
      });
    }
    await reset(0, 'abc', { anchor: 1 });
    console.log('PASS queued host restoration, rewriting and target removal report failure after dispatch settles');

    await editor.evaluate(() => {
      const content = editors[0].contentDOM;
      window.metadataKey = content.cmTile ? 'cmTile' : 'cmView';
      window.savedMetadata = content[metadataKey];
      content[metadataKey] = editors[1].contentDOM[metadataKey];
    });
    assert.equal((await direct('type', 'X')).success, false);
    assert.deepEqual((await read()).map(item => item.text), ['abc', 'SECOND']);
    await editor.evaluate(() => { delete editors[0].contentDOM[metadataKey]; });
    assert.equal((await direct('type', 'X')).success, false);
    await editor.evaluate(() => { editors[0].contentDOM[metadataKey] = savedMetadata; });
    await editor.evaluate(() => {
      window.duplicateMarker = new MutationObserver(() => {
        const token = editors[0].contentDOM.getAttribute('data-paste-typer-target');
        if (token) editors[1].contentDOM.setAttribute('data-paste-typer-target', token);
      });
      duplicateMarker.observe(editors[0].contentDOM, { attributes: true, attributeFilter: ['data-paste-typer-target'] });
    });
    assert.equal((await direct('type', 'X')).success, false);
    assert.deepEqual((await read()).map(item => item.text), ['abc', 'SECOND']);
    await editor.evaluate(() => { duplicateMarker.disconnect(); editors[1].contentDOM.removeAttribute('data-paste-typer-target'); });
    console.log('PASS stale/missing editor metadata and ambiguous target tokens fail without editing another model');

    await page.evaluate(() => {
      for (const action of ['ptCodeMirrorInput', 'ptRoute', 'startTyping']) {
        window.postMessage({ action, operation: 'type', text: 'FORGED', token: 'forged', frameId: 1 }, '*');
        window.dispatchEvent(new CustomEvent(action, { detail: { text: 'FORGED' } }));
      }
    });
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.deepEqual((await read()).map(item => item.text), ['abc', 'SECOND']);
    console.log('PASS page messages and forged DOM events cannot invoke extension bridge or another editor');

    // Popup focus and floating controls must retain the model selection.
    await reset(1, 'SECOND', { anchor: 1, head: 5 });
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${worker.url().split('/')[2]}/popup.html`);
    await route({ action: 'startTyping', text: 'P', speed: 10, typoChance: 0, targetElement: true });
    await waitDone(); await popup.close();
    assert.deepEqual((await read()).map(item => item.text), ['abc', 'SPD']);
    await route({ action: 'toggleFloatingUI' });
    await page.locator('#paste-typer-floating-ui').locator('#textInput').fill('F');
    await page.locator('#paste-typer-floating-ui').locator('#typoChanceSlider').fill('0');
    await page.locator('#paste-typer-floating-ui').locator('#startTyping').click();
    await page.locator('#paste-typer-floating-ui').locator('#status').filter({ hasText: 'Typing started!' }).waitFor();
    await waitDone(); assert.deepEqual((await read()).map(item => item.text), ['abc', 'SPFD']);
    console.log('PASS popup focus and trusted floating UI preserve selected editor/model selection');
    const cleared = await route({ action: 'resetTyping' });
    assert.equal(cleared.success, true, cleared.error);
    assert.deepEqual((await read()).map(item => item.text), ['abc', '']);
    assert.equal(await editor.evaluate(() => transactions.at(-1).event), 'delete.selection');
    assert.equal(await editor.evaluate(() => historyAction(1, 'undo')), true);
    assert.equal((await read())[1].text, 'SPFD');
    console.log('PASS routed Clear uses CodeMirror transactions and stays undoable');

    await reset(0, 'STOP', { anchor: 4 });
    await route({ action: 'startTyping', text: 'x'.repeat(100), speed: 15, typoChance: 0, targetElement: true });
    await editor.waitForFunction(() => editors[0].state.doc.length > 4);
    await route({ action: 'stopTyping' });
    const stopped = (await read())[0].text;
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.equal((await read())[0].text, stopped);
    await editor.evaluate(() => editors[0].dom.remove());
    const removed = await isolated('removed');
    assert.equal(removed.success, false);
    assert.equal((await read())[1].text, 'SPFD');
    console.log('PASS Stop and removed editor never redirect input to unrelated editor');
    console.log('CodeMirror integration passed');
  } finally {
    if (context) await context.close();
    await new Promise(resolve => server.close(resolve));
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
