import assert from "node:assert/strict";
import {
  attachmentStateFlags, attachmentRenderOutcome, attachmentActionBlocked,
} from "./attachment-state.js";

let passed = 0;
function check(name, actual, expected) {
  assert.deepEqual(actual, expected, name);
  passed++;
}

// H9: ordinary attachment remains actionable for manual review.
const pending = { import_document_id: null, processing_status: "needs_review", ingest_error: null };
check("H9 pending flags", attachmentStateFlags(pending), { alreadyIngested: false, partialReview: false });
check("H9 pending render", attachmentRenderOutcome(pending), "button");
check("H9 pending action", attachmentActionBlocked(pending), false);

// H10: a linked partial document resumes through A1.7, without creating a second document.
const partial = { import_document_id: "doc-1", processing_status: "needs_review", ingest_error: null };
check("H10 partial flags", attachmentStateFlags(partial), { alreadyIngested: false, partialReview: true });
check("H10 partial render", attachmentRenderOutcome(partial), "partial");
check("H10 partial action remains available", attachmentActionBlocked(partial), false);

// H11: a completed link must not be imported again.
const imported = { import_document_id: "doc-1", processing_status: "auto_imported", ingest_error: null };
check("H11 imported flags", attachmentStateFlags(imported), { alreadyIngested: true, partialReview: false });
check("H11 imported render", attachmentRenderOutcome(imported), "imported");
check("H11 imported action", attachmentActionBlocked(imported), true);

// H12: local busy/done state closes repeated clicks while DB data refreshes.
check("H12 loading render", attachmentRenderOutcome(partial, "loading"), "partial");
check("H12 loading action", attachmentActionBlocked(partial, "loading"), true);
check("H12 done render", attachmentRenderOutcome(pending, "ingested"), "imported");
check("H12 done action", attachmentActionBlocked(pending, "ingested"), true);

// H13: a permanent decode failure is visible, with no import action.
const failed = { import_document_id: null, processing_status: "pending", ingest_error: "bad base64" };
check("H13 failed render", attachmentRenderOutcome(failed), "failed");
check("H13 failed action", attachmentActionBlocked(failed), true);
check("H13 failed overrides linked state", attachmentRenderOutcome({ ...partial, ingest_error: "bad base64" }), "failed");
check("H13 missing row safely blocked", attachmentActionBlocked(null), true);

console.log(`${passed} attachment-state assertions passed`);
