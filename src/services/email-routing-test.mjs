/**
 * email-routing-test.mjs
 *
 * Tests for Module A · Pre-Ingestion · Task 1 · Email Routing.
 *
 * Tests are grouped into four areas:
 *   A. Edge Function logic  — webhook auth, routing lookup, idempotency,
 *                             attachment storage path, DB row creation,
 *                             transient-error/retry semantics
 *   B. Service layer        — createRoutingAddress, listMessages,
 *                             getMessage, listPendingAttachments,
 *                             getAttachmentFile, markAttachmentIngested
 *   C. Ingestion handoff    — File object produced by getAttachmentFile
 *                             passes to fileToText-compatible checks
 *   D. Organization isolation — queries never return another org's data
 *
 * Uses a lightweight in-memory mock backend; no real DB or network required.
 *
 * A13–A17 import and call the PRODUCTION processAttachments() function from
 * attachment-processor.mjs so changes to that logic are automatically covered.
 */

import {createRecords} from "../backend/records.js";
import {executeSupabaseRecordQuery, createSupabaseInbox} from "../backend/supabase.js";
import {providerResult} from "../backend/contract.js";

import { processAttachments, base64ToBytes as processorBase64 } from
  "../../supabase/functions/inbound-email/attachment-processor.mjs";

// ── helpers ────────────────────────────────────────────────────────────────

let pass = 0, fail = 0;

function t(label, actual, expected) {
  const ok = actual === expected || (
    typeof expected === "number" && typeof actual === "number" &&
    Math.abs(actual - expected) < 0.001
  );
  if (ok) { pass++; }
  else {
    fail++;
    console.log(`FAIL  ${label}`);
    console.log(`      got:    ${JSON.stringify(actual)}`);
    console.log(`      wanted: ${JSON.stringify(expected)}`);
  }
}

function ok(label, cond) {
  if (cond) { pass++; }
  else {
    fail++;
    console.log(`FAIL  ${label}`);
  }
}

async function rejects(label, fn) {
  try { await fn(); fail++; console.log(`FAIL  ${label}  (no error thrown)`); }
  catch { pass++; }
}

// ── in-memory mock backend ─────────────────────────────────────────────────
// Simulates the Supabase client interface used by email-routing.js and
// attachment-processor.mjs.

// FK map for single-level join resolution in the mock.
const JOIN_FK = {
  inbound_attachments: { parent: "inbound_messages", fk: "message_id" },
  inbound_messages:    { parent: "email_routing_addresses", fk: "routing_address_id" },
};

function makeMockBackend(seed = {}) {
  const tables = {
    email_routing_addresses: [...(seed.email_routing_addresses ?? [])],
    inbound_messages:        [...(seed.inbound_messages ?? [])],
    inbound_attachments:     [...(seed.inbound_attachments ?? [])],
  };

  // storage: { bucketName: { path: bytes } }
  const storage = seed.storage ? { ...seed.storage } : { documents: {} };

  function buildQuery(tableName) {
    let rows = tables[tableName].map(r => ({ ...r }));
    let insertPayload = null;
    let updatePayload = null;
    let singleMode = false;
    let maybeSingleMode = false;
    let joinTables = [];
    let error = null;

    const q = {
      select(fields) {
        const joinRegex = /\b([a-z_]+)\s*\(/g;
        let m;
        while ((m = joinRegex.exec(fields)) !== null) {
          if (m[1] !== tableName) joinTables.push(m[1]);
        }
        return q;
      },
      eq(field, value)  { rows = rows.filter(r => r[field] === value); return q; },
      in(field, values) { rows = rows.filter(r => values.includes(r[field])); return q; },
      is(field, value)  {
        rows = rows.filter(r => r[field] === value || (value === null && r[field] == null));
        return q;
      },
      or(filterStr) {
        // Minimal PostgREST `.or()` parser for the subset used in tests.
        // Handles "col.is.null" and "col.eq.value" clauses joined by commas.
        // Example: "import_document_id.is.null,processing_status.eq.needs_review"
        const clauses = filterStr.split(",").map(s => s.trim());
        rows = rows.filter(row => clauses.some(clause => {
          const parts = clause.split(".");
          const col = parts[0];
          const op  = parts[1];
          const val = parts.slice(2).join(".");
          if (op === "is" && val === "null")  return row[col] == null;
          if (op === "is" && val === "notnull") return row[col] != null;
          if (op === "eq") return String(row[col]) === val;
          if (op === "neq") return String(row[col]) !== val;
          return false;
        }));
        return q;
      },
      order(field, { ascending = true } = {}) {
        rows.sort((a, b) => {
          if (a[field] < b[field]) return ascending ? -1 : 1;
          if (a[field] > b[field]) return ascending ? 1 : -1;
          return 0;
        });
        return q;
      },
      range(from, to) { rows = rows.slice(from, to + 1); return q; },
      insert(payload) {
        insertPayload = Array.isArray(payload) ? payload : [payload];
        return q;
      },
      update(payload) { updatePayload = payload; return q; },
      single()      { singleMode = true; return q; },
      maybeSingle() { maybeSingleMode = true; return q; },

      then(resolve, reject) {
        return Promise.resolve().then(() => {
          if (error) return resolve({ data: null, error });

          if (insertPayload) {
            const inserted = insertPayload.map(p => ({
              id: `mock-${Date.now()}-${Math.random().toString(36).slice(2)}`,
              created_at: new Date().toISOString(),
              ...p,
            }));
            tables[tableName].push(...inserted);
            const data = singleMode ? inserted[0] : inserted;
            return resolve({ data, error: null });
          }

          if (updatePayload) {
            const ids = new Set(rows.map(r => r.id));
            tables[tableName].forEach((r, i) => {
              if (ids.has(r.id)) tables[tableName][i] = { ...r, ...updatePayload };
            });
            const updated = tables[tableName].filter(r => ids.has(r.id));
            if (singleMode && updated.length !== 1) {
              return resolve({ data: null, error: { message: "expected exactly one row" } });
            }
            return resolve({ data: singleMode ? updated[0] : null, error: null });
          }

          let resultRows = rows;
          if (joinTables.length > 0) {
            resultRows = rows.map(row => {
              const augmented = { ...row };
              for (const childTable of joinTables) {
                const childRows = tables[childTable] ?? [];
                const fk = (JOIN_FK[childTable] ?? {}).fk;
                augmented[childTable] = fk
                  ? childRows.filter(cr => cr[fk] === row.id)
                  : [];
              }
              return augmented;
            });
          }

          if (singleMode) {
            if (resultRows.length === 0) return resolve({ data: null, error: { message: "no rows" } });
            if (resultRows.length > 1) return resolve({ data: null, error: { message: "multiple rows" } });
            return resolve({ data: resultRows[0], error: null });
          }
          if (maybeSingleMode) {
            return resolve({ data: resultRows[0] ?? null, error: null });
          }
          return resolve({ data: resultRows, error: null });
        }).catch(reject);
      },
    };
    return q;
  }

  // ── Storage mock ───────────────────────────────────────────────────────────
  // Enforces upsert:false semantics: returns 409 when the path already exists.
  const storageApi = {
    from(bucket) {
      return {
        upload(path, bytes, opts = {}) {
          storage[bucket] = storage[bucket] ?? {};
          if (opts && opts.upsert === false && storage[bucket][path] != null) {
            return Promise.resolve({
              data: null,
              error: { statusCode: "409", message: "The resource already exists" },
            });
          }
          storage[bucket][path] = bytes;
          return Promise.resolve({ data: { path }, error: null });
        },
        createSignedUrl(path, _ttl) {
          const exists = storage[bucket]?.[path] != null;
          if (!exists) return Promise.resolve({ data: null, error: { message: "not found" } });
          return Promise.resolve({
            data: { signedUrl: `mock://signed/${bucket}/${path}` }, error: null,
          });
        },
      };
    },
  };

  // ── RPC mock ───────────────────────────────────────────────────────────────
  //
  // Mirrors the SECURITY DEFINER mark_attachment_ingested() DB function,
  // including the Gap B and Gap C additions from migration_032_email_routing_addendum.sql:
  //
  //   Gap B: reject rows where ingest_error IS NOT NULL or storage_path IS NULL.
  //   Gap C: idempotent when the same import_document_id is presented again;
  //          still rejects a different document ID.
  function rpc(funcName, args) {
    if (funcName === "mark_attachment_ingested") {
      // null check (original behaviour)
      if (args.p_import_document_id == null) {
        return Promise.resolve({ data: null, error: { message: "p_import_document_id cannot be null" } });
      }
      const att = tables.inbound_attachments.find(r => r.id === args.p_attachment_id);
      if (!att) {
        return Promise.resolve({ data: null, error: { message: `attachment not found: ${args.p_attachment_id}` } });
      }
      // Gap B: reject permanently-failed attachments
      if (att.ingest_error != null) {
        return Promise.resolve({ data: null, error: { message: `attachment has a decode error and cannot be ingested: ${att.ingest_error}` } });
      }
      // Gap B: reject rows with no storage path
      if (att.storage_path == null) {
        return Promise.resolve({ data: null, error: { message: "attachment has no storage path and cannot be ingested" } });
      }
      // Gap C: idempotent — same doc ID returns success
      if (att.import_document_id === args.p_import_document_id) {
        return Promise.resolve({ data: null, error: null });
      }
      // already linked to a different document
      if (att.import_document_id !== null) {
        return Promise.resolve({ data: null, error: { message: "attachment already linked to a different import document" } });
      }
      att.import_document_id = args.p_import_document_id;
      return Promise.resolve({ data: null, error: null });
    }
    return Promise.resolve({ data: null, error: { message: `unknown function: ${funcName}` } });
  }

  const backend = {
    from(tableName) { return buildQuery(tableName); },
    rpc,
    storage: storageApi,
    functions: {
      async invoke() { return { data: { outcome: "auto_imported" }, error: null }; },
    },
    _tables: tables,
    _storage: storage,
    // Allow tests to inject a forced upload error on the next call
    _nextUploadError: null,
  };
  backend.records=createRecords(spec=>executeSupabaseRecordQuery(backend,spec));
  backend.documents={signedUrl:(path,seconds)=>providerResult(backend.storage.from("documents").createSignedUrl(path,seconds),"Open document")};
  backend.inbox=createSupabaseInbox(backend);
  return backend;
}

// Variant: backend with a forced transient upload error for one path
function makeMockBackendWithUploadError(seed = {}, errorPath = null) {
  const backend = makeMockBackend(seed);
  const originalStorage = backend.storage;
  backend.storage = {
    from(bucket) {
      const orig = originalStorage.from(bucket);
      return {
        ...orig,
        upload(path, bytes, opts = {}) {
          if (errorPath && path.includes(errorPath)) {
            return Promise.resolve({
              data: null,
              error: { statusCode: "500", message: "Storage service unavailable" },
            });
          }
          return orig.upload(path, bytes, opts);
        },
        createSignedUrl: orig.createSignedUrl.bind(orig),
      };
    },
  };
  return backend;
}

// ── Import the service under test ──────────────────────────────────────────

import { isDispatchable, isTerminal, VALID_OUTCOMES } from "../../supabase/functions/inbound-email/attachment-state.mjs";

import {
  createRoutingAddress,
  routingAddressError,
  listRoutingAddresses,
  setRoutingAddressVendor,
  setRoutingAddressDocumentType,
  deactivateRoutingAddress,
  listMessages,
  getMessage,
  listPendingAttachments,
  markAttachmentIngested,
} from "./email-routing.js";

// ── Edge Function auth / routing helpers (replicated for unit tests) ────────

function verifyBasicAuth(authHeader, expectedUser, expectedPass) {
  if (!authHeader || !authHeader.startsWith("Basic ")) return false;
  try {
    const b64 = authHeader.slice("Basic ".length);
    const decoded = atob(b64);
    const colonIndex = decoded.indexOf(":");
    if (colonIndex < 0) return false;
    const user = decoded.slice(0, colonIndex);
    const pass = decoded.slice(colonIndex + 1);
    if (user.length !== expectedUser.length || pass.length !== expectedPass.length) return false;
    let mismatch = 0;
    for (let i = 0; i < user.length; i++) mismatch |= user.charCodeAt(i) ^ expectedUser.charCodeAt(i);
    for (let i = 0; i < pass.length; i++) mismatch |= pass.charCodeAt(i) ^ expectedPass.charCodeAt(i);
    return mismatch === 0;
  } catch { return false; }
}

function _base64ToBytes(b64) {
  const clean = b64.replace(/\s/g, "");
  const binary = atob(clean);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Gap D: stable Storage key — index only, no filename in the key.
function buildStoragePath(orgId, messageId, attachmentIndex) {
  return `${orgId}/inbound/${messageId}/${attachmentIndex}`;
}

// ── Section A: Edge Function logic ────────────────────────────────────────

console.log("\n── A. Edge Function logic ──────────────────────────────────────────────");

{
  // A1. HTTP Basic auth: correct credentials
  const header = "Basic " + btoa("webhook-user:s3cr3t");
  t("A1: correct credentials accepted", verifyBasicAuth(header, "webhook-user", "s3cr3t"), true);
}

{
  // A2. HTTP Basic auth: wrong password
  const header = "Basic " + btoa("webhook-user:wrong");
  t("A2: wrong password rejected", verifyBasicAuth(header, "webhook-user", "s3cr3t"), false);
}

{
  // A3. HTTP Basic auth: wrong scheme
  t("A3: Bearer scheme rejected", verifyBasicAuth("Bearer token", "webhook-user", "s3cr3t"), false);
}

{
  // A4. HTTP Basic auth: missing header
  t("A4: null header rejected", verifyBasicAuth(null, "webhook-user", "s3cr3t"), false);
}

{
  // A5. HTTP Basic auth: empty credentials block
  t("A5: empty auth rejected", verifyBasicAuth("Basic ", "webhook-user", "s3cr3t"), false);
}

{
  // A6. Storage path uses only the attachment index (Gap D: filename excluded from key)
  const path = buildStoragePath("org-1", "msg-1", 0);
  t("A6: storage path uses index only (no filename)", path, "org-1/inbound/msg-1/0");
}

{
  // A7. Storage path: index is the only variable segment (Gap D)
  const path = buildStoragePath("org-abc", "msg-xyz", 2);
  t("A7: multi-attachment index path stable", path, "org-abc/inbound/msg-xyz/2");
}

{
  // A8. base64ToBytes from attachment-processor.mjs produces correct bytes
  const encoded = btoa("Hello, KERDOS!");
  const bytes = processorBase64(encoded);
  const decoded = new TextDecoder().decode(bytes);
  t("A8: base64 round-trip correct (production function)", decoded, "Hello, KERDOS!");
}

{
  // A9. base64 decode: whitespace in content (Postmark may wrap lines)
  const raw = btoa("test bytes");
  const withWhitespace = raw.slice(0, 4) + "\n" + raw.slice(4) + " \n";
  const bytes = processorBase64(withWhitespace);
  t("A9: whitespace in base64 stripped (production function)", new TextDecoder().decode(bytes), "test bytes");
}

{
  // A10. Routing lookup: unknown address → no org
  const backend = makeMockBackend({
    email_routing_addresses: [
      { id: "ra-1", organization_id: "org-1", routing_address: "acme@inbound.kerdos.com", is_active: true },
    ],
  });

  const { data } = await backend
    .from("email_routing_addresses")
    .select("id, organization_id")
    .eq("routing_address", "unknown@inbound.kerdos.com")
    .eq("is_active", true)
    .maybeSingle();

  t("A10: unknown routing address returns null", data, null);
}

{
  // A11. Idempotency: second call with same postmark_message_id returns existing row
  const backend = makeMockBackend({
    inbound_messages: [{
      id: "msg-exists",
      organization_id: "org-1",
      routing_address_id: "ra-1",
      postmark_message_id: "pm-abc123",
      sender_email: "vendor@example.com",
      received_at: new Date().toISOString(),
    }],
  });

  const { data: existing } = await backend
    .from("inbound_messages")
    .select("id")
    .eq("postmark_message_id", "pm-abc123")
    .eq("organization_id", "org-1")
    .maybeSingle();

  ok("A11: duplicate postmark_message_id found before insert",
    existing !== null && existing.id === "msg-exists");
}

{
  // A12. Attachment row: import_document_id starts as null; attachment_index is stored
  const backend = makeMockBackend();
  await backend
    .from("inbound_attachments")
    .insert({
      organization_id:  "org-1",
      message_id:       "msg-1",
      attachment_index: 0,
      filename:         "invoice.pdf",
      content_type:     "application/pdf",
      file_size_bytes:  1024,
      storage_path:     "org-1/inbound/msg-1/0",
      import_document_id: null,
    });

  const rows = backend._tables.inbound_attachments;
  t("A12: attachment row created with null import_document_id", rows[0].import_document_id, null);
  t("A12: attachment_index stored", rows[0].attachment_index, 0);
  t("A12: storage_path is index-only (Gap D)", rows[0].storage_path, "org-1/inbound/msg-1/0");
}

{
  // A13. Duplicate delivery: processAttachments is a no-op when all attachments
  //      are already present.  Calls the PRODUCTION processAttachments function.
  const orgId = "org-a13";
  const msgId = "msg-a13";

  const backend = makeMockBackend({
    inbound_messages: [{
      id: msgId,
      organization_id: orgId,
      routing_address_id: "ra-a13",
      postmark_message_id: "pm-a13",
      sender_email: "vendor@example.com",
      received_at: new Date().toISOString(),
    }],
    inbound_attachments: [
      {
        id: "att-a13-0",
        organization_id: orgId,
        message_id: msgId,
        attachment_index: 0,
        filename: "invoice.pdf",
        content_type: "application/pdf",
        file_size_bytes: 512,
        storage_path: `${orgId}/inbound/${msgId}/0`,
        import_document_id: null,
      },
      {
        id: "att-a13-1",
        organization_id: orgId,
        message_id: msgId,
        attachment_index: 1,
        filename: "prices.xlsx",
        content_type: "application/vnd.ms-excel",
        file_size_bytes: 256,
        storage_path: `${orgId}/inbound/${msgId}/1`,
        import_document_id: null,
      },
    ],
    storage: {
      documents: {
        [`${orgId}/inbound/${msgId}/0`]: new Uint8Array([1]),
        [`${orgId}/inbound/${msgId}/1`]: new Uint8Array([2]),
      },
    },
  });

  const attachments = [
    { Name: "invoice.pdf", Content: btoa("pdf"), ContentType: "application/pdf",        ContentLength: 512 },
    { Name: "prices.xlsx", Content: btoa("xls"), ContentType: "application/vnd.ms-excel", ContentLength: 256 },
  ];

  const countBefore = backend._tables.inbound_attachments.length;
  // Should complete without throwing (all already stored)
  let threw = false;
  try {
    await processAttachments(backend, orgId, msgId, attachments);
  } catch {
    threw = true;
  }
  t("A13: duplicate delivery does not throw", threw, false);
  t("A13: no extra attachment rows written", backend._tables.inbound_attachments.length, countBefore);
}

{
  // A14. Resume after partial failure: processAttachments stores only the
  //      missing attachment and skips the already-stored one.
  //      Calls the PRODUCTION processAttachments function.
  const orgId = "org-a14";
  const msgId = "msg-a14";

  const backend = makeMockBackend({
    inbound_messages: [{
      id: msgId,
      organization_id: orgId,
      routing_address_id: "ra-a14",
      postmark_message_id: "pm-a14",
      sender_email: "vendor@example.com",
      received_at: new Date().toISOString(),
    }],
    // First delivery stored index 0 (invoice.pdf) but crashed before index 1 (prices.xlsx)
    inbound_attachments: [{
      id: "att-a14-0",
      organization_id: orgId,
      message_id: msgId,
      attachment_index: 0,
      filename: "invoice.pdf",
      content_type: "application/pdf",
      file_size_bytes: 512,
      storage_path: `${orgId}/inbound/${msgId}/0`,
      import_document_id: null,
    }],
    storage: {
      documents: {
        [`${orgId}/inbound/${msgId}/0`]: new Uint8Array([1, 2, 3]),
      },
    },
  });

  const retryAttachments = [
    { Name: "invoice.pdf", Content: btoa("fake pdf bytes"),  ContentType: "application/pdf",          ContentLength: 512 },
    { Name: "prices.xlsx", Content: btoa("fake xlsx bytes"), ContentType: "application/vnd.ms-excel", ContentLength: 256 },
  ];

  await processAttachments(backend, orgId, msgId, retryAttachments);

  const finalAtts = backend._tables.inbound_attachments.filter(a => a.message_id === msgId);
  t("A14: final attachment count is 2", finalAtts.length, 2);
  ok("A14: index 0 (invoice.pdf) present",
    finalAtts.some(a => a.attachment_index === 0 && a.filename === "invoice.pdf"));
  ok("A14: index 1 (prices.xlsx) present",
    finalAtts.some(a => a.attachment_index === 1 && a.filename === "prices.xlsx"));

  // Gap D: Storage key is {orgId}/inbound/{msgId}/{index} — no filename
  const xlsxPath = `${orgId}/inbound/${msgId}/1`;
  ok("A14: prices.xlsx uploaded to Storage at index-only path", backend._storage.documents[xlsxPath] != null);

  // invoice.pdf was NOT re-uploaded (upsert:false would conflict → skip via index check)
  const pdfPath = `${orgId}/inbound/${msgId}/0`;
  ok("A14: invoice.pdf path unchanged in Storage",
    backend._storage.documents[pdfPath] != null);
}

{
  // A15. Storage exists but DB row absent → processAttachments recovers by inserting
  //      the DB row rather than throwing.
  //
  // Scenario: a prior request uploaded the file to Storage but crashed before
  // writing the DB row (orphaned object).  processAttachments must NOT throw;
  // it inserts the missing DB row using the deterministic storagePath.
  const orgId = "org-a15";
  const msgId = "msg-a15";

  const backend = makeMockBackend({
    inbound_messages: [{
      id: msgId,
      organization_id: orgId,
      routing_address_id: "ra-a15",
      postmark_message_id: "pm-a15",
      sender_email: "vendor@example.com",
      received_at: new Date().toISOString(),
    }],
    // No inbound_attachments row — DB write never happened
    storage: {
      documents: {
        // But the file IS in Storage (prior request uploaded it).
        // Gap D: key is index-only; must match what processAttachments computes
        // so that the upload sees a 409 and takes the recovery path.
        [`${orgId}/inbound/${msgId}/0`]: new Uint8Array([1]),
      },
    },
  });

  const attachments = [
    { Name: "invoice.pdf", Content: btoa("bytes"), ContentType: "application/pdf", ContentLength: 100 },
  ];

  let threw = false;
  try {
    await processAttachments(backend, orgId, msgId, attachments);
  } catch {
    threw = true;
  }
  t("A15: Storage-exists-but-no-DB-row does NOT throw (recovery path)", threw, false);

  // Recovery must have inserted the DB row
  const recovered = backend._tables.inbound_attachments.find(
    a => a.message_id === msgId && a.attachment_index === 0
  );
  ok("A15: recovery INSERT wrote the DB row", recovered != null);
  // Gap D: recovered storage_path is index-only
  t("A15: recovered row has correct storage_path",
    recovered?.storage_path, `${orgId}/inbound/${msgId}/0`);
  t("A15: recovered row has null import_document_id", recovered?.import_document_id ?? null, null);
}

{
  // A18. Malformed base64 → ingest_error row inserted, no throw.
  //
  // If Postmark sends an attachment with a Content field that cannot be decoded,
  // processAttachments must NOT throw.  Instead it inserts a visible error row
  // with storage_path = null and ingest_error set to the decode error message.
  const orgId = "org-a18";
  const msgId = "msg-a18";

  const backend = makeMockBackend({
    inbound_messages: [{
      id: msgId,
      organization_id: orgId,
      routing_address_id: "ra-a18",
      postmark_message_id: "pm-a18",
      sender_email: "vendor@example.com",
      received_at: new Date().toISOString(),
    }],
  });

  const attachments = [
    // "!!invalid!!" is not valid base64 — atob will throw
    { Name: "corrupt.pdf", Content: "!!invalid!!", ContentType: "application/pdf", ContentLength: 0 },
  ];

  let threw = false;
  try {
    await processAttachments(backend, orgId, msgId, attachments);
  } catch {
    threw = true;
  }
  t("A18: malformed base64 does NOT throw", threw, false);

  const errRow = backend._tables.inbound_attachments.find(
    a => a.message_id === msgId && a.attachment_index === 0
  );
  ok("A18: ingest_error row was inserted", errRow != null);
  t("A18: storage_path is null (no file stored)", errRow?.storage_path ?? null, null);
  ok("A18: ingest_error field contains decode error message",
    typeof errRow?.ingest_error === "string" && errRow.ingest_error.includes("base64 decode failed"));
  t("A18: import_document_id is null", errRow?.import_document_id ?? null, null);
}

{
  // A19. Gap A: transient DB error on ingest_error insert → retry, then throw.
  //
  // If the INSERT for the error row fails with a non-23505 code (transient DB
  // error), processAttachments must retry once.  If the retry also fails, it
  // must throw so Postmark retries the entire webhook and gets another chance
  // to record the failure row.
  const orgId = "org-a19";
  const msgId = "msg-a19";

  let insertCallCount = 0;
  const backend = makeMockBackend({
    inbound_messages: [{
      id: msgId,
      organization_id: orgId,
      routing_address_id: "ra-a19",
      postmark_message_id: "pm-a19",
      sender_email: "vendor@example.com",
      received_at: new Date().toISOString(),
    }],
  });

  // Override to return a transient (non-23505) DB error on every INSERT for
  // inbound_attachments, simulating a momentary DB blip during the error-row write.
  const originalFrom = backend.from.bind(backend);
  backend.from = function(tableName) {
    const q = originalFrom(tableName);
    if (tableName === "inbound_attachments") {
      const originalInsert = q.insert.bind(q);
      q.insert = function(payload) {
        insertCallCount++;
        // Return a generic transient error (not 23505) for both initial attempt and retry
        const fake = originalInsert(payload);
        fake.then = function(resolve) {
          return Promise.resolve().then(() =>
            resolve({ data: null, error: { code: "40001", message: "transient serialization error" } })
          );
        };
        return fake;
      };
    }
    return q;
  };

  const attachments = [
    { Name: "corrupt.pdf", Content: "!!invalid!!", ContentType: "application/pdf", ContentLength: 0 },
  ];

  let threw = false;
  try {
    await processAttachments(backend, orgId, msgId, attachments);
  } catch {
    threw = true;
  }
  ok("A19: transient DB error on both insert attempts causes throw", threw);
  // Both the initial attempt and the retry were made (Gap A: exactly 2 inserts)
  t("A19: INSERT was attempted twice (initial + retry)", insertCallCount, 2);
}

{
  // A16. Transient storage upload error → processAttachments throws.
  //
  // A non-409 upload error (e.g. 500 Service Unavailable) is transient; the
  // function must throw so Postmark retries rather than returning 200 silently.
  const orgId = "org-a16";
  const msgId = "msg-a16";

  const backend = makeMockBackendWithUploadError({
    inbound_messages: [{
      id: msgId,
      organization_id: orgId,
      routing_address_id: "ra-a16",
      postmark_message_id: "pm-a16",
      sender_email: "vendor@example.com",
      received_at: new Date().toISOString(),
    }],
  // Gap D: Storage key is now index-only; match on org prefix so the error fires.
  }, "org-a16");  // force 500 on any path containing "org-a16"

  const attachments = [
    { Name: "prices.xlsx", Content: btoa("bytes"), ContentType: "application/vnd.ms-excel", ContentLength: 256 },
  ];

  await rejects("A16: transient upload error throws (→ HTTP 500)", async () => {
    await processAttachments(backend, orgId, msgId, attachments);
  });
}

{
  // A17. Concurrent 23505 on attachment INSERT → treated as success.
  //
  // Two concurrent requests both pass the existence check and race to INSERT.
  // The loser gets 23505. processAttachments must NOT throw — the attachment
  // is durably stored by the winner.
  //
  // We simulate this with a custom backend whose INSERT for inbound_attachments
  // returns 23505 while the row (simulated as already present) is detectable.
  const orgId = "org-a17";
  const msgId = "msg-a17";

  // Simulate: DB insert returns 23505 on the first call
  let insertCallCount = 0;
  const backend = makeMockBackend({
    inbound_messages: [{
      id: msgId,
      organization_id: orgId,
      routing_address_id: "ra-a17",
      postmark_message_id: "pm-a17",
      sender_email: "vendor@example.com",
      received_at: new Date().toISOString(),
    }],
  });

  // Override the from() method to inject a 23505 error on the first INSERT
  const originalFrom = backend.from.bind(backend);
  backend.from = function(tableName) {
    const q = originalFrom(tableName);
    if (tableName === "inbound_attachments") {
      const _originalThen = q.then.bind(q);
      // Wrap .insert() to force 23505 on first call
      const originalInsert = q.insert.bind(q);
      q.insert = function(payload) {
        insertCallCount++;
        if (insertCallCount === 1) {
          // Another request won: its row must be visible on the winner lookup.
          backend._tables.inbound_attachments.push({ id: "att-winner-a17", ...payload });
          q.then = function(resolve) {
            return Promise.resolve().then(() =>
              resolve({ data: null, error: { code: "23505", message: "duplicate key value" } })
            );
          };
          return q;
        }
        return originalInsert(payload);
      };
    }
    return q;
  };

  const attachments = [
    { Name: "invoice.pdf", Content: btoa("bytes"), ContentType: "application/pdf", ContentLength: 100 },
  ];

  let threw = false;
  try {
    await processAttachments(backend, orgId, msgId, attachments);
  } catch (e) {
    threw = true;
    console.log(`  A17 threw: ${e.message}`);
  }
  t("A17: concurrent 23505 on attachment INSERT does not throw", threw, false);
  t("A17: INSERT was attempted", insertCallCount >= 1, true);
}

// ── Section B: Service layer ───────────────────────────────────────────────

console.log("\n── B. Service layer ────────────────────────────────────────────────────");

{
  // B1. createRoutingAddress normalizes to lowercase
  const backend = makeMockBackend();
  const row = await createRoutingAddress(backend, "org-1", {
    routingAddress: "Acme-Pricing@Inbound.KERDOS.COM",
    label: "Pricing",
  });
  t("B1: routing address lowercased", row.routing_address, "acme-pricing@inbound.kerdos.com");
  t("B1: organization_id stored", row.organization_id, "org-1");
  t("B1: no selected vendor means manual review", row.vendor_id, null);
  t("B1: default production address allowed", routingAddressError("a@inbound.kerdos.com"), null);
  t("B1: test stream accepts its assigned address", routingAddressError("HASH@inbound.postmarkapp.com", "hash@inbound.postmarkapp.com"), null);
  t("B1: test stream rejects another Postmark address", routingAddressError("other@inbound.postmarkapp.com", "hash@inbound.postmarkapp.com"), "Routing address must be hash@inbound.postmarkapp.com");
}

{
  const backend = makeMockBackend({
    email_routing_addresses: [
      { id: "ra-own", organization_id: "org-1", vendor_id: null, is_active: true },
      { id: "ra-other", organization_id: "org-2", vendor_id: null, is_active: true },
    ],
  });
  const created = await createRoutingAddress(backend, "org-1", {
    routingAddress: "vendor@inbound.kerdos.com", vendorId: "vendor-1",
  });
  t("B1: selected vendor is stored on new address", created.vendor_id, "vendor-1");
  const assigned = await setRoutingAddressVendor(backend, "org-1", "ra-own", "vendor-1");
  t("B1: existing address gets selected vendor", assigned.vendor_id, "vendor-1");
  const listed = await listRoutingAddresses(backend, "org-1");
  t("B1: address list includes vendor assignment", listed.find(a => a.id === "ra-own").vendor_id, "vendor-1");
  await setRoutingAddressVendor(backend, "org-1", "ra-own", null);
  t("B1: clearing vendor restores manual review", backend._tables.email_routing_addresses[0].vendor_id, null);
  await rejects("B1: another organization's address cannot be changed", async () => {
    await setRoutingAddressVendor(backend, "org-1", "ra-other", "vendor-1");
  });
  t("B1: other organization remains unchanged", backend._tables.email_routing_addresses[1].vendor_id, null);
}

{
  // B2. createRoutingAddress: missing routingAddress throws
  await rejects("B2: createRoutingAddress throws without address", async () => {
    await createRoutingAddress(makeMockBackend(), "org-1", {});
  });
}

{
  // B3. listRoutingAddresses returns only active rows for the org
  const backend = makeMockBackend({
    email_routing_addresses: [
      { id: "ra-1", organization_id: "org-1", routing_address: "a@x.com", is_active: true },
      { id: "ra-2", organization_id: "org-1", routing_address: "b@x.com", is_active: false },
      { id: "ra-3", organization_id: "org-2", routing_address: "c@x.com", is_active: true },
    ],
  });
  const rows = await listRoutingAddresses(backend, "org-1");
  t("B3: only active rows for own org", rows.length, 1);
  t("B3: correct address returned", rows[0].routing_address, "a@x.com");
}

{
  // B4. deactivateRoutingAddress sets is_active = false
  const backend = makeMockBackend({
    email_routing_addresses: [
      { id: "ra-1", organization_id: "org-1", routing_address: "a@x.com", is_active: true },
    ],
  });
  await deactivateRoutingAddress(backend, "org-1", "ra-1");
  const row = backend._tables.email_routing_addresses.find(r => r.id === "ra-1");
  t("B4: is_active set to false", row.is_active, false);
}

{
  // B5. listMessages returns messages newest-first with attachment counts
  const now = new Date();
  const older = new Date(now.getTime() - 60000).toISOString();
  const newer = now.toISOString();

  const backend = makeMockBackend({
    inbound_messages: [
      { id: "m1", organization_id: "org-1", routing_address_id: "ra-1",
        postmark_message_id: "pm-1", sender_email: "v@x.com", received_at: older },
      { id: "m2", organization_id: "org-1", routing_address_id: "ra-1",
        postmark_message_id: "pm-2", sender_email: "v@x.com", received_at: newer },
    ],
    inbound_attachments: [
      { id: "a1", organization_id: "org-1", message_id: "m1",
        filename: "inv.pdf", import_document_id: null },
      { id: "a2", organization_id: "org-1", message_id: "m1",
        filename: "sheet.xlsx", import_document_id: "doc-1" },  // already ingested
    ],
  });

  const msgs = await listMessages(backend, "org-1");
  t("B5: newest message first", msgs[0].id, "m2");
  t("B5: message 1 has 2 attachments", msgs[1].attachment_count, 2);
  t("B5: message 1 has 1 pending", msgs[1].pending_count, 1);
}

{
  // Cross-task: recovery can leave a linked partial pending, while an active
  // worker is processing another attachment. The badge must agree with the
  // actions actually offered in AttachmentRow.
  const backend = makeMockBackend({
    inbound_messages: [{ id: "m-states", organization_id: "org-1", received_at: new Date().toISOString() }],
    inbound_attachments: [
      { id: "recovering", message_id: "m-states", import_document_id: "doc-1", processing_status: "pending" },
      { id: "working", message_id: "m-states", import_document_id: null, processing_status: "processing" },
      { id: "done", message_id: "m-states", import_document_id: "doc-2", processing_status: "auto_imported" },
      { id: "decode", message_id: "m-states", import_document_id: null, processing_status: "pending", ingest_error: "bad base64" },
    ],
  });
  const [message] = await listMessages(backend, "org-1");
  t("B5 cross-task: only recovered partial counts as actionable", message.pending_count, 1);
}

{
  // B6. listMessages: org isolation — only own messages
  const backend = makeMockBackend({
    inbound_messages: [
      { id: "m1", organization_id: "org-1", routing_address_id: "ra-1",
        postmark_message_id: "pm-1", sender_email: "v@x.com", received_at: new Date().toISOString() },
      { id: "m2", organization_id: "org-2", routing_address_id: "ra-2",
        postmark_message_id: "pm-2", sender_email: "v@x.com", received_at: new Date().toISOString() },
    ],
  });
  const msgs = await listMessages(backend, "org-1");
  t("B6: only own org messages returned", msgs.length, 1);
  t("B6: correct message", msgs[0].id, "m1");
}

{
  // B7. getMessage returns message with attachments including body_text
  const backend = makeMockBackend({
    inbound_messages: [
      { id: "m1", organization_id: "org-1", routing_address_id: "ra-1",
        postmark_message_id: "pm-1", sender_email: "v@x.com",
        body_text: "Please find attached.", received_at: new Date().toISOString() },
    ],
    inbound_attachments: [
      { id: "a1", organization_id: "org-1", message_id: "m1",
        filename: "prices.xlsx", content_type: "application/vnd.ms-excel",
        storage_path: "org-1/inbound/m1/0-prices.xlsx", import_document_id: null },
    ],
  });

  const msg = await getMessage(backend, "org-1", "m1");
  ok("B7: getMessage returns row", msg !== null);
  t("B7: body_text present", msg.body_text, "Please find attached.");
}

{
  // B8. listPendingAttachments returns unprocessed AND background-partial attachments.
  // Fixed: old filter (.is("import_document_id", null)) excluded background partials
  // where import_document_id IS NOT NULL but processing_status = 'needs_review'.
  // Recovered linked pending rows are actionable too; processing rows and
  // decode-error rows must not appear as manual actions.
  const backend = makeMockBackend({
    inbound_messages: [
      { id: "m1", organization_id: "org-1", routing_address_id: "ra-1",
        postmark_message_id: "pm-1", sender_email: "v@x.com",
        subject: "Prices", received_at: new Date().toISOString() },
    ],
    inbound_attachments: [
      // a1: not yet processed — should appear
      { id: "a1", organization_id: "org-1", message_id: "m1",
        filename: "pending.pdf", storage_path: "org-1/inbound/m1/0-pending.pdf",
        import_document_id: null, processing_status: "pending",
        created_at: new Date().toISOString() },
      // a2: fully auto-imported — should NOT appear
      { id: "a2", organization_id: "org-1", message_id: "m1",
        filename: "done.pdf", storage_path: "org-1/inbound/m1/1-done.pdf",
        import_document_id: "doc-99", processing_status: "auto_imported",
        created_at: new Date().toISOString() },
      // a3: background partial that needs human review — should appear (Gap 5 fix)
      { id: "a3", organization_id: "org-1", message_id: "m1",
        filename: "partial.csv", storage_path: "org-1/inbound/m1/2-partial.csv",
        import_document_id: "doc-partial", processing_status: "needs_review",
        created_at: new Date().toISOString() },
      { id: "a4", organization_id: "org-1", message_id: "m1",
        filename: "recovered.csv", storage_path: "org-1/inbound/m1/3-recovered.csv",
        import_document_id: "doc-recovered", processing_status: "pending",
        created_at: new Date().toISOString() },
      { id: "a5", organization_id: "org-1", message_id: "m1",
        filename: "active.csv", storage_path: "org-1/inbound/m1/4-active.csv",
        import_document_id: null, processing_status: "processing",
        created_at: new Date().toISOString() },
      { id: "a6", organization_id: "org-1", message_id: "m1",
        filename: "broken.csv", storage_path: null, ingest_error: "bad base64",
        import_document_id: null, processing_status: "pending",
        created_at: new Date().toISOString() },
    ],
  });

  const pending = await listPendingAttachments(backend, "org-1");
  t("B8: pending + background + recovered partial attachments returned", pending.length, 3);
  const ids = pending.map(a => a.id).sort();
  t("B8: unprocessed attachment included", ids.includes("a1"), true);
  t("B8: background partial (needs_review) included", ids.includes("a3"), true);
  t("B8: recovered linked partial included", ids.includes("a4"), true);
  t("B8: active worker excluded", ids.includes("a5"), false);
  t("B8: decode error excluded", ids.includes("a6"), false);
  t("B8: auto_imported attachment excluded", ids.includes("a2"), false);
  t("B8: import_document_id present in result", pending.find(a => a.id === "a3").import_document_id, "doc-partial");
  t("B8: processing_status present in result", pending.find(a => a.id === "a3").processing_status, "needs_review");
}

{
  // B9. markAttachmentIngested sets import_document_id
  const backend = makeMockBackend({
    inbound_attachments: [
      { id: "a1", organization_id: "org-1", message_id: "m1",
        filename: "inv.pdf", storage_path: "org-1/inbound/m1/0-inv.pdf",
        import_document_id: null },
    ],
  });

  await markAttachmentIngested(backend, "org-1", "a1", "doc-42");
  const att = backend._tables.inbound_attachments.find(r => r.id === "a1");
  t("B9: import_document_id set", att.import_document_id, "doc-42");
}

{
  // B10. markAttachmentIngested: already-ingested attachment throws
  const backend = makeMockBackend({
    inbound_attachments: [
      { id: "a-ingested", organization_id: "org-1", message_id: "m1",
        filename: "inv.pdf", storage_path: "org-1/inbound/m1/0-inv.pdf",
        import_document_id: "doc-already" },
    ],
  });

  let threw = false;
  try {
    await markAttachmentIngested(backend, "org-1", "a-ingested", "doc-new");
  } catch { threw = true; }
  ok("B10: marking an already-ingested attachment throws", threw);
  const att = backend._tables.inbound_attachments.find(r => r.id === "a-ingested");
  t("B10: original import_document_id unchanged", att.import_document_id, "doc-already");
}

{
  // B11. markAttachmentIngested rejects a null importDocumentId
  const backend = makeMockBackend({
    inbound_attachments: [
      { id: "a1", organization_id: "org-1", message_id: "m1",
        filename: "inv.pdf", storage_path: "org-1/inbound/m1/0-inv.pdf",
        import_document_id: null },
    ],
  });

  let threw = false;
  try {
    await markAttachmentIngested(backend, "org-1", "a1", null);
  } catch { threw = true; }
  ok("B11: null importDocumentId throws", threw);
}

{
  // B12. Syntax is enforced without requiring a particular company domain.
  await rejects("B12: malformed address throws", async () => {
    await createRoutingAddress(makeMockBackend(), "org-1", {
      routingAddress: "acme@@otherdomain.com",
    });
  });

  // B12b. createRoutingAddress accepts a valid @inbound.kerdos.com address
  const backend = makeMockBackend();
  const row = await createRoutingAddress(backend, "org-1", {
    routingAddress: "acme-prices@inbound.kerdos.com",
  });
  t("B12: valid @inbound.kerdos.com address accepted", row.routing_address, "acme-prices@inbound.kerdos.com");
}

{
  // B13. Gap B: markAttachmentIngested rejects attachment with ingest_error set.
  //
  // An attachment that failed base64 decode has ingest_error IS NOT NULL.
  // The DB function must reject it so a decode-failure row can never be
  // marked as "imported" by a crafted RPC call.
  const backend = makeMockBackend({
    inbound_attachments: [
      { id: "a-err", organization_id: "org-1", message_id: "m1",
        filename: "corrupt.pdf",
        storage_path: null,
        ingest_error: "base64 decode failed: invalid character",
        import_document_id: null },
    ],
  });

  let threw = false;
  try {
    await markAttachmentIngested(backend, "org-1", "a-err", "doc-x");
  } catch { threw = true; }
  ok("B13: attachment with ingest_error cannot be marked ingested", threw);
  const att = backend._tables.inbound_attachments.find(r => r.id === "a-err");
  t("B13: import_document_id unchanged", att.import_document_id, null);
}

{
  // B14. Gap B: markAttachmentIngested rejects attachment with null storage_path.
  //
  // Belt-and-suspenders: even without ingest_error, a row with no storage_path
  // has no file and must not be importable.
  const backend = makeMockBackend({
    inbound_attachments: [
      { id: "a-nopath", organization_id: "org-1", message_id: "m1",
        filename: "missing.pdf",
        storage_path: null,
        ingest_error: null,
        import_document_id: null },
    ],
  });

  let threw = false;
  try {
    await markAttachmentIngested(backend, "org-1", "a-nopath", "doc-y");
  } catch { threw = true; }
  ok("B14: attachment with null storage_path cannot be marked ingested", threw);
}

{
  // B15. Gap C: markAttachmentIngested is idempotent when same import_document_id
  //      is passed again.
  //
  // Scenario: DB UPDATE succeeded but the RPC response was lost in transit;
  // caller retries with the same importDocumentId.  Must return success.
  const backend = makeMockBackend({
    inbound_attachments: [
      { id: "a-idem", organization_id: "org-1", message_id: "m1",
        filename: "sheet.xlsx",
        storage_path: "org-1/inbound/m1/0",
        ingest_error: null,
        import_document_id: "doc-42" },  // already linked to doc-42
    ],
  });

  let threw = false;
  try {
    await markAttachmentIngested(backend, "org-1", "a-idem", "doc-42");  // same ID
  } catch { threw = true; }
  ok("B15: retry with same import_document_id succeeds (idempotent)", !threw);
  const att = backend._tables.inbound_attachments.find(r => r.id === "a-idem");
  t("B15: import_document_id unchanged", att.import_document_id, "doc-42");
}

{
  // B16. Gap C: markAttachmentIngested still rejects a different import_document_id.
  //
  // A second import attempt with a DIFFERENT doc ID is still an error; only
  // the same doc ID gets idempotent success.
  const backend = makeMockBackend({
    inbound_attachments: [
      { id: "a-diff", organization_id: "org-1", message_id: "m1",
        filename: "sheet.xlsx",
        storage_path: "org-1/inbound/m1/0",
        ingest_error: null,
        import_document_id: "doc-42" },  // already linked to doc-42
    ],
  });

  let threw = false;
  try {
    await markAttachmentIngested(backend, "org-1", "a-diff", "doc-99");  // different ID
  } catch { threw = true; }
  ok("B16: different import_document_id still rejected", threw);
  const att = backend._tables.inbound_attachments.find(r => r.id === "a-diff");
  t("B16: original import_document_id preserved", att.import_document_id, "doc-42");
}

// ── Section C: Ingestion handoff ──────────────────────────────────────────

console.log("\n── C. Ingestion handoff ────────────────────────────────────────────────");

{
  // C1. Storage upload then signed URL: round-trip
  const backend = makeMockBackend();
  const path = "org-1/inbound/m1/0-invoice.pdf";
  const bytes = new TextEncoder().encode("fake pdf bytes");

  await backend.storage.from("documents").upload(path, bytes, { upsert: false });
  const { data: signed } = await backend.storage.from("documents").createSignedUrl(path, 60);
  ok("C1: signed URL created after upload", signed?.signedUrl?.includes("invoice.pdf"));
}

{
  // C2. Signed URL for non-existent path returns error
  const backend = makeMockBackend();
  const { error } = await backend.storage
    .from("documents")
    .createSignedUrl("org-1/inbound/m1/missing.pdf", 60);
  ok("C2: missing file returns error", error !== null);
}

{
  // C3. File object from getAttachmentFile has correct name and type
  const fakeFetch = globalThis.fetch;
  globalThis.fetch = async (url) => {
    const body = new TextEncoder().encode("fake content");
    return { ok: true, blob: async () => new Blob([body], { type: "application/pdf" }) };
  };

  const backend = makeMockBackend({
    inbound_attachments: [
      { id: "a1", organization_id: "org-1", message_id: "m1",
        filename: "prices.pdf", content_type: "application/pdf",
        storage_path: "org-1/inbound/m1/0-prices.pdf" },
    ],
    storage: { documents: { "org-1/inbound/m1/0-prices.pdf": new Uint8Array([1, 2, 3]) } },
  });

  const { getAttachmentFile } = await import("./email-routing.js");
  const file = await getAttachmentFile(backend, "org-1", "a1");

  t("C3: File has correct name", file.name, "prices.pdf");
  t("C3: File has correct type", file.type, "application/pdf");
  ok("C3: File is a File instance", file instanceof File);

  globalThis.fetch = fakeFetch;
}

{
  // C4. Attachment record on ingestion: import_document_id starts null,
  //     links to import_documents after markAttachmentIngested
  const backend = makeMockBackend({
    inbound_attachments: [
      { id: "a1", organization_id: "org-1", message_id: "m1",
        filename: "sheet.xlsx", storage_path: "org-1/inbound/m1/0-sheet.xlsx",
        import_document_id: null },
    ],
  });

  const before = backend._tables.inbound_attachments[0].import_document_id;
  t("C4: import_document_id is null before ingestion", before, null);

  await markAttachmentIngested(backend, "org-1", "a1", "import-doc-55");
  const after = backend._tables.inbound_attachments[0].import_document_id;
  t("C4: import_document_id set after markAttachmentIngested", after, "import-doc-55");
}

{
  // C5. Mock storage enforces upsert:false — second upload to same path returns 409
  const backend = makeMockBackend();
  const path = "org-1/inbound/m1/0-invoice.pdf";
  const bytes = new Uint8Array([1, 2, 3]);

  await backend.storage.from("documents").upload(path, bytes, { upsert: false });
  const { error } = await backend.storage.from("documents").upload(path, bytes, { upsert: false });
  ok("C5: second upload with upsert:false returns error", error !== null);
  t("C5: error is 409", error?.statusCode, "409");
}

// ── Section D: Organization isolation ────────────────────────────────────

console.log("\n── D. Organization isolation ───────────────────────────────────────────");

{
  // D1. listPendingAttachments never returns another org's attachments
  const backend = makeMockBackend({
    inbound_messages: [
      { id: "m-other", organization_id: "org-2", routing_address_id: "ra-2",
        postmark_message_id: "pm-x", sender_email: "v@x.com",
        received_at: new Date().toISOString() },
    ],
    inbound_attachments: [
      { id: "a-other", organization_id: "org-2", message_id: "m-other",
        filename: "secret.pdf", storage_path: "org-2/inbound/m-other/0-secret.pdf",
        import_document_id: null, created_at: new Date().toISOString() },
    ],
  });

  const pending = await listPendingAttachments(backend, "org-1");
  t("D1: org-1 sees zero pending (all belong to org-2)", pending.length, 0);
}

{
  // D2. getMessage returns null when message belongs to another org
  const backend = makeMockBackend({
    inbound_messages: [
      { id: "m-other", organization_id: "org-2", routing_address_id: "ra-2",
        postmark_message_id: "pm-x", sender_email: "v@x.com",
        received_at: new Date().toISOString() },
    ],
  });

  const msg = await getMessage(backend, "org-1", "m-other");
  t("D2: getMessage returns null for wrong org", msg, null);
}

{
  // D3. createRoutingAddress routing lookup only returns the correct org's row
  const backend = makeMockBackend({
    email_routing_addresses: [
      { id: "ra-1", organization_id: "org-1",
        routing_address: "shared@inbound.kerdos.com", is_active: true },
    ],
  });

  const { data: found } = await backend
    .from("email_routing_addresses")
    .select("id, organization_id")
    .eq("routing_address", "shared@inbound.kerdos.com")
    .eq("is_active", true)
    .single();

  t("D3: routing lookup returns org-1 not org-2", found?.organization_id, "org-1");
}

// ── Section E: attachment-state predicates ────────────────────────────────
// These tests establish the dispatch rules that attachment-processor.mjs
// relies on via attachment-state.mjs.  They must live here (not only in the
// lease-handoff-test) so the full email-routing module review can verify
// the state machine without importing process-attachment internals.

{
  // E1. VALID_OUTCOMES is complete and stable
  ok("E1: VALID_OUTCOMES contains auto_imported", VALID_OUTCOMES.includes("auto_imported"));
  ok("E1: VALID_OUTCOMES contains needs_review", VALID_OUTCOMES.includes("needs_review"));
  ok("E1: VALID_OUTCOMES contains skipped", VALID_OUTCOMES.includes("skipped"));
  t("E1: VALID_OUTCOMES has exactly 3 members", VALID_OUTCOMES.length, 3);
}

{
  // E2. isDispatchable: pending + storage_path + no error → dispatchable
  const row = { processing_status: "pending", ingest_error: null, storage_path: "org/inbound/msg/0" };
  ok("E2: pending row with storage_path is dispatchable", isDispatchable(row));
}

{
  // E3. isDispatchable: needs_review is NOT dispatchable (terminal, awaits human)
  const row = { processing_status: "needs_review", ingest_error: null, storage_path: "org/path" };
  ok("E3: needs_review row is not dispatchable", !isDispatchable(row));
}

{
  // E4. isDispatchable: pending without storage_path → not dispatchable (error row)
  const row = { processing_status: "pending", ingest_error: null, storage_path: null };
  ok("E4: pending row without storage_path is not dispatchable", !isDispatchable(row));
}

{
  // E5. isDispatchable: pending with ingest_error → not dispatchable (permanent failure)
  const row = { processing_status: "pending", ingest_error: "bad base64", storage_path: "org/path" };
  ok("E5: pending row with ingest_error is not dispatchable", !isDispatchable(row));
}

{
  // E6. isDispatchable: processing row (another worker holds lease) → not dispatchable
  const row = { processing_status: "processing", ingest_error: null, storage_path: "org/path" };
  ok("E6: processing row is not dispatchable", !isDispatchable(row));
}

{
  // E7. isDispatchable: auto_imported row → not dispatchable (already done)
  const row = { processing_status: "auto_imported", ingest_error: null, storage_path: "org/path" };
  ok("E7: auto_imported row is not dispatchable", !isDispatchable(row));
}

{
  // E8. isDispatchable: null input → false (safe for missing DB rows)
  ok("E8: null is not dispatchable", !isDispatchable(null));
}

{
  // E9. isTerminal: both terminal statuses are recognised
  ok("E9: auto_imported is terminal", isTerminal("auto_imported"));
  ok("E9: needs_review is terminal", isTerminal("needs_review"));
  ok("E9: pending is not terminal", !isTerminal("pending"));
  ok("E9: processing is not terminal", !isTerminal("processing"));
  ok("E9: skipped is not terminal", !isTerminal("skipped"));
}

// ── Section F: attachment-processor edge cases via email-routing mock ─────
// These tests exercise paths in attachment-processor.mjs end-to-end through
// the inbound-email surface — the same surface that production uses.

function makeProcessBackend({
  existingRow = null,
  uploadError = null,
  insertError = null,
  invocationResult = { data: { outcome: "auto_imported" }, error: null },
  raceRow = null,         // row fetched in 409 re-check
  recoveredRow = null,    // row returned by recovery insert
  recoveryInsertError = null,
} = {}) {
  const insertedRows = [];
  const invocations = [];
  return {
    get insertedRows() { return insertedRows; },
    get invocations() { return invocations; },
    from(table) {
      return {
        select() { return this; },
        eq() { return this; },
        single() {
          if (recoveredRow) return Promise.resolve({ data: recoveredRow, error: recoveryInsertError });
          if (insertError) return Promise.resolve({ data: null, error: insertError });
          const row = { id: "att-new", processing_status: "pending", storage_path: "org/path" };
          insertedRows.push(row);
          return Promise.resolve({ data: row, error: null });
        },
        maybeSingle() {
          if (raceRow !== undefined && insertedRows.length > 0) return Promise.resolve({ data: raceRow, error: null });
          return Promise.resolve({ data: existingRow, error: null });
        },
        insert(payload) {
          insertedRows.push(payload);
          return this;
        },
      };
    },
    storage: {
      from() {
        return {
          upload() {
            return Promise.resolve({ error: uploadError });
          },
        };
      },
    },
    functions: {
      invoke(fn, opts) {
        invocations.push({ fn, body: opts?.body });
        return Promise.resolve(invocationResult);
      },
    },
  };
}

const singleAtt = [{ Name: "prices.csv", ContentType: "text/csv", Content: btoa("hello"), ContentLength: 5 }];

{
  // F1. Fresh attachment: upload succeeds → DB row inserted → process invoked
  const b = makeProcessBackend();
  await processAttachments(b, "org-1", "msg-1", singleAtt);
  ok("F1: process-attachment invoked once", b.invocations.length === 1);
  t("F1: invoked with correct attachmentId", b.invocations[0].body.attachmentId, "att-new");
  t("F1: invoked with correct organizationId", b.invocations[0].body.organizationId, "org-1");
}

{
  // F2. Existing pending row with storage_path → re-dispatched (retry of stranded handoff)
  const existing = { id: "att-old", processing_status: "pending", ingest_error: null, storage_path: "org-1/inbound/msg-1/0" };
  const b = makeProcessBackend({ existingRow: existing });
  await processAttachments(b, "org-1", "msg-1", singleAtt);
  ok("F2: existing pending row triggers dispatch", b.invocations.length === 1);
  t("F2: dispatched with existing row id", b.invocations[0].body.attachmentId, "att-old");
}

{
  // F3. Existing auto_imported row → skipped entirely (no dispatch)
  const existing = { id: "att-done", processing_status: "auto_imported", ingest_error: null, storage_path: "org/path" };
  const b = makeProcessBackend({ existingRow: existing });
  await processAttachments(b, "org-1", "msg-1", singleAtt);
  t("F3: auto_imported row causes no dispatch", b.invocations.length, 0);
}

{
  // F4. Existing needs_review row → skipped (human action required)
  const existing = { id: "att-review", processing_status: "needs_review", ingest_error: null, storage_path: "org/path" };
  const b = makeProcessBackend({ existingRow: existing });
  await processAttachments(b, "org-1", "msg-1", singleAtt);
  t("F4: needs_review row causes no dispatch", b.invocations.length, 0);
}

{
  // F5. Existing ingest_error row → skipped (permanent failure, no retry)
  const existing = { id: "att-err", processing_status: "pending", ingest_error: "decode failed", storage_path: null };
  const b = makeProcessBackend({ existingRow: existing });
  await processAttachments(b, "org-1", "msg-1", singleAtt);
  t("F5: ingest_error row causes no dispatch", b.invocations.length, 0);
}

{
  // F6. Storage upload returns non-409 error → throws (Postmark retry)
  const b = makeProcessBackend({ uploadError: { message: "Storage service unavailable", statusCode: 503 } });
  await rejects("F6: transient storage error throws", () => processAttachments(b, "org-1", "msg-1", singleAtt));
}

{
  // F7. Malformed base64 → ingest_error row inserted, no throw, no dispatch
  const badAtt = [{ Name: "bad.pdf", ContentType: "application/pdf", Content: "!!!!not-base64!!!!", ContentLength: 0 }];
  let insertedError = null;
  const b = {
    insertedRows: [],
    invocations: [],
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert(payload) {
          b.insertedRows.push(payload);
          return { then: () => {}, catch: () => {}, finally: () => {}, error: null };
        },
      };
    },
    get _insertedError() { return insertedError; },
  };
  // Override maybeSingle to return null (fresh row), and insert to capture payload
  const capturedInserts = [];
  const testBackend = {
    invocations: [],
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert(payload) {
          capturedInserts.push(payload);
          return { select() { return this; }, single() { return Promise.resolve({ data: null, error: { code: "23505" } }); } };
        },
      };
    },
    storage: { from() { return { upload() { return Promise.resolve({ error: null }); } }; } },
    functions: { invoke() { return Promise.resolve({ data: { outcome: "auto_imported" }, error: null }); } },
  };
  let threw = false;
  try { await processAttachments(testBackend, "org-1", "msg-1", badAtt); } catch { threw = true; }
  ok("F7: malformed base64 does not throw", !threw);
  ok("F7: ingest_error row attempted", capturedInserts.length >= 1);
  ok("F7: ingest_error field set", capturedInserts[0]?.ingest_error?.includes("base64") ?? false);
  t("F7: no process-attachment invoked", testBackend.invocations.length, 0);
}

{
  // F8. Multi-attachment: both attachments processed in sequence
  const twoAtts = [
    { Name: "a.csv", ContentType: "text/csv", Content: btoa("A"), ContentLength: 1 },
    { Name: "b.csv", ContentType: "text/csv", Content: btoa("B"), ContentLength: 1 },
  ];
  let insertCount = 0;
  const invocations = [];
  const multiBackend = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert() {
          insertCount++;
          const id = `att-${insertCount}`;
          return { select() { return this; }, single() { return Promise.resolve({ data: { id }, error: null }); } };
        },
      };
    },
    storage: { from() { return { upload() { return Promise.resolve({ error: null }); } }; } },
    functions: { invoke(fn, opts) { invocations.push(opts.body); return Promise.resolve({ data: { outcome: "auto_imported" }, error: null }); } },
  };
  await processAttachments(multiBackend, "org-1", "msg-1", twoAtts);
  t("F8: two rows inserted", insertCount, 2);
  t("F8: process-attachment invoked twice", invocations.length, 2);
  t("F8: first attachment index used", invocations[0].attachmentId, "att-1");
  t("F8: second attachment index used", invocations[1].attachmentId, "att-2");
}

{
  // F9. Storage 409 + existing DB row (concurrent delivery winner) → dispatch to winner
  let lookupCount = 0;
  const existingWinner = { id: "att-winner", processing_status: "pending", ingest_error: null, storage_path: "org/path" };
  const raceBackend = {
    invocations: [],
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() {
          lookupCount++;
          // First lookup (idempotency check) returns null; second (after 409) returns winner
          return Promise.resolve({ data: lookupCount === 1 ? null : existingWinner, error: null });
        },
        insert() { return this; },
      };
    },
    storage: { from() { return { upload() { return Promise.resolve({ error: { statusCode: 409, message: "The resource already exists" } }); } }; } },
    functions: { invoke(fn, opts) { raceBackend.invocations.push(opts.body); return Promise.resolve({ data: { outcome: "auto_imported" }, error: null }); } },
  };
  await processAttachments(raceBackend, "org-1", "msg-1", singleAtt);
  t("F9: dispatch goes to storage race winner", raceBackend.invocations.length, 1);
  t("F9: winner id used for dispatch", raceBackend.invocations[0].attachmentId, "att-winner");
}

{
  // F10. Process-attachment returns an unrecognised outcome → throws for Postmark retry
  const badOutcomeBackend = makeProcessBackend({
    invocationResult: { data: { outcome: "unknown_status" }, error: null },
  });
  await rejects("F10: unrecognised outcome throws", () =>
    processAttachments(badOutcomeBackend, "org-1", "msg-1", singleAtt)
  );
}

{
  // F11. Process-attachment returns error → throws (edge function error path)
  const errBackend = makeProcessBackend({
    invocationResult: { data: null, error: { message: "Function timeout" } },
  });
  await rejects("F11: invocation error throws", () =>
    processAttachments(errBackend, "org-1", "msg-1", singleAtt)
  );
}

{
  // F12. functions.invoke unavailable → throws immediately (guard check)
  const noFnBackend = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert() { return { select() { return this; }, single() { return Promise.resolve({ data: { id: "x" }, error: null }); } }; },
      };
    },
    storage: { from() { return { upload() { return Promise.resolve({ error: null }); } }; } },
    functions: { invoke: "not-a-function" },
  };
  await rejects("F12: missing invoke guard throws", () =>
    processAttachments(noFnBackend, "org-1", "msg-1", singleAtt)
  );
}

{
  // F13. Storage 409 + no DB row (orphan recovery) → recovery insert → dispatch
  let lookupCount = 0;
  const recoveryInvocations = [];
  const orphanBackend = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() {
          lookupCount++;
          // Both lookups return null: initial check and after-409 re-check
          return Promise.resolve({ data: null, error: null });
        },
        insert() {
          return {
            select() { return this; },
            single() {
              return Promise.resolve({ data: { id: "att-recovered" }, error: null });
            },
          };
        },
      };
    },
    storage: {
      from() {
        return { upload() { return Promise.resolve({ error: { statusCode: 409, message: "already exists" } }); } };
      },
    },
    functions: {
      invoke(fn, opts) {
        recoveryInvocations.push(opts.body);
        return Promise.resolve({ data: { outcome: "auto_imported" }, error: null });
      },
    },
  };
  await processAttachments(orphanBackend, "org-1", "msg-1", singleAtt);
  t("F13: orphan rechecks after Storage 409", lookupCount, 2);
  t("F13: orphan recovery dispatches process-attachment", recoveryInvocations.length, 1);
  t("F13: recovery uses recovered row id", recoveryInvocations[0].attachmentId, "att-recovered");
}

{
  // F14. Concurrent insert 23505 at step 4 → winner fetch → dispatch
  let insertAttempts = 0;
  let winnerLookups = 0;
  const concurrentInvocations = [];
  const winner = { id: "att-concurrent-winner" };
  const concurrentBackend = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() {
          winnerLookups++;
          return Promise.resolve({ data: winnerLookups === 1 ? null : winner, error: null });
        },
        insert() {
          insertAttempts++;
          return {
            select() { return this; },
            single() {
              return Promise.resolve({ data: null, error: { code: "23505" } });
            },
          };
        },
      };
    },
    storage: { from() { return { upload() { return Promise.resolve({ error: null }); } }; } },
    functions: {
      invoke(fn, opts) {
        concurrentInvocations.push(opts.body);
        return Promise.resolve({ data: { outcome: "auto_imported" }, error: null });
      },
    },
  };
  await processAttachments(concurrentBackend, "org-1", "msg-1", singleAtt);
  t("F14: concurrent insert attempted once", insertAttempts, 1);
  t("F14: concurrent insert dispatches to winner", concurrentInvocations.length, 1);
  t("F14: winner id used", concurrentInvocations[0].attachmentId, "att-concurrent-winner");
}

{
  // F15. attachmentIndex is used in storage path, not filename
  const indexPathInvocations = [];
  const twoAtts = [
    { Name: "invoice.pdf", ContentType: "application/pdf", Content: btoa("X"), ContentLength: 1 },
    { Name: "invoice.pdf", ContentType: "application/pdf", Content: btoa("Y"), ContentLength: 1 },
  ];
  let insertCount = 0;
  const indexBackend = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert(payload) {
          insertCount++;
          // Verify storage_path uses index (0 or 1), not filename
          ok(`F15: attachment ${insertCount - 1} path uses index`, payload?.storage_path?.endsWith(`/${insertCount - 1}`) ?? false);
          return {
            select() { return this; },
            single() { return Promise.resolve({ data: { id: `att-${insertCount}` }, error: null }); },
          };
        },
      };
    },
    storage: { from() { return { upload() { return Promise.resolve({ error: null }); } }; } },
    functions: {
      invoke(fn, opts) {
        indexPathInvocations.push(opts.body);
        return Promise.resolve({ data: { outcome: "auto_imported" }, error: null });
      },
    },
  };
  await processAttachments(indexBackend, "org-1", "msg-1", twoAtts);
  t("F15: two same-name attachments both processed", indexPathInvocations.length, 2);
}

{
  // F16. Empty attachments array → no-op
  const emptyBackend = makeProcessBackend();
  await processAttachments(emptyBackend, "org-1", "msg-1", []);
  t("F16: empty attachments array causes no inserts or invocations", emptyBackend.invocations.length, 0);
}

{
  // F17. DB existence-check error → throws
  const existsErrBackend = {
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: { message: "DB connection lost" } }); },
      };
    },
    storage: { from() { return { upload() { return Promise.resolve({ error: null }); } }; } },
    functions: { invoke() { return Promise.resolve({ data: { outcome: "auto_imported" }, error: null }); } },
  };
  await rejects("F17: DB existence-check error throws", () =>
    processAttachments(existsErrBackend, "org-1", "msg-1", singleAtt)
  );
}

{
  // F18. Existing pending row without storage_path (decode-error row) → not dispatched
  const decodeErrRow = {
    id: "att-decode-err",
    processing_status: "pending",
    ingest_error: "base64 decode failed: invalid char",
    storage_path: null,
  };
  const decodeErrBackend = {
    invocations: [],
    from() {
      return {
        select() { return this; },
        eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: decodeErrRow, error: null }); },
      };
    },
    functions: { invoke() { decodeErrBackend.invocations.push(1); return Promise.resolve({ data: { outcome: "auto_imported" }, error: null }); } },
  };
  await processAttachments(decodeErrBackend, "org-1", "msg-1", singleAtt);
  t("F18: decode-error row with null storage_path not dispatched", decodeErrBackend.invocations.length, 0);
}

// ── Section G: processAttachments integration — base64 and storage paths ─────

{
  // G1. Whitespace in base64 Content is stripped before decode
  const wsAtts = [{ Name: "doc.txt", ContentType: "text/plain", Content: "SGVs\nbG8=", ContentLength: 5 }];
  let uploadedBytes = null;
  const wsBackend = {
    from() {
      return {
        select() { return this; }, eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert() { return { select() { return this; }, single() { return Promise.resolve({ data: { id: "att-ws" }, error: null }); } }; },
      };
    },
    storage: { from() { return { upload(path, bytes) { uploadedBytes = bytes; return Promise.resolve({ error: null }); } }; } },
    functions: { invoke() { return Promise.resolve({ data: { outcome: "auto_imported" }, error: null }); } },
  };
  await processAttachments(wsBackend, "org-1", "msg-1", wsAtts);
  t("G1: whitespace stripped from base64 before decode", uploadedBytes != null && uploadedBytes.length > 0, true);
}

{
  // G2. Storage path format: {orgId}/inbound/{messageId}/{index}
  let capturedPath = null;
  const pathBackend = {
    from() {
      return {
        select() { return this; }, eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert() { return { select() { return this; }, single() { return Promise.resolve({ data: { id: "att-p" }, error: null }); } }; },
      };
    },
    storage: { from() { return { upload(path) { capturedPath = path; return Promise.resolve({ error: null }); } }; } },
    functions: { invoke() { return Promise.resolve({ data: { outcome: "skipped" }, error: null }); } },
  };
  await processAttachments(pathBackend, "org-abc", "msg-xyz", [{ Name: "a.pdf", ContentType: "application/pdf", Content: btoa("X"), ContentLength: 1 }]);
  t("G2: storage path uses orgId/inbound/messageId/index format", capturedPath, "org-abc/inbound/msg-xyz/0");
}

{
  // G3. Filename falls back to "attachment" when att.Name is empty
  let dbPayload = null;
  const noNameBackend = {
    from() {
      return {
        select() { return this; }, eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert(payload) {
          dbPayload = payload;
          return { select() { return this; }, single() { return Promise.resolve({ data: { id: "att-nn" }, error: null }); } };
        },
      };
    },
    storage: { from() { return { upload() { return Promise.resolve({ error: null }); } }; } },
    functions: { invoke() { return Promise.resolve({ data: { outcome: "auto_imported" }, error: null }); } },
  };
  await processAttachments(noNameBackend, "org-1", "msg-1", [{ Name: "", ContentType: "application/pdf", Content: btoa("X"), ContentLength: 1 }]);
  t("G3: empty Name falls back to 'attachment' in DB row", dbPayload?.filename, "attachment");
}

{
  // G4. ContentType falls back to null when missing
  let dbPayload2 = null;
  const noCtBackend = {
    from() {
      return {
        select() { return this; }, eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert(payload) {
          dbPayload2 = payload;
          return { select() { return this; }, single() { return Promise.resolve({ data: { id: "att-ct" }, error: null }); } };
        },
      };
    },
    storage: { from() { return { upload() { return Promise.resolve({ error: null }); } }; } },
    functions: { invoke() { return Promise.resolve({ data: { outcome: "auto_imported" }, error: null }); } },
  };
  await processAttachments(noCtBackend, "org-1", "msg-1", [{ Name: "x.bin", ContentType: undefined, Content: btoa("X"), ContentLength: 1 }]);
  t("G4: undefined ContentType becomes null in DB row", dbPayload2?.content_type, null);
}

{
  // G5. Transient DB insert failure (non-23505) → throws for Postmark retry
  const transientInsertBackend = {
    from() {
      return {
        select() { return this; }, eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert() { return { select() { return this; }, single() { return Promise.resolve({ data: null, error: { code: "08006", message: "connection dropped" } }); } }; },
      };
    },
    storage: { from() { return { upload() { return Promise.resolve({ error: null }); } }; } },
    functions: { invoke() { return Promise.resolve({ data: { outcome: "auto_imported" }, error: null }); } },
  };
  await rejects("G5: non-23505 insert error throws for retry", () =>
    processAttachments(transientInsertBackend, "org-1", "msg-1", singleAtt)
  );
}

{
  // G6. process-attachment invoked with correct body: attachmentId and organizationId
  const invocationBodies = [];
  const bodyCheckBackend = {
    from() {
      return {
        select() { return this; }, eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: null, error: null }); },
        insert() { return { select() { return this; }, single() { return Promise.resolve({ data: { id: "att-body" }, error: null }); } }; },
      };
    },
    storage: { from() { return { upload() { return Promise.resolve({ error: null }); } }; } },
    functions: { invoke(fn, opts) { invocationBodies.push({ fn, body: opts.body }); return Promise.resolve({ data: { outcome: "auto_imported" }, error: null }); } },
  };
  await processAttachments(bodyCheckBackend, "org-99", "msg-42", [{ Name: "invoice.pdf", ContentType: "application/pdf", Content: btoa("Z"), ContentLength: 1 }]);
  t("G6: invoked function name is 'process-attachment'", invocationBodies[0]?.fn, "process-attachment");
  t("G6: body includes correct attachmentId", invocationBodies[0]?.body?.attachmentId, "att-body");
  t("G6: body includes correct organizationId", invocationBodies[0]?.body?.organizationId, "org-99");
}

{
  // G7. Processing-status row (lease held by other worker) → not re-dispatched
  const processingRow = { id: "att-proc", processing_status: "processing", ingest_error: null, storage_path: "org/path" };
  let procInvocations = 0;
  const processingBackend = {
    from() {
      return {
        select() { return this; }, eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: processingRow, error: null }); },
      };
    },
    functions: { invoke() { procInvocations++; return Promise.resolve({ data: { outcome: "auto_imported" }, error: null }); } },
  };
  await processAttachments(processingBackend, "org-1", "msg-1", singleAtt);
  t("G7: processing-status row is not re-dispatched", procInvocations, 0);
}

{
  // G8. auto_imported row (terminal) → not re-dispatched
  const autoRow = { id: "att-auto", processing_status: "auto_imported", ingest_error: null, storage_path: "org/path" };
  let autoInvocations = 0;
  const autoBackend = {
    from() {
      return {
        select() { return this; }, eq() { return this; },
        maybeSingle() { return Promise.resolve({ data: autoRow, error: null }); },
      };
    },
    functions: { invoke() { autoInvocations++; return Promise.resolve({ data: { outcome: "auto_imported" }, error: null }); } },
  };
  await processAttachments(autoBackend, "org-1", "msg-1", singleAtt);
  t("G8: auto_imported row is not re-dispatched", autoInvocations, 0);
}

{
  // G9. VALID_OUTCOMES does not include unexpected values
  t("G9: 'processing' is not a valid outcome", VALID_OUTCOMES.includes("processing"), false);
  t("G9: 'failed' is not a valid outcome", VALID_OUTCOMES.includes("failed"), false);
}

{
  const backend=makeMockBackend({email_routing_addresses:[
    {id:"type-own",organization_id:"org-1",document_type:null,is_active:true},
    {id:"type-other",organization_id:"org-2",document_type:null,is_active:true},
  ]});
  await setRoutingAddressDocumentType(backend,"org-1","type-own","invoice");
  t("Type registration: updates own route",backend._tables.email_routing_addresses[0].document_type,"invoice");
  try{await setRoutingAddressDocumentType(backend,"org-1","type-other","pricelist");}catch{/* scoped update returns no row */}
  t("Type registration: foreign route unchanged",backend._tables.email_routing_addresses[1].document_type,null);
  let rejected=false;try{await setRoutingAddressDocumentType(backend,"org-1","type-own","other");}catch{rejected=true;}
  t("Type registration: invalid type rejected",rejected,true);
  for(const domain of ["pricing.example.com","invoices.example.us","custom.example.co"])
    t("Universal address: "+domain,routingAddressError("client.vendor@"+domain,null),null);
  for(const invalid of ["a@@example.com","a b@example.com","missing-at","a@"])
    t("Invalid address rejected: "+invalid,!!routingAddressError(invalid,null),true);
}

// ── Summary ───────────────────────────────────────────────────────────────

console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
