-- DRAFT. Apply to kerdos-test only after reviewing the live signatures.
-- A routing address may be reassigned after an email arrives. Capture the
-- vendor once on the message. NULL + non-NULL snapshot_at means deliberately
-- unassigned at receipt; NULL snapshot_at means legacy/unknown, never infer
-- an earlier assignment from today's routing address.

ALTER TABLE public.inbound_messages
  ADD COLUMN receipt_vendor_id uuid,
  ADD COLUMN vendor_snapshot_at timestamptz;

ALTER TABLE public.inbound_messages
  ADD CONSTRAINT inbound_messages_receipt_vendor_requires_snapshot
    CHECK (receipt_vendor_id IS NULL OR vendor_snapshot_at IS NOT NULL),
  ADD CONSTRAINT inbound_messages_receipt_vendor_org_fk
    FOREIGN KEY (organization_id, receipt_vendor_id)
    REFERENCES public.vendors(organization_id, id);

CREATE OR REPLACE FUNCTION public.protect_inbound_vendor_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.receipt_vendor_id IS DISTINCT FROM OLD.receipt_vendor_id
     OR NEW.vendor_snapshot_at IS DISTINCT FROM OLD.vendor_snapshot_at THEN
    RAISE EXCEPTION 'receipt-time vendor snapshot cannot be changed';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER inbound_messages_vendor_snapshot_immutable
  BEFORE UPDATE ON public.inbound_messages
  FOR EACH ROW EXECUTE FUNCTION public.protect_inbound_vendor_snapshot();

-- The fenced status function delegates to this function. Validate the
-- document against the receipt-time vendor, not a mutable routing address.
CREATE OR REPLACE FUNCTION public.set_attachment_processing_status(
  p_attachment_id uuid,
  p_status text,
  p_error text DEFAULT NULL,
  p_import_document_id uuid DEFAULT NULL
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  v_org_id uuid;
  v_vendor_id uuid;
  v_snapshot_at timestamptz;
  v_ingest_err text;
BEGIN
  IF p_status NOT IN ('pending','processing','auto_imported','needs_review','failed') THEN
    RAISE EXCEPTION 'Unknown processing status: %', p_status;
  END IF;
  IF p_import_document_id IS NOT NULL
     AND p_status NOT IN ('auto_imported','needs_review') THEN
    RAISE EXCEPTION 'p_import_document_id may only be set when p_status is auto_imported or needs_review';
  END IF;

  SELECT ia.organization_id, ia.ingest_error,
         im.receipt_vendor_id, im.vendor_snapshot_at
    INTO v_org_id, v_ingest_err, v_vendor_id, v_snapshot_at
    FROM public.inbound_attachments ia
    JOIN public.inbound_messages im ON im.id = ia.message_id
   WHERE ia.id = p_attachment_id;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'attachment not found: %', p_attachment_id;
  END IF;
  IF v_ingest_err IS NOT NULL AND p_status = 'auto_imported' THEN
    RAISE EXCEPTION 'cannot mark a decode-failed attachment as auto_imported';
  END IF;
  IF p_status = 'auto_imported' AND (v_snapshot_at IS NULL OR v_vendor_id IS NULL) THEN
    RAISE EXCEPTION 'automatic import requires a receipt-time vendor snapshot';
  END IF;
  IF p_import_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.import_documents d
     WHERE d.id = p_import_document_id
       AND d.organization_id = v_org_id
       AND (v_vendor_id IS NULL OR d.vendor_id = v_vendor_id)
  ) THEN
    RAISE EXCEPTION 'import document does not belong to the attachment organization or receipt-time vendor';
  END IF;

  UPDATE public.inbound_attachments
     SET processing_status = p_status,
         processing_error = p_error,
         import_document_id = COALESCE(p_import_document_id, import_document_id)
   WHERE id = p_attachment_id;
END;
$$;

REVOKE EXECUTE ON FUNCTION public.set_attachment_processing_status(uuid,text,text,uuid)
  FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.set_attachment_processing_status(uuid,text,text,uuid)
  TO service_role;
