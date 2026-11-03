// Controlled crash/persistence boundaries; no live browser, supplier or database.
import assert from 'node:assert/strict';
import {createTransferRunner} from '../companion/chrome/transfer-runner.mjs';
const ticket={protocolVersion:2,tabId:1,nonce:'prepared',expiresAt:Date.now()+600000,adapterKey:'us-foods-moxe',portalOrigin:'https://order.usfoods.com',account:'Client',list:'List'};
const idle={busy:false,message:'Paired for one export. Open the selected vendor list.'};
function fixture(seed,boundary=null){
 let alive=true,release,reached=false;const data=structuredClone(seed),effects=[];
 const check=()=>{if(!alive)throw Error('worker terminated');};
 const pause=async()=>{reached=true;await new Promise(resolve=>{release=resolve;});check();};
 const api={
  storage:{session:{
   get:async key=>{check();return {[key]:structuredClone(data[key])};},
   remove:async key=>{check();effects.push('remove:'+key);delete data[key];},
   set:async value=>{check();if(value.transferStatus?.busy&&boundary==='before-commit')await pause();check();Object.assign(data,structuredClone(value));effects.push('write:'+String(value.transferStatus?.busy));if(value.transferStatus?.busy&&boundary==='after-commit')await pause();},
  }},
  tabs:{get:async id=>{check();if(boundary==='before-busy')await pause();return {id,url:'https://order.usfoods.com/desktop/lists/view/list'};},sendMessage:async(id,message)=>{check();assert.equal(id,1);effects.push(message.type);return message.type==='kerdos-claim'?{ok:true,outcome:'ready_for_export'}:{ok:true,outcome:'received_for_review'};}},
  scripting:{executeScript:async()=>{check();effects.push('vendor-export');return [{result:{outcome:'export_captured',artifact:{base64:'YQ==',origin:ticket.portalOrigin}}}];}},
 };
 return {runner:createTransferRunner(api),data,effects,reached:()=>reached,terminate(){alive=false;},release:()=>release()};
}
for(const boundary of ['before-busy','before-commit','after-commit']){
 const original=fixture({pairing:ticket,transferStatus:idle},boundary);
 const interrupted=original.runner.run('export',2);const rejected=assert.rejects(interrupted,/worker terminated/);
 while(!original.reached())await new Promise(resolve=>setImmediate(resolve));
 assert.equal(original.effects.includes('kerdos-claim'),false);assert.equal(original.effects.includes('vendor-export'),false);
 assert.equal(original.data.transferStatus.busy,boundary==='after-commit');
 original.terminate();const persisted=structuredClone(original.data);
 const restarted=fixture(persisted);const status=await restarted.runner.status();
 assert.equal(status.busy,false);assert.equal(restarted.effects.includes('vendor-export'),false);assert.equal(restarted.effects.includes('kerdos-claim'),false);
 if(boundary==='after-commit'){
  assert.match(status.message,/result is unconfirmed/);assert.equal(restarted.data.pairing,undefined);
  const unavailable=await restarted.runner.run('export',2);assert.match(unavailable.message,/Transfer unavailable/);assert.equal(restarted.effects.includes('vendor-export'),false);
 }else{
  assert.equal(status.message,idle.message);assert.deepEqual(restarted.data.pairing,ticket);
  const receipt=await restarted.runner.run('export',2);assert.match(receipt.message,/does not confirm saved prices/);
  assert.equal(restarted.effects.filter(x=>x==='vendor-export').length,1);assert.equal(restarted.effects.filter(x=>x==='kerdos-claim').length,1);assert.equal(restarted.effects.filter(x=>x==='kerdos-deliver').length,1);assert.equal(restarted.data.pairing,undefined);
 }
 const beforeLate=structuredClone(restarted.data);original.release();await rejected;
 assert.deepEqual(restarted.data,beforeLate,'retired worker cannot change restarted state');assert.equal(original.effects.includes('vendor-export'),false);
 console.log('PASS controlled worker interruption '+boundary+': persisted boundary, no automatic claim/export/replay and safe explicit recovery');
}
