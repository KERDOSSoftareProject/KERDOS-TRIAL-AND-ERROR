-- Generated with Supabase CLI 2.122.0; version matches hosted migration history.
-- Installed Task 2 adapter-result contract.
-- Pauses unsupported/verification-needed sources; operator must explicitly resume.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
CREATE OR REPLACE FUNCTION public.kerdos_finish_vendor_pull(p_source_id uuid,p_token uuid,p_status text,p_reason text,p_attachment_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed integer;
BEGIN
 IF p_status IS NULL OR p_reason IS NULL OR p_status NOT IN('received','failed') OR p_reason NOT IN('auto_imported','needs_review','skipped','pull_failed','invalid_source','credential_invalid',
 'dns_validation_required','dns_failed','source_network_denied','download_failed','vendor_auth_rejected','vendor_http_failed','unsupported_export',
 'export_too_large','empty_export','portal_login_page','dispatch_failed','storage_failed','retained_original_mismatch','unsupported_adapter','verification_needed','execution_unavailable') THEN RAISE EXCEPTION 'invalid_pull_result';END IF;
 IF p_attachment_id IS NOT NULL AND NOT EXISTS(SELECT FROM public.inbound_attachments a JOIN public.inbound_messages m ON m.id=a.message_id WHERE a.id=p_attachment_id AND m.vendor_source_id=p_source_id AND m.source_kind='vendor_pull') THEN RAISE EXCEPTION 'attachment_source_mismatch';END IF;
 UPDATE kerdos_private.vendor_price_sources SET last_status=p_status,last_reason=p_reason,last_attachment_id=p_attachment_id,last_finished_at=now(),
  is_active=CASE WHEN p_reason IN ('unsupported_adapter','verification_needed','execution_unavailable') THEN false ELSE is_active END,
  next_pull_at=now()+CASE WHEN p_status='failed' THEN interval '5 minutes' ELSE interval_minutes*interval '1 minute' END,
  lease_token=NULL,lease_until=NULL WHERE id=p_source_id AND lease_token=p_token AND lease_until>now();
 GET DIAGNOSTICS changed=ROW_COUNT;RETURN changed=1;
END$$;

REVOKE ALL ON FUNCTION public.kerdos_finish_vendor_pull(uuid,uuid,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.kerdos_finish_vendor_pull(uuid,uuid,text,text,uuid) TO service_role;
COMMIT;
