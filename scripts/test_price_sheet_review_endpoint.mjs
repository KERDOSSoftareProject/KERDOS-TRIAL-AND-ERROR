import assert from "node:assert/strict";
import { createPriceSheetReviewHandler } from "../supabase/functions/price-sheet-review/handler.mjs";

const id = value => `00000000-0000-4000-8000-${String(value).padStart(12, "0")}`;
const organization = {id: id(1), industry: "construction", settings: {}};
const owner = id(2);
const manager = id(3);
const vendorId = id(4);
const category = {id: id(5), name: "Hardware"};
const now = new Date("2026-11-11T03:00:00.000Z");
const documents = [6, 7].map(value => ({
  id: id(value), organization_id: organization.id, vendor_id: vendorId,
  document_kind: "pricelist", status: "complete", file_name: "pricing.csv",
  fingerprint: `document-${value}`, original_text: "",
}));
const listings = documents.map((document, i) => ({
  id: id(10 + i), organization_id: organization.id, vendor_id: vendorId,
  vendor_item_code: `B${i}`, description: `Zinc bolt ${i + 1} inch`, brand: null,
  price: 25, pack_size: "12 EA", selling_unit: "CS", price_basis: "case",
  price_source: "price_list", price_unavailable: true, last_updated: now.toISOString(),
  price_expired_at: null, row_revision: 1, field_resolutions: {},
  import_row: {
    sourceDocumentId: document.id, rowKey: "row:0", reviewRequired: true, reviewFields: ["selling_unit"],
    row: {code: `B${i}`, description: `Zinc bolt ${i + 1} inch`, packSize: "12 EA", sellingUnit: null, price: 25, sourceLine: `B${i},25`},
    evidence: {sellingUnit: "CS", sellingUnitSource: "inferred"},
  },
}));
const mappings = listings.map((listing, i) => ({
  id: id(20 + i), organization_id: organization.id, vendor_item_id: listing.id,
  catalog_item_id: id(30 + i), comparison_track: "exact", confidence_score: 100, match_method: "manual",
}));
const catalogItems = listings.map((listing, i) => ({id: id(30 + i), category_id: category.id, name: listing.description}));
let vocabulary = [];
const receipts = new Map();
let writes = 0;
const review = createPriceSheetReviewHandler({
  secret: "test-only-signing-key",
  clock: () => now,
  authenticate: request => request.headers.get("authorization"),
  membership: (orgId, actor) => orgId !== organization.id ? null : actor === owner ? "owner" : actor === manager ? "manager" : null,
  loadWorkspace(orgId, documentId) {
    const document = documents.find(entry => entry.id === documentId && entry.organization_id === orgId);
    return structuredClone({organization, vocabulary, document, documents: document ? [document] : documents,
      listings, mappings, catalogItems, categories: [category], vendors: [{id: vendorId}], rawInvoices: []});
  },
  readOperation: ({operationId}) => receipts.get(operationId) || null,
  applyOperation({operationId, operation, actorId, plan}) {
    writes++;
    for (const row of plan.rows) {
      const listing = listings.find(entry => entry.id === row.listingId);
      assert.deepEqual(listing, row.expectedListing);
      if (operation === "confirm") {
        listing.selling_unit = row.sellingUnit;
        listing.price_basis = row.priceBasis;
        listing.price_unavailable = row.priceUnavailable;
        listing.field_resolutions.selling_unit = {value: row.sellingUnit, sourceValue: null, confirmedBy: actorId,
          confirmedAt: now.toISOString(), documentConfirmation: {
            operationId, organizationId: organization.id, vendorId, documentId: plan.documentId,
            documentFingerprint: plan.documentFingerprint, listingId: listing.id, rowKey: row.rowKey,
            packSize: row.packSize, observationHash: "a".repeat(64),
          }};
      } else {
        listing.import_row = {...listing.import_row, reviewRequired: row.reviewRequired, reviewFields: row.reviewFields, baseline: row.baseline};
      }
    }
    const receipt = {operationId, action: operation, confirmedBy: actorId, summary: plan.summary};
    receipts.set(operationId, receipt);
    return receipt;
  },
});

const request = (action, fields, actor = owner) => review(new Request("https://local.invalid", {
  method: "POST", headers: {authorization: actor},
  body: JSON.stringify({organizationId: organization.id, action, ...fields}),
}));

assert.equal((await request("preview-confirmation", {documentId: documents[0].id, unit: "CASE"}, id(99))).status, 403);
assert.equal((await request("preview-recheck", {}, manager)).status, 403);
assert.equal((await request("preview-confirmation", {documentId: documents[0].id, unit: "CASE", organizationId: id(99)})).status, 403);
vocabulary = undefined;
assert.equal((await request("preview-confirmation", {documentId: documents[0].id, unit: "CASE"})).status, 409);
vocabulary = [];
assert.equal(writes, 0);

for (const document of documents) {
  const preview = await request("preview-confirmation", {documentId: document.id, unit: "CASE"});
  assert.equal(preview.rows?.length, 1, JSON.stringify(preview));
  assert.equal(preview.counts.ready, 0);
  assert.equal(writes, documents.indexOf(document), "Preview is read only");
  assert.equal((await request("confirm", {documentId: document.id, token: preview.token}, manager)).status, 403);
  assert.equal((await request("confirm", {documentId: document.id, token: preview.token+"!"})).status, 400);
  const applied = await request("confirm", {documentId: document.id, token: preview.token, actorId: id(99), unit: "LB"});
  assert.equal(applied.receipt?.confirmedBy, owner, JSON.stringify(applied));
  assert.equal(applied.counts.readyAfter, 0);
  assert.equal(listings[documents.indexOf(document)].selling_unit, "CS");
}
const subset = await request("preview-recheck", {listingIds:[listings[0].id]});
assert.equal(subset.rows?.length, 1, JSON.stringify(subset));
assert.equal(subset.rows[0].listingId, listings[0].id);
assert.equal(subset.counts.projectedReady, 1);
assert.equal(writes, 2);
const stale = await request("preview-recheck", {});
assert.equal(stale.rows?.length, 2, JSON.stringify(stale));
assert.equal(stale.counts.projectedReady, 2);
listings[0].row_revision++;
assert.equal((await request("apply-recheck", {token: stale.token})).status, 409);
assert.equal(writes, 2);
const preview = await request("preview-recheck", {});
assert.equal(preview.rows.length, 2);
const applied = await request("apply-recheck", {token: preview.token});
assert.equal(applied.counts?.readyAfter, 2, JSON.stringify(applied));
assert.equal(applied.counts.ready, 0);
assert.equal(applied.counts.totalAfter, 2);
assert.equal(writes, 3);
assert.deepEqual((await request("apply-recheck", {token: preview.token})).receipt, applied.receipt);
assert.equal(writes, 3);
assert.ok(listings.every(listing => !listing.import_row.reviewRequired && listing.price === 25 && listing.selling_unit === "CS"));
console.log("Price sheet review endpoint passed authorization, exact-preview binding, multi-document recheck, measured readiness and retry checks.");
