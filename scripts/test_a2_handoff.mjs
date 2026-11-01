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
// Real isolated bridge function against the app listener, including sender guard.
time=1000;handoff=begin();globalThis.window=target;globalThis.location=target.location;const runtimeListeners=new Set();globalThis.chrome={runtime:{id:'test-extension',onMessage:{addListener:fn=>runtimeListeners.add(fn),removeListener:fn=>runtimeListeners.delete(fn)}}};
const paired=await pairKerdosTab();assert.equal(paired.ok,true);assert.equal(runtimeListeners.size,1);
const runtime=[...runtimeListeners][0];assert.equal(runtime({type:'kerdos-deliver'}, {id:'other-extension'},()=>assert.fail()),false);
const ack=await new Promise(resolve=>{assert.equal(runtime({type:'kerdos-deliver',nonce:paired.ticket.nonce,artifact},{id:'test-extension'},resolve),true);});
assert.equal(ack.outcome,'received_for_review');assert.equal(received.length,2);
await pairKerdosTab();assert.equal(runtimeListeners.size,1);handoff.cancel();delete globalThis.__kerdosCompanionListener;delete globalThis.window;delete globalThis.location;delete globalThis.chrome;
assert.ok(approvedKerdosTab('https://kerdossoftareproject.github.io/KERDOS-TRIAL-AND-ERROR/'));
for(const url of ['https://evil.example/KERDOS-TRIAL-AND-ERROR/','https://kerdossoftareproject.github.io/another-app/','https://kerdossoftareproject.github.io/KERDOS-TRIAL-AND-ERROR-phishing','not a URL'])assert.equal(approvedKerdosTab(url),false);
// A second provider uses the same receiver without modifying the shared core.
const genericSelection={...selection,adapterKey:'another-provider',portalOrigin:'https://supplier.example'};
handoff=begin({selection:genericSelection});await dispatch({type:'pair'});ticket=messages.at(-1).ticket;
await dispatch({type:'deliver',nonce:ticket.nonce,artifact:{...artifact,origin:genericSelection.portalOrigin}});
assert.equal(received.length,3);assert.equal(received.at(-1).evidence.adapter_key,'another-provider');handoff.cancel();
console.log('PASS one-use app/bridge delivery preserves exact bytes, ignores payload ownership, blocks wrong origin/sender, replay, expiry, cancelled in-flight work and invalid exports');
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
