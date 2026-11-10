-- A2.b.vi companion schedule storage/claims only. No runner or schedule enabled.
begin;
set local lock_timeout='3s';
create schema if not exists kerdos_scheduling;
revoke all on schema kerdos_scheduling from public,anon,authenticated,service_role;
create table if not exists kerdos_scheduling.versions(
 request_id uuid not null references public.vendor_connection_requests(id) on delete cascade,
 version bigint not null check(version>0),
 organization_id uuid not null, vendor_id uuid not null, transfer_revision bigint not null,
 weekdays smallint[] not null, local_time time not null, timezone text not null,
 enabled boolean not null, grace_minutes integer not null check(grace_minutes between 1 and 60),
 effective_from timestamptz not null, effective_to timestamptz,
 primary key(request_id,version), check(effective_to is null or effective_to>=effective_from)
);
create unique index if not exists vendor_refresh_current_version on kerdos_scheduling.versions(request_id) where effective_to is null;
create table if not exists kerdos_scheduling.attempts(
 token uuid primary key default gen_random_uuid(),
 request_id uuid not null, version bigint not null, organization_id uuid not null, vendor_id uuid not null,
 transfer_revision bigint not null, slot_at timestamptz not null,
 started_at timestamptz not null, lease_until timestamptz not null,
 finished_at timestamptz, outcome text,
 foreign key(request_id,version) references kerdos_scheduling.versions(request_id,version) on delete cascade,
 unique(request_id,slot_at),
 check(lease_until>started_at),
 check((finished_at is null and outcome is null) or
   (finished_at is not null and finished_at>=started_at and outcome is not null and outcome in ('received','unchanged','saved','failed','verification_needed')))
);
alter table kerdos_scheduling.versions enable row level security;
alter table kerdos_scheduling.attempts enable row level security;
revoke all on all tables in schema kerdos_scheduling from public,anon,authenticated,service_role;

-- A private definer is necessary for server-written slots/version history: API
-- roles have no direct mutation grants. Authorize before taking the row lock.
create or replace function kerdos_scheduling.lock_owned_request(p_request_id uuid)
returns public.vendor_connection_requests language plpgsql security definer set search_path='' as $$
declare r public.vendor_connection_requests;
begin
 if auth.uid() is null or not exists(
  select 1 from public.vendor_connection_requests q join public.organization_members m on m.organization_id=q.organization_id
  where q.id=p_request_id and m.user_id=auth.uid() and m.role in ('owner','manager')) then
  raise exception using errcode='42501',message='vendor_schedule_access_denied';
 end if;
 select * into r from public.vendor_connection_requests where id=p_request_id for update;
 if not found or not exists(select 1 from public.organization_members m where m.organization_id=r.organization_id
  and m.user_id=auth.uid() and m.role in ('owner','manager')) then
  raise exception using errcode='42501',message='vendor_schedule_access_denied';end if;
 return r;
end;$$;
revoke all on function kerdos_scheduling.lock_owned_request(uuid) from public,anon,authenticated,service_role;

create or replace function kerdos_scheduling.set_schedule(
 p_request_id uuid,p_expected_version bigint,p_weekdays smallint[],p_local_time time,
 p_timezone text,p_enabled boolean,p_grace_minutes integer
) returns bigint language plpgsql security definer set search_path='' as $$
declare r public.vendor_connection_requests; previous kerdos_scheduling.versions; stamp timestamptz; days smallint[]; next_version bigint;
begin
 r:=kerdos_scheduling.lock_owned_request(p_request_id);
 if r.state<>'setup_requested' or r.portal_account_label is null or r.portal_list_label is null
  or not exists(select 1 from public.vendors where id=r.vendor_id and organization_id=r.organization_id and is_active)
  or not exists(select 1 from public.vendor_connection_adapters where adapter_key=r.adapter_key and setup_available and execution_model='local_browser') then
  raise exception using errcode='22023',message='vendor_schedule_connection_unavailable';
 end if;
 stamp:=clock_timestamp();
 -- Validate even disabled configurations; no execution or enrollment is implied.
 perform kerdos_private.next_scheduled_at(p_weekdays,p_local_time,p_timezone,stamp);
 if p_enabled is null or p_grace_minutes is null or p_grace_minutes not between 1 and 60 or p_expected_version is null then
  raise exception using errcode='22023',message='invalid_vendor_schedule';
 end if;
 select array_agg(d order by d) into days from unnest(p_weekdays) d;
 select * into previous from kerdos_scheduling.versions where request_id=r.id order by version desc limit 1;
 if p_expected_version<>coalesce(previous.version,0) then
  raise exception using errcode='40001',message='vendor_schedule_version_changed';
 end if;
 if previous.effective_to is null and previous.version is not null and previous.transfer_revision=r.transfer_revision
  and previous.weekdays=days and previous.local_time=p_local_time and previous.timezone=p_timezone
  and previous.enabled=p_enabled and previous.grace_minutes=p_grace_minutes then return previous.version;end if;
 update kerdos_scheduling.versions set effective_to=stamp where request_id=r.id and effective_to is null;
 next_version:=coalesce(previous.version,0)+1;
 insert into kerdos_scheduling.versions values(r.id,next_version,r.organization_id,r.vendor_id,r.transfer_revision,
  days,p_local_time,p_timezone,p_enabled,p_grace_minutes,stamp,null);
 return next_version;
end;$$;
revoke all on function kerdos_scheduling.set_schedule(uuid,bigint,smallint[],time,text,boolean,integer) from public,anon,authenticated,service_role;

create or replace function kerdos_scheduling.claim_refresh(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.vendor_connection_requests; s kerdos_scheduling.versions; stamp timestamptz; slot timestamptz; claimed kerdos_scheduling.attempts;
begin
 r:=kerdos_scheduling.lock_owned_request(p_request_id);
 if r.state<>'setup_requested' or not exists(select 1 from public.vendors where id=r.vendor_id and organization_id=r.organization_id and is_active)
  or not exists(select 1 from public.vendor_connection_adapters where adapter_key=r.adapter_key and setup_available and execution_model='local_browser') then return null;end if;
 select * into s from kerdos_scheduling.versions where request_id=r.id and effective_to is null;
 if not found or not s.enabled or s.transfer_revision<>r.transfer_revision then return null;end if;
 -- Neither a browser clock nor a browser-selected slot is accepted.
 stamp:=clock_timestamp();
 slot:=kerdos_private.next_scheduled_at(s.weekdays,s.local_time,s.timezone,
  greatest(s.effective_from,stamp-make_interval(mins=>s.grace_minutes))-interval '1 microsecond');
 if slot>stamp or slot<s.effective_from then return null;end if;
 -- Unknown work is never automatically retried, even after its lease expires.
 -- Block subsequent slots too until evidence resolves the unfinished operation.
 if exists(select 1 from kerdos_scheduling.attempts where request_id=r.id and finished_at is null) then return null;end if;
 insert into kerdos_scheduling.attempts(request_id,version,organization_id,vendor_id,transfer_revision,slot_at,started_at,lease_until)
 values(r.id,s.version,r.organization_id,r.vendor_id,r.transfer_revision,slot,stamp,stamp+interval '15 minutes')
 on conflict(request_id,slot_at) do nothing returning * into claimed;
 if not found then return null;end if;
 return jsonb_build_object('token',claimed.token,'request_id',r.id,'version',s.version,'organization_id',r.organization_id,
  'vendor_id',r.vendor_id,'transfer_revision',r.transfer_revision,'slot_at',slot,'lease_until',claimed.lease_until);
end;$$;
revoke all on function kerdos_scheduling.claim_refresh(uuid) from public,anon,authenticated,service_role;

-- Cancellation, reconnection, or changed labels retire the old effective window.
-- Attempts retain their identity and are never deleted/reopened by this trigger.
create or replace function kerdos_scheduling.retire_changed_selection()
returns trigger language plpgsql security definer set search_path='' as $$
begin
 if new.transfer_revision is distinct from old.transfer_revision then
  update kerdos_scheduling.versions set effective_to=clock_timestamp() where request_id=new.id and effective_to is null;
 end if;
 return new;
end;$$;
revoke all on function kerdos_scheduling.retire_changed_selection() from public,anon,authenticated,service_role;
drop trigger if exists retire_vendor_refresh_schedule on public.vendor_connection_requests;
create trigger retire_vendor_refresh_schedule after update of state,portal_account_label,portal_list_label
 on public.vendor_connection_requests for each row execute function kerdos_scheduling.retire_changed_selection();

-- Public entry points retain invoker semantics; narrow private delegates enforce
-- ownership themselves and expose no arbitrary data/clock/slot mutation inputs.
grant usage on schema kerdos_scheduling to authenticated;
grant execute on function kerdos_scheduling.set_schedule(uuid,bigint,smallint[],time,text,boolean,integer),kerdos_scheduling.claim_refresh(uuid) to authenticated;
create or replace function public.kerdos_set_vendor_refresh_schedule(
 p_request_id uuid,p_expected_version bigint,p_weekdays smallint[],p_local_time time,
 p_timezone text,p_enabled boolean,p_grace_minutes integer
) returns bigint language sql security invoker set search_path='' as $$
 select kerdos_scheduling.set_schedule(p_request_id,p_expected_version,p_weekdays,p_local_time,p_timezone,p_enabled,p_grace_minutes);
$$;
create or replace function public.kerdos_claim_scheduled_refresh(p_request_id uuid)
returns jsonb language sql security invoker set search_path='' as $$select kerdos_scheduling.claim_refresh(p_request_id);$$;
revoke all on function public.kerdos_set_vendor_refresh_schedule(uuid,bigint,smallint[],time,text,boolean,integer),public.kerdos_claim_scheduled_refresh(uuid) from public,anon,authenticated,service_role;
grant execute on function public.kerdos_set_vendor_refresh_schedule(uuid,bigint,smallint[],time,text,boolean,integer),public.kerdos_claim_scheduled_refresh(uuid) to authenticated;
commit;
