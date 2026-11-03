import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createCompanionHandoff,COMPANION_CHANNEL} from '../src/services/companion-handoff.js';
import {pairKerdosTab,approvedKerdosTab} from '../companion/chrome/bridge.mjs';
const selection={organizationId:'client-a',vendorId:'vendor-a',adapterKey:'us-foods-moxe',portalOrigin:'https://order.usfoods.com',account:'Sample Client',list:'Example List'};
const artifact={origin:'https://order.usfoods.com',base64:btoa('Product Number,Product Description,Product Price\nA,Sample,1.2\n'),vendorId:'attacker-vendor',organizationId:'other-client'};
let time=1000,received=[],messages=[],listeners=new Set();
const target={location:{origin:'https://kerdossoftareproject.github.io'},addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn),postMessage(message,origin){assert.equal(origin,this.location.origin);messages.push(message);queueMicrotask(()=>{for(const fn of [...listeners])void fn({source:target,origin,data:message});});}};
const dispatch=async(message,changes={})=>{await Promise.all([...listeners].map(fn=>fn({source:target,origin:target.location.origin,data:{channel:COMPANION_CHANNEL,requestId:crypto.randomUUID(),...message},...changes})));};
const begin=(overrides={})=>createCompanionHandoff({target,selection,onReceive:payload=>received.push(payload),now:()=>time,...overrides});
let handoff=begin();await dispatch({type:'pair'});let ticket=messages.at(-1).ticket;assert.equal(ticket.vendorId,'vendor-a');
await dispatch({type:'deliver',nonce:ticket.nonce,artifact},{origin:'https://evil.example'});assert.equal(received.length,0);
await dispatch({type:'deliver',nonce:'wrong',artifact});assert.equal(received.length,0);
await Promise.all([dispatch({type:'deliver',nonce:ticket.nonce,artifact}),dispatch({type:'deliver',nonce:ticket.nonce,artifact})]);
assert.equal(received.length,1);assert.equal(received[0].vendorId,'vendor-a');assert.equal(received[0].organizationId,'client-a');assert.equal(await received[0].file.text(),atob(artifact.base64));assert.match(received[0].evidence.sha256,/^[0-9a-f]{64}$/);assert.equal(received[0].evidence.assurance,'user_approved_browser_session');
assert.ok(messages.some(m=>m.outcome==='received_for_review'));handoff.cancel();
for(const invalid of [{...artifact,origin:'https://wrong.example'},{...artifact,base64:btoa('<html>login,again\n')},{...artifact,base64:'invalid!'},{...artifact,base64:'A'.repeat(6990509)}]){
 handoff=begin();await dispatch({type:'pair'});ticket=messages.at(-1).ticket;await dispatch({type:'deliver',nonce:ticket.nonce,artifact:invalid});assert.equal(received.length,1);assert.equal(messages.at(-1).ok,false);handoff.cancel();
}
handoff=begin();await dispatch({type:'pair'});ticket=messages.at(-1).ticket;time=ticket.expiresAt;await dispatch({type:'deliver',nonce:ticket.nonce,artifact});assert.equal(received.length,1);handoff.cancel();
time=1000;let release;const digestGate=new Promise(r=>{release=r;});
handoff=begin({cryptoApi:{randomUUID:()=>crypto.randomUUID(),subtle:{digest:async(...args)=>{await digestGate;return crypto.subtle.digest(...args);}}}});await dispatch({type:'pair'});ticket=messages.at(-1).ticket;
const pending=dispatch({type:'deliver',nonce:ticket.nonce,artifact});handoff.cancel();release();await pending;assert.equal(received.length,1);
// Lifecycle events are terminal and distinguish expiry/rejection from a receipt.
const states=[];let expiry,clears=0;
time=1000;handoff=begin({onStateChange:s=>states.push(s),schedule:fn=>{expiry=fn;return 7;},unschedule:id=>{assert.equal(id,7);clears++;}});
assert.equal(handoff.state,'ready');time=handoff.expiresAt;expiry();assert.equal(handoff.state,'expired');assert.deepEqual(states,['expired']);assert.equal(clears,1);await dispatch({type:'pair'});assert.equal(messages.at(-1).ok,false);handoff.cancel();assert.deepEqual(states,['expired']);
time=1000;states.length=0;handoff=begin({onStateChange:s=>states.push(s),onReceive:async()=>{throw Error('Import review unavailable');}});await dispatch({type:'pair'});ticket=messages.at(-1).ticket;await dispatch({type:'deliver',nonce:ticket.nonce,artifact});assert.deepEqual(states,['receiving','rejected']);assert.equal(handoff.state,'rejected');assert.equal(messages.at(-1).ok,false);await dispatch({type:'pair'});assert.equal(messages.at(-1).ok,false);handoff.cancel();
states.length=0;let finishReview;handoff=begin({onStateChange:s=>states.push(s),onReceive:()=>new Promise(resolve=>{finishReview=resolve;})});await dispatch({type:'pair'});ticket=messages.at(-1).ticket;const reviewPending=dispatch({type:'deliver',nonce:ticket.nonce,artifact});while(!finishReview)await new Promise(resolve=>setImmediate(resolve));assert.equal(handoff.state,'receiving');handoff.cancel();finishReview();await reviewPending;assert.deepEqual(states,['receiving','cancelled']);assert.equal(messages.at(-1).outcome,'received_for_review','Already-admitted review is not falsely described as unsent');
states.length=0;handoff=begin({onStateChange:s=>states.push(s),onReceive:async()=>{}});await dispatch({type:'pair'});ticket=messages.at(-1).ticket;await dispatch({type:'deliver',nonce:ticket.nonce,artifact});assert.deepEqual(states,['receiving','received']);assert.equal(handoff.state,'received');handoff.cancel();assert.deepEqual(states,['receiving','received']);
// Expiry during hashing cannot enter the importer or regress to rejection later.
states.length=0;let finishDigest;handoff=begin({onStateChange:s=>states.push(s),schedule:fn=>{expiry=fn;return 8;},unschedule:()=>{},cryptoApi:{randomUUID:()=>crypto.randomUUID(),subtle:{digest:async(...args)=>{await new Promise(resolve=>{finishDigest=resolve;});return crypto.subtle.digest(...args);}}}});await dispatch({type:'pair'});ticket=messages.at(-1).ticket;const digestPending=dispatch({type:'deliver',nonce:ticket.nonce,artifact});time=handoff.expiresAt;expiry();finishDigest();await digestPending;assert.deepEqual(states,['expired']);assert.equal(received.length,1);handoff.cancel();
console.log('PASS transfer lifecycle: proactive expiry, timer disposal, receiving/rejected/received outcomes, terminal cancellation and expiry during hashing');
// Real isolated bridge function against the app listener, including sender guard.
time=1000;handoff=begin();globalThis.window=target;globalThis.location=target.location;const runtimeListeners=new Set();globalThis.chrome={runtime:{id:'test-extension',onMessage:{addListener:fn=>runtimeListeners.add(fn),removeListener:fn=>runtimeListeners.delete(fn)}}};
const paired=await pairKerdosTab();assert.equal(paired.ok,true);assert.equal(runtimeListeners.size,1);
const runtime=[...runtimeListeners][0];assert.equal(runtime({type:'kerdos-deliver'}, {id:'other-extension'},()=>assert.fail()),false);
const ack=await new Promise(resolve=>{assert.equal(runtime({type:'kerdos-deliver',nonce:paired.ticket.nonce,artifact},{id:'test-extension'},resolve),true);});
assert.equal(ack.outcome,'received_for_review');assert.equal(received.length,2);
await pairKerdosTab();assert.equal(runtimeListeners.size,1);handoff.cancel();delete globalThis.__kerdosCompanionListener;delete globalThis.window;delete globalThis.location;delete globalThis.chrome;
assert.ok(approvedKerdosTab('https://kerdossoftareproject.github.io/KERDOS-TRIAL-AND-ERROR/'));
for(const url of ['https://evil.example/KERDOS-TRIAL-AND-ERROR/','https://kerdossoftareproject.github.io/another-app/','https://kerdossoftareproject.github.io/KERDOS-TRIAL-AND-ERROR-phishing','not a URL'])assert.equal(approvedKerdosTab(url),false);
// Pre-export claim is atomic, nonce-bound and cannot be bypassed by legacy delivery.
time=1000;const beforeClaim=received.length;handoff=begin();await dispatch({type:'pair'});ticket=messages.at(-1).ticket;assert.equal(ticket.protocolVersion,2);const claimId=crypto.randomUUID();
await dispatch({type:'claim',nonce:'wrong',claimId});assert.equal(messages.at(-1).ok,false);
await dispatch({type:'claim',nonce:ticket.nonce,claimId});assert.equal(messages.at(-1).outcome,'ready_for_export');assert.equal(handoff.state,'exporting');
await dispatch({type:'claim',nonce:ticket.nonce,claimId:crypto.randomUUID()});assert.equal(messages.at(-1).ok,false);await dispatch({type:'pair'});assert.equal(messages.at(-1).ok,false);
for(const id of [undefined,crypto.randomUUID()]){await dispatch({type:'deliver',nonce:ticket.nonce,claimId:id,artifact});assert.equal(messages.at(-1).ok,false);assert.equal(received.length,beforeClaim);}
await dispatch({type:'deliver',nonce:ticket.nonce,claimId,artifact});assert.equal(received.length,beforeClaim+1);assert.equal(messages.at(-1).outcome,'received_for_review');handoff.cancel();
// The isolated bridge forwards claim IDs only for the same extension.
handoff=begin();runtimeListeners.clear();globalThis.window=target;globalThis.location=target.location;globalThis.chrome={runtime:{id:'test-extension',onMessage:{addListener:fn=>runtimeListeners.add(fn),removeListener:fn=>runtimeListeners.delete(fn)}}};const newPair=await pairKerdosTab();const claimedBridge=[...runtimeListeners][0],bridgeClaimId=crypto.randomUUID();assert.equal(claimedBridge({type:'kerdos-claim',nonce:newPair.ticket.nonce,claimId:bridgeClaimId},{id:'other-extension'},()=>assert.fail()),false);const claimAck=await new Promise(resolve=>claimedBridge({type:'kerdos-claim',nonce:newPair.ticket.nonce,claimId:bridgeClaimId},{id:'test-extension'},resolve));assert.equal(claimAck.outcome,'ready_for_export');handoff.cancel();delete globalThis.__kerdosCompanionListener;delete globalThis.window;delete globalThis.location;delete globalThis.chrome;
console.log('PASS pre-export reservation: one winner, wrong nonce/claim and legacy bypass denied, isolated sender guard, no import during claim');
// A second provider uses the same receiver without modifying the shared core.
const genericSelection={...selection,adapterKey:'another-provider',portalOrigin:'https://supplier.example'};
handoff=begin({selection:genericSelection});await dispatch({type:'pair'});ticket=messages.at(-1).ticket;
await dispatch({type:'deliver',nonce:ticket.nonce,artifact:{...artifact,origin:genericSelection.portalOrigin}});
assert.equal(received.length,beforeClaim+2);assert.equal(received.at(-1).evidence.adapter_key,'another-provider');handoff.cancel();
// Unicode is valid UTF-8: preserve the raw bytes, not a Latin-1 base64 view.
const unicode='Code,Description,Price\nUTF8,Crème brûlée® – jalapeño,12.50\n';
const unicodeBytes=new TextEncoder().encode(unicode),unicodeBefore=received.length;
handoff=begin();await dispatch({type:'pair'});ticket=messages.at(-1).ticket;
await dispatch({type:'deliver',nonce:ticket.nonce,artifact:{...artifact,base64:Buffer.from(unicodeBytes).toString('base64')}});
assert.equal(received.length,unicodeBefore+1);const unicodePayload=received.at(-1);
assert.equal(await unicodePayload.file.text(),unicode);assert.deepEqual(new Uint8Array(await unicodePayload.file.arrayBuffer()),unicodeBytes);assert.equal(unicodePayload.evidence.byte_length,unicodeBytes.length);
assert.equal(unicodePayload.evidence.sha256,Buffer.from(await crypto.subtle.digest('SHA-256',unicodeBytes)).toString('hex'));handoff.cancel();
// A timer callback queued before disposal may still run during admission.
// Receiving has already cleared its timer and cannot be expired mid-review.
time=1000;states.length=0;let finishAdmitted,disposed=0;
handoff=begin({onStateChange:s=>states.push(s),schedule:fn=>{expiry=fn;return 9;},unschedule:id=>{assert.equal(id,9);disposed++;},onReceive:()=>new Promise(resolve=>{finishAdmitted=resolve;})});
await dispatch({type:'pair'});ticket=messages.at(-1).ticket;const admitted=dispatch({type:'deliver',nonce:ticket.nonce,artifact});while(!finishAdmitted)await new Promise(resolve=>setImmediate(resolve));
assert.equal(disposed,1);time=handoff.expiresAt;expiry();assert.equal(handoff.state,'receiving');finishAdmitted();await admitted;assert.deepEqual(states,['receiving','received']);assert.equal(disposed,1);assert.equal(messages.at(-1).outcome,'received_for_review');handoff.cancel();
console.log('PASS one-use app/bridge delivery preserves UTF-8 bytes and hash, ignores payload ownership, blocks wrong origin/sender, replay, expiry, cancelled in-flight work and invalid exports');
const db=new PGlite();
try{
 await db.exec('CREATE TABLE public.import_documents(id int primary key);');await db.exec(readFileSync('knowledge/a2_companion_evidence_draft.sql','utf8'));
 const proof=received[0].evidence;
 await db.query('INSERT INTO import_documents(id,retrieval_evidence) VALUES(1,$1)',[proof]);await db.query('INSERT INTO import_documents(id) VALUES(2)');
 await assert.rejects(db.query('UPDATE import_documents SET retrieval_evidence=$1 WHERE id=2',[proof]),/immutable/);
 await assert.rejects(db.query('UPDATE import_documents SET retrieval_evidence=NULL WHERE id=1'),/immutable/);
 for(const invalid of [{},{kind:'browser_companion'}, {...proof,assurance:'supplier_certified'},{...proof,sha256:'bad'},{...proof,byte_length:0}])await assert.rejects(db.query('INSERT INTO import_documents(id,retrieval_evidence) VALUES(3,$1)',[invalid]),/check constraint/);
 await db.query('UPDATE import_documents SET retrieval_evidence=retrieval_evidence WHERE id=1');
 console.log('PASS executed SQL evidence draft: nullable manual history, complete companion assertion, immutable source claim, malformed/certified claims refused');
}finally{await db.close();}
