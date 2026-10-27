/**
 * test_module_a_importer.mjs
 *
 * Executed tests for background-import.mjs.
 *
 * Unlike the static checks in test_module_a_interactions.mjs (which grep source
 * text), these tests actually CALL processAttachmentInBackground with a mock
 * backend.  They verify:
 *
 *   Section 1 — classifyDocument (pure, no I/O)
 *     All 5 classification paths including both null-document-type branches.
 *
 *   Section 2 — processAttachmentInBackground (executed with mock backend)
 *     A1.2.g registered invoice         → auto_imported + import_documents row
 *     Duplicate registered invoice       → auto_imported, no second insert
 *     Unregistered invoice content       → needs_review (earlyExit, no DB writes)
 *     Ambiguous content, no registration → needs_review (earlyExit, no DB writes)
 *     Registered pricelist, no rows      → needs_review (no-rows path, not earlyExit)
 *     Missing vendorId                   → throws before any DB access
 *
 * Run: node scripts/test_module_a_importer.mjs
 * Set VERBOSE=1 for full stack traces on failures.
 */

import assert from "node:assert/strict";
import {
  classifyDocument,
  processAttachmentInBackground,
} from "../supabase/functions/process-attachment/background-import.mjs";

let passed = 0;
let failed = 0;

const check = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`PASS ${name}`);
  } catch (err) {
    failed++;
    console.error(`FAIL ${name}: ${err.message}`);
    if (process.env.VERBOSE) console.error(err.stack);
  }
};

// ── Section 1: classifyDocument — pure function, no I/O ─────────────────────

await check("classifyDocument: registered pricelist ignores content kind", async () => {
  // Registration beats content: even if content looks like an invoice, pricelist wins.
  const r = classifyDocument("pricelist", "invoice");
  assert.equal(r.isInvoice, false);
  assert.equal(r.earlyExit, null);
});

await check("classifyDocument: registered invoice ignores content kind", async () => {
  // Registration beats content: even if content looks like a pricelist, invoice wins.
  const r = classifyDocument("invoice", "pricelist");
  assert.equal(r.isInvoice, true);
  assert.equal(r.earlyExit, null);
});

await check("classifyDocument: unregistered + pricelist content → auto-import path", async () => {
  const r = classifyDocument(null, "pricelist");
  assert.equal(r.isInvoice, false);
  assert.equal(r.earlyExit, null);
});

await check("classifyDocument: unregistered + invoice content → earlyExit needs_review", async () => {
  const r = classifyDocument(null, "invoice");
  assert.equal(r.isInvoice, null);
  assert.ok(r.earlyExit, "earlyExit must be set");
  assert.equal(r.earlyExit.status, "needs_review");
  assert.match(r.earlyExit.reason, /registration/i,
    "reason must mention lack of registration");
});

await check("classifyDocument: unregistered + unknown content → earlyExit needs_review", async () => {
  const r = classifyDocument(null, "unknown");
  assert.equal(r.isInvoice, null);
  assert.ok(r.earlyExit, "earlyExit must be set");
  assert.equal(r.earlyExit.status, "needs_review");
  assert.match(r.earlyExit.reason, /inconclusive/i,
    "reason must mention inconclusive detection");
});

await check("classifyDocument: unregistered + null contentKind → earlyExit needs_review", async () => {
  const r = classifyDocument(null, null);
  assert.equal(r.isInvoice, null);
  assert.ok(r.earlyExit, "earlyExit must be set");
  assert.equal(r.earlyExit.status, "needs_review");
});

// ── Mock backend helpers ──────────────────────────────────────────────────────

/** Convert a plain string to the ArrayBuffer shape readAttachment expects. */
function textToArrayBuffer(str) {
  const buf = Buffer.from(str, "utf8");
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
}

/**
 * Build a Supabase-like chainable query object for a single table call.
 *
 * The chain accumulates eq() filters and resolves:
 *   .maybeSingle() / .single() — point lookup (returns first matching row or null)
 *   .then()                    — array query (returns all matching rows)
 *
 * Inserts (.insert().select().single()) are captured via onInsert and return a
 * new row with a generated id.
 *
 * All mutations (update) silently succeed — the importer doesn't need their
 * return value in the executed test paths.
 */
function makeChain(tableName, rows, onInsert) {
  const state = { filters: {}, insertRow: null, hasInsert: false };

  const chain = {
    select: () => chain,
    eq:     (col, val) => { state.filters[col] = val; return chain; },
    neq:    () => chain,
    or:     () => chain,
    order:  () => chain,
    range:  () => chain,
    limit:  () => chain,
    lte:    () => chain,
    insert: (row) => { state.hasInsert = true; state.insertRow = row; return chain; },
    update: () => chain,

    maybeSingle: () => {
      const match = rows.filter(r =>
        Object.entries(state.filters).every(([k, v]) => r[k] === v)
      );
      return Promise.resolve({ data: match[0] ?? null, error: null });
    },

    single: () => {
      if (state.hasInsert) {
        const row = { id: `mock-${tableName}-${Date.now()}`, ...state.insertRow };
        onInsert?.(tableName, row);
        return Promise.resolve({ data: row, error: null });
      }
      const match = rows.filter(r =>
        Object.entries(state.filters).every(([k, v]) => r[k] === v)
      );
      return Promise.resolve({ data: match[0] ?? null, error: null });
    },

    then: (resolve, reject) => {
      if (state.hasInsert) {
        const row = { id: `mock-${tableName}-${Date.now()}`, ...state.insertRow };
        onInsert?.(tableName, row);
        return Promise.resolve({ data: row, error: null }).then(resolve, reject);
      }
      const match = rows.filter(r =>
        Object.entries(state.filters).every(([k, v]) => r[k] === v)
      );
      return Promise.resolve({ data: match, error: null }).then(resolve, reject);
    },
  };

  return chain;
}

/**
 * Build a minimal mock backend for processAttachmentInBackground.
 *
 * @param {object} opts
 * @param {string}  opts.contentStr   — raw text content the "download" returns
 * @param {string}  [opts.mimeType]   — MIME type passed to readAttachment (default text/csv)
 * @param {object}  [opts.tables]     — { tableName: rows[] } for pre-seeded lookups
 */
function makeBackend({ contentStr = "", mimeType = "text/csv", tables = {} } = {}) {
  const statusCalls = [];
  const insertedRows = [];
  const bytes = textToArrayBuffer(contentStr);

  const query = (tableName) =>
    makeChain(tableName, tables[tableName] ?? [], (tbl, row) => {
      insertedRows.push({ table: tbl, row });
    });

  return {
    /** Captured setStatus calls — inspect in assertions. */
    _status:   statusCalls,
    /** Captured DB insert rows — inspect in assertions. */
    _inserted: insertedRows,

    attachments: {
      download: async (_path) => bytes,
      setStatus: async (id, status, reason, docId) => {
        statusCalls.push({ id, status, reason: reason ?? null, docId: docId ?? null });
      },
      assertLease:             () => {},
      claim:                   async () => "test-lease-token",
      renewLease:              async () => {},
      loseLease:               () => {},
      markNeedsReviewIfPending: async () => {},
    },

    records: { query },

    // RPC (used by pricelist import loop — not exercised in current test paths)
    rpc: async () => ({ data: null, error: null }),

    _supabase: { from: query },
  };
}

/** A minimal inbound_attachments row. */
function makeAttachment({
  id          = "att-test-001",
  filename    = "test.csv",
  mimeType    = "text/csv",
  storagePath = "org/test/file.csv",
  sizeBytes   = 128,
} = {}) {
  return {
    id,
    filename,
    content_type:    mimeType,
    storage_path:    storagePath,
    file_size_bytes: sizeBytes,
  };
}

const ORG_ID    = "org-test-001";
const VENDOR_ID = "vendor-test-001";

// ── Section 2: processAttachmentInBackground — executed with mock backend ────

await check("executed: missing vendorId throws before any DB access", async () => {
  const backend = makeBackend({ contentStr: "Code,Description,Price\nA001,Widget,10.00" });
  await assert.rejects(
    () => processAttachmentInBackground(backend, makeAttachment(), {
      organizationId: ORG_ID,
      vendorId: null,
    }),
    /vendorId is required/,
  );
  assert.equal(backend._status.length, 0, "no setStatus calls expected");
  assert.equal(backend._inserted.length, 0, "no DB inserts expected");
});

await check("executed: unregistered invoice content → needs_review (earlyExit, no DB writes)", async () => {
  // "INVOICE" keyword triggers detectDocumentKind → 'invoice'
  const content = "INVOICE #12345,,,\nBill To:,Acme Corp,,\nAmount Due:,$500.00,,";
  const backend  = makeBackend({ contentStr: content });
  const att      = makeAttachment({ filename: "invoice.csv" });

  const result = await processAttachmentInBackground(backend, att, {
    organizationId: ORG_ID,
    vendorId:       VENDOR_ID,
    documentType:   null,  // address has no registration
  });

  assert.equal(result.outcome, "needs_review");
  assert.match(result.reason ?? "", /registration/i,
    "reason must mention missing registration, not some other cause");

  const call = backend._status[0];
  assert.ok(call, "setStatus must be called exactly once");
  assert.equal(call.status, "needs_review");
  assert.match(call.reason ?? "", /registration/i);

  // earlyExit path: no import_documents inserts
  assert.equal(backend._inserted.length, 0,
    "earlyExit path must not write to import_documents");
});

await check("executed: ambiguous content, no registration → needs_review (earlyExit)", async () => {
  // No invoice or pricelist keywords → contentKind = 'unknown'
  const content = "Ref,Column1,Column2\nXYZ,value1,value2\nABC,value3,value4";
  const backend  = makeBackend({ contentStr: content });
  const att      = makeAttachment({ filename: "data.csv" });

  const result = await processAttachmentInBackground(backend, att, {
    organizationId: ORG_ID,
    vendorId:       VENDOR_ID,
    documentType:   null,
  });

  assert.equal(result.outcome, "needs_review");
  assert.match(result.reason ?? "", /inconclusive|determined/i);
  assert.equal(backend._inserted.length, 0,
    "earlyExit path must not write to import_documents");
});

await check("executed: registered invoice (A1.2.g) → auto_imported with import_documents row", async () => {
  // documentType='invoice' means registration is authoritative; content irrelevant.
  const content = "Some file content that could be anything";
  const backend  = makeBackend({ contentStr: content });
  const att      = makeAttachment({ filename: "inv-001.csv" });

  const result = await processAttachmentInBackground(backend, att, {
    organizationId: ORG_ID,
    vendorId:       VENDOR_ID,
    documentType:   "invoice",
  });

  assert.equal(result.outcome, "auto_imported",
    `expected auto_imported but got ${result.outcome}: ${result.reason}`);

  // setStatus called with auto_imported
  const call = backend._status[0];
  assert.ok(call, "setStatus must be called");
  assert.equal(call.status, "auto_imported");
  assert.ok(call.docId, "setStatus must carry the new document id");

  // import_documents row created with document_kind='invoice'
  const docInsert = backend._inserted.find(r => r.table === "import_documents");
  assert.ok(docInsert, "import_documents row must be created");
  assert.equal(docInsert.row.document_kind, "invoice",
    "document_kind must be 'invoice'");
  assert.equal(docInsert.row.organization_id, ORG_ID);
  assert.equal(docInsert.row.vendor_id, VENDOR_ID);
  assert.equal(docInsert.row.status, "complete",
    "invoice document must be marked complete immediately");
});

await check("executed: duplicate registered invoice → auto_imported, no second insert", async () => {
  // Postmark retry: an import_documents row already exists for this fingerprint.
  const att         = makeAttachment();  // storagePath=org/test/file.csv, sizeBytes=128
  const fingerprint = `${att.storage_path}:${att.file_size_bytes}`;  // mirrors makeFingerprint()

  const existingDoc = {
    id:              "existing-invoice-doc-1",
    status:          "complete",
    organization_id: ORG_ID,
    vendor_id:       VENDOR_ID,
    document_kind:   "invoice",
    fingerprint,
  };

  const backend = makeBackend({
    contentStr: "Any content",
    tables: { import_documents: [existingDoc] },
  });

  const result = await processAttachmentInBackground(backend, att, {
    organizationId: ORG_ID,
    vendorId:       VENDOR_ID,
    documentType:   "invoice",
  });

  assert.equal(result.outcome, "auto_imported");

  // Must NOT insert a second import_documents row
  assert.equal(backend._inserted.length, 0,
    "duplicate path must not create a second import_documents row");

  // setStatus must link to the existing document
  const call = backend._status[0];
  assert.equal(call.status, "auto_imported");
  assert.equal(call.docId, "existing-invoice-doc-1",
    "setStatus must reference the already-existing document, not a new one");
});

await check("executed: registered pricelist, no parseable rows → needs_review (not earlyExit)", async () => {
  // CSV with a header row only — parseDocument finds no price rows.
  // This verifies the pricelist classification path is reached (not earlyExit)
  // before failing at the "no rows" guard.
  const content = "Code,Description,Unit Price";
  const backend  = makeBackend({ contentStr: content });
  const att      = makeAttachment({ filename: "pricelist.csv" });

  const result = await processAttachmentInBackground(backend, att, {
    organizationId: ORG_ID,
    vendorId:       VENDOR_ID,
    documentType:   "pricelist",
  });

  assert.equal(result.outcome, "needs_review");

  // The reason must NOT be an earlyExit reason (which would mention registration
  // or inconclusive). It must be the "no rows" or "no data" guard.
  assert.doesNotMatch(result.reason ?? "", /registration/i,
    "must not be the unregistered-invoice earlyExit reason");
  assert.doesNotMatch(result.reason ?? "", /inconclusive/i,
    "must not be the ambiguous-content earlyExit reason");

  // No import_documents rows: code returns before createPriceDocument is called
  assert.equal(backend._inserted.length, 0,
    "no import_documents inserts expected before the rows guard");
});

// ── Summary ───────────────────────────────────────────────────────────────────

const total = passed + failed;
if (failed > 0) {
  console.error(`\n${passed}/${total} importer checks passed — ${failed} FAILED`);
  process.exit(1);
} else {
  console.log(`\n${passed}/${total} importer checks passed`);
}
