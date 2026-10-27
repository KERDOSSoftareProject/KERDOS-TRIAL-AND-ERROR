import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { receiptVendorId } from "../supabase/functions/process-attachment/receipt-vendor.mjs";
import { receiptDocumentType } from "../supabase/functions/process-attachment/receipt-document-type.mjs";

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
check("receiptDocumentType respects snapshot guard — same contract as receiptVendorId", () => {
  const withSnapshot   = { receipt_document_type: "pricelist", vendor_snapshot_at: "2026-10-27T00:00:00Z" };
  const noSnapshot     = { receipt_document_type: "pricelist", vendor_snapshot_at: null };
  const invoiceSnap    = { receipt_document_type: "invoice",   vendor_snapshot_at: "2026-10-27T00:00:00Z" };
  const nullDocSnap    = { receipt_document_type: null,        vendor_snapshot_at: "2026-10-27T00:00:00Z" };
  assert.equal(receiptDocumentType(withSnapshot),   "pricelist");
  assert.equal(receiptDocumentType(noSnapshot),     null);  // no snapshot → do not infer
  assert.equal(receiptDocumentType(invoiceSnap),    "invoice");
  assert.equal(receiptDocumentType(nullDocSnap),    null);
  assert.equal(receiptDocumentType([withSnapshot]), "pricelist"); // array form
  assert.equal(receiptDocumentType([]),             null);
});
check("webhook records the snapshot on the message, including unassigned routes", () => {
  const webhook = source("../supabase/functions/inbound-email/index.ts");
  // Routing row must fetch document_type alongside vendor_id
  assert.match(webhook, /\.select\("id, organization_id, vendor_id, document_type, forward_to"\)/);
  assert.match(webhook, /receipt_vendor_id:\s*receiptVendorId \?\? null/);
  assert.match(webhook, /receipt_document_type:\s*documentType \?\? null/);
  assert.match(webhook, /vendor_snapshot_at:\s*new Date\(\)\.toISOString\(\)/);
});
check("processor consumes receipt snapshot rather than mutable route", () => {
  const processor = source("../supabase/functions/process-attachment/index.ts");
  assert.match(processor, /vendorId\s*=\s*receiptVendorId\(/);
  assert.match(processor, /documentType\s*=\s*receiptDocumentType\(/);
  // document_type must be selected from the message join
  assert.match(processor, /receipt_document_type/);
  // documentType must be forwarded to the background importer
  assert.match(processor, /documentType\s*\}/);
  assert.doesNotMatch(processor, /email_routing_addresses \( vendor_id \)/);
});
check("database validation uses receipt vendor and protects its immutability", () => {
  const migration = source("../knowledge/migration_038_receipt_vendor_snapshot_draft.sql");
  assert.match(migration, /im\.receipt_vendor_id, im\.vendor_snapshot_at/);
  assert.match(migration, /inbound_messages_vendor_snapshot_immutable/);
  assert.match(migration, /receipt-time vendor snapshot cannot be changed/);
});
check("migration_039 extends snapshot trigger to cover receipt_document_type", () => {
  const migration = source("../knowledge/migration_039_routing_document_type.sql");
  // Domain constraint removed
  assert.match(migration, /DROP CONSTRAINT IF EXISTS email_routing_addresses_inbound_domain/);
  // document_type column on routing addresses
  assert.match(migration, /ADD COLUMN IF NOT EXISTS document_type text/);
  assert.match(migration, /CHECK \(document_type IN \('pricelist', 'invoice'\)\)/);
  // receipt_document_type column on messages
  assert.match(migration, /ADD COLUMN IF NOT EXISTS receipt_document_type text/);
  // Trigger extended to cover receipt_document_type
  assert.match(migration, /receipt_document_type IS DISTINCT FROM OLD\.receipt_document_type/);
  assert.match(migration, /receipt-time vendor\/document snapshot cannot be changed/);
});
check("background-import uses registration document_type, not content guess", () => {
  const bg = source("../supabase/functions/process-attachment/background-import.mjs");
  // documentType parameter in signature (default null)
  assert.match(bg, /documentType = null/);
  // classifyDocument is exported as a named export for direct unit testing
  assert.match(bg, /export function classifyDocument/);
  // registration-based classification is present in classifyDocument
  assert.match(bg, /documentType === "invoice"/);
  assert.match(bg, /documentType === "pricelist"/);
  // content fallback is still present for unregistered addresses
  assert.match(bg, /contentKind/);
  // A1.2.g: validated invoice lines go through the fenced atomic writer.
  assert.match(bg, /prepareAutomaticInvoice/);
  assert.match(bg, /invoices\.recordAutomatic/);
  // TypeScript variable declaration removed (file is .mjs, not .ts)
  assert.doesNotMatch(bg, /\blet isInvoice: boolean/);
  // hardcoded content-guess assignment removed from primary path
  assert.doesNotMatch(bg, /const isInvoice = documentKind === "invoice"/);
});
check("email-routing service exposes documentType and removes hardcoded domain", () => {
  const svc = source("../src/services/email-routing.js");
  // createRoutingAddress accepts documentType
  assert.match(svc, /documentType.*\}/);
  assert.match(svc, /document_type:\s*documentType \|\| null/);
  // listRoutingAddresses fetches document_type
  assert.match(svc, /vendor_id, document_type, is_active/);
  // hardcoded domain check removed
  assert.doesNotMatch(svc, /@inbound\.kerdos\.com/);
});
check("receiving UI is read-only and tabs supply document context", () => {
  const panel=source("../src/pages/ReceivingAddresses.jsx");
  const pages=source("../src/pages/DocumentPages.jsx");
  assert.doesNotMatch(panel, /<select|<input|createRoutingAddress|setRoutingAddressVendor|setRoutingAddressDocumentType/);
  assert.match(pages,/documentType="invoice"/);
  assert.match(pages,/documentType="pricelist"/);
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
