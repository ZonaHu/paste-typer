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
    const oldVersion = JSON.parse(fs.readFileSync(path.join(extension, 'manifest.json'))).version;
    const currentVersion = JSON.parse(fs.readFileSync(path.join(root, 'manifest.json'))).version;
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
    const legacySettings = { text: 'Saved source: café 🧪', speed: '35', typoChance: '5' };
    const waitForSettings = async controls => {
      const deadline = Date.now() + 10000;
      while (Date.now() < deadline) {
        const ready = await controls.locator('#textInput').evaluate((element, expected) => {
          const scope = element.getRootNode(), remember = scope.querySelector('#rememberText');
          return element.value === expected.text && scope.querySelector('#speedSlider').value === expected.speed &&
            scope.querySelector('#typoChanceSlider').value === expected.typoChance &&
            (!remember || remember.checked && !remember.disabled);
        }, legacySettings);
        if (ready) return;
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      throw new Error('Upgraded UI did not load the saved source and settings.');
    };
    await worker.evaluate(settings => chrome.storage.local.set({
      upgradeFixture: 'preserved', pasteTyperSettings: settings
    }), legacySettings);
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
        awake = await wake.evaluate(version => chrome.runtime.getManifest().version === version, currentVersion);
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
    await waitForSettings(wake);
    assert.equal(await wake.locator('#textInput').inputValue(), legacySettings.text);
    assert.equal(await wake.locator('#speedSlider').inputValue(), legacySettings.speed);
    assert.equal(await wake.locator('#typoChanceSlider').inputValue(), legacySettings.typoChance);
    const hasTypoHelper = await worker.evaluate(() => typeof PTTypoRate !== 'undefined');
    if (hasTypoHelper) assert.equal(await wake.locator('#typoChanceValue').textContent(), '5%');
    await wake.close();
    const manifest = await worker.evaluate(() => chrome.runtime.getManifest());
    assert.equal(manifest.version, currentVersion);
    assert.equal(manifest.permissions.includes('webNavigation'), false);
    assert.equal(new URL(worker.url()).host, id);
    assert.equal((await worker.evaluate(() => chrome.storage.local.get('upgradeFixture'))).upgradeFixture, 'preserved');
    const preservedSettings = (await worker.evaluate(() => chrome.storage.local.get('pasteTyperSettings'))).pasteTyperSettings;
    for (const key of ['text', 'speed', 'typoChance']) assert.equal(preservedSettings[key], legacySettings[key]);
    console.log('PASS saved Unicode source, legacy privacy default, speed and 5% typo setting survive upgrade');
    let oldTab;
    try { oldTab = await route({ action: 'startInputNavigation' }); }
    catch (error) { oldTab = { error: error.message }; }
    console.log('OBSERVED already-open tab after unpacked reload:', JSON.stringify(oldTab));
    assert.equal(await page.locator('#input').inputValue(), 'OLD', 'reload never rewrites the field');
    if (oldTab.error) assert.match(oldTab.error, /refresh|reload|receiving end|connection/i);
    else assert.ok(oldTab.count > 0, 'An already-open fixture must find its two editable fields.');
    const pageKinds = oldTab.count > 0 ? ['already-open', 'refreshed', 'new'] : ['refreshed', 'new'];
    for (const kind of pageKinds) {
      const target = kind === 'new' ? await context.newPage() : page;
      const targetUrl = kind === 'new' ? url + '?new=1' : url;
      if (kind === 'refreshed') await target.reload();
      else if (kind === 'new') await target.goto(targetUrl);
      const targetId = await findTab(targetUrl);
      assert.ok((await route({ action: 'startInputNavigation' }, targetId)).count > 0);
      await route({ action: 'stopInputNavigation' }, targetId);
      await target.locator('#input').focus();
      await target.locator('#input').evaluate(element => element.setSelectionRange(element.value.length, element.value.length));
      await route({ action: 'startTyping', text: 'NEW', speed: 10, typoChance: 0 }, targetId);
      await done(targetId);
      assert.equal(await target.locator('#input').inputValue(), kind === 'already-open' ? 'OLDNEW' : 'NEW');
      await route({ action: 'startTyping', text: 'long enough to stop', speed: 200, typoChance: 0 }, targetId);
      await route({ action: 'stopTyping' }, targetId);
      const stopped = await target.locator('#input').inputValue();
      await new Promise(resolve => setTimeout(resolve, 500));
      assert.equal(await target.locator('#input').inputValue(), stopped);
      await route({ action: 'toggleFloatingUI' }, targetId);
      await target.locator('#paste-typer-floating-ui').locator('#startTyping').waitFor();
      const panel = target.locator('#paste-typer-floating-ui');
      await waitForSettings(panel);
      assert.equal(await panel.locator('#textInput').inputValue(), legacySettings.text);
      assert.equal(await panel.locator('#speedSlider').inputValue(), legacySettings.speed);
      if (hasTypoHelper) assert.equal(await panel.locator('#typoChanceValue').textContent(), '5%');
      assert.equal(await target.locator('#other').inputValue(), 'UNTOUCHED');
      await panel.locator('#textInput').fill('PANEL');
      await panel.locator('#typoChanceSlider').press('Home');
      await target.locator('#input').focus();
      await panel.locator('#startTyping').click();
      // A trusted click starts asynchronous routing; old stopped progress is
      // not completion of this new Start. Wait for its actual field delivery.
      await target.waitForFunction(expected => document.getElementById('input').value === expected, stopped + 'PANEL');
      await done(targetId);
      assert.equal(await target.locator('#input').inputValue(), stopped + 'PANEL');
      await panel.locator('#closeBtn').click();
      // Restore the fixture settings before checking the next upgraded page.
      await worker.evaluate(settings => chrome.storage.local.set({ pasteTyperSettings: settings }), legacySettings);
      console.log(`PASS ${kind} page: Navigate, exact Start, Stop, Floating Start and saved settings`);
    }
    console.log('ENVIRONMENT', JSON.stringify({ chrome: context.browser().version(), os: os.platform(), release: os.release(), from: oldRef, oldVersion, to: manifest.version }));
    console.log('NOT TESTED: real Web Store update; permission-disabled installation recovery.');
  } finally {
    await context?.close();
    server.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
})().catch(error => { console.error(error); process.exitCode = 1; });
