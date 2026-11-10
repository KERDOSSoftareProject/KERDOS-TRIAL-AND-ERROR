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
import { importPriceRow, MISSING_DESCRIPTION } from "../../../src/core/import-price-row.js";
import { readInvoiceEvidence } from "../../../src/core/invoice-evidence.js";
import { createProcurementContext } from "../../../src/procurement.js";
import { createSourceRowSnapshot, hasWorksheetSnapshot, LEGACY_WORKBOOK_REVIEW, verifyResumeRows } from "../../../src/core/import-resume.js";
import { findUncodedVendorListing } from "../../../src/core/vendor-listing.js";
import { nonemptyWorkbookSheets, parseStructuredDocument } from "../../../src/core/document-structuring.js";
import { isSourceMetadataHeader } from "../../../src/core/source-metadata.js";

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
  return data;
}

async function loadOrganizationRows(backend, table, organizationId) {
  const rows = [];
  const pageSize = 500;
  for (let offset = 0; ; offset += pageSize) {
    const page = await runQuery(backend.records.query(table).select("*")
      .eq("organization_id", organizationId).order("id").range(offset, offset + pageSize - 1), table);
    if (!Array.isArray(page)) throw new Error(`background-import ${table}: missing rows`);
    rows.push(...page);
    if (page.length < pageSize) return rows;
  }
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

function workbookSheetText(rows) {
  return rows.map(row=>row.map(cell=>{
    const text=String(cell??"");
    return /[,"\r\n]/.test(text)?'"'+text.replace(/"/g,'""')+'"':text;
  }).join(",")).join("\n");
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
    readResult = await readAttachment(bytes, mimeType, filename,{imageTextReader:backend.attachments.extractImageText,pdfTextReader:backend.attachments.extractPdfText});
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

  let procurement;
  try {
    const [organization,vocabulary]=await Promise.all([
      runQuery(backend.records.query("organizations").select("industry").eq("id",organizationId).maybeSingle(), "organization industry"),
      loadOrganizationRows(backend,"org_vocabulary",organizationId),
    ]);
    if(typeof organization?.industry!=="string"||!organization.industry.trim())throw new Error("Missing organization industry");
    procurement=createProcurementContext({industry:organization.industry,vocabulary});
  } catch {
    const reason="Could not load the workspace's interpretation settings. The original was retained for automatic retry.";
    await backend.attachments.setStatus(attachmentId,"pending",reason);
    return {outcome:"skipped",reason};
  }

  // ── Step 3: parse document into structured rows ────────────────────────────
  // parseDocument(text, options) from src/ingestion.js takes a plain string.
  // Returns { mode, rows, skipped, documentKind, quoteValidUntil, headerFound, columnMap }.
  // It does NOT return { groups, invoiceRows } — those are ImportModal constructs.
  //
  // For "lines" (PDF/text): join the lines array into a single string.
  // Workbooks with multiple nonempty worksheets use the shared document
  // structurer. Keep the existing single-sheet ordinals for older receipts.

  let parsed;
  let rawText;
  let structuredWorkbook=false;
  try {
    if (readResult.kind === "lines") {
      rawText = readResult.lines.join("\n");
      parsed = parseDocument(rawText,undefined,procurement);
    } else {
      const worksheets=readResult.sheets.map(sheet=>({...sheet,text:workbookSheetText(sheet.rows)}));
      const reading={kind:"workbook",filename,worksheets};
      const activeSheets=nonemptyWorkbookSheets(reading);
      const [firstSheet]=activeSheets;
      if(!firstSheet){
        await backend.attachments.setStatus(attachmentId, "needs_review",
          "Spreadsheet contained no data rows");
        return { outcome: "needs_review", reason: "Empty spreadsheet" };
      }
      structuredWorkbook=activeSheets.length>1;
      rawText=activeSheets.map(sheet=>sheet.text).join("\n");
      parsed=structuredWorkbook?parseStructuredDocument(rawText,reading,undefined,procurement):parseDocument(rawText,undefined,procurement);
    }
  } catch (err) {
    await backend.attachments.setStatus(attachmentId, "needs_review",
      `Could not parse document: ${err.message}`);
    return { outcome: "needs_review", reason: err.message };
  }

  // parseDocument returns { rows, documentKind, quoteValidUntil, ... }.
  // Wrap into the single-group shape the import loop below expects.
  const { rows: rows = [], documentKind: contentKind, quoteValidUntil: parsedQuoteValidUntil } = parsed;
  const normalLine=line=>String(line||'').trim().replace(/[,\t]/g,' ').replace(/\s+/g,' ');
  const ocrHeader=readResult.ocr?.lines.find(line=>/\b(price|cost)\b/i.test(line.text)&&/\b(description|product|item)\b/i.test(line.text));
  const parsedRows=readResult.ocr?rows.map(row=>{
    const matchingLines=readResult.ocr.lines.filter(line=>normalLine(line.text)===normalLine(row.sourceLine));
    const confidence=matchingLines.length?Math.min(...matchingLines.map(line=>line.confidence)):0;
    return {...row,ocr:{engine:readResult.ocr.engine,confidence:Math.min(ocrHeader?.confidence??0,confidence)}};
  }):rows;
  const ocrIssues=row=>row.ocr&&row.ocr.confidence<90?['Image text recognition is below 90% confidence; source fields need clarification']:[];
  const unparsedImageLines=readResult.ocr?.lines.filter(line=>line.confidence<90&&line!==ocrHeader&&!parsedRows.some(row=>normalLine(row.sourceLine)===normalLine(line.text)))||[];

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
    ? [{ name:filename,rows: parsedRows, quoteValidUntil: parsedQuoteValidUntil }]
    : [];

  // Invoice header, lines, original link and terminal status commit together.
  // A worker crash before commit writes nothing; after commit replay is idempotent.
  if (isInvoice) {
    if(structuredWorkbook){
      const reason="This invoice workbook contains multiple worksheets. Review the source to confirm which rows belong to each invoice.";
      await backend.attachments.setStatus(attachmentId,"needs_review",reason);
      return {outcome:"needs_review",reason};
    }
    const lowImageEvidence=parsedRows.some(row=>ocrIssues(row).length)||readResult.ocr?.lines.some(line=>line.confidence<90);
    if(lowImageEvidence){const reason='Invoice image text needs source clarification';await backend.attachments.setStatus(attachmentId,'needs_review',reason);return {outcome:'needs_review',reason};}
    const service = createImportService(backend);
    const vendorItems = await service.vendorItems(organizationId, vendorId);
    const prepared = await prepareAutomaticInvoice({text:rawText,rows:parsedRows,organizationId,vendorId,vendorItems,importService:service},procurement);
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

  // ── Step 5: create/resume import document ─────────────────────────────────
  const importService = createImportService(backend);

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

  if(structuredWorkbook&&existingDoc&&!hasWorksheetSnapshot(existingDoc.source_rows)){
    await backend.attachments.setStatus(attachmentId,"needs_review",LEGACY_WORKBOOK_REVIEW,existingDoc.id);
    return {outcome:"needs_review",reason:LEGACY_WORKBOOK_REVIEW};
  }
  if (existingDoc?.status === "complete") {
    if(structuredWorkbook){
      try{verifyResumeRows(parsedRows,existingDoc.completed_keys||[],[],existingDoc.source_rows);}
      catch(error){
        await backend.attachments.setStatus(attachmentId,"needs_review",error.message,existingDoc.id);
        return {outcome:"needs_review",reason:error.message};
      }
    }
    // Duplicate delivery — already fully processed.
    await backend.attachments.setStatus(
      attachmentId, "auto_imported", null, existingDoc.id
    );
    return { outcome: "auto_imported" };
  }

  if(structuredWorkbook&&parsed.parts.some(part=>(part.rows.length>0&&!part.headerFound)||
    part.layout?.headers?.some(header=>header.how==="unknown"&&!isSourceMetadataHeader(header.label)))){
    const reason="This workbook has worksheet columns that need confirmation before importing prices.";
    await backend.attachments.setStatus(attachmentId,"needs_review",reason,existingDoc?.id??null);
    return {outcome:"needs_review",reason};
  }
  const hasMissingDescription = parsedRows.some(row=>!row.description?.trim());
  let documentId;
  if (existingDoc) {
    if (hasMissingDescription && !existingDoc.source_rows) {
      // A legacy import may have skipped a blank row and assigned later rows
      // different keys. Keep its saved results until the positions can be verified.
      const reason = "This partial import has a blank product description and no retained row snapshot to verify saved row positions.";
      await backend.attachments.setStatus(attachmentId, "needs_review", reason, existingDoc.id);
      return { outcome: "needs_review", reason };
    }
    if(existingDoc.source_rows||readResult.kind==="sheets"){
      const keys=[...new Set([...(existingDoc.completed_keys||[]),...Object.keys(existingDoc.staged_row_receipts||{})])];
      const saved=readResult.kind==="sheets"?await importService.resumeSources(organizationId,vendorId,existingDoc.id):[];
      try {
        verifyResumeRows(parsedRows,keys,saved,existingDoc.source_rows??null);
      } catch (error) {
        await backend.attachments.setStatus(attachmentId, "needs_review", error.message, existingDoc.id);
        return { outcome: "needs_review", reason: error.message };
      }
    }
    documentId = existingDoc.id;
  } else {
    const newDoc = await importService.createPriceDocument({
      organization_id:  organizationId,
      vendor_id:        vendorId,
      document_kind:    "pricelist",
      fingerprint,
      file_name:        filename,
      file_path:        storagePath,
      original_text:    rawText,
      ...(hasMissingDescription||structuredWorkbook?{source_rows:createSourceRowSnapshot(parsedRows)}:{}),
      status:           "processing",
    });
    documentId = newDoc.id;
  }

  // Resume support: collect already-completed row keys.
  const completedRows = existingDoc?.completed_keys
    ? new Set(existingDoc.completed_keys)
    : new Set();

  // Catalog evidence spans vendors. Reusing a source listing stays vendor-scoped.
  const [
    workingVendorItems,
    workingCatalogItems,
    workingCategories,
    workingMappings,
    rawInvoices,
  ] = await Promise.all([
    loadOrganizationRows(backend, "vendor_items", organizationId),
    loadOrganizationRows(backend, "catalog_items", organizationId),
    loadOrganizationRows(backend, "catalog_categories", organizationId),
    loadOrganizationRows(backend, "item_mappings", organizationId),
    importService.invoiceSources(organizationId, vendorId),
  ]);
  const invoiceSources=readInvoiceEvidence(rawInvoices,organizationId,vendorId,procurement);
  const catalogService = createCatalogService(backend,procurement);

  // ── Step 6: run the import engine row by row ───────────────────────────────
  const newCompletedKeys = [...completedRows];
  // completed_keys contains only successfully saved row:N keys (A1.7 contract).
  // Held-row evidence remains with the linked original or vendor listing;
  // report their row keys separately without corrupting resume's saved-row set.
  const heldKeys = [];
  const heldRows = [];
  let saveError = null;

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

  outer: for (const group of groups) {
    for (const sourceRow of group.rows) {
      backend.attachments.assertLease?.();
      const completedKey = `row:${globalRowIndex}`;
      globalRowIndex++;
      // Skip only saved rows. Reassess unresolved rows: new trusted evidence can
      // resolve them, and an unresolved row must never become a permanent skip.
      if (completedRows.has(completedKey)) continue;
      if (!sourceRow.description?.trim()) {
        heldKeys.push(completedKey);
        heldRows.push({key:completedKey,reasons:[MISSING_DESCRIPTION]});
        continue;
      }

      // A missing vendor code is not an identity shared by all unnumbered
      // products. Reuse only one source-compatible listing; retain ambiguous
      // rows for review instead of applying their price to another product.
      const found=sourceRow.code
        ?{item:workingVendorItems.find(v=>v.vendor_id===vendorId&&v.vendor_item_code===sourceRow.code)||null,conflict:null}
        :findUncodedVendorListing(sourceRow,workingVendorItems.filter(v=>v.vendor_id===vendorId),undefined,procurement);
      if(found.conflict){
        heldKeys.push(completedKey);
        heldRows.push({key:completedKey,reasons:[found.conflict]});
        continue;
      }
      const ex=found.item;
      const priorMapping = ex
        ? workingMappings.find(m => m.vendor_item_id === ex.id) || null
        : null;

      // preparePriceImport (via importPriceRow) decides requiresReview.
      // We pass rowNeedsReview=false; the engine returns {needsBasis:true}
      // when the pricing basis cannot be confirmed automatically.
      const rowIssues=[...ocrIssues(sourceRow),...(structuredWorkbook?sourceRow.issues||[]:[])];
      try {
        const result = await importPriceRow({
          backend,
          importService,
          catalogService,
          sourceRow,
          row: sourceRow,
          ex,
          priorMapping,
          rowIssues,
          rowNeedsReview: rowIssues.length>0,
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
        },procurement);
        backend.attachments.assertLease?.();

        if (result.needsBasis) {
          // Hold this row — continue processing the remaining rows rather than
          // blocking the entire sheet on one uncertain item.
          heldKeys.push(completedKey);
          heldRows.push({key:completedKey,reasons:result.reviewReasons});
          continue;
        }

        newCompletedKeys.push(completedKey);

        // Record progress periodically (every 50 rows) so a crash is resumable.
        if (newCompletedKeys.length % 50 === 0) {
          await importService.recordProgress(documentId, newCompletedKeys);
        }

      } catch (err) {
        if (String(err?.message).includes("LEASE_LOST")) throw err;
        // A hard save failure is not the same as basis uncertainty — we cannot
        // safely continue because the row's state in the DB is unknown.
        saveError = `Row save error (${completedKey}): ${err.message}`;
        break outer;
      }
    }
  }

  // ── Step 7: finalize ────────────────────────────────────────────────────────
  // Any held row or save error keeps the document partial. Only saved rows
  // enter completed_keys; the unchanged A1.7 verifier can safely resume it.
  if (heldKeys.length > 0 || saveError !== null || unparsedImageLines.length>0) {
    // Import document status must be 'partial' — the import_documents.status
    // column only accepts ('processing','complete','partial').  'needs_review'
    // is the attachment's status (inbound_attachments.processing_status), not
    // the document's.
    await importService.finalizeDocument(documentId, "partial", newCompletedKeys);

    const reviewReason = saveError || [
      heldKeys.length?`${heldKeys.length} row(s) require basis or source review: ${heldRows.map(row=>`${row.key}: ${row.reasons?.join('; ') || 'Source fields require confirmation'}`).join(' | ')}`:null,
      unparsedImageLines.length?`Unreadable image source lines retained for clarification: ${unparsedImageLines.map(line=>line.text).join(' | ')}`:null,
    ].filter(Boolean).join(' | ');

    // Pass documentId so the partially-created import document is linked to the
    // attachment.  Migration 033's set_attachment_processing_status allows
    // p_import_document_id when p_status = 'needs_review'.
    await backend.attachments.setStatus(attachmentId, "needs_review", reviewReason, documentId);
    return {
      outcome: "needs_review",
      reason: reviewReason,
      heldKeys,
      heldRows,
      savedCount: newCompletedKeys.length,
    };
  }

  await importService.finalizeDocument(documentId, "complete", newCompletedKeys);
  await backend.attachments.setStatus(attachmentId, "auto_imported", null, documentId);
  return { outcome: "auto_imported" };
}
