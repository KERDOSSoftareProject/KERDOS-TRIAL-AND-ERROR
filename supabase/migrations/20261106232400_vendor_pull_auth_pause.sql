-- A2.b.vi: rejected credentials and portal sign-in require an operator action.
-- Preserve the existing lease fencing and all other finish outcomes.
begin;
set local lock_timeout='3s';
create or replace function public.kerdos_finish_vendor_pull(p_source_id uuid,p_token uuid,p_status text,p_reason text,p_attachment_id uuid default null)
returns boolean language plpgsql security definer set search_path='' as $$
declare changed integer;
begin
 if p_status is null or p_reason is null or p_status not in ('received','failed') or p_reason not in ('auto_imported','needs_review','skipped','pull_failed','invalid_source','credential_invalid',
  'dns_validation_required','dns_failed','source_network_denied','download_failed','vendor_auth_rejected','vendor_http_failed','unsupported_export',
  'export_too_large','empty_export','portal_login_page','dispatch_failed','storage_failed','retained_original_mismatch','unsupported_adapter','verification_needed','execution_unavailable') then raise exception 'invalid_pull_result';end if;
 if p_attachment_id is not null and not exists(select from public.inbound_attachments a join public.inbound_messages m on m.id=a.message_id where a.id=p_attachment_id and m.vendor_source_id=p_source_id and m.source_kind='vendor_pull') then raise exception 'attachment_source_mismatch';end if;
 update kerdos_private.vendor_price_sources set last_status=p_status,last_reason=p_reason,last_attachment_id=p_attachment_id,last_finished_at=now(),
  is_active=case when p_reason in ('unsupported_adapter','verification_needed','execution_unavailable','credential_invalid','vendor_auth_rejected','portal_login_page') then false else is_active end,
  next_pull_at=now()+case when p_status='failed' then interval '5 minutes' else interval_minutes*interval '1 minute' end,
  lease_token=null,lease_until=null where id=p_source_id and lease_token=p_token and lease_until>now();
 get diagnostics changed=row_count;return changed=1;
end$$;
revoke all on function public.kerdos_finish_vendor_pull(uuid,uuid,text,text,uuid) from public,anon,authenticated;
grant execute on function public.kerdos_finish_vendor_pull(uuid,uuid,text,text,uuid) to service_role;
commit;
