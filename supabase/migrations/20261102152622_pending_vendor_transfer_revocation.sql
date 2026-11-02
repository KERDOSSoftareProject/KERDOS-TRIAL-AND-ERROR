-- A cancelled/reopened setup must not revive an older pending browser transfer.
alter table public.vendor_connection_requests add column if not exists transfer_revision bigint not null default 0 check(transfer_revision>=0);
create or replace function public.kerdos_advance_vendor_transfer_revision() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.state is distinct from old.state or new.portal_account_label is distinct from old.portal_account_label
   or new.portal_list_label is distinct from old.portal_list_label then
  new.transfer_revision:=old.transfer_revision+1;
 end if;
 return new;
end;$$;
revoke all on function public.kerdos_advance_vendor_transfer_revision() from public,anon;
drop trigger if exists advance_vendor_transfer_revision on public.vendor_connection_requests;
create trigger advance_vendor_transfer_revision before update of state,portal_account_label,portal_list_label
 on public.vendor_connection_requests for each row execute function public.kerdos_advance_vendor_transfer_revision();

-- Read-only POST/RPC validation uses the current authenticated role and RLS.
-- Revision is maintained by the trigger; no client update grant is added.
create or replace function public.kerdos_verify_pending_vendor_transfer(
 p_organization_id uuid,p_vendor_id uuid,p_request_id uuid,p_adapter_key text,
 p_transfer_revision bigint,p_account_label text,p_list_label text,p_portal_origin text
) returns boolean language sql volatile security invoker set search_path='' as $$
 select auth.uid() is not null and p_transfer_revision>=0 and exists(
  select 1 from public.vendor_connection_requests r
  join public.vendors v on v.id=r.vendor_id and v.organization_id=r.organization_id
  join public.vendor_connection_adapters a on a.adapter_key=r.adapter_key
  where r.id=p_request_id and r.organization_id=p_organization_id and r.vendor_id=p_vendor_id
    and r.adapter_key=p_adapter_key and r.state='setup_requested' and r.transfer_revision=p_transfer_revision
    and r.portal_account_label=p_account_label and r.portal_list_label=p_list_label
    and v.is_active and a.setup_available and a.execution_model='local_browser'
    and a.portal_origin=p_portal_origin
    and exists(select 1 from public.organization_members m where m.organization_id=r.organization_id
      and m.user_id=auth.uid() and m.role in ('owner','manager')));
$$;
revoke all on function public.kerdos_verify_pending_vendor_transfer(uuid,uuid,uuid,text,bigint,text,text,text) from public,anon;
grant execute on function public.kerdos_verify_pending_vendor_transfer(uuid,uuid,uuid,text,bigint,text,text,text) to authenticated;
