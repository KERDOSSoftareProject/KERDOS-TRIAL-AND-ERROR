/**
 * background-import.mjs
 *
 * Orchestrates automatic processing of a single inbound attachment.
 * Reuses the three-part engine (Interpret → Compare → Decide) unchanged:
 *   Interpret  — readAttachment + parseDocument (ingestion.js)
 *   Compare    — preparePriceImport / importPriceRow (core/)
 *   Decide     — kerdos_auto_apply_price_quote (via service-backend.mjs)
 *
 * Called by index.ts once per attachment after inbound-email stores bytes.
 *
 * Contract:
 *   processAttachmentInBackground(backend, attachment, options)
 *   → Promise<{ outcome: "auto_imported" | "needs_review" | "failed", reason?: string }>
 *
 * The function updates inbound_attachments.processing_status itself via
 * backend.attachments.setStatus so the caller only needs to await it.
 * On Postmark retry (transient error) it throws — Postmark retries are
 * the recovery mechanism, so the attachment remains in 'processing' state
 * and the retry will reclaim it (claim() check is in index.ts).
 */

import { readAttachment, FileReadError } from "./portable-file-reader.mjs";
import { createImportService } from "../../../src/services/imports.js";
import { createCatalogService } from "../../../src/services/catalog.js";
import { importPriceRow } from "../../../src/core/import-price-row.js";

// Portable ingestion: zero browser APIs (confirmed by audit).
import { parseDocument } from "../../../src/ingestion.js";

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Unwrap a {data, error} result from createRecords and return the rows.
 * Mirrors the run() helper in imports.js — used for the ad-hoc catalog/
 * categories/mappings queries that are not routed through the service layer.
 */
async function runQuery(promise, context) {
  const { data, error } = await promise;
  if (error) throw new Error(`background-import ${context}: ${error.message}`);
  return data ?? [];
}

function iso(date) {
  return (date instanceof Date ? date : new Date(date)).toISOString();
}

/**
 * Return a fingerprint string for the file.  Mirrors ImportModal's logic:
 * use the file's size as an approximation when there is no hash available.
 * For background processing we don't have the raw file reference, so we
 * use a combination of storage_path + file_size_bytes which is stable
 * across retries.
 */
function makeFingerprint(attachment) {
  return `${attachment.storage_path}:${attachment.file_size_bytes}`;
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * @param {ReturnType<import("./service-backend.mjs").createServiceBackend>} backend
 * @param {object} attachment  — row from inbound_attachments (with vendorId attached by caller)
 * @param {object} options
 * @param {string} options.organizationId
 * @param {string} options.vendorId
 */
export async function processAttachmentInBackground(backend, attachment, { organizationId, vendorId }) {
  // Defense-in-depth: index.ts validates vendorId at the HTTP layer, but this
  // function must not silently process unrouted attachments if called directly.
  if (!vendorId) {
    throw new Error("vendorId is required — a vendor must be assigned to the routing address before processing");
  }

  const { id: attachmentId, filename, content_type: mimeType, storage_path: storagePath } = attachment;

  // ── Step 1: download bytes ─────────────────────────────────────────────────
  let bytes;
  try {
    bytes = await backend.attachments.download(storagePath);
  } catch (err) {
    // Storage download failure is transient (network issue, temporary outage).
    // Throw so Postmark retries.
    throw new Error(`Storage download failed for attachment ${attachmentId}: ${err.message}`);
  }

  // ── Step 2: read file ──────────────────────────────────────────────────────
  let readResult;
  try {
    readResult = await readAttachment(bytes, mimeType, filename);
  } catch (err) {
    if (err instanceof FileReadError) {
      // Permanent: corrupt or unreadable file.
      await backend.attachments.setStatus(attachmentId, "needs_review",
        `File could not be read: ${err.message}`);
      return { outcome: "needs_review", reason: err.message };
    }
    throw err; // unexpected — let it propagate for retry
  }

  if (readResult.kind === "unsupported") {
    await backend.attachments.setStatus(attachmentId, "needs_review",
      `Unsupported file type: ${readResult.mimeType || "unknown"} (${filename})`);
    return { outcome: "needs_review", reason: `Unsupported type: ${readResult.mimeType}` };
  }

  // ── Step 3: parse document into structured rows ────────────────────────────
  // parseDocument(text, options) from src/ingestion.js takes a plain string.
  // Returns { mode, rows, skipped, documentKind, quoteValidUntil, headerFound, columnMap }.
  // It does NOT return { groups, invoiceRows } — those are ImportModal constructs.
  //
  // For "lines" (PDF/text): join the lines array into a single string.
  // For "sheets" (CSV/XLSX): convert the first sheet's string[][] back to CSV text.

  let parsed;
  try {
    if (readResult.kind === "lines") {
      parsed = parseDocument(readResult.lines.join("\n"));
    } else {
      // kind === "sheets": use the first non-empty sheet
      const firstSheet = readResult.sheets.find(s => s.rows.length > 0);
      if (!firstSheet) {
        await backend.attachments.setStatus(attachmentId, "needs_review",
          "Spreadsheet contained no data rows");
        return { outcome: "needs_review", reason: "Empty spreadsheet" };
      }
      // Convert string[][] → CSV text so parseDocument receives a string.
      const csvText = firstSheet.rows.map(row =>
        row.map(cell => {
          const s = String(cell ?? "");
          if (s.includes(",") || s.includes('"') || s.includes("\n") || s.includes("\r")) {
            return '"' + s.replace(/"/g, '""') + '"';
          }
          return s;
        }).join(",")
      ).join("\n");
      parsed = parseDocument(csvText);
    }
  } catch (err) {
    await backend.attachments.setStatus(attachmentId, "needs_review",
      `Could not parse document: ${err.message}`);
    return { outcome: "needs_review", reason: err.message };
  }

  // parseDocument returns { rows, documentKind, quoteValidUntil, ... }.
  // Wrap into the single-group shape the import loop below expects.
  const { rows: parsedRows = [], documentKind, quoteValidUntil: parsedQuoteValidUntil } = parsed;
  const isInvoice = documentKind === "invoice";
  const groups = parsedRows.length > 0
    ? [{ rows: parsedRows, quoteValidUntil: parsedQuoteValidUntil }]
    : [];

  // ── Step 4: decide whether auto-import is safe ────────────────────────────
  // Invoices always go to review (human must confirm quantities and totals).
  if (isInvoice) {
    await backend.attachments.setStatus(attachmentId, "needs_review",
      "Document appears to be an invoice — human review required");
    return { outcome: "needs_review", reason: "Invoice document" };
  }

  if (groups.length === 0) {
    await backend.attachments.setStatus(attachmentId, "needs_review",
      "No structured price rows found in document");
    return { outcome: "needs_review", reason: "No price rows found" };
  }

  // Any row that preparePriceImport marks requiresReview triggers a full
  // needs_review outcome; we detect this during the import pass below.

  // ── Step 5: create/resume import document ─────────────────────────────────
  const importService = createImportService(backend);
  const catalogService = createCatalogService(backend);

  const fingerprint = makeFingerprint(attachment);
  const importBatchTime = iso(new Date());

  let existingDoc;
  try {
    existingDoc = await importService.findPriceDocument({
      organizationId, vendorId, fingerprint,
    });
  } catch (err) {
    throw new Error(`Could not check for duplicate import: ${err.message}`);
  }

  if (existingDoc?.status === "complete") {
    // Duplicate delivery — already fully processed.
    await backend.attachments.setStatus(
      attachmentId, "auto_imported", null, existingDoc.id
    );
    return { outcome: "auto_imported" };
  }

  let documentId;
  if (existingDoc) {
    documentId = existingDoc.id;
  } else {
    const newDoc = await importService.createPriceDocument({
      organization_id:  organizationId,
      vendor_id:        vendorId,
      document_kind:    "pricelist",
      fingerprint,
      filename:         filename,
      source_path:      storagePath,
      status:           "processing",
    });
    documentId = newDoc.id;
  }

  // Resume support: collect already-completed row keys.
  const completedRows = existingDoc?.completed_keys
    ? new Set(existingDoc.completed_keys)
    : new Set();

  // Load pre-import data snapshots the same way the browser ImportModal does.
  const [
    workingVendorItems,
    workingCatalogItems,
    workingCategories,
    workingMappings,
    invoiceSources,
  ] = await Promise.all([
    importService.vendorItems(organizationId, vendorId),
    runQuery(backend.records.query("catalog_items").select("*").eq("organization_id", organizationId), "catalog_items"),
    runQuery(backend.records.query("catalog_categories").select("*").eq("organization_id", organizationId), "catalog_categories"),
    runQuery(backend.records.query("item_mappings").select("*").eq("organization_id", organizationId), "item_mappings"),
    importService.invoiceSources(organizationId, vendorId),
  ]);

  // ── Step 6: run the import engine row by row ───────────────────────────────
  const newCompletedKeys = [...completedRows];
  let needsReview = false;
  let reviewReason = null;
  let failedCount = 0;

  // A1.7.b: use row:N (0-based across all groups) as the completedKey so the
  // format matches ImportModal's progressKey = index => `row:${index}`.
  //
  // This alignment is required for three reasons:
  //   1. import_documents.completed_keys must use the same key format so
  //      PasteModal's completedKeys.has(`row:${index}`) skips already-saved rows.
  //   2. verifyResumeRows() expects keys matching /^row:(\d+)$/ and maps them
  //      back to row positions; non-matching keys cause it to throw on resume.
  //   3. kerdos_auto_apply_price_quote stores rowKey as price_history.source_row_key
  //      for the ON CONFLICT DO NOTHING idempotency guard; consistent keys ensure
  //      a user PasteModal retry for the same row hits ON CONFLICT rather than
  //      inserting a duplicate price_history row.
  let globalRowIndex = 0;

  for (const group of groups) {
    for (const sourceRow of group.rows) {
      const completedKey = `row:${globalRowIndex}`;
      globalRowIndex++;
      if (completedRows.has(completedKey)) continue; // already saved (resume)

      // Find existing vendor item for this row's code.
      const ex = workingVendorItems.find(
        v => v.vendor_item_code === sourceRow.code
      ) || null;
      const priorMapping = ex
        ? workingMappings.find(m => m.vendor_item_id === ex.id) || null
        : null;

      // preparePriceImport (via importPriceRow) decides requiresReview.
      // We pass rowNeedsReview=false; if the row needs review the function
      // returns {needsBasis:true} and we surface the whole document.
      try {
        const result = await importPriceRow({
          backend,
          importService,
          catalogService,
          sourceRow,
          row: sourceRow,
          ex,
          priorMapping,
          rowIssues: [],
          rowNeedsReview: false,   // let the engine decide
          invoiceSources,
          orgId: organizationId,
          vendorId,
          sourceDocumentId: documentId,
          completedKey,
          importBatchTime,
          group,
          sourceFilePath: storagePath,
          workingCatalogItems,
          workingCategories,
          workingVendorItems,
          workingMappings,
          applySelectedCategory: null,
        });

        if (result.needsBasis) {
          // Row requires human input — entire document goes to review.
          needsReview = true;
          reviewReason = "One or more rows require human review (basis or conflict)";
          break;
        }

        newCompletedKeys.push(completedKey);

        // Record progress periodically (every 50 rows) so a crash is resumable.
        if (newCompletedKeys.length % 50 === 0) {
          await importService.recordProgress(documentId, newCompletedKeys);
        }

      } catch (err) {
        // Any single-row save failure prevents a "complete" result — silently
        // omitting products from a background import is worse than surfacing the
        // document for human review.
        failedCount++;
        needsReview = true;
        reviewReason = `Row save error (row ${failedCount}): ${err.message}`;
        break;
      }
    }
    if (needsReview) break;
  }

  // ── Step 7: finalize ────────────────────────────────────────────────────────
  if (needsReview) {
    // Import document status must be 'partial' — the import_documents.status
    // column only accepts ('processing','complete','partial').  'needs_review'
    // is the attachment's status (inbound_attachments.processing_status), not
    // the document's.  Using 'partial' here means: rows were saved up to the
    // point of the review trigger; the rest were not processed.
    await importService.finalizeDocument(documentId, "partial", newCompletedKeys);
    // Pass documentId so the partially-created import document is linked to the
    // attachment.  Migration 033's set_attachment_processing_status allows
    // p_import_document_id when p_status = 'needs_review'.
    await backend.attachments.setStatus(attachmentId, "needs_review", reviewReason, documentId);
    return { outcome: "needs_review", reason: reviewReason };
  }

  await importService.finalizeDocument(documentId, "complete", newCompletedKeys);
  await backend.attachments.setStatus(attachmentId, "auto_imported", null, documentId);
  return { outcome: "auto_imported" };
}
