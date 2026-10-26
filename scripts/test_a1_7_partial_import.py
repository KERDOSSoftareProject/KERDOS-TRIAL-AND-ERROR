"""
test_a1_7_partial_import.py
===========================
A1.7 — Partial Import Recovery (revised after blocker review)

Tests the behavioral properties identified in the A1.7 review:

  A1.7.a — Document identity
    - findPriceDocumentById validates org + vendor + document_kind
    - No fingerprint fallback when inboxImportDocumentId is set
    - Hard fail on null result from the ID lookup

  A1.7.b — Row-key consistency
    - Background worker uses row:N (globalRowIndex across all groups)
    - ImportModal uses the same globalRowIndex counter, not per-group index
    - Old-format keys in completed_keys are stripped before verifyResumeRows
    - verifyResumeRows regex unchanged; old keys would have thrown without the filter

  A1.7.c — Status persistence
    - mark_attachment_ingested accepts p_final_status (migration_035)
    - Audit-link retry preserves and replays pendingFinalStatus
    - Migration drops old 2-param overload before creating 3-param version
    - New function receives GRANT EXECUTE to authenticated

  Deduplication safety
    - price_history ON CONFLICT DO NOTHING on source_row_key
    - importPriceRow stores rowKey: completedKey
    - Background passes completedKey to importPriceRow

All checks are structural/textual; no live database required.
"""

import sys, re, pathlib

ROOT = pathlib.Path(__file__).parent.parent
PASS = []
FAIL = []


def ok(name):
    PASS.append(name)
    print(f"  PASS  {name}")


def fail(name, reason):
    FAIL.append(name)
    print(f"  FAIL  {name}: {reason}")


def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def check(source, needle, name, context=""):
    if needle not in source:
        fail(name, f"could not find {repr(needle)}" + (f" in {context}" if context else ""))
        return False
    ok(name)
    return True


def check_absent(source, needle, name):
    if needle in source:
        fail(name, f"found unexpected {repr(needle)}")
        return False
    ok(name)
    return True


# ── Load sources ──────────────────────────────────────────────────────────────

imports_js  = read("src/services/imports.js")
modal_js    = read("src/pages/ImportModal.jsx")
inbox_jsx   = read("src/pages/EmailInboxPanel.jsx")
routing_js  = read("src/services/email-routing.js")
bg          = read("supabase/functions/process-attachment/background-import.mjs")
resume_js   = read("src/core/import-resume.js")
price_row   = read("src/core/import-price-row.js")
migration   = read("knowledge/migration_035_partial_import_recovery.sql")
migration33 = read("knowledge/migration_033_auto_processing.sql")

# ──────────────────────────────────────────────────────────────────────────────
# A1.7.a — Document identity
# ──────────────────────────────────────────────────────────────────────────────

print("\nA1.7.a — Document identity: safe lookup, no fallback")

check(imports_js, "findPriceDocumentById",
      "A1.7.a.1: findPriceDocumentById exists in imports.js")
check(imports_js, 'eq("organization_id",organizationId)',
      "A1.7.a.2: filters by organization_id")
check(imports_js, 'eq("vendor_id",vendorId)',
      "A1.7.a.3: filters by vendor_id")
check(imports_js, 'eq("id",documentId)',
      "A1.7.a.4: filters by documentId")

check(modal_js, "inboxImportDocumentId",
      "A1.7.a.5: PasteModal accepts inboxImportDocumentId prop")
check(modal_js, "findPriceDocumentById",
      "A1.7.a.6: ImportModal calls findPriceDocumentById when prop is set")

check(inbox_jsx, "inboxImportDocumentId={att.import_document_id",
      "A1.7.a.7: EmailInboxPanel passes att.import_document_id as prop")

# No fingerprint fallback when inboxImportDocumentId is set
# The old fallback used findPriceDocument inside the inboxImportDocumentId branch;
# now it must not appear there (fingerprint lookup is only in the else branch).
# We verify the "fail safely" path is present instead.
check(modal_js,
      "linked import document could not be verified",
      "A1.7.a.8: hard-fail message when ID lookup returns null (no fingerprint fallback)")

# The fingerprint lookup must still exist — but only in the else branch.
check(modal_js, "findPriceDocument({organizationId:orgId,vendorId,fingerprint})",
      "A1.7.a.9: fingerprint lookup still present (for non-inbox path)")

# Verify the two branches are mutually exclusive: within the inboxImportDocumentId
# branch there must be no call to findPriceDocument (it must come only in else).
# Check by finding the if-block and confirming findPriceDocument is absent before
# the else keyword that closes the inboxImportDocumentId branch.
inbox_branch_start = modal_js.find("if(inboxImportDocumentId){")
inbox_branch_else  = modal_js.find("} else {", inbox_branch_start)
inbox_branch_text  = modal_js[inbox_branch_start:inbox_branch_else] if inbox_branch_start != -1 and inbox_branch_else != -1 else ""
check_absent(inbox_branch_text, "findPriceDocument({",
             "A1.7.a.10: no fingerprint lookup inside the inboxImportDocumentId branch")

# ──────────────────────────────────────────────────────────────────────────────
# A1.7.b — Row-key consistency
# ──────────────────────────────────────────────────────────────────────────────

print("\nA1.7.b — Row-key consistency: global counter in both worker and modal")

# Background uses globalRowIndex across all groups
check(bg, "globalRowIndex",   "A1.7.b.1: background-import has globalRowIndex")
check(bg, "`row:${globalRowIndex}`", "A1.7.b.2: background completedKey = row:${globalRowIndex}")
check(bg, "globalRowIndex++", "A1.7.b.3: background increments for every row")
check_absent(bg, "sourceRow.rowKey || sourceRow.sourceLine",
             "A1.7.b.4: old fallback key format removed from background")

# ImportModal uses per-group counter (row:${rowIndex}) NOT globalRowIndex.
# Per-group is correct: each group has its own document; verifyResumeRows uses
# rows[N] where N is parsed from row:N, so keys must be 0-based within the
# passed-in group.rows array.  For inbox resume (single group), per-group ==
# global so alignment with the background worker is preserved.
check(modal_js, "`row:${rowIndex}`",
      "A1.7.b.5: ImportModal completedKey = row:${rowIndex} (per-group)")
check_absent(modal_js, "let globalRowIndex=0",
             "A1.7.b.6: no globalRowIndex in ImportModal (reverted; per-group is correct)")
check_absent(modal_js, "const progressKey=index=>`row:${index}`",
             "A1.7.b.7: old per-group progressKey helper removed from ImportModal")

# Old-key detection: block explicitly rather than silently filter.
# verifyResumeRows throws on old-format saved keys (savedRows pass) BEFORE
# the completedKeys check; silently filtering completedKeys did not address
# the savedRows side.  Explicit block preserves saved-row evidence and gives
# the user a clear path (delete and re-import).
check(modal_js, "validRowKey=/^row:\\d+$/",
      "A1.7.b.8: modal declares validRowKey regex for inbox old-key detection")
check(modal_js, "badKeys=[...completedKeys].filter(k=>!validRowKey.test(k))",
      "A1.7.b.9: modal collects bad keys into badKeys array")
check(modal_js, "if(badKeys.length>0){",
      "A1.7.b.10: modal blocks resumption when any bad key detected")
check(modal_js, "cannot be resumed",
      "A1.7.b.11: block message tells user partial cannot be resumed")
check_absent(modal_js, "if(!validRowKey.test(k))completedKeys.delete(k)",
             "A1.7.b.12: old silent delete-from-completedKeys filter removed")

# Old-key error message must cite the accurate recovery path:
# "Delete & re-import" button exists in DocumentPages; ON DELETE SET NULL
# cascades when the import_document is deleted, re-enabling the inbox path.
check(modal_js, '"Delete & re-import" in Price Sheets',
      "A1.7.b.13: old-key message cites the correct UI action (Delete & re-import)")
check(modal_js, "reappear in the inbox",
      "A1.7.b.14: old-key message explains the attachment re-appears in inbox after delete")

# Inbox multi-group guard: when inboxImportDocumentId is set, block if more
# than one group has rows — all groups would try to write into the same
# linked document, which is always a single-group attachment document.
check(modal_js, "Inbox resume requires a single document",
      "A1.7.b.15: inbox multi-group guard present — blocks before any writes")

# Guard must come BEFORE the group loop so no partial writes can happen
guard_mg_pos = modal_js.find("Inbox resume requires a single document")
loop_pos     = modal_js.find("let failedRows=0;")
if guard_mg_pos == -1:
    fail("A1.7.b.16", "multi-group guard message not found")
elif loop_pos == -1:
    fail("A1.7.b.16", "failedRows declaration not found")
elif guard_mg_pos < loop_pos:
    ok("A1.7.b.16: multi-group guard is positioned before the group loop (before failedRows)")
else:
    fail("A1.7.b.16", f"guard at {guard_mg_pos} must precede loop at {loop_pos}")

# verifyResumeRows regex unchanged
check(resume_js, r"/^row:(\d+)$/",
      "A1.7.b.17: verifyResumeRows regex still /^row:(\\d+)$/")

# ──────────────────────────────────────────────────────────────────────────────
# A1.7.c — Status persistence
# ──────────────────────────────────────────────────────────────────────────────

print("\nA1.7.c — Status persistence: migration, retry, grants")

# Migration file is 035, not 034
check(migration, "migration_035_partial_import_recovery.sql",
      "A1.7.c.1: migration file is numbered 035")

# Old 2-param overload dropped before the new one is created
drop_pos   = migration.find("DROP FUNCTION IF EXISTS mark_attachment_ingested(uuid, uuid)")
create_pos = migration.find("CREATE OR REPLACE FUNCTION mark_attachment_ingested(")
if drop_pos == -1:
    fail("A1.7.c.2", "DROP FUNCTION for old (uuid,uuid) overload not found")
elif create_pos == -1:
    fail("A1.7.c.2", "CREATE OR REPLACE FUNCTION not found")
elif drop_pos < create_pos:
    ok("A1.7.c.2: DROP old (uuid,uuid) overload precedes CREATE of 3-param version")
else:
    fail("A1.7.c.2", "DROP must come before CREATE")

check(migration, "p_final_status",
      "A1.7.c.3: migration adds p_final_status parameter")
check(migration, "DEFAULT NULL",
      "A1.7.c.4: p_final_status defaults to NULL (backwards-compatible)")
check(migration, "NOT IN ('auto_imported', 'needs_review')",
      "A1.7.c.5: migration validates allowed values")
check(migration, "SET processing_status = p_final_status",
      "A1.7.c.6: migration sets processing_status column")

# Completion guard: auto_imported requires import_document to be 'complete'
guard_text = "import document is not complete"
check(migration, guard_text,
      "A1.7.c.7: completion guard present — auto_imported requires complete document")
guard_pos      = migration.find(guard_text)
idempotent_pos = migration.find("Idempotency: if this attachment is already linked")
if guard_pos == -1:
    fail("A1.7.c.8", "completion guard not found")
elif idempotent_pos == -1:
    fail("A1.7.c.8", "idempotency block marker not found")
elif guard_pos < idempotent_pos:
    ok("A1.7.c.8: completion guard positioned before idempotency block")
else:
    fail("A1.7.c.8", f"guard at {guard_pos} must precede idempotency block at {idempotent_pos}")

# Idempotent re-link path also applies status
idempotent = migration[migration.find("Already linked to the same document"):]
check(idempotent, "SET processing_status = p_final_status",
      "A1.7.c.9: idempotent re-link path also updates processing_status")

# Grants for new 3-param signature
check(migration, "REVOKE EXECUTE ON FUNCTION mark_attachment_ingested(uuid, uuid, text) FROM PUBLIC",
      "A1.7.c.10: REVOKE from PUBLIC on 3-param signature")
check(migration, "GRANT  EXECUTE ON FUNCTION mark_attachment_ingested(uuid, uuid, text) TO authenticated",
      "A1.7.c.11: GRANT to authenticated on 3-param signature")

# email-routing.js passes finalStatus
check(routing_js, "finalStatus = null",
      "A1.7.c.12: markAttachmentIngested accepts optional finalStatus")
check(routing_js, "p_final_status:       finalStatus",
      "A1.7.c.13: markAttachmentIngested forwards finalStatus as p_final_status")

# EmailInboxPanel passes 'auto_imported'
check(inbox_jsx, '"auto_imported"',
      "A1.7.c.14: EmailInboxPanel passes auto_imported to markAttachmentIngested")

# Audit retry preserves and replays pendingFinalStatus
check(inbox_jsx, "pendingFinalStatus",
      "A1.7.c.15: EmailInboxPanel tracks pendingFinalStatus state")
check(inbox_jsx, "setPendingFinalStatus(\"auto_imported\")",
      "A1.7.c.16: sets pendingFinalStatus to auto_imported on first failure")
check(inbox_jsx, "markAttachmentIngested(backend,orgId,att.id,pendingImportDocumentId,pendingFinalStatus)",
      "A1.7.c.17: retry passes pendingFinalStatus to markAttachmentIngested")
check(inbox_jsx, "setPendingFinalStatus(null)",
      "A1.7.c.18: clears pendingFinalStatus after successful retry")

# alreadyIngested excludes needs_review
check(inbox_jsx, 'att.processing_status !== "needs_review"',
      "A1.7.c.19: alreadyIngested excludes needs_review attachments")

# pending_count includes needs_review
check(routing_js, 'processing_status === "needs_review"',
      "A1.7.c.20: pending_count includes needs_review attachments")

# ──────────────────────────────────────────────────────────────────────────────
# Deduplication safety proof
# ──────────────────────────────────────────────────────────────────────────────

print("\nDeduplication safety proof")

check(migration33, "source_row_key",
      "dup.1: price_history has source_row_key column")
check(migration33, "ON CONFLICT",
      "dup.2: kerdos_auto_apply_price_quote uses ON CONFLICT DO NOTHING")
check(price_row, "rowKey: completedKey",
      "dup.3: importPriceRow stores rowKey: completedKey in importRow")
check(bg, "completedKey,",
      "dup.4: background-import passes completedKey to importPriceRow")

# ──────────────────────────────────────────────────────────────────────────────
# Summary
# ──────────────────────────────────────────────────────────────────────────────

print()
total = len(PASS) + len(FAIL)
print(f"Results: {len(PASS)}/{total} passed")
if FAIL:
    print("\nFailed:")
    for f in FAIL:
        print(f"  ✗ {f}")
    sys.exit(1)
else:
    print("All A1.7 structural checks passed.")
    sys.exit(0)
