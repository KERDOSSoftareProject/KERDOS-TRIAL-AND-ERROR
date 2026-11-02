import {resolveSummaryRequest} from '../src/services/invoice-summary-classification.js';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {invoiceSummaryBasis} from '../src/core/invoice-summary-classification.js';
export async function summaryRaces({setup,f,q,call,overlap,scenario,payReview,payment}){
 const {org,owner,actor}=f;
 await actor(owner);
 for(const space of ['\u00a0','\u2003','\u202f','\ufeff','\t']){
  const basis={rawText:'Tax'+space+' 5.00',itemSources:[]};
  await assert.rejects(call(setup,q('kerdos_classified_invoice_summary',[basis,[{lineNumber:1,kind:'freight'}]])),/Recognized summary labels/);
  assert.equal(await call(setup,q('kerdos_classified_invoice_summary',[basis,[{lineNumber:1,kind:'tax'}]])),'Tax 5.00');
 }
 console.log('PASS summary label whitespace: SQL retains recognized categories across JavaScript whitespace');
 async function plan(s,reason='Classify retained summary source'){
  await actor(owner);const c=await call(setup,q('kerdos_review_summary_classification',[org,s.iid]));
  return q('kerdos_save_summary_classification_as_actor',[org,s.iid,randomUUID(),{kind:'invoice_summary_classification_review',version:1,organizationId:org,invoiceId:s.iid,basis:invoiceSummaryBasis(c.source),previousId:c.history.at(-1)?.id??null,mappings:[],reason},owner,true]);
 }
 async function count(s){await setup.query('reset role');assert.equal((await setup.query('select count(*) as count from invoice_summary_classifications where invoice_id=$1',[s.iid])).rows[0].count,1);}
 for(const mode of ['commit','rollback','conflict']){
  const s=await scenario(),cmd=await plan(s),competing=mode==='conflict'?await plan(s,'A different confirmed classification'):cmd;
  if(mode==='commit'){const wrong={...cmd,args:cmd.args.map((v,i)=>i===4?f.manager:v)};await assert.rejects(call(setup,wrong),/another signed-in user/);console.log('PASS recovery actor guard: mismatched authenticated actor rejects before persistence');}
  const result=await overlap(`summary classification ${mode}`,cmd,competing,{rightActor:owner,rollbackFirst:mode==='rollback',same:mode==='commit',error:mode==='conflict'?/classification history changed/:undefined});
  await count(s);assert.equal((mode==='rollback'?result.second:result.first).revision,1);
  if(mode==='conflict'){
   await actor(owner);const retained={kind:'invoice_summary_classification_request',version:1,requestId:competing.args[2],requestedBy:owner,review:JSON.parse(competing.args[3])};
   const context=async()=>({...await call(setup,q('kerdos_review_summary_classification',[org,s.iid])),actorId:owner});
   assert.equal(resolveSummaryRequest(retained,await context()).status,'superseded');await assert.rejects(call(setup,competing),/classification history changed/);
   await call(setup,await plan(s,'A later reset cannot restore a closed predecessor'));assert.equal(resolveSummaryRequest(retained,await context()).status,'superseded');await assert.rejects(call(setup,competing),/classification history changed/);
   console.log('PASS recovery closure proof: missing old request cannot apply after later immutable revisions');
  }
 }
 for(const classificationFirst of [true,false]){
  const s=await scenario(),classification=await plan(s);
  const source=await call(setup,q('kerdos_review_invoice_reconciliation',[org,s.iid]));
  const approval=q('kerdos_save_invoice_approval',[org,s.iid,randomUUID(),source,'Reviewed source before competing classification',true]);
  await overlap(`summary classification ${classificationFirst?'before':'after'} approval`,classificationFirst?classification:approval,classificationFirst?approval:classification,{rightActor:owner,error:classificationFirst?/evidence changed/:undefined});
  await count(s);await actor(owner);
  await assert.rejects(call(setup,payReview(s,100,'STALE-CLASSIFIED-APPROVAL')),/current clean/);
 }
 for(const classificationFirst of [true,false]){
  const s=await scenario(),classification=await plan(s),review=await call(setup,payReview(s,1000,'SUMMARY-PAY-RACE')),save=payment(review);
  await overlap(`summary classification ${classificationFirst?'before':'after'} payment`,classificationFirst?classification:save,classificationFirst?save:classification,{rightActor:owner,error:classificationFirst?/current clean/:undefined});
  await count(s);await setup.query('reset role');assert.equal((await setup.query('select count(*) as count from invoice_payments where invoice_id=$1',[s.iid])).rows[0].count,classificationFirst?0:1);
 }
 // A persistent fence closes even a still-current predecessor; first committed outcome wins.
 for(const closeFirst of [true,false])for(const rollbackFirst of [false,true]){
  const s=await scenario(),save=await plan(s),close=q('kerdos_close_summary_classification_attempt',save.args);
  const result=await overlap(`summary close ${closeFirst?'before':'after'} save ${rollbackFirst?'rollback':'commit'}`,closeFirst?close:save,closeFirst?save:close,{rightActor:owner,rollbackFirst,error:closeFirst&&!rollbackFirst?/permanently closed/:undefined});
  const saved=closeFirst?rollbackFirst:!rollbackFirst;
  await setup.query('reset role');const {rows:[r]}=await setup.query('select (select count(*) from invoice_summary_classifications where organization_id=$1 and request_id=$2) as saved,(select count(*) from invoice_summary_closed_attempts where organization_id=$1 and request_id=$2) as closed',[org,save.args[2]]);assert.deepEqual(r,{saved:saved?1:0,closed:saved?0:1});
  await actor(owner);const c={...await call(setup,q('kerdos_review_summary_classification',[org,s.iid])),actorId:owner},retained={kind:'invoice_summary_classification_request',version:1,requestId:save.args[2],requestedBy:owner,review:JSON.parse(save.args[3])};assert.equal(resolveSummaryRequest(retained,c).status,saved?'saved':'closed');
  if(!saved){await assert.rejects(call(setup,save),/permanently closed/);await assert.rejects(call(setup,q('kerdos_save_summary_classification',save.args.slice(0,4).concat(true))),/permanently closed/);}else if(!closeFirst&&!rollbackFirst)assert.equal(result.second.record.id,result.first.id);
  if(!saved)await call(setup,payReview(s,1,'CLOSURE-LEAVES-APPROVAL-CURRENT'));
 }
 for(const rollbackFirst of [false,true]){
  const s=await scenario(),save=await plan(s),close=q('kerdos_close_summary_classification_attempt',save.args),result=await overlap(`summary close identical ${rollbackFirst?'rollback':'commit'}`,close,close,{rightActor:owner,rollbackFirst,same:!rollbackFirst});
  await setup.query('reset role');const {rows:[r]}=await setup.query('select (select count(*) from invoice_summary_classifications where invoice_id=$1) as saved,(select count(*) from invoice_summary_closed_attempts where invoice_id=$1) as closed',[s.iid]);assert.deepEqual(r,{saved:0,closed:1});if(rollbackFirst)assert.notEqual(result.first.attempt.id,result.second.attempt.id);
 }

}
