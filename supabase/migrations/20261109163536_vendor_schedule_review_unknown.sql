-- A2.b.vi: owner-reviewed closure of an expired attempt with no retained
-- receipt. Its outcome remains explicitly unverified and records the actor.
begin;
set local lock_timeout='3s';
alter table kerdos_scheduling.attempts add column if not exists closed_by uuid;
alter table kerdos_scheduling.attempts drop constraint if exists attempts_check1;
alter table kerdos_scheduling.attempts drop constraint if exists vendor_refresh_attempt_outcome;
alter table kerdos_scheduling.attempts add constraint vendor_refresh_attempt_outcome check(
 (finished_at is null and outcome is null and closed_by is null) or
 (finished_at is not null and finished_at>=started_at and outcome in
  ('received','unchanged','saved','failed','verification_needed') and closed_by is null) or
 (finished_at is not null and finished_at>=started_at and outcome='closed_unverified' and closed_by is not null));
create or replace function kerdos_scheduling.history(p_request_id uuid)
returns jsonb language plpgsql security definer set search_path='' as $$
declare r public.vendor_connection_requests; stamp timestamptz; current_version kerdos_scheduling.versions;
 unknown_since timestamptz; unknown_token uuid;
 config jsonb; events jsonb;
begin
 r:=kerdos_scheduling.lock_owned_request(p_request_id);
 stamp:=clock_timestamp();
 select * into current_version from kerdos_scheduling.versions where request_id=r.id order by version desc limit 1;
 config:=case when current_version.version is null then null else
  jsonb_build_object('version',current_version.version,'weekdays',current_version.weekdays,
   'local_time',current_version.local_time,'timezone',current_version.timezone,
   'enabled',current_version.enabled and current_version.effective_to is null and current_version.transfer_revision=r.transfer_revision,
   'grace_minutes',current_version.grace_minutes,'effective_from',current_version.effective_from,
   'effective_to',current_version.effective_to) end;
 select token,started_at into unknown_token,unknown_since from kerdos_scheduling.attempts
  where request_id=r.id and finished_at is null and lease_until<=stamp order by started_at limit 1;
 with slots as (
  select v.request_id,v.version,v.grace_minutes,v.timezone,d.local_day::date as local_day,
   kerdos_private.next_scheduled_at(v.weekdays,v.local_time,v.timezone,
    ((d.local_day::timestamp at time zone v.timezone)-interval '1 microsecond')) as slot_at
  from kerdos_scheduling.versions v
  cross join lateral generate_series(
   (greatest(v.effective_from,stamp-interval '30 days') at time zone v.timezone)::date,
   (least(coalesce(v.effective_to,stamp),stamp) at time zone v.timezone)::date,
   interval '1 day') d(local_day)
  where v.request_id=r.id and v.enabled
   and v.effective_from<=stamp and (v.effective_to is null or v.effective_to>=stamp-interval '30 days')
   and extract(isodow from d.local_day)::integer=any(v.weekdays)
 ), valid_slots as (
  select * from slots s where s.slot_at>=stamp-interval '30 days' and s.slot_at<=stamp
   and (s.slot_at at time zone s.timezone)::date=s.local_day
   and s.slot_at>=(select effective_from from kerdos_scheduling.versions where request_id=s.request_id and version=s.version)
   and s.slot_at<(select coalesce(effective_to,'infinity'::timestamptz) from kerdos_scheduling.versions where request_id=s.request_id and version=s.version)
 ), rows as (
  select s.slot_at,s.version,a.token,a.started_at,a.lease_until,a.finished_at,a.outcome,a.closed_by,
   a.import_document_id,a.receipt_sha256,a.received_at,
   case when a.finished_at is not null then a.outcome
    when a.token is not null and a.lease_until<=stamp then 'outcome_unknown'
    when a.token is not null then 'in_progress'
    when s.slot_at+make_interval(mins=>s.grace_minutes)<=stamp then 'missed'
    else 'pending' end as state
  from valid_slots s left join kerdos_scheduling.attempts a on a.request_id=s.request_id and a.slot_at=s.slot_at
  union all
  select a.slot_at,a.version,a.token,a.started_at,a.lease_until,a.finished_at,a.outcome,a.closed_by,
   a.import_document_id,a.receipt_sha256,a.received_at,
   case when a.finished_at is not null then a.outcome
    when a.lease_until<=stamp then 'outcome_unknown' else 'in_progress' end
  from kerdos_scheduling.attempts a
  where a.request_id=r.id and a.slot_at>=stamp-interval '30 days'
   and not exists(select 1 from valid_slots s where s.request_id=a.request_id and s.slot_at=a.slot_at)
 )
 select coalesce(jsonb_agg(jsonb_build_object('slot_at',slot_at,'version',version,'state',state,
  'token',token,'started_at',started_at,'lease_until',lease_until,'finished_at',finished_at,
  'outcome',outcome,'closed_by',closed_by,'import_document_id',import_document_id,'received_at',received_at)
  order by slot_at desc,version desc),'[]'::jsonb) into events from rows;
 return jsonb_build_object('request_id',r.id,'server_now',stamp,'schedule',config,'slots',events,
  'blocked_by_unknown',unknown_since is not null,'unknown_since',unknown_since,'unknown_token',unknown_token);
end;$$;
revoke all on function kerdos_scheduling.history(uuid) from public,anon,authenticated,service_role;
grant execute on function kerdos_scheduling.history(uuid) to authenticated;
create or replace function public.kerdos_vendor_refresh_history(p_request_id uuid)
returns jsonb language sql security invoker set search_path='' as $$
 select kerdos_scheduling.history(p_request_id);
$$;
revoke all on function public.kerdos_vendor_refresh_history(uuid) from public,anon,authenticated,service_role;
grant execute on function public.kerdos_vendor_refresh_history(uuid) to authenticated;
create or replace function kerdos_scheduling.close_unknown(p_request_id uuid,p_token uuid,p_confirmed boolean)
returns text language plpgsql security definer set search_path='' as $$
declare r public.vendor_connection_requests; a kerdos_scheduling.attempts;
begin
 r:=kerdos_scheduling.lock_owned_request(p_request_id);
 if p_confirmed is distinct from true or p_token is null then
  raise exception using errcode='22023',message='vendor_schedule_review_required';end if;
 select * into a from kerdos_scheduling.attempts where token=p_token and request_id=r.id for update;
 if not found then raise exception using errcode='42501',message='vendor_schedule_attempt_unavailable';end if;
 if a.finished_at is not null then
  if a.outcome='closed_unverified' then return a.outcome;end if;
  raise exception using errcode='22023',message='vendor_schedule_attempt_finished';end if;
 if a.lease_until>clock_timestamp()
  or exists(select 1 from public.import_documents d where d.organization_id=a.organization_id
   and (d.id=a.import_document_id or d.retrieval_evidence->>'attempt_token'=a.token::text)) then
  raise exception using errcode='22023',message='vendor_schedule_evidence_required';end if;
 update kerdos_scheduling.attempts set finished_at=clock_timestamp(),outcome='closed_unverified',closed_by=auth.uid()
  where token=a.token;
 return 'closed_unverified';
end;$$;
revoke all on function kerdos_scheduling.close_unknown(uuid,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function kerdos_scheduling.close_unknown(uuid,uuid,boolean) to authenticated;
create or replace function public.kerdos_close_unknown_scheduled_refresh(p_request_id uuid,p_token uuid,p_confirmed boolean)
returns text language sql security invoker set search_path='' as $$
 select kerdos_scheduling.close_unknown(p_request_id,p_token,p_confirmed);
$$;
revoke all on function public.kerdos_close_unknown_scheduled_refresh(uuid,uuid,boolean) from public,anon,authenticated,service_role;
grant execute on function public.kerdos_close_unknown_scheduled_refresh(uuid,uuid,boolean) to authenticated;
commit;
