import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { receiptVendorId } from "../supabase/functions/process-attachment/receipt-vendor.mjs";

const source = path => readFileSync(new URL(path, import.meta.url), "utf8");
let passed = 0;
const check = (name, fn) => { fn(); passed++; console.log(`PASS ${name}`); };

check("captured vendor survives later route reassignment", () => {
  const message = { receipt_vendor_id: "vendor-at-receipt", vendor_snapshot_at: "2026-10-27T00:00:00Z" };
  const mutableRoute = { vendor_id: "vendor-assigned-later" };
  assert.equal(receiptVendorId(message), "vendor-at-receipt");
  assert.notEqual(receiptVendorId(message), mutableRoute.vendor_id);
});
check("explicitly unassigned message remains manual", () => {
  assert.equal(receiptVendorId({ receipt_vendor_id: null, vendor_snapshot_at: "2026-10-27T00:00:00Z" }), null);
});
check("legacy message cannot borrow today's routing assignment", () => {
  assert.equal(receiptVendorId({ receipt_vendor_id: null, vendor_snapshot_at: null }), null);
  assert.equal(receiptVendorId([]), null);
});
check("webhook records the snapshot on the message, including unassigned routes", () => {
  const webhook = source("../supabase/functions/inbound-email/index.ts");
  assert.match(webhook, /\.select\("id, organization_id, vendor_id, forward_to"\)/);
  assert.match(webhook, /receipt_vendor_id:\s*receiptVendorId \?\? null/);
  assert.match(webhook, /vendor_snapshot_at:\s*new Date\(\)\.toISOString\(\)/);
});
check("processor consumes receipt snapshot rather than mutable route", () => {
  const processor = source("../supabase/functions/process-attachment/index.ts");
  assert.match(processor, /vendorId = receiptVendorId\(/);
  assert.doesNotMatch(processor, /email_routing_addresses \( vendor_id \)/);
});
check("database validation uses receipt vendor and protects its immutability", () => {
  const migration = source("../knowledge/migration_038_receipt_vendor_snapshot_draft.sql");
  assert.match(migration, /im\.receipt_vendor_id, im\.vendor_snapshot_at/);
  assert.match(migration, /inbound_messages_vendor_snapshot_immutable/);
  assert.match(migration, /receipt-time vendor snapshot cannot be changed/);
});
check("closing preview cannot reserve the attachment", () => {
  const inbox = source("../src/pages/EmailInboxPanel.jsx");
  const handler = inbox.slice(inbox.indexOf("async function handleReviewAndImport"), inbox.indexOf("async function handleImportFinished"));
  assert.doesNotMatch(handler, /beginManualAttachmentReview\(/);
  assert.match(inbox, /onClose=\{\(\)=>setPendingFile\(null\)\}/);
  assert.match(inbox, /onBeforeSave=\{\(\)=>beginManualAttachmentReview\(/);
});
check("reservation precedes the modal's first save-side effect", () => {
  const modal = source("../src/pages/ImportModal.jsx");
  const start = modal.indexOf("async function saveImport()");
  const reserve = modal.indexOf("await onBeforeSave()", start);
  const firstWrite = modal.indexOf("await documents.uploadOriginal", start);
  assert.ok(reserve > start && reserve < firstWrite);
  assert.match(modal.slice(reserve, firstWrite), /if\(!allowed\)throw/);
  assert.match(modal, /if\(onBeforeSave\)return;\s*if\(step!==2/);
  assert.match(modal, /onBeforeSave&&!saveReview\?"Save Import"/);
});
console.log(`${passed}/${passed} Module A interaction checks passed`);
