// Test-only persistence fixture shared by A1 new-item and A2 pull/import tests.
// The parser, price importer, catalog service and readiness calculation are real;
// database write results are deliberately simulated and are not hosted evidence.
import {createRecords} from '../../src/backend/records.js';
const CREATED_VENDOR_ITEM_ID='aaaaaaaa-0000-0000-0000-000000000001';
const CREATED_CATALOG_ID='cccccccc-0000-0000-0000-000000000001';
const CREATED_CATEGORY_ID='eeeeeeee-0000-0000-0000-000000000001';
const CREATED_MAPPING_ID='dddddddd-0000-0000-0000-000000000001';

export function createPriceImportFixture({text:CSV_TEXT}) {
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
        const id = row.id ?? 'bbbbbbbb-0000-0000-0000-'+String(calls.insertImportDoc.length+1).padStart(12,'0');
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
        const row={id:params.vendorItemId||CREATED_VENDOR_ITEM_ID,organization_id:params.organizationId,vendor_id:params.vendorId,
          vendor_item_code:params.vendorItemCode,description:params.description,pack_size:params.packSize,
          selling_unit:params.sellingUnit,price:params.price,price_basis:params.priceBasis,
          price_source:'price_list',last_updated:params.effectiveDate,import_row:params.importRow,
          field_resolutions:params.fieldResolutions,price_unavailable:params.priceUnavailable};
        const existing=vendorItems.find(item=>item.id===row.id);
        if(existing)Object.assign(existing,row);else vendorItems.push(row);
        return CREATED_VENDOR_ITEM_ID;
      },
    },
    records,
  };

  return { backend, calls, importDocs, mappings, vendorItems, catalogItems, categories };
}
