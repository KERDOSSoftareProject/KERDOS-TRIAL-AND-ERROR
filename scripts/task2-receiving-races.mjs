import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';

// Reuse the real-session harness: no mocked locking or production connection.
export async function receivingRaces({setup,f,q,call,overlap}){
 const {org,owner,manager,employee,vendor,intent,actor,invoice}=f;
 const draft=(request=randomUUID())=>q('kerdos_save_estimated_draft',[org,vendor,request,intent.lines]);
 const close=request=>q('kerdos_close_estimated_draft_attempt',[org,vendor,request,intent.lines]);
 const submit=(d,review)=>q('kerdos_submit_estimated_order',[org,d.id,review,true,false]);
 const cancel=d=>q('kerdos_cancel_estimated_draft',[org,d.id]);
 const receiptReview=(order,s,cases=1)=>q('kerdos_review_estimated_receipt',[org,order.lines[0].id,s.lid,cases]);
 const receipt=(review)=>q('kerdos_save_estimated_receipt',[org,review.orderLine.id,review.invoiceLine.id,review.receivedCaseQuantity,review,true,true]);
 const reverse=r=>q('kerdos_reverse_estimated_receipt',[org,r.id,'Correcting synthetic received cases',true]);
 const replace=(r,review)=>q('kerdos_replace_estimated_receipt',[org,r.id,review.orderLine.id,review.invoiceLine.id,review.receivedCaseQuantity,review,'Correcting synthetic receipt source',true,true,true]);
 const employeeSessions={leftActor:employee,rightActor:employee};
 async function readyDraft(){await actor(employee);const d=await call(setup,draft());return {d,review:await call(setup,q('kerdos_review_estimated_order',[org,d.id]))};}
 async function newOrder(){const {d,review}=await readyDraft();return call(setup,submit(d,review));}
 async function requestCounts(request,saved,closed){
  await setup.query('reset role');
  const {rows:[row]}=await setup.query(`select (select count(*) from estimated_purchase_drafts where organization_id=$1 and request_id=$2) as saved,
   (select count(*) from estimated_draft_closed_attempts where organization_id=$1 and request_id=$2) as closed`,[org,request]);
  assert.deepEqual(row,{saved,closed});
 }
 async function orderCounts(d,status,orders){
  await setup.query('reset role');
  const {rows:[row]}=await setup.query(`select status,
   (select count(*) from estimated_draft_submissions where draft_id=$1) as submissions,
   (select count(*) from purchase_orders o join estimated_draft_submissions s on s.purchase_order_id=o.id where s.draft_id=$1) as orders,
   (select count(*) from purchase_order_lines l join estimated_draft_submissions s on s.purchase_order_id=l.purchase_order_id where s.draft_id=$1) as lines
   from estimated_purchase_drafts where id=$1`,[d.id]);
  assert.deepEqual(row,{status,submissions:orders,orders,lines:orders});
 }
 async function receiptCounts(order,{records,reversals=0,replacements=0,cases,chargeCents}){
  await setup.query('reset role');
  const {rows:[row]}=await setup.query(`select
   (select count(*) from estimated_order_receipts where order_id=$1) as records,
   (select count(*) from estimated_receipt_reversals where order_id=$1) as reversals,
   (select count(*) from estimated_receipt_replacements where order_id=$1) as replacements,
   coalesce(sum(received_cases),0) as cases,
   coalesce(sum((snapshot->>'actualCharge')::numeric*100),0) as cents
   from estimated_order_receipts r where order_id=$1 and not exists(select 1 from estimated_receipt_reversals v where v.receipt_id=r.id)`,[order.id]);
  assert.deepEqual(row,{records,reversals,replacements,cases,cents:chargeCents});
 }
 // A lost save result and permanent closure share one advisory request lock.
 for(const closeFirst of [true,false])for(const rollbackFirst of [false,true]){
  const request=randomUUID(),save=draft(request),closure=close(request);
  const result=await overlap(`draft ${closeFirst?'closure':'save'} first ${rollbackFirst?'rollback':'commit'}`,closeFirst?closure:save,closeFirst?save:closure,{...employeeSessions,rollbackFirst,error:closeFirst&&!rollbackFirst?/permanently closed/:undefined});
  const saved=closeFirst?rollbackFirst:!rollbackFirst;
  await requestCounts(request,saved?1:0,saved?0:1);
  if(!closeFirst){assert.equal(result.second.status,saved?'saved':'closed');if(saved)assert.equal(result.second.draft.id,result.first.id);}
  await actor(employee);
  if(!saved)await assert.rejects(call(setup,save),/permanently closed/);
 }
 for(const rollbackFirst of [false,true]){
  const request=randomUUID(),cmd=draft(request);
  const result=await overlap(`draft identical save ${rollbackFirst?'rollback':'commit'}`,cmd,cmd,{...employeeSessions,rollbackFirst,same:!rollbackFirst});
  await requestCounts(request,1,0);
  if(rollbackFirst){assert.notEqual(result.first.id,result.second.id);await setup.query('reset role');assert.equal((await setup.query('select count(*) as count from estimated_purchase_drafts where id=$1',[result.first.id])).rows[0].count,0);}
 }
 {
  const request=randomUUID(),cmd=draft(request);
  await overlap('draft request different actor',cmd,cmd,{leftActor:employee,rightActor:manager,error:/another request/});
  await requestCounts(request,1,0);
 }
 // Submission pins the draft row; cancellation cannot erase a recorded order.
 for(const rollbackFirst of [false,true]){
  const {d,review}=await readyDraft(),cmd=submit(d,review);
  const result=await overlap(`order identical submission ${rollbackFirst?'rollback':'commit'}`,cmd,cmd,{...employeeSessions,rollbackFirst,same:!rollbackFirst});
  await orderCounts(d,'draft',1);
  if(rollbackFirst){assert.notEqual(result.first.id,result.second.id);assert.equal((await setup.query('select count(*) as count from purchase_orders where id=$1',[result.first.id])).rows[0].count,0);}
 }
 {
  const {d,review}=await readyDraft(),cmd=submit(d,review);
  await overlap('order submission different actor',cmd,cmd,{leftActor:employee,rightActor:owner,error:/another reviewed request/});
  await orderCounts(d,'draft',1);
 }
 for(const cancelFirst of [true,false]){
  const {d,review}=await readyDraft(),save=submit(d,review),cancellation=cancel(d);
  await overlap(`draft cancellation ${cancelFirst?'before':'after'} order`,cancelFirst?cancellation:save,cancelFirst?save:cancellation,{...employeeSessions,error:cancelFirst?/Cancelled drafts/:/recorded order cannot be cancelled/});
  await orderCounts(d,cancelFirst?'cancelled':'draft',cancelFirst?0:1);
 }
 // Same-source replay is one reservation; another actor cannot adopt the receipt.
 for(const rollbackFirst of [false,true]){
  const order=await newOrder(),s=await invoice(),r=await call(setup,receiptReview(order,s)),cmd=receipt(r);
  const result=await overlap(`receipt identical save ${rollbackFirst?'rollback':'commit'}`,cmd,cmd,{...employeeSessions,rollbackFirst,same:!rollbackFirst});
  await receiptCounts(order,{records:1,cases:1,chargeCents:5600});
  if(rollbackFirst){assert.notEqual(result.first.id,result.second.id);assert.equal((await setup.query('select count(*) as count from estimated_order_receipts where id=$1',[result.first.id])).rows[0].count,0);}
 }
 {
  const order=await newOrder(),s=await invoice(),r=await call(setup,receiptReview(order,s)),cmd=receipt(r);
  await overlap('receipt same source different actor',cmd,cmd,{leftActor:employee,rightActor:manager,error:/another confirmed receipt/});
  await receiptCounts(order,{records:1,cases:1,chargeCents:5600});
 }
 for(const cases of [2,1]){
  const order=await newOrder(),a=await invoice(),b=await invoice();
  const ar=await call(setup,receiptReview(order,a,cases)),br=await call(setup,receiptReview(order,b,cases));
  await overlap(`competing receipts ${cases} cases`,receipt(ar),receipt(br),{...employeeSessions,error:/exceed the ordered|remaining cases changed/});
  await receiptCounts(order,{records:1,cases,chargeCents:5600});
  assert.equal((await setup.query('select count(*) as count from estimated_order_receipts where invoice_line_id=$1',[b.lid])).rows[0].count,0,'Rejected source must remain unreserved');
  await actor(employee);const fresh=await call(setup,receiptReview(order,b,1)).catch(e=>{if(cases===2&&/exceed the ordered/.test(e.message))return null;throw e;});
  if(cases===1){await call(setup,receipt(fresh));await receiptCounts(order,{records:2,cases:2,chargeCents:11200});}
 }
 {
  const a=await newOrder(),b=await newOrder(),s=await invoice();
  const ar=await call(setup,receiptReview(a,s)),br=await call(setup,receiptReview(b,s));
  await overlap('same invoice line competing orders',receipt(ar),receipt(br),{...employeeSessions,error:/another confirmed receipt/});
  await receiptCounts(a,{records:1,cases:1,chargeCents:5600});await receiptCounts(b,{records:0,cases:0,chargeCents:0});
 }
 {
  const order=await newOrder(),a=await invoice(),r=await call(setup,receipt(await call(setup,receiptReview(order,a)))),b=await invoice(),stale=await call(setup,receiptReview(order,b));
  await overlap('receipt reversal invalidates pending receiving review',reverse(r),receipt(stale),{leftActor:owner,rightActor:employee,error:/remaining cases changed/});
  await receiptCounts(order,{records:1,reversals:1,cases:0,chargeCents:0});
  await actor(employee);await call(setup,receipt(await call(setup,receiptReview(order,b))));
  await receiptCounts(order,{records:2,reversals:1,cases:1,chargeCents:5600});
 }
 for(const mode of ['branch','replay','rollback']){
  const order=await newOrder(),a=await invoice(),old=await call(setup,receipt(await call(setup,receiptReview(order,a))));
  await actor(owner);await call(setup,reverse(old));const b=await invoice(),c=await invoice();
  await actor(owner);const br=await call(setup,receiptReview(order,b)),cr=await call(setup,receiptReview(order,c)),cmd=replace(old,br);
  const result=await overlap(`receipt replacement ${mode}`,cmd,mode==='branch'?replace(old,cr):cmd,{leftActor:owner,rightActor:mode==='branch'?manager:owner,error:mode==='branch'?/different confirmed replacement/:undefined,rollbackFirst:mode==='rollback',same:mode==='replay'});
  await receiptCounts(order,{records:2,reversals:1,replacements:1,cases:1,chargeCents:5600});
  const saved=mode==='rollback'?result.second:result.first;
  assert.equal(saved.replacement.predecessorId,old.id);assert.equal(saved.replacement.replacementId,saved.receipt.id);assert.equal(saved.receipt.invoiceLineId,b.lid);
  assert.equal((await setup.query('select count(*) as count from estimated_order_receipts where invoice_line_id=$1',[c.lid])).rows[0].count,0,'Competing replacement cannot reserve an unused source');
  await actor(owner);assert.deepEqual(await call(setup,cmd),saved);
 }
}
