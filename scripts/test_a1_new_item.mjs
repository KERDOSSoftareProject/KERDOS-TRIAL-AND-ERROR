/**
 * scripts/test_a1_new_item.mjs
 *
 * Division I → Module A → Task 1 — Brand-new item automatic ingestion
 * Evidence category: local executed regression (in-memory backend)
 *
 * Verifies that processAttachmentInBackground automatically:
 *   1. Creates a new vendor_item when vendor_item_code is not yet known
 *   2. Saves pack, quoted price, and source file evidence
 *   3. Creates a catalog entry and mapping (Order Guide prerequisite)
 *   4. On replay (duplicate delivery), reuses the same import document;
 *      no second vendor_item, catalog_item, or mapping is created
 *
 * This test uses an in-memory stub backend — no network, no Supabase credentials.
 * The DB function (kerdos_apply_price_quote) is represented by a stub that returns
 * a fixed vendor_item_id, matching the contract the RPC enforces in production.
 *
 * Constraints preserved:
 *   · Code A1-NEW-20261027-001 is NOT pre-seeded — confirms brand-new-item path
 *   · No existing mappings — confirms catalogService creates one, not reuses one
 *   · Real parser (parseDocument / preparePriceImport) runs on the CSV text
 *   · Real importPriceRow logic runs; only the DB write calls are stubbed
 */

import assert from 'node:assert/strict';
import { orderGuideAssessment } from '../src/core/catalog-fields.js';
import { createRecords } from '../src/backend/records.js';
import { processAttachmentInBackground } from '../supabase/functions/process-attachment/background-import.mjs';

// ── Fixture ───────────────────────────────────────────────────────────────────

const NEW_CODE   = 'A1-NEW-20261027-001';
const NEW_DESC   = 'Chicken Breast Boneless Skinless';
const NEW_PACK   = '4/10 LB';
const NEW_UNIT   = 'CASE';
const NEW_PRICE  = 80.00;

// Exercise the same Price Unit/Price header pair fixed in PR #10.
const CSV_TEXT = [
  'Code,Description,Pack,Price Unit,Price',
  `${NEW_CODE},${NEW_DESC},${NEW_PACK},${NEW_UNIT},${NEW_PRICE}`,
].join('\n');

const ORG    = '00000000-0000-0000-0000-000000000001';
const VENDOR = '00000000-0000-0000-0000-000000000002';
const ATT    = '00000000-0000-0000-0000-000000000009';

// Fixed IDs produced by stubs (simulating what the DB would return)
const CREATED_VENDOR_ITEM_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const CREATED_DOC_ID         = 'bbbbbbbb-0000-0000-0000-000000000001';
const CREATED_CATALOG_ID     = 'cccccccc-0000-0000-0000-000000000001';
const CREATED_CATEGORY_ID    = 'eeeeeeee-0000-0000-0000-000000000001';
const CREATED_MAPPING_ID     = 'dddddddd-0000-0000-0000-000000000001';

const FINGERPRINT = `test-storage/new-item:${new TextEncoder().encode(CSV_TEXT).length}`;   // storage_path:file_size_bytes

let passed = 0;
async function check(name, fn) { await fn(); passed++; console.log('PASS ' + name); }

// ── Shared call log ───────────────────────────────────────────────────────────

function makeState() {
  const calls = {
    applyQuote: [],
    createMapping: [],
    createCatalog: [],
    setStatus: [],
    insertImportDoc: [],
    updateImportDoc: [],
  };
  // In-memory tables
  const importDocs  = {};   // id → row
  const mappings    = {};   // vendor_item_id → row
  const vendorItems = [];
  const catalogItems = [];
  const categories = [];

  // createRecords execute function — handles each operation
  function execute(spec) {
    const { table, action, filters, value, cardinality } = spec;

    const eqFilter = (rows, filters) =>
      filters.reduce((acc, f) =>
        f.operator === 'eq' ? acc.filter(r => String(r[f.column]) === String(f.value)) : acc, rows);

    // ── vendor_items ─────────────────────────────────────────────────────────
    if (table === 'vendor_items') {
      // Initial load — empty (no pre-seeded items for NEW_CODE)
      if (action === 'select') return Promise.resolve({ data: eqFilter(vendorItems, filters), error: null });
      // update (import_row staging when needsBasis && ex — should NOT be called
      // for a brand-new item because ex is null)
      if (action === 'update') return Promise.reject(new Error(
        'vendor_items UPDATE called for new item — should not happen (needsBasis && ex path)'));
    }

    // ── catalog_items ─────────────────────────────────────────────────────────
    if (table === 'catalog_items') {
      if (action === 'select') return Promise.resolve({ data: eqFilter(catalogItems, filters), error: null });
      // INSERT (matchOrCreate creates a new catalog_item)
      if (action === 'insert') {
        const row = { ...(Array.isArray(value) ? value[0] : value), id: CREATED_CATALOG_ID };
        catalogItems.push(row);
        calls.createCatalog.push(row);
        return Promise.resolve({ data: cardinality === 'single' ? row : [row], error: null });
      }
    }

    // ── catalog_categories ────────────────────────────────────────────────────
    if (table === 'catalog_categories') {
      if (action === 'select') return Promise.resolve({ data: eqFilter(categories, filters), error: null });
      if (action === 'insert') {
        const insertVal = Array.isArray(value) ? value[0] : value;
        const row = {
          ...insertVal,
          id: CREATED_CATEGORY_ID,
          range_start: 10000,
          range_end:   19999,
        };
        categories.push(row);
        return Promise.resolve({ data: cardinality === 'single' ? row : [row], error: null });
      }
    }

    // ── item_mappings ─────────────────────────────────────────────────────────
    if (table === 'item_mappings') {
      if (action === 'select') {
        // Check by vendor_item_id for the final "mapping exists" guard
        const all = Object.values(mappings);
        const rows = eqFilter(all, filters);
        if (cardinality === 'maybeSingle') return Promise.resolve({ data: rows[0] ?? null, error: null });
        return Promise.resolve({ data: rows, error: null });
      }
      if (action === 'insert') {
        const row = { ...(Array.isArray(value) ? value[0] : value), id: CREATED_MAPPING_ID };
        mappings[row.vendor_item_id] = row;
        calls.createMapping.push(row);
        return Promise.resolve({ data: cardinality === 'single' ? row : [row], error: null });
      }
    }

    // ── invoices (invoice sources for basis inference) ────────────────────────
    if (table === 'invoices') {
      if (action === 'select') return Promise.resolve({ data: [], error: null });
    }

    // ── price_history (import resume sources) ─────────────────────────────────
    if (table === 'price_history') {
      if (action === 'select') return Promise.resolve({ data: [], error: null });
    }

    // ── import_documents ──────────────────────────────────────────────────────
    if (table === 'import_documents') {
      if (action === 'select') {
        // findPriceDocument — look up by fingerprint filter
        const fpFilter = filters.find(f => f.column === 'fingerprint');
        if (fpFilter && importDocs[fpFilter.value]) {
          const doc = importDocs[fpFilter.value];
          const row = { id: doc.id, status: doc.status, completed_keys: doc.completed_keys };
          return Promise.resolve({ data: row, error: null });
        }
        return Promise.resolve({ data: null, error: null });
      }
      if (action === 'insert') {
        const row = Array.isArray(value) ? value[0] : value;
        const id = row.id ?? CREATED_DOC_ID;
        const doc = { ...row, id };
        importDocs[row.fingerprint ?? id] = doc;
        calls.insertImportDoc.push(doc);
        return Promise.resolve({ data: cardinality === 'single' ? { id } : [{ id }], error: null });
      }
      if (action === 'update') {
        // finalizeDocument / recordProgress — update status/completed_keys
        const idFilter = filters.find(f => f.column === 'id');
        if (idFilter) {
          for (const doc of Object.values(importDocs)) {
            if (doc.id === idFilter.value) { Object.assign(doc, value); }
          }
        }
        calls.updateImportDoc.push({ filters, value });
        return Promise.resolve({ data: [], error: null });
      }
    }

    return Promise.resolve({ data: null, error: null });
  }

  const records = createRecords(execute);

  const backend = {
    attachments: {
      download: async () => new TextEncoder().encode(CSV_TEXT),
      setStatus: async (attachmentId, status, reason, importDocId) => {
        calls.setStatus.push({ attachmentId, status, reason, importDocId });
      },
    },
    pricing: {
      applyQuote: async (params) => {
        calls.applyQuote.push({ ...params });
        vendorItems.push({id:CREATED_VENDOR_ITEM_ID,organization_id:params.organizationId,vendor_id:params.vendorId,
          vendor_item_code:params.vendorItemCode,description:params.description,pack_size:params.packSize,
          selling_unit:params.sellingUnit,price:params.price,price_basis:params.priceBasis,
          price_source:'price_list',last_updated:params.effectiveDate,import_row:params.importRow,
          field_resolutions:params.fieldResolutions,price_unavailable:params.priceUnavailable});
        return CREATED_VENDOR_ITEM_ID;
      },
    },
    records,
  };

  return { backend, calls, importDocs, mappings, vendorItems, catalogItems, categories };
}

// ── Test fixture: confirm code not pre-seeded ─────────────────────────────────

// ── First run: brand-new item automatic creation ──────────────────────────────

const attachment = {
  id:               ATT,
  filename:         'A1_New_Item_Test.csv',
  content_type:     'text/csv',
  storage_path:     'test-storage/new-item',
  file_size_bytes:  new TextEncoder().encode(CSV_TEXT).length,
};

const state = makeState();
const {backend:backend1,calls:calls1}=state;
assert.equal(state.vendorItems.length,0);
assert.equal(state.catalogItems.length,0);
assert.equal(Object.keys(state.mappings).length,0);

let result1;
await check('processAttachmentInBackground returns auto_imported for new item', async () => {
  result1 = await processAttachmentInBackground(
    backend1,
    attachment,
    { organizationId: ORG, vendorId: VENDOR, documentType: 'pricelist' }
  );
  assert.equal(result1.outcome, 'auto_imported',
    `Expected auto_imported, got ${result1.outcome}: ${result1.reason ?? ''}`);
});

await check('applyQuote called exactly once with vendorItemId=null (new item creation)', () => {
  assert.equal(calls1.applyQuote.length, 1, 'Expected exactly one applyQuote call');
  const q = calls1.applyQuote[0];
  assert.equal(q.vendorItemId, null,
    `Expected vendorItemId=null (new item), got ${q.vendorItemId}`);
});

await check('applyQuote received correct vendor item code and description', () => {
  const q = calls1.applyQuote[0];
  assert.equal(q.vendorItemCode, NEW_CODE,   `Code mismatch: ${q.vendorItemCode}`);
  assert.equal(q.description,    NEW_DESC,   `Description mismatch: ${q.description}`);
  assert.equal(q.organizationId, ORG);
  assert.equal(q.vendorId,       VENDOR);
});

await check('applyQuote retained pack, quoted price, and source file evidence', () => {
  const q = calls1.applyQuote[0];
  assert.equal(q.packSize, NEW_PACK,
    `Pack mismatch: expected "${NEW_PACK}", got "${q.packSize}"`);
  assert.equal(Number(q.price), NEW_PRICE,
    `Price mismatch: expected ${NEW_PRICE}, got ${q.price}`);
  assert.equal(q.priceBasis, 'case',
    `priceBasis: expected "case" (resolved from CASE selling unit), got "${q.priceBasis}"`);
  assert.equal(q.sourceFilePath,attachment.storage_path);
  assert.equal(q.sourceDocumentId,CREATED_DOC_ID);
  assert.equal(q.importRow.sourceDocumentId,CREATED_DOC_ID);
  assert.equal(q.importRow.row.code,NEW_CODE);
  assert.match(q.importRow.row.sourceLine,/Chicken Breast Boneless Skinless/);
  console.log(`  · packSize:      ${q.packSize}`);
  console.log(`  · price:         ${q.price}`);
  console.log(`  · priceBasis:    ${q.priceBasis}`);
  console.log(`  · sourceDocumentId: ${q.sourceDocumentId}`);
});

await check('catalog entry and mapping created and linked', () => {
  assert.equal(calls1.createMapping.length, 1, 'Expected exactly one createMapping call');
  const m = calls1.createMapping[0];
  assert.equal(m.vendor_item_id, CREATED_VENDOR_ITEM_ID,
    `Mapping vendor_item_id mismatch: ${m.vendor_item_id}`);
  assert.equal(calls1.createCatalog.length,1);
  assert.equal(m.catalog_item_id,CREATED_CATALOG_ID);
  console.log(`  · mapping links vendor_item ${m.vendor_item_id}`);
  console.log(`            → catalog_item  ${m.catalog_item_id}`);
  console.log(`  · match_method:  ${m.match_method}`);
  console.log(`  · confidence:    ${m.confidence_score}`);
});

await check('import document created and finalized as complete', () => {
  assert.equal(calls1.insertImportDoc.length, 1, 'Expected one import_documents INSERT');
  const doc = calls1.insertImportDoc[0];
  assert.equal(doc.document_kind, 'pricelist');
  assert.equal(doc.fingerprint, FINGERPRINT);
  assert.equal(doc.organization_id, ORG);
  assert.equal(doc.vendor_id, VENDOR);
  // file_name comes from attachment.filename passed to processAttachmentInBackground
  assert.equal(doc.file_name, attachment.filename);
  assert.equal(doc.file_path, attachment.storage_path);
  // finalizeDocument sets status=complete
  const finalUpdate = calls1.updateImportDoc.find(u => u.value?.status === 'complete');
  assert.ok(finalUpdate, 'finalizeDocument must have been called with status=complete');
  console.log(`  · import document fingerprint: ${doc.fingerprint}`);
  console.log(`  · finalized status: complete`);
});

await check('attachment status set to auto_imported with import document id', () => {
  const st = calls1.setStatus.find(s => s.status === 'auto_imported');
  assert.ok(st, 'Expected setStatus call with auto_imported');
  assert.equal(st.importDocId,CREATED_DOC_ID);
  console.log(`  · attachment ${st.attachmentId} → ${st.status}`);
  console.log(`  · importDocId: ${st.importDocId ?? '(linked via finalizeDocument)'}`);
});

// ── Order Guide readiness ─────────────────────────────────────────────────────

await check('new item stays stored but Uncategorized prevents Order Guide eligibility',()=>{
  const item=state.catalogItems[0],vendorItem=state.vendorItems[0],mapping=calls1.createMapping[0];
  const category=state.categories.find(c=>c.id===item.category_id);
  const assessment=orderGuideAssessment({item,vendorItem,mapping,vendor:{id:VENDOR,name:'Test Vendor'},
    category,categories:state.categories,peers:[]});
  assert.equal(category.is_holding_pen,true);
  assert.equal(assessment.ready,false);
  assert.deepEqual(assessment.blockers,['category']);
  assert.equal(assessment.evidence.unitCost.value,2);
});

// ── Replay (duplicate delivery) ───────────────────────────────────────────────
// Replay the same backend state produced by the first run; no fabricated document.
// Expected: setStatus=auto_imported immediately, zero new applyQuote/createMapping calls.

await check('duplicate delivery reuses existing import document (no second applyQuote or mapping)', async () => {
  const backend2=backend1;
  const before={quotes:calls1.applyQuote.length,mappings:calls1.createMapping.length,
    catalogs:calls1.createCatalog.length,documents:calls1.insertImportDoc.length};
  const ATT2 = '00000000-0000-0000-0000-000000000099';  // second delivery, new attachment id
  const result2 = await processAttachmentInBackground(
    backend2,
    { ...attachment, id: ATT2 },
    { organizationId: ORG, vendorId: VENDOR, documentType: 'pricelist' }
  );

  assert.equal(result2.outcome, 'auto_imported',
    `Replay outcome: expected auto_imported, got ${result2.outcome}`);
  assert.equal(calls1.applyQuote.length, before.quotes,
    `Replay must not call applyQuote again (got ${calls1.applyQuote.length} calls)`);
  assert.equal(calls1.createMapping.length, before.mappings,
    `Replay must not create a new mapping (got ${calls1.createMapping.length} calls)`);
  assert.equal(calls1.insertImportDoc.length, before.documents,
    `Replay must not create a new import document (got ${calls1.insertImportDoc.length} inserts)`);
  assert.equal(calls1.createCatalog.length,before.catalogs);
  const replaySt = calls1.setStatus.find(s => s.attachmentId === ATT2 && s.status === 'auto_imported');
  assert.ok(replaySt, 'Replay must still mark attachment as auto_imported');
  assert.equal(replaySt.importDocId,CREATED_DOC_ID);
  console.log('  · Duplicate delivery: outcome = auto_imported');
  console.log('  · applyQuote calls: 0 ✓');
  console.log('  · createMapping calls: 0 ✓');
  console.log('  · import_documents inserts: 0 ✓');
});

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed}/${passed} brand-new-item checks passed (local executed regression evidence).`);
console.log(`
Evidence recorded — Division I → Module A → Task 1 (new-item path):
  ✓ Code A1-NEW-20261027-001 not pre-seeded; ex=null confirmed
  ✓ processAttachmentInBackground → outcome: auto_imported
  ✓ applyQuote(vendorItemId=null) → new vendor_item creation path exercised
  ✓ Pack "4/10 LB", price 80.00, priceBasis case, source file evidence retained
  ✓ Catalog entry and mapping retained; Uncategorized is the sole Order Guide blocker
  ✓ Import document created and finalized as complete
  ✓ Duplicate delivery replay: no second applyQuote, mapping, or import document

Separate evidence still required:
  · Real-email delivery (Postmark inbound → webhook → Edge Function → database)
`);
