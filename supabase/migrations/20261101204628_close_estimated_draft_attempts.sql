-- Permanent fences for abandoned draft request IDs. No purchasing side effects.
create table if not exists public.estimated_draft_closed_attempts(
 organization_id uuid not null references public.organizations(id),request_id uuid not null,
 vendor_id uuid not null references public.vendors(id),created_by uuid not null,
 requested_lines jsonb not null check(jsonb_typeof(requested_lines)='array' and jsonb_array_length(requested_lines) between 1 and 100),
 closed_at timestamptz not null default current_timestamp,primary key(organization_id,request_id)
);
alter table public.estimated_draft_closed_attempts enable row level security;
revoke all on public.estimated_draft_closed_attempts from public,anon,authenticated;
grant select on public.estimated_draft_closed_attempts to authenticated;
grant insert(organization_id,request_id,vendor_id,created_by,requested_lines) on public.estimated_draft_closed_attempts to authenticated;
drop policy if exists "closed draft members read" on public.estimated_draft_closed_attempts;
create policy "closed draft members read" on public.estimated_draft_closed_attempts for select to authenticated
 using(exists(select 1 from public.organization_members m where m.organization_id=estimated_draft_closed_attempts.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "closed draft purchasing create" on public.estimated_draft_closed_attempts;
create policy "closed draft purchasing create" on public.estimated_draft_closed_attempts for insert to authenticated
 with check(created_by=(select auth.uid()) and closed_at=current_timestamp
 and exists(select 1 from public.organization_members m where m.organization_id=estimated_draft_closed_attempts.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager','employee'))
 and exists(select 1 from public.vendors v where v.id=vendor_id and v.organization_id=estimated_draft_closed_attempts.organization_id));

-- The same lock guards RPCs AND direct inserts, including older clients.
create or replace function public.kerdos_guard_draft_request()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
 if (select auth.uid()) is null or not exists(select 1 from public.organization_members m where m.organization_id=new.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager','employee')) then raise exception 'Purchasing membership is required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text||':'||new.request_id::text,0));
 if tg_table_name='estimated_purchase_drafts' then
   if exists(select 1 from public.estimated_draft_closed_attempts where organization_id=new.organization_id and request_id=new.request_id) then raise exception 'This draft save attempt is permanently closed'; end if;
 else
   if exists(select 1 from public.estimated_purchase_drafts where organization_id=new.organization_id and request_id=new.request_id) then raise exception 'A saved draft already exists; recover its result'; end if;
 end if;
 return new;
end;
$$;
drop trigger if exists estimated_draft_request_guard on public.estimated_purchase_drafts;
create trigger estimated_draft_request_guard before insert on public.estimated_purchase_drafts for each row execute function public.kerdos_guard_draft_request();
drop trigger if exists closed_draft_request_guard on public.estimated_draft_closed_attempts;
create trigger closed_draft_request_guard before insert on public.estimated_draft_closed_attempts for each row execute function public.kerdos_guard_draft_request();

create or replace function public.kerdos_close_estimated_draft_attempt(p_organization_id uuid,p_vendor_id uuid,p_request_id uuid,p_lines jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare saved public.estimated_purchase_drafts%rowtype; closed public.estimated_draft_closed_attempts%rowtype;
begin
 if (select auth.uid()) is null or not exists(select 1 from public.organization_members m where m.organization_id=p_organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager','employee')) then raise exception 'Purchasing membership is required'; end if;
 if p_request_id is null or jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) not between 1 and 100 then raise exception 'A retained draft request is required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_request_id::text,0));
 select * into saved from public.estimated_purchase_drafts where organization_id=p_organization_id and request_id=p_request_id;
 if found then
   if saved.created_by is distinct from (select auth.uid()) or saved.vendor_id is distinct from p_vendor_id or saved.requested_lines is distinct from p_lines then raise exception 'Draft request ID already belongs to another request'; end if;
   return jsonb_build_object('status','saved','draft',to_jsonb(saved));
 end if;
 select * into closed from public.estimated_draft_closed_attempts where organization_id=p_organization_id and request_id=p_request_id;
 if found then
   if closed.created_by is distinct from (select auth.uid()) or closed.vendor_id is distinct from p_vendor_id or closed.requested_lines is distinct from p_lines then raise exception 'Draft request ID already belongs to another request'; end if;
 else
   insert into public.estimated_draft_closed_attempts(organization_id,request_id,vendor_id,created_by,requested_lines)
   values(p_organization_id,p_request_id,p_vendor_id,(select auth.uid()),p_lines) returning * into closed;
 end if;
 return jsonb_build_object('status','closed','organizationId',closed.organization_id,'vendorId',closed.vendor_id,'requestId',closed.request_id,'createdBy',closed.created_by,'closedAt',closed.closed_at,'requestedLines',closed.requested_lines);
end;
$$;
revoke all on function public.kerdos_guard_draft_request(),public.kerdos_close_estimated_draft_attempt(uuid,uuid,uuid,jsonb) from public,anon;
grant execute on function public.kerdos_guard_draft_request(),public.kerdos_close_estimated_draft_attempt(uuid,uuid,uuid,jsonb) to authenticated;
