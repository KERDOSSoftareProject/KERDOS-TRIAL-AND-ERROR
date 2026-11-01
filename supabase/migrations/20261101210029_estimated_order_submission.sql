-- Shared purchase-order history retains typed estimates, never a scalar final charge.
alter table public.purchase_orders add column if not exists estimated_snapshot jsonb;
alter table public.purchase_order_lines add column if not exists estimated_snapshot jsonb;
create table if not exists public.estimated_draft_submissions(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),
 draft_id uuid not null unique references public.estimated_purchase_drafts(id),
 purchase_order_id uuid not null unique default gen_random_uuid() references public.purchase_orders(id) deferrable initially deferred,
 created_by uuid not null default auth.uid(),created_at timestamptz not null default current_timestamp,
 review jsonb not null,minimum_acknowledged boolean not null default false,order_snapshot jsonb not null
);
alter table public.estimated_draft_submissions enable row level security;
revoke all on public.estimated_draft_submissions from public,anon,authenticated;
grant select on public.estimated_draft_submissions to authenticated;
grant insert(organization_id,draft_id,review,minimum_acknowledged) on public.estimated_draft_submissions to authenticated;
drop policy if exists "submission members read" on public.estimated_draft_submissions;
create policy "submission members read" on public.estimated_draft_submissions for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=estimated_draft_submissions.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "submission purchasing create" on public.estimated_draft_submissions;
create policy "submission purchasing create" on public.estimated_draft_submissions for insert to authenticated with check(created_by=(select auth.uid()) and exists(select 1 from public.organization_members m where m.organization_id=estimated_draft_submissions.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager','employee')));

create or replace function public.kerdos_review_estimated_order(p_organization_id uuid,p_draft_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare d public.estimated_purchase_drafts%rowtype; v public.vendors%rowtype; cases numeric; minimum_status text;
begin
 select * into d from public.estimated_purchase_drafts where organization_id=p_organization_id and id=p_draft_id;
 if not found then raise exception 'Draft is outside this organization'; end if;
 if not exists(select 1 from public.organization_members m where m.organization_id=p_organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager','employee') and (d.created_by=(select auth.uid()) or m.role in ('owner','manager'))) then raise exception 'Only the creator, owner or manager can record this order'; end if;
 if d.status<>'draft' then raise exception 'Cancelled drafts cannot be submitted'; end if;
 if exists(select 1 from public.estimated_draft_submissions where draft_id=d.id) then raise exception 'This draft already has a recorded order'; end if;
 perform public.kerdos_estimated_draft_intents(p_organization_id,d.vendor_id,d.requested_lines);
 select * into v from public.vendors where id=d.vendor_id and organization_id=p_organization_id;
 if not found then raise exception 'Vendor is outside this organization'; end if;
 select sum((value->>'quantity')::numeric) into cases from jsonb_array_elements(d.requested_lines);
 minimum_status:=case when coalesce(v.delivery_minimum_units,0)>cases then 'units_short' when coalesce(v.delivery_minimum_dollar,0)>0 then 'unknown' else 'met' end;
 return jsonb_build_object('kind','estimated_order_review','version',1,'organizationId',p_organization_id,'vendorId',d.vendor_id,'draftId',d.id,
 'customerName',(select name from public.organizations where id=p_organization_id),'vendorName',v.name,'requestedLines',d.requested_lines,'estimate',d.estimate,'finalCharge',null,
 'deliveryMinimum',jsonb_build_object('dollar',v.delivery_minimum_dollar,'units',v.delivery_minimum_units,'caseQuantity',cases,'status',minimum_status));
end;
$$;

create or replace function public.kerdos_prepare_estimated_submission()
returns trigger language plpgsql security invoker set search_path=public as $$
declare d public.estimated_purchase_drafts%rowtype; fresh jsonb; lines jsonb;
begin
 select * into d from public.estimated_purchase_drafts where id=new.draft_id and organization_id=new.organization_id for update;
 if not found then raise exception 'Draft is outside this organization'; end if;
 fresh:=public.kerdos_review_estimated_order(new.organization_id,new.draft_id);
 if new.review is distinct from fresh then raise exception 'Order terms or delivery minimum changed; review again'; end if;
 if fresh->'deliveryMinimum'->>'status'='units_short' then raise exception 'The stated case minimum is not met'; end if;
 if fresh->'deliveryMinimum'->>'status'='unknown' and new.minimum_acknowledged is distinct from true then raise exception 'Acknowledge the unknown monetary delivery minimum'; end if;
 if new.created_by is distinct from (select auth.uid()) or new.created_at is distinct from current_timestamp then raise exception 'Submission actor and time must match'; end if;
 select jsonb_agg((value-'id'-'orderId'-'kind')||jsonb_build_object('id',gen_random_uuid(),'orderId',new.purchase_order_id,'kind','estimated_purchase_line') order by ordinal)
 into lines from jsonb_array_elements(d.lines) with ordinality as parts(value,ordinal);
 new.order_snapshot:=jsonb_build_object('kind','estimated_purchase_order','version',1,'id',new.purchase_order_id,'organizationId',d.organization_id,'vendorId',d.vendor_id,'sourceDraftId',d.id,'customerName',fresh->'customerName','vendorName',fresh->'vendorName','submittedBy',new.created_by,'submittedAt',new.created_at,'lines',lines,'estimate',d.estimate,'deliveryMinimum',fresh->'deliveryMinimum','finalCharge',null,'deliveryStatus','not_sent');
 return new;
end;
$$;
drop trigger if exists estimated_submission_prepare on public.estimated_draft_submissions;
create trigger estimated_submission_prepare before insert on public.estimated_draft_submissions for each row execute function public.kerdos_prepare_estimated_submission();

create or replace function public.kerdos_guard_estimated_order_records()
returns trigger language plpgsql security invoker set search_path=public as $$
declare s public.estimated_draft_submissions%rowtype; snapshot jsonb; parent public.purchase_orders%rowtype; line jsonb;
begin
 if tg_table_name='purchase_orders' then
   if tg_op<>'INSERT' then
     if old.estimated_snapshot is not null or (tg_op='UPDATE' and new.estimated_snapshot is not null) then raise exception 'Recorded estimated orders are immutable'; end if;
     if tg_op='DELETE' then return old; end if;return new;
   end if;
   if new.estimated_snapshot is null then return new; end if;
   select * into s from public.estimated_draft_submissions where purchase_order_id=new.id;
   if not found then raise exception 'An authenticated estimated submission is required'; end if;
   snapshot:=s.order_snapshot;
   if new.organization_id is distinct from s.organization_id or new.vendor_id is distinct from (snapshot->>'vendorId')::uuid or new.created_by is distinct from s.created_by or new.status is distinct from 'submitted' or new.total_amount is not null or new.estimated_snapshot is distinct from snapshot or new.submitted_at is distinct from s.created_at or new.created_at is distinct from s.created_at or new.notes is not null or new.meets_delivery_minimum is distinct from (case when snapshot->'deliveryMinimum'->>'status'='met' then true else null end) then raise exception 'Order header differs from its authoritative submission'; end if;
 else
   if tg_op<>'INSERT' then
     select * into parent from public.purchase_orders where id=old.purchase_order_id;
     if parent.estimated_snapshot is not null or old.estimated_snapshot is not null or (tg_op='UPDATE' and new.estimated_snapshot is not null) then raise exception 'Recorded estimated order lines are immutable'; end if;
     if tg_op='DELETE' then return old; end if;
   end if;
   select * into parent from public.purchase_orders where id=new.purchase_order_id;
   if parent.estimated_snapshot is null then
     if new.estimated_snapshot is not null then raise exception 'Estimated lines require an estimated order'; end if;return new;
   end if;
   if tg_op<>'INSERT' then raise exception 'Recorded estimated order lines are immutable'; end if;
   select value into line from jsonb_array_elements(parent.estimated_snapshot->'lines') where value->>'id'=new.id::text;
   if not found or new.estimated_snapshot is distinct from line or new.vendor_item_id is distinct from (line->'terms'->>'vendorItemId')::uuid or new.catalog_item_id is distinct from (line->'terms'->>'catalogItemId')::uuid or new.quantity is distinct from (line->>'quantity')::integer or new.order_unit is distinct from 'case' or new.pack_size is distinct from line->'terms'->>'packSize' or new.unit_price is not null or new.line_total is not null then raise exception 'Order line differs from its authoritative submission'; end if;
 end if;
 return new;
end;
$$;
drop trigger if exists estimated_order_record_guard on public.purchase_orders;
create trigger estimated_order_record_guard before insert or update or delete on public.purchase_orders for each row execute function public.kerdos_guard_estimated_order_records();
drop trigger if exists estimated_order_line_record_guard on public.purchase_order_lines;
create trigger estimated_order_line_record_guard before insert or update or delete on public.purchase_order_lines for each row execute function public.kerdos_guard_estimated_order_records();

create or replace function public.kerdos_record_estimated_submission()
returns trigger language plpgsql security invoker set search_path=public as $$
declare s jsonb:=new.order_snapshot;
begin
 insert into public.purchase_orders(id,organization_id,vendor_id,created_by,status,total_amount,created_at,submitted_at,meets_delivery_minimum,estimated_snapshot)
 values(new.purchase_order_id,new.organization_id,(s->>'vendorId')::uuid,new.created_by,'submitted',null,new.created_at,new.created_at,case when s->'deliveryMinimum'->>'status'='met' then true else null end,s);
 insert into public.purchase_order_lines(id,purchase_order_id,catalog_item_id,vendor_item_id,quantity,unit_price,line_total,order_unit,pack_size,estimated_snapshot)
 select (value->>'id')::uuid,new.purchase_order_id,(value->'terms'->>'catalogItemId')::uuid,(value->'terms'->>'vendorItemId')::uuid,(value->>'quantity')::integer,null,null,'case',value->'terms'->>'packSize',value from jsonb_array_elements(s->'lines');
 return new;
end;
$$;
drop trigger if exists estimated_submission_record on public.estimated_draft_submissions;
create trigger estimated_submission_record after insert on public.estimated_draft_submissions for each row execute function public.kerdos_record_estimated_submission();

create or replace function public.kerdos_guard_submitted_draft()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
 -- Same row lock serializes cancellation with submission preparation.
 if new.status='cancelled' and exists(select 1 from public.estimated_draft_submissions where draft_id=old.id) then raise exception 'A recorded order cannot be cancelled as a draft'; end if;
 return new;
end;
$$;
drop trigger if exists estimated_submitted_draft_guard on public.estimated_purchase_drafts;
create trigger estimated_submitted_draft_guard before update on public.estimated_purchase_drafts for each row execute function public.kerdos_guard_submitted_draft();

create or replace function public.kerdos_submit_estimated_order(p_organization_id uuid,p_draft_id uuid,p_review jsonb,p_confirmed boolean,p_minimum_acknowledged boolean)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare d public.estimated_purchase_drafts%rowtype; s public.estimated_draft_submissions%rowtype;
begin
 if p_confirmed is distinct from true then raise exception 'Explicitly confirm recording this order'; end if;
 select * into d from public.estimated_purchase_drafts where id=p_draft_id and organization_id=p_organization_id for update;
 if not found then raise exception 'Draft is outside this organization'; end if;
 if not exists(select 1 from public.organization_members m where m.organization_id=p_organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager','employee') and (d.created_by=(select auth.uid()) or m.role in ('owner','manager'))) then raise exception 'Only the creator, owner or manager can record this order'; end if;
 select * into s from public.estimated_draft_submissions where draft_id=d.id;
 if found then
   if s.created_by is distinct from (select auth.uid()) or s.review is distinct from p_review then raise exception 'Submission belongs to another reviewed request'; end if;
   return s.order_snapshot;
 end if;
 if p_review->'deliveryMinimum'->>'status'='unknown' and p_minimum_acknowledged is distinct from true then raise exception 'Acknowledge the unknown monetary delivery minimum'; end if;
 insert into public.estimated_draft_submissions(organization_id,draft_id,review,minimum_acknowledged) values(p_organization_id,p_draft_id,p_review,coalesce(p_minimum_acknowledged,false)) returning * into s;
 return s.order_snapshot;
end;
$$;
revoke all on function public.kerdos_review_estimated_order(uuid,uuid),public.kerdos_prepare_estimated_submission(),public.kerdos_guard_estimated_order_records(),public.kerdos_record_estimated_submission(),public.kerdos_guard_submitted_draft(),public.kerdos_submit_estimated_order(uuid,uuid,jsonb,boolean,boolean) from public,anon;
grant execute on function public.kerdos_review_estimated_order(uuid,uuid),public.kerdos_prepare_estimated_submission(),public.kerdos_guard_estimated_order_records(),public.kerdos_record_estimated_submission(),public.kerdos_guard_submitted_draft(),public.kerdos_submit_estimated_order(uuid,uuid,jsonb,boolean,boolean) to authenticated;
