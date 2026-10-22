const { test } = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function setup({ denied = false, running = false, partial = false, legacy = false, legacyFrame = 0, helperOnly = false } = {}) {
  const sent = [];
  const injected = [];
  const loaded = new Set(partial ? [0] : legacy ? [legacyFrame] : []);
  const floatingLoaded = new Set(helperOnly ? [0] : []);
  const injectedFiles = [];
  const session = {};
  const listeners = [];
  const frames = [
    { frameId: 0, documentId: 'parent', url: 'https://parent.test/' },
    { frameId: 7, documentId: 'editor', url: 'https://editor.test/' },
    { frameId: 9, documentId: 'advert', url: 'https://advert.test/' }
  ];
  const chrome = {
    storage: { session: { get: async key => ({ [key]: session[key] }),
      set: async values => Object.assign(session, values) } },
    webNavigation: { getAllFrames: async () => frames },
    permissions: { contains: async ({ origins }) => !denied && origins[0] !== 'https://advert.test/*' },
    scripting: { executeScript: async ({ target, files, world }) => {
      assert.equal(world, 'ISOLATED');
      const id = target.frameIds[0];
      if (files) {
        injected.push(id); injectedFiles.push([...files]);
        if (files.includes('content.js')) loaded.add(id);
        if (files.includes('floating-ui.js')) floatingLoaded.add(id);
        return [];
      }
      return [{ result: { hasTyper: loaded.has(id), hasFloating: floatingLoaded.has(id), legacyBridge: legacy && id === legacyFrame } }];
    } },
    tabs: { sendMessage: async (tabId, message, options) => {
      sent.push({ tabId, message, options });
      if (message.action === 'getTargetInfo') return options.frameId === 7
        ? { hasTarget: true, changedAt: 100, isTyping: running, focused: false }
        : { hasTarget: true, changedAt: 1, isTyping: false, focused: false };
      return { success: true };
    } },
    runtime: { onMessage: { addListener(fn) { listeners.push(fn); } } }
  };
  const context = vm.createContext({ chrome, URL, Map, Set, console });
  vm.runInContext(fs.readFileSync(path.join(__dirname, '../frameRouter.js'), 'utf8'), context);
  return { router: vm.runInContext('frameRouter', context), sent, injected, injectedFiles, frames, chrome, listeners,
    restart: () => vm.runInContext('new FrameRouter()', context) };
}

test('Monaco input is confined to the sending content-script document', async () => {
  const { chrome, listeners } = setup();
  let injected;
  chrome.scripting.executeScript = async options => { injected = options; return [{ result: { success: true } }]; };
  const result = await new Promise(resolve => {
    assert.equal(listeners[0]({ action: 'ptMonacoInput', token: 'chosen', text: '{', tabId: 999 },
      { tab: { id: 1 }, documentId: 'editor', url: 'https://editor.test/' }, resolve), true);
  });
  assert.equal(result.success, true);
  assert.equal(injected.world, 'MAIN');
  assert.equal(injected.target.tabId, 1);
  assert.deepEqual([...injected.target.documentIds], ['editor']);
  assert.deepEqual([...injected.args], ['chosen', '{']);
});

test('Monaco input rejects extension pages and malformed payloads', () => {
  const { chrome, listeners } = setup();
  chrome.scripting.executeScript = () => { throw new Error('must not inject'); };
  for (const [request, sender] of [
    [{ action: 'ptMonacoInput', token: 'chosen', text: '{' }, { tab: { id: 1 }, documentId: 'popup', url: 'chrome-extension://id/popup.html' }],
    [{ action: 'ptMonacoInput', token: 'chosen', text: 'whole document' }, { tab: { id: 1 }, documentId: 'editor', url: 'https://editor.test/' }],
    [{ action: 'ptMonacoInput', token: 'chosen', text: '{' }, { tab: { id: 1 }, url: 'https://editor.test/' }]
  ]) assert.equal(listeners[0](request, sender, () => {}), undefined);
});

test('start targets only the most recently selected frame and its document', async () => {
  const { router, sent } = setup();
  await router.route(1, { action: 'startTyping', text: 'abc' });
  assert.deepEqual({ ...sent.at(-1).options }, { documentId: 'editor' });
  assert.equal(sent.filter(s => s.message.action === 'startTyping').length, 1);
});

test('denied cross-origin access is listed, never injected', async () => {
  const { router, injected } = setup({ denied: true });
  const result = await router.prepare(1);
  assert.deepEqual([...result.missingOrigins], ['https://advert.test/*', 'https://editor.test/*']);
  assert.deepEqual(injected, [0]);
});

test('floating controls stay on the top frame, input stays in selected frame', async () => {
  const { router, sent } = setup();
  await router.route(1, { action: 'toggleFloatingUI' });
  assert.deepEqual({ ...sent.at(-1).options }, { documentId: 'parent' });
});

test('progress and stop follow the running session', async () => {
  const { router, sent } = setup({ running: true });
  for (const action of ['getTypingProgress', 'stopTyping', 'pauseTyping', 'resumeTyping']) {
    await router.route(1, { action });
    assert.deepEqual({ ...sent.at(-1).options }, { documentId: 'editor' });
  }
});

test('concurrent injection is deduplicated per frame, subsequent calls check presence', async () => {
  const { router, injected } = setup();
  await Promise.all([router.prepare(1), router.prepare(1), router.prepare(1)]);
  await router.prepare(1);
  assert.deepEqual(injected.sort(), [0, 7]);
});

test('a vanished explicitly selected frame fails instead of typing into the parent', async () => {
  const { router, sent } = setup();
  await assert.rejects(router.route(1, { action: 'startTyping' }, 42), /no longer available/);
  assert.equal(sent.filter(s => s.message.action === 'startTyping').length, 0);
});

test('navigation in a frame causes reinjection into its new document', async () => {
  const { router, injected, chrome } = setup();
  await router.prepare(1);
  const execute = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async args => args.func
    ? [{ result: { hasTyper: false, hasFloating: false, legacyBridge: false } }] : execute(args);
  await router.prepare(1);
  assert.equal(injected.filter(id => id === 7).length, 2);
});

test('removing the remembered frame does not fall back to an older parent input', async () => {
  const { router, frames, sent } = setup();
  await router.route(1, { action: 'getActiveElement' });
  frames.splice(frames.findIndex(frame => frame.frameId === 7), 1);
  await assert.rejects(router.route(1, { action: 'startTyping' }), /removed or navigated/);
  assert.equal(sent.filter(s => s.message.action === 'startTyping').length, 0);
});

test('a second typing session is rejected instead of starting in another editor', async () => {
  const { router, sent } = setup({ running: true });
  await assert.rejects(router.route(1, { action: 'startTyping' }), /already running/);
  assert.equal(sent.filter(s => s.message.action === 'startTyping').length, 0);
});

test('remembered frame survives a service-worker restart', async () => {
  const { router, frames, restart } = setup();
  await router.route(1, { action: 'getActiveElement' });
  frames.splice(frames.findIndex(frame => frame.frameId === 7), 1);
  await assert.rejects(restart().route(1, { action: 'startTyping' }), /removed or navigated/);
});

test('partial content installation loads only the missing isolated controller once', async () => {
  const { router, injectedFiles } = setup({ partial: true });
  await Promise.all([router.ensure(1, 0), router.ensure(1, 0)]);
  await router.ensure(1, 0);
  assert.deepEqual(injectedFiles, [['floating-ui.js']]);
});

test('a transient null probe is retried without injecting into a loaded frame', async () => {
  const { router, chrome, injected } = setup();
  const execute = chrome.scripting.executeScript;
  let probes = 0;
  chrome.scripting.executeScript = async args => {
    if (args.func) return [{ result: ++probes === 1 ? null
      : { hasTyper: true, hasFloating: true, legacyBridge: false } }];
    return execute(args);
  };
  await router.ensure(1, 0);
  assert.equal(probes, 2);
  assert.equal(injected.length, 0);
});

test('missing or malformed probes require refresh without injecting or sending commands', async () => {
  for (const response of [[], [null], [{ result: null }], [{ result: {} }],
    [{ result: { hasTyper: true, hasFloating: true } }]]) {
    const { router, chrome, injected, sent } = setup();
    chrome.scripting.executeScript = async args => {
      assert.ok(args.func, 'must not reinject when installation state is unknown');
      return response;
    };
    await assert.rejects(router.route(1, { action: 'startTyping', text: 'must not type' }),
      /Reload the extension and refresh/);
    assert.equal(injected.length, 0);
    assert.equal(sent.filter(command => command.message.action === 'startTyping').length, 0);
  }
});

test('the actual probe handles a failed content initializer without throwing', async () => {
  const { router, chrome, sent } = setup();
  const isolated = vm.createContext({});
  assert.throws(() => vm.runInContext('const pasteTyper = (() => { throw Error("initialization failed"); })()', isolated));
  chrome.scripting.executeScript = async ({ func }) => {
    assert.equal(typeof func, 'function', 'must not redeclare failed content scripts');
    const result = vm.runInContext(`(${func.toString()})()`, isolated);
    assert.equal(result.initializationFailed, true);
    return [{ result }];
  };
  await assert.rejects(router.ensure(1, 0), /Reload the extension and refresh/);
  assert.equal(sent.length, 0);
});

test('a retry that discovers a legacy bridge still blocks typing', async () => {
  const { router, chrome, sent } = setup();
  let probes = 0;
  chrome.scripting.executeScript = async ({ func }) => {
    assert.equal(typeof func, 'function');
    return [{ result: ++probes === 1 ? null
      : { hasTyper: true, hasFloating: true, legacyBridge: true } }];
  };
  await assert.rejects(router.ensure(1, 0), /Reload the extension and refresh/);
  assert.equal(probes, 2);
  assert.equal(sent.length, 0);
});

test('an unverifiable child installation cannot redirect typing to the parent', async () => {
  const { router, chrome, sent } = setup();
  const execute = chrome.scripting.executeScript;
  chrome.scripting.executeScript = async args => args.func && args.target.frameIds[0] === 7
    ? [{ result: null }] : execute(args);
  await assert.rejects(router.route(1, { action: 'startTyping', text: 'must not type' }),
    /Reload the extension and refresh/);
  assert.equal(sent.filter(command => command.message.action === 'startTyping').length, 0);
});

test('a preloaded controller is not redeclared during full content installation', async () => {
  const { router, injectedFiles } = setup({ helperOnly: true });
  await router.ensure(1, 0);
  assert.ok(injectedFiles[0].includes('content.js'));
  assert.ok(!injectedFiles[0].includes('floating-ui.js'));
});

test('a legacy page-facing bridge requires refresh instead of a silent partial upgrade', async () => {
  const { router, injected, sent } = setup({ legacy: true });
  await assert.rejects(router.ensure(1, 0), /Reload the extension and refresh/);
  assert.equal(injected.length, 0);
  assert.equal(sent.length, 0);
});

test('a legacy bridge in a child frame blocks routing instead of falling back to another origin', async () => {
  const { router, sent } = setup({ legacy: true, legacyFrame: 7 });
  await assert.rejects(router.route(1, { action: 'startTyping', text: 'must not type' }), /Reload the extension and refresh/);
  assert.equal(sent.filter(command => command.message.action === 'startTyping').length, 0);
});
