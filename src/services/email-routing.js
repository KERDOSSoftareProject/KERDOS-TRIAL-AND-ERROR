/**
 * email-routing.js
 *
 * Service layer for Module A · Pre-Ingestion · Task 1 · Email Routing.
 *
 * This module covers three operations the browser UI needs:
 *   1. Managing routing addresses (create, list, deactivate)
 *   2. Reading the inbox (list messages with attachment counts)
 *   3. Fetching an attachment from Storage so PasteModal can open it
 *
 * The handoff to the existing import pipeline works as follows:
 *   • getAttachmentFile(organizationId, attachmentId) returns a File object.
 *   • The inbox UI passes that File to PasteModal via the initialFiles prop.
 *   • fileToText() runs in the browser during PasteModal interaction.
 *   • After a successful save, the UI calls markAttachmentIngested() to set
 *     inbound_attachments.import_document_id, completing the audit trail.
 *
 * All reads use the anon/authenticated Supabase client (RLS enforced).
 * The Edge Function uses the service role key for writes; this module never
 * needs it.
 */

import { attachmentActionBlocked } from "../utils/attachment-state.js";

// ── helpers ────────────────────────────────────────────────────────────────

async function run(promise, context) {
  const { data, error } = await promise;
  if (error) throw Object.assign(new Error(`email-routing ${context}: ${error.message}`), { cause: error });
  return data;
}

// ── routing addresses ──────────────────────────────────────────────────────

// The isolated test app may use the exact address Postmark assigns to its
// separate inbound stream. This is a public receiving address, not a secret.
// Production builds retain the branded inbound domain by default.
export const testInboundAddress = import.meta.env?.VITE_TEST_INBOUND_ADDRESS?.trim().toLowerCase() || null;

export function routingAddressError(address, assignedTestAddress = testInboundAddress) {
  const normalized = address?.trim().toLowerCase() || "";
  if (!normalized) return "Routing address is required";
  if (assignedTestAddress) {
    return normalized === assignedTestAddress.toLowerCase()
      ? null : `Routing address must be ${assignedTestAddress}`;
  }
  // Validate syntax, without hardcoding a company name or domain extension.
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) {
    return "Routing address must be a valid email address (local@domain)";
  }
  return null;
}

/**
 * Create a new routing address for an organization.
 *
 * @param {object} backend  — the Supabase client from src/backend/index.js
 * @param {string} organizationId
 * @param {{ routingAddress: string, label?: string, forwardTo?: string, vendorId?: string|null, documentType?: 'pricelist'|'invoice'|null }} opts
 * @returns {Promise<object>} the created row
 */
export async function createRoutingAddress(backend, organizationId, { routingAddress, label, forwardTo, vendorId, documentType }) {
  if (!routingAddress) throw new Error("routingAddress is required");
  const normalized = routingAddress.toLowerCase().trim();
  const addressError = routingAddressError(normalized);
  if (addressError) throw new Error(addressError);
  if (documentType !== undefined && documentType !== null
      && documentType !== "pricelist" && documentType !== "invoice") {
    throw new Error('documentType must be "pricelist", "invoice", or null');
  }
  return run(
    backend
      .from("email_routing_addresses")
      .insert({
        organization_id: organizationId,
        routing_address: normalized,
        label: label ?? null,
        forward_to: forwardTo ?? null,
        vendor_id: vendorId || null,
        document_type: documentType || null,
      })
      .select()
      .single(),
    "createRoutingAddress"
  );
}

/**
 * List all active routing addresses for an organization.
 *
 * @param {object} backend
 * @param {string} organizationId
 * @returns {Promise<object[]>}
 */
export async function listRoutingAddresses(backend, organizationId) {
  return run(
    backend
      .from("email_routing_addresses")
      .select("id, routing_address, label, forward_to, vendor_id, document_type, is_active, created_at")
      .eq("organization_id", organizationId)
      .eq("is_active", true)
      .order("created_at", { ascending: false }),
    "listRoutingAddresses"
  );
}

/** Change an address's current vendor mapping. Pending attachments use this mapping at processing time. */
export async function setRoutingAddressVendor(backend, organizationId, addressId, vendorId) {
  if (!addressId) throw new Error("addressId is required");
  return run(
    backend
      .from("email_routing_addresses")
      .update({ vendor_id: vendorId || null })
      .eq("id", addressId)
      .eq("organization_id", organizationId)
      .select("id, vendor_id")
      .single(),
    "setRoutingAddressVendor"
  );
}

/** Change the registration for future receipts; existing snapshots stay immutable. */
export async function setRoutingAddressDocumentType(backend,organizationId,addressId,documentType){
  if(!["pricelist","invoice"].includes(documentType))throw new Error("Select Price Sheet or Invoice");
  return run(backend.from("email_routing_addresses").update({document_type:documentType})
    .eq("id",addressId).eq("organization_id",organizationId).select("id, document_type").single(),
    "setRoutingAddressDocumentType");
}

/**
 * Deactivate a routing address (soft-delete).
 *
 * @param {object} backend
 * @param {string} organizationId
 * @param {string} addressId
 * @returns {Promise<void>}
 */
export async function deactivateRoutingAddress(backend, organizationId, addressId) {
  await run(
    backend
      .from("email_routing_addresses")
      .update({ is_active: false })
      .eq("id", addressId)
      .eq("organization_id", organizationId),
    "deactivateRoutingAddress"
  );
}

// ── inbox (messages + attachments) ────────────────────────────────────────

/**
 * List recent inbound messages for an organization, newest first.
 * Each row includes a count of total and pending attachments.
 *
 * @param {object} backend
 * @param {string} organizationId
 * @param {{ limit?: number, offset?: number }} [opts]
 * @returns {Promise<object[]>}
 */
export async function listMessages(backend, organizationId, { limit = 50, offset = 0 } = {}) {
  // Fetch messages
  const messages = await run(
    backend
      .from("inbound_messages")
      .select(`
        id, routing_address_id, postmark_message_id,
        sender_email, sender_name, subject, received_at,
        inbound_attachments ( id, filename, content_type, import_document_id, ingest_error, processing_status )
      `)
      .eq("organization_id", organizationId)
      .order("received_at", { ascending: false })
      .range(offset, offset + limit - 1),
    "listMessages"
  );

  // Annotate each message with attachment summary counts
  return (messages ?? []).map((msg) => {
    const atts = msg.inbound_attachments ?? [];
    return {
      ...msg,
      attachment_count: atts.length,
      // Count the same attachments for which AttachmentRow offers a manual
      // action. Processing and imported rows are not yet actionable; a linked
      // partial remains actionable after recovery resets its status to pending.
      pending_count: atts.filter((a) => !attachmentActionBlocked(a)).length,
    };
  });
}

/**
 * Get a single message with its full attachment list.
 *
 * @param {object} backend
 * @param {string} organizationId
 * @param {string} messageId
 * @returns {Promise<object|null>}
 */
export async function getMessage(backend, organizationId, messageId) {
  const row = await run(
    backend
      .from("inbound_messages")
      .select(`
        id, routing_address_id, postmark_message_id,
        sender_email, sender_name, subject, body_text, received_at,
        inbound_attachments (
          id, filename, content_type, file_size_bytes,
          storage_path, import_document_id, ingest_error, processing_status, created_at
        )
      `)
      .eq("organization_id", organizationId)
      .eq("id", messageId)
      .maybeSingle(),
    "getMessage"
  );
  return row;
}

/**
 * List all pending (not yet ingested) attachments across an organization.
 * Useful for a "pending review" badge or queue view.
 *
 * @param {object} backend
 * @param {string} organizationId
 * @returns {Promise<object[]>}
 */
export async function listPendingAttachments(backend, organizationId) {
  // Query a superset, then use the same action decision as AttachmentRow.
  // A recovered partial can be linked to a document while its status is
  // pending; filtering only on a null document or needs_review hides it.
  const rows = await run(
    backend
      .from("inbound_attachments")
      .select(`
        id, message_id, filename, content_type, file_size_bytes,
        storage_path, ingest_error, created_at,
        import_document_id, processing_status,
        inbound_messages ( sender_email, sender_name, subject, received_at )
      `)
      .eq("organization_id", organizationId)
      .or("import_document_id.is.null,processing_status.eq.needs_review,processing_status.eq.pending,processing_status.eq.failed")
      .order("created_at", { ascending: false }),
    "listPendingAttachments"
  );
  return (rows ?? []).filter((a) => !attachmentActionBlocked(a));
}

// ── attachment handoff to PasteModal ──────────────────────────────────────

/**
 * Download an inbound attachment from Storage and return it as a File
 * object ready for PasteModal.
 *
 * The caller opens PasteModal with initialFiles={[file]}. fileToText() runs
 * in the browser during the interaction; vendor selection is still required.
 *
 * @param {object} backend          — Supabase client
 * @param {string} organizationId
 * @param {string} attachmentId
 * @returns {Promise<File>}
 */
export async function getAttachmentFile(backend, organizationId, attachmentId) {
  // 1. Load the attachment row to get storage_path and filename
  const att = await run(
    backend
      .from("inbound_attachments")
      .select("filename, content_type, storage_path, ingest_error")
      .eq("organization_id", organizationId)
      .eq("id", attachmentId)
      .single(),
    "getAttachmentFile/select"
  );

  // Permanently failed attachments have no Storage file to fetch.
  if (att.ingest_error) {
    throw new Error(`Cannot retrieve attachment: ${att.ingest_error}`);
  }
  if (!att.storage_path) {
    throw new Error("Attachment has no storage path");
  }

  // 2. Create a signed URL valid for 60 seconds
  const { data: signed, error: signErr } = await backend.storage
    .from("documents")
    .createSignedUrl(att.storage_path, 60);

  if (signErr) {
    throw Object.assign(
      new Error(`email-routing getAttachmentFile/sign: ${signErr.message}`),
      { cause: signErr }
    );
  }

  // 3. Fetch the raw bytes
  const response = await fetch(signed.signedUrl);
  if (!response.ok) {
    throw new Error(`email-routing getAttachmentFile/fetch: HTTP ${response.status}`);
  }

  const blob = await response.blob();

  // 4. Wrap in a File object so fileToText() and handleDroppedFiles() accept it
  return new File([blob], att.filename, {
    type: att.content_type || "application/octet-stream",
  });
}

/**
 * Mark an attachment as ingested by linking it to an import_documents row.
 * Call this after the user completes the PasteModal flow and saveImport()
 * returns an import document id.
 *
 * Uses the mark_attachment_ingested() SECURITY DEFINER database function rather
 * than a direct UPDATE. The function restricts the operation to setting only
 * import_document_id and validates org membership via auth.uid() — this is the
 * database-level column restriction Dino required.
 *
 * @param {object} backend
 * @param {string} organizationId   — kept for API consistency; org check is in the DB function
 * @param {string} attachmentId
 * @param {string} importDocumentId
 * @returns {Promise<void>}
 */
/**
 * @param {string|null} [finalStatus]  — optional terminal processing_status to set atomically
 *   with the import_document_id link.  Accepted values: 'auto_imported', 'needs_review', null.
 *   Pass 'auto_imported' when the user successfully completed a PasteModal review so the
 *   attachment clears from the pending queue.  Omit (or pass null) to leave processing_status
 *   unchanged — used by the audit-retry path which only needs to re-link the document id.
 */
export async function markAttachmentIngested(backend, organizationId, attachmentId, importDocumentId, finalStatus = null) {
  await run(
    backend.rpc("mark_attachment_ingested", {
      p_attachment_id:      attachmentId,
      p_import_document_id: importDocumentId,
      p_final_status:       finalStatus,
    }),
    "markAttachmentIngested"
  );
}

/** Atomically reserve an attachment for manual review before opening PasteModal.
 * A pending automatic worker and the user compete for the same database row lock.
 * Only one can change the state; a running worker returns false.
 */
export async function beginManualAttachmentReview(backend, organizationId, attachmentId) {
  return run(
    backend.rpc("begin_manual_attachment_review", {
      p_organization_id: organizationId,
      p_attachment_id: attachmentId,
    }),
    "beginManualAttachmentReview"
  );
}
