import assert from 'node:assert/strict';
import {registerCompanionWorker} from '../companion/chrome/background.mjs';
const ticket={protocolVersion:2,tabId:1,nonce:'one-use-transfer',expiresAt:Date.now()+600000,adapterKey:'us-foods-moxe',portalOrigin:'https://order.usfoods.com',account:'Sample Client',list:'Example List'};
let mode,api,worker,storage,events,commands,exports,finishExport,ui,counter=0;
const controls=()=>Object.fromEntries(['export','pair','status'].map(id=>[id,{disabled:false,textContent:'',addEventListener(event,fn){this[event]=fn;}}]));
const tick=()=>new Promise(resolve=>setImmediate(resolve));
globalThis.document={getElementById:id=>ui[id]};
async function load(){ui=controls();await import('../companion/chrome/popup.mjs?test='+counter++);await tick();return ui;}
async function scenario(nextMode,overrides={}){
 mode=nextMode;storage={pairing:{...ticket,...overrides}};events=new Set();commands=[];exports=0;finishExport=null;
 const runtimeListeners=new Set();
 api={tabs:{update:async(id,args)=>{assert.equal(id,2);assert.deepEqual(args,{active:true});assert.equal(commands[0]?.type,'kerdos-claim');},query:async()=>[{id:2}],get:async id=>({id,active:true,url:mode==='pair'?'https://kerdossoftareproject.github.io/KERDOS-TRIAL-AND-ERROR/':'https://order.usfoods.com/desktop/lists/view/selected'}),sendMessage:async(id,msg)=>{commands.push(msg);assert.equal(id,1);if(mode==='closed')throw Error('No receiving tab');if(msg.type==='kerdos-claim')return mode==='rejected'?{ok:false}:{ok:true,outcome:'ready_for_export'};assert.equal(msg.claimId,commands[0].claimId);return mode==='delivery-rejected'?{ok:false}:{ok:true,outcome:'received_for_review'};}},
 storage:{session:{get:async key=>({[key]:storage[key]&&structuredClone(storage[key])}),remove:async key=>{delete storage[key];},set:async value=>{Object.assign(storage,structuredClone(value));for(const fn of events)fn(Object.fromEntries(Object.entries(value).map(([key,v])=>[key,{newValue:structuredClone(v)}])),'session');}},onChanged:{addListener:fn=>events.add(fn)}},
 scripting:{executeScript:async spec=>{if(mode==='pair'){assert.equal(spec.func.name,'pairKerdosTab');return [{result:{ok:true,ticket}}];}exports++;assert.equal(spec.world,'MAIN');assert.deepEqual(spec.args,[{account:ticket.account,list:ticket.list,capture:true}]);if(mode==='interrupted')await new Promise(resolve=>{finishExport=resolve;});return [{result:mode==='verification'?{outcome:'verification_needed'}:{outcome:'export_captured',artifact:{origin:ticket.portalOrigin,base64:'YQ=='}}}];}},
 runtime:{id:'companion',getURL:path=>'chrome-extension://companion/'+path,onMessage:{addListener:fn=>runtimeListeners.add(fn)},sendMessage:message=>new Promise(resolve=>{for(const fn of runtimeListeners)fn(message,{id:'companion',url:'chrome-extension://companion/popup.html'},resolve);})}};
 worker=registerCompanionWorker(api);globalThis.chrome=api;await worker.runner.status();return load();
}
try{
 for(const condition of ['closed','rejected']){const page=await scenario(condition);await page.export.click();assert.equal(exports,0);assert.doesNotMatch(page.status.textContent,/received the CSV/);assert.equal(page.export.disabled,false);assert.equal(page.pair.disabled,false);}
 let page=await scenario('success',{expiresAt:Date.now()-1});await page.export.click();assert.equal(exports,0);assert.equal(commands.length,0);
 page=await scenario('success',{protocolVersion:undefined});await page.export.click();assert.equal(exports,0);assert.equal(commands.length,0);assert.equal(storage.pairing,undefined);assert.match(page.status.textContent,/Refresh KERDOS/);
 page=await scenario('success');await page.export.click();assert.equal(exports,1);assert.deepEqual(commands.map(m=>m.type),['kerdos-claim','kerdos-deliver']);assert.match(commands[0].claimId,/^[0-9a-f-]{36}$/);assert.equal(storage.pairing,undefined);assert.match(page.status.textContent,/does not confirm saved prices/);
 for(const result of ['verification','delivery-rejected']){page=await scenario(result);await page.export.click();assert.equal(exports,1);assert.equal(storage.pairing,undefined);if(result==='verification'){assert.equal(commands.length,1);assert.match(page.status.textContent,/Complete it directly with the vendor/);}else assert.match(page.status.textContent,/did not accept/);}
 // Popup disposal does not own execution. A reopened view observes busy then result.
 page=await scenario('interrupted');const pending=page.export.click();while(!finishExport)await tick();assert.equal(storage.pairing,undefined);assert.equal(page.export.disabled,true);events.clear();const reopened=await load();assert.equal(reopened.export.disabled,true);assert.match(reopened.status.textContent,/may close this popup/);
 await reopened.export.click();assert.equal(exports,1,'competing popup cannot repeat export');assert.equal(reopened.export.disabled,true);
 finishExport();await pending;assert.deepEqual(commands.map(m=>m.type),['kerdos-claim','kerdos-deliver']);assert.match(reopened.status.textContent,/does not confirm saved prices/);assert.equal(reopened.export.disabled,false);
 events.clear();const resultView=await load();assert.match(resultView.status.textContent,/KERDOS received the CSV/);assert.equal(exports,1,'opening result never replays');
 // Restarted executor retains uncertainty and removes one-use metadata, not auto-resume.
 storage.transferStatus={busy:true,message:'Delivering'};storage.pairing={...ticket};const recovered=registerCompanionWorker({...api,runtime:{...api.runtime,onMessage:{addListener(){}}}});const status=await recovered.runner.status();assert.equal(status.busy,false);assert.match(status.message,/result is unconfirmed/);assert.equal(storage.pairing,undefined);assert.equal(exports,1);assert.deepEqual(Object.keys(storage).sort(),['transferStatus'],'CSV and account secrets are never persisted as a job');
 // React to the terminal status immediately, before its storage promise resolves.
 // The preceding command must already have released execution ownership.
 page=await scenario('success');let repairPair,finishPair;const execute=api.scripting.executeScript;
 api.scripting.executeScript=async spec=>{if(spec.func.name==='pairKerdosTab')await new Promise(resolve=>{finishPair=resolve;});return execute(spec);};
 events.add(changes=>{if(changes.transferStatus?.newValue?.message?.includes('KERDOS received the CSV')&&!repairPair){mode='pair';repairPair=worker.runner.run('pair',2);}});
 await page.export.click();assert.ok(repairPair);for(let i=0;i<10&&!finishPair;i++)await tick();assert.equal(typeof finishPair,'function','immediate re-pair starts after terminal publication');assert.equal((await worker.runner.status()).busy,true,'older completion cannot clear the new command lock');
 await worker.runner.run('export',2);assert.equal(exports,1,'a third command cannot bypass the new pairing lock');finishPair();await repairPair;assert.equal(storage.pairing?.tabId,2);assert.equal((await worker.runner.status()).busy,false);assert.match(storage.transferStatus.message,/Paired for one export/);
 // Only this extension popup can direct the worker; no content or external sender.
 const denied=()=>assert.fail('untrusted command replied');for(const sender of [{id:'other',url:api.runtime.getURL('popup.html')},{id:'companion',url:api.runtime.getURL('popup.html'),tab:{id:2}},{id:'companion',url:'https://order.usfoods.com/'}])assert.equal(worker.listener({type:'kerdos-companion-control',action:'export',tabId:2},sender,denied),false);
 assert.equal(worker.listener({type:'kerdos-companion-control',action:'unknown'},{id:'companion',url:api.runtime.getURL('popup.html')},denied),false);
 await assert.rejects(worker.runner.run('export',-1),/Invalid companion command/);
 page=await scenario('pair');await page.pair.click();assert.equal(storage.pairing.tabId,2);assert.match(page.status.textContent,/Paired for one export/);
 console.log('PASS companion worker + actual popup: popup closure/reopen, completion ownership/immediate re-pair, busy/result persistence, one export winner, restart uncertainty/no replay, sender guard, pairing, closed/rejected/expired receiver, exact claim, verification guidance and unchanged receipt semantics. Controlled browser APIs; installed acceptance remains open.');
}finally{delete globalThis.document;delete globalThis.chrome;}
