-- A2.b.vi receipt identity and immutable terminal outcomes. No runner enabled.
begin;
set local lock_timeout='3s';
alter table kerdos_scheduling.attempts
 add column if not exists import_document_id uuid,
 add column if not exists receipt_sha256 text,
 add column if not exists received_at timestamptz;
-- An immutable historical document ID intentionally has no cascading FK:
-- existing Delete & re-import must not erase/rewrite the attempt's identity.
do $$begin
 if not exists(select 1 from pg_constraint where conrelid='kerdos_scheduling.attempts'::regclass and conname='vendor_refresh_receipt_shape') then
  alter table kerdos_scheduling.attempts add constraint vendor_refresh_receipt_shape check(
   (import_document_id is null and receipt_sha256 is null and received_at is null) or
   (import_document_id is not null and receipt_sha256 is not null and receipt_sha256 ~ '^[a-f0-9]{64}$' and received_at is not null));
 end if;
end$$;

create or replace function kerdos_scheduling.lock_owned_attempt(p_token uuid)
returns kerdos_scheduling.attempts language plpgsql security definer set search_path='' as $$
declare a kerdos_scheduling.attempts;
begin
 select * into a from kerdos_scheduling.attempts where token=p_token;
 if not found then raise exception using errcode='42501',message='vendor_schedule_attempt_unavailable';end if;
 perform kerdos_scheduling.lock_owned_request(a.request_id);
 select * into a from kerdos_scheduling.attempts where token=p_token for update;
 if not found then raise exception using errcode='42501',message='vendor_schedule_attempt_unavailable';end if;
 return a;
end;$$;
revoke all on function kerdos_scheduling.lock_owned_attempt(uuid) from public,anon,authenticated,service_role;

create or replace function kerdos_scheduling.current_attempt(p_token uuid)
returns boolean language plpgsql security definer set search_path='' as $$
declare a kerdos_scheduling.attempts;
begin
 a:=kerdos_scheduling.lock_owned_attempt(p_token);
 return a.finished_at is null and a.lease_until>clock_timestamp() and exists(
  select 1 from public.vendor_connection_requests r
  join public.vendors v on v.id=r.vendor_id and v.organization_id=r.organization_id
  join public.vendor_connection_adapters d on d.adapter_key=r.adapter_key
  join kerdos_scheduling.versions s on s.request_id=r.id and s.version=a.version
  where r.id=a.request_id and r.organization_id=a.organization_id and r.vendor_id=a.vendor_id
   and r.state='setup_requested' and r.transfer_revision=a.transfer_revision and v.is_active
   and d.setup_available and d.execution_model='local_browser' and s.enabled and s.effective_to is null);
end;$$;
revoke all on function kerdos_scheduling.current_attempt(uuid) from public,anon,authenticated,service_role;

-- AFTER INSERT validation/stamp is one transaction: a rejected citation leaves
-- neither a document nor a receipt stamp. Untagged manual/legacy imports pass.
create or replace function kerdos_scheduling.bind_import_receipt()
returns trigger language plpgsql security definer set search_path='' as $$
declare a kerdos_scheduling.attempts; r public.vendor_connection_requests; cited uuid;
begin
 if not coalesce(new.retrieval_evidence ? 'attempt_token',false) then return new;end if;
 begin cited:=(new.retrieval_evidence->>'attempt_token')::uuid;
 exception when invalid_text_representation then raise exception using errcode='22023',message='invalid_vendor_schedule_receipt';end;
 a:=kerdos_scheduling.lock_owned_attempt(cited);
 select * into r from public.vendor_connection_requests where id=a.request_id;
 -- A late actual receipt can resolve uncertainty; lease expiry never authorizes
 -- another export. Revision/cancellation/configuration still gate new admission.
 if a.finished_at is not null or (a.import_document_id is not null and a.import_document_id<>new.id)
  or new.organization_id<>a.organization_id or new.vendor_id<>a.vendor_id or new.document_kind<>'pricelist'
  or new.file_path is null or new.retrieval_evidence->>'kind'<>'browser_companion'
  or r.state<>'setup_requested' or r.transfer_revision<>a.transfer_revision
  or new.retrieval_evidence->>'adapter_key' is distinct from r.adapter_key
  or new.retrieval_evidence->>'account_label' is distinct from r.portal_account_label
  or new.retrieval_evidence->>'list_label' is distinct from r.portal_list_label
  or not exists(select 1 from public.vendors v where v.id=r.vendor_id and v.organization_id=r.organization_id and v.is_active)
  or not exists(select 1 from public.vendor_connection_adapters d where d.adapter_key=r.adapter_key and d.setup_available
   and d.execution_model='local_browser' and d.portal_origin=new.retrieval_evidence->>'origin')
  or not exists(select 1 from kerdos_scheduling.versions s where s.request_id=a.request_id and s.version=a.version and s.enabled and s.effective_to is null) then
  raise exception using errcode='22023',message='invalid_vendor_schedule_receipt';
 end if;
 update kerdos_scheduling.attempts set import_document_id=new.id,receipt_sha256=new.retrieval_evidence->>'sha256',received_at=clock_timestamp() where token=a.token;
 return new;
end;$$;
revoke all on function kerdos_scheduling.bind_import_receipt() from public,anon,authenticated,service_role;
drop trigger if exists bind_vendor_schedule_receipt on public.import_documents;
create trigger bind_vendor_schedule_receipt after insert on public.import_documents for each row execute function kerdos_scheduling.bind_import_receipt();

create or replace function kerdos_scheduling.complete_refresh(p_token uuid,p_document_id uuid,p_sha256 text)
returns text language plpgsql security definer set search_path='' as $$
declare a kerdos_scheduling.attempts; d public.import_documents; result text;
begin
 a:=kerdos_scheduling.lock_owned_attempt(p_token);
 if p_document_id is null or p_sha256 is null or p_sha256 !~ '^[a-f0-9]{64}$' then
  raise exception using errcode='22023',message='invalid_vendor_schedule_receipt';end if;
 if a.finished_at is not null then
  if a.import_document_id=p_document_id and a.receipt_sha256=p_sha256 then return a.outcome;end if;
  raise exception using errcode='22023',message='vendor_schedule_attempt_finished';
 end if;
 select * into d from public.import_documents where id=p_document_id;
 if not found or d.organization_id<>a.organization_id or d.vendor_id<>a.vendor_id or d.document_kind<>'pricelist'
  or d.file_path is null or d.retrieval_evidence->>'kind' is distinct from 'browser_companion'
  or d.retrieval_evidence->>'sha256' is distinct from p_sha256 then
  raise exception using errcode='22023',message='invalid_vendor_schedule_receipt';end if;
 if a.import_document_id is not null then
  if a.import_document_id<>d.id or a.receipt_sha256<>p_sha256
   or d.retrieval_evidence->>'attempt_token' is distinct from a.token::text then
   raise exception using errcode='22023',message='invalid_vendor_schedule_receipt';end if;
  if d.status='complete' then result:='saved';elsif d.status='partial' then result:='received';
  else raise exception using errcode='22023',message='vendor_schedule_import_pending';end if;
 else
  -- Unchanged bytes reuse an earlier completed document, never relabel its
  -- immutable evidence. The current browser hash remains a client assertion.
  if d.status<>'complete' or d.created_at>a.started_at or not kerdos_scheduling.current_attempt(a.token)
   or not exists(select 1 from public.vendor_connection_requests r join public.vendor_connection_adapters v on v.adapter_key=r.adapter_key
    where r.id=a.request_id and d.retrieval_evidence->>'adapter_key'=r.adapter_key
     and d.retrieval_evidence->>'account_label'=r.portal_account_label and d.retrieval_evidence->>'list_label'=r.portal_list_label
     and d.retrieval_evidence->>'origin'=v.portal_origin) then
   raise exception using errcode='22023',message='invalid_vendor_schedule_receipt';end if;
  result:='unchanged';
 end if;
 update kerdos_scheduling.attempts set import_document_id=d.id,receipt_sha256=p_sha256,
  received_at=coalesce(received_at,clock_timestamp()),finished_at=clock_timestamp(),outcome=result where token=a.token;
 return result;
end;$$;
revoke all on function kerdos_scheduling.complete_refresh(uuid,uuid,text) from public,anon,authenticated,service_role;

create or replace function kerdos_scheduling.stop_refresh(p_token uuid,p_outcome text)
returns text language plpgsql security definer set search_path='' as $$
declare a kerdos_scheduling.attempts;
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
 return p_outcome;
end;$$;
revoke all on function kerdos_scheduling.stop_refresh(uuid,text) from public,anon,authenticated,service_role;

create or replace function kerdos_scheduling.preserve_finished_attempt()
returns trigger language plpgsql security invoker set search_path='' as $$
begin
 if old.finished_at is not null and new is distinct from old then raise exception 'vendor_schedule_attempt_immutable';end if;
 return new;
end;$$;
revoke all on function kerdos_scheduling.preserve_finished_attempt() from public,anon,authenticated,service_role;
drop trigger if exists preserve_finished_vendor_refresh on kerdos_scheduling.attempts;
create trigger preserve_finished_vendor_refresh before update on kerdos_scheduling.attempts for each row execute function kerdos_scheduling.preserve_finished_attempt();

create or replace function public.kerdos_verify_scheduled_refresh(p_token uuid)
returns boolean language sql security invoker set search_path='' as $$select kerdos_scheduling.current_attempt(p_token);$$;
create or replace function public.kerdos_complete_scheduled_refresh(p_token uuid,p_document_id uuid,p_sha256 text)
returns text language sql security invoker set search_path='' as $$select kerdos_scheduling.complete_refresh(p_token,p_document_id,p_sha256);$$;
create or replace function public.kerdos_stop_scheduled_refresh(p_token uuid,p_outcome text)
returns text language sql security invoker set search_path='' as $$select kerdos_scheduling.stop_refresh(p_token,p_outcome);$$;
revoke all on function public.kerdos_verify_scheduled_refresh(uuid),public.kerdos_complete_scheduled_refresh(uuid,uuid,text),public.kerdos_stop_scheduled_refresh(uuid,text) from public,anon,authenticated,service_role;
grant execute on function kerdos_scheduling.current_attempt(uuid),kerdos_scheduling.complete_refresh(uuid,uuid,text),kerdos_scheduling.stop_refresh(uuid,text),
 public.kerdos_verify_scheduled_refresh(uuid),public.kerdos_complete_scheduled_refresh(uuid,uuid,text),public.kerdos_stop_scheduled_refresh(uuid,text) to authenticated;
commit;
