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
import { prepareAutomaticInvoice } from "../../../src/core/automatic-invoice.js";
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

// ── Document classification ──────────────────────────────────────────────────

/**
 * Classify a document as pricelist or invoice based on routing registration
 * intent and content detection. Pure — no I/O. Exported for unit tests.
 *
 * Registration (documentType) is authoritative when present. Content detection
 * (contentKind from parseDocument) is the fallback only for unregistered
 * addresses. Unregistered invoice content goes to review rather than
 * auto-importing, because the routing address owner has not confirmed vendor
 * and type — a content guess alone is not sufficient authority for ingestion.
 *
 * Decision matrix:
 *   documentType = 'pricelist'  → { isInvoice: false, earlyExit: null }
 *   documentType = 'invoice'    → { isInvoice: true,  earlyExit: null }  (A1.2.g)
 *   documentType = null, contentKind = 'pricelist' → { isInvoice: false, earlyExit: null }
 *   documentType = null, contentKind = 'invoice'   → earlyExit needs_review
 *   documentType = null, contentKind = other/null  → earlyExit needs_review
 *
 * @param {string|null} documentType  — receipt_document_type from routing registration
 * @param {string|null} contentKind   — documentKind returned by parseDocument
 * @returns {{ isInvoice: boolean, earlyExit: null }
 *          | { isInvoice: null, earlyExit: { status: string, reason: string } }}
 */
export function classifyDocument(documentType, contentKind) {
  // Registration is authoritative: use it when present.
  if ((documentType === "pricelist" && ["invoice","mixed"].includes(contentKind)) ||
      (documentType === "invoice" && ["pricelist","mixed"].includes(contentKind)))
    return {isInvoice:null,earlyExit:{status:"needs_review",reason:"Document content conflicts with the registered receiving address type."}};
  if (documentType === "pricelist") return { isInvoice: false, earlyExit: null };
  if (documentType === "invoice")   return { isInvoice: true,  earlyExit: null };

  // No registration — fall back to content detection.
  if (contentKind === "pricelist") return { isInvoice: false, earlyExit: null };

  // Unregistered invoice or ambiguous content → manual review.
  // Automatic invoice ingestion (A1.2.g) requires a registered address;
  // unregistered invoices need a human to confirm vendor and document type.
  const reason = contentKind === "invoice"
    ? "Document content appears to be an invoice but the routing address has no document_type registration — manual review required to confirm vendor and document type. Set document_type on the routing address for automatic ingestion."
    : "Document type could not be determined — no routing registration and content detection was inconclusive. Set document_type on the routing address and reprocess.";
  return { isInvoice: null, earlyExit: { status: "needs_review", reason } };
}

// ── Main export ──────────────────────────────────────────────────────────────

/**
 * @param {ReturnType<import("./service-backend.mjs").createServiceBackend>} backend
 * @param {object} attachment  — row from inbound_attachments (with vendorId attached by caller)
 * @param {object} options
 * @param {string} options.organizationId
 * @param {string} options.vendorId
 * @param {string|null} [options.documentType]  — 'pricelist' | 'invoice' | null
 *   Captured at receipt time from the routing address registration. When present
 *   it is used as the authoritative document classification and parseDocument's
 *   content-based guess is ignored. When null (address had no document_type when
 *   the message arrived) we fall back to content detection and send to review if
 *   the content-detected kind is not clearly a pricelist.
 */
export async function processAttachmentInBackground(backend, attachment, { organizationId, vendorId, documentType = null }) {
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
  let rawText;
  try {
    if (readResult.kind === "lines") {
      rawText = readResult.lines.join("\n");
      parsed = parseDocument(rawText);
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
      rawText = csvText;
      parsed = parseDocument(rawText);
    }
  } catch (err) {
    await backend.attachments.setStatus(attachmentId, "needs_review",
      `Could not parse document: ${err.message}`);
    return { outcome: "needs_review", reason: err.message };
  }

  // parseDocument returns { rows, documentKind, quoteValidUntil, ... }.
  // Wrap into the single-group shape the import loop below expects.
  const { rows: parsedRows = [], documentKind: contentKind, quoteValidUntil: parsedQuoteValidUntil } = parsed;

  // ── Step 4: classify document using registration intent ──────────────────
  //
  // documentType is the value captured at receipt time from the routing address
  // registration — the single authoritative source for what this address receives.
  // Content-based detection (contentKind from parseDocument) is the fallback only
  // when the address had no document_type when the message arrived.
  //
  // When isInvoice is true after classifyDocument, documentType === 'invoice'
  // (the registration was explicit). Content-detected invoices from unregistered
  // addresses produce earlyExit=needs_review to protect against mis-classification.

  const { isInvoice, earlyExit } = classifyDocument(documentType, contentKind);

  if (earlyExit) {
    await backend.attachments.setStatus(attachmentId, earlyExit.status, earlyExit.reason);
    return { outcome: earlyExit.status, reason: earlyExit.reason };
  }

  const groups = parsedRows.length > 0
    ? [{ rows: parsedRows, quoteValidUntil: parsedQuoteValidUntil }]
    : [];

  // Invoice header, lines, original link and terminal status commit together.
  // A worker crash before commit writes nothing; after commit replay is idempotent.
  if (isInvoice) {
    const service = createImportService(backend);
    const vendorItems = await service.vendorItems(organizationId, vendorId);
    const prepared = prepareAutomaticInvoice({text:rawText,rows:parsedRows,organizationId,vendorId,vendorItems});
    if (prepared.reason) {
      await backend.attachments.setStatus(attachmentId, "needs_review", prepared.reason);
      return {outcome:"needs_review",reason:prepared.reason};
    }
    await backend.invoices.recordAutomatic({attachmentId,fingerprint:makeFingerprint(attachment),
      header:{...prepared.header,file_name:filename,file_path:storagePath},lines:prepared.lines});
    return {outcome:"auto_imported"};
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
      file_name:        filename,
      file_path:        storagePath,
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
      backend.attachments.assertLease?.();
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
        backend.attachments.assertLease?.();

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
        if (String(err?.message).includes("LEASE_LOST")) throw err;
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
