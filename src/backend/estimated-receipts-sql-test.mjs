import fs from 'node:fs';
import assert from 'node:assert/strict';
import {reconcileInvoice} from '../core/invoice-reconciliation.js';
import {variableWeightFixture} from './fixtures/variable-weight-db.mjs';
import {prepareVariableWeightApproval} from '../core/variable-weight-purchasing.js';
import {prepareEstimatedPurchaseDraft} from '../core/estimated-purchase-drafts.js';
import {validateReceiptReview,validateEstimatedReceipt,summarizeEstimatedOrderReceipts,validateReceiptHistory} from '../services/estimated-receipts.js';
const f=await variableWeightFixture();const {db,org,owner,manager,employee,outsider,vendor,vi,map,actor,admin,loadInput}=f;
await db.exec(`alter table organizations add column name text default 'Synthetic client';alter table vendors add column name text default 'Synthetic vendor';alter table vendors add column delivery_minimum_dollar numeric;alter table vendors add column delivery_minimum_units integer;
create role service_role;create table inbound_attachments(id uuid);create table inbound_messages(id uuid);
create table purchase_orders(id uuid primary key default gen_random_uuid(),organization_id uuid,vendor_id uuid,created_by uuid,status text,total_amount numeric,notes text,created_at timestamptz default current_timestamp,submitted_at timestamptz,meets_delivery_minimum boolean);
create table purchase_order_lines(id uuid primary key default gen_random_uuid(),purchase_order_id uuid references purchase_orders(id),catalog_item_id uuid,vendor_item_id uuid,quantity integer,unit_price numeric,line_total numeric,order_unit text,pack_size text);
create table invoices(id uuid primary key default gen_random_uuid(),organization_id uuid,vendor_id uuid,total_amount numeric,raw_text text,invoice_date date,invoice_number text,status text,file_path text,file_name text,source_document_id uuid);
create table invoice_lines(id uuid primary key default gen_random_uuid(),invoice_id uuid references invoices(id),vendor_item_id uuid,vendor_item_code text,description text,quantity numeric,unit_price numeric,line_total numeric,selling_unit text,pack_size text,source_line text,billing_unit_evidence jsonb,match_confidence numeric);
alter table purchase_orders enable row level security;alter table purchase_order_lines enable row level security;alter table invoices enable row level security;alter table invoice_lines enable row level security;
grant select,insert,update,delete on purchase_orders,purchase_order_lines,invoices,invoice_lines to authenticated;
create policy member_orders on purchase_orders for all to authenticated using(exists(select 1 from organization_members m where m.organization_id=purchase_orders.organization_id and m.user_id=auth.uid()));
create policy member_lines on purchase_order_lines for all to authenticated using(exists(select 1 from purchase_orders p join organization_members m on m.organization_id=p.organization_id where p.id=purchase_order_lines.purchase_order_id and m.user_id=auth.uid()));
create policy member_invoices on invoices for all to authenticated using(exists(select 1 from organization_members m where m.organization_id=invoices.organization_id and m.user_id=auth.uid()));
create policy member_invoice_lines on invoice_lines for all to authenticated using(exists(select 1 from invoices i join organization_members m on m.organization_id=i.organization_id where i.id=invoice_lines.invoice_id and m.user_id=auth.uid()));`);
for(const name of ['20261101201348_estimated_purchase_drafts.sql','20261101204628_close_estimated_draft_attempts.sql','20261101210029_estimated_order_submission.sql','20261101213251_invoice_billed_quantity_evidence.sql','20261101215229_estimated_order_receipts.sql','20261101221823_estimated_receipt_reversals.sql','20261101222925_estimated_receipt_replacements.sql','20261101225029_invoice_reconciliation_review.sql']){const s=fs.readFileSync(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8');await db.exec(s);await db.exec(s);}
const input=await loadInput(owner);await actor(owner);const a=(await db.query('select kerdos_approve_variable_weight($1,$2,$3,0,$4) as a',[org,vi,map,JSON.stringify(prepareVariableWeightApproval(input))])).rows[0].a;
const intent=prepareEstimatedPurchaseDraft({organizationId:org,vendorId:vendor,requestId:'11111111-0000-0000-0000-000000000001',confirmed:true,now:new Date().toISOString(),lines:[{...input,quantity:2,orderUnit:'case',approval:{kind:'variable_weight_approval',version:1,id:a.id,terms:a.terms,approvedBy:owner,approvedAt:a.approved_at}}]});await actor(employee);
const d=(await db.query('select kerdos_save_estimated_draft($1,$2,$3,$4) as d',[org,vendor,intent.requestId,JSON.stringify(intent.lines)])).rows[0].d;
const reviewOrder=(await db.query('select kerdos_review_estimated_order($1,$2) as r',[org,d.id])).rows[0].r;
const order=(await db.query('select kerdos_submit_estimated_order($1,$2,$3,true,false) as o',[org,d.id,JSON.stringify(reviewOrder)])).rows[0].o;const ol=order.lines[0].id;
let sequence=0;
async function invoice({qty=14,rate=4,amount=qty*rate,unit='LB',header='Billed Weight',code='TEST-1',item=vi}={}){
 const iid='22222222-0000-0000-0000-'+String(++sequence).padStart(12,'0'),lid='33333333-0000-0000-0000-'+String(sequence).padStart(12,'0');
 await admin("insert into invoices(id,organization_id,vendor_id,total_amount,raw_text,invoice_date,invoice_number,status) values($1,$2,$3,$4,$6,current_date,$5,'recorded')",[iid,org,vendor,amount,'SYN-'+sequence,`Subtotal ${amount.toFixed(2)}\nTax 0.00\nFreight 0.00\nCredits 0.00\nInvoice Total ${amount.toFixed(2)}`]);
 const source={kind:'quantity-column',header,rawValue:String(qty),columnIndex:1,headerLine:'Item\t'+header+'\tPrice\tAmount'};
 await admin('insert into invoice_lines(id,invoice_id,vendor_item_id,vendor_item_code,description,quantity,unit_price,line_total,selling_unit,source_line,billing_unit_evidence,quantity_source,match_confidence) values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,100)',[lid,iid,item,code,'Synthetic invoice line',qty,rate,amount,unit,`${code}\t${qty}\t${rate}\t${amount}`,JSON.stringify({kind:'pricing-unit-header',header:'Price Unit',unit}),JSON.stringify(source)]);await actor(employee);return {iid,lid};
}
const review=async id=>(await db.query('select kerdos_review_estimated_receipt($1,$2,$3,1) as r',[org,ol,id])).rows[0].r;
const save=async(r,confirmed=true,cases=true)=>(await db.query('select kerdos_save_estimated_receipt($1,$2,$3,$4,$5,$6,$7) as r',[org,ol,r.invoiceLine.id,r.receivedCaseQuantity,JSON.stringify(r),confirmed,cases])).rows[0].r;
const first=await invoice();const r=await review(first.lid);validateReceiptReview(r,{organizationId:org,orderLineId:ol,invoiceLineId:first.lid,cases:1});
assert.equal(r.calculation.actualCharge,56);assert.equal(r.calculation.weightOutsideStatedRange,false);await assert.rejects(save(r,false),/confirm/);await assert.rejects(save(r,true,false),/confirm/);await assert.rejects(save({...r,calculation:{...r.calculation,actualCharge:1}}),/changed/);
await admin('update invoice_lines set unit_price=5,line_total=70 where id=$1',[first.lid]);await actor(employee);await assert.rejects(save(r),/printed rate|source clarification/);await admin('update invoice_lines set unit_price=4,line_total=56 where id=$1',[first.lid]);await actor(employee);
const receipt=await save(r);validateEstimatedReceipt(receipt,org,order.id);assert.equal((await save(r)).id,receipt.id);assert.equal(summarizeEstimatedOrderReceipts(order,[receipt]).actualCharge,null);assert.equal(summarizeEstimatedOrderReceipts(order,[receipt]).recordedCharge,56);
for(const q of ["update invoice_lines set unit_price=5 where id=$1","delete from invoice_lines where id=$1"]){await assert.rejects(db.query(q,[first.lid]),/immutable/);}
await assert.rejects(db.query('update invoices set total_amount=1 where id=$1',[first.iid]),/immutable/);await assert.rejects(db.query('delete from invoices where id=$1',[first.iid]),/immutable/);await db.query("update invoices set status='review' where id=$1",[first.iid]);
await assert.rejects(db.query('update estimated_order_receipts set received_cases=2'),/permission denied/);await assert.rejects(db.query('delete from estimated_order_receipts'),/permission denied/);
const generic=await invoice({header:'Qty'});await assert.rejects(review(generic.lid),/clarification/);
const bad=await invoice({amount:99});await assert.rejects(review(bad.lid),/arithmetic/);
const wrongCode=await invoice({code:'DIFFERENT'});await assert.rejects(review(wrongCode.lid),/code differs/);
const second=await invoice({qty:224,rate:.3125,amount:70,unit:'OZ'});const r2=await review(second.lid);validateReceiptReview(r2,{organizationId:org,orderLineId:ol,invoiceLineId:second.lid,cases:1});assert.equal(r2.calculation.expectedChargeAtQuotedRate,56);assert.equal(r2.calculation.rateVariance,14);
// Failure late in the trigger still rolls back the receipt and its unique link.
await admin("create function fail_receipt() returns trigger language plpgsql as $$begin raise exception 'controlled receipt failure';end;$$;");await admin('create trigger zz_fail_receipt after insert on estimated_order_receipts for each row execute function fail_receipt()');await actor(employee);await assert.rejects(save(r2),/controlled receipt failure/);assert.equal((await db.query('select count(*) from estimated_order_receipts')).rows[0].count,1);await admin('drop trigger zz_fail_receipt on estimated_order_receipts');await actor(employee);
const receipt2=await save(r2);validateEstimatedReceipt(receipt2,org,order.id);const summary=summarizeEstimatedOrderReceipts(order,[receipt,receipt2]);assert.equal(summary.status,'complete');assert.equal(summary.actualCharge,126);assert.deepEqual(summary.estimate,order.estimate);
const excess=await invoice();await assert.rejects(review(excess.lid),/exceed/);await assert.rejects(save({...r,receivedCaseQuantity:2}),/another confirmed receipt/);
const candidates=(await db.query('select kerdos_receipt_candidates($1,$2,0) as c',[org,ol])).rows[0].c;assert.equal(candidates.find(c=>c.id===first.lid).linkedReceiptId,receipt.id);
assert.equal((await db.query('select kerdos_list_estimated_receipts($1,$2) as r',[org,order.id])).rows[0].r.length,2);
// The same invoice line cannot be reassigned to a different recorded order.
await actor(employee);const d2=(await db.query('select kerdos_save_estimated_draft($1,$2,$3,$4) as d',[org,vendor,'11111111-0000-0000-0000-000000000002',JSON.stringify(intent.lines)])).rows[0].d;
const or2=(await db.query('select kerdos_review_estimated_order($1,$2) as r',[org,d2.id])).rows[0].r;
const secondOrder=(await db.query('select kerdos_submit_estimated_order($1,$2,$3,true,false) as o',[org,d2.id,JSON.stringify(or2)])).rows[0].o;const ol2=secondOrder.lines[0].id;
await assert.rejects(db.query('select kerdos_save_estimated_receipt($1,$2,$3,1,$4,true,true)',[org,ol2,first.lid,JSON.stringify(r)]),/another confirmed receipt/);
const extreme=await invoice({qty:30,rate:4,amount:120});const extremeReview=(await db.query('select kerdos_review_estimated_receipt($1,$2,$3,1) as r',[org,ol2,extreme.lid])).rows[0].r;validateReceiptReview(extremeReview,{organizationId:org,orderLineId:ol2,invoiceLineId:extreme.lid,cases:1});assert.equal(extremeReview.calculation.weightOutsideStatedRange,true);
const stale=(await db.query('select kerdos_review_estimated_receipt($1,$2,$3,1) as r',[org,ol2,excess.lid])).rows[0].r;
await db.query('select kerdos_save_estimated_receipt($1,$2,$3,1,$4,true,true)',[org,ol2,extreme.lid,JSON.stringify(extremeReview)]);
await assert.rejects(db.query('select kerdos_save_estimated_receipt($1,$2,$3,1,$4,true,true)',[org,ol2,excess.lid,JSON.stringify(stale)]),/remaining cases changed/);
// Append-only reversal is manager/owner-only and restores remaining cases without reusing its invoice.
const reverse=async(id=receipt.id,reason='Incorrect received case confirmation',confirmed=true)=>(await db.query('select kerdos_reverse_estimated_receipt($1,$2,$3,$4) as r',[org,id,reason,confirmed])).rows[0].r;
await actor(employee);await assert.rejects(reverse(),/Owner or manager/);
await assert.rejects(db.query('insert into estimated_receipt_reversals(organization_id,receipt_id,reason,confirmed) values($1,$2,$3,true)',[org,receipt.id,'Bypassing the application control']),/Owner or manager/);
await actor(owner);await assert.rejects(reverse(receipt.id,'Too short'),/reason/);await assert.rejects(reverse(receipt.id,'Incorrect received case confirmation',false),/confirm/);
await assert.rejects(reverse(receipt.id,' Incorrect received case confirmation'),/reason/);
const reversal=await reverse();assert.equal((await reverse()).id,reversal.id);await assert.rejects(reverse(receipt.id,'Different correction reason'),/different request/);
const history=(await db.query('select kerdos_estimated_receipt_history($1,$2) as h',[org,order.id])).rows[0].h;
validateReceiptHistory(history,org,order.id);assert.equal(history.receipts.length,2);assert.equal(history.reversals.length,1);
const after=summarizeEstimatedOrderReceipts(order,history.receipts,history.reversals);assert.equal(after.status,'partial');assert.equal(after.recordedCharge,70);assert.equal(after.actualCharge,null);assert.equal(after.lines[0].receivedCaseQuantity,1);assert.deepEqual(after.estimate,order.estimate);
assert.throws(()=>summarizeEstimatedOrderReceipts(order,history.receipts,[...history.reversals,...history.reversals]),/duplicate/);
assert.throws(()=>summarizeEstimatedOrderReceipts(order,history.receipts,[{...reversal,receiptId:'missing'}]),/unknown/);
await assert.rejects(db.query('update estimated_receipt_reversals set reason=$1',['Changed reversal reason']),/permission denied/);await assert.rejects(db.query('delete from estimated_receipt_reversals'),/permission denied/);
await assert.rejects(review(first.lid),/already linked/);await actor(employee);assert.equal((await save(r)).id,receipt.id);await actor(owner); // historical replay never reactivates it
await assert.rejects(db.query("update invoice_lines set description='Changed source' where id=$1",[first.lid]),/immutable/);
const restored=await review(excess.lid);assert.equal(restored.remainingCases,1);
// A second reversal changes remaining cases and invalidates an older review.
await reverse(receipt2.id);await assert.rejects(save(restored),/remaining cases changed/);
const fresh=await review(excess.lid);assert.equal(fresh.remainingCases,2);const replacement=await save(fresh);
assert.equal(summarizeEstimatedOrderReceipts(order,[receipt,receipt2,replacement],[reversal,(await db.query('select snapshot from estimated_receipt_reversals where receipt_id=$1',[receipt2.id])).rows[0].snapshot]).recordedCharge,56);
await actor(employee);await assert.rejects(reverse(),/Owner or manager/);
await actor(outsider);assert.equal((await db.query('select count(*) from estimated_receipt_reversals')).rows[0].count,0);await assert.rejects(db.query('select kerdos_estimated_receipt_history($1,$2)',[org,order.id]),/outside/);await assert.rejects(reverse(),/Owner or manager/);
await actor(null,'anon');await assert.rejects(reverse(),/permission denied/);
await actor(owner);await assert.rejects(admin('update estimated_receipt_reversals set reason=$1',['Tamper reversal history']),/immutable/);await actor(owner);
// A different invoice source creates a new receipt and an immutable lineage in one transaction.
const corrected=await invoice({qty:18,rate:4,amount:72});await actor(owner);const correctedReview=await review(corrected.lid);
const replaceReceipt=async({predecessor=receipt2.id,r=correctedReview,reason='Corrected invoice supplied by vendor',confirmed=true,cases=true,replacementConfirmed=true}={})=>(await db.query('select kerdos_replace_estimated_receipt($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as r',[org,predecessor,ol,r.invoiceLine.id,r.receivedCaseQuantity,JSON.stringify(r),reason,confirmed,cases,replacementConfirmed])).rows[0].r;
await assert.rejects(replaceReceipt({replacementConfirmed:false}),/confirm/);await assert.rejects(replaceReceipt({cases:false}),/confirm/);await assert.rejects(replaceReceipt({confirmed:false}),/confirm/);await assert.rejects(replaceReceipt({reason:'short'}),/reason/);
await assert.rejects(replaceReceipt({predecessor:replacement.id}),/Reverse/);
await actor(employee);await assert.rejects(replaceReceipt(),/Owner or manager/);await assert.rejects(db.query('insert into estimated_receipt_replacements(organization_id,predecessor_id,replacement_id,reason,confirmed) values($1,$2,$3,$4,true)',[org,receipt2.id,replacement.id,'Attempt unauthorized source link']),/Owner or manager/);await actor(owner);
await admin("create function fail_replacement() returns trigger language plpgsql as $$begin raise exception 'controlled replacement failure';end;$$;");await admin('create trigger zz_fail_replacement after insert on estimated_receipt_replacements for each row execute function fail_replacement()');await actor(owner);
await assert.rejects(replaceReceipt(),/controlled replacement failure/);assert.equal((await db.query('select count(*) from estimated_order_receipts where invoice_line_id=$1',[corrected.lid])).rows[0].count,0);await admin('drop trigger zz_fail_replacement on estimated_receipt_replacements');await actor(owner);
const replaced=await replaceReceipt();assert.deepEqual(await replaceReceipt(),replaced);await assert.rejects(replaceReceipt({reason:'Different source replacement reason'}),/different confirmed replacement/);
await assert.rejects(replaceReceipt({predecessor:receipt.id}),/unique|duplicate/);
await assert.rejects(db.query('select kerdos_replace_estimated_receipt($1,$2,$3,$4,1,$5,$6,true,true,true)',[org,receipt.id,ol2,corrected.lid,JSON.stringify(correctedReview),'Wrong recorded order line']),/belong/);
const replacementHistory=(await db.query('select kerdos_estimated_receipt_history($1,$2) as h',[org,order.id])).rows[0].h;validateReceiptHistory(replacementHistory,org,order.id);assert.equal(replacementHistory.replacements.length,1);assert.equal(replacementHistory.replacements[0].predecessorId,receipt2.id);assert.equal(replacementHistory.replacements[0].replacementId,replaced.receipt.id);
assert.equal(summarizeEstimatedOrderReceipts(order,replacementHistory.receipts,replacementHistory.reversals).actualCharge,128);
await assert.rejects(db.query('update estimated_receipt_replacements set reason=$1',['Change audit lineage']),/permission denied/);await assert.rejects(db.query('delete from estimated_receipt_replacements'),/permission denied/);await assert.rejects(admin('delete from estimated_receipt_replacements'),/immutable/);await actor(owner);
await assert.rejects(review(second.lid),/already linked/);await assert.rejects(review(corrected.lid),/already linked/);
const malformed=structuredClone(replacementHistory);malformed.replacements[0].reversalId='unrelated';assert.throws(()=>validateReceiptHistory(malformed,org,order.id),/lineage/);
const duplicate=structuredClone(replacementHistory);duplicate.replacements.push(duplicate.replacements[0]);assert.throws(()=>validateReceiptHistory(duplicate,org,order.id),/Duplicate/);
// Replacing a replacement makes a chain. Historical retry cannot reactivate the reversed middle receipt.
await actor(manager);await db.query('select kerdos_reverse_estimated_receipt($1,$2,$3,true)',[org,replaced.receipt.id,'Vendor issued another corrected invoice']);
const finalSource=await invoice({qty:15,rate:4,amount:60});await actor(manager);const finalReview=await review(finalSource.lid);const finalReplacement=await replaceReceipt({predecessor:replaced.receipt.id,r:finalReview});assert.equal(finalReplacement.replacement.predecessorId,replaced.receipt.id);
const chain=(await db.query('select kerdos_estimated_receipt_history($1,$2) as h',[org,order.id])).rows[0].h;validateReceiptHistory(chain,org,order.id);assert.equal(chain.replacements.length,2);assert.equal(summarizeEstimatedOrderReceipts(order,chain.receipts,chain.reversals).actualCharge,116);
await actor(owner);assert.deepEqual(await replaceReceipt(),replaced);await actor(outsider);assert.equal((await db.query('select count(*) from estimated_receipt_replacements')).rows[0].count,0);await assert.rejects(replaceReceipt(),/Owner or manager/);await actor(null,'anon');await assert.rejects(replaceReceipt(),/permission denied/);
// Invoice-wide review is a complete read snapshot, not a settled/payment record.
await actor(employee);const invoiceReview=(await db.query('select kerdos_review_invoice_reconciliation($1,$2) as s',[org,finalSource.iid])).rows[0].s;const reconciled=reconcileInvoice(invoiceReview,{organizationId:org,invoiceId:finalSource.iid});assert.equal(reconciled.status,'reconciled');assert.equal(reconciled.lineCents,6000);assert.equal(reconciled.settlementStatus,'not_recorded');
const reversedReview=(await db.query('select kerdos_review_invoice_reconciliation($1,$2) as s',[org,first.iid])).rows[0].s;assert.equal(reconcileInvoice(reversedReview,{organizationId:org,invoiceId:first.iid}).coverage,'none');
const bulk=await invoice({qty:1,rate:1,amount:1});await admin("insert into invoice_lines(invoice_id,vendor_item_id,vendor_item_code,description,quantity,unit_price,line_total,selling_unit,source_line) select $1,$2,'TEST-1','Bulk invoice line',1,1,1,'LB','Retained bulk row' from generate_series(1,1001)",[bulk.iid,vi]);await admin("update invoices set total_amount=1002,raw_text=E'Subtotal 1002.00\\nTax 0.00\\nFreight 0.00\\nCredits 0.00\\nInvoice Total 1002.00' where id=$1",[bulk.iid]);await actor(employee);
const bulkReview=(await db.query('select kerdos_review_invoice_reconciliation($1,$2) as s',[org,bulk.iid])).rows[0].s;assert.equal(bulkReview.lines.length,1002);assert.equal(reconcileInvoice(bulkReview,{organizationId:org,invoiceId:bulk.iid}).lineCents,100200);
await actor(outsider);await assert.rejects(db.query('select kerdos_review_invoice_reconciliation($1,$2)',[org,first.iid]),/membership/);await actor(null,'anon');await assert.rejects(db.query('select kerdos_review_invoice_reconciliation($1,$2)',[org,first.iid]),/permission denied/);await actor(employee);await assert.rejects(db.query('select kerdos_review_invoice_reconciliation($1,$2)',[org,'55555555-0000-0000-0000-000000000001']),/outside/);
const viewer='44444444-0000-0000-0000-000000000001';await admin('insert into organization_members values($1,$2,$3)',[org,viewer,'viewer']);await actor(viewer);await assert.rejects(review(excess.lid),/membership/);
await actor(outsider);assert.equal((await db.query('select count(*) from estimated_order_receipts')).rows[0].count,0);await assert.rejects(review(first.lid),/membership/);
await actor(null,'anon');await assert.rejects(review(first.lid),/permission denied/);
assert.equal((await admin('select total_amount from purchase_orders where id=$1',[order.id])).rows[0].total_amount,null);await db.close();console.log('PASS receipt SQL/core parity: explicit cases/link, authoritative source and conversion, immutable source, partial/final summaries, unique replay, overdelivery, full rollback and role isolation.');
