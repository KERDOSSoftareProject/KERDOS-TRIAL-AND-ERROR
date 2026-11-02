-- Non-secret selection labels are retained per owned vendor connection.
-- Credentials, codes, tokens and supplier sessions are not part of this record.
alter table public.vendor_connection_requests
  add column if not exists portal_account_label text,
  add column if not exists portal_list_label text;
do $$begin
 if not exists(select 1 from pg_constraint where conname='vendor_connection_portal_labels_valid'
   and conrelid='public.vendor_connection_requests'::regclass) then
  alter table public.vendor_connection_requests add constraint vendor_connection_portal_labels_valid check(
    (portal_account_label is null and portal_list_label is null) or
    (portal_account_label is not null and portal_list_label is not null
      and char_length(portal_account_label) between 1 and 200
      and char_length(portal_list_label) between 1 and 200
      and btrim(portal_account_label,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')<>''
      and btrim(portal_list_label,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF')<>''));
 end if;
end$$;
-- Keep the existing owner/manager RLS and restricted identity-column grants.
grant update(portal_account_label,portal_list_label) on public.vendor_connection_requests to authenticated;
create or replace function public.kerdos_check_portal_selection() returns trigger
language plpgsql security invoker set search_path='' as $$
begin
 if new.state<>'setup_requested' then
  raise exception 'A cancelled vendor setup cannot save a pricing-list selection';
 end if;
 if not exists(select 1 from public.vendor_connection_adapters a
   where a.adapter_key=new.adapter_key and a.execution_model='local_browser' and a.setup_available) then
  raise exception 'This browser connection provider is unavailable';
 end if;
 return new;
end;$$;
revoke all on function public.kerdos_check_portal_selection() from public,anon;
drop trigger if exists check_portal_selection on public.vendor_connection_requests;
create trigger check_portal_selection before update of portal_account_label,portal_list_label
 on public.vendor_connection_requests for each row execute function public.kerdos_check_portal_selection();
