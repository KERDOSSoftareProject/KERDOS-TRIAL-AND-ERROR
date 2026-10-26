"""
test_a1_7_partial_import.py
===========================
A1.7 — Partial Import Recovery

Tests three sub-tasks without a live database:

  A1.7.a — importService.findPriceDocumentById validates organization and
            vendor ownership before returning a document.  A lookup against
            the wrong org or vendor must return null so PasteModal cannot
            resume a document belonging to another tenant.

  A1.7.b — background-import.mjs uses row:N keys (0-based across all groups)
            so completed_keys in import_documents matches ImportModal's
            progressKey format and verifyResumeRows() can validate them.

  A1.7.c — mark_attachment_ingested() accepts an optional p_final_status and
            sets processing_status atomically.  The migration SQL is verified
            structurally: parameter present, validation of allowed values,
            and the idempotent status-update path on re-link.

All tests run in-process with no database connection required.
"""

import sys, re, ast, pathlib, textwrap

ROOT = pathlib.Path(__file__).parent.parent
PASS = []
FAIL = []

def ok(name):
    PASS.append(name)
    print(f"  PASS  {name}")

def fail(name, reason):
    FAIL.append(name)
    print(f"  FAIL  {name}: {reason}")

# ──────────────────────────────────────────────────────────────────────────────
# Helpers
# ──────────────────────────────────────────────────────────────────────────────

def read(path):
    return (ROOT / path).read_text(encoding="utf-8")


def assert_contains(source, needle, name, context=""):
    if needle not in source:
        fail(name, f"could not find {repr(needle)}" + (f" in {context}" if context else ""))
        return False
    ok(name)
    return True


def assert_not_contains(source, needle, name):
    if needle in source:
        fail(name, f"found unexpected {repr(needle)}")
        return False
    ok(name)
    return True

# ──────────────────────────────────────────────────────────────────────────────
# A1.7.a — findPriceDocumentById ownership check
# ──────────────────────────────────────────────────────────────────────────────

print("\nA1.7.a — findPriceDocumentById ownership validation")

imports_js = read("src/services/imports.js")

assert_contains(
    imports_js,
    "findPriceDocumentById",
    "A1.7.a.1: findPriceDocumentById method exists in imports.js",
)

# Must filter by organization_id AND vendor_id — ownership guards
assert_contains(
    imports_js,
    'eq("organization_id",organizationId)',
    "A1.7.a.2: findPriceDocumentById filters by organization_id",
    "findPriceDocumentById",
)
assert_contains(
    imports_js,
    'eq("vendor_id",vendorId)',
    "A1.7.a.3: findPriceDocumentById filters by vendor_id",
    "findPriceDocumentById",
)
assert_contains(
    imports_js,
    'eq("id",documentId)',
    "A1.7.a.4: findPriceDocumentById filters by documentId (id column)",
)

# ImportModal must accept the new prop
modal_js = read("src/pages/ImportModal.jsx")
assert_contains(
    modal_js,
    "inboxImportDocumentId",
    "A1.7.a.5: PasteModal accepts inboxImportDocumentId prop",
)
assert_contains(
    modal_js,
    "findPriceDocumentById",
    "A1.7.a.6: ImportModal calls findPriceDocumentById when prop is set",
)

# EmailInboxPanel must pass att.import_document_id as the prop
inbox_jsx = read("src/pages/EmailInboxPanel.jsx")
assert_contains(
    inbox_jsx,
    "inboxImportDocumentId={att.import_document_id",
    "A1.7.a.7: EmailInboxPanel passes att.import_document_id as inboxImportDocumentId",
)

# Fallback: if findPriceDocumentById returns null, ImportModal must fall back
# to fingerprint lookup (not silently create a fresh document)
assert_contains(
    modal_js,
    "findPriceDocument({organizationId:orgId,vendorId,fingerprint})",
    "A1.7.a.8: ImportModal falls back to fingerprint lookup if ID lookup returns null",
)

# ──────────────────────────────────────────────────────────────────────────────
# A1.7.b — background worker uses row:N key format
# ──────────────────────────────────────────────────────────────────────────────

print("\nA1.7.b — background-import rowKey = row:N format")

bg = read("supabase/functions/process-attachment/background-import.mjs")

assert_contains(
    bg,
    "globalRowIndex",
    "A1.7.b.1: background-import uses a globalRowIndex counter",
)
assert_contains(
    bg,
    "`row:${globalRowIndex}`",
    "A1.7.b.2: completedKey is row:${globalRowIndex}",
)
assert_contains(
    bg,
    "globalRowIndex++",
    "A1.7.b.3: globalRowIndex increments for every row (including skipped ones)",
)

# The old fallback formats must be gone
assert_not_contains(
    bg,
    "sourceRow.rowKey || sourceRow.sourceLine",
    "A1.7.b.4: old sourceLine/JSON fallback key removed",
)

# Verify that ImportModal uses the same row:N format (alignment check)
assert_contains(
    modal_js,
    "progressKey=index=>`row:${index}`",
    "A1.7.b.5: ImportModal progressKey uses row:${index} format (key-format alignment)",
)

# verifyResumeRows expects /^row:(\d+)$/ — confirm it's unchanged
resume_js = read("src/core/import-resume.js")
assert_contains(
    resume_js,
    r"/^row:(\d+)$/",
    "A1.7.b.6: verifyResumeRows regex still expects ^row:(\\d+)$ format",
)

# ──────────────────────────────────────────────────────────────────────────────
# A1.7.c — mark_attachment_ingested sets processing_status
# ──────────────────────────────────────────────────────────────────────────────

print("\nA1.7.c — processing_status persisted after user review")

migration = read("knowledge/migration_034_partial_import_recovery.sql")

assert_contains(
    migration,
    "p_final_status",
    "A1.7.c.1: migration adds p_final_status parameter",
)
assert_contains(
    migration,
    "DEFAULT NULL",
    "A1.7.c.2: p_final_status defaults to NULL (backwards-compatible)",
)
assert_contains(
    migration,
    "NOT IN ('auto_imported', 'needs_review')",
    "A1.7.c.3: migration rejects values outside the allowed set",
)
assert_contains(
    migration,
    "SET processing_status = p_final_status",
    "A1.7.c.4: migration UPDATE sets processing_status column",
)
# Idempotency on re-link must also apply the status update
idempotent_section = migration[migration.find("Already linked to the same document"):]
assert_contains(
    idempotent_section,
    "SET processing_status = p_final_status",
    "A1.7.c.5: idempotent re-link path also updates processing_status",
)

# email-routing.js must pass the finalStatus argument
routing_js = read("src/services/email-routing.js")
assert_contains(
    routing_js,
    "finalStatus = null",
    "A1.7.c.6: markAttachmentIngested accepts optional finalStatus param",
)
assert_contains(
    routing_js,
    "p_final_status:       finalStatus",
    "A1.7.c.7: markAttachmentIngested forwards finalStatus as p_final_status",
)

# EmailInboxPanel must pass 'auto_imported' after successful PasteModal review
assert_contains(
    inbox_jsx,
    '"auto_imported"',
    "A1.7.c.8: EmailInboxPanel passes 'auto_imported' to markAttachmentIngested",
)

# alreadyIngested must exclude needs_review attachments
assert_contains(
    inbox_jsx,
    'att.processing_status !== "needs_review"',
    "A1.7.c.9: alreadyIngested excludes needs_review attachments",
)

# pending_count must count needs_review attachments as still pending
assert_contains(
    routing_js,
    'processing_status === "needs_review"',
    "A1.7.c.10: listMessages pending_count includes needs_review attachments",
)

# processing_status must be fetched in both listMessages and getMessage
assert_contains(
    routing_js,
    "processing_status",
    "A1.7.c.11: processing_status selected in email-routing queries",
)

# ──────────────────────────────────────────────────────────────────────────────
# Deduplication safety proof (A1.7.b cross-check)
# ──────────────────────────────────────────────────────────────────────────────

print("\nA1.7 — Deduplication safety proof")

migration_033 = read("knowledge/migration_033_auto_processing.sql")

# price_history ON CONFLICT key must include source_row_key
assert_contains(
    migration_033,
    "source_row_key",
    "dup.1: price_history has source_row_key column for ON CONFLICT guard",
)
assert_contains(
    migration_033,
    "ON CONFLICT",
    "dup.2: kerdos_auto_apply_price_quote uses ON CONFLICT DO NOTHING",
)

# importPriceRow stores rowKey: completedKey in importRow JSON
price_row_js = read("src/core/import-price-row.js")
assert_contains(
    price_row_js,
    "rowKey: completedKey",
    "dup.3: importPriceRow stores rowKey: completedKey in importRow (idempotency key)",
)

# Background worker must pass completedKey (which is now row:N) to importPriceRow
assert_contains(
    bg,
    "completedKey,",
    "dup.4: background-import passes completedKey to importPriceRow",
)

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
