import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {invoiceSummaryBasis} from '../src/core/invoice-summary-classification.js';
export async function summaryRaces({setup,f,q,call,overlap,scenario,payReview,payment}){
 const {org,owner,actor}=f;
 async function plan(s,reason='Classify retained summary source'){
  await actor(owner);const c=await call(setup,q('kerdos_review_summary_classification',[org,s.iid]));
  return q('kerdos_save_summary_classification',[org,s.iid,randomUUID(),{kind:'invoice_summary_classification_review',version:1,organizationId:org,invoiceId:s.iid,basis:invoiceSummaryBasis(c.source),previousId:c.history.at(-1)?.id??null,mappings:[],reason},true]);
 }
 async function count(s){await setup.query('reset role');assert.equal((await setup.query('select count(*) as count from invoice_summary_classifications where invoice_id=$1',[s.iid])).rows[0].count,1);}
 for(const mode of ['commit','rollback','conflict']){
  const s=await scenario(),cmd=await plan(s);
  const result=await overlap(`summary classification ${mode}`,cmd,mode==='conflict'?await plan(s,'A different confirmed classification'):cmd,{rightActor:owner,rollbackFirst:mode==='rollback',same:mode==='commit',error:mode==='conflict'?/classification history changed/:undefined});
  await count(s);assert.equal((mode==='rollback'?result.second:result.first).revision,1);
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
}
