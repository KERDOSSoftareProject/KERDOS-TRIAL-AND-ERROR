-- A new source creates a new receipt; history is never rewritten or reactivated.
create table if not exists public.estimated_receipt_replacements(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),
 predecessor_id uuid not null unique references public.estimated_order_receipts(id),
 replacement_id uuid not null unique references public.estimated_order_receipts(id),
 order_id uuid not null references public.purchase_orders(id),
 reason text not null check(char_length(btrim(reason)) between 10 and 500),confirmed boolean not null default false,
 created_by uuid not null default auth.uid(),created_at timestamptz not null default current_timestamp,snapshot jsonb not null,
 check(predecessor_id<>replacement_id)
);
create index if not exists receipt_replacements_org on public.estimated_receipt_replacements(organization_id);
create index if not exists receipt_replacements_order on public.estimated_receipt_replacements(order_id);
alter table public.estimated_receipt_replacements enable row level security;
revoke all on public.estimated_receipt_replacements from public,anon,authenticated,service_role;
grant select on public.estimated_receipt_replacements to authenticated,service_role;
grant insert(organization_id,predecessor_id,replacement_id,reason,confirmed) on public.estimated_receipt_replacements to authenticated;
drop policy if exists "replacement members read" on public.estimated_receipt_replacements;
create policy "replacement members read" on public.estimated_receipt_replacements for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=estimated_receipt_replacements.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "replacement managers create" on public.estimated_receipt_replacements;
create policy "replacement managers create" on public.estimated_receipt_replacements for insert to authenticated with check(created_by=(select auth.uid()) and exists(select 1 from public.organization_members m where m.organization_id=estimated_receipt_replacements.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager')));
create or replace function public.kerdos_prepare_receipt_replacement()
returns trigger language plpgsql security invoker set search_path=public as $$
declare old_receipt public.estimated_order_receipts%rowtype;new_receipt public.estimated_order_receipts%rowtype;rv public.estimated_receipt_reversals%rowtype;
begin
 if not exists(select 1 from public.organization_members where organization_id=new.organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager membership is required to replace receipts';end if;
 if new.confirmed is distinct from true then raise exception 'Explicitly confirm receipt replacement';end if;
 if new.reason is null or new.reason is distinct from btrim(new.reason) or char_length(new.reason) not between 10 and 500 then raise exception 'Enter a replacement reason of 10 to 500 characters';end if;
 select * into old_receipt from public.estimated_order_receipts where id=new.predecessor_id and organization_id=new.organization_id;
 if not found then raise exception 'Predecessor receipt is outside this organization';end if;
 perform 1 from public.purchase_order_lines where id=old_receipt.order_line_id for update;
 select * into rv from public.estimated_receipt_reversals where receipt_id=old_receipt.id;
 if not found then raise exception 'Reverse the original receipt before replacing its source';end if;
 select * into new_receipt from public.estimated_order_receipts where id=new.replacement_id and organization_id=new.organization_id;
 if not found or new_receipt.id=old_receipt.id or new_receipt.order_line_id is distinct from old_receipt.order_line_id or new_receipt.invoice_line_id=old_receipt.invoice_line_id or new_receipt.created_by is distinct from (select auth.uid()) or new_receipt.created_at<rv.created_at then raise exception 'Replacement requires a new confirmed source for the same recorded order line';end if;
 if exists(select 1 from public.estimated_receipt_reversals where receipt_id=new_receipt.id) then raise exception 'Replacement receipt must be active';end if;
 if new.created_by is distinct from (select auth.uid()) or new.created_at is distinct from current_timestamp then raise exception 'Replacement actor and time must match';end if;
 new.order_id:=old_receipt.order_id;
 new.snapshot:=jsonb_build_object('kind','estimated_receipt_replacement','version',1,'id',new.id,'organizationId',new.organization_id,'orderId',new.order_id,'predecessorId',old_receipt.id,'replacementId',new_receipt.id,'reversalId',rv.id,'reason',new.reason,'replacedBy',new.created_by,'replacedAt',new.created_at);
 return new;
end;
$$;
drop trigger if exists receipt_replacement_prepare on public.estimated_receipt_replacements;
create trigger receipt_replacement_prepare before insert on public.estimated_receipt_replacements for each row execute function public.kerdos_prepare_receipt_replacement();
create or replace function public.kerdos_freeze_receipt_replacement()
returns trigger language plpgsql security invoker set search_path=public as $$
begin raise exception 'Receipt replacements are immutable';end;
$$;
drop trigger if exists receipt_replacement_immutable on public.estimated_receipt_replacements;
create trigger receipt_replacement_immutable before update or delete on public.estimated_receipt_replacements for each row execute function public.kerdos_freeze_receipt_replacement();
create or replace function public.kerdos_replace_estimated_receipt(p_organization_id uuid,p_predecessor_id uuid,p_order_line_id uuid,p_invoice_line_id uuid,p_received_cases integer,p_review jsonb,p_reason text,p_confirmed boolean,p_cases_confirmed boolean,p_replacement_confirmed boolean)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare old_receipt public.estimated_order_receipts%rowtype;s public.estimated_receipt_replacements%rowtype;r jsonb;
begin
 if not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager membership is required to replace receipts';end if;
 if p_confirmed is distinct from true or p_cases_confirmed is distinct from true or p_replacement_confirmed is distinct from true then raise exception 'Explicitly confirm replacement, invoice link and physically received cases';end if;
 if p_reason is null or p_reason is distinct from btrim(p_reason) or char_length(p_reason) not between 10 and 500 then raise exception 'Enter a replacement reason of 10 to 500 characters';end if;
 select * into old_receipt from public.estimated_order_receipts where id=p_predecessor_id and organization_id=p_organization_id;
 if not found or old_receipt.order_line_id is distinct from p_order_line_id then raise exception 'Predecessor receipt must belong to this recorded order line';end if;
 perform 1 from public.purchase_order_lines where id=p_order_line_id for update;
 if not exists(select 1 from public.estimated_receipt_reversals where receipt_id=p_predecessor_id) then raise exception 'Reverse the original receipt before replacing its source';end if;
 select * into s from public.estimated_receipt_replacements where predecessor_id=p_predecessor_id;
 if found then
  select snapshot into r from public.estimated_order_receipts where id=s.replacement_id;
  if s.created_by is distinct from (select auth.uid()) or s.reason is distinct from p_reason or r->>'invoiceLineId' is distinct from p_invoice_line_id::text or r->'receivedCaseQuantity' is distinct from to_jsonb(p_received_cases) or r->'sourceReview' is distinct from p_review then raise exception 'Predecessor already has a different confirmed replacement; refresh history';end if;
  return jsonb_build_object('receipt',r,'replacement',s.snapshot);
 end if;
 -- Any late audit failure rolls back both the receipt and its new invoice reservation.
 r:=public.kerdos_save_estimated_receipt(p_organization_id,p_order_line_id,p_invoice_line_id,p_received_cases,p_review,p_confirmed,p_cases_confirmed);
 insert into public.estimated_receipt_replacements(organization_id,predecessor_id,replacement_id,reason,confirmed) values(p_organization_id,p_predecessor_id,(r->>'id')::uuid,p_reason,p_replacement_confirmed) returning * into s;
 return jsonb_build_object('receipt',r,'replacement',s.snapshot);
end;
$$;
create or replace function public.kerdos_estimated_receipt_history(p_organization_id uuid,p_order_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare result jsonb;
begin
 if not exists(select 1 from public.purchase_orders where id=p_order_id and organization_id=p_organization_id and estimated_snapshot is not null) then raise exception 'Recorded estimated order is outside this organization';end if;
 select jsonb_build_object('receipts',(select coalesce(jsonb_agg(snapshot order by created_at,id),'[]') from public.estimated_order_receipts where organization_id=p_organization_id and order_id=p_order_id),'reversals',(select coalesce(jsonb_agg(snapshot order by created_at,id),'[]') from public.estimated_receipt_reversals where organization_id=p_organization_id and order_id=p_order_id),'replacements',(select coalesce(jsonb_agg(snapshot order by created_at,id),'[]') from public.estimated_receipt_replacements where organization_id=p_organization_id and order_id=p_order_id)) into result;
 return result;
end;
$$;
revoke all on function public.kerdos_prepare_receipt_replacement(),public.kerdos_freeze_receipt_replacement(),public.kerdos_replace_estimated_receipt(uuid,uuid,uuid,uuid,integer,jsonb,text,boolean,boolean,boolean) from public,anon;
grant execute on function public.kerdos_prepare_receipt_replacement(),public.kerdos_freeze_receipt_replacement(),public.kerdos_replace_estimated_receipt(uuid,uuid,uuid,uuid,integer,jsonb,text,boolean,boolean,boolean) to authenticated,service_role;
