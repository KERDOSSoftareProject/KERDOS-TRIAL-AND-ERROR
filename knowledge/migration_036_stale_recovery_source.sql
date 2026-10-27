-- A1.2.f source reconciliation, derived from the verified kerdos-test function bodies.
-- Review and apply in sequence after migrations 032–035 on a new environment.
-- This source file is NOT applied here; kerdos-test already has the functions.
-- The status fence includes the 2026-10-26 NULL-token correction.

ALTER TABLE public.inbound_attachments
  ADD COLUMN IF NOT EXISTS processing_started_at timestamptz,
  ADD COLUMN IF NOT EXISTS processing_heartbeat_at timestamptz,
  ADD COLUMN IF NOT EXISTS processing_lease_token uuid;

CREATE INDEX IF NOT EXISTS inbound_attachments_heartbeat_stale_idx
  ON public.inbound_attachments(organization_id, processing_heartbeat_at)
  WHERE processing_status = 'processing' AND processing_heartbeat_at IS NOT NULL;
-- The scheduled sweep scans across organizations.
CREATE INDEX IF NOT EXISTS inbound_attachments_global_stale_idx
  ON public.inbound_attachments(processing_heartbeat_at)
  WHERE processing_status = 'processing' AND processing_heartbeat_at IS NOT NULL;

-- A changed parameter list is a new PostgreSQL overload, not a replacement.
-- Fail without CASCADE if dependencies need a separate migration plan.
DROP FUNCTION IF EXISTS public.kerdos_auto_apply_price_quote(
  uuid, uuid, uuid, text, text, text, numeric, boolean, timestamptz, date,
  text, text, text, uuid, text, text, text, text, jsonb, jsonb, text
);

CREATE OR REPLACE FUNCTION public.claim_attachment(p_attachment_id uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_token uuid := gen_random_uuid();
  v_rows  int;
BEGIN
  UPDATE public.inbound_attachments
     SET processing_status       = 'processing',
         processing_started_at   = now(),
         processing_heartbeat_at = now(),
         processing_lease_token  = v_token
   WHERE id               = p_attachment_id
     AND processing_status = 'pending';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  IF v_rows = 0 THEN
    RETURN NULL;
  END IF;
  RETURN v_token;
END;
$function$;

CREATE OR REPLACE FUNCTION public.kerdos_auto_apply_price_quote(p_vendor_item_id uuid, p_organization_id uuid, p_vendor_id uuid, p_vendor_item_code text, p_description text, p_pack_size text, p_price numeric, p_price_unavailable boolean, p_effective_date timestamp with time zone, p_quote_valid_until date, p_source_file_path text, p_source_file_name text, p_source_line text, p_source_document_id uuid, p_selling_unit text DEFAULT NULL::text, p_price_basis text DEFAULT NULL::text, p_gtin text DEFAULT NULL::text, p_manufacturer_code text DEFAULT NULL::text, p_import_row jsonb DEFAULT NULL::jsonb, p_field_resolutions jsonb DEFAULT NULL::jsonb, p_brand text DEFAULT NULL::text, p_lease_token uuid DEFAULT NULL::uuid, p_attachment_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_item_id  uuid;
  v_lease_ok boolean;
BEGIN
  -- §LEASE mandatory guard: both parameters are required.  A call without a
  -- valid lease context is rejected before any writes.
  IF p_lease_token IS NULL OR p_attachment_id IS NULL THEN
    RAISE EXCEPTION
      'kerdos_auto_apply_price_quote_with_lease requires p_lease_token and p_attachment_id — '
      'call without lease context rejected before any writes. [migration_036]';
  END IF;

  SELECT (processing_lease_token = p_lease_token)
    INTO v_lease_ok
    FROM public.inbound_attachments
   WHERE id = p_attachment_id
     FOR UPDATE;

  IF NOT FOUND OR NOT COALESCE(v_lease_ok, false) THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.vendors v
     WHERE v.id = p_vendor_id
       AND v.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'Vendor is outside the requested organization';
  END IF;

  IF p_source_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.import_documents d
     WHERE d.id              = p_source_document_id
       AND d.organization_id = p_organization_id
       AND d.vendor_id       = p_vendor_id
  ) THEN
    RAISE EXCEPTION 'Source document is outside the requested organization/vendor';
  END IF;

  IF p_effective_date IS NULL THEN
    RAISE EXCEPTION 'A price quotation requires an effective date';
  END IF;

  IF p_price_unavailable IS NOT TRUE AND (p_price IS NULL OR p_price <= 0) THEN
    RAISE EXCEPTION 'A current quotation requires a positive price';
  END IF;

  IF p_price_basis IS NOT NULL AND p_price_basis NOT IN ('case','each','measure') THEN
    RAISE EXCEPTION 'Price basis must be case, each or measure';
  END IF;

  IF p_vendor_item_id IS NULL THEN
    INSERT INTO public.vendor_items(
      organization_id, vendor_id, vendor_item_code, description, pack_size, price,
      last_updated, price_source, price_unavailable, price_expired_at,
      price_quote_valid_until, selling_unit, price_basis, gtin, manufacturer_code,
      import_row, field_resolutions, brand
    ) VALUES (
      p_organization_id, p_vendor_id, p_vendor_item_code, p_description, p_pack_size, p_price,
      p_effective_date, 'price_list', p_price_unavailable OR p_pack_size IS NULL, NULL,
      p_quote_valid_until, p_selling_unit, p_price_basis, p_gtin, p_manufacturer_code,
      COALESCE(p_import_row, '{}'::jsonb), COALESCE(p_field_resolutions, '{}'::jsonb), p_brand
    ) RETURNING id INTO v_item_id;
  ELSE
    UPDATE public.vendor_items SET
      price               = CASE WHEN p_price_unavailable THEN price     ELSE p_price     END,
      pack_size           = COALESCE(p_pack_size, pack_size),
      last_updated        = p_effective_date,
      price_source        = 'price_list',
      price_unavailable   = p_price_unavailable OR COALESCE(p_pack_size, pack_size) IS NULL,
      price_expired_at    = NULL,
      price_quote_valid_until = p_quote_valid_until,
      selling_unit        = CASE WHEN p_price_unavailable THEN selling_unit  ELSE p_selling_unit  END,
      price_basis         = CASE WHEN p_price_unavailable THEN price_basis   ELSE p_price_basis   END,
      gtin                = COALESCE(p_gtin,             gtin),
      manufacturer_code   = COALESCE(p_manufacturer_code, manufacturer_code),
      import_row          = COALESCE(p_import_row,        import_row),
      field_resolutions   = COALESCE(p_field_resolutions, field_resolutions),
      brand               = COALESCE(p_brand,             brand),
      row_revision        = row_revision + 1
    WHERE id              = p_vendor_item_id
      AND organization_id = p_organization_id
      AND vendor_id       = p_vendor_id
    RETURNING id INTO v_item_id;

    IF v_item_id IS NULL THEN
      RAISE EXCEPTION 'Vendor item is outside the requested organization/vendor';
    END IF;
  END IF;

  IF NOT p_price_unavailable AND NOT EXISTS (
    SELECT 1 FROM public.price_history h
     WHERE h.source_row_key IS NULL
       AND h.vendor_item_id      = v_item_id
       AND h.source_document_id  = p_source_document_id
       AND (p_import_row->>'rowKey' IS NULL OR
            (p_source_line IS NOT NULL AND h.source_line = p_source_line))
       AND h.price = p_price
  ) THEN
    INSERT INTO public.price_history(
      vendor_item_id, organization_id, price, source, effective_date, quote_valid_until,
      source_file_path, source_file_name, source_description, source_line,
      source_document_id, selling_unit, price_basis, source_row_key
    ) VALUES (
      v_item_id, p_organization_id, p_price, 'price_list',
      p_effective_date, p_quote_valid_until,
      p_source_file_path, p_source_file_name, p_description, p_source_line,
      p_source_document_id, p_selling_unit, p_price_basis,
      p_import_row->>'rowKey'
    )
    ON CONFLICT (source_document_id, source_row_key)
      WHERE source_row_key IS NOT NULL
    DO NOTHING;
  END IF;

  RETURN v_item_id;
END;
$function$;

CREATE OR REPLACE FUNCTION public.recover_stale_attachment(p_attachment_id uuid, p_stale_before timestamp with time zone)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_rows int;
BEGIN
  UPDATE public.inbound_attachments
     SET processing_status       = 'pending',
         processing_error        = NULL,
         processing_started_at   = NULL,
         processing_heartbeat_at = NULL,
         processing_lease_token  = NULL
   WHERE id                      = p_attachment_id
     AND processing_status       = 'processing'
     AND processing_heartbeat_at IS NOT NULL
     AND processing_heartbeat_at < p_stale_before;

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$function$;

CREATE OR REPLACE FUNCTION public.renew_processing_lease(p_attachment_id uuid, p_lease_token uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_rows int;
BEGIN
  UPDATE public.inbound_attachments
     SET processing_heartbeat_at = now()
   WHERE id                     = p_attachment_id
     AND processing_lease_token  = p_lease_token
     AND processing_status       = 'processing';

  GET DIAGNOSTICS v_rows = ROW_COUNT;
  RETURN v_rows > 0;
END;
$function$;

CREATE OR REPLACE FUNCTION public.set_attachment_status_fenced(p_attachment_id uuid, p_status text, p_error text, p_import_document_id uuid, p_lease_token uuid)
 RETURNS boolean
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_token_matches boolean;
BEGIN
  SELECT (processing_lease_token = p_lease_token)
    INTO v_token_matches
    FROM public.inbound_attachments
   WHERE id = p_attachment_id
     AND processing_status = 'processing'
     FOR UPDATE;

  IF NOT FOUND OR NOT COALESCE(v_token_matches, false) THEN
    RETURN false;
  END IF;

  PERFORM public.set_attachment_processing_status(
    p_attachment_id      := p_attachment_id,
    p_status             := p_status,
    p_error              := p_error,
    p_import_document_id := p_import_document_id
  );
  RETURN true;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.claim_attachment(uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.claim_attachment(uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.kerdos_auto_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid,text,text,text,text,jsonb,jsonb,text,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kerdos_auto_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid,text,text,text,text,jsonb,jsonb,text,uuid,uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.recover_stale_attachment(uuid,timestamptz) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.recover_stale_attachment(uuid,timestamptz) TO service_role;

REVOKE EXECUTE ON FUNCTION public.renew_processing_lease(uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.renew_processing_lease(uuid,uuid) TO service_role;

REVOKE EXECUTE ON FUNCTION public.set_attachment_status_fenced(uuid,text,text,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_attachment_status_fenced(uuid,text,text,uuid,uuid) TO service_role;

DO $check$
BEGIN
  IF (SELECT count(*) FROM pg_proc WHERE pronamespace='public'::regnamespace
      AND proname='kerdos_auto_apply_price_quote') <> 1 THEN
    RAISE EXCEPTION 'Expected one canonical price function';
  END IF;
END;
$check$;
