-- Explicit invoice links and confirmed received cases; immutable estimates stay intact.
create table if not exists public.estimated_order_receipts(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),
 order_id uuid not null references public.purchase_orders(id),order_line_id uuid not null references public.purchase_order_lines(id),
 invoice_id uuid not null references public.invoices(id),invoice_line_id uuid not null unique references public.invoice_lines(id),
 received_cases integer not null check(received_cases>0),review jsonb not null,confirmed boolean not null default false,cases_confirmed boolean not null default false,
 created_by uuid not null default auth.uid(),created_at timestamptz not null default current_timestamp,snapshot jsonb not null
);
create index if not exists estimated_receipts_order on public.estimated_order_receipts(order_id);
create index if not exists estimated_receipts_order_line on public.estimated_order_receipts(order_line_id);
create index if not exists estimated_receipts_invoice on public.estimated_order_receipts(invoice_id);
alter table public.estimated_order_receipts enable row level security;
revoke all on public.estimated_order_receipts from public,anon,authenticated,service_role;
grant select on public.estimated_order_receipts to authenticated,service_role;
grant insert(organization_id,order_line_id,invoice_line_id,received_cases,review,confirmed,cases_confirmed) on public.estimated_order_receipts to authenticated;
drop policy if exists "receipt members read" on public.estimated_order_receipts;
create policy "receipt members read" on public.estimated_order_receipts for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=estimated_order_receipts.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "receipt purchasing create" on public.estimated_order_receipts;
create policy "receipt purchasing create" on public.estimated_order_receipts for insert to authenticated with check(created_by=(select auth.uid()) and exists(select 1 from public.organization_members m where m.organization_id=estimated_order_receipts.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager','employee')));

create or replace function public.kerdos_receipt_invoice_line(p_organization_id uuid,p_invoice_line_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare l public.invoice_lines%rowtype;i public.invoices%rowtype;
begin
 select * into l from public.invoice_lines where id=p_invoice_line_id;
 select * into i from public.invoices where id=l.invoice_id and organization_id=p_organization_id;
 if not found then raise exception 'Invoice line is outside this organization';end if;
 return jsonb_build_object('id',l.id,'sourceDocumentId',i.id,'sourceImportDocumentId',i.source_document_id,'documentKind','invoice','organizationId',i.organization_id,'vendorId',i.vendor_id,'vendorItemId',l.vendor_item_id,'invoiceNumber',i.invoice_number,'invoiceDate',i.invoice_date,'fileName',i.file_name,'filePath',i.file_path,'matchConfidence',l.match_confidence,
 'row',jsonb_build_object('code',l.vendor_item_code,'description',l.description,'qty',l.quantity,'price',l.unit_price,'amount',l.line_total,'sellingUnit',l.selling_unit,'packSize',l.pack_size,'sourceLine',l.source_line,'billingUnitEvidence',l.billing_unit_evidence,'sellingUnitSource',l.billing_unit_evidence->'source','priceHeader',l.billing_unit_evidence->'header','quoteUnitEvidence',case when l.billing_unit_evidence->>'kind'='explicit-price-unit' then jsonb_build_array(jsonb_build_object('unit',l.selling_unit,'source',l.billing_unit_evidence->'source')) else '[]'::jsonb end),
 'quantitySource',l.quantity_source,'billedQuantityEvidence',l.billed_quantity_evidence);
end;
$$;
create or replace function public.kerdos_invoice_charge_matches(p_source jsonb,p_source_line text,p_price numeric,p_amount numeric)
returns boolean language plpgsql immutable security invoker set search_path=public as $$
declare h text;idx integer:=0;pi integer;ai integer;pc integer:=0;ac integer:=0;p text;a text;parts text[];
begin
 if p_source->>'kind'='quantity-column' then
  for h in select value from jsonb_array_elements_text(to_jsonb(string_to_array(p_source->>'headerLine',E'\t'))) loop
   h:=lower(regexp_replace(btrim(h),'[[:space:]]+',' ','g'));
   if h~'^(unit price|price|rate|billed rate)$' then pc:=pc+1;pi:=idx;end if;
   if h~'^(extended price|extended amount|extended|line total|line amount|amount|ext[.]? price|total amount)$' then ac:=ac+1;ai:=idx;end if;idx:=idx+1;
  end loop;
  if pc<>1 or ac<>1 or pi=ai or pi=(p_source->>'columnIndex')::integer or ai=(p_source->>'columnIndex')::integer then return false;end if;
  p:=btrim(split_part(p_source_line,E'\t',pi+1));a:=btrim(split_part(p_source_line,E'\t',ai+1));
 elsif p_source->>'kind'='goods-invoice-weight' then
  parts:=regexp_match(p_source_line,'[[:space:]]+[$]([0-9,]+[.][0-9]{2})[[:space:]]+[$]([0-9,]+[.][0-9]{2})[[:space:]]*$');p:=parts[1];a:=parts[2];
 else return false;end if;
 if p is null or a is null or p!~'^[$]?([0-9]+|[0-9]{1,3}(,[0-9]{3})+)([.][0-9]+)?$' or a!~'^[$]?([0-9]+|[0-9]{1,3}(,[0-9]{3})+)([.][0-9]+)?$' then return false;end if;
 return replace(replace(p,'$',''),',','')::numeric=p_price and replace(replace(a,'$',''),',','')::numeric=p_amount;
end;
$$;
create or replace function public.kerdos_review_estimated_receipt(p_organization_id uuid,p_order_line_id uuid,p_invoice_line_id uuid,p_received_cases integer)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare l public.purchase_order_lines%rowtype;h public.purchase_orders%rowtype;i jsonb;r jsonb;terms jsonb;proof jsonb;expected numeric;variance numeric;bf numeric;qf numeric;pack jsonb;n jsonb;counts numeric:=1;outside boolean:=null;used integer;calc jsonb;
begin
 if (select auth.uid()) is null or not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager','employee')) then raise exception 'Purchasing membership is required';end if;
 select * into l from public.purchase_order_lines where id=p_order_line_id;
 select * into h from public.purchase_orders where id=l.purchase_order_id and organization_id=p_organization_id;
 if not found or h.estimated_snapshot is null or l.estimated_snapshot is null then raise exception 'A recorded estimated order line in this organization is required';end if;
 if p_received_cases is null or p_received_cases<=0 then raise exception 'Confirm a positive whole number of physically received cases';end if;
 if exists(select 1 from public.estimated_order_receipts where invoice_line_id=p_invoice_line_id) then raise exception 'Invoice line is already linked; recover its saved receipt';end if;
 select coalesce(sum(received_cases),0) into used from public.estimated_order_receipts where order_line_id=l.id;
 if used+p_received_cases>l.quantity then raise exception 'Receipts exceed the ordered case quantity';end if;
 i:=public.kerdos_receipt_invoice_line(p_organization_id,p_invoice_line_id);r:=i->'row';terms:=l.estimated_snapshot->'terms';
 if i->>'vendorId' is distinct from h.vendor_id::text or i->>'vendorItemId' is distinct from l.vendor_item_id::text or coalesce((i->>'matchConfidence')::numeric,0) not between 90 and 100 then raise exception 'Invoice product and vendor must match the recorded order';end if;
 if nullif(terms->>'vendorItemCode','') is not null and nullif(r->>'code','') is not null and terms->>'vendorItemCode' is distinct from r->>'code' then raise exception 'Invoice product code differs from the ordered item';end if;
 proof:=public.kerdos_invoice_quantity_proof(i->'quantitySource',(r->>'qty')::numeric,r->>'sellingUnit',r->>'sourceLine',r->'billingUnitEvidence');
 if proof is null or proof is distinct from i->'billedQuantityEvidence' then raise exception 'Invoice billed quantity needs retained source clarification';end if;
 if not public.kerdos_invoice_charge_matches(i->'quantitySource',r->>'sourceLine',(r->>'price')::numeric,(r->>'amount')::numeric) then raise exception 'Invoice printed rate and charge need source clarification';end if;
 if (r->>'price') is null or (r->>'amount') is null or (r->>'price') in ('NaN','Infinity','-Infinity') or (r->>'amount') in ('NaN','Infinity','-Infinity') or (r->>'price')::numeric<0 or (r->>'amount')::numeric<0 or round((r->>'qty')::numeric*(r->>'price')::numeric,2) is distinct from (r->>'amount')::numeric then raise exception 'Invoice arithmetic needs review before receiving';end if;
 bf:=case public.kerdos_mass_unit(r->>'sellingUnit') when 'LB' then 453.59237 when 'OZ' then 28.349523125 when 'KG' then 1000 when 'G' then 1 end;
 qf:=case public.kerdos_mass_unit(terms->>'quotedUnit') when 'LB' then 453.59237 when 'OZ' then 28.349523125 when 'KG' then 1000 when 'G' then 1 end;
 if bf is null or qf is null then raise exception 'Invoice billing measurement must be compatible mass';end if;
 expected:=round((r->>'qty')::numeric*(terms->>'quotedRate')::numeric*bf/qf,2);variance:=(r->>'amount')::numeric-expected;
 if abs(expected)*100>9007199254740991 or abs(variance)*100>9007199254740991 or (r->>'amount')::numeric*100>9007199254740991 then raise exception 'Receipt charge exceeds supported monetary precision';end if;
 pack:=public.kerdos_variable_mass_pack(terms->>'packSize');
 if (pack->>'range')::boolean then
  for n in select value from jsonb_array_elements(pack->'counts') loop counts:=counts*n::numeric;end loop;
  outside:=(r->>'qty')::numeric*bf/p_received_cases < counts*(pack->>'minimumBase')::numeric or (r->>'qty')::numeric*bf/p_received_cases > counts*(pack->>'maximumBase')::numeric;
 end if;
 calc:=jsonb_build_object('organizationId',p_organization_id,'vendorId',h.vendor_id,'vendorItemId',l.vendor_item_id,'orderId',h.id,'orderLineId',l.id,'approvalId',l.estimated_snapshot->'approvalId','invoiceDocumentId',i->'sourceDocumentId','invoiceLineId',i->'id','billedQuantity',r->'qty','billedUnit',r->'sellingUnit','billedRate',r->'price','actualCharge',r->'amount','expectedChargeAtQuotedRate',expected,'rateVariance',variance,'receivedCaseQuantity',p_received_cases,'weightOutsideStatedRange',outside,'sourceLine',r->'sourceLine','billingUnitEvidence',r->'billingUnitEvidence','billedQuantityEvidence',proof);
 return jsonb_build_object('kind','estimated_receipt_review','version',1,'organizationId',p_organization_id,'orderLine',l.estimated_snapshot,'invoiceLine',i,'receivedCaseQuantity',p_received_cases,'remainingCases',l.quantity-used,'calculation',calc);
end;
$$;
create or replace function public.kerdos_prepare_estimated_receipt()
returns trigger language plpgsql security invoker set search_path=public as $$
declare l public.purchase_order_lines%rowtype;il public.invoice_lines%rowtype;fresh jsonb;
begin
 if new.confirmed is distinct from true or new.cases_confirmed is distinct from true then raise exception 'Explicitly confirm the invoice link and physically received cases';end if;
 -- Order line first serializes all partial receipts; header then invoice line pins source.
 select * into l from public.purchase_order_lines where id=new.order_line_id for update;
 if not found then raise exception 'Recorded order line is unavailable';end if;
 select * into il from public.invoice_lines where id=new.invoice_line_id;
 if not found then raise exception 'Invoice line is unavailable';end if;
 perform 1 from public.invoices where id=il.invoice_id for share;
 perform 1 from public.invoice_lines where id=new.invoice_line_id and invoice_id=il.invoice_id for update;
 if not found then raise exception 'Invoice source changed; reload it';end if;
 fresh:=public.kerdos_review_estimated_receipt(new.organization_id,new.order_line_id,new.invoice_line_id,new.received_cases);
 if fresh is distinct from new.review then raise exception 'Invoice source or remaining cases changed; review the receipt again';end if;
 if new.created_by is distinct from (select auth.uid()) or new.created_at is distinct from current_timestamp then raise exception 'Receipt actor and time must match';end if;
 new.order_id:=l.purchase_order_id;new.invoice_id:=il.invoice_id;
 new.snapshot:=(fresh->'calculation')||jsonb_build_object('kind','variable_weight_receipt','version',1,'id',new.id,'receivedBy',new.created_by,'receivedAt',new.created_at,'caseEvidence',jsonb_build_object('kind','client_received_cases','quantity',new.received_cases,'confirmedBy',new.created_by,'confirmedAt',new.created_at),'sourceReview',fresh);
 return new;
end;
$$;
drop trigger if exists estimated_receipt_prepare on public.estimated_order_receipts;
create trigger estimated_receipt_prepare before insert on public.estimated_order_receipts for each row execute function public.kerdos_prepare_estimated_receipt();

create or replace function public.kerdos_save_estimated_receipt(p_organization_id uuid,p_order_line_id uuid,p_invoice_line_id uuid,p_received_cases integer,p_review jsonb,p_confirmed boolean,p_cases_confirmed boolean)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare saved public.estimated_order_receipts%rowtype;
begin
 if p_confirmed is distinct from true or p_cases_confirmed is distinct from true then raise exception 'Explicitly confirm the invoice link and physically received cases';end if;
 if not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager','employee')) then raise exception 'Purchasing membership is required';end if;
 perform 1 from public.purchase_order_lines l join public.purchase_orders h on h.id=l.purchase_order_id where l.id=p_order_line_id and h.organization_id=p_organization_id for update of l;
 if not found then raise exception 'Recorded order line is outside this organization';end if;
 -- The invoice row lock serializes duplicate attempts across different order lines.
 perform 1 from public.invoice_lines il join public.invoices i on i.id=il.invoice_id where il.id=p_invoice_line_id and i.organization_id=p_organization_id for share of i;
 if not found then raise exception 'Invoice line is outside this organization';end if;
 perform 1 from public.invoice_lines where id=p_invoice_line_id for update;
 select * into saved from public.estimated_order_receipts where invoice_line_id=p_invoice_line_id;
 if found then
  if saved.organization_id is distinct from p_organization_id or saved.order_line_id is distinct from p_order_line_id or saved.received_cases is distinct from p_received_cases or saved.created_by is distinct from (select auth.uid()) or saved.review is distinct from p_review then raise exception 'Invoice line already belongs to another confirmed receipt';end if;
  return saved.snapshot;
 end if;
 insert into public.estimated_order_receipts(organization_id,order_line_id,invoice_line_id,received_cases,review,confirmed,cases_confirmed) values(p_organization_id,p_order_line_id,p_invoice_line_id,p_received_cases,p_review,p_confirmed,p_cases_confirmed) returning * into saved;
 return saved.snapshot;
end;
$$;
create or replace function public.kerdos_receipt_candidates(p_organization_id uuid,p_order_line_id uuid,p_offset integer default 0)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare l public.purchase_order_lines%rowtype;h public.purchase_orders%rowtype;result jsonb;
begin
 if p_offset is null or p_offset<0 then raise exception 'Choose a valid invoice page';end if;
 select * into l from public.purchase_order_lines where id=p_order_line_id;
 select * into h from public.purchase_orders where id=l.purchase_order_id and organization_id=p_organization_id;
 if not found or l.estimated_snapshot is null then raise exception 'Recorded estimated order line is outside this organization';end if;
 select coalesce(jsonb_agg(public.kerdos_receipt_invoice_line(p_organization_id,x.id)||jsonb_build_object('linkedReceiptId',r.id) order by x.invoice_date desc,x.id),'[]') into result from (select il.id,i.invoice_date from public.invoice_lines il join public.invoices i on i.id=il.invoice_id where i.organization_id=p_organization_id and i.vendor_id=h.vendor_id and il.vendor_item_id=l.vendor_item_id order by i.invoice_date desc,il.id limit 50 offset p_offset) x left join public.estimated_order_receipts r on r.invoice_line_id=x.id;
 return result;
end;
$$;
create or replace function public.kerdos_list_estimated_receipts(p_organization_id uuid,p_order_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare result jsonb;
begin
 if not exists(select 1 from public.purchase_orders where id=p_order_id and organization_id=p_organization_id and estimated_snapshot is not null) then raise exception 'Recorded estimated order is outside this organization';end if;
 select coalesce(jsonb_agg(snapshot order by created_at,id),'[]') into result from public.estimated_order_receipts where organization_id=p_organization_id and order_id=p_order_id;
 return result;
end;
$$;
create or replace function public.kerdos_freeze_receipt_sources()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
 if tg_table_name='estimated_order_receipts' then raise exception 'Saved receipts are immutable';end if;
 if tg_table_name='invoice_lines' then
  if exists(select 1 from public.estimated_order_receipts where invoice_line_id=old.id) then raise exception 'Invoice lines linked to saved receipts are immutable';end if;
 else
  if exists(select 1 from public.estimated_order_receipts where invoice_id=old.id) and (tg_op='DELETE' or to_jsonb(new)-'status' is distinct from to_jsonb(old)-'status') then raise exception 'Invoice source linked to saved receipts is immutable';end if;
 end if;
 if tg_op='DELETE' then return old;end if;return new;
end;
$$;
drop trigger if exists estimated_receipts_immutable on public.estimated_order_receipts;
create trigger estimated_receipts_immutable before update or delete on public.estimated_order_receipts for each row execute function public.kerdos_freeze_receipt_sources();
drop trigger if exists received_invoice_line_immutable on public.invoice_lines;
create trigger received_invoice_line_immutable before update or delete on public.invoice_lines for each row execute function public.kerdos_freeze_receipt_sources();
drop trigger if exists received_invoice_source_immutable on public.invoices;
create trigger received_invoice_source_immutable before update or delete on public.invoices for each row execute function public.kerdos_freeze_receipt_sources();
revoke all on function public.kerdos_receipt_invoice_line(uuid,uuid),public.kerdos_review_estimated_receipt(uuid,uuid,uuid,integer),public.kerdos_prepare_estimated_receipt(),public.kerdos_save_estimated_receipt(uuid,uuid,uuid,integer,jsonb,boolean,boolean),public.kerdos_receipt_candidates(uuid,uuid,integer),public.kerdos_freeze_receipt_sources(),public.kerdos_list_estimated_receipts(uuid,uuid),public.kerdos_invoice_charge_matches(jsonb,text,numeric,numeric) from public,anon;
grant execute on function public.kerdos_receipt_invoice_line(uuid,uuid),public.kerdos_review_estimated_receipt(uuid,uuid,uuid,integer),public.kerdos_prepare_estimated_receipt(),public.kerdos_save_estimated_receipt(uuid,uuid,uuid,integer,jsonb,boolean,boolean),public.kerdos_receipt_candidates(uuid,uuid,integer),public.kerdos_freeze_receipt_sources(),public.kerdos_list_estimated_receipts(uuid,uuid),public.kerdos_invoice_charge_matches(jsonb,text,numeric,numeric) to authenticated,service_role;
