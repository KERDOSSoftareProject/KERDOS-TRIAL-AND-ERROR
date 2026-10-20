-- migration_032_email_routing.sql
--
-- Adds three tables for Module A · Pre-Ingestion · Task 1 · Email Routing.
--
-- email_routing_addresses  — one row per client routing address
--   Each organization gets one or more dedicated inbound addresses, e.g.
--   acme-pricing@inbound.kerdos.com. The routing_address column (the full
--   address, lowercased) is the lookup key when the Edge Function receives
--   a Postmark webhook and inspects OriginalRecipient.
--
-- inbound_messages  — one row per received email
--   Recorded by the Edge Function before any attachment work. The
--   postmark_message_id column is the idempotency key: the Edge Function
--   checks for an existing row with the same postmark_message_id before
--   inserting, so Postmark's 10-retry policy cannot duplicate records.
--
-- inbound_attachments  — one row per attachment on an inbound email
--   storage_path points to the raw file bytes in Supabase Storage (bucket:
--   documents). import_document_id is null until the client opens the
--   "Review & Import" inbox panel and completes the PasteModal flow;
--   it becomes a FK to import_documents once the attachment is ingested.
--   null = pending review; populated = ingested. This IS the audit trail.
--
-- RLS is enabled on all three tables. All policies use auth.uid() to scope
-- reads and writes to the organization the authenticated user belongs to.
-- The Edge Function uses the service role key (bypasses RLS) but constrains
-- every operation to the organization_id resolved from the routing address.

-- ── email_routing_addresses ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS email_routing_addresses (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  routing_address   text        NOT NULL,   -- full address, lowercase, e.g. acme-pricing@inbound.kerdos.com
  label             text,                   -- human label, e.g. "Pricing sheet inbox"
  forward_to        text,                   -- optional: forward a copy to this address
  is_active         boolean     NOT NULL DEFAULT true,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT email_routing_addresses_address_unique UNIQUE (routing_address),
  CONSTRAINT email_routing_addresses_address_lower  CHECK (routing_address = lower(routing_address))
);

ALTER TABLE email_routing_addresses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "email_routing_addresses: org members read own"
  ON email_routing_addresses FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
    )
  );

-- Routing-address writes are restricted to owners and managers.
-- Any org member may read; only privileged roles may create or change addresses.
CREATE POLICY "email_routing_addresses: owners and managers insert"
  ON email_routing_addresses FOR INSERT
  WITH CHECK (
    organization_id IN (
      SELECT organization_id FROM organization_members
       WHERE user_id = auth.uid()
         AND role IN ('owner', 'manager')
    )
  );

CREATE POLICY "email_routing_addresses: owners and managers update"
  ON email_routing_addresses FOR UPDATE
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members
       WHERE user_id = auth.uid()
         AND role IN ('owner', 'manager')
    )
  );

-- ── inbound_messages ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS inbound_messages (
  id                   uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id      uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  routing_address_id   uuid        NOT NULL REFERENCES email_routing_addresses(id),
  postmark_message_id  text        NOT NULL,   -- Postmark MessageID, idempotency key
  sender_email         text        NOT NULL,
  sender_name          text,
  subject              text,
  body_text            text,
  received_at          timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT inbound_messages_postmark_id_org_unique
    UNIQUE (postmark_message_id, organization_id)
);

CREATE INDEX inbound_messages_org_idx
  ON inbound_messages (organization_id, received_at DESC);

ALTER TABLE inbound_messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inbound_messages: org members read own"
  ON inbound_messages FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
    )
  );

-- Edge Function inserts via service role key; no INSERT policy needed for
-- authenticated users. If direct inserts from the browser are ever required,
-- add an INSERT policy here.

-- ── inbound_attachments ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS inbound_attachments (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id    uuid        NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  message_id         uuid        NOT NULL REFERENCES inbound_messages(id) ON DELETE CASCADE,
  attachment_index   integer     NOT NULL,   -- 0-based position in Postmark Attachments array
  filename           text        NOT NULL,
  content_type       text,
  file_size_bytes    integer,
  storage_path       text        NOT NULL,   -- path inside the "documents" Storage bucket
                                             -- format: {orgId}/inbound/{messageId}/{index}-{filename}
  import_document_id uuid        REFERENCES import_documents(id) ON DELETE SET NULL,
                                             -- null  = pending review
                                             -- set   = ingested through PasteModal
  created_at         timestamptz NOT NULL DEFAULT now(),

  -- Attachment-level idempotency key. Postmark's retry payload is deterministic
  -- and the index is stable across retries. Using (message_id, attachment_index)
  -- rather than (message_id, filename) handles the edge case where two attachments
  -- in the same email share a filename, which would cause a false unique violation
  -- on the filename-based constraint.
  CONSTRAINT inbound_attachments_message_index_unique
    UNIQUE (message_id, attachment_index)
);

CREATE INDEX inbound_attachments_org_pending_idx
  ON inbound_attachments (organization_id, created_at DESC)
  WHERE import_document_id IS NULL;

CREATE INDEX inbound_attachments_message_idx
  ON inbound_attachments (message_id);

ALTER TABLE inbound_attachments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "inbound_attachments: org members read own"
  ON inbound_attachments FOR SELECT
  USING (
    organization_id IN (
      SELECT organization_id FROM organization_members WHERE user_id = auth.uid()
    )
  );

-- No direct UPDATE policy for authenticated users on inbound_attachments.
-- All field updates are routed through the mark_attachment_ingested() function
-- below, which is SECURITY DEFINER and restricts the operation to setting only
-- import_document_id. This is the database-level column restriction.

-- ── updated_at trigger for email_routing_addresses ─────────────────────────

CREATE OR REPLACE FUNCTION update_email_routing_addresses_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

CREATE TRIGGER email_routing_addresses_updated_at
  BEFORE UPDATE ON email_routing_addresses
  FOR EACH ROW EXECUTE FUNCTION update_email_routing_addresses_updated_at();

-- ── mark_attachment_ingested() — SECURITY DEFINER ─────────────────────────
--
-- This function is the ONLY way authenticated users can modify inbound_attachments.
-- It restricts the operation to setting import_document_id on a single row,
-- after verifying the caller belongs to that row's organization.
--
-- The SECURITY DEFINER + REVOKE approach is necessary because PostgreSQL RLS
-- policies cannot restrict which columns an UPDATE touches. Without this,
-- an authenticated user could craft a direct UPDATE and overwrite any column,
-- including storage_path or organization_id.
--
-- Usage (service layer):
--   await backend.rpc('mark_attachment_ingested', {
--     p_attachment_id:      '<uuid>',
--     p_import_document_id: '<uuid>',
--   })

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
  v_org_id uuid;
BEGIN
  -- Reject a null import document ID up front; callers must provide a real
  -- import_documents row before marking an attachment ingested.
  IF p_import_document_id IS NULL THEN
    RAISE EXCEPTION 'p_import_document_id cannot be null';
  END IF;

  -- Fetch the attachment's organization, confirming the row exists.
  SELECT organization_id INTO v_org_id
    FROM public.inbound_attachments
   WHERE id = p_attachment_id;

  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'attachment not found: %', p_attachment_id;
  END IF;

  -- Verify the calling user belongs to that organization.
  IF NOT EXISTS (
    SELECT 1 FROM public.organization_members
    WHERE organization_id = v_org_id
      AND user_id = auth.uid()
  ) THEN
    RAISE EXCEPTION 'permission denied';
  END IF;

  -- Verify the import document belongs to the same organization as the
  -- attachment, preventing cross-org linkage via a crafted UUID.
  IF NOT EXISTS (
    SELECT 1 FROM public.import_documents
    WHERE id              = p_import_document_id
      AND organization_id = v_org_id
  ) THEN
    RAISE EXCEPTION 'import document not found or belongs to a different organization';
  END IF;

  -- Update ONLY import_document_id, and ONLY on rows still pending (null).
  -- This prevents overwriting an already-ingested attachment.
  UPDATE public.inbound_attachments
     SET import_document_id = p_import_document_id
   WHERE id                 = p_attachment_id
     AND import_document_id IS NULL;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'attachment not found or already ingested: %', p_attachment_id;
  END IF;
END;
$$;

-- Deny all direct invocation; re-grant to authenticated only
REVOKE EXECUTE ON FUNCTION mark_attachment_ingested(uuid, uuid) FROM PUBLIC;
GRANT  EXECUTE ON FUNCTION mark_attachment_ingested(uuid, uuid) TO authenticated;

-- ── grants ─────────────────────────────────────────────────────────────────

REVOKE ALL ON email_routing_addresses FROM PUBLIC;
REVOKE ALL ON inbound_messages         FROM PUBLIC;
REVOKE ALL ON inbound_attachments      FROM PUBLIC;

GRANT SELECT, INSERT, UPDATE ON email_routing_addresses TO authenticated;
GRANT SELECT                  ON inbound_messages         TO authenticated;
-- inbound_attachments: no UPDATE grant. All writes go through
-- mark_attachment_ingested() above.
GRANT SELECT                  ON inbound_attachments      TO authenticated;
