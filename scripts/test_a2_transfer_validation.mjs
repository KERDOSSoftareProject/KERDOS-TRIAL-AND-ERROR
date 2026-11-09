import assert from 'node:assert/strict';
import {createCompanionHandoff,COMPANION_CHANNEL} from '../src/services/companion-handoff.js';
import {createVendorConnectService} from '../src/services/vendor-connect.js';
import {createSupabaseBackend} from '../src/backend/supabase.js';
const selection={organizationId:'client',vendorId:'vendor',adapterKey:'provider',portalOrigin:'https://supplier.example',account:'Account',list:'List'};
const artifact={origin:selection.portalOrigin,base64:btoa('Code,Price\nITEM,12\n')};
function fixture(onValidate){
 const listeners=new Set(),messages=[],received=[];let now=1000,expire;
 const target={location:{origin:'https://kerdossoftareproject.github.io'},addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn),postMessage:m=>messages.push(m)};
 const h=createCompanionHandoff({target,selection,onValidate,onReceive:p=>received.push(p),now:()=>now,schedule:fn=>{expire=fn;return 1;},unschedule:()=>{}});
 const send=async data=>{await Promise.all([...listeners].map(fn=>fn({source:target,origin:target.location.origin,data:{channel:COMPANION_CHANNEL,requestId:crypto.randomUUID(),...data}})));return messages.at(-1);};
 const pair=async()=>{const r=await send({type:'pair'});assert.equal(r.ok,true);return r.ticket;};
 return {h,send,pair,received,messages,expire:()=>{now=h.expiresAt;expire();}};
}
{
 const f=fixture(async()=>false);assert.equal((await f.send({type:'pair'})).ok,false);assert.equal(f.h.state,'rejected');assert.equal(f.received.length,0);f.h.cancel();
}
{
 let revision=1;const f=fixture(async()=>revision===1);const t=await f.pair();revision=3; // cancel then reopen; old state alone would look usable again
 assert.equal((await f.send({type:'claim',nonce:t.nonce,claimId:crypto.randomUUID()})).ok,false);assert.equal(f.messages.some(m=>m.outcome==='ready_for_export'),false);assert.equal(f.received.length,0);f.h.cancel();
}
{
 let current=true;const phases=[];const f=fixture(async phase=>{phases.push(phase);return current;});const t=await f.pair(),id=crypto.randomUUID();assert.equal((await f.send({type:'claim',nonce:t.nonce,claimId:id})).ok,true);current=false;
 assert.equal((await f.send({type:'deliver',nonce:t.nonce,claimId:id,artifact})).ok,false);assert.equal(f.received.length,0);assert.deepEqual(phases,['pair','export','receive']);f.h.cancel();
}
{
 const f=fixture(async()=>{throw Error('unavailable private diagnostics');});assert.equal((await f.send({type:'pair'})).ok,false);assert.equal(f.received.length,0);assert.ok(!JSON.stringify(f.messages).includes('diagnostics'));f.h.cancel();
}
{
 const phases=[];const f=fixture(async phase=>{phases.push(phase);if(phase==='receive')throw Error('private receive diagnostics');return true;});const t=await f.pair(),id=crypto.randomUUID();await f.send({type:'claim',nonce:t.nonce,claimId:id});
 assert.equal((await f.send({type:'deliver',nonce:t.nonce,claimId:id,artifact})).ok,false);assert.deepEqual(phases,['pair','export','receive']);assert.equal(f.received.length,0);assert.equal(f.h.state,'rejected');assert.ok(!JSON.stringify(f.messages).includes('diagnostics'));f.h.cancel();
}
{
 const phases=[];const f=fixture(async phase=>{phases.push(phase);return true;});const t=await f.pair(),id=crypto.randomUUID();
 assert.equal((await f.send({type:'claim',nonce:t.nonce,claimId:id})).ok,true);
 assert.equal((await f.send({type:'deliver',nonce:t.nonce,claimId:id,artifact})).ok,true);assert.equal(f.received.length,1);assert.deepEqual(phases,['pair','export','receive']);
 await f.send({type:'deliver',nonce:t.nonce,claimId:id,artifact});assert.equal(f.received.length,1);f.h.cancel();
}
for(const terminal of ['cancel','expire','none']){
 let release,started=0;const gate=new Promise(resolve=>{release=resolve;});
 const f=fixture(async phase=>{if(phase==='export'){started++;await gate;}return true;});const t=await f.pair(),id=crypto.randomUUID();
 const pending=f.send({type:'claim',nonce:t.nonce,claimId:id});while(!started)await Promise.resolve();
 assert.equal((await f.send({type:'claim',nonce:t.nonce,claimId:crypto.randomUUID()})).ok,false);assert.equal(started,1,'claim must reserve before awaiting validation');
 if(terminal==='cancel')f.h.cancel();if(terminal==='expire')f.expire();release();await pending;
 assert.equal(f.messages.filter(m=>m.outcome==='ready_for_export').length,terminal==='none'?1:0);assert.equal(f.received.length,0);f.h.cancel();
}
{
 let release,started=false,current=true;const f=fixture(async phase=>{if(phase==='receive'){started=true;await new Promise(resolve=>{release=resolve;});}return current;});const t=await f.pair(),id=crypto.randomUUID();await f.send({type:'claim',nonce:t.nonce,claimId:id});
 const pending=f.send({type:'deliver',nonce:t.nonce,claimId:id,artifact});while(!started)await new Promise(resolve=>setImmediate(resolve));assert.equal((await f.send({type:'deliver',nonce:t.nonce,claimId:id,artifact})).ok,false);current=false;release();await pending;assert.equal(f.received.length,0);f.h.cancel();
}
{
 let current=true;const f=fixture(async()=>current);const t=await f.pair();current=false;assert.equal((await f.send({type:'deliver',nonce:t.nonce,artifact})).ok,false,'legacy unclaimed delivery must not bypass admission validation');assert.equal(f.received.length,0);f.h.cancel();
}
const calls=[];const input={...selection,requestId:'request',revision:4,password:'must-not-forward'};
const service=createVendorConnectService({vendorConnect:{verifySelection:async value=>{calls.push(value);return true;}}});assert.equal(await service.verifySelection(input),true);assert.deepEqual(Object.keys(calls[0]).sort(),['account','adapterKey','list','organizationId','portalOrigin','requestId','revision','vendorId'].sort());
for(const revision of [undefined,-1,1.5,Number.MAX_SAFE_INTEGER+1])await assert.rejects(service.verifySelection({...input,revision}));assert.equal(calls.length,1);
for(const result of [false,null,'true',{}])await assert.rejects(createVendorConnectService({vendorConnect:{verifySelection:async()=>result}}).verifySelection(input),/no longer available/);
await assert.rejects(createVendorConnectService({vendorConnect:{verifySelection:async()=>{throw Error('private');}}}).verifySelection(input),/no longer available/);
const prior=globalThis.window;globalThis.window={localStorage:{removeItem(){}},sessionStorage:{}};
try{let rpc;const provider=createSupabaseBackend({url:'https://example.invalid',anonKey:'public-test-key'},()=>({rpc:async(name,args)=>{rpc={name,args};return {data:true};}}));assert.equal(await provider.vendorConnect.verifySelection(input),true);assert.deepEqual(rpc,{name:'kerdos_verify_pending_vendor_transfer',args:{p_organization_id:'client',p_vendor_id:'vendor',p_request_id:'request',p_adapter_key:'provider',p_transfer_revision:4,p_account_label:'Account',p_list_label:'List',p_portal_origin:'https://supplier.example'}});}finally{if(prior===undefined)delete globalThis.window;else globalThis.window=prior;}
console.log('PASS pending transfer validation: cancellation/reopen, pre-export/pre-admission gates, denied/offline checks, atomic competing claims, cancellation/expiry during validation, duplicate delivery, legacy admission gate and safe RPC payload; controlled windows only');
