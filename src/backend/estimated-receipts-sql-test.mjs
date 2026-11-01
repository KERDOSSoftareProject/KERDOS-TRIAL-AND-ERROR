import fs from 'node:fs';
import assert from 'node:assert/strict';
import {variableWeightFixture} from './fixtures/variable-weight-db.mjs';
import {prepareVariableWeightApproval} from '../core/variable-weight-purchasing.js';
import {prepareEstimatedPurchaseDraft} from '../core/estimated-purchase-drafts.js';
import {validateReceiptReview,validateEstimatedReceipt,summarizeEstimatedOrderReceipts} from '../services/estimated-receipts.js';
const f=await variableWeightFixture();const {db,org,owner,employee,outsider,vendor,vi,map,actor,admin,loadInput}=f;
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
for(const name of ['20261101201348_estimated_purchase_drafts.sql','20261101204628_close_estimated_draft_attempts.sql','20261101210029_estimated_order_submission.sql','20261101213251_invoice_billed_quantity_evidence.sql','20261101215229_estimated_order_receipts.sql']){const s=fs.readFileSync(new URL('../../supabase/migrations/'+name,import.meta.url),'utf8');await db.exec(s);await db.exec(s);}
const input=await loadInput(owner);await actor(owner);const a=(await db.query('select kerdos_approve_variable_weight($1,$2,$3,0,$4) as a',[org,vi,map,JSON.stringify(prepareVariableWeightApproval(input))])).rows[0].a;
const intent=prepareEstimatedPurchaseDraft({organizationId:org,vendorId:vendor,requestId:'11111111-0000-0000-0000-000000000001',confirmed:true,now:new Date().toISOString(),lines:[{...input,quantity:2,orderUnit:'case',approval:{kind:'variable_weight_approval',version:1,id:a.id,terms:a.terms,approvedBy:owner,approvedAt:a.approved_at}}]});await actor(employee);
const d=(await db.query('select kerdos_save_estimated_draft($1,$2,$3,$4) as d',[org,vendor,intent.requestId,JSON.stringify(intent.lines)])).rows[0].d;
const reviewOrder=(await db.query('select kerdos_review_estimated_order($1,$2) as r',[org,d.id])).rows[0].r;
const order=(await db.query('select kerdos_submit_estimated_order($1,$2,$3,true,false) as o',[org,d.id,JSON.stringify(reviewOrder)])).rows[0].o;const ol=order.lines[0].id;
let sequence=0;
async function invoice({qty=14,rate=4,amount=qty*rate,unit='LB',header='Billed Weight',code='TEST-1',item=vi}={}){
 const iid='22222222-0000-0000-0000-'+String(++sequence).padStart(12,'0'),lid='33333333-0000-0000-0000-'+String(sequence).padStart(12,'0');
 await admin("insert into invoices(id,organization_id,vendor_id,total_amount,raw_text,invoice_date,invoice_number,status) values($1,$2,$3,$4,'original invoice text',current_date,$5,'recorded')",[iid,org,vendor,amount,'SYN-'+sequence]);
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
const viewer='44444444-0000-0000-0000-000000000001';await admin('insert into organization_members values($1,$2,$3)',[org,viewer,'viewer']);await actor(viewer);await assert.rejects(review(excess.lid),/membership/);
await actor(outsider);assert.equal((await db.query('select count(*) from estimated_order_receipts')).rows[0].count,0);await assert.rejects(review(first.lid),/membership/);
await actor(null,'anon');await assert.rejects(review(first.lid),/permission denied/);
assert.equal((await admin('select total_amount from purchase_orders where id=$1',[order.id])).rows[0].total_amount,null);await db.close();console.log('PASS receipt SQL/core parity: explicit cases/link, authoritative source and conversion, immutable source, partial/final summaries, unique replay, overdelivery, full rollback and role isolation.');
