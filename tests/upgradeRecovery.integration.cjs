// This tests an unpacked reload, not a Chrome Web Store update or a disabled install.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const { chromium } = require(path.join(process.env.PT_TEST_DEPS, 'node_modules/playwright'));
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-typer-upgrade-'));
const extension = path.join(scratch, 'extension');
const oldRef = process.env.PT_UPGRADE_OLD_REF || '64198da';
const server = http.createServer((request, response) => {
  response.setHeader('Content-Type', 'text/html');
  response.end('<textarea id="input"></textarea><input id="other" value="UNTOUCHED">');
});
function grantFixtureOrigin() {
  const manifest = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json')));
  manifest.host_permissions = ['http://127.0.0.1/*'];
  fs.writeFileSync(path.join(extension, 'manifest.json'), JSON.stringify(manifest));
}
function installCurrentCopy() {
  // Keep the installed directory present. Removing it first makes Chrome
  // disable the unpacked extension instead of exercising a normal reload.
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (entry.isFile() && /\.(js|html|json|png)$/.test(entry.name)) {
      fs.copyFileSync(path.join(root, entry.name), path.join(extension, entry.name));
    }
  }
  fs.cpSync(path.join(root, 'content'), path.join(extension, 'content'), { recursive: true });
  grantFixtureOrigin();
}
(async () => {
  let context;
  try {
    fs.mkdirSync(extension);
    const archive = execFileSync('git', ['archive', oldRef], { cwd: root });
    execFileSync('tar', ['-x', '-C', extension], { input: archive });
    grantFixtureOrigin();
    assert.equal(JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'))).version, '1.1.1');
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    context = await chromium.launchPersistentContext(path.join(scratch, 'profile'), {
      headless: true, channel: 'chrome', ignoreDefaultArgs: ['--disable-extensions'],
      args: ['--enable-unsafe-extension-debugging']
    });
    context.setDefaultTimeout(10000);
    // CDP can initially load unpacked code with Developer mode off, but a
    // normal runtime.reload then leaves it disabled. Mirror the prerequisite
    // of Chrome's Load unpacked UI in this disposable profile only.
    const configuration = await context.newPage();
    await configuration.goto('chrome://extensions/');
    await configuration.evaluate(() => new Promise((resolve, reject) => {
      chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true }, () =>
        chrome.runtime.lastError ? reject(Error(chrome.runtime.lastError.message)) : resolve());
    }));
    assert.equal(await configuration.evaluate(() => new Promise(resolve =>
      chrome.developerPrivate.getProfileConfiguration(config => resolve(config.inDeveloperMode)))), true);
    await configuration.close();
    const cdp = await context.browser().newBrowserCDPSession();
    const { id } = await cdp.send('Extensions.loadUnpacked', { path: extension });
    let worker = context.serviceWorkers()[0] || await context.waitForEvent('serviceworker');
    const page = await context.newPage();
    const url = `http://127.0.0.1:${server.address().port}/`;
    await page.goto(url);
    const findTab = target => worker.evaluate(async target =>
      (await chrome.tabs.query({})).find(tab => tab.url === target)?.id, target);
    let tabId = await findTab(url);
    const route = (message, target = tabId) => worker.evaluate(({ tabId, message }) =>
      frameRouter.route(tabId, message, 0), { tabId: target, message });
    const done = async target => {
      for (let attempts = 0; attempts < 100; attempts++) {
        const progress = await route({ action: 'getTypingProgress' }, target);
        if (!progress.isTyping) { assert.equal(progress.error, null); return; }
        await new Promise(resolve => setTimeout(resolve, 30));
      }
      throw new Error('Fixture typing did not complete.');
    };
    await route({ action: 'getTypingProgress' });
    await page.locator('#input').focus();
    await route({ action: 'startTyping', text: 'OLD', speed: 10, typoChance: 0 });
    await done(tabId);
    assert.equal(await page.locator('#input').inputValue(), 'OLD');
    await worker.evaluate(() => chrome.storage.local.set({ upgradeFixture: 'preserved' }));
    installCurrentCopy();
    const oldWorker = worker;
    const newWorker = context.waitForEvent('serviceworker', {
      predicate: next => next !== oldWorker && next.url() === oldWorker.url(), timeout: 15000
    }).catch(error => ({ startupError: error.message }));
    await oldWorker.evaluate(() => chrome.runtime.reload()).catch(error => {
      if (!/closed|destroyed|Target page/i.test(error.message)) throw error;
    });
    // Opening an extension page is a normal way to wake its service worker.
    // Resource access can briefly be blocked while the reload is in progress.
    const wake = await context.newPage();
    const deadline = Date.now() + 10000;
    let wakeError;
    let awake = false;
    while (Date.now() < deadline) {
      try {
        await wake.goto(`chrome-extension://${id}/popup.html`, { timeout: 1000 });
        awake = await wake.evaluate(() => chrome.runtime.getManifest().version === '1.1.2');
        if (awake) break;
      } catch (error) {
        if (!/ERR_BLOCKED_BY_CLIENT|ERR_ABORTED|Timeout/i.test(error.message)) throw error;
        wakeError = error;
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    assert.ok(awake, `Reloaded extension page did not become available: ${wakeError?.message || 'wrong version'}`);
    worker = await newWorker;
    if (worker.startupError) throw new Error(worker.startupError);
    await wake.close();
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    assert.equal(manifest.version, '1.1.2');
    assert.equal(manifest.permissions.includes('webNavigation'), false);
    assert.equal(new URL(worker.url()).host, id);
    assert.equal((await worker.evaluate(() => chrome.storage.local.get('upgradeFixture'))).upgradeFixture, 'preserved');
    let oldTab;
    try { oldTab = await route({ action: 'startInputNavigation' }); }
    catch (error) { oldTab = { error: error.message }; }
    console.log('OBSERVED already-open tab after unpacked reload:', JSON.stringify(oldTab));
    assert.equal(await page.locator('#input').inputValue(), 'OLD', 'reload never rewrites the field');
    for (const kind of ['refreshed', 'new']) {
      const target = kind === 'refreshed' ? page : await context.newPage();
      const targetUrl = kind === 'refreshed' ? url : url + '?new=1';
      if (kind === 'refreshed') await target.reload(); else await target.goto(targetUrl);
      const targetId = await findTab(targetUrl);
      assert.ok((await route({ action: 'startInputNavigation' }, targetId)).count > 0);
      await route({ action: 'stopInputNavigation' }, targetId);
      await target.locator('#input').focus();
      await route({ action: 'startTyping', text: 'NEW', speed: 10, typoChance: 0 }, targetId);
      await done(targetId);
      assert.equal(await target.locator('#input').inputValue(), 'NEW');
      await route({ action: 'startTyping', text: 'long enough to stop', speed: 200, typoChance: 0 }, targetId);
      await route({ action: 'stopTyping' }, targetId);
      const stopped = await target.locator('#input').inputValue();
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal(await target.locator('#input').inputValue(), stopped);
      await route({ action: 'toggleFloatingUI' }, targetId);
      await target.locator('#paste-typer-floating-ui').locator('#startTyping').waitFor();
      assert.equal(await target.locator('#other').inputValue(), 'UNTOUCHED');
      console.log(`PASS ${kind} page: Navigate, Start, Stop, Floating UI`);
    }
    console.log('ENVIRONMENT', JSON.stringify({ chrome: context.browser().version(), os: os.platform(), release: os.release(), from: oldRef, to: manifest.version }));
    console.log('NOT TESTED: real Web Store update; permission-disabled installation recovery.');
  } finally {
    await context?.close();
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
