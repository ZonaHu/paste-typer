// node tests/background.integration.cjs (Node 22+, recent installed Chrome)
// Headful Chrome, disposable profile; no account or external page is opened.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-typer-background-'));
const extension = path.join(scratch, 'extension');
const output = process.env.PT_BACKGROUND_REPORT;
const text = 'PT14 one\nPT14 two\nPT14 end';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const report = { capturedAt: new Date().toISOString(), platform: {
  platform: os.platform(), release: os.release(), arch: os.arch()
}, source: text, requestedDelayMs: 40, randomVariation: false, typos: false, cases: [] };

// Direct CDP deliberately avoids Playwright's forced focus/visibility emulation
// and default flags that disable hidden-page timer throttling.
async function connect(url) {
  const socket = new WebSocket(url);
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true });
    socket.addEventListener('error', reject, { once: true });
  });
  let sequence = 0;
  const pending = new Map();
  socket.addEventListener('message', event => {
    const message = JSON.parse(event.data);
    if (message.method === 'Target.detachedFromTarget' || message.method === 'Target.targetDestroyed' ||
        message.method === 'Inspector.detached') {
      (report.protocolEvents ||= []).push(message);
    }
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    clearTimeout(request.timer);
      if (message.error) request.reject(new Error(`${request.method}: ${JSON.stringify(message.error)}`));
    else request.resolve(message.result);
  });
  return {
    close: () => socket.close(),
    send(method, params = {}, sessionId) {
      return new Promise((resolve, reject) => {
        const id = ++sequence;
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error(`CDP timeout: ${method}`));
        }, 10000);
        pending.set(id, { resolve, reject, timer, method });
        socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
      });
    }
  };
}

async function until(read, description, timeout = 10000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const value = await read();
    if (value) return value;
    await delay(100);
  }
  throw new Error(`Timed out: ${description}`);
}

fs.mkdirSync(extension);
for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (entry.isFile() && /\.(js|html|json|png)$/.test(entry.name)) {
    fs.copyFileSync(path.join(root, entry.name), path.join(extension, entry.name));
  }
}
fs.cpSync(path.join(root, 'content'), path.join(extension, 'content'), { recursive: true });
const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
manifest.host_permissions = ['http://127.0.0.1/*']; // Disposable fixture permission only.
fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));

const html = `<!doctype html><title>Paste Typer local background fixture</title>
<h1>Local timer and event-delivery fixture, not Google Docs</h1>
<textarea id="native"></textarea><textarea id="other">UNTOUCHED</textarea>
<iframe class="docs-texteventtarget-iframe" src="/sink"></iframe>
<script>
window.trace=[]; window.startedAt=performance.now();
window.record=(type,data,trusted=false)=>trace.push({type,data,trusted,atMs:performance.now()-startedAt,
  visibility:document.visibilityState,focused:document.hasFocus()});
document.addEventListener('visibilitychange',()=>record('visibility',document.visibilityState));
document.getElementById('native').addEventListener('input',e=>record('input',e.data,e.isTrusted));
</script>`;
const sink = `<!doctype html><body tabindex="0"><script>
// This observable model accepts synthetic input. Real Docs may reject it.
window.model='';
document.addEventListener('textInput',e=>{model+=e.data;parent.record('textInput',e.data);e.preventDefault();});
document.addEventListener('keydown',e=>{
  if(e.key==='Enter'){model+='\\n';parent.record('Enter','\\n');e.preventDefault();}
  if(e.key==='Backspace'){model=model.slice(0,-1);parent.record('Backspace','');e.preventDefault();}
});
</script>`;
const server = http.createServer((req, res) => {
  res.setHeader('Content-Type', 'text/html');
  res.end(req.url === '/sink' ? sink : html);
});

(async () => {
  let chromeProcess;
  let browserCdp;
  try {
    assert.equal(typeof WebSocket, 'function', 'This optional harness needs Node 22+ (WebSocket)');
    await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
    console.log('Starting disposable headful Chrome with background throttling enabled');
    const chromePath = process.env.PT_CHROME_PATH || (process.platform === 'darwin'
      ? '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
      : process.platform === 'win32' ? 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe' : '/usr/bin/google-chrome');
    const profile = path.join(scratch, 'profile');
    const launchArgs = ['--remote-debugging-port=0', `--user-data-dir=${profile}`,
      '--enable-automation', '--enable-unsafe-extension-debugging', '--no-first-run',
      '--no-default-browser-check', '--disable-background-networking', 'about:blank'];
    chromeProcess = spawn(chromePath, launchArgs, { stdio: 'ignore' });
    let launchError;
    chromeProcess.once('error', error => { launchError = error; });
    const activePort = path.join(profile, 'DevToolsActivePort');
    await until(() => {
      if (launchError) throw launchError;
      assert.equal(chromeProcess.exitCode, null, 'Disposable Chrome exited during startup');
      return fs.existsSync(activePort);
    }, 'Chrome remote debugging port');
    const [port, endpoint] = fs.readFileSync(activePort, 'utf8').trim().split(/\r?\n/);
    browserCdp = await connect(`ws://127.0.0.1:${port}${endpoint}`);
    console.log('Disposable Chrome connected');
    report.browser = await browserCdp.send('Browser.getVersion');
    await browserCdp.send('Target.setDiscoverTargets', { discover: true });
    report.commandLine = (await browserCdp.send('Browser.getBrowserCommandLine')).arguments;
    for (const flag of ['--disable-background-timer-throttling',
      '--disable-backgrounding-occluded-windows', '--disable-renderer-backgrounding']) {
      assert.ok(!report.commandLine.includes(flag), `Test must not disable throttling: ${flag}`);
    }
    const { id: extensionId } = await browserCdp.send('Extensions.loadUnpacked', { path: extension });
    const session = async targetId => (await browserCdp.send('Target.attachToTarget', { targetId, flatten: true })).sessionId;
    const evaluate = (sessionId, label) => async (fn, argument) => {
      const result = await browserCdp.send('Runtime.evaluate', {
        expression: `(${fn.toString()})(${argument === undefined ? '' : JSON.stringify(argument)})`,
        awaitPromise: true, returnByValue: true
      }, sessionId).catch(error => { error.message = `${label}: ${error.message}`; throw error; });
      if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
      return result.result.value;
    };
    // Use a real extension page as the command sender. Evaluating directly in
    // the worker would skip runtime events and become invalid when MV3 idles it.
    const { targetId: controlId } = await browserCdp.send('Target.createTarget', {
      url: `chrome-extension://${extensionId}/popup.html`
    });
    const controller = { evaluate: evaluate(await session(controlId), 'extension page') };
    await until(() => controller.evaluate(() => typeof chrome?.runtime?.sendMessage === 'function'), 'extension command page');
    console.log('Disposable extension loaded');
    const url = `http://127.0.0.1:${server.address().port}/`;
    const { targetId } = await browserCdp.send('Target.createTarget', { url: 'about:blank' });
    const pageSession = await session(targetId);
    const page = { evaluate: evaluate(pageSession, 'local fixture') };
    const { targetId: awayId } = await browserCdp.send('Target.createTarget', { url: `${url}away` });
    report.focusEmulation = false;
    const { windowId } = await browserCdp.send('Browser.getWindowForTarget', { targetId });
    let tabId;
    const command = message => controller.evaluate(({ tabId, message }) =>
      chrome.runtime.sendMessage({ action: 'ptRoute', tabId, message, frameId: 0 }), { tabId, message });
    const progress = () => command({ action: 'getTypingProgress' });
    const snapshot = async kind => ({ state: await progress(), ...await page.evaluate(kind => ({
      value: kind === 'native' ? document.getElementById('native').value
        : document.querySelector('iframe').contentWindow.model,
      other: document.getElementById('other').value, visibility: document.visibilityState,
      focused: document.hasFocus(), trace: window.trace
    }), kind) });
    const waitPosition = async position => {
      const deadline = Date.now() + 40000;
      while (Date.now() < deadline) {
        const state = await progress();
        assert.equal(state.error, null);
        if (state.position >= position) return state;
        assert.ok(state.isTyping, `Stopped before position ${position}: ${JSON.stringify(state)}`);
        await delay(100);
      }
      throw new Error(`Timed out waiting for position ${position}`);
    };
    const timedCommand = async action => {
      const at = performance.now();
      const response = await command({ action });
      assert.equal(response.success, true);
      return { response, responseMs: performance.now() - at };
    };
    const restore = async () => {
      await browserCdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'normal' } });
      await browserCdp.send('Target.activateTarget', { targetId });
      await until(async () => (await browserCdp.send('Browser.getWindowBounds', { windowId })).bounds.windowState === 'normal' &&
        await page.evaluate(() => document.visibilityState === 'visible'), 'restored window and visible target');
    };
    const setMode = async mode => {
      if (mode === 'switched') await browserCdp.send('Target.activateTarget', { targetId: awayId });
      if (mode === 'minimized') {
        await browserCdp.send('Browser.setWindowBounds', { windowId, bounds: { windowState: 'minimized' } });
      }
      try {
        await until(() => page.evaluate(expected => document.visibilityState === expected,
          mode === 'foreground' ? 'visible' : 'hidden'), `real visibility for ${mode}`, 5000);
      } catch (error) {
        console.error('Visibility diagnostics', await controller.evaluate(async () =>
          (await chrome.tabs.query({})).map(({ id, active, windowId, url }) => ({ id, active, windowId, url }))),
        await page.evaluate(() => ({ visibility: document.visibilityState, focused: document.hasFocus() })),
        await browserCdp.send('Browser.getWindowBounds', { windowId }));
        throw error;
      }
      const visibility = await page.evaluate(() => document.visibilityState);
      assert.equal(visibility, mode === 'foreground' ? 'visible' : 'hidden', `Mode ${mode} was not applied`);
      if (mode === 'minimized') {
        assert.equal((await browserCdp.send('Browser.getWindowBounds', { windowId })).bounds.windowState, 'minimized');
      }
    };
    const prepare = async kind => {
      await restore();
      await browserCdp.send('Page.navigate', { url }, pageSession);
      await until(() => page.evaluate(url => location.href === url && document.readyState === 'complete' &&
        document.querySelector('iframe')?.contentWindow.model !== undefined, url), 'local fixture loaded');
      tabId = await controller.evaluate(async url => (await chrome.tabs.query({})).find(t => t.url === url).id, url);
      const prepared = await controller.evaluate(tabId => chrome.runtime.sendMessage({ action: 'ptPrepare', tabId }), tabId);
      assert.equal(prepared.success, true, prepared.error);
      await page.evaluate(() => document.getElementById('native').focus());
      await controller.evaluate(async ({ tabId, kind }) => {
        await chrome.scripting.executeScript({ target: { tabId, frameIds: [0] }, world: 'ISOLATED',
          func: kind => {
            pasteTyper.speedVariation = 0;
            pasteTyper.pauseChance = 0;
            // Localhost is deliberately not detected as Docs. Only this test
            // selects the real adapter explicitly, to examine event delivery.
            if (kind === 'docs-event-sink') adapterManager.getAdapter = () => new GoogleDocsAdapter();
          }, args: [kind] });
      }, { tabId, kind });
    };
    for (const kind of ['native', 'docs-event-sink']) {
      for (const mode of ['foreground', 'switched', 'minimized']) {
        await prepare(kind);
        const item = { kind, mode };
        report.cases.push(item);
        const started = performance.now();
        const response = await command({ action: 'startTyping', text, speed: 40, typoChance: 0, targetElement: true });
        assert.equal(response.success, true);
        await waitPosition(2);
        await setMode(mode);
        item.transitionMs = performance.now() - started;
        item.transition = await snapshot(kind);
        await waitPosition(text.length);
        item.elapsedMs = performance.now() - started;
        item.complete = await snapshot(kind);
        assert.equal(item.complete.value, text, 'Exact fixture output must match source');
        assert.equal(item.complete.state.position, text.length);
        assert.equal(item.complete.state.total, text.length);
        assert.equal(item.complete.state.isTyping, false);
        assert.equal(item.complete.other, 'UNTOUCHED');
        const expectedVisibility = mode === 'foreground' ? 'visible' : 'hidden';
        assert.equal(item.complete.visibility, expectedVisibility);
        for (const event of item.complete.trace.slice(item.transition.trace.length)) {
          assert.equal(event.visibility, expectedVisibility, 'Visibility must hold through delivery');
        }

        // Independent run: issue pause and Stop while still hidden. No typo
        // branch is used; that session/cancellation work belongs to issue #15.
        await prepare(kind);
        await command({ action: 'startTyping', text: text.repeat(10), speed: 40, typoChance: 0, targetElement: true });
        await waitPosition(2);
        await setMode(mode);
        item.pause = await timedCommand('pauseTyping');
        item.paused = await snapshot(kind);
        assert.equal(item.paused.state.isPaused, true);
        await delay(1400);
        const held = await snapshot(kind);
        assert.equal(held.value, item.paused.value, 'Pause must hold exact output');
        assert.equal(held.state.position, item.paused.state.position, 'Pause must hold progress');
        item.pauseHeldMs = 1400;
        item.resume = await timedCommand('resumeTyping');
        await waitPosition(held.state.position + 2);
        item.stop = await timedCommand('stopTyping');
        item.stopped = await snapshot(kind);
        assert.equal(item.stopped.state.isTyping, false);
        await delay(1400);
        const stoppedHidden = await snapshot(kind);
        assert.equal(stoppedHidden.value, item.stopped.value, 'Stop must hold output in the tested state');
        assert.equal(stoppedHidden.state.position, item.stopped.state.position, 'Stop must hold progress');
        await restore();
        await delay(600);
        item.afterRestore = await snapshot(kind);
        assert.equal(item.afterRestore.value, item.stopped.value, 'Returning to the tab must not insert after Stop');
        assert.equal(item.afterRestore.state.position, item.stopped.state.position);
        console.log(`PASS ${kind}/${mode}: exact ${text.length} chars, ${Math.round(item.elapsedMs)}ms; pause/resume/Stop stable`);
      }
    }
    console.log(`Chrome: ${report.browser.product}; OS: ${os.type()} ${os.release()} ${os.arch()}`);
  } finally {
    if (output) fs.writeFileSync(output, `${JSON.stringify(report, null, 2)}\n`);
    if (browserCdp) {
      await browserCdp.send('Browser.close').catch(() => {});
      browserCdp.close();
    }
    if (chromeProcess && chromeProcess.exitCode === null) {
      chromeProcess.kill();
      await until(() => chromeProcess.exitCode !== null || chromeProcess.signalCode !== null,
        'disposable Chrome exit', 5000).catch(() => {});
    }
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
