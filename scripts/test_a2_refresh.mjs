import assert from 'node:assert/strict';
import vm from 'node:vm';
import {readFileSync} from 'node:fs';
import {createPortableTransferRunner} from '../companion/chrome/core/transfer-runner.mjs';
import {createRefreshSourceResolver} from '../companion/chrome/refresh-source.mjs';
import {registerCompanionWorker} from '../companion/chrome/background.mjs';
import {createCompanionRefreshClient} from '../src/services/companion-refresh.js';
const nonce='11111111-2222-3333-4444-555555555555';
const ticket={nonce,protocolVersion:2,expiresAt:Date.now()+60000,organizationId:'org',vendorId:'vendor',adapterKey:'example',portalOrigin:'https://vendor.example',account:'Account',list:'List'};
function portable({permission=true,source='ready',pairNonce=nonce,reserve=true}={}){
 let pairing,status;const events=[];
 const host={validTarget:id=>['app','source'].includes(id),getTarget:async id=>({id}),isReceiver:t=>t.id==='app',supportsSource:t=>t.id==='source',readStatus:async()=>status,writeStatus:async s=>{status=s;},readPairing:async()=>pairing,savePairing:async p=>{pairing=p;},clearPairing:async()=>{pairing=undefined;},refreshAccess:async()=>permission,pair:async()=>{events.push('pair');return {ok:true,ticket:{...ticket,nonce:pairNonce}};},resolveSource:async p=>{assert.equal(p.receiverId,'app');events.push('resolve');return {outcome:source,targetId:'source'};},reserve:async()=>{events.push('claim');return {ok:reserve,outcome:reserve?'ready_for_export':'rejected'};},retrieve:async()=>{events.push('export');return {outcome:'export_captured',artifact:{base64:'Q29kZSxQcmljZQpBLDEK',origin:ticket.portalOrigin}};},deliver:async()=>{events.push('deliver');return {ok:true,outcome:'received_for_review'};}};
 return {runner:createPortableTransferRunner(host),events,host};
}
{
 const {runner,events}=portable();assert.equal((await runner.run('refresh','app',{expectedNonce:nonce})).outcome,'received_for_review');assert.deepEqual(events,['pair','resolve','claim','export','deliver']);
 await assert.rejects(runner.run('refresh','app',{expectedNonce:'invalid'}));
}
for(const args of [{permission:false},{pairNonce:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'},{source:'ambiguous_source'},{source:'verification_needed'},{reserve:false}]){
 const {runner,events}=portable(args);const result=await runner.run('refresh','app',{expectedNonce:nonce});assert.notEqual(result.outcome,'received_for_review');assert.ok(!events.includes('export'));assert.ok(!events.includes('deliver'));
 if(args.permission===false)assert.deepEqual(events,[],'denied host access cannot pair or touch a vendor page');
}
{
 const {runner,host,events}=portable();let finish;host.resolveSource=()=>new Promise(resolve=>{finish=resolve;});const first=runner.run('refresh','app',{expectedNonce:nonce});while(!finish)await new Promise(resolve=>setImmediate(resolve));assert.equal((await runner.run('refresh','app',{expectedNonce:nonce})).busy,true);finish({outcome:'ready',targetId:'source'});await first;assert.equal(events.filter(e=>e==='export').length,1,'concurrent refresh has one owner');
}
const provider={key:'example',origin:'https://vendor.example',refreshPath:/^\/lists\/[a-z]+$/,execute:()=>{}};
function browser({granted=true,tabs=[{id:2,url:'https://vendor.example/lists/one'}],proofs={2:{outcome:'selection_verified',path:'/lists/one'}},stored={},openedProof={outcome:'selection_verified',path:'/lists/one'}}={}){
 const events=[];const values={...stored};
 const api={permissions:{contains:async()=>granted},tabs:{query:async()=>tabs,create:async args=>{events.push(['open',args]);return {id:3,url:args.url};},get:async id=>({id,url:'https://vendor.example/lists/one'}),update:async(id,args)=>events.push(['focus',id,args])},storage:{local:{get:async key=>({[key]:values[key]}),set:async args=>{events.push(['save-route']);Object.assign(values,args);}}},scripting:{executeScript:async args=>{assert.equal(args.args[0].inspectOnly,true,'discovery must never export');events.push(['inspect',args.target.tabId]);return [{result:proofs[args.target.tabId]||(args.target.tabId===3?openedProof:null)}];}}};
 return {api,events,values,resolve:createRefreshSourceResolver(api,[provider],{pause:async()=>{}})};
}
const pairing={...ticket,receiverId:1};const scope='refresh-route:'+JSON.stringify(['org','vendor','example','Account','List']);
{
 const b=browser();assert.deepEqual(await b.resolve(pairing),{outcome:'ready',targetId:2});assert.equal(b.values[scope],'/lists/one');assert.equal((await b.resolve({...pairing,vendorId:'other'})).outcome,'ready');assert.equal(Object.keys(b.values).length,2,'route hints have distinct client/vendor scopes');
}
{
 const b=browser({granted:false});assert.equal((await b.resolve(pairing)).outcome,'permission_required');assert.deepEqual(b.events,[]);
}
{
 const b=browser({tabs:[{id:2,url:'https://vendor.example/lists/one'},{id:4,url:'https://vendor.example/lists/one'}],proofs:{2:{outcome:'selection_verified',path:'/lists/one'},4:{outcome:'selection_verified',path:'/lists/one'}}});assert.equal((await b.resolve(pairing)).outcome,'ambiguous_source');assert.ok(!b.events.some(e=>e[0]==='save-route'));
}
{
 const b=browser({tabs:[],stored:{[scope]:'/lists/one'}});assert.deepEqual(await b.resolve(pairing),{outcome:'ready',targetId:3});assert.deepEqual(b.events[0],['open',{url:'https://vendor.example/lists/one',active:true}]);
 const other=browser({tabs:[],stored:{[scope]:'/lists/one'}});assert.equal((await other.resolve({...pairing,organizationId:'other-org'})).outcome,'source_selection_required');assert.deepEqual(other.events[0],['open',{url:'https://vendor.example',active:true}],'another client cannot reuse a saved list route');
}
// A reopened portal may defer its account header until its tab is selected.
// Discovery must allow rendering before inspection, never bypass identity proof.
{
 const b=browser({tabs:[],stored:{[scope]:'/lists/one'}});let selected=false,clock=0;
 b.api.tabs.create=async args=>{selected=args.active;return {id:3,url:args.url};};
 b.api.scripting.executeScript=async args=>{assert.equal(args.args[0].inspectOnly,true);return [{result:selected?{outcome:'selection_verified',path:'/lists/one'}:{outcome:'account_mismatch'}}];};
 const resolve=createRefreshSourceResolver(b.api,[provider],{now:()=>clock,pause:async ms=>{clock+=ms;}});
 assert.deepEqual(await resolve({...pairing,expiresAt:20000}),{outcome:'ready',targetId:3},'saved-route discovery can render its account header before verification');
}
for(const [failure,outcome] of [['account_mismatch','source_account_unverified'],['list_mismatch','source_list_unverified'],['verification_needed','verification_needed']]){
 const b=browser({tabs:[],stored:{[scope]:'/lists/one'},openedProof:{outcome:failure}});let clock=0;
 const resolve=createRefreshSourceResolver(b.api,[provider],{now:()=>clock,pause:async ms=>{clock+=ms;}});
 assert.deepEqual(await resolve({...pairing,expiresAt:20000}),{outcome},'foreground rendering never bypasses saved account/list or verification checks');
 assert.ok(!b.events.some(e=>e[0]==='save-route'),'failed reopened page cannot replace the verified route');
}
{
 const secondScope='refresh-route:'+JSON.stringify(['other-org','vendor','example','Other Account','Other List']);
 const b=browser({tabs:[],stored:{[scope]:'/lists/one'}});
 const second={...pairing,organizationId:'other-org',account:'Other Account',list:'Other List'};
 assert.equal((await b.resolve(second)).outcome,'source_selection_required');
 assert.deepEqual(b.events[0],['open',{url:'https://vendor.example',active:true}]);
 assert.equal(b.values[secondScope],undefined,'another client has no inherited verified list');
 assert.equal(b.values[scope],'/lists/one','the first client keeps its verified route');
 const signedIn=browser({tabs:[{id:2,url:'https://vendor.example/lists/one'}],proofs:{2:{outcome:'selection_mismatch'}}});
 assert.equal((await signedIn.resolve(second)).outcome,'source_selection_required');
 assert.ok(!signedIn.events.some(e=>e[0]==='save-route'),'a different signed-in account cannot seed the second client route');
}
for(const path of ['https://evil.example/lists/one','//evil.example/lists/one','/lists/one?token=secret','/lists/one#private','/unapproved']){
 const b=browser({tabs:[],stored:{[scope]:path}});assert.equal((await b.resolve(pairing)).outcome,'source_selection_required');assert.equal(b.events[0][1].url,provider.origin);
}
{
 const b=browser({tabs:[],stored:{[scope]:'/lists/one'},openedProof:{outcome:'verification_needed'}});assert.equal((await b.resolve(pairing)).outcome,'verification_needed');assert.ok(b.events.some(e=>e[0]==='focus'));
}
// Discovery failures on an already-open list retain only fixed stage codes.
for(const [failure,outcome] of [['account_mismatch','source_account_unverified'],['list_mismatch','source_list_unverified'],['page_unavailable','source_inspection_failed']]){
 const b=browser({proofs:{2:{outcome:failure,message:'PRIVATE PAGE CONTENT'}},stored:{[scope]:'/lists/one'}});
 assert.deepEqual(await b.resolve(pairing),{outcome});assert.ok(!b.events.some(e=>['open','save-route'].includes(e[0])),'failed recognition cannot reopen or cache an unverified list');
 const p=portable({source:outcome}),result=await p.runner.run('refresh','app',{expectedNonce:nonce});
 assert.equal(result.outcome,outcome);assert.match(result.message,/No export was started/);assert.ok(!result.message.includes('PRIVATE'));assert.deepEqual(p.events,['pair','resolve']);assert.equal(await p.host.readPairing(),undefined);
}
{
 const b=browser();b.api.scripting.executeScript=async()=>{throw Error('PRIVATE INJECTION DETAILS');};assert.deepEqual(await b.resolve(pairing),{outcome:'source_inspection_failed'});
 const empty=browser();empty.api.scripting.executeScript=async()=>[];assert.deepEqual(await empty.resolve(pairing),{outcome:'source_inspection_failed'});
 const other=browser({tabs:[{id:2,url:'https://vendor.example/lists/one'},{id:4,url:'https://vendor.example/lists/two'}],proofs:{2:{outcome:'account_mismatch'},4:{outcome:'selection_verified',path:'/lists/two'}}});assert.deepEqual(await other.resolve(pairing),{outcome:'ready',targetId:4},'verified match wins over another failed tab');
 const multiple=browser({tabs:[{id:2,url:'https://vendor.example/lists/one'},{id:4,url:'https://vendor.example/lists/two'}],proofs:{2:{outcome:'account_mismatch'},4:{outcome:'list_mismatch'}}});assert.deepEqual(await multiple.resolve(pairing),{outcome:'source_selection_required'},'do not choose a failed candidate arbitrarily');
}

// Same-origin control channel: page supplies nonce only, never receiver/vendor IDs.
const listeners=new Set(),posted=[],runtime=[];const attrs=new Map();
const app={top:null,location:{origin:'https://kerdossoftareproject.github.io',href:'https://kerdossoftareproject.github.io/KERDOS-TRIAL-AND-ERROR/'},document:{documentElement:{getAttribute:k=>attrs.get(k),setAttribute:(k,v)=>attrs.set(k,v)}},addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn),postMessage:m=>posted.push(m)};app.top=app;
let siteAccess=false;
vm.runInNewContext(readFileSync('companion/chrome/app-channel.js','utf8'),{window:app,location:app.location,document:app.document,URL,chrome:{runtime:{sendMessage:async m=>{runtime.push(m);return m.action==='status'?{readyProviders:siteAccess?['example']:[]}:m.action==='setup'?{outcome:'setup_opened'}:{outcome:'received_for_review',message:'Received'};}}}});
const dispatch=async(data,extra={})=>{for(const listener of [...listeners])await listener({source:app,origin:app.location.origin,data,...extra});};
const client=createCompanionRefreshClient(app);
await new Promise(resolve=>setImmediate(resolve));
assert.equal(client.installed(),true);assert.equal(client.available(),false);
assert.equal((await client.refresh(nonce)).outcome,'refresh_unavailable');
const setup=client.setup('example');await dispatch(posted.at(-1));await dispatch(posted.at(-1));assert.equal((await setup).outcome,'setup_opened');
assert.deepEqual(runtime.map(m=>m.action),['status','setup']);
assert.equal(runtime.at(-1).adapterKey,'example');
const readiness=[];const unwatch=client.watch((ready,installed)=>readiness.push([ready,installed]));
siteAccess=true;await app.__kerdosRefreshChannelInstalled();await dispatch(posted.at(-1));
assert.deepEqual(readiness,[[false,true],[true,true]]);
assert.equal(client.available('example'),true);assert.equal(client.available('other'),false);
assert.equal((await client.refresh(nonce,'other')).outcome,'refresh_unavailable');
runtime.length=0;
const pending=client.refresh(nonce);const command=posted.at(-1);assert.deepEqual(Object.keys(command).sort(),['channel','nonce','requestId','type']);await dispatch(command,{origin:'https://evil.example'});assert.equal(runtime.length,0);await dispatch(command);assert.deepEqual(JSON.parse(JSON.stringify(runtime)),[{type:'kerdos-companion-refresh',action:'refresh',nonce}]);await dispatch(posted.at(-1));assert.equal((await pending).outcome,'received_for_review');
siteAccess=false;await app.__kerdosRefreshChannelInstalled();await dispatch(posted.at(-1));assert.deepEqual(readiness.at(-1),[false,true]);assert.equal(client.available(),false);unwatch();client.dispose();
// Worker does not accept control from popup/vendor/subframes or arbitrary IDs.
const registered=[],setupTabs=[];const api={runtime:{id:'self',onMessage:{addListener:fn=>registered.push(fn)},getURL:path=>'chrome-extension://self/'+path},tabs:{create:async options=>{setupTabs.push(options);}},storage:{session:{get:async()=>({}),set:async()=>{},remove:async()=>{}}}};
const worker=registerCompanionWorker(api);const sender={id:'self',frameId:0,url:app.location.href,tab:{id:7,url:app.location.href}};const msg={type:'kerdos-companion-refresh',action:'refresh',nonce};
for(const bad of [{...sender,id:'other'},{...sender,frameId:1},{...sender,url:'https://evil.example/'},{...sender,tab:{id:7,url:'https://evil.example/'}},{...sender,tab:null}])assert.equal(worker.refreshListener(msg,bad,()=>assert.fail('unauthorized response')),false);
assert.equal(worker.refreshListener({...msg,nonce:'bad'},sender,()=>{}),false);
const setupCommand={type:msg.type,action:'setup',adapterKey:'us-foods-moxe'};
assert.equal(worker.refreshListener(setupCommand,{...sender,frameId:1},()=>assert.fail('unauthorized setup')),false);
assert.equal(worker.refreshListener({...setupCommand,adapterKey:'unregistered'},sender,()=>assert.fail('unknown setup')),false);
assert.equal((await new Promise(resolve=>worker.refreshListener(setupCommand,sender,resolve))).outcome,'setup_opened');
assert.deepEqual(setupTabs,[{url:'chrome-extension://self/popup.html?setup=us-foods-moxe',openerTabId:7}]);
console.log('PASS A2 refresh: one command pairs/claims/exports/delivers; denied, stale, concurrent and ambiguous attempts do not export; route scope, verification and page/worker sender boundaries.');
// Optional access is requested directly by the explicit popup click, for only
// the app host and the registered provider selected in that popup.
const enableEvents=new Map(),popupStatus={textContent:''};let grantCall;
const enable={addEventListener:(event,fn)=>enableEvents.set(event,fn)},select={value:'example',appendChild:()=>{}};
const elements={export:{addEventListener:()=>{}},pair:{addEventListener:()=>{}},status:popupStatus,'enable-refresh':enable,provider:select};
const popupSource=readFileSync('companion/chrome/popup.mjs','utf8').replace(/^import .*;$/gm,'');
vm.runInNewContext(popupSource,{approvedKerdosTab:url=>url===app.location.href,providers:[provider],document:{getElementById:id=>elements[id],createElement:()=>({})},chrome:{tabs:{query:async()=>[]},runtime:{sendMessage:async()=>({message:'Ready'})},storage:{onChanged:{addListener:()=>{}}},permissions:{request:args=>{grantCall=args;return Promise.resolve(true);}}}});
enableEvents.get('click')();assert.deepEqual(JSON.parse(JSON.stringify(grantCall)),{origins:['https://kerdossoftareproject.github.io/*','https://vendor.example/*']});await new Promise(resolve=>setImmediate(resolve));assert.match(popupStatus.textContent,/Refresh access enabled/);
console.log('PASS one-time popup access request: direct user click, selected provider origins only, no wildcard-wide host access.');
// Enabling access reconnects only approved top-level app tabs; it never starts
// a transfer. Permission denial touches no tabs. A closed tab gives fallback.
for(const condition of ['granted','denied','closed']){
 const clicks=new Map(),status={textContent:''},calls=[];
 const elements={export:{addEventListener(){}},pair:{addEventListener(){}},status,'enable-refresh':{addEventListener:(event,fn)=>clicks.set(event,fn)},provider:{value:'example',appendChild(){}}};
 vm.runInNewContext(popupSource,{approvedKerdosTab:url=>url===app.location.href,providers:[provider],document:{getElementById:id=>elements[id],createElement:()=>({})},chrome:{runtime:{sendMessage:async()=>({message:'Ready'})},storage:{onChanged:{addListener(){}}},permissions:{request:()=>{calls.push('permission');return Promise.resolve(condition!=='denied');}},tabs:{query:async query=>{assert.deepEqual(JSON.parse(JSON.stringify(query)),{url:app.location.origin+'/*'});calls.push('tabs');return [{id:1,url:app.location.href},{id:2,url:app.location.origin+'/other-project/'},{id:3,url:provider.origin}];}},scripting:{executeScript:async args=>{calls.push(JSON.parse(JSON.stringify(args)));if(condition==='closed')throw Error('tab closed');}}}});
 clicks.get('click')();assert.deepEqual(calls,['permission'],'permission requested synchronously before tab access');
 await new Promise(resolve=>setImmediate(resolve));
 if(condition==='denied'){assert.deepEqual(calls,['permission']);assert.match(status.textContent,/not granted/);}
 else{assert.deepEqual(calls,['permission','tabs',{target:{tabId:1,frameIds:[0]},files:['app-channel.js']}]);assert.match(status.textContent,condition==='closed'?/Reload KERDOS/:/Return to KERDOS/);}
}
const beforeListeners=listeners.size;
const beforeRuntime=runtime.length;
vm.runInNewContext(readFileSync('companion/chrome/app-channel.js','utf8'),{window:app,location:app.location,document:app.document,URL,chrome:{runtime:{sendMessage:async()=>assert.fail('reconnection must not export')}}});
assert.equal(listeners.size,beforeListeners,'reinjection cannot add a second runtime command listener');
assert.deepEqual(runtime.slice(beforeRuntime).map(message=>message.action),['status'],'reinjection rechecks access without exporting');
console.log('PASS access activation: scoped app tabs reconnect without export, denial is inert, closed-tab fallback, and repeated channel injection is idempotent.');
