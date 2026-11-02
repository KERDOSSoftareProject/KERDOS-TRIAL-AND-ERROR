import fs from 'node:fs';
import {variableWeightFixture} from './variable-weight-db.mjs';
import {prepareVariableWeightApproval} from '../../core/variable-weight-purchasing.js';
import {prepareEstimatedPurchaseDraft} from '../../core/estimated-purchase-drafts.js';

// Shared fixture: embedded SQL regression and real PostgreSQL race acceptance.
export async function estimatedReceiptFixture({db:providedDb}={}){
const f=await variableWeightFixture({db:providedDb});const {db,org,owner,employee,vendor,vi,map,actor,admin,loadInput}=f;
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
for(const name of ['20261101201348_estimated_purchase_drafts.sql','20261101204628_close_estimated_draft_attempts.sql','20261101210029_estimated_order_submission.sql','20261101213251_invoice_billed_quantity_evidence.sql','20261101215229_estimated_order_receipts.sql','20261101221823_estimated_receipt_reversals.sql','20261101222925_estimated_receipt_replacements.sql','20261101225029_invoice_reconciliation_review.sql','20261101230555_invoice_accounting_approvals.sql','20261101232510_invoice_approval_withdrawals.sql','20261101234133_invoice_payment_ledger.sql','20261102000119_invoice_payment_corrections.sql','20261102000737_invoice_payment_correction_index.sql','20261102003947_invoice_summary_classification.sql','20261102005513_summary_label_whitespace_guard.sql']){const s=fs.readFileSync(new URL('../../../supabase/migrations/'+name,import.meta.url),'utf8');await db.exec(s);await db.exec(s);}
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
return {...f,input,a,intent,d,reviewOrder,order,ol,invoice};
}
