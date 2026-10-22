-- migration_033_auto_processing.sql
--
-- Enables automatic background processing of inbound email attachments.
-- Apply after migration_032_email_routing_addendum.sql.
--
-- Changes:
--   1. email_routing_addresses.vendor_id   — which vendor this address represents
--   2. inbound_attachments.processing_status + processing_error
--                                          — tracks background-processing state
--   3. set_attachment_processing_status()  — SECURITY DEFINER; service-role callable
--                                            updates status/error without auth.uid()
--   4. kerdos_auto_apply_price_quote()     — SECURITY DEFINER; service-role callable
--                                            same body as kerdos_apply_price_quote but
--                                            replaces auth.uid() checks with explicit
--                                            org/vendor validation; browser clients
--                                            must continue using the authenticated variant
--
-- What this does NOT do:
--   • Does not modify kerdos_apply_price_quote — authenticated browser path is unchanged.
--   • Does not drop or replace mark_attachment_ingested — that function still requires
--     an authenticated user and is still used by the browser flow.
--   • Does not grant the new functions to the 'authenticated' role — they are
--     service-role only.
--
-- Schema after this migration:
--   email_routing_addresses : vendor_id (nullable FK → vendors)
--   inbound_attachments     : processing_status, processing_error
--   Functions granted to service_role:
--     set_attachment_processing_status(uuid, text, text)
--     kerdos_auto_apply_price_quote(uuid, uuid, uuid, text, text, text,
--                                   numeric, boolean, timestamptz, date,
--                                   text, text, text, uuid,
--                                   text, text, text, text, jsonb, jsonb, text)

-- ── 1. email_routing_addresses — vendor assignment ─────────────────────────
--
-- vendor_id links a routing address to a specific vendor.
-- When null, the inbound-email function cannot determine which vendor sent the
-- attachment, so processing_status is set to 'needs_review' immediately.
-- ON DELETE SET NULL: if the vendor row is deleted, the routing address becomes
-- unassigned rather than cascading the delete.

ALTER TABLE email_routing_addresses
  ADD COLUMN IF NOT EXISTS vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL;

-- Optional: index for reverse lookup (all routing addresses for a vendor).
CREATE INDEX IF NOT EXISTS email_routing_addresses_vendor_idx
  ON email_routing_addresses (organization_id, vendor_id)
  WHERE vendor_id IS NOT NULL;

-- ── 2. inbound_attachments — processing state ──────────────────────────────
--
-- processing_status values:
--   'pending'        default; attachment stored, processing not yet attempted
--   'processing'     background worker has started (optimistic lock to avoid
--                    duplicate concurrent processing attempts)
--   'auto_imported'  background worker completed without review; import_document_id set
--   'needs_review'   human must open the inbox; reasons recorded in processing_error
--   'failed'         permanent error that prevents processing (distinct from ingest_error
--                    which is about base64 decode at storage time)
--
-- processing_error: human-readable reason for needs_review or failed status.

ALTER TABLE inbound_attachments
  ADD COLUMN IF NOT EXISTS processing_status text NOT NULL DEFAULT 'pending'
    CONSTRAINT inbound_attachments_processing_status_check
      CHECK (processing_status IN ('pending','processing','auto_imported','needs_review','failed')),
  ADD COLUMN IF NOT EXISTS processing_error text;

-- Index for inbox UI queries: find pending/needs_review items for an org.
CREATE INDEX IF NOT EXISTS inbound_attachments_org_processing_idx
  ON inbound_attachments (organization_id, processing_status, created_at DESC);

-- ── 3. set_attachment_processing_status() ─────────────────────────────────
--
-- Used by the background worker (service role) to record the outcome of
-- automatic processing.  Validates the attachment exists and belongs to the
-- expected organization before updating.
--
-- p_import_document_id: accepted when p_status = 'auto_imported' OR 'needs_review'.
-- For 'needs_review', it links the partially-created import document so it does not
-- float unlinked.  For any other status it must be NULL; the function raises if not.
-- When status = 'auto_imported', import_document_id is also set here so the
-- attachment becomes fully linked in a single operation.
--
-- Document ownership validation (when p_import_document_id IS NOT NULL):
--   The provided document must belong to the same organization as the
--   attachment, and — when the routing address has an explicitly assigned
--   vendor — to that same vendor.  The vendor is resolved by joining through
--   inbound_messages → email_routing_addresses.  If the routing address has
--   no assigned vendor (vendor_id IS NULL) the vendor check is skipped and
--   only the organization is verified.
--   Existing import_document_id is preserved via COALESCE when no new id is
--   supplied; a conflicting (non-NULL, wrong org/vendor) id is rejected above
--   before reaching the UPDATE.

CREATE OR REPLACE FUNCTION set_attachment_processing_status(
  p_attachment_id      uuid,
  p_status             text,
  p_error              text    DEFAULT NULL,
  p_import_document_id uuid    DEFAULT NULL
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id     uuid;
  v_vendor_id  uuid;
  v_ingest_err text;
BEGIN
  -- Validate status value.
  IF p_status NOT IN ('pending','processing','auto_imported','needs_review','failed') THEN
    RAISE EXCEPTION 'Unknown processing status: %', p_status;
  END IF;

  -- import_document_id is accepted for auto_imported and needs_review.
  -- For needs_review it links the partial import document so it does not float unlinked.
  IF p_import_document_id IS NOT NULL AND p_status NOT IN ('auto_imported', 'needs_review') THEN
    RAISE EXCEPTION 'p_import_document_id may only be set when p_status is auto_imported or needs_review';
  END IF;

  -- Fetch the attachment's organization, ingest error, and — via the message
  -- and routing address — the vendor explicitly assigned to that address.
  -- v_vendor_id is NULL when email_routing_addresses.vendor_id is not set;
  -- in that case only the organization check applies.
  SELECT ia.organization_id, ia.ingest_error, era.vendor_id
    INTO v_org_id, v_ingest_err, v_vendor_id
    FROM public.inbound_attachments      ia
    JOIN public.inbound_messages         im  ON im.id  = ia.message_id
    JOIN public.email_routing_addresses  era ON era.id = im.routing_address_id
   WHERE ia.id = p_attachment_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'attachment not found: %', p_attachment_id;
  END IF;

  -- Reject processing a permanently failed ingest row.
  IF v_ingest_err IS NOT NULL AND p_status = 'auto_imported' THEN
    RAISE EXCEPTION 'cannot mark a decode-failed attachment as auto_imported';
  END IF;

  -- When a document ID is supplied, verify ownership before writing.
  -- The document must belong to the attachment's organization; when the routing
  -- address has an assigned vendor the document must also belong to that vendor.
  -- This closes a cross-org / cross-vendor linkage gap: a caller with service-role
  -- access could otherwise link any document UUID to any attachment.
  IF p_import_document_id IS NOT NULL THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.import_documents d
       WHERE d.id              = p_import_document_id
         AND d.organization_id = v_org_id
         AND (v_vendor_id IS NULL OR d.vendor_id = v_vendor_id)
    ) THEN
      RAISE EXCEPTION
        'import document does not belong to the attachment''s organization or vendor';
    END IF;
  END IF;

  UPDATE public.inbound_attachments
     SET processing_status  = p_status,
         processing_error   = p_error,
         import_document_id = COALESCE(p_import_document_id, import_document_id)
   WHERE id = p_attachment_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION set_attachment_processing_status(uuid, text, text, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION set_attachment_processing_status(uuid, text, text, uuid) TO service_role;

-- ── 4. kerdos_auto_apply_price_quote() ────────────────────────────────────
--
-- Service-role variant of kerdos_apply_price_quote (migration_015).
-- Identical body except:
--   • No auth.uid() null-check — service role has no JWT user.
--   • No organization_members check for the caller — service role is trusted;
--     the calling Edge Function has already validated the org via the routing
--     address before any data is touched.
--   • All other validations are preserved: vendor-in-org, source-doc-in-org,
--     effective_date required, price > 0, price_basis valid values.
--
-- Granted to service_role only.  The 'authenticated' role continues to use
-- kerdos_apply_price_quote, which enforces caller membership.

CREATE OR REPLACE FUNCTION kerdos_auto_apply_price_quote(
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
  p_brand               text    DEFAULT NULL
)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_item_id uuid;
BEGIN
  -- Structural validations (same as kerdos_apply_price_quote).
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

  -- Upsert public.vendor_items (same logic as kerdos_apply_price_quote).
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

  -- Price history (idempotent on source_document_id + source_row_key).
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
$$;

REVOKE ALL  ON FUNCTION kerdos_auto_apply_price_quote(
  uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,
  text,text,text,uuid,text,text,text,text,jsonb,jsonb,text
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION kerdos_auto_apply_price_quote(
  uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,
  text,text,text,uuid,text,text,text,text,jsonb,jsonb,text
) TO service_role;
