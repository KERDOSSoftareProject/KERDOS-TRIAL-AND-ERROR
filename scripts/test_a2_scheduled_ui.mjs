import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
const dir=mkdtempSync(join(process.cwd(),'node_modules/.a2-scheduled-ui-'));
try{
 const outfile=join(dir,'ui.mjs');
 await build({stdin:{contents:`
 import React from 'react';
 import Renderer,{act} from 'react-test-renderer';
 import assert from 'node:assert/strict';
 import VendorConnectPage from './src/pages/VendorConnectPage.jsx';
 import {createRecords} from './src/backend/records.js';
 const adapter={adapter_key:'us-foods-moxe',display_name:'MOXe',setup_available:true,execution_model:'local_browser',portal_origin:'https://order.usfoods.com'};
 const request={id:'request',organization_id:'org',vendor_id:'vendor',adapter_key:adapter.adapter_key,state:'setup_requested',transfer_revision:5,portal_account_label:'Sample account',portal_list_label:'Main Items'};
 const claims=[],verified=[],imports=[],replies=[],listeners=new Set();let scheduledTick,claimAvailable=true,readyProvider='different-provider';
 const appWindow={location:{origin:'https://kerdos.example'},document:{documentElement:{getAttribute:k=>k==='data-kerdos-refresh'?'1':k==='data-kerdos-ready-providers'?JSON.stringify([readyProvider]):null}},
  addEventListener:(_,fn)=>listeners.add(fn),removeEventListener:(_,fn)=>listeners.delete(fn),postMessage:msg=>{
   if(msg.channel==='kerdos-refresh-v1'&&msg.type==='refresh')queueMicrotask(async()=>{
    await send({channel:'kerdos-companion-v1',type:'pair'});const ticket=replies.at(-1).ticket;
    const claimId=crypto.randomUUID();await send({channel:'kerdos-companion-v1',type:'claim',nonce:ticket.nonce,claimId});
    await send({channel:'kerdos-companion-v1',type:'deliver',nonce:ticket.nonce,claimId,artifact:{origin:adapter.portal_origin,base64:btoa('Code,Price\\nA,1\\n')}});
    await send({channel:'kerdos-refresh-v1',type:'reply',requestId:msg.requestId,outcome:'received_for_review'});
   });
   else if(msg.channel==='kerdos-companion-v1'&&msg.type==='reply')replies.push(msg);
  }};
 async function send(data){for(const fn of [...listeners])await fn({source:appWindow,origin:appWindow.location.origin,data:{requestId:crypto.randomUUID(),...data}});}
 globalThis.window=appWindow;
 const oldSet=globalThis.setTimeout,oldClear=globalThis.clearTimeout;
 globalThis.setTimeout=(fn,ms,...args)=>ms===30000?(scheduledTick=fn,1):oldSet(fn,ms,...args);
 globalThis.clearTimeout=id=>{if(id===1)scheduledTick=null;else oldClear(id);};
 const backend={records:createRecords(async spec=>({data:spec.table==='vendor_connection_adapters'?[adapter]:[request]})),vendorConnect:{
  verifySelection:async()=>true,reconcileSchedule:async()=>0,scheduleHistory:async()=>({schedule:null,slots:[]}),
  claimSchedule:async id=>{claims.push(id);if(!claimAvailable)return null;claimAvailable=false;return {token:'scheduled-token',request_id:id,organization_id:'org',vendor_id:'vendor',transfer_revision:5};},
  verifySchedule:async token=>{verified.push(token);return true;},stopSchedule:async()=>{throw Error('unexpected stop')},
 }};
 let tree;
 try{
  await act(async()=>{tree=Renderer.create(React.createElement(VendorConnectPage,{backend,organizationId:'org',vendors:[{id:'vendor',name:'Vendor'}],role:'owner',visible:false,onCompanionImport:p=>imports.push(p)}));});
  assert.ok(scheduledTick,'the signed-in hidden page keeps a bounded due check');
  // Browser access for another provider must not claim this vendor's slot.
  await act(async()=>{await scheduledTick();});
  assert.deepEqual(claims,[]);assert.equal(imports.length,0);
  readyProvider=adapter.adapter_key;
  await act(async()=>{await send({channel:'kerdos-refresh-v1',type:'available',version:1});});
  await act(async()=>{await scheduledTick();});
  assert.deepEqual(claims,['request']);assert.equal(imports.length,1);
  assert.equal(imports[0].evidence.attempt_token,'scheduled-token');
  assert.ok(verified.length>=3,'server validation precedes pairing, export and admission');
  await act(async()=>{tree.unmount();});
  console.log('PASS scheduled UI: hidden signed-in page asks server once, validates before export/admission, and stamps its own token on the import; no real vendor contact.');
 }finally{globalThis.setTimeout=oldSet;globalThis.clearTimeout=oldClear;delete globalThis.window;}
 `,resolveDir:process.cwd(),loader:'jsx'},bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',outfile});
 execFileSync(process.execPath,[outfile],{stdio:'inherit'});
}finally{rmSync(dir,{recursive:true,force:true});}
