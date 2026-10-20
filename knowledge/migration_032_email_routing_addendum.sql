-- migration_032_email_routing_addendum.sql
--
-- Reliability and consistency fixes for Module A · Task 1 · Email Routing.
-- Apply after migration_032_email_routing.sql.
--
-- Changes covered:
--   1. inbound_attachments.storage_path → nullable (failed-decode rows have no path)
--   2. inbound_attachments.ingest_error  → new nullable text column
--   3. email_routing_addresses           → domain CHECK constraint
--   4. email_routing_addresses           → write policies restricted to owner/manager
--   5. mark_attachment_ingested()        → reject failed/null-path rows (Gap B)
--                                          idempotent on same import_document_id (Gap C)

-- ── 1. inbound_attachments — visible failure state ──────────────────────────
--
-- storage_path becomes nullable: rows inserted for base64-decode failures have
-- no path because the file never reached Storage.

ALTER TABLE inbound_attachments
  ALTER COLUMN storage_path DROP NOT NULL;

-- ingest_error records the reason an attachment could not be stored.
--   null  = no error (normal state, file is in Storage)
--   text  = permanent error message (e.g. "base64 decode failed: …")
--           import_document_id must remain null; the file cannot be imported.

ALTER TABLE inbound_attachments
  ADD COLUMN IF NOT EXISTS ingest_error text;

-- ── 2. email_routing_addresses — domain constraint ──────────────────────────
--
-- All routing addresses must use the @inbound.kerdos.com domain.
-- This enforces at the database boundary what the UI already explains.

ALTER TABLE email_routing_addresses
  ADD CONSTRAINT email_routing_addresses_inbound_domain
    CHECK (routing_address LIKE '%@inbound.kerdos.com');

-- ── 3. email_routing_addresses — write policies ──────────────────────────────
--
-- Owner/manager-only INSERT and UPDATE policies are created by the base
-- migration (migration_032_email_routing.sql).  No replacement needed here.

-- ── 4. mark_attachment_ingested() — corrected SECURITY DEFINER function ─────
--
-- Replaces the version in migration_032_email_routing.sql with three additions:
--
--   Gap B: reject rows that were never stored (ingest_error IS NOT NULL or
--          storage_path IS NULL) — the UI already blocks these; the DB must
--          enforce the same rule so a crafted RPC call cannot mark a decode-
--          failure row as "imported."
--
--   Gap C: make the call idempotent when the same import_document_id is
--          presented a second time.  Scenario: the DB UPDATE succeeds but the
--          RPC response is lost in transit; the caller retries with the same
--          importDocumentId.  That retry must succeed rather than raising
--          "already ingested."  A different import_document_id is still
--          rejected to prevent clobbering a legitimate link.
--
-- All other behaviour (null-check, org membership, cross-org document check)
-- is preserved exactly.

CREATE OR REPLACE FUNCTION mark_attachment_ingested(
  p_attachment_id      uuid,
  p_import_document_id uuid
)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_org_id             uuid;
  v_ingest_error       text;
  v_storage_path       text;
  v_existing_doc_id    uuid;
BEGIN
  -- Reject a null import document ID up front.
  IF p_import_document_id IS NULL THEN
    RAISE EXCEPTION 'p_import_document_id cannot be null';
  END IF;

  -- Fetch the attachment row (one query covers all column checks).
  SELECT organization_id, ingest_error, storage_path, import_document_id
    INTO v_org_id, v_ingest_error, v_storage_path, v_existing_doc_id
    FROM public.inbound_attachments
   WHERE id = p_attachment_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'attachment not found: %', p_attachment_id;
  END IF;

  -- Gap B: reject permanently-failed attachments — no file was ever stored.
  IF v_ingest_error IS NOT NULL THEN
    RAISE EXCEPTION 'attachment has a decode error and cannot be ingested: %', v_ingest_error;
  END IF;

  -- Gap B: belt-and-suspenders — reject any row without a storage path.
  IF v_storage_path IS NULL THEN
    RAISE EXCEPTION 'attachment has no storage path and cannot be ingested';
  END IF;

  -- Verify the calling user belongs to the attachment's organization.
  -- Access rule: any org member may mark attachments ingested (inbox is
  -- member-accessible); routing-address writes are owner/manager-only.
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE organization_id = v_org_id
      AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'permission denied';
  END IF;

  -- Verify the import document belongs to the same organization.
  IF NOT EXISTS (
    SELECT 1 FROM public.import_documents
    WHERE id              = p_import_document_id
      AND organization_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'import document not found or belongs to a different organization';
  END IF;

  -- Gap C: idempotency — if this attachment is already linked to the SAME
  -- import document, treat the call as a no-op success.  This handles the
  -- case where the DB UPDATE succeeded but the RPC response was lost in
  -- transit and the caller retries.
  IF v_existing_doc_id IS NOT NULL THEN
    IF v_existing_doc_id = p_import_document_id THEN
      RETURN;  -- already linked to this exact document; success
    END IF;
    RAISE EXCEPTION 'attachment already linked to a different import document';
  END IF;

  -- Link the attachment to the import document.
  UPDATE public.inbound_attachments
     SET import_document_id = p_import_document_id
   WHERE id                 = p_attachment_id
     AND import_document_id IS NULL;

  -- Concurrent-retry safety: a parallel call may have updated the row between
  -- our SELECT and this UPDATE.  Re-check the idempotency condition.
  IF NOT FOUND THEN
    SELECT import_document_id INTO v_existing_doc_id
      FROM public.inbound_attachments WHERE id = p_attachment_id;
    IF v_existing_doc_id = p_import_document_id THEN
      RETURN;  -- concurrent call used the same doc; idempotent success
    END IF;
    RAISE EXCEPTION 'attachment already linked to a different import document';
  END IF;
END;
$$;
