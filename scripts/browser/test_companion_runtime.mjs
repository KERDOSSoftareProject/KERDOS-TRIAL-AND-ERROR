// Real Chromium extension/runtime; synthetic pages and transport only.
// No live supplier, signed-in KERDOS, Supabase or purchasing acceptance.
import assert from 'node:assert/strict';
import {mkdtemp,cp,readFile,writeFile,rm} from 'node:fs/promises';
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
 // Test fixture grants allow automated action opening. They NEVER enter the shipped ZIP.
 manifest.host_permissions=[appOrigin+'/*',vendorOrigin+'/*'];
 await writeFile(join(extension,'manifest.json'),JSON.stringify(manifest));
 context=await chromium.launchPersistentContext(join(scratch,'profile'),{channel:'chromium',headless:process.env.KERDOS_BROWSER_HEADED!=='1',acceptDownloads:true,args:['--disable-extensions-except='+extension,'--load-extension='+extension]});
 context.setDefaultTimeout(15000);
 const devtools=await context.browser().newBrowserCDPSession();
 let protocolId=0;const replies=new Map();
 devtools.on('Target.receivedMessageFromTarget',event=>{const message=JSON.parse(event.message),key=event.sessionId+':'+message.id;const pending=replies.get(key);if(pending){replies.delete(key);if(message.error)pending.reject(Error(message.error.message));else pending.resolve(message.result);}});
 const call=(sessionId,method,params={})=>new Promise((resolve,reject)=>{const id=++protocolId,key=sessionId+':'+id;replies.set(key,{resolve,reject});devtools.send('Target.sendMessageToTarget',{sessionId,message:JSON.stringify({id,method,params})}).catch(error=>{replies.delete(key);reject(error);});});

 const unexpected=[];
 const source=await readFile('src/services/companion-handoff.js','utf8');
 const app=`<!doctype html><title>Synthetic KERDOS receiver</title><script type="module">
 import {createCompanionHandoff} from '/handoff.mjs';
 window.received=[];window.prepare=()=>{window.handoff?.cancel();window.handoff=createCompanionHandoff({selection:{organizationId:'synthetic-client',vendorId:'synthetic-vendor',adapterKey:'us-foods-moxe',portalOrigin:'${vendorOrigin}',account:'Sample Client',list:'Example List'},onReceive:async p=>{window.received.push({text:await p.file.text(),organizationId:p.organizationId,vendorId:p.vendorId,evidence:p.evidence});}});};window.prepare();
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
 await worker.evaluate(()=>{globalThis.__runtimeCommands=[];globalThis.chrome.runtime.onMessage.addListener((m,s)=>{globalThis.__runtimeCommands.push({action:m?.action,url:s.url,hasTab:!!s.tab});});});
 const appPage=await context.newPage();await appPage.goto(appUrl);await appPage.waitForFunction(()=>!!window.handoff);
 const vendorPage=await context.newPage();await vendorPage.goto(vendorUrl);
 async function popup(target){
  await target.bringToFront();await worker.evaluate(()=>globalThis.chrome.action.openPopup());
  const until=Date.now()+15000;let info;
  do{info=(await devtools.send('Target.getTargets')).targetInfos.find(t=>t.url==='chrome-extension://'+extensionId+'/popup.html');if(info)break;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<until);
  assert.ok(info,'native action popup target was not created');
  const {sessionId}=await devtools.send('Target.attachToTarget',{targetId:info.targetId,flatten:false});
  const evaluate=async expression=>{const value=await call(sessionId,'Runtime.evaluate',{expression,returnByValue:true,awaitPromise:true,userGesture:true});if(value.exceptionDetails)throw Error(value.exceptionDetails.text);return value.result.value;};
  return {
   click:id=>evaluate(`document.getElementById(${JSON.stringify(id)}).click()`),
   status:()=>evaluate("document.getElementById('status').textContent"),
   disabled:()=>evaluate("document.getElementById('export').disabled"),
   async waitStatus(text){const end=Date.now()+15000;do{if((await this.status()).includes(text))return;await new Promise(resolve=>setTimeout(resolve,100));}while(Date.now()<end);throw Error('Unexpected popup status: '+await this.status());},
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
 await appPage.evaluate(()=>window.prepare());await pair();await appPage.close();view=await popup(vendorPage);await view.click('export');await view.waitStatus('Transfer unavailable');assert.equal(await vendorPage.evaluate(()=>window.exportCount),2);await view.close();
 assert.deepEqual(unexpected,[],'no fixture request reached an outside origin');
 console.log('PASS native extension: closed receiver blocks supplier export; production manifest remains narrow. Synthetic fixture host grants only; actual activeTab user gesture, supplier authentication, installed-user acceptance, database saves and original storage checks remain open.');
}finally{await context?.close();await rm(scratch,{recursive:true,force:true});}
