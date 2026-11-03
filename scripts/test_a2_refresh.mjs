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
 const b=browser({tabs:[],stored:{[scope]:'/lists/one'}});assert.deepEqual(await b.resolve(pairing),{outcome:'ready',targetId:3});assert.deepEqual(b.events[0],['open',{url:'https://vendor.example/lists/one',active:false}]);
 const other=browser({tabs:[],stored:{[scope]:'/lists/one'}});assert.equal((await other.resolve({...pairing,organizationId:'other-org'})).outcome,'source_selection_required');assert.deepEqual(other.events[0],['open',{url:'https://vendor.example',active:true}],'another client cannot reuse a saved list route');
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
// Same-origin control channel: page supplies nonce only, never receiver/vendor IDs.
const listeners=new Set(),posted=[],runtime=[];const attrs=new Map();
const app={top:null,location:{origin:'https://kerdossoftareproject.github.io',href:'https://kerdossoftareproject.github.io/KERDOS-TRIAL-AND-ERROR/'},document:{documentElement:{getAttribute:k=>attrs.get(k),setAttribute:(k,v)=>attrs.set(k,v)}},addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn),postMessage:m=>posted.push(m)};app.top=app;
vm.runInNewContext(readFileSync('companion/chrome/app-channel.js','utf8'),{window:app,location:app.location,document:app.document,URL,chrome:{runtime:{sendMessage:async m=>{runtime.push(m);return {outcome:'received_for_review',message:'Received'};}}}});
const dispatch=async(data,extra={})=>{for(const listener of [...listeners])await listener({source:app,origin:app.location.origin,data,...extra});};
const client=createCompanionRefreshClient(app);assert.equal(client.available(),true);const pending=client.refresh(nonce);const command=posted.at(-1);assert.deepEqual(Object.keys(command).sort(),['channel','nonce','requestId','type']);await dispatch(command,{origin:'https://evil.example'});assert.equal(runtime.length,0);await dispatch(command);assert.deepEqual(JSON.parse(JSON.stringify(runtime)),[{type:'kerdos-companion-refresh',action:'refresh',nonce}]);await dispatch(posted.at(-1));assert.equal((await pending).outcome,'received_for_review');client.dispose();
// Worker does not accept control from popup/vendor/subframes or arbitrary IDs.
const registered=[];const api={runtime:{id:'self',onMessage:{addListener:fn=>registered.push(fn)},getURL:path=>'chrome-extension://self/'+path},storage:{session:{get:async()=>({}),set:async()=>{},remove:async()=>{}}}};
const worker=registerCompanionWorker(api);const sender={id:'self',frameId:0,url:app.location.href,tab:{id:7,url:app.location.href}};const msg={type:'kerdos-companion-refresh',action:'refresh',nonce};
for(const bad of [{...sender,id:'other'},{...sender,frameId:1},{...sender,url:'https://evil.example/'},{...sender,tab:{id:7,url:'https://evil.example/'}},{...sender,tab:null}])assert.equal(worker.refreshListener(msg,bad,()=>assert.fail('unauthorized response')),false);
assert.equal(worker.refreshListener({...msg,nonce:'bad'},sender,()=>{}),false);
console.log('PASS A2 refresh: one command pairs/claims/exports/delivers; denied, stale, concurrent and ambiguous attempts do not export; route scope, verification and page/worker sender boundaries.');
// Optional access is requested directly by the explicit popup click, for only
// the app host and the registered provider selected in that popup.
const enableEvents=new Map(),popupStatus={textContent:''};let grantCall;
const enable={addEventListener:(event,fn)=>enableEvents.set(event,fn)},select={value:'example',appendChild:()=>{}};
const elements={export:{addEventListener:()=>{}},pair:{addEventListener:()=>{}},status:popupStatus,'enable-refresh':enable,provider:select};
const popupSource=readFileSync('companion/chrome/popup.mjs','utf8').replace("import {providers} from './providers.mjs';",'');
vm.runInNewContext(popupSource,{providers:[provider],document:{getElementById:id=>elements[id],createElement:()=>({})},chrome:{tabs:{query:async()=>[]},runtime:{sendMessage:async()=>({message:'Ready'})},storage:{onChanged:{addListener:()=>{}}},permissions:{request:args=>{grantCall=args;return Promise.resolve(true);}}}});
enableEvents.get('click')();assert.deepEqual(JSON.parse(JSON.stringify(grantCall)),{origins:['https://kerdossoftareproject.github.io/*','https://vendor.example/*']});await Promise.resolve();assert.match(popupStatus.textContent,/Refresh access enabled/);
console.log('PASS one-time popup access request: direct user click, selected provider origins only, no wildcard-wide host access.');
