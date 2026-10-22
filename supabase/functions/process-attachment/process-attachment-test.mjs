/**
 * process-attachment-test.mjs
 *
 * Tests for the automatic attachment processing pipeline.
 *
 * Run with:
 *   node --experimental-vm-modules process-attachment-test.mjs
 *   (or Deno: deno run --allow-read process-attachment-test.mjs)
 *
 * These tests use an in-memory backend — no Supabase connection required.
 *
 * Coverage:
 *   1. Auto-import clean CSV price list with vendor assigned → auto_imported
 *   2. needs_review: unsupported file type (binary blob)
 *   3. needs_review: empty CSV (no rows parsed)
 *   4. needs_review: row requires human basis decision (price_basis missing)
 *   5. Duplicate delivery — fingerprint already complete, no double-write
 *   6. Storage download failure — throws (Postmark retry mechanism)
 *   7. No vendor assigned — processAttachmentInBackground throws before any I/O
 *   8. Row-save failure → needs_review immediately; loop stops, later rows not attempted
 *   9. needs_review status carries the import_document id (Fix 4 — document must be linked)
 */

import assert from "node:assert/strict";
import { createRecords } from "../../../src/backend/records.js";

// ── In-memory backend ────────────────────────────────────────────────────────
// Matches the interface required by background-import.mjs and service-backend.mjs.
//
// records is built with createRecords(execute) so that createImportService
// (which destructures {data, error} from every query result) works correctly.

function createInMemoryBackend({
  bytes = new Uint8Array([]),
  downloadShouldThrow = false,
  existingDoc = null,
  vendorItems = [],
  catalogItems = [],
  categories = [],
  mappings = [],
  applyQuoteShouldThrow = false,
} = {}) {
  const statusLog = [];
  const appliedQuotes = [];
  const createdDocs = [];
  const finalizedDocs = [];
  let downloadCount = 0;
  let applyQuoteAttempts = 0;

  // execute(spec) — called by createRecords when a chain is awaited.
  // Returns { data, error } to match Supabase client convention expected by
  // imports.js and catalog.js service layers.
  function execute(spec) {
    try {
      const result = runSpec(spec);
      return Promise.resolve({ data: result, error: null });
    } catch (err) {
      return Promise.resolve({ data: null, error: { message: err.message } });
    }
  }

  function runSpec(spec) {
    const { table, action, filters, cardinality } = spec;

    if (action === "select") {
      let rows;
      if (table === "vendor_items")        rows = vendorItems;
      else if (table === "catalog_items")  rows = catalogItems;
      else if (table === "catalog_categories") rows = categories;
      else if (table === "item_mappings")  rows = mappings;
      else if (table === "invoices")       rows = [];
      else if (table === "price_history")  rows = [];
      else if (table === "import_documents") {
        rows = existingDoc ? [existingDoc] : [];
      }
      else rows = [];

      // Apply simple eq filters
      for (const f of filters) {
        if (f.operator === "eq") rows = rows.filter(r => r[f.column] === f.value);
      }

      if (cardinality === "single")      return rows[0] ?? null;
      if (cardinality === "maybeSingle") return rows[0] ?? null;
      return rows;
    }

    if (action === "insert") {
      const row = Array.isArray(spec.value) ? spec.value[0] : spec.value;
      if (table === "import_documents") {
        const id = `doc-${createdDocs.length + 1}`;
        const newDoc = { ...row, id };
        createdDocs.push(newDoc);
        if (cardinality === "single") return newDoc;
        return [newDoc];
      }
      return row;
    }

    if (action === "update") {
      if (table === "import_documents") {
        finalizedDocs.push({ filters, value: spec.value });
      }
      // vendor_items update for needsBasis path — allow it silently
      return null;
    }

    if (action === "upsert") {
      return spec.value;
    }

    return null;
  }

  return {
    kind: "in-memory",
    records: createRecords(execute),
    pricing: {
      applyQuote(quote) {
        applyQuoteAttempts++;
        // When applyQuoteShouldThrow is set, simulate a save failure on every
        // call.  This is used in Test 8 to prove the row loop breaks immediately
        // on a single row error and does not continue to later rows.
        if (applyQuoteShouldThrow) throw new Error("Simulated save failure");
        appliedQuotes.push(quote);
        // When updating an existing vendor item, return its id (mirrors the real
        // kerdos_apply_price_quote RPC which UPDATEs and returns the same id).
        // When creating a new item, generate a synthetic id.
        return Promise.resolve(quote.vendorItemId || `item-${appliedQuotes.length}`);
      }
    },
    catalog: {
      matchOrCreate: () => Promise.resolve(null),
      // The following are browser-only catalog ops — not needed in background import
      groupAutomaticAlternatives:    () => { throw new Error("not available in background processing"); },
      separateAutomaticAlternatives: () => { throw new Error("not available in background processing"); },
      associateAlternatives:         () => { throw new Error("not available in background processing"); },
      saveRow:                       () => { throw new Error("not available in background processing"); },
    },
    orgSettings: {
      vendorLayouts: () => Promise.resolve({}),
    },
    attachments: {
      download() {
        downloadCount++;
        if (downloadShouldThrow) throw new Error("Storage unavailable");
        return Promise.resolve(bytes);
      },
      claim() { return Promise.resolve(true); },
      setStatus(id, status, error = null, docId = null) {
        statusLog.push({ id, status, error, docId });
        return Promise.resolve();
      },
    },
    // Test inspection handles
    _statusLog:     statusLog,
    _appliedQuotes: appliedQuotes,
    _createdDocs:   createdDocs,
    _finalizedDocs: finalizedDocs,
    _downloadCount:       { get value() { return downloadCount; } },
    _applyQuoteAttempts:  { get value() { return applyQuoteAttempts; } },
  };
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function csvBytes(text) {
  return new TextEncoder().encode(text);
}

// Base attachment — mutate per test as needed.
const ATTACHMENT_BASE = {
  id:               "att-1",
  filename:         "prices.csv",
  content_type:     "text/csv",
  file_size_bytes:  100,
  storage_path:     "org-1/inbound/msg-1/0",
  ingest_error:     null,
};

// ── Import processAttachmentInBackground ──────────────────────────────────────

import { processAttachmentInBackground } from "./background-import.mjs";

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

async function test(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
    passed++;
  } catch (err) {
    console.error(`  ✗ ${name}`);
    console.error(`    ${err.message}`);
    if (process.env.VERBOSE) console.error(err.stack);
    failed++;
  }
}

console.log("\nprocess-attachment tests\n");

// ── Test 1: clean CSV goes all the way to auto_imported ───────────────────────
//
// This is the primary happy path: a well-formed CSV with known columns produces
// at least one price row that imports without needing human review.
// Evidence: outcome = 'auto_imported', applyQuote called, status set correctly.

await test("auto-import: clean CSV price list → auto_imported with rows saved", async () => {
  // code + description + price.  The description must exactly match the
  // prior item's description so rememberImportRow sees no conflict.
  // Pack and selling-unit come from the prior (rememberImportRow fills them in),
  // which is enough for preparePriceImport to resolve basis without review.
  const csv = [
    "code,description,price",
    "SKU-001,Widget A,10.00",
    "SKU-002,Widget B,15.50",
    "SKU-003,Widget C,22.00",
  ].join("\n");

  // Pre-seed vendor items matching the CSV codes and their catalog mappings.
  // Each item carries full pack/basis so rememberImportRow sets knownVendorItem=true,
  // bypassing change-detection and catalog-creation.  Exact mappings are required so
  // resolveQuoteBasis can resolve from the confirmed vendor item without review.
  const backend = createInMemoryBackend({
    bytes: csvBytes(csv),
    vendorItems: [
      { id: "vi-1", organization_id: "org-1", vendor_id: "vendor-1", vendor_item_code: "SKU-001",
        description: "Widget A", pack_size: "18 LB", selling_unit: "CASE", price_basis: "case", price_source: "price_list" },
      { id: "vi-2", organization_id: "org-1", vendor_id: "vendor-1", vendor_item_code: "SKU-002",
        description: "Widget B", pack_size: "18 LB", selling_unit: "CASE", price_basis: "case", price_source: "price_list" },
      { id: "vi-3", organization_id: "org-1", vendor_id: "vendor-1", vendor_item_code: "SKU-003",
        description: "Widget C", pack_size: "18 LB", selling_unit: "CASE", price_basis: "case", price_source: "price_list" },
    ],
    mappings: [
      { id: "map-1", organization_id: "org-1", vendor_item_id: "vi-1", catalog_item_id: "cat-1", comparison_track: "exact", confidence_score: 100 },
      { id: "map-2", organization_id: "org-1", vendor_item_id: "vi-2", catalog_item_id: "cat-2", comparison_track: "exact", confidence_score: 100 },
      { id: "map-3", organization_id: "org-1", vendor_item_id: "vi-3", catalog_item_id: "cat-3", comparison_track: "exact", confidence_score: 100 },
    ],
  });
  const attachment = { ...ATTACHMENT_BASE };

  const result = await processAttachmentInBackground(backend, attachment, {
    organizationId: "org-1",
    vendorId:       "vendor-1",
  });

  // Must be auto_imported (no human review required for clean data)
  assert.equal(result.outcome, "auto_imported",
    `Expected auto_imported but got ${result.outcome}${result.reason ? ": " + result.reason : ""}`);

  // At least one quote was applied (rows were actually saved)
  assert.ok(backend._appliedQuotes.length > 0,
    `Expected applyQuote to be called but it was called ${backend._appliedQuotes.length} times`);

  // Status was set to auto_imported
  const statusEntry = backend._statusLog.find(s => s.status === "auto_imported");
  assert.ok(statusEntry, "Expected processing_status to be set to auto_imported");
  assert.equal(statusEntry.id, "att-1");

  // An import_document row was created
  assert.ok(backend._createdDocs.length > 0, "Expected an import_document to be created");
  assert.equal(backend._createdDocs[0].status, "processing"); // created with 'processing'

  // import_document_id was linked in the status call
  assert.ok(statusEntry.docId, "Expected auto_imported status to carry docId");
  assert.equal(statusEntry.docId, backend._createdDocs[0].id);

  // All three CSV rows were applied — no silent skips
  assert.equal(backend._appliedQuotes.length, 3,
    `Expected applyQuote called 3 times (once per CSV row) but got ${backend._appliedQuotes.length}`);

  // Import document was finalized as 'complete', not left in 'processing'
  const finalizedDoc = backend._finalizedDocs.find(d => d.value?.status === "complete");
  assert.ok(finalizedDoc, "Expected import_document to be finalized with status='complete'");
});

// ── Test 2: unsupported MIME type → needs_review ──────────────────────────────

await test("needs_review: unsupported MIME type", async () => {
  const backend = createInMemoryBackend({
    bytes: new Uint8Array([0x25, 0x50, 0x44, 0x46]), // PDF magic bytes but wrong MIME
  });
  const attachment = { ...ATTACHMENT_BASE, filename: "prices.bin", content_type: "application/octet-stream" };

  const result = await processAttachmentInBackground(backend, attachment, {
    organizationId: "org-1",
    vendorId:       "vendor-1",
  });

  assert.equal(result.outcome, "needs_review");

  const statusEntry = backend._statusLog.find(s => s.status === "needs_review");
  assert.ok(statusEntry, "Expected processing_status to be set to needs_review");
});

// ── Test 3: empty CSV → needs_review ──────────────────────────────────────────

await test("needs_review: empty CSV (no rows parsed)", async () => {
  const backend = createInMemoryBackend({ bytes: csvBytes("") });
  const attachment = { ...ATTACHMENT_BASE };

  const result = await processAttachmentInBackground(backend, attachment, {
    organizationId: "org-1",
    vendorId:       "vendor-1",
  });

  assert.equal(result.outcome, "needs_review");
});

// ── Test 4: row requires human basis decision → whole doc needs_review ────────
//
// When any imported row produces a 'needsBasis' signal (price_basis cannot be
// determined automatically), the document must be escalated to needs_review —
// never auto_imported.  This verifies the three-part engine's Decide gate:
// the importer must not commit a price it cannot price-basis-resolve.
//
// The fixture seeds a vendor item whose code matches the CSV row but carries
// no pack_size, selling_unit, or price_basis.  rememberImportRow sets
// knownVendorItem=true (code match), but preparePriceImport still cannot
// resolve a basis → requiresReview=true → importPriceRow takes the
// (needsBasis && ex) branch, which skips applyQuote entirely and writes the
// incoming quote to vendor_items.import_row for human resolution.
// background-import.mjs sees needsBasis=true, sets needsReview=true, and
// breaks out of the row loop → final outcome: needs_review.

await test("needs_review: row requires human basis decision (Decide gate)", async () => {
  const csv = [
    "code,description,price",
    "SKU-A,Bulk Item A,50.00",
    "SKU-B,Bulk Item B,75.00",
  ].join("\n");

  // Pre-seed vendor items matching the CSV codes but WITHOUT pack/basis info.
  // This ensures importPriceRow enters the (needsBasis && ex) branch, which
  // skips applyQuote and returns needsBasis=true without committing anything.
  //
  // Exact mappings must also be present so importPriceRow finds priorMapping
  // and never reaches catalogService.matchOrCreate.  Without them the test
  // passes for the wrong reason — matchOrCreate returns null → throws
  // "item-number range" → caught as a row error → needs_review via the
  // error-tolerance path, not the basis-decision path we are testing.
  const backend = createInMemoryBackend({
    bytes: csvBytes(csv),
    vendorItems: [
      { id: "vi-a", organization_id: "org-1", vendor_id: "vendor-1",
        vendor_item_code: "SKU-A", description: "Bulk Item A" },
      { id: "vi-b", organization_id: "org-1", vendor_id: "vendor-1",
        vendor_item_code: "SKU-B", description: "Bulk Item B" },
    ],
    mappings: [
      { id: "map-a", organization_id: "org-1", vendor_item_id: "vi-a",
        catalog_item_id: "cat-a", comparison_track: "exact", confidence_score: 100 },
      { id: "map-b", organization_id: "org-1", vendor_item_id: "vi-b",
        catalog_item_id: "cat-b", comparison_track: "exact", confidence_score: 100 },
    ],
  });
  const attachment = { ...ATTACHMENT_BASE };

  const result = await processAttachmentInBackground(backend, attachment, {
    organizationId: "org-1",
    vendorId:       "vendor-1",
  });

  // The Decide gate must not auto-import a row whose basis is unresolvable.
  assert.equal(result.outcome, "needs_review",
    `Expected needs_review but got ${result.outcome}${result.reason ? ": " + result.reason : ""}`);

  // The (needsBasis && ex) branch skips applyQuote entirely — no price committed.
  assert.equal(backend._appliedQuotes.length, 0,
    `Expected applyQuote NOT to be called on an unresolvable-basis row, but was called ${backend._appliedQuotes.length} time(s)`);

  // Status log must carry needs_review
  const statusEntry = backend._statusLog.find(s => s.status === "needs_review");
  assert.ok(statusEntry, "Expected processing_status to be set to needs_review");
  assert.equal(statusEntry.id, "att-1");

  // The review must be triggered by the basis-decision path, not by a row
  // save error or some other failure.  result.reason comes from the
  // reviewReason set when result.needsBasis===true in background-import.mjs.
  assert.ok(
    result.reason && /basis/i.test(result.reason),
    `Expected review reason to mention basis but got: "${result.reason}"`
  );
});

// ── Test 5: duplicate delivery — fingerprint already complete ─────────────────
//
// When an email is redelivered (Postmark retry), inbound-email stores another
// identical attachment row.  background-import must detect the fingerprint
// match, skip re-importing, and immediately return auto_imported.
//
// Evidence: applyQuote NOT called (no double-write), status set to auto_imported
// with the EXISTING doc id (not a new doc).

await test("duplicate delivery: returns auto_imported without re-importing", async () => {
  const existingDoc = {
    id:              "doc-existing",
    organization_id: "org-1",
    vendor_id:       "vendor-1",
    document_kind:   "pricelist",
    fingerprint:     "org-1/inbound/msg-1/0:100",
    status:          "complete",
    completed_keys:  ["row-1", "row-2"],
  };

  const backend = createInMemoryBackend({
    bytes: csvBytes("code,description,price\nABC,Widget,10.00"),
    existingDoc,
  });
  const attachment = { ...ATTACHMENT_BASE };

  const result = await processAttachmentInBackground(backend, attachment, {
    organizationId: "org-1",
    vendorId:       "vendor-1",
  });

  assert.equal(result.outcome, "auto_imported");

  // No new quotes were applied — the existing import was reused
  assert.equal(backend._appliedQuotes.length, 0,
    "Duplicate delivery must not re-apply quotes");

  // Status was set to auto_imported with the EXISTING doc id
  const statusEntry = backend._statusLog.find(s => s.status === "auto_imported");
  assert.ok(statusEntry, "Expected processing_status to be set to auto_imported");
  assert.equal(statusEntry.docId, "doc-existing",
    "Status must reference the existing doc, not a newly created one");

  // No new import_document was created
  assert.equal(backend._createdDocs.length, 0,
    "Duplicate delivery must not create a new import_document row");
});

// ── Test 6: storage download failure → throws (Postmark retry) ───────────────
//
// Transient storage errors must propagate as thrown errors, not be silently
// swallowed as needs_review.  The inbound-email function catches these throws
// and lets Postmark's retry mechanism handle them.

await test("storage download failure throws (Postmark retry)", async () => {
  const backend = createInMemoryBackend({ downloadShouldThrow: true });
  const attachment = { ...ATTACHMENT_BASE };

  await assert.rejects(
    () => processAttachmentInBackground(backend, attachment, {
      organizationId: "org-1",
      vendorId:       "vendor-1",
    }),
    /Storage unavailable/,
    "Expected a throw on storage failure, not a needs_review outcome"
  );
});

// ── Test 7: no vendor assignment → throws immediately ────────────────────────
//
// index.ts validates vendorId at the HTTP layer before invoking this function.
// processAttachmentInBackground also guards itself as defense-in-depth so it
// cannot silently process an unrouted attachment if called directly (e.g., from
// another Edge Function or a future scheduled replay path).
//
// Evidence: passing vendorId=null rejects before any I/O.

await test("no vendor assignment throws before any I/O (defense-in-depth guard)", async () => {
  const backend = createInMemoryBackend({ bytes: csvBytes("code,price\nSKU-1,10.00") });
  const attachment = { ...ATTACHMENT_BASE };

  await assert.rejects(
    () => processAttachmentInBackground(backend, attachment, {
      organizationId: "org-1",
      vendorId:       null,
    }),
    /vendorId is required/,
    "Expected processAttachmentInBackground to throw when vendorId is falsy"
  );

  // No I/O should have occurred — the guard fires before download
  assert.equal(backend._downloadCount.value, 0,
    "Expected attachments.download() not to be called before the vendorId guard throws");
  assert.equal(backend._statusLog.length, 0,
    "Expected no status writes before the vendorId guard throws");
  assert.equal(backend._appliedQuotes.length, 0,
    "Expected no quote writes before the vendorId guard throws");
});

// ── Test 8: single row-save failure → needs_review, loop stops immediately ────
//
// Fix verification for the "failedCount > 3" tolerance that was removed.
// Any single importPriceRow throw must set needs_review and break out of the
// row loop — it must not continue to the remaining rows.
//
// Fixture: three valid rows, but applyQuote is configured to throw on every
// call.  The ingestion layer treats price=0 as priceUnavailable, which bypasses
// the positive-price guard; to reliably trigger a save failure for any valid
// row, we instead force the backend pricing service to throw.
//
// Row 1 triggers the throw → catch block sets needsReview and breaks.
// Rows 2 and 3 must never be attempted.  We track applyQuote call attempts
// (including the failed one) separately from successful saves so both facts can
// be asserted:
//   - _appliedQuotes.length === 0  (no successful saves)
//   - _applyQuoteAttempts.value === 1  (only row 1 reached the save; 2 and 3 did not)

await test("row-save failure: needs_review immediately, no further rows processed", async () => {
  const csv = [
    "code,description,price",
    "SKU-001,Widget A,10.00",  // valid — but applyQuote will throw
    "SKU-002,Widget B,15.50",  // valid — must NOT be attempted after row 1 fails
    "SKU-003,Widget C,22.00",  // valid — must NOT be attempted after row 1 fails
  ].join("\n");

  // All three items carry full pack/basis so preparePriceImport resolves
  // without review and the importer reaches applyQuote on the first row.
  // applyQuoteShouldThrow then fires, triggering the catch/break path.
  const backend = createInMemoryBackend({
    bytes: csvBytes(csv),
    vendorItems: [
      { id: "vi-1", organization_id: "org-1", vendor_id: "vendor-1", vendor_item_code: "SKU-001",
        description: "Widget A", pack_size: "18 LB", selling_unit: "CASE", price_basis: "case", price_source: "price_list" },
      { id: "vi-2", organization_id: "org-1", vendor_id: "vendor-1", vendor_item_code: "SKU-002",
        description: "Widget B", pack_size: "18 LB", selling_unit: "CASE", price_basis: "case", price_source: "price_list" },
      { id: "vi-3", organization_id: "org-1", vendor_id: "vendor-1", vendor_item_code: "SKU-003",
        description: "Widget C", pack_size: "18 LB", selling_unit: "CASE", price_basis: "case", price_source: "price_list" },
    ],
    mappings: [
      { id: "map-1", organization_id: "org-1", vendor_item_id: "vi-1", catalog_item_id: "cat-1", comparison_track: "exact", confidence_score: 100 },
      { id: "map-2", organization_id: "org-1", vendor_item_id: "vi-2", catalog_item_id: "cat-2", comparison_track: "exact", confidence_score: 100 },
      { id: "map-3", organization_id: "org-1", vendor_item_id: "vi-3", catalog_item_id: "cat-3", comparison_track: "exact", confidence_score: 100 },
    ],
    applyQuoteShouldThrow: true,
  });
  const attachment = { ...ATTACHMENT_BASE };

  const result = await processAttachmentInBackground(backend, attachment, {
    organizationId: "org-1",
    vendorId:       "vendor-1",
  });

  // Single row failure must escalate the whole document — no partial success.
  assert.equal(result.outcome, "needs_review",
    `Expected needs_review on row-save failure but got ${result.outcome}`);

  // No successful saves — the throw fires before appliedQuotes is updated.
  assert.equal(backend._appliedQuotes.length, 0,
    `Expected no successful applyQuote saves but got ${backend._appliedQuotes.length}`);

  // The loop must break after row 1 — rows 2 and 3 must never be attempted.
  // _applyQuoteAttempts counts every call entry including the failing one.
  assert.equal(backend._applyQuoteAttempts.value, 1,
    `Expected exactly 1 applyQuote attempt (row 1 only) but got ${backend._applyQuoteAttempts.value}`);

  // Status was set to needs_review for the correct attachment.
  const statusEntry = backend._statusLog.find(s => s.status === "needs_review");
  assert.ok(statusEntry, "Expected processing_status to be set to needs_review");
  assert.equal(statusEntry.id, "att-1");
});

// ── Test 9: needs_review status carries the import_document id ───────────────
//
// Fix 4 verification: when the importer returns needs_review, the
// set_attachment_processing_status call must include the import_document_id so
// the partially-created document is linked to the attachment.  Without this
// link, the review UI cannot open the source document from the attachment row.
//
// We reuse the applyQuoteShouldThrow fixture from Test 8 — it reliably reaches
// the needs_review finalize path after creating an import_document — and check
// that the docId on the status log entry matches the created document's id.
//
// Document ownership validation (org + vendor) is enforced at the SQL layer in
// set_attachment_processing_status (migration_033).  The in-memory mock records
// calls without enforcing those constraints, so rejection tests for a
// wrong-org or wrong-vendor document belong in a Supabase database test, not
// here.  Migration_033 rejects any p_import_document_id whose organization_id
// differs from the attachment's org or whose vendor_id differs from the vendor
// assigned to the routing address (when one is assigned).

await test("needs_review status carries import_document id (Fix 4 — document must be linked)", async () => {
  const csv = [
    "code,description,price",
    "SKU-001,Widget A,10.00",
  ].join("\n");

  const backend = createInMemoryBackend({
    bytes: csvBytes(csv),
    vendorItems: [
      { id: "vi-1", organization_id: "org-1", vendor_id: "vendor-1", vendor_item_code: "SKU-001",
        description: "Widget A", pack_size: "18 LB", selling_unit: "CASE", price_basis: "case", price_source: "price_list" },
    ],
    mappings: [
      { id: "map-1", organization_id: "org-1", vendor_item_id: "vi-1", catalog_item_id: "cat-1", comparison_track: "exact", confidence_score: 100 },
    ],
    applyQuoteShouldThrow: true,
  });
  const attachment = { ...ATTACHMENT_BASE };

  const result = await processAttachmentInBackground(backend, attachment, {
    organizationId: "org-1",
    vendorId:       "vendor-1",
  });

  assert.equal(result.outcome, "needs_review",
    `Expected needs_review but got ${result.outcome}`);

  // An import_document must have been created before the failure was handled.
  assert.ok(backend._createdDocs.length > 0,
    "Expected an import_document to be created before the row failure");

  const expectedDocId = backend._createdDocs[0].id;

  // The document must belong to the correct org and vendor — this verifies
  // the importer creates the document with matching org/vendor, which is what
  // set_attachment_processing_status validates at the SQL layer.
  assert.equal(backend._createdDocs[0].organization_id, "org-1",
    "Created document must carry the correct organization_id");
  assert.equal(backend._createdDocs[0].vendor_id, "vendor-1",
    "Created document must carry the correct vendor_id");

  // The import document must be finalized as 'partial', not 'needs_review'.
  // import_documents.status CHECK only permits ('processing','complete','partial').
  // 'needs_review' is the attachment's processing_status — not the document's.
  const finalizedDoc = backend._finalizedDocs.find(d => d.value?.status === "partial");
  assert.ok(finalizedDoc,
    "Expected import document to be finalized with status 'partial', not 'needs_review'");
  assert.equal(finalizedDoc.value.status, "partial",
    `Expected import document status 'partial' but got '${finalizedDoc.value?.status}'`);

  // The needs_review status entry must carry the document id so the review UI
  // can link the attachment to the source document.
  const statusEntry = backend._statusLog.find(s => s.status === "needs_review");
  assert.ok(statusEntry, "Expected processing_status to be set to needs_review");
  assert.equal(statusEntry.id, "att-1");
  assert.ok(
    statusEntry.docId,
    "Expected needs_review setStatus call to include import_document_id, but docId was absent"
  );
  assert.equal(statusEntry.docId, expectedDocId,
    `Expected docId "${expectedDocId}" but got "${statusEntry.docId}"`);
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed} passed, ${failed} failed\n`);
if (failed > 0) process.exit(1);
