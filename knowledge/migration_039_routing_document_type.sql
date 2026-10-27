-- migration_039_routing_document_type.sql
--
-- Records document type at routing-address registration and captures it
-- immutably on inbound_messages at receipt time.
--
-- Background
-- ──────────
-- Each routing address maps a client, vendor, AND document type. The document
-- type ('pricelist' or 'invoice') is established at registration and must not
-- be inferred from message content or address text. This migration adds the
-- column and captures the value immutably on the message row at receipt, so
-- the background processor reads the registration intent, not a content guess.
--
-- Changes
-- ───────
--   1. Drop the @inbound.kerdos.com domain CHECK constraint. Routing addresses
--      now use any domain configured outside KERDOS. The constraint was a
--      deployment-time guard; the RLS policy and vendor/org FK remain.
--
--   2. email_routing_addresses.document_type ('pricelist' | 'invoice')
--      Records the document type this address is registered to receive.
--      Nullable: existing addresses are treated as unclassified until set.
--
--   3. inbound_messages.receipt_document_type ('pricelist' | 'invoice')
--      Captured from document_type at receipt time alongside receipt_vendor_id.
--      NULL means the routing address had no document_type when the message
--      arrived. Content-detected pricelists are auto-imported;
--      content-detected invoices and ambiguous documents go to manual review.
--
--   4. Extend protect_inbound_vendor_snapshot() to cover receipt_document_type.
--      The trigger already exists; replacing the function body is sufficient.
--
-- Apply to kerdos-test ONLY. Review before applying to production.

-- ── 1. Remove hardcoded domain constraint ─────────────────────────────────

ALTER TABLE public.email_routing_addresses
  DROP CONSTRAINT IF EXISTS email_routing_addresses_inbound_domain;

-- ── 2. document_type on email_routing_addresses ────────────────────────────

ALTER TABLE public.email_routing_addresses
  ADD COLUMN IF NOT EXISTS document_type text
    CONSTRAINT email_routing_addresses_document_type_check
      CHECK (document_type IN ('pricelist', 'invoice'));

-- Index: find all price-sheet or invoice addresses for an org quickly.
CREATE INDEX IF NOT EXISTS email_routing_addresses_doc_type_idx
  ON public.email_routing_addresses (organization_id, document_type)
  WHERE document_type IS NOT NULL AND is_active = true;

-- ── 3. receipt_document_type on inbound_messages ──────────────────────────

ALTER TABLE public.inbound_messages
  ADD COLUMN IF NOT EXISTS receipt_document_type text
    CONSTRAINT inbound_messages_receipt_document_type_check
      CHECK (receipt_document_type IN ('pricelist', 'invoice'));

-- ── 4. Extend the immutable snapshot trigger ──────────────────────────────
--
-- The trigger (inbound_messages_vendor_snapshot_immutable) already exists and
-- fires on UPDATE of inbound_messages. Replacing the function body is
-- sufficient — PostgreSQL resolves the function at fire time.
--
-- After this change the trigger rejects any mutation of:
--   • receipt_vendor_id
--   • vendor_snapshot_at
--   • receipt_document_type   ← new

CREATE OR REPLACE FUNCTION public.protect_inbound_vendor_snapshot()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF NEW.receipt_vendor_id IS DISTINCT FROM OLD.receipt_vendor_id
     OR NEW.vendor_snapshot_at IS DISTINCT FROM OLD.vendor_snapshot_at
     OR NEW.receipt_document_type IS DISTINCT FROM OLD.receipt_document_type THEN
    RAISE EXCEPTION 'receipt-time vendor/document snapshot cannot be changed after insertion';
  END IF;
  RETURN NEW;
END;
$$;

-- Verify the trigger exists (it was created by migration_038).
-- If it does not exist in the target environment, create it now.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_trigger
     WHERE tgrelid = 'public.inbound_messages'::regclass
       AND tgname  = 'inbound_messages_vendor_snapshot_immutable'
  ) THEN
    CREATE TRIGGER inbound_messages_vendor_snapshot_immutable
      BEFORE UPDATE ON public.inbound_messages
      FOR EACH ROW EXECUTE FUNCTION public.protect_inbound_vendor_snapshot();
  END IF;
END;
$$;
