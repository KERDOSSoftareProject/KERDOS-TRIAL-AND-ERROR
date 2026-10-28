/**
 * scripts/test_a1_partial_row_hold.mjs
 *
 * Division I → Module A → Task 1 — Partial-row-hold behaviour
 * Evidence category: local executed regression (in-memory backend)
 *
 * Verifies the "process every row, hold only the uncertain ones" contract:
 *   1. uncertain-first   — row 0 needsBasis; rows 1–2 auto-import; doc partial
 *   2. uncertain-middle  — row 1 needsBasis; rows 0,2 auto-import; doc partial
 *   3. all-uncertain     — all rows needsBasis; zero auto-imports; doc partial
 *   4. retry/resume      — pre-seed completed_keys with row:0 + held:row:1;
 *                          both are skipped on re-run; row 2 (new) processes;
 *                          doc stays partial (held:row:1 still outstanding)
 *
 * Design constraints tested:
 *   · One unclear item does not block valid items from importing automatically
 *   · Unresolved rows remain identifiable (held:row:N keys in completed_keys)
 *   · Completion status is honest (partial, not complete, while held rows exist)
 *   · Retry cannot duplicate rows already saved (row:N skipped) or re-hold
 *     rows already held (held:row:N skipped on automatic re-run)
 *
 * How uncertain rows are triggered (no CSV/parser patching needed):
 *   Pre-seed the uncertain row's vendor item in the DB so ex≠null.
 *   CSV column "Price Unit" is EMPTY for that row's code.
 *   preparePriceImport sets requiresReview=true (no sellingUnit resolution).
 *   import-price-row.js line 72: needsBasis && ex → vendor_items UPDATE only;
 *   applyQuote is NOT called.  importPriceRow returns {needsBasis:true}.
 *   background-import.mjs: result.needsBasis → heldKeys.push("held:row:N").
 *
 * How certain rows are triggered:
 *   NOT pre-seeded in vendor_items (ex=null); Price Unit="CASE" in CSV.
 *   preparePriceImport resolves sellingUnit; requiresReview=false; needsBasis=false.
 *   importPriceRow calls applyQuote → new vendor item created → auto-import.
 *
 * Implementation under test:
 *   supabase/functions/process-attachment/background-import.mjs (Steps 6 + 7)
 *   Branch: codex/a1-partial-row-hold
 */

import assert from 'node:assert/strict';
import { createRecords } from '../src/backend/records.js';
import { processAttachmentInBackground } from '../supabase/functions/process-attachment/background-import.mjs';

// ── Constants ─────────────────────────────────────────────────────────────────

const ORG    = '00000000-0000-0000-0000-000000000001';
const VENDOR = '00000000-0000-0000-0000-000000000002';
const ATT    = '00000000-1111-0000-0000-000000000009';
const DOC_ID = 'bbbbbbbb-1111-0000-0000-000000000001';

// Three item codes used across all tests.
// Real alphanumeric codes with food descriptions so parseDocument's heuristic
// recognises these rows as price data (non-food descriptions like "PHT-A Product"
// score too low and cause parseDocument to return 0 rows → early exit).
const CODES = ['A1-HOLD-001', 'A1-HOLD-002', 'A1-HOLD-003'];
const DESCS = [
  'Chicken Breast Boneless Skinless',
  'Beef Tenderloin Choice Cut',
  'Turkey Breast Smoked Deli Style',
];

// Pre-built existing vendor-item rows for "uncertain" rows.
// price_basis=null, selling_unit=null → resolveQuoteBasis returns null on line 12 of
// quote-basis.js (!prior.price_basis → return null). With no prior basis and no
// Price Unit column in the CSV, requiresReview=true → needsBasis=true → held.
const EXISTING_ITEMS = CODES.map((code, i) => ({
  id:               `vi-${i + 1}-${code}`,
  organization_id:  ORG,
  vendor_id:        VENDOR,
  vendor_item_code: code,
  description:      DESCS[i],
  pack_size:        `${i + 1}/10 LB`,
  selling_unit:     null,    // ← no confirmed basis; forces resolveQuoteBasis → null
  price:            null,
  price_basis:      null,    // ← key: quote-basis.js line 12: !prior.price_basis → return null
}));

// Pre-built existing item-mappings for each uncertain row's vendor item.
// When priorMapping is found, importPriceRow skips catalog creation entirely.
const EXISTING_MAPPINGS = EXISTING_ITEMS.map((item, i) => ({
  id:             `map-${i + 1}-${item.vendor_item_code}`,
  organization_id: ORG,
  vendor_item_id: item.id,
  catalog_item_id: `cat-${i + 1}`,
  confidence_score: 80,
  match_method:   'rule_based',
}));

// ── CSV builder ───────────────────────────────────────────────────────────────
//
// uncertainIndexes: which rows (0-based) should have empty Price Unit.
//   These rows are pre-seeded as existing vendor items → needsBasis=true → held.
// certainIndexes: which rows should have "CASE" Price Unit.
//   These rows are NOT pre-seeded → new item → applyQuote → auto-import.

function buildCsv(rowDefs) {
  // rowDefs: [{code, priceUnit}]
  // Use DESCS for descriptions — parseDocument requires food-like text to score the
  // document as a price sheet; generic names like "A1-HOLD-001 Product" score too low
  // and cause 0 rows to be returned (triggering the early "No price rows found" exit).
  return [
    'Code,Description,Pack,Price Unit,Price',
    ...rowDefs.map((r, i) => {
      const desc = DESCS[CODES.indexOf(r.code)] ?? r.code;
      return `${r.code},${desc},${i + 1}/10 LB,${r.priceUnit},${(i + 1) * 10}`;
    }),
  ].join('\n');
}

// ── Backend factory ───────────────────────────────────────────────────────────
//
// uncertainIndexes: row indexes whose vendor items are pre-seeded (held path).
// preSeededKeys:    completed_keys for the pre-existing import document
//                   (used for the retry/resume test).

function makeBackend({ uncertainIndexes = [], preSeededKeys = [], csv } = {}) {
  const calls = {
    applyQuote:      [],
    setStatus:       [],
    insertImportDoc: [],
    updateImportDoc: [],
    vendorItemUpdate: [],
  };

  // ── In-memory tables ────────────────────────────────────────────────────────

  // Pre-seed vendor items for uncertain rows only.
  const vendorItems  = uncertainIndexes.map(i => ({ ...EXISTING_ITEMS[i] }));

  // Pre-seed item_mappings for uncertain rows so importPriceRow finds
  // priorMapping and skips catalog creation for them.
  const mappingsArr  = uncertainIndexes.map(i => ({ ...EXISTING_MAPPINGS[i] }));

  const catalogItems = [];
  const categories   = [];
  const importDocs   = {};

  let catalogCounter = 0;
  let mappingCounter = 0;
  let vendorCounter  = 0;

  const fingerprint = `test-storage/partial:${new TextEncoder().encode(csv).length}`;

  // Pre-prime the import document when testing retry/resume.
  if (preSeededKeys.length > 0) {
    importDocs[fingerprint] = {
      id:             DOC_ID,
      fingerprint,
      status:         'partial',
      completed_keys: preSeededKeys,
    };
  }

  // ── createRecords execute stub ──────────────────────────────────────────────

  function eqFilter(rows, filters) {
    return filters.reduce((acc, f) =>
      f.operator === 'eq'
        ? acc.filter(r => String(r[f.column]) === String(f.value))
        : acc,
      rows);
  }

  function execute(spec) {
    const { table, action, filters, value, cardinality } = spec;

    // ── vendor_items ──────────────────────────────────────────────────────────
    if (table === 'vendor_items') {
      if (action === 'select') {
        // background-import loads ALL vendor items for org+vendor in one shot.
        return Promise.resolve({ data: eqFilter(vendorItems, filters), error: null });
      }
      if (action === 'update') {
        // needsBasis && ex path: background saves incoming quote for review
        // without calling applyQuote.
        const idFilter = filters.find(f => f.column === 'id');
        if (idFilter) {
          const item = vendorItems.find(v => v.id === idFilter.value);
          if (item) Object.assign(item, value);
        }
        calls.vendorItemUpdate.push({ filters, value });
        return Promise.resolve({ data: [], error: null });
      }
    }

    // ── catalog_items ─────────────────────────────────────────────────────────
    if (table === 'catalog_items') {
      if (action === 'select') return Promise.resolve({ data: eqFilter(catalogItems, filters), error: null });
      if (action === 'insert') {
        catalogCounter++;
        const row = { ...(Array.isArray(value) ? value[0] : value), id: `cat-new-${catalogCounter}` };
        catalogItems.push(row);
        return Promise.resolve({ data: cardinality === 'single' ? row : [row], error: null });
      }
    }

    // ── catalog_categories ────────────────────────────────────────────────────
    if (table === 'catalog_categories') {
      if (action === 'select') return Promise.resolve({ data: eqFilter(categories, filters), error: null });
      if (action === 'insert') {
        const insertVal = Array.isArray(value) ? value[0] : value;
        const row = { ...insertVal, id: `cat-${++catalogCounter}`, range_start: 10000, range_end: 19999 };
        categories.push(row);
        return Promise.resolve({ data: cardinality === 'single' ? row : [row], error: null });
      }
    }

    // ── item_mappings ─────────────────────────────────────────────────────────
    if (table === 'item_mappings') {
      if (action === 'select') {
        const rows = eqFilter(mappingsArr, filters);
        if (cardinality === 'maybeSingle') return Promise.resolve({ data: rows[0] ?? null, error: null });
        return Promise.resolve({ data: rows, error: null });
      }
      if (action === 'insert') {
        mappingCounter++;
        const row = { ...(Array.isArray(value) ? value[0] : value), id: `map-new-${mappingCounter}` };
        mappingsArr.push(row);
        return Promise.resolve({ data: cardinality === 'single' ? row : [row], error: null });
      }
    }

    // ── invoices / price_history (invoice sources / basis inference) ──────────
    if (table === 'invoices' || table === 'price_history') {
      return Promise.resolve({ data: [], error: null });
    }

    // ── import_documents ──────────────────────────────────────────────────────
    if (table === 'import_documents') {
      if (action === 'select') {
        const fpFilter = filters.find(f => f.column === 'fingerprint');
        if (fpFilter && importDocs[fpFilter.value]) {
          const doc = importDocs[fpFilter.value];
          return Promise.resolve({
            data: { id: doc.id, status: doc.status, completed_keys: doc.completed_keys },
            error: null,
          });
        }
        return Promise.resolve({ data: null, error: null });
      }
      if (action === 'insert') {
        const row = Array.isArray(value) ? value[0] : value;
        const id  = row.id ?? DOC_ID;
        const doc = { ...row, id };
        importDocs[row.fingerprint ?? id] = doc;
        calls.insertImportDoc.push(doc);
        return Promise.resolve({ data: cardinality === 'single' ? { id } : [{ id }], error: null });
      }
      if (action === 'update') {
        const idFilter = filters.find(f => f.column === 'id');
        if (idFilter) {
          for (const doc of Object.values(importDocs)) {
            if (doc.id === idFilter.value) Object.assign(doc, value);
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
      download: async () => new TextEncoder().encode(csv),
      setStatus: async (id, status, reason, importDocId) => {
        calls.setStatus.push({ id, status, reason, importDocId });
      },
    },
    pricing: {
      applyQuote: async (params) => {
        calls.applyQuote.push({ ...params });
        vendorCounter++;
        const newId = `vi-new-${vendorCounter}`;
        vendorItems.push({
          id:               newId,
          organization_id:  params.organizationId,
          vendor_id:        params.vendorId,
          vendor_item_code: params.vendorItemCode,
          description:      params.description,
          pack_size:        params.packSize,
          selling_unit:     params.sellingUnit,
          price:            params.price,
          price_basis:      params.priceBasis,
        });
        return newId;
      },
    },
    records,
  };

  const attachment = {
    id:              ATT,
    filename:        'A1_Partial_Hold_Test.csv',
    content_type:    'text/csv',
    storage_path:    'test-storage/partial',
    file_size_bytes: new TextEncoder().encode(csv).length,
  };

  const options = { organizationId: ORG, vendorId: VENDOR, documentType: 'pricelist' };

  return { backend, calls, importDocs, attachment, options, fingerprint };
}

// ── Test runner ───────────────────────────────────────────────────────────────

let passed = 0;
async function check(name, fn) {
  try {
    await fn();
    passed++;
    console.log('PASS ' + name);
  } catch (err) {
    console.error('FAIL ' + name + '\n  ' + err.message);
    throw err;
  }
}

// Helper: get the document from importDocs
function getDoc(importDocs) {
  return Object.values(importDocs).find(d => d.id === DOC_ID);
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 1 — uncertain-first
//
// Row 0 (A1-HOLD-001): empty Price Unit + pre-seeded as existing → needsBasis=true → held
// Row 1 (A1-HOLD-002): "CASE" Price Unit + new (ex=null) → applyQuote → auto-import
// Row 2 (A1-HOLD-003): "CASE" Price Unit + new (ex=null) → applyQuote → auto-import
//
// Expected: outcome=needs_review, heldKeys=['held:row:0'], savedCount=2
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Test 1: uncertain-first ──────────────────────────────────────────────────\n');

{
  const csv = buildCsv([
    { code: CODES[0], priceUnit: '' },      // row 0: uncertain (pre-seeded)
    { code: CODES[1], priceUnit: 'CASE' },  // row 1: certain (new)
    { code: CODES[2], priceUnit: 'CASE' },  // row 2: certain (new)
  ]);

  const { backend, calls, importDocs, attachment, options } = makeBackend({
    uncertainIndexes: [0],   // pre-seed A1-HOLD-001 as existing vendor item + mapping
    csv,
  });

  let result;

  await check('uncertain-first → outcome is needs_review', async () => {
    result = await processAttachmentInBackground(backend, attachment, options);
    assert.equal(result.outcome, 'needs_review',
      `Expected needs_review, got ${result.outcome}: ${result.reason ?? ''}`);
  });

  await check('uncertain-first → heldKeys = ["held:row:0"]', () => {
    assert.deepEqual(result.heldKeys, ['held:row:0'],
      `heldKeys: ${JSON.stringify(result.heldKeys)}`);
  });

  await check('uncertain-first → savedCount = 2 (rows 1 and 2)', () => {
    assert.equal(result.savedCount, 2,
      `savedCount: expected 2, got ${result.savedCount}`);
  });

  await check('uncertain-first → applyQuote called for rows 1 and 2 only (not row 0)', () => {
    // Uncertain row (row 0) uses vendor_items UPDATE path — no applyQuote.
    assert.equal(calls.applyQuote.length, 2,
      `applyQuote count: expected 2, got ${calls.applyQuote.length}`);
    const codes = calls.applyQuote.map(q => q.vendorItemCode);
    assert.ok(codes.includes(CODES[1]), `${CODES[1]} (row 1) must be auto-imported`);
    assert.ok(codes.includes(CODES[2]), `${CODES[2]} (row 2) must be auto-imported`);
    assert.ok(!codes.includes(CODES[0]), `${CODES[0]} (row 0) must NOT be auto-imported (held)`);
  });

  await check('uncertain-first → vendor_items UPDATE called for held row', () => {
    // The needsBasis && ex path writes the incoming quote to vendor_items.import_row
    // for reviewer visibility; applyQuote is not called.
    assert.equal(calls.vendorItemUpdate.length, 1,
      `vendor_items UPDATE count: expected 1, got ${calls.vendorItemUpdate.length}`);
  });

  await check('uncertain-first → import document finalized as partial', () => {
    const doc = getDoc(importDocs);
    assert.ok(doc, 'import document must exist');
    assert.equal(doc.status, 'partial', `status: expected partial, got ${doc.status}`);
  });

  await check('uncertain-first → completed_keys contains held:row:0, row:1, row:2 (no raw row:0)', () => {
    const doc = getDoc(importDocs);
    const keys = doc.completed_keys ?? [];
    assert.ok(keys.includes('held:row:0'), `held:row:0 missing from ${JSON.stringify(keys)}`);
    assert.ok(keys.includes('row:1'),      `row:1 missing from ${JSON.stringify(keys)}`);
    assert.ok(keys.includes('row:2'),      `row:2 missing from ${JSON.stringify(keys)}`);
    assert.ok(!keys.includes('row:0'),     `raw row:0 must NOT appear: ${JSON.stringify(keys)}`);
    console.log(`  · completed_keys: ${JSON.stringify(keys)}`);
  });

  await check('uncertain-first → attachment status set to needs_review with document id', () => {
    const st = calls.setStatus.find(s => s.status === 'needs_review');
    assert.ok(st, 'Expected needs_review setStatus call');
    assert.equal(st.importDocId, DOC_ID,
      `importDocId: expected ${DOC_ID}, got ${st.importDocId}`);
    console.log(`  · reason: ${st.reason}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 2 — uncertain-middle
//
// Row 0 (A1-HOLD-001): "CASE" Price Unit + new → auto-import
// Row 1 (A1-HOLD-002): empty Price Unit + pre-seeded as existing → held
// Row 2 (A1-HOLD-003): "CASE" Price Unit + new → auto-import
//
// Expected: outcome=needs_review, heldKeys=['held:row:1'], savedCount=2
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Test 2: uncertain-middle ─────────────────────────────────────────────────\n');

{
  const csv = buildCsv([
    { code: CODES[0], priceUnit: 'CASE' },  // row 0: certain (new)
    { code: CODES[1], priceUnit: '' },      // row 1: uncertain (pre-seeded)
    { code: CODES[2], priceUnit: 'CASE' },  // row 2: certain (new)
  ]);

  const { backend, calls, importDocs, attachment, options } = makeBackend({
    uncertainIndexes: [1],   // pre-seed A1-HOLD-002 as existing
    csv,
  });

  let result;

  await check('uncertain-middle → outcome is needs_review', async () => {
    result = await processAttachmentInBackground(backend, attachment, options);
    assert.equal(result.outcome, 'needs_review',
      `Expected needs_review, got ${result.outcome}`);
  });

  await check('uncertain-middle → heldKeys = ["held:row:1"]', () => {
    assert.deepEqual(result.heldKeys, ['held:row:1'],
      `heldKeys: ${JSON.stringify(result.heldKeys)}`);
  });

  await check('uncertain-middle → savedCount = 2 (rows 0 and 2)', () => {
    assert.equal(result.savedCount, 2);
  });

  await check('uncertain-middle → rows 0 and 2 auto-imported; row 1 held', () => {
    const codes = calls.applyQuote.map(q => q.vendorItemCode);
    assert.ok(codes.includes(CODES[0]), `${CODES[0]} (row 0) must be auto-imported`);
    assert.ok(codes.includes(CODES[2]), `${CODES[2]} (row 2) must be auto-imported`);
    assert.ok(!codes.includes(CODES[1]), `${CODES[1]} (row 1) must be held, not auto-imported`);
  });

  await check('uncertain-middle → completed_keys: row:0, held:row:1, row:2', () => {
    const doc = getDoc(importDocs);
    const keys = doc.completed_keys ?? [];
    assert.ok(keys.includes('row:0'),      `row:0 missing: ${JSON.stringify(keys)}`);
    assert.ok(keys.includes('held:row:1'), `held:row:1 missing: ${JSON.stringify(keys)}`);
    assert.ok(keys.includes('row:2'),      `row:2 missing: ${JSON.stringify(keys)}`);
    assert.ok(!keys.includes('row:1'),     `raw row:1 must not appear: ${JSON.stringify(keys)}`);
    console.log(`  · completed_keys: ${JSON.stringify(keys)}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 3 — all-uncertain
//
// All three rows: empty Price Unit + pre-seeded as existing → all held
//
// Expected: outcome=needs_review, heldKeys=['held:row:0','held:row:1','held:row:2'],
//           savedCount=0, applyQuote never called, doc=partial
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Test 3: all-uncertain ────────────────────────────────────────────────────\n');

{
  const csv = buildCsv([
    { code: CODES[0], priceUnit: '' },   // row 0: uncertain
    { code: CODES[1], priceUnit: '' },   // row 1: uncertain
    { code: CODES[2], priceUnit: '' },   // row 2: uncertain
  ]);

  const { backend, calls, importDocs, attachment, options } = makeBackend({
    uncertainIndexes: [0, 1, 2],   // all three pre-seeded
    csv,
  });

  let result;

  await check('all-uncertain → outcome is needs_review', async () => {
    result = await processAttachmentInBackground(backend, attachment, options);
    assert.equal(result.outcome, 'needs_review',
      `Expected needs_review, got ${result.outcome}`);
  });

  await check('all-uncertain → heldKeys has all three rows in order', () => {
    assert.deepEqual(result.heldKeys, ['held:row:0', 'held:row:1', 'held:row:2'],
      `heldKeys: ${JSON.stringify(result.heldKeys)}`);
  });

  await check('all-uncertain → savedCount = 0', () => {
    assert.equal(result.savedCount, 0,
      `savedCount: expected 0, got ${result.savedCount}`);
  });

  await check('all-uncertain → applyQuote never called', () => {
    // needsBasis && ex path: all rows take vendor_items UPDATE, not applyQuote.
    assert.equal(calls.applyQuote.length, 0,
      `applyQuote must not be called; got ${calls.applyQuote.length} call(s)`);
  });

  await check('all-uncertain → import document finalized as partial', () => {
    const doc = getDoc(importDocs);
    assert.ok(doc, 'import document must exist');
    assert.equal(doc.status, 'partial');
  });

  await check('all-uncertain → completed_keys has all three held keys and no saved keys', () => {
    const doc = getDoc(importDocs);
    const keys = doc.completed_keys ?? [];
    assert.ok(keys.includes('held:row:0'), `held:row:0 missing`);
    assert.ok(keys.includes('held:row:1'), `held:row:1 missing`);
    assert.ok(keys.includes('held:row:2'), `held:row:2 missing`);
    assert.ok(!keys.includes('row:0'), `raw row:0 must not appear`);
    assert.ok(!keys.includes('row:1'), `raw row:1 must not appear`);
    assert.ok(!keys.includes('row:2'), `raw row:2 must not appear`);
    console.log(`  · completed_keys: ${JSON.stringify(keys)}`);
  });
}

// ─────────────────────────────────────────────────────────────────────────────
// Test 4 — retry/resume
//
// Simulates an automatic re-run where the document already has:
//   completed_keys: ['row:0', 'held:row:1']
//   status: 'partial'
//
// Expectations:
//   · Row 0 (PHT-A): skipped — row:0 is in completedRows (already saved)
//   · Row 1 (PHT-B): skipped — held:row:1 is in completedRows (reviewer's action needed)
//   · Row 2 (PHT-C): new → auto-import
//
//   · applyQuote called exactly once (PHT-C only)
//   · No duplicate row:0 in completed_keys
//   · held:row:1 appears exactly once (pre-existing, not duplicated)
//   · Document stays partial (held:row:1 still outstanding)
//   · outcome = needs_review (completion status is honest)
// ─────────────────────────────────────────────────────────────────────────────

console.log('\n── Test 4: retry/resume ─────────────────────────────────────────────────────\n');

{
  // Row 1 (A1-HOLD-002) was held in the prior run; it would still be uncertain if
  // re-processed (A1-HOLD-002 is pre-seeded as existing, empty Price Unit).
  // But on the automatic re-run it is SKIPPED (held:row:1 is in completedRows),
  // so its pre-seeded status doesn't affect this run's behaviour.
  // We still pre-seed it to correctly represent the system state after the prior run.
  const csv = buildCsv([
    { code: CODES[0], priceUnit: 'CASE' },  // row 0: was saved (skipped)
    { code: CODES[1], priceUnit: '' },      // row 1: was held (skipped)
    { code: CODES[2], priceUnit: 'CASE' },  // row 2: new → auto-import this run
  ]);

  const { backend, calls, importDocs, attachment, options } = makeBackend({
    uncertainIndexes: [1],                        // PHT-B: existing (would be held if retried)
    preSeededKeys:    ['row:0', 'held:row:1'],    // prior run's completed state
    csv,
  });

  let result;

  await check('retry/resume → outcome is needs_review (held:row:1 still outstanding)', async () => {
    result = await processAttachmentInBackground(backend, attachment, options);
    assert.equal(result.outcome, 'needs_review',
      `Expected needs_review (doc stays partial), got ${result.outcome}: ${result.reason ?? ''}`);
  });

  await check(`retry/resume → applyQuote called exactly once (${CODES[2]} only)`, () => {
    assert.equal(calls.applyQuote.length, 1,
      `applyQuote count: expected 1, got ${calls.applyQuote.length}`);
    assert.equal(calls.applyQuote[0].vendorItemCode, CODES[2],
      `Expected ${CODES[2]}, got ${calls.applyQuote[0].vendorItemCode}`);
  });

  await check('retry/resume → heldKeys reports held:row:1 (carried from prior run)', () => {
    // The re-run found held:row:1 in the pre-existing newCompletedKeys.
    // It surfaces it as outstanding in the return value.
    assert.ok(
      result.heldKeys.includes('held:row:1'),
      `held:row:1 must appear in heldKeys: ${JSON.stringify(result.heldKeys)}`
    );
    // No NEW holds were added this run (row:1 was skipped, not re-held).
    const newHolds = result.heldKeys.filter(k => !['held:row:1'].includes(k));
    assert.equal(newHolds.length, 0,
      `No new held keys expected; got: ${JSON.stringify(newHolds)}`);
    console.log(`  · heldKeys (outstanding): ${JSON.stringify(result.heldKeys)}`);
  });

  await check('retry/resume → row:0 appears exactly once (no duplicate save)', () => {
    const doc = getDoc(importDocs);
    const keys = doc.completed_keys ?? [];
    const count = keys.filter(k => k === 'row:0').length;
    assert.equal(count, 1,
      `row:0 must appear exactly once; found ${count}: ${JSON.stringify(keys)}`);
  });

  await check('retry/resume → held:row:1 appears exactly once (not re-added)', () => {
    const doc = getDoc(importDocs);
    const keys = doc.completed_keys ?? [];
    const count = keys.filter(k => k === 'held:row:1').length;
    assert.equal(count, 1,
      `held:row:1 must appear exactly once; found ${count}: ${JSON.stringify(keys)}`);
  });

  await check('retry/resume → final completed_keys has exactly row:0, held:row:1, row:2', () => {
    const doc = getDoc(importDocs);
    const keys = new Set(doc.completed_keys ?? []);
    assert.ok(keys.has('row:0'),      `row:0 missing`);
    assert.ok(keys.has('held:row:1'), `held:row:1 missing`);
    assert.ok(keys.has('row:2'),      `row:2 missing`);
    // Exactly three unique keys — no extras.
    assert.equal(keys.size, 3,
      `Expected 3 unique keys, got ${keys.size}: ${JSON.stringify([...keys])}`);
    console.log(`  · completed_keys: ${JSON.stringify(doc.completed_keys)}`);
  });

  await check('retry/resume → import document stays partial (not complete)', () => {
    const doc = getDoc(importDocs);
    assert.equal(doc.status, 'partial',
      `status: expected partial (held:row:1 still outstanding), got ${doc.status}`);
  });
}

// ── Summary ───────────────────────────────────────────────────────────────────

console.log(`\n${passed}/${passed} partial-row-hold checks passed (local executed regression evidence).`);
console.log(`
Evidence recorded — Division I → Module A → Task 1 (partial-row-hold path):
  ✓ uncertain-first  — row 0 held; rows 1+2 auto-import; doc partial
  ✓ uncertain-middle — row 1 held; rows 0,2 auto-import; doc partial
  ✓ all-uncertain    — all rows held; zero auto-imports; doc partial
  ✓ retry/resume     — row:0 and held:row:1 skipped; row:2 processed;
                       doc stays partial; no duplicates

Design constraints verified:
  ✓ One unclear item does not block valid items from importing automatically
  ✓ Unresolved rows remain identifiable (held:row:N in completed_keys)
  ✓ Completion status is honest (partial, not complete, while held rows exist)
  ✓ Retry/resume: saved rows skip; held rows skip; new rows process; no duplicates

Separate evidence still required:
  · Real-email delivery (Postmark inbound → webhook → Edge Function → database)
`);
