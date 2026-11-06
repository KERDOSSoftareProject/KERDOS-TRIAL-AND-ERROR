// Real Chromium extension/runtime; synthetic pages and transport only.
// No live supplier, signed-in KERDOS, Supabase or purchasing acceptance.
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,resolve} from 'node:path';
import {pathToFileURL} from 'node:url';
import {createHash} from 'node:crypto';
const {chromium}=await import(process.env.KERDOS_PLAYWRIGHT_MODULE?pathToFileURL(process.env.KERDOS_PLAYWRIGHT_MODULE).href:'playwright-core');
const scratch=await mkdtemp(join(tmpdir(),'kerdos-extension-runtime-'));
const extension=join(scratch,'companion');
const appOrigin='https://kerdossoftareproject.github.io',appUrl=appOrigin+'/KERDOS-TRIAL-AND-ERROR/';
const vendorOrigin='https://order.usfoods.com',vendorUrl=vendorOrigin+'/desktop/lists/view/synthetic-runtime';
const csv='Product Number,Product Description,Product Price\nSYNTHETIC,Crème brûlée® – jalapeño,1.20\n';
const changedCsv=csv.replace('1.20','1.35');
let context;
try{
 await cp(resolve('companion/chrome'),extension,{recursive:true});
 const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
 assert.deepEqual(manifest.permissions,['activeTab','scripting','storage']);assert.equal(manifest.host_permissions,undefined);
 // Run the exact shipped manifest; optional grants are enabled only in the
 // dedicated refresh phase below, never by widening the packaged manifest.
 context=await chromium.launchPersistentContext(join(scratch,'profile'),{channel:'chromium',headless:process.env.KERDOS_BROWSER_HEADED!=='1',acceptDownloads:true,args:['--host-resolver-rules=MAP * ~NOTFOUND','--enable-unsafe-extension-debugging','--disable-extensions-except='+extension,'--load-extension='+extension]});
 context.setDefaultTimeout(15000);
 const devtools=await context.browser().newBrowserCDPSession();
 let protocolId=0;const replies=new Map();
 devtools.on('Target.receivedMessageFromTarget',event=>{const message=JSON.parse(event.message),key=event.sessionId+':'+message.id;const pending=replies.get(key);if(pending){replies.delete(key);if(message.error)pending.reject(Error(message.error.message));else pending.resolve(message.result);}});
 const call=(sessionId,method,params={})=>new Promise((resolve,reject)=>{const id=++protocolId,key=sessionId+':'+id;replies.set(key,{resolve,reject});devtools.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})}).catch(error=>{replies.delete(key);reject(error);});});

 const unexpected=[];
 const source=await readFile('src/services/companion-handoff.js','utf8');
 const refreshSource=await readFile('src/services/companion-refresh.js','utf8');let vendorRequiresVerification=false;
 const app=`<!doctype html><meta charset="utf-8"><title>Synthetic KERDOS receiver</title><script type="module">
 import {createCompanionHandoff} from '/handoff.mjs';import {createCompanionRefreshClient} from '/refresh.mjs';
 window.received=[];window.prepare=()=>{window.handoff?.cancel();window.handoff=createCompanionHandoff({selection:{organizationId:'synthetic-client',vendorId:'synthetic-vendor',adapterKey:'us-foods-moxe',portalOrigin:'${vendorOrigin}',account:'Sample Client',list:'Example List'},now:()=>window.clock??Date.now(),onReceive:async p=>{window.received.push({text:await p.file.text(),organizationId:p.organizationId,vendorId:p.vendorId,evidence:p.evidence});}});};window.prepare();window.refreshClient=createCompanionRefreshClient(window);window.startRefresh=async()=>{window.prepare();window.refreshResult=null;window.refreshResult=await window.refreshClient.refresh(window.handoff.nonce);};
 </script><button id="refresh-prices" onclick="window.startRefresh()">Refresh prices</button>`;
 const vendor=`<!doctype html><meta charset="utf-8"><title>Synthetic vendor</title><p>MY LIST</p><button>Sample Client (12345678)</button><span data-cy="list-banner-list-name-text">Example List</span>
 <button id="open" onclick="window.openDialog()">Download</button>
 <style>#dialog[hidden]{display:none}#dialog:not([hidden]),app-dual-pane-modal{display:contents}</style><ion-modal id="dialog" hidden><app-dual-pane-modal><div data-cy="list-download-modal-dual-pane-modal-title">Download Example List</div><p>Select Format CSV</p><div onclick="document.getElementById('prices').hidden=false"><span>Download Options</span></div><div id="prices" hidden><ion-checkbox><div class="checkbox-content"><div class="label">Product Prices</div><div class="sublabel">Include quoted prices</div></div></ion-checkbox><ion-checkbox><div class="checkbox-content"><div class="label">Product Notes</div></div></ion-checkbox></div><button id="download">Download</button></app-dual-pane-modal></ion-modal>
 <script>window.openDialog=async()=>{while(!await window.__fixtureSourceSelected())await new Promise(resolve=>setTimeout(resolve,50));requestAnimationFrame(()=>{document.getElementById('dialog').hidden=false;});};customElements.define('ion-checkbox',class extends HTMLElement{get checked(){return this.getAttribute('aria-checked')==='true';}set checked(value){this.setAttribute('aria-checked',String(value));}connectedCallback(){this.style.display='block';this.addEventListener('click',()=>{const next=this.cloneNode(true);next.checked=!this.checked;this.replaceWith(next);});}});window.csv=${JSON.stringify(csv)};window.exportCount=0;document.getElementById('download').onclick=()=>{window.exportCount++;window.finishExport=()=>{const url=URL.createObjectURL(new Blob([window.csv],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download='Example List.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};};</script>`;
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.protocol==='chrome-extension:')return route.continue();
  if(url.origin===appOrigin)return route.fulfill({contentType:['/handoff.mjs','/refresh.mjs'].includes(url.pathname)?'text/javascript':'text/html',body:url.pathname==='/handoff.mjs'?source:url.pathname==='/refresh.mjs'?refreshSource:app});
  if(url.origin===vendorOrigin)return route.fulfill({contentType:'text/html',body:vendorRequiresVerification?'<input type="password"><p>Sign in directly</p>':vendor});
  unexpected.push(url.origin);await route.abort();
 });
 let worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const extensionId=new URL(worker.url()).host;
 const granted=await worker.evaluate(()=>globalThis.chrome.permissions.getAll());assert.ok((granted.origins||[]).every(origin=>origin.startsWith(appOrigin+'/')),'no vendor access before explicit optional grant');assert.deepEqual([...granted.permissions].sort(),['activeTab','scripting','storage'].sort());
 await worker.evaluate(()=>{globalThis.__runtimeCommands=[];globalThis.chrome.runtime.onMessage.addListener((m,s)=>{globalThis.__runtimeCommands.push({action:m?.action,url:s.url,hasTab:!!s.tab});});});
 // Playwright forces renderer focus for its pages. Use actual native Chrome
 // tab selection as the synthetic rendering gate, then an animation frame;
 // this does not claim to test production visibility throttling itself.
 await context.exposeBinding('__fixtureSourceSelected',async({page})=>worker.evaluate(async url=>{const tabs=await globalThis.chrome.tabs.query({url});return tabs.length===1&&tabs[0].active;},page.url()));
 let appPage=await context.newPage();await appPage.goto(appUrl);await appPage.waitForFunction(()=>!!window.handoff);
 let vendorPage=await context.newPage();await vendorPage.goto(vendorUrl);
 async function popup(target){
  await target.bringToFront();
  const pageTarget=(await devtools.send('Target.getTargets',{filter:[{type:'tab'},{exclude:true}]})).targetInfos.find(t=>t.type==='tab'&&t.url===target.url());assert.ok(pageTarget);
  // The isolated test browser invokes the real toolbar action, which lets
  // Chromium grant activeTab normally; opening a popup alone is insufficient.
  await devtools.send('Extensions.triggerAction',{id:extensionId,targetId:pageTarget.targetId});
  const until=Date.now()+15000;let info;
  do{info=(await devtools.send('Target.getTargets')).targetInfos.find(t=>t.url==='chrome-extension://'+extensionId+'/popup.html');if(info)break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<until);
  assert.ok(info,'native action popup target was not created');
  const {sessionId}=await devtools.send('Target.attachToTarget',{targetId:info.targetId,flatten:false});
  const evaluate=async expression=>{const value=await call(sessionId,'Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(value.exceptionDetails)throw Error(value.exceptionDetails.exception?.description||value.exceptionDetails.text);return value.result.value;};
  const readyBy=Date.now()+15000;let ready=false;
  do{ready=await evaluate("document.readyState==='complete'&&!!document.getElementById('pair')&&!!document.getElementById('export')&&!!document.getElementById('status')");if(ready)break;await new Promise(resolve=>setTimeout(resolve,50));}while(Date.now()<readyBy);
  assert.equal(ready,true,'native popup document and module are loaded before its controls are used');
  return {
   click:id=>evaluate(`document.getElementById(${JSON.stringify(id)}).click()`),
   status:()=>evaluate("document.getElementById('status').textContent"),
   disabled:()=>evaluate("document.getElementById('export').disabled"),
   async waitStatus(text){const end=Date.now()+25000;do{const status=await this.status();if((Array.isArray(text)?text:[text]).some(value=>status.includes(value)))return;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<end);throw Error('Unexpected popup status: '+await this.status());},
   close:()=>devtools.send('Target.closeTarget',{targetId:info.targetId}),
  };
 }
 async function pair(){const view=await popup(appPage);await view.click('pair');await view.waitStatus('Paired for one export');await view.close();}
 async function start(text){
  await vendorPage.evaluate(value=>{window.csv=value;window.finishExport=undefined;document.getElementById('dialog').hidden=true;},text);
  const view=await popup(vendorPage);await view.click('export');await vendorPage.waitForFunction(()=>typeof window.finishExport==='function');return view;
 }
 await pair();
 // Stop a paired but idle worker before any export command. Persistence must
 // retain the preparation without starting a supplier operation on restart.
 const idlePairing=await worker.evaluate(()=>globalThis.chrome.storage.session.get('pairing'));
 const idleLifecycle=await context.newCDPSession(appPage);await idleLifecycle.send('ServiceWorker.enable');
 const idleTarget=(await devtools.send('Target.getTargets')).targetInfos.find(t=>t.type==='service_worker'&&t.url==='chrome-extension://'+extensionId+'/background.mjs');assert.ok(idleTarget);
 await idleLifecycle.send('ServiceWorker.stopAllWorkers');
 const idleStopBy=Date.now()+10000;let idleRunning=true;do{idleRunning=(await devtools.send('Target.getTargets')).targetInfos.some(t=>t.targetId===idleTarget.targetId);if(!idleRunning)break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<idleStopBy);assert.equal(idleRunning,false,'the paired idle worker actually stopped');
 await idleLifecycle.send('ServiceWorker.startWorker',{scopeURL:'chrome-extension://'+extensionId+'/'});await worker.evaluate(()=>true);
 let view=await popup(vendorPage);await view.waitStatus('Paired for one export');assert.equal(await view.disabled(),false);
 const idleRestored=await worker.evaluate(()=>globalThis.chrome.storage.session.get(['pairing','transferStatus']));assert.deepEqual(idleRestored.pairing,idlePairing.pairing);assert.equal(await appPage.evaluate(()=>window.handoff.state),'ready');assert.equal(idleRestored.transferStatus.busy,false);assert.equal(await vendorPage.evaluate(()=>window.exportCount),0);assert.equal(await appPage.evaluate(()=>window.received.length),0);await view.close();await idleLifecycle.detach();
 console.log('PASS native extension: actual idle worker stop/start retains pairing and prior status, starts no export or delivery, and waits for an explicit command.');
 view=await start(csv);await view.close();
 view=await popup(vendorPage);assert.equal(await view.disabled(),true);assert.match(await view.status(),/may close this popup/);
 await vendorPage.evaluate(()=>window.finishExport());
 await view.waitStatus('KERDOS received the CSV');assert.match(await view.status(),/does not confirm saved prices/);
 assert.equal(await view.disabled(),false);
 let received=await appPage.evaluate(()=>window.received);assert.equal(received.length,1);assert.equal(received[0].text,csv);assert.equal(received[0].vendorId,'synthetic-vendor');assert.equal(received[0].evidence.sha256,createHash('sha256').update(csv).digest('hex'));
 await view.close();view=await popup(vendorPage);assert.match(await view.status(),/KERDOS received the CSV/);assert.equal(await vendorPage.evaluate(()=>window.exportCount),1);await view.close();
 console.log('PASS native extension: native action popup close/reopen, worker continuation, status recovery, provider DOM/Blob capture, exact bytes/SHA-256, original ownership and no replay.');
 await appPage.evaluate(()=>window.prepare());await pair();view=await start(changedCsv);await view.close();await vendorPage.evaluate(()=>window.finishExport());
 view=await popup(vendorPage);await view.waitStatus('KERDOS received the CSV');received=await appPage.evaluate(()=>window.received);assert.equal(received.length,2);assert.equal(received[1].text,changedCsv);assert.notEqual(received[0].evidence.sha256,received[1].evidence.sha256);await view.close();
 console.log('PASS native extension: a newly prepared transfer preserves changed synthetic prices as new source bytes; no saved-catalog-price claim.');
 // A wrong account gets useful guidance before the supplier export, and that
 // result remains visible when the native popup is reopened.
 await appPage.evaluate(()=>window.prepare());await pair();await vendorPage.evaluate(()=>{document.querySelector('button').textContent='Other Client (12345678)';});
 view=await popup(vendorPage);await view.click('export');await view.waitStatus('does not match your selected account');assert.equal(await appPage.evaluate(()=>window.handoff.state),'rejected');assert.equal(await vendorPage.evaluate(()=>window.exportCount),2);assert.equal(await appPage.evaluate(()=>window.received.length),2);assert.equal(await view.disabled(),false);await view.close();
 view=await popup(vendorPage);assert.match(await view.status(),/does not match your selected account/);await view.close();await vendorPage.evaluate(()=>{document.querySelector('button').textContent='Sample Client (12345678)';});
 console.log('PASS native extension: account mismatch stops before supplier export, gives safe retry guidance and persists across popup reopening.');
 // A verification screen must stop before an export, without reading its value.
 await appPage.evaluate(()=>window.prepare());await pair();await vendorPage.evaluate(()=>{const input=document.createElement('input');input.type='password';input.id='verification';document.body.append(input);});
 view=await popup(vendorPage);await view.click('export');await view.waitStatus('Your vendor requires sign-in or verification');assert.equal(await appPage.evaluate(()=>window.handoff.state),'rejected');assert.equal(await vendorPage.evaluate(()=>window.exportCount),2);assert.equal(await appPage.evaluate(()=>window.received.length),2);await view.close();await vendorPage.evaluate(()=>document.getElementById('verification').remove());
 // Advance only the synthetic receiver clock; no ten-minute wait or production change.
 await appPage.evaluate(()=>window.prepare());await pair();await appPage.evaluate(()=>{window.clock=Date.now()+11*60*1000;});
 view=await popup(vendorPage);await view.click('export');await view.waitStatus('KERDOS is no longer ready');assert.equal(await vendorPage.evaluate(()=>window.exportCount),2);assert.equal(await appPage.evaluate(()=>window.received.length),2);await view.close();await appPage.evaluate(()=>{window.clock=undefined;});
 console.log('PASS native extension: visible vendor verification and expired receiver stop before export; no new receive or saved-price claim.');
 // Cancellation after export authorization cannot retract the vendor action,
 // but it must fence the pending bytes from the receiver.
 await appPage.evaluate(()=>window.prepare());await pair();view=await start(csv);await appPage.evaluate(()=>window.handoff.cancel());await vendorPage.evaluate(()=>window.finishExport());
 await view.waitStatus('KERDOS did not accept the file');assert.equal(await appPage.evaluate(()=>window.received.length),2);assert.equal(await vendorPage.evaluate(()=>window.exportCount),3);await view.close();
 console.log('PASS native extension: cancellation during a vendor export rejects pending delivery without falsely claiming the export never started.');
 // Removing the exporting tab interrupts the native scripting operation. The
 // worker must report uncertainty/failure without admitting a file or retrying.
 await appPage.evaluate(()=>window.prepare());await pair();view=await start(csv);await view.close();await vendorPage.close();view=await popup(appPage);
 await view.waitStatus(['Transfer unavailable','The vendor export did not complete']);assert.equal(await appPage.evaluate(()=>window.received.length),2);await view.close();
 vendorPage=await context.newPage();await vendorPage.goto(vendorUrl);await appPage.evaluate(()=>window.prepare());await pair();view=await start(changedCsv);await vendorPage.evaluate(()=>window.finishExport());await view.waitStatus('KERDOS received the CSV');assert.equal(await appPage.evaluate(()=>window.received.length),3);assert.equal(await vendorPage.evaluate(()=>window.exportCount),1);await view.close();
 console.log('PASS native extension: exporting-tab interruption admits no file; a fresh preparation recovers with one delivery and no automatic replay.');
 // Force-stop only the worker in this disposable browser profile while the
 // provider is awaiting its Blob. Session status must survive without a replay.
 await appPage.evaluate(()=>window.prepare());await pair();view=await start(csv);await view.close();
 const lifecycle=await context.newCDPSession(appPage);await lifecycle.send('ServiceWorker.enable');
 const oldTarget=(await devtools.send('Target.getTargets')).targetInfos.find(t=>t.type==='service_worker'&&t.url==='chrome-extension://'+extensionId+'/background.mjs');assert.ok(oldTarget);
 await lifecycle.send('ServiceWorker.stopAllWorkers');
 const stoppedBy=Date.now()+10000;let oldRunning=true;do{oldRunning=(await devtools.send('Target.getTargets')).targetInfos.some(t=>t.targetId===oldTarget.targetId);if(!oldRunning)break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<stoppedBy);assert.equal(oldRunning,false,'the native worker actually stopped');
 await vendorPage.close();await lifecycle.send('ServiceWorker.startWorker',{scopeURL:'chrome-extension://'+extensionId+'/'});
 // Playwright's MV3 worker handle resumes across a worker stop/start.
 await worker.evaluate(()=>true);view=await popup(appPage);await view.waitStatus('The companion restarted during a transfer');assert.match(await view.status(),/result is unconfirmed/);assert.equal(await view.disabled(),false);assert.equal(await appPage.evaluate(()=>window.received.length),3);
 const recoveredState=await worker.evaluate(()=>globalThis.chrome.storage.session.get(['pairing','transferStatus']));assert.equal(recoveredState.pairing,undefined);assert.equal(recoveredState.transferStatus.busy,false);await view.close();
 vendorPage=await context.newPage();await vendorPage.goto(vendorUrl);view=await popup(vendorPage);assert.match(await view.status(),/nothing will be resent automatically/);assert.equal(await vendorPage.evaluate(()=>window.exportCount),0);await view.close();
 await appPage.evaluate(()=>window.prepare());await pair();view=await start(changedCsv);await vendorPage.evaluate(()=>window.finishExport());await view.waitStatus('KERDOS received the CSV');assert.equal(await appPage.evaluate(()=>window.received.length),4);assert.equal(await vendorPage.evaluate(()=>window.exportCount),1);await view.close();await lifecycle.detach();
 console.log('PASS native extension: forced worker stop/start retains unconfirmed status, clears pairing, admits no pending file, never auto-replays and allows one newly prepared transfer.');
 // The claim has already authorized one export. Closing its receiver before
 // the Blob exists must report failure, never retry or admit it to a new tab.
 await appPage.evaluate(()=>window.prepare());await pair();view=await start(csv);await view.close();await appPage.close();
 await vendorPage.evaluate(()=>window.finishExport());view=await popup(vendorPage);await view.waitStatus(['Transfer unavailable','KERDOS did not accept the file']);assert.match(await view.status(),/Transfer unavailable|KERDOS did not accept the file/);assert.equal(await vendorPage.evaluate(()=>window.exportCount),2);await view.close();
 appPage=await context.newPage();await appPage.goto(appUrl);await appPage.waitForFunction(()=>!!window.handoff);view=await popup(appPage);assert.match(await view.status(),/Transfer unavailable|KERDOS did not accept the file/);assert.equal(await appPage.evaluate(()=>window.received.length),0);assert.equal(await vendorPage.evaluate(()=>window.exportCount),2);await view.close();
 console.log('PASS native extension: receiver closed after claim rejects pending bytes, performs only the authorized export and never replays into a newly opened receiver.');
 await appPage.evaluate(()=>window.prepare());await pair();await appPage.close();view=await popup(vendorPage);await view.click('export');await view.waitStatus('Transfer unavailable');assert.equal(await vendorPage.evaluate(()=>window.exportCount),2);await view.close();
 // Exercise one app-side command without toolbar pair/export clicks. Native
 // management grants are confined to this disposable profile and declared
 // optional sites; this is not evidence of a human permission-prompt approval.
 for(const page of context.pages().filter(p=>p.url().startsWith(vendorOrigin)))await page.close();
 appPage=await context.newPage();await appPage.goto(appUrl);await appPage.waitForFunction(()=>!!window.refreshClient&&document.documentElement.getAttribute('data-kerdos-refresh')==='1');
 await appPage.locator('#refresh-prices').click();await appPage.waitForFunction(()=>!!window.refreshResult);assert.equal((await appPage.evaluate(()=>window.refreshResult)).outcome,'permission_required');assert.equal(await appPage.evaluate(()=>window.received.length),0);
 const management=await context.newPage();await management.goto('chrome://extensions/');
 for(const host of [appOrigin+'/*',vendorOrigin+'/*'])await management.evaluate(async({extensionId,host})=>{await globalThis.chrome.developerPrivate.addHostPermission(extensionId,host);},{extensionId,host});
 await management.close();
 // Existing same-host page navigated into the app without loading its content
 // script: enabling must attach the shipped channel without a page reload.
 const reconnectPage=await context.newPage();await reconnectPage.goto(appOrigin+'/unapproved-project/');await reconnectPage.waitForFunction(()=>!!window.refreshClient);
 await reconnectPage.evaluate(url=>{history.replaceState(null,'',url);window.availableEvents=0;window.refreshClient.watch(()=>window.availableEvents++);},appUrl+'?activation-check');
 assert.equal(await reconnectPage.evaluate(()=>window.refreshClient.available()),false);
 view=await popup(reconnectPage);await view.click('enable-refresh');await view.waitStatus('Refresh access enabled');await view.close();
 await reconnectPage.waitForFunction(()=>window.refreshClient.available()&&window.availableEvents===1);
 assert.equal(await reconnectPage.evaluate(()=>window.received.length),0,'enabling access never exports or delivers');
 view=await popup(reconnectPage);await view.click('enable-refresh');await view.waitStatus('Refresh access enabled');await view.close();
 assert.equal(await reconnectPage.evaluate(()=>window.availableEvents),1,'repeat enable cannot register another channel');
 await reconnectPage.close();
 assert.equal(await worker.evaluate(async origins=>globalThis.chrome.permissions.contains({origins}),[appOrigin+'/*',vendorOrigin+'/*']),true);
 vendorPage=await context.newPage();await vendorPage.goto(vendorUrl);
 // Recognition failures on a list already open must identify the failed gate
 // and never start an export, then allow a fresh verified user command.
 await vendorPage.locator('button').filter({hasText:'Sample Client (12345678)'}).evaluate(el=>{el.textContent='Other Client (12345678)';});
 await appPage.locator('#refresh-prices').click();await appPage.waitForFunction(()=>window.refreshResult?.outcome==='source_account_unverified');assert.equal(await vendorPage.evaluate(()=>window.exportCount),0);
 await vendorPage.locator('button').filter({hasText:'Other Client (12345678)'}).evaluate(el=>{el.textContent='Sample Client (12345678)';});
 await vendorPage.locator('[data-cy="list-banner-list-name-text"]').evaluate(el=>{el.textContent='Other List';});
 await appPage.locator('#refresh-prices').click();await appPage.waitForFunction(()=>window.refreshResult?.outcome==='source_list_unverified');assert.equal(await vendorPage.evaluate(()=>window.exportCount),0);assert.equal(await appPage.evaluate(()=>window.received.length),0);
 await vendorPage.locator('[data-cy="list-banner-list-name-text"]').evaluate(el=>{el.textContent='Example List';});
 // Start with the real Chrome source tab unselected, independently of
 // Playwright's renderer-focus emulation. Only host activation opens the gate.
 await appPage.bringToFront();
 assert.equal(await worker.evaluate(async({appUrl,vendorUrl})=>{const app=(await globalThis.chrome.tabs.query({url:appUrl}))[0];await globalThis.chrome.tabs.update(app.id,{active:true});return !(await globalThis.chrome.tabs.query({url:vendorUrl}))[0].active;},{appUrl,vendorUrl}),true,'app command begins with the native source tab unselected');
 await appPage.locator('#refresh-prices').click();await vendorPage.waitForFunction(()=>typeof window.finishExport==='function');await vendorPage.evaluate(()=>window.finishExport());
 await appPage.waitForFunction(()=>window.refreshResult?.outcome==='received_for_review');assert.equal(await appPage.evaluate(()=>window.received.length),1);assert.equal(await vendorPage.evaluate(()=>window.exportCount),1);assert.equal((await appPage.evaluate(()=>window.received[0])).text,csv);
 // Leave the actual dialog and checked prices option open. A fresh user
 // refresh must reuse them without confusing the page/modal Download buttons.
 await vendorPage.evaluate(()=>{window.finishExport=undefined;});
 await appPage.locator('#refresh-prices').click();await vendorPage.waitForFunction(()=>typeof window.finishExport==='function');await vendorPage.evaluate(()=>window.finishExport());
 await appPage.waitForFunction(()=>window.refreshResult?.outcome==='received_for_review');assert.equal(await appPage.evaluate(()=>window.received.length),2);assert.equal(await vendorPage.evaluate(()=>window.exportCount),2);assert.equal((await appPage.evaluate(()=>window.received[1])).text,csv);
 console.log('PASS native Refresh prices: a new explicit refresh reuses the open matching dialog and already checked Product Prices, exports once and delivers once.');
 const duplicate=await context.newPage();await duplicate.goto(vendorUrl);await appPage.locator('#refresh-prices').click();await appPage.waitForFunction(()=>!!window.refreshResult);assert.equal((await appPage.evaluate(()=>window.refreshResult)).outcome,'ambiguous_source');assert.equal(await duplicate.evaluate(()=>window.exportCount),0);assert.equal(await vendorPage.evaluate(()=>window.exportCount),2);await duplicate.close();await vendorPage.close();
 const reopenedPromise=context.waitForEvent('page');await appPage.locator('#refresh-prices').click();vendorPage=await reopenedPromise;
 // Chrome can begin an extension-created navigation before Playwright attaches
 // its route interception. DNS is blocked for this profile; once attached,
 // fulfill the same saved URL with the synthetic response, never a real site.
 await vendorPage.goto(vendorUrl);await vendorPage.waitForFunction(()=>typeof window.finishExport==='function',null,{polling:100,timeout:25000}).catch(async error=>{throw Error('Reopen check: '+JSON.stringify({url:vendorPage.url(),page:await vendorPage.evaluate(()=>({state:document.readyState,exports:window.exportCount,ready:typeof window.finishExport})),result:await appPage.evaluate(()=>window.refreshResult),status:await worker.evaluate(()=>globalThis.chrome.storage.session.get('transferStatus'))})+' '+error.message);});await vendorPage.evaluate(()=>window.finishExport());await appPage.waitForFunction(()=>window.refreshResult?.outcome==='received_for_review');assert.equal(await appPage.evaluate(()=>window.received.length),3);assert.equal(await vendorPage.evaluate(()=>window.exportCount),1);
 await vendorPage.close();vendorRequiresVerification=true;const loginPromise=context.waitForEvent('page');await appPage.locator('#refresh-prices').click();const login=await loginPromise;await login.goto(vendorUrl);await appPage.waitForFunction(()=>!!window.refreshResult);assert.equal((await appPage.evaluate(()=>window.refreshResult)).outcome,'verification_needed');assert.equal(await appPage.evaluate(()=>window.received.length),3);await login.close();vendorRequiresVerification=false;
 // Model completed supplier sign-in by restoring the synthetic selected list.
 // The browser session changing alone must not resume the paused export.
 const beforeRecovery=await appPage.evaluate(()=>window.received);
 vendorPage=await context.newPage();await vendorPage.goto(vendorUrl);
 assert.deepEqual(await appPage.evaluate(()=>window.received),beforeRecovery);assert.equal(await vendorPage.evaluate(()=>window.exportCount),0);
 assert.equal((await worker.evaluate(()=>globalThis.chrome.storage.session.get('transferStatus'))).transferStatus.busy,false);
 await appPage.locator('#refresh-prices').click();await vendorPage.waitForFunction(()=>typeof window.finishExport==='function');await vendorPage.evaluate(()=>window.finishExport());
 await appPage.waitForFunction(()=>window.refreshResult?.outcome==='received_for_review');assert.equal(await appPage.evaluate(()=>window.received.length),4);assert.equal(await vendorPage.evaluate(()=>window.exportCount),1);assert.equal((await appPage.evaluate(()=>window.received[3])).text,csv);
 const beforeRevocation=await appPage.evaluate(()=>window.received);
 assert.equal(await worker.evaluate(origins=>globalThis.chrome.permissions.remove({origins}),[vendorOrigin+'/*']),true);await appPage.locator('#refresh-prices').click();await appPage.waitForFunction(()=>!!window.refreshResult);
 assert.deepEqual(await appPage.evaluate(()=>window.received),beforeRevocation);assert.equal(await vendorPage.evaluate(()=>window.exportCount),1);assert.equal((await appPage.evaluate(()=>window.refreshResult)).outcome,'permission_required');
 // Restore only the already-declared host grant in this disposable profile.
 // No supplier content or real credential is involved, and granting does not retry.
 const restoreAccess=await context.newPage();await restoreAccess.goto('chrome://extensions/');
 await restoreAccess.evaluate(async({extensionId,host})=>{await globalThis.chrome.developerPrivate.addHostPermission(extensionId,host);},{extensionId,host:vendorOrigin+'/*'});await restoreAccess.close();
 assert.deepEqual(await appPage.evaluate(()=>window.received),beforeRevocation);assert.equal(await vendorPage.evaluate(()=>window.exportCount),1);
 await vendorPage.evaluate(value=>{window.csv=value;window.finishExport=undefined;},changedCsv);
 await appPage.locator('#refresh-prices').click();await vendorPage.waitForFunction(()=>typeof window.finishExport==='function');await vendorPage.evaluate(()=>window.finishExport());
 await appPage.waitForFunction(()=>window.refreshResult?.outcome==='received_for_review');assert.equal(await appPage.evaluate(()=>window.received.length),5);assert.equal(await vendorPage.evaluate(()=>window.exportCount),2);assert.equal((await appPage.evaluate(()=>window.received[4])).text,changedCsv);
 assert.deepEqual(await appPage.evaluate(()=>window.received.slice(0,4)),beforeRevocation,'new explicit retrieval preserves all prior received artifacts');
 console.log('PASS native lifecycle recovery: verification and permission stops preserve prior artifacts; restored synthetic sign-in or declared host access never auto-resumes; a fresh explicit app refresh captures once and preserves changed source bytes. No real supplier session or database acceptance is implied.');
 console.log('PASS native Refresh prices: scoped optional-access denial/grant/revocation, actual app channel -> worker -> automatic pairing/claim/export/delivery, no popup clicks, duplicate-tab refusal, saved-route reopening and sign-in pause. Synthetic profile and vendor pages only.');
 assert.deepEqual(unexpected,[],'no fixture request reached an outside origin');
 console.log('PASS native extension: closed receiver blocks supplier export; production manifest remains narrow. Optional grants above are explicit native test-profile fixtures; actual human permission approval/activeTab gesture, supplier authentication, installed-user acceptance, database saves and original storage checks remain open.');
}finally{await context?.close();await rm(scratch,{recursive:true,force:true});}
