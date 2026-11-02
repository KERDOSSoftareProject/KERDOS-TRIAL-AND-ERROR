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
const csv='Product Number,Product Description,Product Price\nSYNTHETIC,Sample Product,1.20\n';
const changedCsv=csv.replace('1.20','1.35');
let context;
try{
 await cp(resolve('companion/chrome'),extension,{recursive:true});
 const manifest=JSON.parse(await readFile(join(extension,'manifest.json'),'utf8'));
 assert.deepEqual(manifest.permissions,['activeTab','scripting','storage']);assert.equal(manifest.host_permissions,undefined);
 // Run the exact shipped manifest: no fixture host grants or extra permissions.
 context=await chromium.launchPersistentContext(join(scratch,'profile'),{channel:'chromium',headless:process.env.KERDOS_BROWSER_HEADED!=='1',acceptDownloads:true,args:['--enable-unsafe-extension-debugging','--disable-extensions-except='+extension,'--load-extension='+extension]});
 context.setDefaultTimeout(15000);
 const devtools=await context.browser().newBrowserCDPSession();
 let protocolId=0;const replies=new Map();
 devtools.on('Target.receivedMessageFromTarget',event=>{const message=JSON.parse(event.message),key=event.sessionId+':'+message.id;const pending=replies.get(key);if(pending){replies.delete(key);if(message.error)pending.reject(Error(message.error.message));else pending.resolve(message.result);}});
 const call=(sessionId,method,params={})=>new Promise((resolve,reject)=>{const id=++protocolId,key=sessionId+':'+id;replies.set(key,{resolve,reject});devtools.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})}).catch(error=>{replies.delete(key);reject(error);});});

 const unexpected=[];
 const source=await readFile('src/services/companion-handoff.js','utf8');
 const app=`<!doctype html><title>Synthetic KERDOS receiver</title><script type="module">
 import {createCompanionHandoff} from '/handoff.mjs';
 window.received=[];window.prepare=()=>{window.handoff?.cancel();window.handoff=createCompanionHandoff({selection:{organizationId:'synthetic-client',vendorId:'synthetic-vendor',adapterKey:'us-foods-moxe',portalOrigin:'${vendorOrigin}',account:'Sample Client',list:'Example List'},now:()=>window.clock??Date.now(),onReceive:async p=>{window.received.push({text:await p.file.text(),organizationId:p.organizationId,vendorId:p.vendorId,evidence:p.evidence});}});};window.prepare();
 </script>`;
 const vendor=`<!doctype html><title>Synthetic vendor</title><p>MY LIST</p><button>Sample Client (12345678)</button><span data-cy="list-banner-list-name-text">Example List</span>
 <button id="open" onclick="document.getElementById('dialog').hidden=false">Download</button>
 <div id="dialog" role="dialog" hidden><p>Download Example List Select Format CSV</p><button onclick="document.getElementById('prices').hidden=false">Download Options</button><label id="prices" hidden>Product Prices<input type="checkbox" aria-label="Product Prices"></label><button id="download">Download</button></div>
 <script>window.exportCount=0;document.getElementById('download').onclick=()=>{window.exportCount++;window.finishExport=()=>{const url=URL.createObjectURL(new Blob([window.csv],{type:'text/csv'}));const a=document.createElement('a');a.href=url;a.download='Example List.csv';a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);};};</script>`;
 await context.route('**/*',async route=>{
  const url=new URL(route.request().url());
  if(url.protocol==='chrome-extension:')return route.continue();
  if(url.origin===appOrigin)return route.fulfill({contentType:url.pathname==='/handoff.mjs'?'text/javascript':'text/html',body:url.pathname==='/handoff.mjs'?source:app});
  if(url.origin===vendorOrigin)return route.fulfill({contentType:'text/html',body:vendor});
  unexpected.push(url.origin);await route.abort();
 });
 let worker=context.serviceWorkers()[0]||await context.waitForEvent('serviceworker');
 const extensionId=new URL(worker.url()).host;
 const granted=await worker.evaluate(()=>globalThis.chrome.permissions.getAll());assert.deepEqual(granted.origins||[],[]);assert.deepEqual([...granted.permissions].sort(),['activeTab','scripting','storage'].sort());
 await worker.evaluate(()=>{globalThis.__runtimeCommands=[];globalThis.chrome.runtime.onMessage.addListener((m,s)=>{globalThis.__runtimeCommands.push({action:m?.action,url:s.url,hasTab:!!s.tab});});});
 const appPage=await context.newPage();await appPage.goto(appUrl);await appPage.waitForFunction(()=>!!window.handoff);
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
 await pair();let view=await start(csv);await view.close();
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
 // A verification screen must stop before an export, without reading its value.
 await appPage.evaluate(()=>window.prepare());await pair();await vendorPage.evaluate(()=>{const input=document.createElement('input');input.type='password';input.id='verification';document.body.append(input);});
 view=await popup(vendorPage);await view.click('export');await view.waitStatus('Your vendor requires sign-in or verification');assert.equal(await vendorPage.evaluate(()=>window.exportCount),2);assert.equal(await appPage.evaluate(()=>window.received.length),2);await view.close();await vendorPage.evaluate(()=>document.getElementById('verification').remove());
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
 await appPage.evaluate(()=>window.prepare());await pair();await appPage.close();view=await popup(vendorPage);await view.click('export');await view.waitStatus('Transfer unavailable');assert.equal(await vendorPage.evaluate(()=>window.exportCount),1);await view.close();
 assert.deepEqual(unexpected,[],'no fixture request reached an outside origin');
 console.log('PASS native extension: closed receiver blocks supplier export; production manifest remains narrow. No fixture host grants; actual human activeTab user gesture, supplier authentication, installed-user acceptance, database saves and original storage checks remain open.');
}finally{await context?.close();await rm(scratch,{recursive:true,force:true});}
