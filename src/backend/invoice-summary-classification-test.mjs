import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {estimatedReceiptFixture} from './fixtures/estimated-receipts-db.mjs';
import {classifyInvoiceSummary,invoiceSummaryBasis,validateSummaryClassification} from '../core/invoice-summary-classification.js';
import {reconcileInvoice} from '../core/invoice-reconciliation.js';
import {createSummaryClassificationService,resolveSummaryRequest} from '../services/invoice-summary-classification.js';
const f=await estimatedReceiptFixture();const {db,org,owner,manager,employee,outsider,ol,actor,admin,invoice}=f;
const one=async(sql,args=[])=>(await db.query(sql,args)).rows[0].value;
let signedIn=true,sessionUser=owner,backendSaves=0;
const service=createSummaryClassificationService({session:{get:async()=>signedIn?{user:{id:sessionUser}}:null},invoiceSummaryClassification:{review:(o,i)=>one('select kerdos_review_summary_classification($1,$2) as value',[o,i]),save:p=>{backendSaves++;return one('select kerdos_save_summary_classification_as_actor($1,$2,$3,$4,$5,true) as value',[p.review.organizationId,p.review.invoiceId,p.requestId,JSON.stringify(p.review),p.requestedBy]);},closeAttempt:p=>one('select kerdos_close_summary_classification_attempt($1,$2,$3,$4,$5,true) as value',[p.review.organizationId,p.review.invoiceId,p.requestId,JSON.stringify(p.review),p.requestedBy])}});
try{
 const s=await invoice(),raw='Subtotal 56.00\nTax 0.00\nTransportation 0.00\nCredits 0.00\nInvoice Total 56.00';
 await admin('update invoices set raw_text=$1 where id=$2',[raw,s.iid]);await actor(employee);
 const r=await one('select kerdos_review_estimated_receipt($1,$2,$3,1) as value',[org,ol,s.lid]);
 await one('select kerdos_save_estimated_receipt($1,$2,$3,1,$4,true,true) as value',[org,ol,s.lid,JSON.stringify(r)]);
 await actor(owner);let c=await service.review(org,s.iid);assert.equal(reconcileInvoice(c.source,{organizationId:org,invoiceId:s.iid}).status,'needs_review');
 const mappings=[{lineNumber:3,kind:'freight'}],plan=service.prepare(c,mappings,'Classify retained transportation charge',{confirmed:true});
 assert.throws(()=>service.prepare(c,mappings,'Classify retained transportation charge'),/confirmation/);
 await actor(employee);await assert.rejects(one('select kerdos_save_summary_classification($1,$2,$3,$4,true) as value',[org,s.iid,plan.requestId,JSON.stringify(plan.review)]),/Owner or manager/);
 await actor(owner);await assert.rejects(one('select kerdos_save_summary_classification($1,$2,$3,$4,false) as value',[org,s.iid,plan.requestId,JSON.stringify(plan.review)]),/confirm/);
 await assert.rejects(one('select kerdos_save_summary_classification_as_actor($1,$2,$3,$4,$5,true) as value',[org,s.iid,plan.requestId,JSON.stringify(plan.review),manager]),/another signed-in user/);
 const saved=await service.save(plan,{confirmed:true});validateSummaryClassification(saved,org,s.iid);assert.equal(saved.revision,1);assert.deepEqual(await service.save(plan,{confirmed:true}),saved);
 c=await service.review(org,s.iid);assert.equal(c.source.header.rawText,raw);assert.equal(c.history.length,1);assert.equal(reconcileInvoice(c.source,{organizationId:org,invoiceId:s.iid}).status,'reconciled');
 assert.equal((await one('select kerdos_invoice_approval_gate($1) as value',[JSON.stringify(c.source)])).eligible,true);
 const approval=await one('select kerdos_save_invoice_approval($1,$2,$3,$4,$5,true) as value',[org,s.iid,randomUUID(),JSON.stringify(c.source),'Reviewed classified source']);
 const reset=service.prepare(c,[],'Restore original source interpretation',{confirmed:true});await service.save(reset,{confirmed:true});
 await assert.rejects(one('select kerdos_review_invoice_payment($1,$2,$3,100,current_date,\'check\',\'NO-STALE-APPROVAL\') as value',[org,s.iid,approval.id]),/current clean/);
 await assert.rejects(one('select kerdos_save_summary_classification($1,$2,$3,$4,true) as value',[org,s.iid,randomUUID(),JSON.stringify(plan.review)]),/history changed/);
 await assert.rejects(service.save({...plan,review:{...plan.review,reason:'Different confirmed category reason'}},{confirmed:true}),/different confirmed evidence/);
 await actor(manager);await assert.rejects(one('select kerdos_save_summary_classification($1,$2,$3,$4,true) as value',[org,s.iid,plan.requestId,JSON.stringify(plan.review)]),/different confirmed evidence/);
 await actor(owner);assert.deepEqual(await service.save(plan,{confirmed:true}),saved);c=await service.review(org,s.iid);assert.equal(c.history.length,2);assert.equal(c.source.summaryClassification.revision,2);assert.equal(reconcileInvoice(c.source,{organizationId:org,invoiceId:s.iid}).status,'needs_review');
 const restore=service.prepare(c,mappings,'Restore classification after source review',{confirmed:true});const third=await service.save(restore,{confirmed:true});assert.equal(third.previousId,c.history[1].id);assert.equal(third.revision,3);
 const freshSource=(await service.review(org,s.iid)).source;assert.equal((await one('select kerdos_invoice_approval_gate($1) as value',[JSON.stringify(freshSource)])).eligible,true);assert.notDeepEqual(approval.source,freshSource);
 for(const query of ['update invoice_summary_classifications set confirmed=false','delete from invoice_summary_classifications'])await assert.rejects(db.exec(query),/permission denied/);
 await assert.rejects(db.query('insert into invoice_summary_classifications(organization_id,invoice_id,request_id,review,confirmed,snapshot) values($1,$2,$3,$4,true,\'{}\')',[org,s.iid,randomUUID(),JSON.stringify(restore.review)]),/permission denied/);
 await actor(outsider);await assert.rejects(service.review(org,s.iid),/membership/);await actor(owner);
 signedIn=false;await assert.rejects(service.review(org,s.iid),/Sign in/);signedIn=true;
 // Derived text parity, including forbidden item sources and unchanged unsupported rows.
 for(const [basis,m,valid]of [
  [{rawText:'Transportation $1,234.56',itemSources:[]},[{lineNumber:1,kind:'freight'}],true],
  [{rawText:'Rebate (3.00)',itemSources:[]},[{lineNumber:1,kind:'credits'}],true],
  [{rawText:'Tax 0.00\nUnknown charge 8.00',itemSources:[]},[{lineNumber:1,kind:'tax'}],true],
  [{rawText:'Item,14,4,56.00',itemSources:['Item\t14\t4\t56.00']},[{lineNumber:1,kind:'total'}],false],
  [{rawText:'Bill 56.00',itemSources:[]},[{lineNumber:1,kind:'unknown'}],false],
  [{rawText:'Tax 5.00',itemSources:[]},[{lineNumber:1,kind:'freight'}],false],
  ...['\u00a0','\u2003','\u202f','\ufeff','\t'].flatMap(space=>[
   [{rawText:'Tax'+space+' 5.00',itemSources:[]},[{lineNumber:1,kind:'freight'}],false],
   [{rawText:'Tax'+space+' 5.00',itemSources:[]},[{lineNumber:1,kind:'tax'}],true],
  ]),
  [{rawText:'Bill 56.000',itemSources:[]},[{lineNumber:1,kind:'total'}],false],
  [{rawText:'Bill €56.00',itemSources:[]},[{lineNumber:1,kind:'total'}],false],
  [{rawText:'Bill (-56.00)',itemSources:[]},[{lineNumber:1,kind:'total'}],false],
  [{rawText:'Bill 90071992547409.92',itemSources:[]},[{lineNumber:1,kind:'total'}],false],
  [{rawText:'Bill 56.00',itemSources:[]},[{lineNumber:1,kind:'total'},{lineNumber:1,kind:'tax'}],false],
  [{rawText:'Bill 56.00',itemSources:[]},[{lineNumber:1,kind:'total',amount:0}],false],
  [{rawText:'',itemSources:[]},[],true],
 ]){
  if(valid)assert.equal(await one('select kerdos_classified_invoice_summary($1,$2) as value',[JSON.stringify(basis),JSON.stringify(m)]),classifyInvoiceSummary(basis,m));
  else{assert.throws(()=>classifyInvoiceSummary(basis,m));await assert.rejects(one('select kerdos_classified_invoice_summary($1,$2) as value',[JSON.stringify(basis),JSON.stringify(m)]));}
 }
 const next=await invoice();await actor(owner);const nc=await service.review(org,next.iid),np=service.prepare(nc,[],'Review current original source only',{confirmed:true});await admin("update invoices set raw_text=raw_text||E'\nUnknown fee 1.00' where id=$1",[next.iid]);await actor(owner);await assert.rejects(service.save(np,{confirmed:true}),/source or classification history changed/);
 assert.equal(resolveSummaryRequest(np,await service.review(org,next.iid)).status,'pending','Source changes alone do not prove permanent closure');await admin('update invoices set raw_text=$1 where id=$2',[np.review.basis.rawText,next.iid]);await actor(owner);assert.equal((await service.save(np,{confirmed:true})).revision,1,'Original request can apply if its unchanged predecessor and original source return');
 // Late failure does not reserve a request or advance the revision chain.
 c=await service.review(org,s.iid);const late=service.prepare(c,[],'Controlled late classification failure',{confirmed:true});
 await admin("create function fail_summary() returns trigger language plpgsql as $$begin raise exception 'controlled summary failure';end;$$;");await admin("create trigger zz_fail_summary after insert on invoice_summary_classifications for each row execute function fail_summary();");await actor(owner);await assert.rejects(service.save(late,{confirmed:true}),/controlled summary failure/);assert.equal((await service.review(org,s.iid)).history.length,3);await admin('drop trigger zz_fail_summary on invoice_summary_classifications');await actor(owner);assert.equal((await service.save(late,{confirmed:true})).revision,4);
 // Recovery closure is proven by append-only predecessor advancement, not source changes.
 const rc=await service.review(org,s.iid),unknown=service.prepare(rc,[],'Unknown request retained before another revision',{confirmed:true}),winner=service.prepare(rc,[],'Competing revision advances immutable predecessor',{confirmed:true});
 assert.equal(resolveSummaryRequest(unknown,rc).status,'pending');await service.save(winner,{confirmed:true});assert.equal(resolveSummaryRequest(unknown,await service.review(org,s.iid)).status,'superseded');await assert.rejects(service.save(unknown,{confirmed:true}),/history changed/);
 const nextContext=await service.review(org,s.iid),resetAgain=service.prepare(nextContext,[],'Another reset cannot restore the old predecessor',{confirmed:true});await service.save(resetAgain,{confirmed:true});assert.equal(resolveSummaryRequest(unknown,await service.review(org,s.iid)).status,'superseded');await assert.rejects(service.save(unknown,{confirmed:true}),/history changed/);assert.equal(resolveSummaryRequest(winner,await service.review(org,s.iid)).status,'saved');
 const beforeActorChange=backendSaves;sessionUser=manager;await assert.rejects(service.save(unknown,{confirmed:true}),/another signed-in user/);assert.equal(backendSaves,beforeActorChange,'Actor mismatch rejects before RPC');sessionUser=owner;
 // Independent core refuses source-bound and text tampering.
 assert.throws(()=>reconcileInvoice({...freshSource,summaryClassification:{...third,classifiedText:'Tax 0.00'}},{organizationId:org,invoiceId:s.iid}),/Invalid.*audit/);
 assert.throws(()=>reconcileInvoice({...freshSource,header:{...freshSource.header,rawText:'Changed source'}},{organizationId:org,invoiceId:s.iid}),/source changed/);
 assert.equal((await one('select kerdos_invoice_approval_gate($1) as value',[JSON.stringify({...freshSource,header:{...freshSource.header,rawText:'Changed source'}})])).eligible,false);
 assert.equal(invoiceSummaryBasis(freshSource).rawText,raw);
 // Permanent closure works without advancing the current predecessor.
 const closeContext=await service.review(org,s.iid),toClose=service.prepare(closeContext,[],'Close this exact unconfirmed original request',{confirmed:true});
 await assert.rejects(service.closeAttempt(toClose),/Confirm closing/);
 await assert.rejects(one('select kerdos_close_summary_classification_attempt($1,$2,$3,$4,$5,false) as value',[org,s.iid,toClose.requestId,JSON.stringify(toClose.review),owner]),/confirm/);
 await assert.rejects(one('select kerdos_close_summary_classification_attempt($1,$2,$3,$4,$5,true) as value',[org,s.iid,toClose.requestId,JSON.stringify(toClose.review),manager]),/another signed-in user/);
 const closed=await service.closeAttempt(toClose,{confirmed:true});assert.equal(closed.status,'closed');assert.deepEqual(await service.closeAttempt(toClose,{confirmed:true}),closed);
 const afterClose=await service.review(org,s.iid);assert.deepEqual(afterClose.source,closeContext.source,'Closure must not change invoice reconciliation evidence');assert.deepEqual(resolveSummaryRequest(toClose,afterClose),{status:'closed',recordId:closed.record.id});
 await assert.rejects(service.save(toClose,{confirmed:true}),/permanently closed/);
 await assert.rejects(one('select kerdos_save_summary_classification($1,$2,$3,$4,true) as value',[org,s.iid,toClose.requestId,JSON.stringify(toClose.review)]),/permanently closed/);
 await assert.rejects(db.query('insert into invoice_summary_classifications(organization_id,invoice_id,request_id,review,confirmed) values($1,$2,$3,$4,true)',[org,s.iid,toClose.requestId,JSON.stringify(toClose.review)]),/permanently closed/);
 await assert.rejects(service.closeAttempt({...toClose,review:{...toClose.review,reason:'Changed retained request cannot replace closure'}},{confirmed:true}),/different confirmed evidence/);
 for(const sql of ['update invoice_summary_closed_attempts set confirmed=false','delete from invoice_summary_closed_attempts'])await assert.rejects(db.exec(sql),/permission denied/);
 await assert.rejects(db.query("insert into invoice_summary_closed_attempts(organization_id,invoice_id,request_id,review,confirmed,snapshot) values($1,$2,$3,$4,true,'{}')",[org,s.iid,randomUUID(),JSON.stringify(toClose.review)]),/permission denied/);
 const completed=service.prepare(afterClose,[],'The saved result must win against closure',{confirmed:true}),completedRecord=await service.save(completed,{confirmed:true}),beforeSavedClose=(await service.review(org,s.iid)).closedAttempts.length;
 assert.deepEqual(await service.closeAttempt(completed,{confirmed:true}),{status:'saved',record:completedRecord});assert.equal((await service.review(org,s.iid)).closedAttempts.length,beforeSavedClose);
 const failContext=await service.review(org,s.iid),failClose=service.prepare(failContext,[],'Controlled closure rollback leaves no fence',{confirmed:true});
 await admin("create function fail_summary_close() returns trigger language plpgsql as $$begin raise exception 'controlled close failure';end;$$;");await admin('create trigger zz_fail_summary_close after insert on invoice_summary_closed_attempts for each row execute function fail_summary_close()');await actor(owner);await assert.rejects(service.closeAttempt(failClose,{confirmed:true}),/controlled close failure/);assert.equal((await service.review(org,s.iid)).closedAttempts.length,beforeSavedClose);await admin('drop trigger zz_fail_summary_close on invoice_summary_closed_attempts');await actor(owner);await service.save(failClose,{confirmed:true});
 await actor(employee);await assert.rejects(one('select kerdos_close_summary_classification_attempt($1,$2,$3,$4,$5,true) as value',[org,s.iid,randomUUID(),JSON.stringify(failClose.review),employee]),/Owner or manager/);await actor(manager);sessionUser=manager;const mc=await service.review(org,s.iid),mp=service.prepare(mc,[],'Manager closes only this manager request',{confirmed:true});assert.equal((await service.closeAttempt(mp,{confirmed:true})).record.closedBy,manager);sessionUser=owner;await actor(owner);
 console.log('PASS permanent summary closure: consent/actor/role, exact replay, legacy/direct late-save fence, immutable protected marker, saved-result recovery, unchanged financial evidence and late rollback.');
 console.log('PASS summary classification SQL/core/service: retained tokens only, independent parity/gates, owner/manager consent, immutable linear audit, source/history CAS, exact/historical replay, approval invalidation, tamper denial and late rollback.');
}finally{await db.close();}
