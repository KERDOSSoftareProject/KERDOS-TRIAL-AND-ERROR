-- A1 cross-task handoff correction. DRAFT — not applied.
-- Apply after 036, in the isolated test environment first.
-- Manual review and automatic claim serialize on the attachment row.
-- The existing mark function is replaced at its exact (uuid,uuid,text) signature
-- with a row lock and active-worker guard; all other validation is retained.

CREATE OR REPLACE FUNCTION public.mark_attachment_ingested(
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
  v_processing_status  text;
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
  SELECT organization_id, ingest_error, storage_path, import_document_id, processing_status
    INTO v_org_id, v_ingest_error, v_storage_path, v_existing_doc_id, v_processing_status
    FROM public.inbound_attachments
   WHERE id = p_attachment_id
     FOR UPDATE;

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

  -- A person cannot finish an import while a worker owns this attachment.
  IF v_processing_status = 'processing' THEN
    RAISE EXCEPTION 'attachment is being processed automatically — retry after it finishes';
  END IF;

  -- Verify the import document belongs to the same organization.
  IF NOT EXISTS (
    SELECT 1 FROM public.import_documents
    WHERE id              = p_import_document_id
      AND organization_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'import document not found or belongs to a different organization';
  END IF;

  -- Completion guard: 'auto_imported' asserts that the entire file has been
  -- processed.  Enforce this at the database level so a bug or race in the
  -- caller cannot mark an attachment fully imported while the import document
  -- is still partial or processing.  'needs_review' has no equivalent guard —
  -- a partial document (status 'partial' or 'processing') is the expected
  -- state when the background worker routes a document to human review.
  IF p_final_status = 'auto_imported' THEN
    IF NOT EXISTS (
      SELECT 1 FROM public.import_documents
      WHERE id     = p_import_document_id
        AND status = 'complete'
    ) THEN
      RAISE EXCEPTION
        'import document is not complete — cannot mark attachment as auto_imported; finalize the import first';
    END IF;
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
      -- The completion guard above runs before this path so the status
      -- invariant is enforced even on retry.
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

CREATE OR REPLACE FUNCTION public.begin_manual_attachment_review(
  p_organization_id uuid,
  p_attachment_id uuid
)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $$
DECLARE
  v_row public.inbound_attachments%ROWTYPE;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
     WHERE organization_id = p_organization_id AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'permission denied';
  END IF;
  -- This row lock serializes with claim_attachment's UPDATE and with recovery.
  SELECT * INTO v_row FROM public.inbound_attachments
   WHERE id = p_attachment_id
     AND organization_id = p_organization_id
     FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'attachment not found in this organization';
  END IF;
  IF v_row.ingest_error IS NOT NULL OR v_row.storage_path IS NULL THEN
    RAISE EXCEPTION 'attachment has no usable stored file';
  END IF;
  IF v_row.processing_status = 'needs_review' THEN
    RETURN true;
  END IF;
  IF v_row.processing_status <> 'pending' THEN
    RETURN false;
  END IF;

  UPDATE public.inbound_attachments
     SET processing_status = 'needs_review'
   WHERE id = p_attachment_id;
  RETURN true;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.begin_manual_attachment_review(uuid,uuid) FROM PUBLIC, anon;
GRANT EXECUTE ON FUNCTION public.begin_manual_attachment_review(uuid,uuid) TO authenticated;
