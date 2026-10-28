/** Local executed checks for independent row processing and A1.7 resume compatibility.
 * completed_keys holds saved row:N only; unresolved row metadata is separate.
 */
import assert from 'node:assert/strict';
import {parseDocument} from '../src/ingestion.js';
import {verifyResumeRows} from '../src/core/import-resume.js';
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
        const newId = params.vendorItemId || `vi-new-${++vendorCounter}`;
        const saved = {
          id:               newId,
          organization_id:  params.organizationId,
          vendor_id:        params.vendorId,
          vendor_item_code: params.vendorItemCode,
          description:      params.description,
          pack_size:        params.packSize,
          selling_unit:     params.sellingUnit,
          price:            params.price,
          price_basis:      params.priceBasis,
          import_row:       params.importRow,
          price_unavailable:params.priceUnavailable,
        };
        const existing=vendorItems.find(item=>item.id===newId);
        if(existing)Object.assign(existing,saved);else vendorItems.push(saved);
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

  return { backend, calls, importDocs, attachment, options, fingerprint, vendorItems, mappingsArr, catalogItems };
}


let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
const docFor=state=>Object.values(state.importDocs).find(doc=>doc.id===DOC_ID);
function savedSources(state){return [
  ...state.calls.applyQuote.map(q=>({key:q.importRow.rowKey,sourceLine:q.sourceLine})),
  ...state.vendorItems.filter(v=>v.import_row).map(v=>({key:v.import_row.rowKey,sourceLine:v.import_row.row.sourceLine})),
];}
const run=state=>processAttachmentInBackground(state.backend,state.attachment,state.options);
for(const [name,uncertain] of [['uncertain-first',[0]],['uncertain-middle',[1]],['all-uncertain',[0,1,2]]]){
  const csv=buildCsv(CODES.map((code,i)=>({code,priceUnit:uncertain.includes(i)?'':'CASE'})));
  const state=makeBackend({uncertainIndexes:uncertain,csv});let result;
  const held=uncertain.map(i=>`row:${i}`),saved=CODES.map((_,i)=>`row:${i}`).filter(key=>!held.includes(key));
  await check(name+': valid rows save despite held rows',async()=>{
    result=await run(state);assert.equal(result.outcome,'needs_review');
    assert.deepEqual(result.heldKeys,held);assert.equal(state.calls.applyQuote.length,saved.length);
    assert.deepEqual(state.calls.applyQuote.map(q=>q.importRow.rowKey),saved);
  });
  await check(name+': completion keys contain only saved rows',()=>{
    assert.equal(docFor(state).status,'partial');assert.deepEqual(docFor(state).completed_keys,saved);
    assert.deepEqual(result.heldRows.map(row=>row.key),held);
    assert.ok(result.heldRows.every(row=>row.reasons.length>0));
  });
  await check(name+': unresolved source and reasons persist',()=>{
    for(const i of uncertain){const item=state.vendorItems.find(v=>v.vendor_item_code===CODES[i]);
      assert.equal(item.import_row.reviewRequired,true);assert.ok(item.import_row.row.sourceLine);
      assert.ok(item.import_row.conflicts.length>0);assert.equal(item.import_row.sourceDocumentId,DOC_ID);
    }
    assert.ok(state.calls.setStatus.at(-1).reason.includes('row:'));
  });
  await check(name+': unchanged manual resume verifier accepts saved keys',()=>{
    verifyResumeRows(parseDocument(csv).rows,docFor(state).completed_keys,savedSources(state));
    assert.ok(docFor(state).completed_keys.every(key=>/^row:\d+$/.test(key)));
  });
  await check(name+': retry skips saved rows and reassesses unresolved rows without duplicate writes',async()=>{
    const quotes=state.calls.applyQuote.length,mappings=state.mappingsArr.length,catalogs=state.catalogItems.length;
    const updates=state.calls.vendorItemUpdate.length;
    const retry=await run(state);assert.equal(retry.outcome,'needs_review');assert.deepEqual(retry.heldKeys,held);
    assert.equal(state.calls.applyQuote.length,quotes);assert.equal(state.mappingsArr.length,mappings);
    assert.equal(state.catalogItems.length,catalogs);assert.equal(state.calls.vendorItemUpdate.length-updates,held.length);
    assert.deepEqual(docFor(state).completed_keys,saved);
  });
  await check(name+': trusted resolution can finish the same document without duplicating saved rows',async()=>{
    const before=state.calls.applyQuote.length,ids=state.vendorItems.map(item=>item.id);
    // Simulate the accepted vendor-specific basis produced by a separate review.
    // No inferred value is silently approved by the importer.
    for(const i of uncertain){const item=state.vendorItems.find(v=>v.vendor_item_code===CODES[i]);
      item.price_basis='case';item.selling_unit='CASE';item.price_source='price_list';
      item.import_row={...item.import_row,reviewRequired:false};
    }
    const done=await run(state);assert.equal(done.outcome,'auto_imported');
    assert.equal(docFor(state).id,DOC_ID);assert.equal(docFor(state).status,'complete');
    assert.deepEqual(new Set(docFor(state).completed_keys),new Set(['row:0','row:1','row:2']));
    assert.equal(state.calls.applyQuote.length-before,held.length);
    assert.deepEqual(state.vendorItems.map(item=>item.id),ids);
    verifyResumeRows(parseDocument(csv).rows,docFor(state).completed_keys,savedSources(state));
  });
}
await check('new uncertain items are retained without being counted as saved quotes',async()=>{
  const csv=buildCsv(CODES.map(code=>({code,priceUnit:''})));
  const state=makeBackend({csv});const result=await run(state);
  assert.equal(result.outcome,'needs_review');assert.equal(state.vendorItems.length,3);
  assert.deepEqual(docFor(state).completed_keys,[]);assert.equal(result.heldKeys.length,3);
  assert.ok(state.vendorItems.every(v=>v.price_unavailable&&v.import_row.reviewRequired));
});
await check('write failure stays partial without marking the failed or later row complete',async()=>{
  const state=makeBackend({csv:buildCsv(CODES.map(code=>({code,priceUnit:'CASE'})))});
  const apply=state.backend.pricing.applyQuote;let calls=0;
  state.backend.pricing.applyQuote=async q=>{if(++calls===2)throw new Error('simulated write failure');return apply(q);};
  const result=await run(state);assert.equal(result.outcome,'needs_review');
  assert.equal(calls,2);assert.equal(docFor(state).status,'partial');assert.deepEqual(docFor(state).completed_keys,['row:0']);
});
console.log(`${passed}/${passed} independent-row and resume checks passed (local executed evidence).`);
