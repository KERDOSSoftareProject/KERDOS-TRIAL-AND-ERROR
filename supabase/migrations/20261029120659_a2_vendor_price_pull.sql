-- Module A · Task 2. DRAFT: not applied. Generate a migration with Supabase CLI
-- after review. Requires Vault and existing A1 receipt/worker migrations.
-- Sources are operator-enrolled read-only HTTPS exports, not guessed portal APIs.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
SET LOCAL idle_in_transaction_session_timeout='10s';
CREATE SCHEMA IF NOT EXISTS kerdos_private;
REVOKE ALL ON SCHEMA kerdos_private FROM PUBLIC,anon,authenticated;

CREATE TABLE IF NOT EXISTS kerdos_private.vendor_export_origins(
  origin text PRIMARY KEY CHECK(origin ~ '^https://[a-z0-9][a-z0-9.-]+\.[a-z]{2,}$'),
  approved_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE kerdos_private.vendor_export_origins ENABLE ROW LEVEL SECURITY;
CREATE TABLE IF NOT EXISTS kerdos_private.vendor_price_sources(
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
  vendor_id uuid NOT NULL,
  approved_origin text NOT NULL REFERENCES kerdos_private.vendor_export_origins(origin),
  export_path text NOT NULL CHECK(export_path LIKE '/%' AND export_path NOT LIKE '//%' AND export_path !~ '[?#\r\n]'),
  file_name text NOT NULL CHECK(file_name ~ '^[A-Za-z0-9][A-Za-z0-9_. -]{0,119}\.(csv|txt|xlsx|pdf|png|jpg|jpeg)$'),
  credential_secret_id uuid NOT NULL UNIQUE,
  is_active boolean NOT NULL DEFAULT false,
  interval_minutes integer NOT NULL DEFAULT 1440 CHECK(interval_minutes BETWEEN 5 AND 10080),
  next_pull_at timestamptz NOT NULL DEFAULT now(),
  lease_token uuid,
  lease_until timestamptz,
  content_hash text CHECK(content_hash ~ '^[0-9a-f]{64}$'),
  content_revision bigint NOT NULL DEFAULT 0 CHECK(content_revision>=0),
  last_status text CHECK(last_status IN ('received','failed')),
  last_reason text,
  last_attachment_id uuid REFERENCES public.inbound_attachments(id) ON DELETE SET NULL,
  last_finished_at timestamptz,
  FOREIGN KEY(organization_id,vendor_id) REFERENCES public.vendors(organization_id,id) ON DELETE CASCADE,
  UNIQUE(organization_id,vendor_id,approved_origin,export_path)
);
ALTER TABLE kerdos_private.vendor_price_sources ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON ALL TABLES IN SCHEMA kerdos_private FROM PUBLIC,anon,authenticated;

-- A pulled file is honestly labelled as such; it is not a received email.
ALTER TABLE public.inbound_messages ADD COLUMN IF NOT EXISTS source_kind text NOT NULL DEFAULT 'email';
ALTER TABLE public.inbound_messages ADD COLUMN IF NOT EXISTS vendor_source_id uuid;
ALTER TABLE public.inbound_messages ALTER COLUMN routing_address_id DROP NOT NULL;
DO $$BEGIN
 IF NOT EXISTS(SELECT FROM pg_constraint WHERE conname='inbound_messages_source_contract') THEN
  ALTER TABLE public.inbound_messages ADD CONSTRAINT inbound_messages_source_contract CHECK(
    (source_kind='email' AND routing_address_id IS NOT NULL AND vendor_source_id IS NULL)
    OR (source_kind='vendor_pull' AND routing_address_id IS NULL AND vendor_source_id IS NOT NULL
      AND receipt_vendor_id IS NOT NULL AND receipt_document_type='pricelist' AND vendor_snapshot_at IS NOT NULL));
 END IF;
END$$;

-- Secret creation/rotation is operator-only; no secret-bearing browser API.
CREATE OR REPLACE FUNCTION kerdos_private.configure_vendor_price_source(
 p_organization_id uuid,p_vendor_id uuid,p_origin text,p_path text,p_file_name text,
 p_credential jsonb,p_interval integer DEFAULT 1440,p_active boolean DEFAULT false
) RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE source_id uuid;secret_id uuid;
BEGIN
 IF NOT EXISTS(SELECT FROM public.vendors WHERE id=p_vendor_id AND organization_id=p_organization_id AND is_active) THEN
  RAISE EXCEPTION 'vendor_not_active_in_organization';END IF;
 IF (p_credential->>'kind'='bearer' AND length(p_credential->>'token')>0
   OR p_credential->>'kind'='basic' AND length(p_credential->>'username')>0 AND length(p_credential->>'password')>0) IS NOT TRUE THEN
  RAISE EXCEPTION 'credential_invalid';END IF;
 SELECT id,credential_secret_id INTO source_id,secret_id FROM kerdos_private.vendor_price_sources
 WHERE organization_id=p_organization_id AND vendor_id=p_vendor_id AND approved_origin=p_origin AND export_path=p_path FOR UPDATE;
 IF source_id IS NULL THEN
  source_id:=gen_random_uuid();
  SELECT vault.create_secret(p_credential::text,'kerdos-vendor-'||source_id::text,'KERDOS vendor price export credential') INTO secret_id;
  INSERT INTO kerdos_private.vendor_price_sources(id,organization_id,vendor_id,approved_origin,export_path,file_name,credential_secret_id,interval_minutes,is_active)
  VALUES(source_id,p_organization_id,p_vendor_id,p_origin,p_path,p_file_name,secret_id,p_interval,p_active);
 ELSE
  PERFORM vault.update_secret(secret_id,p_credential::text);
  UPDATE kerdos_private.vendor_price_sources SET file_name=p_file_name,interval_minutes=p_interval,is_active=p_active,
    lease_token=NULL,lease_until=NULL,next_pull_at=now() WHERE id=source_id;
 END IF;
 RETURN source_id;
END$$;
REVOKE ALL ON FUNCTION kerdos_private.configure_vendor_price_source(uuid,uuid,text,text,text,jsonb,integer,boolean) FROM PUBLIC,anon,authenticated,service_role;

CREATE OR REPLACE FUNCTION kerdos_private.remove_vendor_price_secret()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 DELETE FROM vault.secrets WHERE id=OLD.credential_secret_id;
 RETURN OLD;
END$$;
REVOKE ALL ON FUNCTION kerdos_private.remove_vendor_price_secret() FROM PUBLIC,anon,authenticated,service_role;
DROP TRIGGER IF EXISTS vendor_price_source_secret_cleanup ON kerdos_private.vendor_price_sources;
CREATE TRIGGER vendor_price_source_secret_cleanup AFTER DELETE ON kerdos_private.vendor_price_sources
FOR EACH ROW EXECUTE FUNCTION kerdos_private.remove_vendor_price_secret();

CREATE OR REPLACE FUNCTION public.kerdos_claim_vendor_pulls(p_source_id uuid DEFAULT NULL)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE claimed jsonb;
BEGIN
 WITH candidates AS (
  SELECT s.id FROM kerdos_private.vendor_price_sources s JOIN public.vendors v ON v.id=s.vendor_id AND v.organization_id=s.organization_id
  WHERE s.is_active AND v.is_active AND (p_source_id IS NULL OR s.id=p_source_id)
   AND (p_source_id IS NOT NULL OR s.next_pull_at<=now()) AND (s.lease_until IS NULL OR s.lease_until<=now())
  ORDER BY s.next_pull_at LIMIT 3 FOR UPDATE OF s SKIP LOCKED
 ), updated AS (
  UPDATE kerdos_private.vendor_price_sources s SET lease_token=gen_random_uuid(),lease_until=now()+interval '3 minutes'
  FROM candidates c WHERE s.id=c.id RETURNING s.*
 ) SELECT coalesce(jsonb_agg(jsonb_build_object('id',u.id,'organization_id',u.organization_id,'vendor_id',u.vendor_id,
  'approved_origin',u.approved_origin,'export_path',u.export_path,'file_name',u.file_name,'lease_token',u.lease_token,
  'content_hash',u.content_hash,'content_revision',u.content_revision,
  'credential',v.decrypted_secret::jsonb)),'[]'::jsonb) INTO claimed FROM updated u LEFT JOIN vault.decrypted_secrets v ON v.id=u.credential_secret_id;
 RETURN claimed;
END$$;

CREATE OR REPLACE FUNCTION public.kerdos_check_vendor_pull_lease(p_source_id uuid,p_token uuid)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 IF NOT EXISTS(SELECT FROM kerdos_private.vendor_price_sources s JOIN public.vendors v ON v.id=s.vendor_id AND v.organization_id=s.organization_id
 WHERE s.id=p_source_id AND s.lease_token=p_token AND s.lease_until>now() AND s.is_active AND v.is_active) THEN
 RAISE EXCEPTION 'vendor_pull_lease_lost';END IF;
 RETURN true;
END$$;

CREATE OR REPLACE FUNCTION public.kerdos_stage_vendor_pull(p_source_id uuid,p_token uuid,p_hash text,p_path text,p_content_type text,p_size integer)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE s kerdos_private.vendor_price_sources;v_message_id uuid;v_attachment_id uuid;revision bigint;
BEGIN
 SELECT * INTO s FROM kerdos_private.vendor_price_sources WHERE id=p_source_id FOR UPDATE;
 PERFORM public.kerdos_check_vendor_pull_lease(p_source_id,p_token);
 revision:=CASE WHEN s.content_hash=p_hash THEN s.content_revision ELSE s.content_revision+1 END;
 IF p_hash IS NULL OR p_content_type IS NULL OR p_hash !~ '^[0-9a-f]{64}$' OR p_path IS DISTINCT FROM s.organization_id::text||'/vendor-pulls/'||s.id::text||'/'||revision::text||'/'||p_hash
  OR p_size IS NULL OR p_size<1 OR p_size>5242880 OR p_content_type NOT IN('text/csv','text/plain','application/vnd.openxmlformats-officedocument.spreadsheetml.sheet','application/pdf','image/png','image/jpeg') THEN
 RAISE EXCEPTION 'vendor_pull_artifact_invalid';END IF;
 INSERT INTO public.inbound_messages(organization_id,routing_address_id,postmark_message_id,sender_email,sender_name,subject,body_text,
 receipt_vendor_id,receipt_document_type,vendor_snapshot_at,source_kind,vendor_source_id)
 VALUES(s.organization_id,NULL,'vendor-pull:'||s.id::text||':'||revision::text||':'||p_hash,'vendor-pull@kerdos.invalid','Automatic vendor price pull',
 s.file_name,'Read-only vendor export; not an email delivery.',s.vendor_id,'pricelist',now(),'vendor_pull',s.id)
 ON CONFLICT(postmark_message_id,organization_id) DO NOTHING RETURNING id INTO v_message_id;
 IF v_message_id IS NULL THEN SELECT id INTO v_message_id FROM public.inbound_messages
  WHERE organization_id=s.organization_id AND postmark_message_id='vendor-pull:'||s.id::text||':'||revision::text||':'||p_hash;END IF;
 INSERT INTO public.inbound_attachments(organization_id,message_id,attachment_index,filename,content_type,file_size_bytes,storage_path,processing_status)
 VALUES(s.organization_id,v_message_id,0,s.file_name,p_content_type,p_size,p_path,'pending')
 ON CONFLICT(message_id,attachment_index) DO NOTHING RETURNING id INTO v_attachment_id;
 IF v_attachment_id IS NULL THEN SELECT id INTO v_attachment_id FROM public.inbound_attachments WHERE message_id=v_message_id AND attachment_index=0;END IF;
 UPDATE kerdos_private.vendor_price_sources SET content_hash=p_hash,content_revision=revision WHERE id=s.id;
 RETURN jsonb_build_object('message_id',v_message_id,'attachment_id',v_attachment_id);
END$$;

CREATE OR REPLACE FUNCTION public.kerdos_finish_vendor_pull(p_source_id uuid,p_token uuid,p_status text,p_reason text,p_attachment_id uuid DEFAULT NULL)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE changed integer;
BEGIN
 IF p_status IS NULL OR p_reason IS NULL OR p_status NOT IN('received','failed') OR p_reason NOT IN('auto_imported','needs_review','skipped','pull_failed','invalid_source','credential_invalid',
 'dns_validation_required','dns_failed','source_network_denied','download_failed','vendor_auth_rejected','vendor_http_failed','unsupported_export',
 'export_too_large','empty_export','portal_login_page','dispatch_failed','storage_failed','retained_original_mismatch') THEN RAISE EXCEPTION 'invalid_pull_result';END IF;
 IF p_attachment_id IS NOT NULL AND NOT EXISTS(SELECT FROM public.inbound_attachments a JOIN public.inbound_messages m ON m.id=a.message_id WHERE a.id=p_attachment_id AND m.vendor_source_id=p_source_id AND m.source_kind='vendor_pull') THEN RAISE EXCEPTION 'attachment_source_mismatch';END IF;
 UPDATE kerdos_private.vendor_price_sources SET last_status=p_status,last_reason=p_reason,last_attachment_id=p_attachment_id,last_finished_at=now(),
  next_pull_at=now()+CASE WHEN p_status='failed' THEN interval '5 minutes' ELSE interval_minutes*interval '1 minute' END,
  lease_token=NULL,lease_until=NULL WHERE id=p_source_id AND lease_token=p_token AND lease_until>now();
 GET DIAGNOSTICS changed=ROW_COUNT;RETURN changed=1;
END$$;

REVOKE ALL ON FUNCTION public.kerdos_claim_vendor_pulls(uuid),public.kerdos_check_vendor_pull_lease(uuid,uuid),
 public.kerdos_stage_vendor_pull(uuid,uuid,text,text,text,integer),public.kerdos_finish_vendor_pull(uuid,uuid,text,text,uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.kerdos_claim_vendor_pulls(uuid),public.kerdos_check_vendor_pull_lease(uuid,uuid),
 public.kerdos_stage_vendor_pull(uuid,uuid,text,text,text,integer),public.kerdos_finish_vendor_pull(uuid,uuid,text,text,uuid) TO service_role;

-- Separate operator-owned dispatch configuration. No service key or credential
-- literal in cron SQL. Vault reference is set by the operator after deployment.
CREATE TABLE IF NOT EXISTS kerdos_private.vendor_pull_dispatch(
 singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
 function_url text NOT NULL CHECK(function_url ~ '^https://[a-z0-9]+\.supabase\.co/functions/v1/vendor-price-pull$'),
 secret_id uuid NOT NULL
);
ALTER TABLE kerdos_private.vendor_pull_dispatch ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON kerdos_private.vendor_pull_dispatch FROM PUBLIC,anon,authenticated,service_role;
CREATE OR REPLACE FUNCTION kerdos_private.dispatch_due_vendor_pulls()
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE config kerdos_private.vendor_pull_dispatch;credential text;request_id bigint;
BEGIN
 IF NOT EXISTS(SELECT FROM kerdos_private.vendor_price_sources s JOIN public.vendors v ON v.id=s.vendor_id AND v.organization_id=s.organization_id
  WHERE s.is_active AND v.is_active AND s.next_pull_at<=now() AND (s.lease_until IS NULL OR s.lease_until<=now())) THEN RETURN NULL;END IF;
 SELECT * INTO config FROM kerdos_private.vendor_pull_dispatch WHERE singleton;
 IF NOT FOUND THEN RAISE EXCEPTION 'vendor_pull_dispatch_not_configured';END IF;
 SELECT decrypted_secret INTO credential FROM vault.decrypted_secrets WHERE id=config.secret_id;
 IF credential IS NULL OR length(credential)<1 THEN RAISE EXCEPTION 'vendor_pull_dispatch_secret_missing';END IF;
 SELECT net.http_post(url:=config.function_url,headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||credential),
  body:='{}'::jsonb,timeout_milliseconds:=120000) INTO request_id;
 RETURN request_id;
END$$;
REVOKE ALL ON FUNCTION kerdos_private.dispatch_due_vendor_pulls() FROM PUBLIC,anon,authenticated,service_role;
-- After deployment and operator dispatch configuration, enable once:
-- SELECT cron.schedule('kerdos-vendor-price-pulls','*/5 * * * *',
--   'select kerdos_private.dispatch_due_vendor_pulls();');
-- In kerdos-test, the existing recovery Vault secret can authenticate dispatch
-- using RECOVERY_SWEEP_SECRET. Do not return or paste its decrypted value.
COMMIT;
