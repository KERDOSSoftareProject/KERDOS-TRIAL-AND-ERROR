// Test-only persistence fixture shared by A1 new-item and A2 pull/import tests.
// The parser, price importer, catalog service and readiness calculation are real;
// database write results are deliberately simulated and are not hosted evidence.
import {createRecords} from '../../src/backend/records.js';
const CREATED_VENDOR_ITEM_ID='aaaaaaaa-0000-0000-0000-000000000001';
const CREATED_CATALOG_ID='cccccccc-0000-0000-0000-000000000001';
const CREATED_CATEGORY_ID='eeeeeeee-0000-0000-0000-000000000001';
const CREATED_MAPPING_ID='dddddddd-0000-0000-0000-000000000001';

const normalizeCatalogName = name => String(name || '').trim().toLowerCase().replace(/\s+/g, ' ');

// Match the atomic catalog RPC's public contract for local integration tests.
// The migration tests exercise the real transaction and locking behavior.
export function fixtureProductItemRpc(catalogItems, categories, insertCatalog) {
  return async (name, args) => {
    if (name !== 'kerdos_find_or_create_product_item') return {data:null,error:{message:`Unsupported fixture RPC: ${name}`}};
    const {p_organization_id:organizationId,p_concept_key:conceptKey,p_name:label,p_category_id:categoryId,
      p_category_review:categoryReview,p_category_reason:categoryReason} = args;
    const byAge = (a,b) => String(a.created_at || '').localeCompare(String(b.created_at || '')) || a.id.localeCompare(b.id);
    const active = catalogItems.filter(item => item.organization_id === organizationId && !item.merged_into_id
      && !item.retired_at && (!item.lifecycle_state || item.lifecycle_state==='active') && !item.concept_review_required);
    const same = active.filter(item => item.concept_key === conceptKey);
    const eligible = active.filter(item => !item.concept_split_from_id);
    const item = eligible.filter(candidate => candidate.concept_key === conceptKey).sort(byAge)[0]
      || eligible.filter(candidate => !candidate.concept_key && normalizeCatalogName(candidate.name) === normalizeCatalogName(label)).sort(byAge)[0];
    if (item || !categoryId) return {data:{item:item || null,created:false,sameLabelCount:same.length},error:null};
    const category = categories.find(entry => entry.id === categoryId);
    const start = category?.range_start || 10000;
    const end = category?.range_end ?? Number.MAX_SAFE_INTEGER;
    const used = active.map(entry => entry.master_item_number).filter(number => number >= start && number <= end);
    const created = insertCatalog({
      organization_id:organizationId,category_id:categoryId,name:label,concept_key:conceptKey,concept_key_set_at:new Date().toISOString(),
      master_item_number:Math.max(start-1,...used)+1,matching_behavior:'flexible',brand_locked:false,
      category_review:!!categoryReview,category_reason:categoryReason || null,
    });
    return {data:{item:created,created:true,sameLabelCount:same.length+1},error:null};
  };
}

export function createPriceImportFixture({text:CSV_TEXT,industry='Generic',vocabulary=[],multiRow=false}) {
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
  const nextId = (base, ordinal) => multiRow ? base.slice(0,-12)+String(ordinal).padStart(12,'0') : base;
  const insertCatalog = value => {
    const row = {...value,id:nextId(CREATED_CATALOG_ID,calls.createCatalog.length+1),created_at:new Date().toISOString()};
    catalogItems.push(row);
    calls.createCatalog.push(row);
    return row;
  };

  // createRecords execute function — handles each operation
  function execute(spec) {
    const { table, action, filters, value, cardinality } = spec;

    const eqFilter = (rows, filters) =>
      filters.reduce((acc, f) =>
        f.operator === 'eq' ? acc.filter(r => String(r[f.column]) === String(f.value)) : acc, rows);

    if (action === "select" && table === "organizations") return {data:{industry},error:null};
    if (action === "select" && table === "org_vocabulary") return {data:vocabulary,error:null};

    // ── vendor_items ─────────────────────────────────────────────────────────
    if (table === 'vendor_items') {
      // Initial load — empty (no pre-seeded items for NEW_CODE)
      if (action === 'select') {const rows=eqFilter(vendorItems,filters);return Promise.resolve({data:cardinality==='single'||cardinality==='maybeSingle'?rows[0]??null:rows,error:null});}
      // update (import_row staging when needsBasis && ex — should NOT be called
      // for a brand-new item because ex is null)
      if (action === 'update') {
        const matches=eqFilter(vendorItems,filters);
        if(!matches.length)return Promise.reject(new Error('vendor_items UPDATE called for new item — should not happen (needsBasis && ex path)'));
        for(const row of matches)Object.assign(row,value);
        return Promise.resolve({data:cardinality==='single'?matches[0]:matches,error:null});
      }
    }

    // ── catalog_items ─────────────────────────────────────────────────────────
    if (table === 'catalog_items') {
      if (action === 'select') return Promise.resolve({ data: eqFilter(catalogItems, filters), error: null });
      // INSERT (matchOrCreate creates a new catalog_item)
      if (action === 'insert') {
        const row = insertCatalog(Array.isArray(value) ? value[0] : value);
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
        const row = { ...(Array.isArray(value) ? value[0] : value), id: nextId(CREATED_MAPPING_ID,calls.createMapping.length+1) };
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
          const row = { id: doc.id, status: doc.status, completed_keys: doc.completed_keys,source_rows:doc.source_rows,file_path:doc.file_path,staged_row_receipts:doc.staged_row_receipts,organization_id:doc.organization_id,vendor_id:doc.vendor_id,retrieval_evidence:doc.retrieval_evidence };
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

  const rpc = fixtureProductItemRpc(catalogItems,categories,insertCatalog);
  const backend = {
    rpc,
    catalog:{async findOrCreateProductItem(args){return (await rpc('kerdos_find_or_create_product_item',args)).data;}},
    attachments: {
      download: async () => new TextEncoder().encode(CSV_TEXT || ''),
      setStatus: async (attachmentId, status, reason, importDocId) => {
        calls.setStatus.push({ attachmentId, status, reason, importDocId });
      },
    },
    pricing: {
      applyQuote: async (params) => {
        calls.applyQuote.push({ ...params });
        const row={id:params.vendorItemId||nextId(CREATED_VENDOR_ITEM_ID,vendorItems.length+1),organization_id:params.organizationId,vendor_id:params.vendorId,
          vendor_item_code:params.vendorItemCode,description:params.description,pack_size:params.packSize,
          selling_unit:params.sellingUnit,price:params.price,price_basis:params.priceBasis,brand:params.brand,
          gtin:params.gtin,manufacturer_code:params.manufacturerCode,
          price_source:'price_list',last_updated:params.effectiveDate,import_row:params.importRow,
          field_resolutions:params.fieldResolutions,price_unavailable:params.priceUnavailable};
        const existing=vendorItems.find(item=>item.id===row.id);
        if(existing)Object.assign(existing,row);else vendorItems.push(row);
        return row.id;
      },
    },
    records,
  };

  return { backend, calls, importDocs, mappings, vendorItems, catalogItems, categories };
}
