-- Append-only reversal. The original receipt and invoice reservation remain immutable.
create table if not exists public.estimated_receipt_reversals(
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),
 receipt_id uuid not null unique references public.estimated_order_receipts(id),
 order_id uuid not null references public.purchase_orders(id),
 reason text not null check(char_length(btrim(reason)) between 10 and 500),
 confirmed boolean not null default false,
 created_by uuid not null default auth.uid(),created_at timestamptz not null default current_timestamp,
 snapshot jsonb not null
);
create index if not exists receipt_reversals_order on public.estimated_receipt_reversals(order_id);
create index if not exists receipt_reversals_org on public.estimated_receipt_reversals(organization_id);
alter table public.estimated_receipt_reversals enable row level security;
revoke all on public.estimated_receipt_reversals from public,anon,authenticated,service_role;
grant select on public.estimated_receipt_reversals to authenticated,service_role;
grant insert(organization_id,receipt_id,reason,confirmed) on public.estimated_receipt_reversals to authenticated;
drop policy if exists "reversal members read" on public.estimated_receipt_reversals;
create policy "reversal members read" on public.estimated_receipt_reversals for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=estimated_receipt_reversals.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "reversal managers create" on public.estimated_receipt_reversals;
create policy "reversal managers create" on public.estimated_receipt_reversals for insert to authenticated with check(created_by=(select auth.uid()) and exists(select 1 from public.organization_members m where m.organization_id=estimated_receipt_reversals.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager')));

create or replace function public.kerdos_prepare_receipt_reversal()
returns trigger language plpgsql security invoker set search_path=public as $$
declare r public.estimated_order_receipts%rowtype;
begin
 if not exists(select 1 from public.organization_members where organization_id=new.organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager membership is required to reverse receipts';end if;
 if new.confirmed is distinct from true then raise exception 'Explicitly confirm receipt reversal';end if;
 if new.reason is null or new.reason is distinct from btrim(new.reason) or char_length(new.reason) not between 10 and 500 then raise exception 'Enter a reversal reason of 10 to 500 characters';end if;
 select * into r from public.estimated_order_receipts where id=new.receipt_id and organization_id=new.organization_id;
 if not found then raise exception 'Receipt is outside this organization';end if;
 -- Match the save lock order. Receipt rows themselves are immutable.
 perform 1 from public.purchase_order_lines where id=r.order_line_id for update;
 if not found then raise exception 'Recorded order line is unavailable';end if;
 if new.created_by is distinct from (select auth.uid()) or new.created_at is distinct from current_timestamp then raise exception 'Reversal actor and time must match';end if;
 new.order_id:=r.order_id;
 new.snapshot:=jsonb_build_object('kind','estimated_receipt_reversal','version',1,'id',new.id,'organizationId',r.organization_id,'orderId',r.order_id,'receiptId',r.id,'reason',new.reason,'reversedBy',new.created_by,'reversedAt',new.created_at);
 return new;
end;
$$;
drop trigger if exists receipt_reversal_prepare on public.estimated_receipt_reversals;
create trigger receipt_reversal_prepare before insert on public.estimated_receipt_reversals for each row execute function public.kerdos_prepare_receipt_reversal();
create or replace function public.kerdos_freeze_receipt_reversal()
returns trigger language plpgsql security invoker set search_path=public as $$
begin raise exception 'Receipt reversals are immutable';end;
$$;
drop trigger if exists receipt_reversal_immutable on public.estimated_receipt_reversals;
create trigger receipt_reversal_immutable before update or delete on public.estimated_receipt_reversals for each row execute function public.kerdos_freeze_receipt_reversal();
create or replace function public.kerdos_reverse_estimated_receipt(p_organization_id uuid,p_receipt_id uuid,p_reason text,p_confirmed boolean)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare r public.estimated_order_receipts%rowtype;s public.estimated_receipt_reversals%rowtype;
begin
 if not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager membership is required to reverse receipts';end if;
 if p_confirmed is distinct from true then raise exception 'Explicitly confirm receipt reversal';end if;
 if p_reason is null or p_reason is distinct from btrim(p_reason) or char_length(p_reason) not between 10 and 500 then raise exception 'Enter a reversal reason of 10 to 500 characters';end if;
 select * into r from public.estimated_order_receipts where id=p_receipt_id and organization_id=p_organization_id;
 if not found then raise exception 'Receipt is outside this organization';end if;
 perform 1 from public.purchase_order_lines where id=r.order_line_id for update;
 select * into s from public.estimated_receipt_reversals where receipt_id=p_receipt_id;
 if found then
  if s.created_by is distinct from (select auth.uid()) or s.reason is distinct from p_reason then raise exception 'Receipt already reversed with a different request; refresh its history';end if;
  return s.snapshot;
 end if;
 insert into public.estimated_receipt_reversals(organization_id,receipt_id,reason,confirmed) values(p_organization_id,p_receipt_id,p_reason,p_confirmed) returning * into s;
 return s.snapshot;
end;
$$;
-- One SQL statement supplies a consistent receipt/reversal history snapshot.
create or replace function public.kerdos_estimated_receipt_history(p_organization_id uuid,p_order_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare result jsonb;
begin
 if not exists(select 1 from public.purchase_orders where id=p_order_id and organization_id=p_organization_id and estimated_snapshot is not null) then raise exception 'Recorded estimated order is outside this organization';end if;
 select jsonb_build_object('receipts',(select coalesce(jsonb_agg(snapshot order by created_at,id),'[]') from public.estimated_order_receipts where organization_id=p_organization_id and order_id=p_order_id),'reversals',(select coalesce(jsonb_agg(snapshot order by created_at,id),'[]') from public.estimated_receipt_reversals where organization_id=p_organization_id and order_id=p_order_id)) into result;
 return result;
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
 select coalesce(sum(received_cases),0) into used from public.estimated_order_receipts er where order_line_id=l.id and not exists(select 1 from public.estimated_receipt_reversals rv where rv.receipt_id=er.id);
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
revoke all on function public.kerdos_prepare_receipt_reversal(),public.kerdos_freeze_receipt_reversal(),public.kerdos_reverse_estimated_receipt(uuid,uuid,text,boolean),public.kerdos_estimated_receipt_history(uuid,uuid) from public,anon;
grant execute on function public.kerdos_prepare_receipt_reversal(),public.kerdos_freeze_receipt_reversal(),public.kerdos_reverse_estimated_receipt(uuid,uuid,text,boolean),public.kerdos_estimated_receipt_history(uuid,uuid) to authenticated,service_role;
