/**
 * attachment-processor.mjs
 *
 * Pure ES module — no Deno-specific or Node-specific imports.
 * Exported by the inbound-email Edge Function AND imported directly
 * by the test suite, so tests exercise the real production logic.
 *
 * Design
 * ──────
 * processAttachments() THROWS on any transient error (Storage or DB).
 * The caller wraps it in try/catch and returns HTTP 500, causing
 * Postmark to retry.  Permanent errors (malformed base64) are recorded
 * as visible ingest_error rows so the inbox UI can show the failure.
 *
 * A1.2.e handoff (Gap 4)
 * ──────────────────────
 * After storing the row, this module awaits the process-attachment result.
 * A dispatch failure throws to inbound-email, which responds 500 so Postmark
 * retries. The existing-row path re-dispatches pending rows on that retry.
 *
 * Idempotency key
 * ───────────────
 * Each attachment is identified by (message_id, attachment_index),
 * where attachment_index is the 0-based position in the Postmark
 * Attachments array.  Using the index rather than filename means two
 * attachments with the same name in one email are handled correctly.
 *
 * Storage path
 * ────────────
 * {orgId}/inbound/{messageId}/{attachmentIndex}
 * The original filename is kept in the database row only; the Storage
 * path uses only the stable index so an external filename is never part
 * of the Storage key.
 *
 * Storage "already exists" handling
 * ──────────────────────────────────
 * A 409 from Storage means a prior request already uploaded the file.
 * We then re-check the DB:
 *   • DB row present  → fully processed; skip.
 *   • DB row absent   → the prior request crashed between Storage upload
 *                       and DB insert (orphaned object).  RECOVER by
 *                       inserting the DB row using the deterministic
 *                       storagePath — no re-upload needed.
 *
 * Malformed base64 handling
 * ─────────────────────────
 * If Postmark sends an attachment whose Content field cannot be decoded,
 * an inbound_attachments row is inserted with storage_path = null and
 * ingest_error set to the decode error message.  This makes the failure
 * visible in the inbox UI rather than silently losing the attachment.
 * 23505 on that insert is silently skipped (prior decode-error record).
 * Any other insert error triggers ONE retry; if the retry also fails
 * (with a non-23505 code) the function THROWS so Postmark retries the
 * entire webhook and gets another chance to record the failure row.
 */

import { isDispatchable, VALID_OUTCOMES } from "./attachment-state.mjs";

// ── base64 decode ──────────────────────────────────────────────────────────

export function base64ToBytes(b64) {
  // Postmark may break Content into multiple lines; strip whitespace.
  const clean = b64.replace(/\s/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

// ── helpers ────────────────────────────────────────────────────────────────

function isAlreadyExistsError(err) {
  if (!err) return false;
  if (err.statusCode === 409 || err.statusCode === "409") return true;
  const msg = (err.message || "").toLowerCase();
  return msg.includes("already exists") || msg.includes("duplicate");
}

// ── processAttachments ─────────────────────────────────────────────────────

/**
 * Store each attachment that is not already recorded.
 *
 * @param {object} backend        — Supabase client (service role) or mock
 * @param {string} organizationId
 * @param {string} messageId      — UUID of the inbound_messages row
 * @param {Array}  attachments    — Postmark Attachments array
 *
 * @throws {Error} on any transient failure so the caller returns HTTP 500
 *                 and Postmark retries.
 */
export async function processAttachments(backend, organizationId, messageId, attachments) {
  for (let attachmentIndex = 0; attachmentIndex < attachments.length; attachmentIndex++) {
    const att = attachments[attachmentIndex];
    const filename = att.Name || "attachment";
    // Gap D: stable Storage key uses only the index; filename lives in the DB row.
    const storagePath = `${organizationId}/inbound/${messageId}/${attachmentIndex}`;

    // ── 1. Idempotency: skip if DB row already present ───────────────────
    const { data: existingAtt, error: existsErr } = await backend
      .from("inbound_attachments")
      .select("id, processing_status, ingest_error, storage_path")
      .eq("message_id", messageId)
      .eq("attachment_index", attachmentIndex)
      .maybeSingle();

    if (existsErr) {
      throw new Error(
        `existence check failed for attachment ${attachmentIndex} (${filename}): ${existsErr.message}`
      );
    }
    if (existingAtt) {
      // A prior delivery may have stored the row but failed to launch the
      // processor. Retrying a dispatchable pending row must complete that handoff.
      if (isDispatchable(existingAtt)) {
        await triggerProcessAttachment(backend, organizationId, existingAtt.id, filename, attachmentIndex);
      }
      continue;
    }

    // ── 2. Decode base64 (permanent error → ingest_error row) ───────────
    let bytes;
    try {
      bytes = base64ToBytes(att.Content);
    } catch (e) {
      // Malformed base64 is permanent — retry will not help.
      // Insert a visible error row so the inbox UI can show the failure
      // instead of silently losing the attachment.
      console.error(`malformed base64 for attachment ${attachmentIndex} (${filename})`, e);

      // Build the error-row payload once; reused on retry.
      const errorRowPayload = {
        organization_id:    organizationId,
        message_id:         messageId,
        attachment_index:   attachmentIndex,
        filename,
        content_type:       att.ContentType || null,
        file_size_bytes:    att.ContentLength || null,
        storage_path:       null,   // no file stored; column nullable after addendum migration
        ingest_error:       `base64 decode failed: ${e.message}`,
        import_document_id: null,
      };

      const { error: errRowErr } = await backend
        .from("inbound_attachments")
        .insert(errorRowPayload);

      if (errRowErr && errRowErr.code !== "23505") {
        // Gap A: transient DB error — retry once so a momentary blip does not
        // silently lose the failure record.  If the retry also fails, throw so
        // Postmark retries the whole webhook and gets another chance to record it.
        const { error: retryErr } = await backend
          .from("inbound_attachments")
          .insert(errorRowPayload);
        if (retryErr && retryErr.code !== "23505") {
          throw new Error(
            `could not record decode error for attachment ${attachmentIndex} (${filename}): ${retryErr.message}`
          );
        }
      }
      continue;
    }

    // ── 3. Upload to Storage ─────────────────────────────────────────────
    const { error: uploadErr } = await backend.storage
      .from("documents")
      .upload(storagePath, bytes, {
        contentType: att.ContentType || "application/octet-stream",
        upsert: false,
      });

    if (uploadErr) {
      if (isAlreadyExistsError(uploadErr)) {
        // File exists in Storage — check whether the DB row also landed.
        const { data: raceRow, error: raceErr } = await backend
          .from("inbound_attachments")
          .select("id")
          .eq("message_id", messageId)
          .eq("attachment_index", attachmentIndex)
          .maybeSingle();

        if (raceErr) {
          throw new Error(
            `re-check after storage conflict failed for attachment ${attachmentIndex} (${filename}): ${raceErr.message}`
          );
        }
        if (raceRow) {
          await triggerProcessAttachment(backend, organizationId, raceRow.id, filename, attachmentIndex);
          continue;
        }

        // Orphaned Storage object: prior request crashed after uploading
        // but before writing the DB row.  Recover by inserting the row now;
        // storagePath is deterministic so we know exactly where the file is.
        const { data: recoveredRow, error: recoverErr } = await backend
          .from("inbound_attachments")
          .insert({
            organization_id:  organizationId,
            message_id:       messageId,
            attachment_index: attachmentIndex,
            filename,
            content_type:     att.ContentType || null,
            file_size_bytes:  att.ContentLength || bytes.length,
            storage_path:     storagePath,
            import_document_id: null,
          })
          .select("id")
          .single();
        if (recoverErr) {
          if (recoverErr.code === "23505") {
            const { data: winner, error: winnerErr } = await backend.from("inbound_attachments")
              .select("id").eq("message_id", messageId)
              .eq("attachment_index", attachmentIndex).maybeSingle();
            if (winnerErr || !winner) throw new Error(`recovery winner lookup failed: ${winnerErr?.message ?? "missing row"}`);
            await triggerProcessAttachment(backend, organizationId, winner.id, filename, attachmentIndex);
            continue;
          }
          throw new Error(
            `recovery insert failed for attachment ${attachmentIndex} (${filename}): ${recoverErr.message}`
          );
        }
        // Recovery succeeded — fire process-attachment for this recovered row
        if (!recoveredRow?.id) throw new Error("recovery insert returned no attachment ID");
        await triggerProcessAttachment(backend, organizationId, recoveredRow.id, filename, attachmentIndex);
        continue;
      }

      // Any other upload error is transient — throw so Postmark retries.
      throw new Error(
        `storage upload failed for attachment ${attachmentIndex} (${filename}): ${uploadErr.message}`
      );
    }

    // ── 4. Write DB row ──────────────────────────────────────────────────
    const { data: newRow, error: attErr } = await backend
      .from("inbound_attachments")
      .insert({
        organization_id:  organizationId,
        message_id:       messageId,
        attachment_index: attachmentIndex,
        filename,
        content_type:     att.ContentType || null,
        file_size_bytes:  att.ContentLength || bytes.length,
        storage_path:     storagePath,
        import_document_id: null,
      })
      .select("id")
      .single();

    if (attErr) {
      if (attErr.code === "23505") {
        // Concurrent retry inserted the row after our existence check
        // passed. Fetch the winner so its pending handoff can be retried.
        const { data: winner, error: winnerErr } = await backend.from("inbound_attachments")
          .select("id").eq("message_id", messageId)
          .eq("attachment_index", attachmentIndex).maybeSingle();
        if (winnerErr || !winner) throw new Error(`insert winner lookup failed: ${winnerErr?.message ?? "missing row"}`);
        await triggerProcessAttachment(backend, organizationId, winner.id, filename, attachmentIndex);
        continue;
      }
      throw new Error(
        `insert failed for attachment ${attachmentIndex} (${filename}): ${attErr.message}`
      );
    }

    // ── 5. Confirm the processing handoff before acknowledging Postmark ──
    if (!newRow?.id) throw new Error("attachment insert returned no ID");
    await triggerProcessAttachment(backend, organizationId, newRow.id, filename, attachmentIndex);
  }
}

// ── triggerProcessAttachment ──────────────────────────────────────────────────
//
// The invocation is awaited. An error reaches inbound-email's 500 response,
// allowing Postmark to retry the existing attachment's pending handoff.

async function triggerProcessAttachment(backend, organizationId, attachmentId, filename, attachmentIndex) {
  // Supabase client or a test mock must expose functions.invoke.
  const invoke = backend?.functions?.invoke;
  if (typeof invoke !== "function") throw new Error("process-attachment invocation is unavailable");

  const { data, error } = await invoke.call(backend.functions, "process-attachment", {
    body: { attachmentId, organizationId },
  });
  if (error || !VALID_OUTCOMES.includes(data?.outcome)) {
    // A failed dispatch must not be acknowledged as a successful delivery.
    // Postmark retries, and the existing-row path above will retry the handoff.
    throw new Error(`process-attachment failed for ${attachmentIndex} (${filename}): ${error?.message ?? data?.reason ?? "unknown"}`);
  }
}
