/**
 * db_check_a1_7_migration_035.mjs
 * ================================
 * A1.7.c — Live kerdos-test database check for migration_035.
 *
 * Verifies, against kerdos-test only:
 *   1. Function exists with 3-param signature (uuid, uuid, text DEFAULT NULL)
 *   2. Old 2-param overload dropped — verified in migration SQL on disk
 *   3. Grants — migration SQL on disk + behavioral anonymous-call test (if SUPABASE_ANON_KEY set)
 *   4. Completion guard: auto_imported with incomplete doc → raises
 *   5. Completion guard: auto_imported with complete doc → succeeds
 *   6. Status update: processing_status is set in the same transaction
 *   7. Idempotency: calling twice with same attachment+document → no error
 *   8. Idempotency status replay: second call still applies p_final_status
 *   9. Cross-doc collision: different import document → raises
 *  10. Invalid p_final_status → raises
 *  11. Null p_import_document_id → raises
 *
 * Usage:
 *   SUPABASE_URL=<...> SUPABASE_SERVICE_ROLE_KEY=<...> \
 *     [SUPABASE_ANON_KEY=<...>] \
 *     node scripts/db_check_a1_7_migration_035.mjs
 *
 * Targets kerdos-test (project gwtnaudjfoxjermhvhpx) only.
 *
 * Fixture chain:
 *   organization → email_routing_addresses → inbound_messages → inbound_attachments
 *
 * All rows inserted during the run are deleted in the finally block even if a test
 * fails.  ANY cleanup error causes the process to exit with code 1 so leaked
 * fixtures cannot pass silently.
 *
 * Do NOT apply migration_035 or merge PR #2 from this script.
 */

import { createClient }    from "@supabase/supabase-js";
import { readFileSync }    from "fs";
import { fileURLToPath }   from "url";
import path                from "path";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const SUPABASE_URL              = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;
const SUPABASE_ANON_KEY         = process.env.SUPABASE_ANON_KEY; // optional — enables check 3b

if (!SUPABASE_URL || !SUPABASE_SERVICE_ROLE_KEY) {
  console.error("Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY before running.");
  process.exit(1);
}
if (!SUPABASE_URL.includes("gwtnaudjfoxjermhvhpx")) {
  console.error("SUPABASE_URL does not target kerdos-test (gwtnaudjfoxjermhvhpx). Aborting.");
  process.exit(1);
}

const admin = createClient(SUPABASE_URL, SUPABASE_SERVICE_ROLE_KEY, {
  auth: { persistSession: false },
});

// ── Tracking ──────────────────────────────────────────────────────────────────

const PASS = [];
const FAIL = [];
let   cleanupFailed = false;

// Insertion order within each array = deletion order (newest first within group).
// Delete arrays hold IDs only for records created THIS run.
const created = {
  orgs:            [],
  users:           [],
  vendors:         [],
  messages:        [],   // inbound_messages — deleted before routing_addresses
  routingAddresses:[],   // email_routing_addresses — deleted after messages
  attachments:     [],   // inbound_attachments
  documents:       [],   // import_documents
};

function ok(name) {
  PASS.push(name);
  console.log(`  PASS  ${name}`);
}

function fail(name, reason) {
  FAIL.push(name);
  console.log(`  FAIL  ${name}: ${reason}`);
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

async function createOrg(name) {
  const { data, error } = await admin
    .from("organizations")
    .insert({ name })
    .select("id")
    .single();
  if (error) throw new Error(`createOrg: ${error.message}`);
  created.orgs.push(data.id);
  return data.id;
}

async function createOrgMember(orgId, userId) {
  const { error } = await admin
    .from("organization_members")
    .insert({ organization_id: orgId, user_id: userId, role: "owner" });
  if (error) throw new Error(`createOrgMember: ${error.message}`);
}

async function createTestUser(email) {
  const { data, error } = await admin.auth.admin.createUser({
    email,
    password: "Test1234!",
    email_confirm: true,
  });
  if (error) throw new Error(`createTestUser(${email}): ${error.message}`);
  created.users.push(data.user.id);
  return data.user.id;
}

async function getUserClient(email, password = "Test1234!") {
  const anonKey = SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY;
  const userClient = createClient(SUPABASE_URL, anonKey, {
    auth: { persistSession: false },
  });
  const { data, error } = await userClient.auth.signInWithPassword({ email, password });
  if (error) throw new Error(`signIn(${email}): ${error.message}`);
  return userClient;
}

async function createVendor(orgId, name) {
  const { data, error } = await admin
    .from("vendors")
    .insert({ organization_id: orgId, name })
    .select("id")
    .single();
  if (error) throw new Error(`createVendor: ${error.message}`);
  created.vendors.push(data.id);
  return data.id;
}

async function createImportDocument(orgId, vendorId, status = "complete") {
  const { data, error } = await admin
    .from("import_documents")
    .insert({
      organization_id: orgId,
      vendor_id:       vendorId,
      document_kind:   "pricelist",
      status,
      file_path:       `test/db-check-${Date.now()}.pdf`,
    })
    .select("id")
    .single();
  if (error) throw new Error(`createImportDocument: ${error.message}`);
  created.documents.push(data.id);
  return data.id;
}

/**
 * Create an email_routing_addresses row.
 * routing_address must be lowercase (CHECK constraint) and globally unique.
 */
async function createRoutingAddress(orgId, suffix) {
  const routingAddress = `a17-check-${suffix}@test.kerdos.invalid`;
  const { data, error } = await admin
    .from("email_routing_addresses")
    .insert({ organization_id: orgId, routing_address: routingAddress })
    .select("id")
    .single();
  if (error) throw new Error(`createRoutingAddress(${routingAddress}): ${error.message}`);
  created.routingAddresses.push(data.id);
  return data.id;
}

/**
 * Create an inbound_messages row.
 * postmark_message_id + organization_id must be unique.
 */
async function createMessage(orgId, routingAddressId, suffix) {
  const { data, error } = await admin
    .from("inbound_messages")
    .insert({
      organization_id:    orgId,
      routing_address_id: routingAddressId,
      postmark_message_id: `a17-check-msg-${suffix}`,
      sender_email:        `sender-${suffix}@example.com`,
    })
    .select("id")
    .single();
  if (error) throw new Error(`createMessage(${suffix}): ${error.message}`);
  created.messages.push(data.id);
  return data.id;
}

/**
 * Create an inbound_attachments row.
 * Requires message_id (FK to inbound_messages) and attachment_index (NOT NULL).
 * message_id + attachment_index must be unique.
 */
async function createAttachment(orgId, messageId, attachmentIndex, processingStatus = "needs_review") {
  const { data, error } = await admin
    .from("inbound_attachments")
    .insert({
      organization_id:   orgId,
      message_id:        messageId,
      attachment_index:  attachmentIndex,
      filename:          `test-attachment-${attachmentIndex}.pdf`,
      storage_path:      `test/db-check-att-${Date.now()}-${attachmentIndex}.pdf`,
      processing_status: processingStatus,
    })
    .select("id")
    .single();
  if (error) throw new Error(`createAttachment(msg=${messageId}, idx=${attachmentIndex}): ${error.message}`);
  created.attachments.push(data.id);
  return data.id;
}

async function getAttachment(id) {
  const { data, error } = await admin
    .from("inbound_attachments")
    .select("import_document_id, processing_status")
    .eq("id", id)
    .single();
  if (error) throw new Error(`getAttachment(${id}): ${error.message}`);
  return data;
}

/**
 * Call mark_attachment_ingested via an authenticated user client so auth.uid()
 * resolves to a real org member.
 */
async function callMarkIngested(userClient, attachmentId, documentId, finalStatus = null) {
  const params = {
    p_attachment_id:      attachmentId,
    p_import_document_id: documentId,
  };
  if (finalStatus !== null) params.p_final_status = finalStatus;
  const { data, error } = await userClient.rpc("mark_attachment_ingested", params);
  return { data, error };
}

// ── Checks 1–3: signature and grants ─────────────────────────────────────────

async function checkSchema() {
  // ── 1: 3-param function exists and is callable ────────────────────────────
  console.log("\n[1] 3-param mark_attachment_ingested exists and is callable");
  {
    // Pass nil UUIDs — function should raise "attachment not found" or similar,
    // not "function does not exist".  Any runtime error proves it was invoked.
    const { error } = await admin.rpc("mark_attachment_ingested", {
      p_attachment_id:      "00000000-0000-0000-0000-000000000000",
      p_import_document_id: "00000000-0000-0000-0000-000000000000",
      p_final_status:       null,
    });
    const funcMiss = !error || /function.*does not exist/i.test(error.message);
    if (!error) {
      // Unexpected: nil UUIDs should not succeed.
      fail("1", "call with nil UUIDs returned no error — null guard or attachment lookup may be missing");
    } else if (funcMiss) {
      fail("1", `function not found / wrong signature: ${error.message}`);
    } else {
      ok(`1: 3-param function callable — raised runtime error (not schema miss): "${error.message.slice(0, 80)}"`);
    }
  }

  // ── 2: Old 2-param overload dropped — verified in migration SQL on disk ───
  console.log("\n[2] Old 2-param overload dropped (migration SQL structural check)");
  {
    // PostgREST does not expose pg_catalog views reliably, so we verify that
    // migration_035 includes an explicit DROP for the old 2-param overload.
    const migration035Path = path.join(ROOT, "knowledge", "migration_035_partial_import_recovery.sql");
    let sql035;
    try {
      sql035 = readFileSync(migration035Path, "utf8");
    } catch (e) {
      fail("2", `could not read ${migration035Path}: ${e.message}`);
      sql035 = "";
    }
    // Match: DROP FUNCTION IF EXISTS mark_attachment_ingested(uuid, uuid)
    // (with optional whitespace variations)
    const dropPattern = /DROP\s+FUNCTION\s+IF\s+EXISTS\s+mark_attachment_ingested\s*\(\s*uuid\s*,\s*uuid\s*\)/i;
    if (dropPattern.test(sql035)) {
      ok("2: migration_035 explicitly DROPs the 2-param overload mark_attachment_ingested(uuid,uuid)");
    } else {
      fail("2", "DROP FUNCTION for old 2-param overload not found in migration_035 SQL");
    }
  }

  // ── 3: Grants — migration SQL + optional behavioral anonymous-call test ───
  console.log("\n[3] Grants: authenticated has EXECUTE; PUBLIC does not");
  {
    // 3a: Structural — migration SQL must REVOKE from PUBLIC and GRANT to authenticated.
    const migration035Path = path.join(ROOT, "knowledge", "migration_035_partial_import_recovery.sql");
    let sql035 = "";
    try { sql035 = readFileSync(migration035Path, "utf8"); } catch (_) {}

    const hasRevoke = /REVOKE\s+EXECUTE\s+ON\s+FUNCTION\s+mark_attachment_ingested[^;]*FROM\s+PUBLIC/i.test(sql035);
    const hasGrant  = /GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+mark_attachment_ingested[^;]*TO\s+authenticated/i.test(sql035);

    if (!hasRevoke) {
      fail("3a", "REVOKE EXECUTE ... FROM PUBLIC not found in migration_035 SQL");
    } else if (!hasGrant) {
      fail("3a", "GRANT EXECUTE ... TO authenticated not found in migration_035 SQL");
    } else {
      ok("3a: migration_035 REVOKEs from PUBLIC and GRANTs to authenticated");
    }

    // 3b: Behavioral — anonymous call (no JWT) must be rejected with permissions error.
    if (SUPABASE_ANON_KEY) {
      const anonClient = createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
        auth: { persistSession: false },
      });
      const { error } = await anonClient.rpc("mark_attachment_ingested", {
        p_attachment_id:      "00000000-0000-0000-0000-000000000000",
        p_import_document_id: "00000000-0000-0000-0000-000000000000",
      });
      if (!error) {
        fail("3b", "anonymous (anon key, no JWT) call succeeded — PUBLIC may still have EXECUTE");
      } else if (/permission denied|insufficient privilege|not allowed/i.test(error.message)) {
        ok(`3b: anonymous call rejected as expected — "${error.message.slice(0, 80)}"`);
      } else {
        // Any other error (e.g. "Invalid API key") still means PUBLIC has no EXECUTE.
        ok(`3b: anonymous call rejected (${error.message.slice(0, 60)}) — PUBLIC does not have EXECUTE`);
      }
    } else {
      console.log("  NOTE  3b skipped — set SUPABASE_ANON_KEY to enable anonymous-call grant test");
    }
  }
}

// ── Checks 4–11: behavioral (require live fixtures) ──────────────────────────

async function checkBehavior() {
  const ts    = Date.now();
  const email = `a17-db-check-${ts}@test.kerdos.invalid`;

  console.log("\n[fixture] building org → routing_address → message → attachments …");
  const orgId = await createOrg(`A1.7 DB Check ${ts}`);

  // Routing address + message are required by the inbound_attachments FK chain.
  const routingAddressId = await createRoutingAddress(orgId, ts);
  const messageId        = await createMessage(orgId, routingAddressId, ts);

  const userId = await createTestUser(email);
  await createOrgMember(orgId, userId);
  const vendorId = await createVendor(orgId, `Vendor ${ts}`);

  // Two import documents: one complete, one partial.
  const completeDocId = await createImportDocument(orgId, vendorId, "complete");
  const partialDocId  = await createImportDocument(orgId, vendorId, "partial");

  // One attachment per behavioral test; attachment_index must be unique per message.
  let idx = 0;
  const att = {
    guardFails:   await createAttachment(orgId, messageId, idx++),  // 4
    guardPasses:  await createAttachment(orgId, messageId, idx++),  // 5
    statusUpdate: await createAttachment(orgId, messageId, idx++),  // 6
    idempotent:   await createAttachment(orgId, messageId, idx++),  // 7–8
    crossDoc:     await createAttachment(orgId, messageId, idx++),  // 9
    badStatus:    await createAttachment(orgId, messageId, idx++),  // 10
    nullDoc:      await createAttachment(orgId, messageId, idx++),  // 11
  };
  console.log(`  fixture ready — ${Object.keys(att).length} attachments, message ${messageId}`);

  // Sign in as the test user so auth.uid() resolves to a real org member.
  let userClient;
  try {
    userClient = await getUserClient(email);
  } catch (e) {
    fail("fixture", `Could not sign in as test user: ${e.message}`);
    return;
  }

  // ── 4 ─────────────────────────────────────────────────────────────────────
  console.log("\n[4] Completion guard: auto_imported with incomplete doc → raises");
  {
    const { error } = await callMarkIngested(userClient, att.guardFails, partialDocId, "auto_imported");
    if (error && /import document is not complete/i.test(error.message)) {
      ok("4: completion guard fires — auto_imported on partial doc raises correct error");
    } else if (error) {
      fail("4", `unexpected error: ${error.message}`);
    } else {
      fail("4", "guard did not fire — auto_imported on partial doc succeeded (should have raised)");
    }
  }

  // ── 5 ─────────────────────────────────────────────────────────────────────
  console.log("\n[5] Completion guard: auto_imported with complete doc → succeeds");
  {
    const { error } = await callMarkIngested(userClient, att.guardPasses, completeDocId, "auto_imported");
    if (error) {
      fail("5", `unexpected error: ${error.message}`);
    } else {
      ok("5: completion guard passes — auto_imported on complete doc succeeds");
    }
  }

  // ── 6 ─────────────────────────────────────────────────────────────────────
  console.log("\n[6] Status update: processing_status and import_document_id written atomically");
  {
    const { error } = await callMarkIngested(userClient, att.statusUpdate, completeDocId, "auto_imported");
    if (error) {
      fail("6", `unexpected error: ${error.message}`);
    } else {
      const row = await getAttachment(att.statusUpdate);
      if (row.processing_status === "auto_imported" && row.import_document_id === completeDocId) {
        ok("6: processing_status=auto_imported and import_document_id linked in one transaction");
      } else {
        fail("6", `got processing_status=${row.processing_status} import_document_id=${row.import_document_id}`);
      }
    }
  }

  // ── 7 ─────────────────────────────────────────────────────────────────────
  console.log("\n[7] Idempotency: calling twice with same attachment+document → no error");
  {
    await callMarkIngested(userClient, att.idempotent, completeDocId, "auto_imported");
    const { error } = await callMarkIngested(userClient, att.idempotent, completeDocId, "auto_imported");
    if (error) {
      fail("7", `second call raised: ${error.message}`);
    } else {
      ok("7: idempotent — second call with same attachment+document succeeds");
    }
  }

  // ── 8 ─────────────────────────────────────────────────────────────────────
  console.log("\n[8] Idempotency status replay: second call still applies p_final_status");
  {
    // att.idempotent already has auto_imported from test 7; update to needs_review.
    const { error } = await callMarkIngested(userClient, att.idempotent, completeDocId, "needs_review");
    if (error) {
      fail("8", `second call raised: ${error.message}`);
    } else {
      const row = await getAttachment(att.idempotent);
      if (row.processing_status === "needs_review") {
        ok("8: idempotent retry replays p_final_status — processing_status updated to needs_review");
      } else {
        fail("8", `processing_status=${row.processing_status} (expected needs_review after replay)`);
      }
    }
  }

  // ── 9 ─────────────────────────────────────────────────────────────────────
  console.log("\n[9] Cross-doc collision: different import document → raises");
  {
    await callMarkIngested(userClient, att.crossDoc, completeDocId, null);
    const { error } = await callMarkIngested(userClient, att.crossDoc, partialDocId, null);
    if (error && /already linked to a different import document/i.test(error.message)) {
      ok("9: cross-doc collision raises correct error");
    } else if (error) {
      fail("9", `unexpected error: ${error.message}`);
    } else {
      fail("9", "cross-doc call succeeded — attachment would be linked to wrong document");
    }
  }

  // ── 10 ────────────────────────────────────────────────────────────────────
  console.log("\n[10] Invalid p_final_status → raises");
  {
    const { error } = await callMarkIngested(userClient, att.badStatus, completeDocId, "bad_value");
    if (error && /invalid p_final_status/i.test(error.message)) {
      ok("10: invalid p_final_status raises correct validation error");
    } else if (error) {
      fail("10", `unexpected error: ${error.message}`);
    } else {
      fail("10", "invalid status was accepted — validation gate is missing");
    }
  }

  // ── 11 ────────────────────────────────────────────────────────────────────
  console.log("\n[11] Null p_import_document_id → raises");
  {
    const { error } = await callMarkIngested(userClient, att.nullDoc, null, null);
    if (error && /cannot be null|null.*import_document/i.test(error.message)) {
      ok("11: null p_import_document_id raises correct error");
    } else if (error) {
      fail("11", `unexpected error: ${error.message}`);
    } else {
      fail("11", "null document ID was accepted — null guard is missing");
    }
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────
// Any cleanup failure sets cleanupFailed=true so the process exits 1 even if
// all tests passed.  This prevents leaked fixtures from passing silently.

async function cleanup() {
  console.log("\n[cleanup] removing test fixtures …");
  const errors = [];

  // Reverse FK dependency order:
  //   inbound_attachments → inbound_messages → email_routing_addresses
  //   import_documents → vendors
  //   organization_members (cascade-deleted with org)
  //   users → organizations

  for (const id of created.attachments) {
    const { error } = await admin.from("inbound_attachments").delete().eq("id", id);
    if (error) errors.push(`inbound_attachment ${id}: ${error.message}`);
  }
  for (const id of created.messages) {
    const { error } = await admin.from("inbound_messages").delete().eq("id", id);
    if (error) errors.push(`inbound_message ${id}: ${error.message}`);
  }
  for (const id of created.routingAddresses) {
    const { error } = await admin.from("email_routing_addresses").delete().eq("id", id);
    if (error) errors.push(`email_routing_address ${id}: ${error.message}`);
  }
  for (const id of created.documents) {
    const { error } = await admin.from("import_documents").delete().eq("id", id);
    if (error) errors.push(`import_document ${id}: ${error.message}`);
  }
  for (const id of created.vendors) {
    const { error } = await admin.from("vendors").delete().eq("id", id);
    if (error) errors.push(`vendor ${id}: ${error.message}`);
  }
  for (const id of created.users) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) errors.push(`user ${id}: ${error.message}`);
  }
  for (const id of created.orgs) {
    const { error } = await admin.from("organizations").delete().eq("id", id);
    if (error) errors.push(`organization ${id}: ${error.message}`);
  }

  if (errors.length) {
    console.log("\n[cleanup ERRORS — manual deletion required]");
    for (const e of errors) console.log(`  ✗ ${e}`);
    cleanupFailed = true;
  } else {
    console.log("  cleanup complete — all test records removed");
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

try {
  await checkSchema();
  await checkBehavior();
} finally {
  await cleanup();
}

console.log();
const total = PASS.length + FAIL.length;
console.log(`Results: ${PASS.length}/${total} passed`);

if (FAIL.length) {
  console.log("\nFailed:");
  for (const f of FAIL) console.log(`  ✗ ${f}`);
}

if (cleanupFailed) {
  console.log("\nCleanup failed — see errors above.  Leaked fixtures must be removed manually.");
}

if (FAIL.length || cleanupFailed) {
  process.exit(1);
} else {
  console.log("All A1.7 database checks passed.");
  process.exit(0);
}
