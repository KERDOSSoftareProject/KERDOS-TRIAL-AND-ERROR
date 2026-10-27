-- migration_034_lease_and_recovery.sql
--
-- Adds row-level lease columns to inbound_attachments; creates
-- claim_attachment(), renew_processing_lease(), and recover_stale_attachment();
-- extends kerdos_auto_apply_price_quote with fenced-write logic; and fixes the
-- NULL-token bypass in the pre-existing set_attachment_status_fenced().
--
-- Verified by:
--   scripts/test_a1_2_g_race.py                       — B1/B2 race
--   supabase/functions/process-attachment/lease-handoff-test.mjs  — unit
--   supabase/functions/process-attachment/process-attachment-test.mjs — unit
-- Apply after migration_033_auto_processing.sql.
--
-- Changes:
--   1. inbound_attachments.processing_lease_token   uuid  — UUID held by the
--        current worker; NULL when not in 'processing'
--   2. inbound_attachments.processing_started_at    timestamptz — when
--        'processing' was entered
--   3. inbound_attachments.processing_heartbeat_at  timestamptz — last heartbeat;
--        recover_stale_attachment checks this for expiry
--   4. claim_attachment(uuid) RETURNS text          — NEW; atomically transitions
--        pending/needs_review → processing, mints a lease UUID, returns it; NULL
--        if another worker already holds the row
--   5. renew_processing_lease(uuid, uuid) RETURNS boolean — NEW; updates
--        processing_heartbeat_at when the caller's lease token matches; returns
--        false if the lease has been revoked
--   6. kerdos_auto_apply_price_quote() (23-param)   — REPLACE; adds
--        p_lease_token uuid DEFAULT NULL and p_attachment_id uuid DEFAULT NULL;
--        fenced write: acquires FOR UPDATE, checks lease, resets status on success
--   7. recover_stale_attachment(uuid, timestamptz)  — NEW; resets a stuck
--        'processing' row to 'pending' when heartbeat has expired
--   8. set_attachment_status_fenced()               — PATCH; fixes NULL-token
--        bypass in the pre-existing function; COALESCE(token_matches, false)
--        ensures a NULL lease token always fails the fence
--
-- What this does NOT change:
--   • kerdos_apply_price_quote    — browser-authenticated path unchanged
--   • set_attachment_processing_status — still used for unfenced final status

-- ── 1–3. Lease columns on inbound_attachments ────────────────────────────────

ALTER TABLE public.inbound_attachments
  ADD COLUMN IF NOT EXISTS processing_lease_token  uuid,
  ADD COLUMN IF NOT EXISTS processing_started_at   timestamptz,
  ADD COLUMN IF NOT EXISTS processing_heartbeat_at timestamptz;

-- Partial index for stale-recovery: quickly find expired processing rows.
CREATE INDEX IF NOT EXISTS inbound_attachments_stale_processing_idx
  ON public.inbound_attachments (organization_id, processing_heartbeat_at)
  WHERE processing_status = 'processing';

-- ── 4. claim_attachment(uuid) ─────────────────────────────────────────────────
--
-- Atomically transitions an inbound_attachments row from
-- pending/needs_review → processing, minting a fresh UUID lease token.
--
-- Returns the lease token (uuid cast to text) so the caller can pass it on
-- every subsequent fenced write.  Returns NULL if the row is not in a
-- claimable state (another worker already holds it, or the id does not exist).
--
-- Matches the call in lease-bindings.mjs:
--   client.rpc("claim_attachment", { p_attachment_id: attachmentId })
--   → data: string | null

CREATE OR REPLACE FUNCTION public.claim_attachment(
  p_attachment_id uuid
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_token uuid := gen_random_uuid();
  v_now   timestamptz := now();
  v_id    uuid;
BEGIN
  UPDATE public.inbound_attachments
     SET processing_status       = 'processing',
         processing_lease_token  = v_token,
         processing_started_at   = v_now,
         processing_heartbeat_at = v_now
   WHERE id                = p_attachment_id
     AND processing_status IN ('pending', 'needs_review')
  RETURNING id INTO v_id;

  IF v_id IS NULL THEN
    RETURN NULL;   -- already claimed or row absent
  END IF;

  RETURN v_token::text;
END;
$$;

REVOKE ALL ON FUNCTION public.claim_attachment(uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.claim_attachment(uuid) TO service_role;

-- ── 5. renew_processing_lease(uuid, uuid) ────────────────────────────────────
--
-- Updates processing_heartbeat_at when the caller's token matches the stored
-- lease token AND the row is still in 'processing'.
--
-- Returns TRUE on success, FALSE if the lease has been revoked by
-- recover_stale_attachment or another concurrent worker.
--
-- Matches the call in lease-bindings.mjs:
--   client.rpc("renew_processing_lease",
--              { p_attachment_id: attachmentId, p_lease_token: token })
--   → data: boolean

CREATE OR REPLACE FUNCTION public.renew_processing_lease(
  p_attachment_id uuid,
  p_lease_token   uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_id uuid;
BEGIN
  UPDATE public.inbound_attachments
     SET processing_heartbeat_at = now()
   WHERE id                    = p_attachment_id
     AND processing_status     = 'processing'
     AND processing_lease_token = p_lease_token
  RETURNING id INTO v_id;

  RETURN v_id IS NOT NULL;
END;
$$;

REVOKE ALL ON FUNCTION public.renew_processing_lease(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.renew_processing_lease(uuid, uuid) TO service_role;

-- ── 6. kerdos_auto_apply_price_quote (23-param — fenced write) ───────────────
--
-- Extends the 21-param function from migration_033 with two optional parameters:
--
--   p_lease_token    uuid DEFAULT NULL
--   p_attachment_id  uuid DEFAULT NULL
--
-- When both are supplied:
--   1. Acquires FOR UPDATE on the attachment row.
--   2. Verifies processing_lease_token = p_lease_token AND status = 'processing'.
--   3. If the check fails, returns NULL without writing anything.
--   4. Saves the price quote (vendor_items + price_history — same as before).
--   5. Atomically resets processing_status = 'pending', processing_lease_token = NULL
--      so a pending kerdos_auto_apply_price_quote call from a recovered worker
--      on the same row sees a clean state.
--
-- When both are NULL (legacy callers, tests), the lock/check/reset path is
-- entirely skipped and the function behaves identically to migration_033.
--
-- The 21-parameter signature is dropped first so PostgreSQL function
-- overloading does not leave both versions active.

DROP FUNCTION IF EXISTS public.kerdos_auto_apply_price_quote(
  uuid, uuid, uuid, text, text, text,
  numeric, boolean, timestamptz, date,
  text, text, text, uuid,
  text, text, text, text, jsonb, jsonb, text
);

CREATE OR REPLACE FUNCTION public.kerdos_auto_apply_price_quote(
  p_vendor_item_id      uuid,
  p_organization_id     uuid,
  p_vendor_id           uuid,
  p_vendor_item_code    text,
  p_description         text,
  p_pack_size           text,
  p_price               numeric,
  p_price_unavailable   boolean,
  p_effective_date      timestamptz,
  p_quote_valid_until   date,
  p_source_file_path    text,
  p_source_file_name    text,
  p_source_line         text,
  p_source_document_id  uuid,
  p_selling_unit        text    DEFAULT NULL,
  p_price_basis         text    DEFAULT NULL,
  p_gtin                text    DEFAULT NULL,
  p_manufacturer_code   text    DEFAULT NULL,
  p_import_row          jsonb   DEFAULT NULL,
  p_field_resolutions   jsonb   DEFAULT NULL,
  p_brand               text    DEFAULT NULL,
  -- New in migration_034: fenced-write parameters (both NULL → legacy behaviour)
  p_lease_token         uuid    DEFAULT NULL,
  p_attachment_id       uuid    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_item_id uuid;
BEGIN
  -- ── Fenced-write guard (migration_034) ──────────────────────────────────────
  IF p_attachment_id IS NOT NULL THEN
    PERFORM 1
      FROM public.inbound_attachments
     WHERE id                     = p_attachment_id
       AND processing_lease_token  = p_lease_token
       AND processing_status       = 'processing'
    FOR UPDATE;

    IF NOT FOUND THEN
      RETURN NULL;   -- lease revoked or row absent
    END IF;
  END IF;

  -- ── Structural validations (same as migration_033) ──────────────────────────

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

  -- ── Upsert vendor_items (same as migration_033) ──────────────────────────────

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
      price               = CASE WHEN p_price_unavailable THEN price ELSE p_price END,
      pack_size           = COALESCE(p_pack_size, pack_size),
      last_updated        = p_effective_date,
      price_source        = 'price_list',
      price_unavailable   = p_price_unavailable OR COALESCE(p_pack_size, pack_size) IS NULL,
      price_expired_at    = NULL,
      price_quote_valid_until = p_quote_valid_until,
      selling_unit        = CASE WHEN p_price_unavailable THEN selling_unit ELSE p_selling_unit END,
      price_basis         = CASE WHEN p_price_unavailable THEN price_basis ELSE p_price_basis END,
      gtin                = COALESCE(p_gtin, gtin),
      manufacturer_code   = COALESCE(p_manufacturer_code, manufacturer_code),
      import_row          = COALESCE(p_import_row, import_row),
      field_resolutions   = COALESCE(p_field_resolutions, field_resolutions),
      brand               = COALESCE(p_brand, brand),
      row_revision        = row_revision + 1
    WHERE id              = p_vendor_item_id
      AND organization_id = p_organization_id
      AND vendor_id       = p_vendor_id
    RETURNING id INTO v_item_id;

    IF v_item_id IS NULL THEN
      RAISE EXCEPTION 'Vendor item is outside the requested organization/vendor';
    END IF;
  END IF;

  -- ── Append price history (same as migration_033) ─────────────────────────────

  IF NOT p_price_unavailable AND NOT EXISTS (
    SELECT 1 FROM public.price_history h
     WHERE h.source_row_key IS NULL
       AND h.vendor_item_id    = v_item_id
       AND h.source_document_id = p_source_document_id
       AND (
             p_import_row->>'rowKey' IS NULL
             OR (
                  p_source_line IS NOT NULL
                  AND h.source_line = p_source_line
                )
           )
       AND h.price = p_price
  ) THEN
    INSERT INTO public.price_history(
      vendor_item_id, organization_id, price, source, effective_date, quote_valid_until,
      source_file_path, source_file_name, source_description, source_line,
      source_document_id, selling_unit, price_basis, source_row_key
    ) VALUES (
      v_item_id, p_organization_id, p_price, 'price_list', p_effective_date, p_quote_valid_until,
      p_source_file_path, p_source_file_name, p_description, p_source_line,
      p_source_document_id, p_selling_unit, p_price_basis, p_import_row->>'rowKey'
    )
    ON CONFLICT (source_document_id, source_row_key)
      WHERE source_row_key IS NOT NULL
      DO NOTHING;
  END IF;

  -- ── Lease release (migration_034) ────────────────────────────────────────────
  -- After a successful write, reset the attachment to 'pending' and clear the
  -- lease token.  The Edge Function calls set_attachment_status_fenced()
  -- (via lease-bindings.mjs) to set the final status once all rows are done.

  IF p_attachment_id IS NOT NULL THEN
    UPDATE public.inbound_attachments
       SET processing_status      = 'pending',
           processing_lease_token = NULL
     WHERE id = p_attachment_id;
  END IF;

  RETURN v_item_id;
END;
$$;

REVOKE ALL ON FUNCTION public.kerdos_auto_apply_price_quote(
  uuid, uuid, uuid, text, text, text,
  numeric, boolean, timestamptz, date,
  text, text, text, uuid,
  text, text, text, text, jsonb, jsonb, text,
  uuid, uuid
) FROM PUBLIC;

GRANT EXECUTE ON FUNCTION public.kerdos_auto_apply_price_quote(
  uuid, uuid, uuid, text, text, text,
  numeric, boolean, timestamptz, date,
  text, text, text, uuid,
  text, text, text, text, jsonb, jsonb, text,
  uuid, uuid
) TO service_role;

-- ── 7. recover_stale_attachment(uuid, timestamptz) ───────────────────────────
--
-- Resets an inbound_attachments row that is stuck in 'processing' with an
-- expired heartbeat back to 'pending'.  Uses FOR UPDATE to serialise against
-- concurrent kerdos_auto_apply_price_quote calls (B1/B2 race).
--
-- Return values (text):
--   'recovered' — attachment was stale; status reset, lease cleared
--   'active'    — heartbeat is fresh; worker is still alive
--   'not_stale' — attachment is not in 'processing' state
--   'not_found' — no row with that id

CREATE OR REPLACE FUNCTION public.recover_stale_attachment(
  p_attachment_id uuid,
  p_now           timestamptz
)
RETURNS text
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.inbound_attachments%ROWTYPE;
BEGIN
  SELECT * INTO v_row
    FROM public.inbound_attachments
   WHERE id = p_attachment_id
   FOR UPDATE;

  IF NOT FOUND THEN RETURN 'not_found'; END IF;

  IF v_row.processing_status <> 'processing' THEN RETURN 'not_stale'; END IF;

  IF v_row.processing_heartbeat_at IS NOT NULL
     AND v_row.processing_heartbeat_at > p_now - INTERVAL '5 minutes' THEN
    RETURN 'active';
  END IF;

  UPDATE public.inbound_attachments
     SET processing_status       = 'pending',
         processing_lease_token  = NULL,
         processing_started_at   = NULL,
         processing_heartbeat_at = NULL,
         processing_error        = 'Recovered from stale processing state at ' || p_now::text
   WHERE id = p_attachment_id;

  RETURN 'recovered';
END;
$$;

REVOKE ALL ON FUNCTION public.recover_stale_attachment(uuid, timestamptz) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.recover_stale_attachment(uuid, timestamptz) TO service_role;

-- ── 8. set_attachment_status_fenced — NULL-token fix ─────────────────────────
--
-- Patches the pre-existing set_attachment_status_fenced() which evaluates
-- NULL = p_lease_token as NULL (not FALSE) in PL/pgSQL, silently letting a
-- NULL lease token bypass the fence check.
--
-- Fix: use COALESCE(v_token_matches, false) so a NULL stored token (row already
-- recovered) is treated as a failed match, not as a pass-through.
--
-- The corrected logic:
--   1. SELECT ... FOR UPDATE on the row filtered to status = 'processing'.
--   2. COALESCE(processing_lease_token = p_lease_token, false) — false if NULL.
--   3. If NOT FOUND or token does not match → RETURN false.
--   4. Call set_attachment_processing_status to update status.
--   5. RETURN true.

CREATE OR REPLACE FUNCTION public.set_attachment_status_fenced(
  p_attachment_id      uuid,
  p_status             text,
  p_error              text,
  p_import_document_id uuid,
  p_lease_token        uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_token_matches boolean;
BEGIN
  SELECT COALESCE(processing_lease_token = p_lease_token, false)
    INTO v_token_matches
    FROM public.inbound_attachments
   WHERE id                = p_attachment_id
     AND processing_status = 'processing'
   FOR UPDATE;

  IF NOT FOUND OR NOT v_token_matches THEN
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
$$;

-- Permissions: keep existing grants (same signature, just replace body).
REVOKE ALL ON FUNCTION public.set_attachment_status_fenced(uuid, text, text, uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION public.set_attachment_status_fenced(uuid, text, text, uuid, uuid) TO service_role;
