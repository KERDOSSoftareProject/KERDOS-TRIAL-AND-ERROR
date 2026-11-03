import assert from 'node:assert/strict';
import {createPortableTransferRunner} from '../companion/chrome/core/transfer-runner.mjs';
// Deliberately no browser, URLs, numeric tab IDs or supplier DOM in this host.
function fixture(name,{ready=true,outcome='export_captured',expired=false}={}){
 const log=[],state={};let retrievals=0,finish;
 const receiverId='receiver:'+name,sourceId='source:'+name;
 const ticket={protocolVersion:2,organizationId:'org:'+name,vendorId:'vendor:'+name,adapterKey:'adapter:'+name,portalOrigin:'https://'+name+'.example',account:'Account '+name,list:'List '+name,nonce:'nonce:'+name,expiresAt:expired?99:1000,receiverId:'untrusted'};
 const artifact={base64:'Q29kZSxQcmljZQpJVEVNLDEyCg==',origin:ticket.portalOrigin};
 const host={
  validTarget:id=>typeof id==='string'&&id.startsWith('receiver:')||typeof id==='string'&&id.startsWith('source:'),
  getTarget:async id=>({id,kind:id===receiverId?'receiver':'source',adapterKey:ticket.adapterKey}),
  isReceiver:target=>target.id===receiverId,
  supportsSource:(target,pairing)=>target.id===sourceId&&target.adapterKey===pairing.adapterKey,
  readStatus:async()=>structuredClone(state.status),writeStatus:async value=>{state.status=structuredClone(value);},
  readPairing:async()=>structuredClone(state.pairing),savePairing:async value=>{state.pairing=structuredClone(value);},clearPairing:async()=>{delete state.pairing;log.push('clear');},
  pair:async()=>({ok:true,ticket}),
  reserve:async(pairing,id)=>{assert.equal(pairing.receiverId,receiverId);assert.equal(pairing.organizationId,'org:'+name);assert.equal(id,'claim:'+name);log.push('reserve');return {ok:ready,outcome:ready?'ready_for_export':'denied'};},
  retrieve:async(target,pairing)=>{assert.equal(state.pairing,undefined,'consume pairing before supplier operation');assert.equal(target.id,sourceId);assert.equal(pairing.list,ticket.list);log.push('retrieve');retrievals++;await new Promise(resolve=>{finish=resolve;});return {outcome,artifact,diagnostic:'private adapter diagnostic'};},
  deliver:async(pairing,id,value)=>{assert.equal(pairing.receiverId,receiverId);assert.equal(id,'claim:'+name);assert.deepEqual(value,artifact);log.push('deliver');return {ok:true,outcome:'received_for_review'};},
 };
 const runner=createPortableTransferRunner(host,{now:()=>100,randomUUID:()=> 'claim:'+name});
 return {runner,host,state,log,receiverId,sourceId,release:()=>finish(),started:()=>retrievals};
}
assert.equal(globalThis.chrome,undefined);assert.equal(globalThis.document,undefined);
const a=fixture('first'),b=fixture('second');
for(const f of [a,b]){await f.runner.run('pair',f.receiverId);assert.equal(f.state.pairing.receiverId,f.receiverId);}
const first=a.runner.run('export',a.sourceId);while(!a.started())await new Promise(resolve=>setImmediate(resolve));
assert.equal((await a.runner.run('export',a.sourceId)).busy,true);assert.equal(a.started(),1);assert.equal(b.started(),0);assert.ok(b.state.pairing);
const second=b.runner.run('export',b.sourceId);while(!b.started())await new Promise(resolve=>setImmediate(resolve));
a.release();b.release();for(const result of await Promise.all([first,second]))assert.match(result.message,/does not confirm saved prices/);
for(const f of [a,b]){assert.deepEqual(f.log.slice(-4),['reserve','clear','retrieve','deliver']);assert.equal(f.started(),1);const again=await f.runner.run('export',f.sourceId);assert.match(again.message,/Transfer unavailable/);assert.equal(f.started(),1);}
for(const options of [{ready:false},{expired:true}]){const f=fixture('blocked',options);await f.runner.run('pair',f.receiverId);const result=await f.runner.run('export',f.sourceId);assert.equal(f.started(),0);assert.doesNotMatch(result.message,/received the CSV/);}
const f=fixture('verification',{outcome:'verification_needed'});await f.runner.run('pair',f.receiverId);const verification=f.runner.run('export',f.sourceId);while(!f.started())await new Promise(resolve=>setImmediate(resolve));f.release();assert.match((await verification).message,/requires sign-in or verification/);assert.equal(f.log.includes('deliver'),false);
// Known outcomes get safe actionable text, consume pairing, and never deliver.
for(const [outcome,expected] of [
 ['account_mismatch',/selected account/],['list_mismatch',/selected list/],['list_changed',/selected list/],['open_selected_list',/selected vendor pricing list/],['selection_required',/Choose an account/],['csv_format_required',/CSV format/],['capture_busy',/already running/],['capture_unavailable',/could not capture/],['unsupported_encoding',/unsupported text encoding/],['invalid_csv',/not a supported CSV/],['page_changed',/could not be verified/],['page_unavailable',/could not be verified/],['ambiguous_control',/could not be verified/],['wrong_origin',/selected for this connection/],['execution_unavailable',/current companion/],['unsupported_adapter',/current companion/],['private error details',/did not complete/],['toString',/did not complete/],[{},/did not complete/],
]){
 const held=fixture('guided',{outcome});await held.runner.run('pair',held.receiverId);const attempt=held.runner.run('export',held.sourceId);while(!held.started())await new Promise(resolve=>setImmediate(resolve));held.release();const result=await attempt;
 assert.match(result.message,expected);assert.match(result.message,/No file was sent/);assert.equal(result.busy,false);assert.equal(held.state.pairing,undefined);assert.equal(held.log.includes('deliver'),false);assert.ok(!JSON.stringify(held.state).includes('private'));assert.deepEqual(await held.runner.status(),result);
 await held.runner.run('export',held.sourceId);assert.equal(held.started(),1,'failure never automatically retries or retains a reusable pairing');
}
f.state.status={busy:true,message:'Interrupted'};f.state.pairing={receiverId:f.receiverId};const restored=createPortableTransferRunner(f.host);assert.match((await restored.status()).message,/unconfirmed/);assert.equal(f.state.pairing,undefined);assert.equal(f.started(),1);
await assert.rejects(restored.run('export',12),/Invalid companion command/);
console.log('PASS portable runner: two independent hosts/providers, string targets, exact reserved receiver, one-use claim, competing commands, denied/expired checks, verification stop, restart uncertainty and no browser APIs; synthetic host contract only');
