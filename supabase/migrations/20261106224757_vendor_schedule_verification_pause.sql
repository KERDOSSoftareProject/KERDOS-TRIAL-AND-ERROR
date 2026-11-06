-- A2.b.vi: a known verification stop must not resume at the next slot.
begin;
set local lock_timeout='3s';
create or replace function kerdos_scheduling.stop_refresh(p_token uuid,p_outcome text)
returns text language plpgsql security definer set search_path='' as $$
declare a kerdos_scheduling.attempts; current_version kerdos_scheduling.versions;
begin
 a:=kerdos_scheduling.lock_owned_attempt(p_token);
 if p_outcome is null or p_outcome not in ('failed','verification_needed') then
  raise exception using errcode='22023',message='invalid_vendor_schedule_outcome';end if;
 if a.finished_at is not null then
  if a.import_document_id is null and a.outcome=p_outcome then return a.outcome;end if;
  raise exception using errcode='22023',message='vendor_schedule_attempt_finished';end if;
 if a.import_document_id is not null or a.lease_until<=clock_timestamp() then
  raise exception using errcode='22023',message='vendor_schedule_evidence_required';end if;
 update kerdos_scheduling.attempts set finished_at=clock_timestamp(),outcome=p_outcome where token=a.token;
 if p_outcome='verification_needed' then
  select * into current_version from kerdos_scheduling.versions where request_id=a.request_id and effective_to is null;
  if found and current_version.enabled and current_version.transfer_revision=a.transfer_revision then
   perform kerdos_scheduling.set_schedule(a.request_id,current_version.version,current_version.weekdays,
    current_version.local_time,current_version.timezone,false,current_version.grace_minutes);
  end if;
 end if;
 return p_outcome;
end;$$;
revoke all on function kerdos_scheduling.stop_refresh(uuid,text) from public,anon,authenticated,service_role;
grant execute on function kerdos_scheduling.stop_refresh(uuid,text) to authenticated;
commit;
