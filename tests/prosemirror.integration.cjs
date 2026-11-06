// Optional real-editor check. Dependencies belong in a temporary directory,
// never in the extension (see CONTRIBUTING.md).
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const dependencies = process.env.PT_TEST_DEPS;
if (!dependencies) throw new Error('Set PT_TEST_DEPS to the test-only dependency directory.');
const { chromium } = require(path.join(dependencies, 'node_modules/playwright'));
const esbuild = require(path.join(dependencies, 'node_modules/esbuild'));
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-typer-prosemirror-'));
const extension = path.join(scratch, 'extension');
fs.mkdirSync(extension);
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && /\.(js|html|json|png)$/.test(entry.name)) {
    fs.copyFileSync(path.join(root, entry.name), path.join(extension, entry.name));
  }
}
fs.cpSync(path.join(root, 'content'), path.join(extension, 'content'), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
manifest.host_permissions = ['http://127.0.0.1/*', 'http://localhost/*']; // Disposable test copy only.
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
const fixture = esbuild.buildSync({
  stdin: { contents: `
    import { EditorState, TextSelection, AllSelection, Plugin } from 'prosemirror-state';
    import { EditorView } from 'prosemirror-view';
    import { schema } from 'prosemirror-schema-basic';
    import { history, undo, redo } from 'prosemirror-history';
    import { baseKeymap } from 'prosemirror-commands';
    import { keymap } from 'prosemirror-keymap';
    window.views = [];
    window.events = [];
    window.transactions = [];
    window.options = {};
    window.commandCalls = 0;
    const nativeCommand = document.execCommand.bind(document);
    document.execCommand = (...args) => { commandCalls++; return nativeCommand(...args); };
    window.setup = (from = 4, to = 7, code = false, heading = false) => {
      for (const view of views) view.destroy();
      views.length = 0; events.length = 0; transactions.length = 0;
      window.options = {};
      window.commandCalls = 0;
      for (const id of ['one', 'two']) {
        const doc = schema.node('doc', null, id === 'one' ? [
          code ? schema.node('code_block', null, schema.text('abcDEFghi')) :
            schema.node(heading ? 'heading' : 'paragraph', heading ? { level: 1 } : null, [schema.text('abc'), schema.text('DEF', [schema.marks.strong.create()]), schema.text('ghi')]),
          schema.node('horizontal_rule'),
          schema.node('paragraph', null, schema.text('KEEP'))
        ] : [schema.node('paragraph', null, schema.text('SECOND'))]);
        const view = new EditorView(document.getElementById(id), {
          state: EditorState.create({ doc, plugins: [
            new Plugin({ filterTransaction: tr => !options.reject || !tr.docChanged }),
            history(), keymap(baseKeymap)
          ] }),
          editable: () => !options.readOnly,
          nodeViews: { horizontal_rule: () => {
            const dom = document.createElement('span'); dom.contentEditable = 'false';
            const input = document.createElement('input'); input.id = 'nested'; input.value = 'WIDGET';
            dom.appendChild(input); return { dom };
          } },
          handleTextInput: (view, from, to, text) => {
            if (options.augmentText) { view.dispatch(view.state.tr.insertText(text + '!', from, to)); return true; }
            if (options.rejectText) return true;
          },
          handleKeyDown: (view, event) => {
            if (options.augmentEnter && event.key === 'Enter') { view.dispatch(view.state.tr.insertText('WRONG')); return true; }
            if (options.augmentBackspace && event.key === 'Backspace') { view.dispatch(view.state.tr.insertText('!')); return true; }
            if (options.rejectKey) { event.preventDefault(); return true; }
          },
          handleKeyPress: () => options.rejectPress || false,
          dispatchTransaction(tr) {
            const next = this.state.apply(tr);
            transactions.push({ id, steps: tr.steps.map(step => step.toJSON()), text: next.doc.textBetween(0, next.doc.content.size, '\\n') });
            this.updateState(next);
          }
        });
        for (const type of ['keydown', 'beforeinput', 'input', 'keyup', 'paste']) {
          view.dom.addEventListener(type, event => {
            events.push({ id, type, key: event.key, data: event.data, inputType: event.inputType, trusted: event.isTrusted });
            if (type === 'beforeinput' && options.cancelBeforeInput) event.preventDefault();
            if (type === 'beforeinput' && options.redirectBeforeInput) {
              const other = views[1];
              other.dispatch(other.state.tr.setSelection(TextSelection.create(other.state.doc, 7)));
              other.focus();
            }
            if (type === 'beforeinput' && options.beforeInputEdit) document.execCommand('insertText', false, event.data);
            if (type === 'input' && options.restoreMicrotask) queueMicrotask(() => views[0].updateState(savedState));
            if (type === 'input' && options.removeMicrotask) queueMicrotask(() => views[0].dom.remove());
            if (type === 'keyup' && options.restoreKeyupMicrotask) queueMicrotask(() => views[0].updateState(savedState));
          });
        }
        views.push(view);
      }
      const view = views[0];
      view.dispatch(view.state.tr.setSelection(from === 0 && to === view.state.doc.content.size
        ? new AllSelection(view.state.doc) : TextSelection.create(view.state.doc, from, to)));
      window.savedState = view.state;
      view.focus();
      document.dispatchEvent(new Event('selectionchange'));
    };
    window.read = () => views.map(view => ({
      doc: view.state.doc.toJSON(), text: view.state.doc.textBetween(0, view.state.doc.content.size, '\\n'),
      selection: { from: view.state.selection.from, to: view.state.selection.to },
      html: view.dom.innerHTML
    }));
    window.undo = () => undo(views[0].state, views[0].dispatch);
    window.redo = () => redo(views[0].state, views[0].dispatch);
    setup();
    window.ready = true;
  `, resolveDir: dependencies }, bundle: true, write: false, format: 'iife'
}).outputFiles[0].text;
const server = http.createServer((req, res) => {
  if (req.url === '/fixture.js') { res.setHeader('Content-Type', 'text/javascript'); res.end(fixture); return; }
  res.setHeader('Content-Type', 'text/html');
  if (req.url === '/editor') {
    res.end('<div id="one"></div><div id="two"></div><script src="/fixture.js"></script>');
  } else {
    res.end(`<textarea id="outside">OUTSIDE</textarea><iframe src="http://localhost:${server.address().port}/editor" style="width:900px;height:600px"></iframe>`);
  }
});

(async () => {
  let context;
  try {
    await new Promise(resolve => server.listen(0, resolve));
    context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
      headless: true, channel: 'chrome', ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging']
    });
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
    const worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${server.address().port}/`);
    const editor = page.frame({ url: /\/editor$/ });
    await editor.waitForFunction(() => window.ready);
    const tabId = await worker.evaluate(async () => (await chrome.tabs.query({})).find(tab => tab.url?.startsWith('http://127.0.0.1:')).id);
    const frames = await worker.evaluate(tabId => frameRouter.prepare(tabId), tabId);
    const editorDocumentId = frames.available.find(frame => /\/editor$/.test(frame.url)).documentId;
    const route = message => worker.evaluate(({ tabId, message }) => frameRouter.route(tabId, message), { tabId, message });
    const progress = async (wantError = false) => {
      for (let i = 0; i < 160; i++) {
        const state = await route({ action: 'getTypingProgress' });
        if (!state.isTyping) {
          if (wantError) assert.ok(state.error); else assert.equal(state.error, null);
          return state;
        }
        await new Promise(resolve => setTimeout(resolve, 25));
      }
      throw new Error('Typing timed out');
    };
    const setup = async (from = 4, to = 7, code = false, heading = false) => {
      await page.bringToFront();
      await editor.evaluate(({ from, to, code, heading }) => setup(from, to, code, heading), { from, to, code, heading });
    };
    const start = text => route({ action: 'startTyping', text, speed: 1, typoChance: 0, targetElement: true });
    const read = () => editor.evaluate(() => read());
    const directInput = (text, operation = 'type') => worker.evaluate(async ({ tabId, editorDocumentId, text, operation }) => {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId, documentIds: [editorDocumentId] }, world: 'ISOLATED',
        func: async (text, operation) => {
          const element = document.querySelector('#one .ProseMirror');
          const adapter = adapterManager.getAdapter(element);
          return operation === 'backspace' ? adapter.simulateBackspace(element) : adapter.typeCharacter(element, text);
        }, args: [text, operation]
      });
      return result.result;
    }, { tabId, editorDocumentId, text, operation });
    const verifyUnrelated = async () => {
      const values = await read();
      assert.equal(values[1].text, 'SECOND');
      assert.equal(await page.locator('#outside').inputValue(), 'OUTSIDE');
      assert.deepEqual(values[0].doc.content.slice(-2), [{ type: 'horizontal_rule' }, { type: 'paragraph', content: [{ type: 'text', text: 'KEEP' }] }]);
    };

    await setup();
    const original = (await read())[0].doc;
    await start('X\nY'); await progress();
    let values = await read();
    assert.equal(values[0].text, 'abcX\nYghi\nKEEP');
    assert.equal(values[0].doc.content[0].type, 'paragraph');
    assert.equal(values[0].doc.content[1].type, 'paragraph');
    assert.deepEqual(await editor.evaluate(() => transactions.filter(tr => tr.id === 'one' && tr.steps.length).map(tr => tr.text)),
      ['abcXghi\nKEEP', 'abcX\nghi\nKEEP', 'abcX\nYghi\nKEEP']);
    const inputEvents = await editor.evaluate(() => events.filter(event => event.type === 'input'));
    assert.deepEqual(inputEvents.map(event => event.data), ['X', 'Y']);
    assert.ok(inputEvents.every(event => event.trusted));
    assert.deepEqual(await editor.evaluate(() => events.filter(event => event.type === 'keydown').map(event => event.key)), ['X', 'Enter', 'Y']);
    assert.deepEqual(await editor.evaluate(() => events.filter(event => event.type === 'keyup').map(event => event.key)), ['X', 'Enter', 'Y']);
    assert.equal(await editor.evaluate(() => events.filter(event => event.type === 'paste').length), 0);
    await editor.evaluate(() => views[0].updateState(views[0].state));
    assert.deepEqual((await read())[0].doc, values[0].doc);
    await verifyUnrelated();
    assert.equal(await editor.evaluate(() => undo()), true);
    assert.deepEqual((await read())[0].doc, original);
    assert.equal(await editor.evaluate(() => redo()), true);
    assert.deepEqual((await read())[0].doc, values[0].doc);
    console.log('PASS real ProseMirror: range replacement, paragraph newline, redraw persistence, undo/redo, unrelated nodes/editors/frame');

    await setup(4, 4);
    await route({ action: 'toggleFloatingUI' });
    const panel = page.locator('#paste-typer-floating-ui');
    await panel.locator('#textInput').fill('中Z');
    await panel.locator('#typoChanceSlider').fill('0');
    await panel.locator('#startTyping').click();
    await progress();
    assert.equal((await read())[0].text, 'abc中ZDEFghi\nKEEP');
    assert.deepEqual((await read())[0].doc.content[0].content.find(node => node.text === 'DEF'),
      { type: 'text', marks: [{ type: 'strong' }], text: 'DEF' });
    await verifyUnrelated();
    console.log('PASS floating controls preserve the ProseMirror caret and CJK text');

    await setup(4, 4, true);
    await start('\tX\nY'); await progress();
    assert.equal((await read())[0].text, 'abc\tX\nYDEFghi\nKEEP');
    assert.equal((await read())[0].doc.content[0].type, 'code_block');
    await verifyUnrelated();
    console.log('PASS code blocks retain literal tabs/newlines');

    await setup(10, 10, false, true);
    await start('\nZ'); await progress();
    assert.equal((await read())[0].text, 'abcDEFghi\nZ\nKEEP');
    assert.equal((await read())[0].doc.content[0].type, 'heading');
    assert.equal((await read())[0].doc.content[1].type, 'paragraph');
    await verifyUnrelated();
    console.log('PASS Enter at the end of a heading follows the normal new-paragraph binding');

    await setup(4, 4);
    const beforeTab = (await read())[0].doc;
    await start('\t'); await progress(true);
    assert.deepEqual((await read())[0].doc, beforeTab);
    console.log('PASS paragraph tab is refused before ProseMirror can normalize it to a space');

    await setup(4, 4);
    assert.equal((await directInput('👨‍👩‍👦')).success, true);
    assert.equal((await read())[0].text, 'abc👨‍👩‍👦DEFghi\nKEEP');
    assert.equal((await directInput('', 'backspace')).success, true);
    assert.equal((await read())[0].text, 'abcDEFghi\nKEEP');
    console.log('PASS adapter accepts a complete grapheme and native Backspace deletes it (engine Unicode iteration is separate)');

    await setup(4, 4);
    const longGrapheme = 'a' + '\u0301'.repeat(160);
    assert.equal((await directInput(longGrapheme)).success, true);
    assert.equal((await read())[0].text, 'abc' + longGrapheme + 'DEFghi\nKEEP');
    assert.equal(await editor.evaluate(() => transactions.filter(tr => tr.id === 'one' && tr.steps.length).length), 1);
    assert.equal(await editor.evaluate(() => commandCalls), 1);
    await verifyUnrelated();
    console.log('PASS a single grapheme longer than 128 UTF-16 code units commits intact once');

    await setup(7, 7);
    await editor.evaluate(() => { options.augmentBackspace = true; });
    assert.equal((await directInput('', 'backspace')).success, false);
    assert.equal((await read())[0].text, 'abcDEF!ghi\nKEEP');
    await verifyUnrelated();
    console.log('PASS a transformed Backspace is reported instead of treating it as a successful typo deletion');

    await setup();
    const popup = await context.newPage();
    await popup.goto(`chrome-extension://${id}/popup.html`);
    await popup.evaluate(tabId => { chrome.tabs.query = async () => [{ id: tabId }]; }, tabId);
    await popup.locator('#textInput').fill('XYZ');
    await popup.locator('#typoChanceSlider').fill('0');
    await popup.locator('#startTyping').click();
    await progress();
    assert.equal((await read())[0].text, 'abcXYZghi\nKEEP');
    await verifyUnrelated();
    await popup.close();
    console.log('PASS popup preserves the selected ProseMirror range');

    await setup(4, 15);
    await start('X'); await progress();
    assert.equal((await read())[0].text, 'abcXEP');
    assert.equal((await read())[1].text, 'SECOND');
    console.log('PASS a cross-block selection is replaced once when ProseMirror handles keypress itself');

    await setup(4, 15, false, true);
    await start('X'); await progress();
    assert.equal((await read())[0].text, 'abcXEP');
    assert.equal((await read())[0].doc.content[0].type, 'heading');
    assert.equal((await read())[1].text, 'SECOND');
    console.log('PASS cross-block replacement preserves text/marks while adopting the start heading wrapper');

    await setup(0, 18);
    await start('X'); await progress();
    assert.equal((await read())[0].text, 'X');
    assert.equal((await read())[1].text, 'SECOND');
    console.log('PASS a full-document selection is replaced once with the schema-required paragraph');

    await setup();
    const clearBefore = (await read())[0].doc;
    const cleared = await route({ action: 'resetTyping' });
    assert.equal(cleared.success, true);
    assert.equal((await read())[0].text, '');
    assert.equal((await read())[1].text, 'SECOND');
    assert.equal(await editor.evaluate(() => undo()), true);
    assert.deepEqual((await read())[0].doc, clearBefore);
    console.log('PASS explicit Clear uses browser deletion and remains undoable');

    for (const option of ['rejectText', 'rejectKey', 'rejectPress', 'reject', 'cancelBeforeInput', 'redirectBeforeInput']) {
      await setup();
      const before = (await read())[0].doc;
      await editor.evaluate(option => { options[option] = true; }, option);
      await start('XYZ');
      const state = await progress(true);
      assert.equal(state.position, 0);
      assert.deepEqual((await read())[0].doc, before);
      await verifyUnrelated();
      console.log(`PASS ${option}: rejected character stops progress without retry/fallback`);
    }
    await setup(4, 5);
    await editor.evaluate(() => { options.rejectText = true; });
    assert.equal((await directInput('D')).success, false);
    assert.deepEqual((await read())[0].selection, { from: 4, to: 5 });
    console.log('PASS an identical selected character is still rejected when its input hook rejects it');

    await setup(4, 5);
    assert.equal((await directInput('D')).success, true);
    assert.deepEqual((await read())[0].selection, { from: 5, to: 5 });
    console.log('PASS accepted identical replacement collapses the selected range');

    for (const [option, text, expected] of [['augmentText', 'XYZ', 'abcX!ghi\nKEEP'], ['augmentEnter', '\nY', 'abcWRONGghi\nKEEP']]) {
      await setup();
      await editor.evaluate(option => { options[option] = true; }, option);
      await start(text);
      assert.equal((await progress(true)).position, 0);
      assert.equal((await read())[0].text, expected);
      await verifyUnrelated();
      console.log(`PASS ${option}: site transformation is reported and no further source characters are sent`);
    }
    for (const reject of [false, true]) {
      await setup();
      await editor.evaluate(reject => { options.beforeInputEdit = true; options.rejectText = reject; }, reject);
      await start('X'); await progress(reject);
      assert.equal(await editor.evaluate(() => commandCalls), 1);
      assert.equal((await read())[0].text, reject ? 'abcDEFghi\nKEEP' : 'abcXghi\nKEEP');
      await verifyUnrelated();
      console.log(`PASS page-owned beforeinput edit is never duplicated or retried (rejected=${reject})`);
    }
    for (const option of ['restoreMicrotask', 'restoreKeyupMicrotask', 'removeMicrotask']) {
      await setup();
      const previous = (await read())[0].doc;
      await editor.evaluate(option => { options[option] = true; }, option);
      await start('XYZ');
      assert.equal((await progress(true)).position, 0);
      if (option === 'removeMicrotask') assert.equal((await read())[0].text, 'abcXghi\nKEEP');
      else assert.deepEqual((await read())[0].doc, previous);
      await verifyUnrelated();
      console.log(`PASS ${option}: queued host changes are verified before reporting character acceptance`);
    }
    await setup();
    const before = (await read())[0].doc;
    await editor.evaluate(() => { options.readOnly = true; views[0].setProps({ editable: () => false }); });
    const readOnlyResult = await start('X');
    assert.equal(readOnlyResult.success, false);
    assert.match(readOnlyResult.error, /editable|editor/i);
    assert.deepEqual((await read())[0].doc, before);
    console.log('PASS read-only editor is not modified');

    await setup();
    const removedBefore = (await read())[0].doc;
    await start('XYZ');
    await editor.evaluate(() => views[0].dom.remove());
    await progress(true);
    assert.deepEqual((await read())[0].doc, removedBefore);
    assert.equal((await read())[1].text, 'SECOND');
    console.log('PASS removed editor stops without falling back to another editor');

    await setup();
    await editor.evaluate(() => {
      const fake = document.createElement('div');
      fake.className = 'ProseMirror'; fake.contentEditable = 'true'; fake.textContent = 'FAKE';
      document.body.appendChild(fake); fake.focus();
      const range = document.createRange(); range.selectNodeContents(fake); range.collapse(false);
      const selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      document.dispatchEvent(new Event('selectionchange'));
    });
    await start('X'); await progress(true);
    assert.equal(await editor.locator('body > .ProseMirror').textContent(), 'FAKE');
    await verifyUnrelated();
    console.log('PASS a CSS-only lookalike is refused before any edit');

    await editor.locator('body > .ProseMirror').evaluate(element => element.remove());
    await setup();
    const widgetBefore = (await read())[0].doc;
    await editor.locator('#nested').focus();
    await editor.locator('#nested').evaluate(element => element.setSelectionRange(3, 3));
    await start('X'); await progress();
    assert.equal(await editor.locator('#nested').inputValue(), 'WIDXGET');
    assert.deepEqual((await read())[0].doc, widgetBefore);
    await verifyUnrelated();
    console.log('PASS nested form fields use the standard adapter and do not edit their enclosing document');
  } finally {
    await context?.close(); server.close(); fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
