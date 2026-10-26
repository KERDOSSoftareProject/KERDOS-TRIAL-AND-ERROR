-- migration_034_partial_import_recovery.sql
--
-- A1.7 — Partial Import Recovery
--
-- Fixes the three gaps identified in A1.7.c:
--
--   Gap A1.7.c: mark_attachment_ingested() only links import_document_id but
--   never updates processing_status.  After the user completes a "needs_review"
--   import through PasteModal the attachment stays in 'needs_review' forever —
--   the inbox badge never clears and the attachment looks perpetually unfinished.
--
-- Fix:
--   Add an optional p_final_status parameter to mark_attachment_ingested().
--   When the caller supplies it (value 'auto_imported' or 'needs_review') the
--   function also updates processing_status in the same transaction.
--
--   Existing callers that omit the parameter get the original behaviour
--   (import_document_id linked, processing_status left unchanged).
--
-- No schema additions needed; processing_status already exists on
-- inbound_attachments (added by migration_033_auto_processing.sql).

CREATE OR REPLACE FUNCTION mark_attachment_ingested(
  p_attachment_id      uuid,
  p_import_document_id uuid,
  p_final_status       text DEFAULT NULL
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
  -- Validate p_final_status early so the caller learns of bad input before
  -- any side effects occur.
  IF p_final_status IS NOT NULL
     AND p_final_status NOT IN ('auto_imported', 'needs_review') THEN
    RAISE EXCEPTION
      'invalid p_final_status ''%'': must be auto_imported or needs_review',
      p_final_status;
  END IF;

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

  -- Reject permanently-failed attachments — no file was ever stored.
  IF v_ingest_error IS NOT NULL THEN
    RAISE EXCEPTION 'attachment has a decode error and cannot be ingested: %', v_ingest_error;
  END IF;

  -- Belt-and-suspenders — reject any row without a storage path.
  IF v_storage_path IS NULL THEN
    RAISE EXCEPTION 'attachment has no storage path and cannot be ingested';
  END IF;

  -- Verify the calling user belongs to the attachment's organization.
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

  -- Idempotency: if this attachment is already linked to the SAME import
  -- document, update processing_status (if requested) and return.  This
  -- handles the case where the DB UPDATE succeeded but the RPC response was
  -- lost in transit and the caller retries.
  IF v_existing_doc_id IS NOT NULL THEN
    IF v_existing_doc_id = p_import_document_id THEN
      -- Already linked to the same document — idempotent success.
      -- Still apply the status update so a retry after a partial response
      -- (link wrote, status write was lost) also converges.
      IF p_final_status IS NOT NULL THEN
        UPDATE public.inbound_attachments
           SET processing_status = p_final_status
         WHERE id = p_attachment_id;
      END IF;
      RETURN;
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
      -- Concurrent call used the same doc; apply status and return idempotently.
      IF p_final_status IS NOT NULL THEN
        UPDATE public.inbound_attachments
           SET processing_status = p_final_status
         WHERE id = p_attachment_id;
      END IF;
      RETURN;
    END IF;
    RAISE EXCEPTION 'attachment already linked to a different import document';
  END IF;

  -- Optionally set the terminal processing status in the same transaction.
  IF p_final_status IS NOT NULL THEN
    UPDATE public.inbound_attachments
       SET processing_status = p_final_status
     WHERE id = p_attachment_id;
  END IF;
END;
$$;
