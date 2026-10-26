/**
 * db_check_a1_7_migration_035.mjs
 * ================================
 * A1.7.c — Live kerdos-test database check for migration_035.
 *
 * Verifies, against kerdos-test only:
 *   1. Function exists with 3-param signature (uuid, uuid, text)
 *   2. Old 2-param overload is gone
 *   3. GRANT: authenticated role has EXECUTE; PUBLIC does not
 *   4. Completion guard fires: auto_imported with incomplete doc → raises
 *   5. Completion guard passes: auto_imported with complete doc → succeeds
 *   6. Status update: processing_status is set in the same transaction
 *   7. Idempotency: calling twice with the same attachment+document → no error
 *   8. Idempotency status replay: second call with p_final_status still applies
 *   9. Cross-doc collision: different import document → raises
 *  10. Invalid p_final_status → raises
 *  11. Null p_import_document_id → raises
 *
 * Usage:
 *   SUPABASE_URL=<...> SUPABASE_SERVICE_ROLE_KEY=<...> node scripts/db_check_a1_7_migration_035.mjs
 *
 * Targets kerdos-test (project gwtnaudjfoxjermhvhpx) only.
 * All rows inserted during the run are deleted in a finally block even if
 * a test fails.  Cleanup errors are visible; they do not mask the test result.
 *
 * Do NOT apply migration_035 or merge PR #2 from this script.
 */

import { createClient } from "@supabase/supabase-js";

const SUPABASE_URL             = process.env.SUPABASE_URL;
const SUPABASE_SERVICE_ROLE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

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
const createdIds = {
  orgs:        [],
  users:        [],
  vendors:      [],
  attachments:  [],
  documents:    [],
};

function ok(name) {
  PASS.push(name);
  console.log(`  PASS  ${name}`);
}

function fail(name, reason) {
  FAIL.push(name);
  console.log(`  FAIL  ${name}: ${reason}`);
}

// ── SQL helpers ───────────────────────────────────────────────────────────────

async function sql(query, params = []) {
  // Execute raw SQL via the service role. Supabase JS doesn't expose a raw SQL
  // method on the client, so we use the Postgres RPC pathway via pg directly.
  // Since we only have the JS client here, we use rpc('exec_sql'…) — but that
  // doesn't exist on kerdos-test.  Instead we use the PostgREST /rpc/... route
  // for functions we know exist, and fall through to direct table operations for
  // fixture setup.
  //
  // For the grant and overload checks we use information_schema via a known-safe
  // RPC or the admin client's .from() on pg_catalog views exposed via PostgREST.
  throw new Error("Use the targeted helpers below, not raw sql().");
}

// ── Fixture helpers ───────────────────────────────────────────────────────────

async function createOrg(name) {
  const { data, error } = await admin
    .from("organizations")
    .insert({ name })
    .select("id")
    .single();
  if (error) throw new Error(`createOrg: ${error.message}`);
  createdIds.orgs.push(data.id);
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
  createdIds.users.push(data.user.id);
  return data.user.id;
}

async function signInUser(email) {
  const { data, error } = await admin.auth.admin.generateLink({
    type: "magiclink",
    email,
  });
  if (error) throw new Error(`generateLink: ${error.message}`);
  // Use service role for the actual calls in tests that need auth.uid()
  // by impersonating through createClient with user JWT.
  // For this database check, all calls go through service role with
  // auth.uid() override via set_claim or direct column assertion.
  // Mark_attachment_ingested calls auth.uid() for the org membership check.
  // We'll use the admin client to call it via rpc and pass the user context
  // through the Authorization header by creating a user session client.
  const { data: sessionData, error: sessionError } = await admin.auth.admin.getUserById
    ? null : null; // unused — see getUserClient() below
  return data;
}

async function getUserClient(email, password = "Test1234!") {
  const userClient = createClient(SUPABASE_URL, process.env.SUPABASE_ANON_KEY || SUPABASE_SERVICE_ROLE_KEY, {
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
  createdIds.vendors.push(data.id);
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
  createdIds.documents.push(data.id);
  return data.id;
}

async function createAttachment(orgId, processingStatus = "needs_review") {
  const { data, error } = await admin
    .from("inbound_attachments")
    .insert({
      organization_id:   orgId,
      storage_path:      `test/db-check-att-${Date.now()}.pdf`,
      filename:          "test-attachment.pdf",
      content_type:      "application/pdf",
      processing_status: processingStatus,
    })
    .select("id")
    .single();
  if (error) throw new Error(`createAttachment: ${error.message}`);
  createdIds.attachments.push(data.id);
  return data.id;
}

async function getAttachment(id) {
  const { data, error } = await admin
    .from("inbound_attachments")
    .select("import_document_id, processing_status")
    .eq("id", id)
    .single();
  if (error) throw new Error(`getAttachment: ${error.message}`);
  return data;
}

// Call mark_attachment_ingested via an authenticated user client.
// The function is SECURITY DEFINER and checks auth.uid() for org membership.
async function callMarkIngested(userClient, attachmentId, documentId, finalStatus = null) {
  const params = {
    p_attachment_id:      attachmentId,
    p_import_document_id: documentId,
  };
  if (finalStatus !== null) params.p_final_status = finalStatus;

  const { data, error } = await userClient.rpc("mark_attachment_ingested", params);
  return { data, error };
}

// ── Checks 1–3: schema-level (function exists, old overload gone, grants) ─────

async function checkSchema() {
  console.log("\n[1] Function exists with 3-param signature");
  {
    const { data, error } = await admin.rpc("mark_attachment_ingested", {
      p_attachment_id:      "00000000-0000-0000-0000-000000000000",
      p_import_document_id: "00000000-0000-0000-0000-000000000000",
      p_final_status:       null,
    });
    // Expected: raises "attachment not found" — that means the 3-param function
    // was found and invoked (argument count matched). Any other error is a schema miss.
    if (error && error.message.includes("attachment not found")) {
      ok("1: 3-param mark_attachment_ingested exists and is callable");
    } else if (error && (error.message.includes("function") || error.message.includes("does not exist"))) {
      fail("1", `function not found or wrong signature: ${error.message}`);
    } else if (error) {
      // Different runtime error — function was found, wrong fixture
      ok("1: 3-param mark_attachment_ingested exists (raised runtime error, not schema miss)");
    } else {
      fail("1", "expected an error (fixture IDs are invalid) but got success");
    }
  }

  console.log("\n[2] Old 2-param overload is gone");
  {
    // The old overload accepted exactly 2 args. Passing 2 positional should fail with
    // "function mark_attachment_ingested(uuid, uuid) does not exist" if it was dropped.
    // supabase-js rpc always sends named params; test via pg_proc directly.
    const { data, error } = await admin
      .from("pg_catalog.pg_proc")
      .select("proname, pronargs")
      .eq("proname", "mark_attachment_ingested")
      .neq("pronargs", 3); // any overload that isn't the 3-param one

    if (error) {
      // pg_catalog not exposed via PostgREST — use information_schema instead
      const { data: d2, error: e2 } = await admin
        .from("information_schema.routines")
        .select("routine_name, specific_name")
        .eq("routine_schema", "public")
        .eq("routine_name", "mark_attachment_ingested");
      if (e2) {
        fail("2", `could not query information_schema: ${e2.message}`);
      } else {
        // Count parameter signatures
        const count = (d2 || []).length;
        if (count <= 1) {
          ok("2: only one overload of mark_attachment_ingested found in information_schema (2-param overload is gone or not visible)");
        } else {
          fail("2", `${count} overloads found — old 2-param may still exist`);
        }
      }
    } else {
      const extras = (data || []);
      if (extras.length === 0) {
        ok("2: no non-3-param overloads found in pg_proc (2-param overload is gone)");
      } else {
        fail("2", `found ${extras.length} overload(s) with pronargs != 3: ${JSON.stringify(extras)}`);
      }
    }
  }

  console.log("\n[3] Grants: authenticated has EXECUTE; PUBLIC does not");
  {
    // Check via has_function_privilege using a raw SQL approach.
    // Since we can't do arbitrary SQL, we test behaviorally: an anonymous
    // call (no JWT) should be rejected, and an authenticated call should proceed
    // to the function body (tested in checks 4–11 via user client).
    // For the explicit grant check, we query information_schema.role_routine_grants.
    const { data, error } = await admin
      .from("information_schema.role_routine_grants")
      .select("grantee, privilege_type")
      .eq("specific_schema", "public")
      .eq("routine_name", "mark_attachment_ingested")
      .eq("privilege_type", "EXECUTE");

    if (error) {
      fail("3", `could not query role_routine_grants: ${error.message}`);
    } else {
      const grantees = (data || []).map(r => r.grantee);
      const hasAuthenticated = grantees.includes("authenticated");
      const hasPublic = grantees.includes("PUBLIC");
      if (hasAuthenticated && !hasPublic) {
        ok("3: EXECUTE granted to authenticated; PUBLIC excluded");
      } else {
        fail("3", `grantees=${JSON.stringify(grantees)} (want authenticated, not PUBLIC)`);
      }
    }
  }
}

// ── Checks 4–11: behavioral (require live org+user+attachment fixtures) ────────

async function checkBehavior() {
  const ts    = Date.now();
  const email = `a17-db-check-${ts}@test.kerdos.invalid`;

  console.log("\n[fixture] creating org, user, vendor, attachments, documents …");
  const orgId  = await createOrg(`A1.7 DB Check ${ts}`);
  const userId = await createTestUser(email);
  await createOrgMember(orgId, userId);
  const vendorId = await createVendor(orgId, `Vendor ${ts}`);

  // Two import documents: one complete, one partial
  const completeDocId = await createImportDocument(orgId, vendorId, "complete");
  const partialDocId  = await createImportDocument(orgId, vendorId, "partial");

  // Several attachments for the behavioral tests
  const att = {
    guardFails:     await createAttachment(orgId),  // test 4: completion guard fires
    guardPasses:    await createAttachment(orgId),  // test 5: completion guard passes
    statusUpdate:   await createAttachment(orgId),  // test 6: status is written
    idempotent:     await createAttachment(orgId),  // tests 7–8: idempotency
    crossDoc:       await createAttachment(orgId),  // test 9: cross-doc collision
    badStatus:      await createAttachment(orgId),  // test 10: invalid status
    nullDoc:        await createAttachment(orgId),  // test 11: null doc id
  };

  // Sign in as the test user so auth.uid() resolves to a real org member
  let userClient;
  try {
    userClient = await getUserClient(email);
  } catch (e) {
    fail("fixture", `Could not sign in as test user: ${e.message}`);
    return;
  }

  console.log("\n[4] Completion guard: auto_imported with incomplete doc → raises");
  {
    const { error } = await callMarkIngested(userClient, att.guardFails, partialDocId, "auto_imported");
    if (error && error.message.includes("import document is not complete")) {
      ok("4: completion guard fires — auto_imported on partial doc raises correct error");
    } else if (error) {
      fail("4", `unexpected error: ${error.message}`);
    } else {
      fail("4", "guard did not fire — auto_imported on partial doc succeeded (should have raised)");
    }
  }

  console.log("\n[5] Completion guard: auto_imported with complete doc → succeeds");
  {
    const { error } = await callMarkIngested(userClient, att.guardPasses, completeDocId, "auto_imported");
    if (error) {
      fail("5", `unexpected error: ${error.message}`);
    } else {
      ok("5: completion guard passes — auto_imported on complete doc succeeds");
    }
  }

  console.log("\n[6] Status update: processing_status is set after call");
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

  console.log("\n[8] Idempotency status replay: second call still applies p_final_status");
  {
    // att.idempotent already has auto_imported from test 7.
    // Change to needs_review on the second call to verify the UPDATE runs.
    const { error } = await callMarkIngested(userClient, att.idempotent, completeDocId, "needs_review");
    if (error) {
      fail("8", `second call raised: ${error.message}`);
    } else {
      const row = await getAttachment(att.idempotent);
      if (row.processing_status === "needs_review") {
        ok("8: idempotent retry replays p_final_status — processing_status updated");
      } else {
        fail("8", `processing_status=${row.processing_status} (expected needs_review after replay)`);
      }
    }
  }

  console.log("\n[9] Cross-doc collision: different import document → raises");
  {
    // Link att.crossDoc to completeDocId first
    await callMarkIngested(userClient, att.crossDoc, completeDocId, null);
    // Now try to link to a different document
    const { error } = await callMarkIngested(userClient, att.crossDoc, partialDocId, null);
    if (error && error.message.includes("already linked to a different import document")) {
      ok("9: cross-doc collision raises correct error");
    } else if (error) {
      fail("9", `unexpected error: ${error.message}`);
    } else {
      fail("9", "cross-doc call succeeded — attachment would be linked to wrong document");
    }
  }

  console.log("\n[10] Invalid p_final_status → raises");
  {
    const { error } = await callMarkIngested(userClient, att.badStatus, completeDocId, "bad_value");
    if (error && error.message.includes("invalid p_final_status")) {
      ok("10: invalid p_final_status raises correct validation error");
    } else if (error) {
      fail("10", `unexpected error: ${error.message}`);
    } else {
      fail("10", "invalid status was accepted — validation gate is missing");
    }
  }

  console.log("\n[11] Null p_import_document_id → raises");
  {
    const { error } = await callMarkIngested(userClient, att.nullDoc, null, null);
    if (error && error.message.includes("cannot be null")) {
      ok("11: null p_import_document_id raises correct error");
    } else if (error) {
      fail("11", `unexpected error: ${error.message}`);
    } else {
      fail("11", "null document ID was accepted — null guard is missing");
    }
  }
}

// ── Cleanup ───────────────────────────────────────────────────────────────────

async function cleanup() {
  console.log("\n[cleanup] removing test fixtures …");
  const errors = [];

  // Delete in reverse FK order
  for (const id of createdIds.attachments) {
    const { error } = await admin.from("inbound_attachments").delete().eq("id", id);
    if (error) errors.push(`attachment ${id}: ${error.message}`);
  }
  for (const id of createdIds.documents) {
    const { error } = await admin.from("import_documents").delete().eq("id", id);
    if (error) errors.push(`document ${id}: ${error.message}`);
  }
  for (const id of createdIds.vendors) {
    const { error } = await admin.from("vendors").delete().eq("id", id);
    if (error) errors.push(`vendor ${id}: ${error.message}`);
  }
  for (const id of createdIds.users) {
    const { error } = await admin.auth.admin.deleteUser(id);
    if (error) errors.push(`user ${id}: ${error.message}`);
  }
  for (const id of createdIds.orgs) {
    const { error } = await admin.from("organizations").delete().eq("id", id);
    if (error) errors.push(`org ${id}: ${error.message}`);
  }

  if (errors.length) {
    console.log("\n[cleanup ERRORS — manual deletion may be needed]");
    for (const e of errors) console.log(`  ✗ ${e}`);
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
  process.exit(1);
} else {
  console.log("All A1.7 database checks passed.");
  process.exit(0);
}
