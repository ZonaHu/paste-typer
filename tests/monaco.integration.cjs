const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const assert = require('node:assert/strict');
const os = require('node:os');
const root = path.resolve(__dirname, '..');
const dependencies = path.resolve(process.env.PT_TEST_DEPS || path.join(root, '.local-analysis/harness'));
const { chromium } = require(path.join(dependencies, 'node_modules/playwright'));
const monacoRoot = path.join(path.resolve(process.env.PT_MONACO_DEPS || dependencies), 'node_modules/monaco-editor');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'paste-typer-test-'));
const extension = path.join(scratch, 'extension');
fs.mkdirSync(extension, {recursive:true});
for (const entry of fs.readdirSync(root, {withFileTypes:true})) {
  if (entry.isFile() && /\.(js|html|json|png)$/.test(entry.name)) fs.copyFileSync(path.join(root,entry.name), path.join(extension,entry.name));
}
fs.cpSync(path.join(root,'content'), path.join(extension,'content'), {recursive:true});
const manifest = JSON.parse(fs.readFileSync(path.join(extension,'manifest.json')));
// Only the disposable test copy has pregranted local hosts. Shipped permissions
// are optional, and their denial/request behavior is tested separately.
manifest.host_permissions = ['http://127.0.0.1/*','http://localhost/*'];
fs.writeFileSync(path.join(extension,'manifest.json'), JSON.stringify(manifest));
const editorHtml = `<!doctype html><html><body><div id="one" style="height:250px"></div><div id="two" style="height:250px"></div>
<script src="/vs/loader.js"></script><script>
require.config({paths:{vs:'/vs'}});require(['vs/editor/editor.main'],function(){
window.editors=[monaco.editor.create(document.getElementById('one'),{value:'abcdef',language:'plaintext',automaticLayout:true,editContext:false}),monaco.editor.create(document.getElementById('two'),{value:'SECOND',language:'plaintext',automaticLayout:true,editContext:false})];
editors[0].setPosition({lineNumber:1,column:4});editors[0].focus();window.ready=true;
});</script></body></html>`;
const server = http.createServer((req,res)=>{
  if(req.url === '/editor') {res.setHeader('Content-Type','text/html');res.end(editorHtml);return;}
  if(req.url.startsWith('/vs/')) {
    const file=path.join(monacoRoot,'min',req.url.split('?')[0]);
    if(!fs.existsSync(file)){res.statusCode=404;res.end();return;}
    res.setHeader('Content-Type',file.endsWith('.js')?'text/javascript':file.endsWith('.css')?'text/css':'application/octet-stream');fs.createReadStream(file).pipe(res);return;
  }
  res.setHeader('Content-Type','text/html');res.end(`<html><body><textarea id="outside">OUTSIDE</textarea><iframe title="Editor" src="http://localhost:${server.address().port}/editor" style="width:900px;height:600px"></iframe></body></html>`);
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const port=server.address().port;
 const profile=path.join(scratch,'profile');
 let context;
 try{
  context=await chromium.launchPersistentContext(profile,{headless:true,channel:'chrome',ignoreDefaultArgs:['--disable-extensions'],args:['--enable-unsafe-extension-debugging']});
  const cdp=await context.browser().newBrowserCDPSession();
  const extensionInfo=await cdp.send('Extensions.loadUnpacked',{path:extension});
  const worker=context.serviceWorkers()[0] || await context.waitForEvent('serviceworker', {timeout:5000});
  const page=await context.newPage(); await page.goto(`http://127.0.0.1:${port}/`);
  const editor=page.frame({url:new RegExp('/editor$')}); await editor.waitForFunction(()=>window.ready);
  const tabId=await worker.evaluate(async()=>{const tabs=await chrome.tabs.query({});return tabs.find(t=>t.url?.startsWith('http://127.0.0.1:')).id;});
  const route=(message)=>worker.evaluate(({tabId,message})=>frameRouter.route(tabId,message),{tabId,message});
  const prepare=()=>worker.evaluate(tabId=>frameRouter.prepare(tabId).then(r=>r.available.map(f=>({frameId:f.frameId,info:f.info}))),tabId);
  if(process.env.PT_PARTIAL_INSTALL==='1'){
    await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',
      files:PT_CONTENT_FILES.filter(file=>file!=='floating-ui.js')}),tabId);
  }
  await prepare();
  await worker.evaluate(()=>{
    globalThis.testRoutedCommands=[];
    const original=frameRouter.route.bind(frameRouter);
    frameRouter.route=(tabId,message,...args)=>{
      testRoutedCommands.push(message.action);return original(tabId,message,...args);
    };
  });
  await worker.evaluate(async tabId=>{await chrome.scripting.executeScript({target:{tabId,allFrames:true},func:()=>{if(typeof pasteTyper!=='undefined')pasteTyper.pauseChance=0;}});},tabId);
  const read=()=>editor.evaluate(()=>editors.map(e=>e.getValue().replace(/\r\n/g,'\n')));
  const waitDone=async()=>{for(let i=0;i<1500;i++){const r=await route({action:'getTypingProgress'});if(!r.isTyping){assert.equal(r.error,null);return;}await new Promise(r=>setTimeout(r,30));}throw Error('typing timed out');};
  await route({action:'startTyping',text:'XYZ',speed:10,typoChance:0,targetElement:true});await waitDone();
  assert.deepEqual(await read(),['abcXYZdef','SECOND']);assert.equal(await page.locator('#outside').inputValue(),'OUTSIDE');console.log('PASS cross-origin target + middle insertion + unrelated editor untouched');
  await editor.evaluate(()=>{for(let i=0;i<3;i++)editors[0].trigger('test','undo');});assert.equal((await read())[0],'abcdef');console.log('PASS undo');
  await editor.evaluate(()=>editors[1].setSelection({startLineNumber:1,startColumn:2,endLineNumber:1,endColumn:5}));
  await editor.locator('#two textarea.inputarea').focus();
  const commandCount=()=>worker.evaluate(()=>testRoutedCommands.length);
  const startCount=()=>worker.evaluate(()=>testRoutedCommands.filter(action=>action==='startTyping').length);
  const forgeMessages=()=>page.evaluate(()=>{
    for(const action of ['startTyping','stopTyping','loadSettings','saveSettings','floatingUIClosed']){
      window.postMessage({source:'paste-typer-floating-ui',direction:'to-content',requestId:'forged',
        action,payload:{text:'FORGED',speed:10,typoChance:0,targetElement:true,settings:{text:'FORGED'}}},'*');
    }
  });
  const assertNoPageCommands=async baseline=>{
    // Observe asynchronous runtime delivery too, rather than only checking DOM.
    for(let i=0;i<10;i++){
      await new Promise(resolve=>setTimeout(resolve,30));assert.equal(await commandCount(),baseline);
    }
  };
  const settingsBefore=await worker.evaluate(()=>chrome.storage.local.get('pasteTyperSettings'));
  await page.evaluate(()=>{
    window.forgedReplies=[];
    window.addEventListener('message',event=>{
      if(event.data?.source==='paste-typer-floating-ui' && event.data.direction==='to-floating-ui')forgedReplies.push(event.data);
    });
  });
  let baseline=await commandCount();await forgeMessages();await assertNoPageCommands(baseline);
  assert.deepEqual(await read(),['abcdef','SECOND']);
  console.log('PASS forged page messages before opening floating UI cannot reach another origin');
  await route({action:'toggleFloatingUI'});
  await page.locator('#paste-typer-floating-ui').locator('#startTyping').waitFor();
  assert.equal(await page.locator('#paste-typer-floating-ui').getByText('Floating UI loaded',{exact:true}).count(),0);
  assert.equal(await worker.evaluate(async tabId=>{
    const [result]=await chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',
      func:()=>typeof FloatingUIController==='function' && !!pasteTyper.floatingUIController});
    return result.result;
  },tabId),true);
  assert.equal(await page.evaluate(()=>typeof FloatingUIController),'undefined');
  assert.equal(await page.locator('#paste-typer-floating-ui').locator('script').count(),0);
  baseline=await commandCount();
  await page.evaluate(()=>{
    const root=document.getElementById('paste-typer-floating-ui').shadowRoot;
    for(const id of ['startTyping','stopTyping','loadClipboard','closeBtn']){
      root.getElementById(id).click();
      root.getElementById(id).dispatchEvent(new MouseEvent('click',{bubbles:true,composed:true}));
    }
    root.getElementById('startTyping').dispatchEvent(new KeyboardEvent('keydown',{key:'Enter',bubbles:true}));
    root.getElementById('textInput').value='FORGED';
    for(const id of ['textInput','speedSlider','typoChanceSlider']){
      root.getElementById(id).dispatchEvent(new InputEvent('input',{bubbles:true,composed:true}));
    }
  });
  await forgeMessages();await assertNoPageCommands(baseline);
  assert.deepEqual(await read(),['abcdef','SECOND']);
  assert.deepEqual(await worker.evaluate(()=>chrome.storage.local.get('pasteTyperSettings')),settingsBefore);
  assert.deepEqual(await page.evaluate(()=>forgedReplies),[]);
  await page.locator('#paste-typer-floating-ui').locator('#startTyping').waitFor({state:'visible'});
  console.log('PASS synthetic clicks/input and forged messages cannot route commands, save settings or close UI');
  await page.locator('#paste-typer-floating-ui').locator('#textInput').fill('selection');
  const stored=await worker.evaluate(()=>chrome.storage.local.get('pasteTyperSettings'));
  assert.equal(stored.pasteTyperSettings.text,'selection');
  const header=await page.locator('#paste-typer-floating-ui').locator('#header').boundingBox();
  await page.mouse.move(header.x+20,header.y+15);await page.mouse.down();
  await page.mouse.move(header.x+30,header.y+35);await page.mouse.up();
  const position=await worker.evaluate(()=>chrome.storage.local.get('floatingUIPosition'));
  assert.equal(typeof position.floatingUIPosition.x,'number');
  assert.equal(typeof position.floatingUIPosition.y,'number');
  console.log('PASS trusted drag persists floating position');
  await route({action:'toggleFloatingUI'});await route({action:'toggleFloatingUI'});
  baseline=await startCount();
  await page.locator('#paste-typer-floating-ui').locator('#startTyping').click();
  await page.locator('#paste-typer-floating-ui').locator('#status').filter({hasText:'Typing started!'}).waitFor();await waitDone();
  assert.equal(await startCount()-baseline,1);
  assert.deepEqual(await read(),['abcdef','SselectionND']);console.log('PASS floating UI retains selected editor and selection');
  await editor.evaluate(()=>editors[1].setPosition({lineNumber:1,column:2}));
  await editor.locator('#two textarea.inputarea').focus();
  await page.locator('#paste-typer-floating-ui').locator('#textInput').fill('K');
  await page.locator('#paste-typer-floating-ui').locator('#speedSlider').fill('10');
  await page.locator('#paste-typer-floating-ui').locator('#typoChanceSlider').fill('0');
  await page.locator('#paste-typer-floating-ui').locator('#startTyping').press('Enter');
  await page.locator('#paste-typer-floating-ui').locator('#status').filter({hasText:'Typing started!'}).waitFor();await waitDone();
  assert.equal((await read())[1],'SKselectionND');console.log('PASS trusted keyboard activation starts typing');
  await editor.locator('#two textarea.inputarea').focus();
  await page.locator('#paste-typer-floating-ui').locator('#textInput').fill('R'.repeat(200));
  await page.locator('#paste-typer-floating-ui').locator('#speedSlider').fill('25');
  await page.locator('#paste-typer-floating-ui').locator('#startTyping').click();
  await page.locator('#paste-typer-floating-ui').locator('#status').filter({hasText:'Typing started!'}).waitFor();
  baseline=await commandCount();
  await forgeMessages();
  await page.evaluate(()=>document.getElementById('paste-typer-floating-ui').shadowRoot.getElementById('stopTyping').click());
  await assertNoPageCommands(baseline);
  assert.equal((await route({action:'getTypingProgress'})).isTyping,true);
  await page.locator('#paste-typer-floating-ui').locator('#stopTyping').click();
  await page.locator('#paste-typer-floating-ui').locator('#status').filter({hasText:'Stopped'}).waitFor();
  assert.equal((await route({action:'getTypingProgress'})).isTyping,false);
  const stoppedText=(await read())[1];
  await new Promise(resolve=>setTimeout(resolve,100));assert.equal((await read())[1],stoppedText);
  console.log('PASS forged Stop cannot interrupt typing; trusted Stop halts input');
  // Mock only the isolated clipboard API, never the user's OS clipboard.
  await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',func:()=>{
    globalThis.fixtureClipboardReads=0;
    navigator.clipboard.readText=async()=>{fixtureClipboardReads++;return 'clipboard fixture';};
  }}),tabId);
  await page.locator('#paste-typer-floating-ui').locator('#loadClipboard').click();
  await page.locator('#paste-typer-floating-ui').locator('#status').filter({hasText:'Clipboard text loaded'}).waitFor();
  // Playwright range.fill dispatches an untrusted event; use native keyboard
  // adjustment for the user action that should persist each prepared value.
  await page.locator('#paste-typer-floating-ui').locator('#speedSlider').fill('72');
  await page.locator('#paste-typer-floating-ui').locator('#speedSlider').press('ArrowRight');
  await page.locator('#paste-typer-floating-ui').locator('#typoChanceSlider').fill('10');
  await page.locator('#paste-typer-floating-ui').locator('#typoChanceSlider').press('ArrowRight');
  await page.locator('#paste-typer-floating-ui').locator('#closeBtn').click();
  await page.locator('#paste-typer-floating-ui').locator('#startTyping').waitFor({state:'hidden'});
  await route({action:'toggleFloatingUI'});
  await page.locator('#paste-typer-floating-ui').locator('#startTyping').waitFor({state:'visible'});
  assert.equal(await page.locator('#paste-typer-floating-ui').locator('#textInput').inputValue(),'clipboard fixture');
  assert.equal(await page.locator('#paste-typer-floating-ui').locator('#speedSlider').inputValue(),'73');
  assert.equal(await page.locator('#paste-typer-floating-ui').locator('#typoChanceSlider').inputValue(),'11');
  const savedSettings=await worker.evaluate(()=>chrome.storage.local.get('pasteTyperSettings'));
  assert.deepEqual(savedSettings.pasteTyperSettings,{text:'clipboard fixture',speed:'73',typoChance:'11'});
  // Recreate, rather than just show, the panel to exercise storage loading too.
  await page.locator('#paste-typer-floating-ui').evaluate(host=>host.remove());
  await route({action:'toggleFloatingUI'});
  await page.waitForFunction(()=>document.getElementById('paste-typer-floating-ui')?.shadowRoot?.getElementById('textInput')?.value==='clipboard fixture');
  assert.equal(await page.locator('#paste-typer-floating-ui').locator('#speedSlider').inputValue(),'73');
  assert.equal(await page.locator('#paste-typer-floating-ui').locator('#typoChanceSlider').inputValue(),'11');
  console.log('PASS clipboard handler and settings persist through close/reopen and panel recreation');
  await editor.evaluate(()=>{editors[1].setValue('SselectionND');editors[1].setPosition({lineNumber:1,column:2});});
  await editor.evaluate(()=>editors[1].setPosition({lineNumber:1,column:2}));await editor.locator('#two textarea.inputarea').focus();
  await route({action:'startTyping',text:'\nQ',speed:10,typoChance:0,targetElement:true});await waitDone();assert.equal((await read())[1],'S\nQselectionND');console.log('PASS newline');
  // Real native key handling for typo correction.
  await route({action:'startTyping',text:'abcdefghij',speed:10,typoChance:1,targetElement:true});await waitDone();assert.ok((await read())[1].includes('QabcdefghijselectionND'));console.log('PASS forced typo + backspace corrections');
  await route({action:'resetTyping'});assert.equal((await read())[1],'');assert.equal((await read())[0],'abcdef');console.log('PASS explicit clear only selected Monaco');
  // Repeated discovery does not redeclare classes or duplicate UI listeners.
  await Promise.all([prepare(),prepare(),prepare()]);console.log('PASS concurrent/repeated injection');
  await editor.locator('#one textarea.inputarea').focus();
  await editor.evaluate(()=>editors[0].setPosition({lineNumber:1,column:3}));
  const popup=await context.newPage();await popup.goto(`chrome-extension://${extensionInfo.id}/popup.html`);
  // A headless extension-page tab is itself "active"; the test scope pins tabs
  // query to the invoked web tab. Popup behavior and runtime messages are real.
  await popup.evaluate(id=>{chrome.tabs.query=async()=>[ {id,url:'http://127.0.0.1/'} ];},tabId);
  await popup.reload();
  await popup.evaluate(id=>{chrome.tabs.query=async()=>[ {id,url:'http://127.0.0.1/'} ];},tabId);
  await popup.locator('#textInput').fill('popup');await popup.locator('#speedSlider').fill('10');
  await popup.locator('#typoChanceSlider').fill('0');await popup.locator('#startTyping').click();
  await popup.locator('#status').filter({hasText:'Typing started!'}).waitFor({timeout:3000});await waitDone();
  assert.equal((await read())[0],'abpopupcdef');console.log('PASS popup after losing page focus, saved caret');
  const indented='    int n = 1;\r\n    n++;\r\n';
  await popup.locator('#textInput').fill(indented);await popup.locator('#startTyping').click();
  await popup.locator('#status').filter({hasText:'Typing started!'}).waitFor({timeout:3000});await waitDone();
  assert.equal((await read())[0],'abpopup'+indented.replace(/\r\n/g,'\n')+'cdef');console.log('PASS popup preserves leading indentation and trailing newlines');
  await editor.evaluate(()=>{
    editors[0].setValue('');monaco.editor.setModelLanguage(editors[0].getModel(),'cpp');
    editors[0].updateOptions({autoIndent:'full',autoIndentOnPaste:true,autoClosingBrackets:'always',autoClosingQuotes:'always'});
    editors[0].focus();
    const names=['autoIndent','autoClosingBrackets','autoClosingQuotes','autoClosingOvertype','autoSurround','formatOnType','acceptSuggestionOnEnter'];
    window.inputOptionsBefore=names.map(name=>editors[0].getOption(monaco.editor.EditorOption[name]));
    window.inputEvents=[];window.pasteCount=0;
    const input=editors[0].getDomNode().querySelector('textarea.inputarea');
    input.addEventListener('input',event=>inputEvents.push(event.inputType));
    input.addEventListener('paste',()=>pasteCount++);
    // Prove this path uses editor input handlers, never direct executeEdits.
    editors[0].executeEdits=()=>{throw Error('Direct model edits are prohibited by this test');};
  });
  const code='int main() {\n    // Вывод текста на экран\n    printf("Привет! Это простая программа на C.\\n");\n\n    int num1, num2, sum;\n\n    // Запрос ввода от пользователя\n    printf("Введите первое целое число: ");\n    scanf("%d", &num1);\n\n    printf("Введите второе целое число: ");\n    scanf("%d", &num2);\n\n    // Математическая операция\n    sum = num1 + num2;\n\n    // Вывод результата\n    printf("Сумма чисел %d и %d равна: %d\\n", num1, num2, sum);\n\n    return 0;\n}\n';
  await popup.locator('#textInput').fill(code);await popup.locator('#startTyping').click();
  await popup.locator('#status').filter({hasText:'Typing started!'}).waitFor({timeout:3000});await waitDone();
  assert.equal((await read())[0],code);console.log('PASS exact multiline C sample, auto-indent and auto-closing enabled');
  const inputProof=await editor.evaluate(()=>({pasteCount,inputEvents,before:inputOptionsBefore,
    after:['autoIndent','autoClosingBrackets','autoClosingQuotes','autoClosingOvertype','autoSurround','formatOnType','acceptSuggestionOnEnter'].map(name=>editors[0].getOption(monaco.editor.EditorOption[name]))}));
  assert.equal(inputProof.pasteCount,0);assert.ok(inputProof.inputEvents.length>0);
  assert.ok(inputProof.inputEvents.every(type=>type==='insertText'));
  assert.deepEqual(inputProof.after,inputProof.before);console.log('PASS simulated input only, no paste/model edits, editor options restored');
  await editor.evaluate(()=>{
    editors[0].setValue('UNCHANGED');editors[0].setPosition({lineNumber:1,column:1});editors[0].focus();
    window.blockKey=event=>{if(event.key==='X')event.preventDefault();};
    editors[0].getDomNode().querySelector('textarea.inputarea').addEventListener('keydown',blockKey,true);
  });
  await route({action:'startTyping',text:'XYZ',speed:10,typoChance:0,targetElement:true});
  let failed;
  for(let i=0;i<100;i++){failed=await route({action:'getTypingProgress'});if(!failed.isTyping)break;await new Promise(r=>setTimeout(r,30));}
  assert.ok(failed.error.includes('intercepted'));assert.equal((await read())[0],'UNCHANGED');
  const afterFailure=await editor.evaluate(()=>{
    editors[0].getDomNode().querySelector('textarea.inputarea').removeEventListener('keydown',blockKey,true);
    return ['autoIndent','autoClosingBrackets','autoClosingQuotes','autoClosingOvertype','autoSurround','formatOnType','acceptSuggestionOnEnter'].map(name=>editors[0].getOption(monaco.editor.EditorOption[name]));
  });
  assert.deepEqual(afterFailure,inputProof.before);console.log('PASS intercepted input fails, preserves text and restores options');
  await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',func:()=>{
    // Force failure after markup import, as in the reported missing controller.
    FloatingUIController=class { constructor(){throw Error('fixture controller initialization failure');} };
  }}),tabId);
  await page.locator('#paste-typer-floating-ui').evaluate(host=>host.remove());
  await route({action:'toggleFloatingUI'});
  await page.locator('#paste-typer-floating-ui').getByText('Floating UI could not load. Reload the extension and refresh this page.',{exact:true}).waitFor();
  assert.equal(await page.locator('#paste-typer-floating-ui').locator('#startTyping').count(),0);
  assert.equal(await page.locator('#paste-typer-floating-ui').locator('.floating-header').count(),1);
  console.log('PASS controller failure replaces partial markup with one explicit fallback panel');

  // A mixed installation can leave pasteTyper in the temporal dead zone.
  // Chrome reports the old probe's ReferenceError as a null result.
  const failedPage=await context.newPage();
  await failedPage.goto(`http://127.0.0.1:${port}/?failed-install`);
  const failedTab=await worker.evaluate(async url=>(await chrome.tabs.query({})).find(tab=>tab.url===url).id,failedPage.url());
  await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',func:()=>{
    globalThis.fixtureStorageGet=chrome.storage.local.get;
    chrome.storage.local.get=()=>{throw Error('fixture content initialization failure');};
  }}),failedTab);
  await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',
    files:PT_CONTENT_FILES}),failedTab);
  await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',func:()=>{
    chrome.storage.local.get=globalThis.fixtureStorageGet;
    delete globalThis.fixtureStorageGet;
  }}),failedTab);
  const brokenProbe=await worker.evaluate(tabId=>chrome.scripting.executeScript({target:{tabId,frameIds:[0]},world:'ISOLATED',func:()=>{
    const hasTyper=typeof pasteTyper!=='undefined';
    return {hasTyper,hasFloating:typeof FloatingUIController!=='undefined',
      legacyBridge:hasTyper && typeof pasteTyper.setupFloatingUIBridge==='function'};
  }}),failedTab);
  assert.equal(brokenProbe[0].result,null);
  const failure=await worker.evaluate(async tabId=>{
    try{await frameRouter.route(tabId,{action:'startTyping',text:'must not type'});return null;}
    catch(error){return {code:error.code,message:error.message};}
  },failedTab);
  assert.equal(failure.code,'PT_REFRESH_REQUIRED');
  assert.match(failure.message,/refresh this page/);
  await failedPage.reload();
  await worker.evaluate(tabId=>frameRouter.prepare(tabId),failedTab);
  await failedPage.locator('#outside').click();
  await worker.evaluate(tabId=>frameRouter.route(tabId,{action:'startTyping',text:'OK',speed:10,typoChance:0}),failedTab);
  await failedPage.waitForFunction(()=>document.querySelector('#outside').value.includes('OK'));
  assert.equal(await failedPage.locator('#outside').inputValue(),'OK');
  console.log('PASS real Chrome null-probe regression: explicit refresh requirement, then standard input typing recovers');
  await failedPage.close();

 }finally{await context?.close();server.close();if(path.dirname(scratch)===path.resolve(os.tmpdir()) && path.basename(scratch).startsWith('paste-typer-test-'))fs.rmSync(scratch,{recursive:true,force:true});}
})().catch(e=>{console.error(e);server.close();process.exitCode=1;});
