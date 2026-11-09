-- Resolve an expired scheduled claim only from its transactionally stamped
-- import document. No new supplier export or client-provided receipt is used.
begin;
set local lock_timeout='3s';
create or replace function kerdos_scheduling.reconcile_receipts(p_request_id uuid)
returns integer language plpgsql security definer set search_path='' as $$
declare r public.vendor_connection_requests; receipt record; resolved integer:=0;
begin
 r:=kerdos_scheduling.lock_owned_request(p_request_id);
 for receipt in
  select a.token,a.import_document_id,a.receipt_sha256
  from kerdos_scheduling.attempts a
  join public.import_documents d on d.id=a.import_document_id
  where a.request_id=r.id and a.finished_at is null and a.lease_until<=clock_timestamp()
   and d.organization_id=a.organization_id and d.vendor_id=a.vendor_id
   and d.document_kind='pricelist' and d.file_path is not null
   and d.status in ('complete','partial')
   and d.retrieval_evidence->>'kind'='browser_companion'
   and d.retrieval_evidence->>'attempt_token'=a.token::text
   and d.retrieval_evidence->>'sha256'=a.receipt_sha256
  order by a.started_at for update of a
 loop
  perform kerdos_scheduling.complete_refresh(receipt.token,receipt.import_document_id,receipt.receipt_sha256);
  resolved:=resolved+1;
 end loop;
 return resolved;
end;$$;
revoke all on function kerdos_scheduling.reconcile_receipts(uuid) from public,anon,authenticated,service_role;
grant execute on function kerdos_scheduling.reconcile_receipts(uuid) to authenticated;
create or replace function public.kerdos_reconcile_scheduled_refresh(p_request_id uuid)
returns integer language sql security invoker set search_path='' as $$
 select kerdos_scheduling.reconcile_receipts(p_request_id);
$$;
revoke all on function public.kerdos_reconcile_scheduled_refresh(uuid) from public,anon,authenticated,service_role;
grant execute on function public.kerdos_reconcile_scheduled_refresh(uuid) to authenticated;
-- Reconcile in the existing due-claim RPC as well, without an additional
-- browser request on every thirty-second poll.
create or replace function public.kerdos_claim_scheduled_refresh(p_request_id uuid)
returns jsonb language plpgsql security invoker set search_path='' as $$
begin
 perform kerdos_scheduling.reconcile_receipts(p_request_id);
 return kerdos_scheduling.claim_refresh(p_request_id);
end;$$;
revoke all on function public.kerdos_claim_scheduled_refresh(uuid) from public,anon,authenticated,service_role;
grant execute on function public.kerdos_claim_scheduled_refresh(uuid) to authenticated;
commit;
