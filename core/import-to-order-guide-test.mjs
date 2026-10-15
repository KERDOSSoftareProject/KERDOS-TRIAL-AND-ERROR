// End-to-end test: import row → preparePriceImport → OrderGuide readiness
// Tests the complete path: invoice arithmetic resolves basis → fields populate
// → orderGuideAssessment clears all blockers → row is ready.
// Also tests that rows without sufficient evidence stay in Item Catalog.

import {preparePriceImport} from './price-import-review.js';
import {resolveQuoteBasis} from './quote-basis.js';
import {orderGuideAssessment, catalogRowEvidence} from './catalog-fields.js';
import {quoteStatus, configureProcurement} from '../procurement.js';
import {configureCategoryProfile} from '../knowledge/category-profiles.js';
import {createRecords} from '../backend/records.js';
import {assertBackendContract} from '../backend/contract.js';
import {createImportService} from '../services/imports.js';
import {createCatalogService} from '../services/catalog.js';
import {importPriceRow} from './import-price-row.js';
configureProcurement({industry:'restaurant'});
configureCategoryProfile('restaurant');

// ── In-memory backend for workflow tests ───────────────────────────────────────
// Pattern from portable-provider-test.mjs.
// applyQuote returns a vendor-item ID (scalar string) — matching the production
// kerdos_apply_price_quote RPC contract that ImportModal depends on.
// createMapping inserts into item_mappings and returns {id}.
// Records service supports the full query vocabulary used by importService and catalogService.
function createInMemoryBackend() {
  const data = new Map();
  let nextId = 1;
  const rows = name => { if (!data.has(name)) data.set(name, []); return data.get(name); };
  const execute = async spec => {
    const matches = row => spec.filters.every(({operator,column,value}) => {
      const actual = row[column];
      if (operator === 'eq') return actual === value;
      if (operator === 'in') return value.includes(actual);
      if (operator === 'ilike') return String(actual||'').toLowerCase() === String(value).toLowerCase();
      if (operator === 'lte') return actual <= value;
      throw new Error(`Unsupported filter: ${operator}`);
    });
    let result;
    if (spec.action === 'insert' || spec.action === 'upsert') {
      const values = Array.isArray(spec.value) ? spec.value : [spec.value];
      result = values.map(value => value.id ? {...value} : {id:`mem-${nextId++}`, ...value});
      rows(spec.table).push(...result);
    } else if (spec.action === 'select') result = rows(spec.table).filter(matches);
    else if (spec.action === 'update') {
      result = rows(spec.table).filter(matches);
      result.forEach(r => Object.assign(r, spec.value));
    } else if (spec.action === 'delete') {
      result = rows(spec.table).filter(matches);
      data.set(spec.table, rows(spec.table).filter(r => !matches(r)));
    } else throw new Error(`Unsupported action: ${spec.action}`);
    if (spec.orders.length) result = [...result].sort((a,b) => {
      for (const {column,options} of spec.orders) {
        const order = (a[column]>b[column])-(a[column]<b[column]);
        if (order) return options?.ascending === false ? -order : order;
      }
      return 0;
    });
    if (spec.range) result = result.slice(spec.range.from, spec.range.to + 1);
    if (spec.limit !== undefined) result = result.slice(0, spec.limit);
    if (spec.cardinality === 'single') return {data:result[0]||null, error:result.length===1?null:new Error('Expected one record')};
    if (spec.cardinality === 'maybeSingle') return {data:result[0]||null, error:result.length>1?new Error('Expected at most one record'):null};
    return {data:result, error:null};
  };
  const fn = async () => null;
  // applyQuote writes a vendor_items row and returns the vendor-item ID (scalar string).
  // This matches the kerdos_apply_price_quote RPC return contract.
  // The in-memory version omits price_history writes (covered by SQL tests).
  const applyQuote = async quote => {
    const existing = rows('vendor_items').find(r =>
      r.organization_id === quote.organizationId &&
      r.vendor_id === quote.vendorId &&
      r.vendor_item_code === quote.vendorItemCode
    );
    const fields = {
      organization_id: quote.organizationId,
      vendor_id: quote.vendorId,
      vendor_item_code: quote.vendorItemCode || null,
      description: quote.description,
      brand: quote.brand || null,
      pack_size: quote.packSize || null,
      selling_unit: quote.sellingUnit || null,
      price: quote.price ?? null,
      price_unavailable: !!quote.priceUnavailable,
      price_source: quote.sourceDocumentId ? 'pricelist' : 'quote',
      price_basis: quote.priceBasis || null,
      import_row: quote.importRow || null,
      field_resolutions: quote.fieldResolutions || null,
      gtin: quote.gtin || null,
      manufacturer_code: quote.manufacturerCode || null,
    };
    if (existing) { Object.assign(existing, fields); return existing.id; }  // ← returns ID
    const record = {id:`mem-${nextId++}`, ...fields};
    rows('vendor_items').push(record);
    return record.id;  // ← returns ID, matching production RPC
  };
  const provider = assertBackendContract({
    kind:'in-memory-test',
    session:{get:fn,subscribe:()=>()=>{},signIn:fn,signUp:fn,signOut:fn},
    workspace:{memberships:fn,snapshot:fn},
    documents:{upload:fn,signedUrl:fn,remove:fn,deletePriceSheet:fn,deleteInvoiceRecord:fn},
    realtime:{subscribeToOrganization:()=>()=>{}},
    pricing:{applyQuote},
    catalog:{saveRow:fn},
    invoices:{record:fn},
    team:{acceptInvite:fn},
    records:createRecords(execute),
  });
  return {
    provider,
    importService: createImportService(provider),
    catalogService: createCatalogService(provider),
  };
}

let passed=0, failed=0;
function t(label, got, want) {
  if (got === want) { passed++; }
  else { failed++; console.log('FAIL  ' + label + ': got ' + JSON.stringify(got) + ' want ' + JSON.stringify(want)); }
}
function ok(label, val, extra) {
  if (val) { passed++; }
  else { failed++; console.log('FAIL  ' + label + (extra ? ': ' + extra : '')); }
}

// Goods invoice entry that establishes LB basis for chicken breast
const chickenInvoice = {
  row: {
    code: '49200',
    description: 'CHIC BRST RAW BNLS RNDM CVP',
    packSize: '4/10 LB',
    sellingUnit: 'LB',
    priceBasis: 'measure',
    billingUnitEvidence:{kind:'goods-invoice-billed-unit',header:'UOM',unit:'LB'},
    qty: 40, price: 2.06, amount: 82.40,
    issues: [],
  },
  number: 'INV-2026-001',
  date: '2026-09-15',
};

// A category and catalog item that would receive the row
const meatCategory = {id: 'cat-meat', name: 'Meat & Poultry', is_holding_pen: false};
const chickenCatalogItem = {
  id: 'ci-chicken', name: 'Chicken Breast Boneless',
  category_id: 'cat-meat', category_reason: 'Meat product',
  category_review: false,
  brand_locked: false,
};

// ── TEST 1: Invoice arithmetic resolves basis ──────────────────────────────────
// Price sheet row with no explicit selling unit, but matching invoice with LB billing
{
  const sheetRow = {
    code: '49200',
    description: 'CHIC BRST RAW BNLS RNDM CVP',
    packSize: '4/10 LB',
    price: 2.06,
    sellingUnit: '',
    sellingUnitSource: '',
  };
  const prepared = preparePriceImport(sheetRow, null, null, [], [chickenInvoice]);
  t('invoice resolves: resolved is not null', prepared.resolved !== null, true);
  t('invoice resolves: sellingUnit is LB', prepared.resolved?.sellingUnit, 'LB');
  t('invoice resolves: basis is measure', prepared.resolved?.basis?.basis, 'measure');
  t('invoice resolves: source is invoice billing unit', prepared.resolved?.source, 'invoice billing unit');
  t('invoice resolves: requiresReview is false', !!prepared.requiresReview, false);
  ok('invoice resolves: no blocking reasons', prepared.reasons.length === 0, JSON.stringify(prepared.reasons));
}

// ── TEST 2: Inference without invoice — still suggested, requiresReview true ──
{
  const sheetRow = {
    code: '49200',
    description: 'CHIC BRST RAW BNLS RNDM CVP',
    packSize: '4/10 LB',
    price: 2.06,
    sellingUnit: '',
    sellingUnitSource: '',
  };
  const prepared = preparePriceImport(sheetRow, null, null, [], []);
  t('inference only: resolved is not null', prepared.resolved !== null, true);
  t('inference only: requiresReview is true', !!prepared.requiresReview, true);
  ok('inference only: reason mentions suggested', 
    prepared.reasons.some(r => /suggested|basis/i.test(r)));
}

// ── TEST 3: Explicit unit on sheet — resolves immediately, no review ───────────
{
  const sheetRow = {
    code: '49200',
    description: 'CHIC BRST RAW BNLS RNDM CVP',
    packSize: '4/10 LB',
    price: 2.06,
    sellingUnit: 'LB',
    sellingUnitSource: 'price header',
  };
  const prepared = preparePriceImport(sheetRow, null, null, [], []);
  t('explicit unit: resolved', prepared.resolved?.sellingUnit, 'LB');
  t('explicit unit: no review', !!prepared.requiresReview, false);
}

// ── TEST 4: Conflicting invoices — requiresReview true ────────────────────────
{
  const sheetRow = {
    code: '49200',
    description: 'CHIC BRST RAW BNLS RNDM CVP',
    packSize: '4/10 LB',
    price: 2.06,
    sellingUnit: '',
  };
  const conflictInvoice = {
    row: { ...chickenInvoice.row, sellingUnit: 'CS', priceBasis: 'selling-unit',
           qty: 1, price: 82.40, amount: 82.40 },
    number: 'INV-2026-002', date: '2026-09-16',
  };
  const prepared = preparePriceImport(sheetRow, null, null, [], [chickenInvoice, conflictInvoice]);
  t('conflict invoices: requiresReview', !!prepared.requiresReview, true);
  ok('conflict invoices: reason mentions conflict',
    prepared.reasons.some(r => /conflict|billing unit|disagree/i.test(r)));
}

// ── TEST 5: Order Guide assessment — invoice-resolved row clears all gates ────
// Simulate what orderGuideAssessment sees after applyQuote writes the resolved fields.
{
  // What applyQuote would write to the vendor_item record
  const vendorItem = {
    id: 'vi-1',
    vendor_id: 'v-1',
    description: 'CHIC BRST RAW BNLS RNDM CVP',
    pack_size: '4/10 LB',
    selling_unit: 'LB',
    price_basis: 'measure',
    price: 2.06,
    price_unavailable: false,
    price_source: 'pricelist',
    import_row: {
      reviewRequired: false,   // invoice arithmetic resolved — no review needed
    },
    field_resolutions: {},
    brand: null,
  };
  const mapping = {
    id: 'm-1',
    catalog_item_id: 'ci-chicken',
    vendor_item_id: 'vi-1',
    comparison_track: 'exact',
    confidence_score: 100,
    match_method: 'rule_based',
  };
  const assessment = orderGuideAssessment({
    item: chickenCatalogItem,
    vendorItem,
    mapping,
    vendor: {id:'v-1', name:'Test Vendor'},
    category: meatCategory,
    peers: [],
    categories: [meatCategory],
    settings: {},
    now: new Date('2026-10-06'),
  });
  ok('order guide: no blockers', assessment.blockers.length === 0,
    'blockers: ' + JSON.stringify(assessment.blockers));
  t('order guide: ready', assessment.ready, true);
}

// ── TEST 6: Inferred row stays in Item Catalog — source blocker present ────────
{
  const vendorItem = {
    id: 'vi-2',
    vendor_id: 'v-1',
    description: 'CHIC BRST RAW BNLS RNDM CVP',
    pack_size: '4/10 LB',
    selling_unit: 'LB',
    price_basis: 'measure',
    price: 2.06,
    price_unavailable: true,   // set because requiresReview (inference only)
    price_source: 'pricelist',
    import_row: {
      reviewRequired: true,    // inference only — client must confirm
    },
    field_resolutions: {},
    brand: null,
  };
  const mapping = {
    id: 'm-2',
    catalog_item_id: 'ci-chicken',
    vendor_item_id: 'vi-2',
    comparison_track: 'exact',
    confidence_score: 100,
    match_method: 'rule_based',
  };
  const assessment = orderGuideAssessment({
    item: chickenCatalogItem,
    vendorItem,
    mapping,
    vendor: {id:'v-1', name:'Test Vendor'},
    category: meatCategory,
    peers: [],
    categories: [meatCategory],
    settings: {},
    now: new Date('2026-10-06'),
  });
  ok('inferred row: has blockers', assessment.blockers.length > 0);
  ok('inferred row: source or quote blocker',
    assessment.blockers.includes('source') || assessment.blockers.includes('quote'),
    'blockers: ' + JSON.stringify(assessment.blockers));
  t('inferred row: not ready', assessment.ready, false);
}

// ── TEST 7: Inferred unit → sellingUnitSource="inferred" written by preparePriceImport ──
// Verifies the provenance fix in price-import-review.js.
// The row has no explicit unit, no invoice, no prior. inferQuoteBasis runs at
// "suggested" level and must write sellingUnitSource="inferred" into row.
{
  const sheetRow = {
    code: '49200',
    description: 'CHIC BRST RAW BNLS RNDM CVP',
    packSize: '4/10 LB',
    price: 2.06,
    sellingUnit: '',
    sellingUnitSource: '',
  };
  const prepared = preparePriceImport(sheetRow, null, null, [], []);
  t('inferred provenance: sellingUnitSource written', prepared.row.sellingUnitSource, 'inferred');
  t('inferred provenance: resolved.sellingUnitSource written', prepared.resolved?.sellingUnitSource, 'inferred');
  t('inferred provenance: requiresReview true', !!prepared.requiresReview, true);
}

// Shared row context for workflow tests 8–11
const TEST_ORG = 'org-wf';
const TEST_VENDOR = 'v-wf';
const TEST_CATALOG_ITEM = {id:'ci-chicken', name:'Chicken Breast Boneless', category_id:'cat-meat', category_reason:'Meat product', category_review:false, brand_locked:false, master_item_number:'KDX-49200'};
const TEST_CATEGORY = {id:'cat-meat', name:'Meat & Poultry', is_holding_pen:false, range_start:5000, range_end:5999, keywords:['chicken','beef','pork','turkey','meat','poultry']};
const GROUP = {name:'horn.txt', quoteValidUntil:null};

// ── TEST 8: Inferred unit → importPriceRow saves record → catalogRowEvidence gives GUESSED(70) ──
// Exercises the full orchestration path: importPriceRow calls applyQuote (returns ID),
// matchOrCreate, createMapping. The saved record is loaded back and checked for
// sellingUnitSource="inferred" → accuracy=70. Production import contract is verified.
{
  const {provider, importService, catalogService} = createInMemoryBackend();
  // Seed a catalog item for matchOrCreate to find
  const workingCatalogItems = [TEST_CATALOG_ITEM];
  const workingCategories = [TEST_CATEGORY];
  const workingVendorItems = [];
  const workingMappings = [];
  // matchOrCreate returns ci-chicken from workingCatalogItems without writing to the DB.
  // Seed it directly so that the post-import provider.records lookup finds the same row.
  await provider.records.query('catalog_items').insert({...TEST_CATALOG_ITEM}).select().single();

  const sourceRow = {code:'49200', description:'CHIC BRST RAW BNLS RNDM CVP', packSize:'4/10 LB', price:2.06, sellingUnit:'', sellingUnitSource:''};
  const row = {...sourceRow};
  const result = await importPriceRow({
    backend: provider, importService, catalogService,
    sourceRow, row, ex:null, priorMapping:null, rowIssues:[], rowNeedsReview:false,
    invoiceSources:[], orgId:TEST_ORG, vendorId:TEST_VENDOR,
    sourceDocumentId:'doc-8', completedKey:'row:0', importBatchTime:'2026-10-07',
    group:GROUP, sourceFilePath:null,
    workingCatalogItems, workingCategories, workingVendorItems, workingMappings,
    applySelectedCategory: null,
  });
  ok('inferred accuracy: importPriceRow succeeded', !!result.vendorItemId, 'vendorItemId: '+result.vendorItemId);
  ok('inferred accuracy: needsBasis=true (no explicit unit)', result.needsBasis, 'needsBasis='+result.needsBasis);

  // Read back the saved record through importService
  const vendorItem = await importService.findVendorItem({organizationId:TEST_ORG, vendorId:TEST_VENDOR, code:sourceRow.code});
  ok('inferred accuracy: saved record found', !!vendorItem, 'findVendorItem returned null');
  ok('inferred accuracy: sellingUnitSource="inferred" in saved import_row',
    vendorItem?.import_row?.evidence?.sellingUnitSource === 'inferred',
    'got: '+vendorItem?.import_row?.evidence?.sellingUnitSource);

  // mapping was created by matchOrCreate + createMapping through the actual services
  const mapping = await importService.mapping(TEST_ORG, result.vendorItemId);
  ok('inferred accuracy: mapping created', !!mapping, 'mapping: '+JSON.stringify(mapping));

  // Load the catalog item the mapping actually points to — not the seeded constant.
  // matchOrCreate creates a new catalog item when no existing item matches the vendor description.
  // The test verifies the mapping points to the item that was actually saved, whatever it is.
  const {data:actualCatalogItem} = await provider.records.query('catalog_items').select().eq('id', mapping.catalog_item_id).maybeSingle();
  ok('inferred accuracy: catalog item loaded from mapping', !!actualCatalogItem, 'catalog_item_id: '+mapping?.catalog_item_id);
  ok('inferred accuracy: mapping points to a real catalog item', !!actualCatalogItem?.id, 'got: '+JSON.stringify(actualCatalogItem?.id));

  const evidence = catalogRowEvidence({item:actualCatalogItem, vendorItem, mapping, vendor:{id:TEST_VENDOR,name:'Test Vendor'}, category:TEST_CATEGORY, peers:[], categories:[TEST_CATEGORY]});
  t('inferred accuracy: sellingUnit accuracy is 70 (GUESSED)', evidence?.sellingUnit?.accuracy, 70);
  ok('inferred accuracy: reason says Suggested', /suggested/i.test(evidence?.sellingUnit?.reason||''), 'reason: '+JSON.stringify(evidence?.sellingUnit?.reason));
  const qs = quoteStatus(vendorItem, {}, new Date());
  t('inferred accuracy: quoteStatus unavailable', qs, 'unavailable');
}

// ── TEST 9: Inferred unit → sellingUnit is an independent blocker ─────────────
// importPriceRow → load saved record → orderGuideAssessment must include sellingUnit
// even with comparison_track="exact" and a clean association.
{
  const {provider, importService, catalogService} = createInMemoryBackend();
  const workingCatalogItems = [TEST_CATALOG_ITEM];
  const workingCategories = [TEST_CATEGORY];
  const workingVendorItems = [];
  const workingMappings = [];
  await provider.records.query('catalog_items').insert({...TEST_CATALOG_ITEM}).select().single();

  const sourceRow = {code:'49201', description:'CHIC BRST RAW BNLS RNDM CVP', packSize:'4/10 LB', price:2.06, sellingUnit:'', sellingUnitSource:''};
  await importPriceRow({
    backend:provider, importService, catalogService,
    sourceRow, row:{...sourceRow}, ex:null, priorMapping:null, rowIssues:[], rowNeedsReview:false,
    invoiceSources:[], orgId:TEST_ORG, vendorId:TEST_VENDOR,
    sourceDocumentId:'doc-9', completedKey:'row:0', importBatchTime:'2026-10-07',
    group:GROUP, sourceFilePath:null,
    workingCatalogItems, workingCategories, workingVendorItems, workingMappings,
    applySelectedCategory:null,
  });
  const vendorItem = await importService.findVendorItem({organizationId:TEST_ORG, vendorId:TEST_VENDOR, code:sourceRow.code});
  const mapping = await importService.mapping(TEST_ORG, vendorItem?.id);
  const {data:actualCatalogItem9} = await provider.records.query('catalog_items').select().eq('id', mapping.catalog_item_id).maybeSingle();
  ok('inferred blocker: catalog item loaded from mapping', !!actualCatalogItem9);
  const assessment = orderGuideAssessment({item:actualCatalogItem9, vendorItem, mapping, vendor:{id:TEST_VENDOR,name:'Test Vendor'}, category:TEST_CATEGORY, peers:[], categories:[TEST_CATEGORY], settings:{}, now:new Date()});
  ok('inferred blocker: sellingUnit is a blocker', assessment.blockers.includes('sellingUnit'),
    'blockers: '+JSON.stringify(assessment.blockers));
  t('inferred blocker: not ready', assessment.ready, false);
}

// ── TEST 10: Confirmed unit (explicit on sheet) clears sellingUnit gate ────────
// importPriceRow with explicit sellingUnit → saved record → no sellingUnit blocker.
{
  const {provider, importService, catalogService} = createInMemoryBackend();
  const workingCatalogItems = [TEST_CATALOG_ITEM];
  const workingCategories = [TEST_CATEGORY];
  const workingVendorItems = [];
  const workingMappings = [];
  await provider.records.query('catalog_items').insert({...TEST_CATALOG_ITEM}).select().single();

  const sourceRow = {code:'49202', description:'CHIC BRST RAW BNLS RNDM CVP', packSize:'4/10 LB', price:2.06, sellingUnit:'LB', sellingUnitSource:'price header'};
  const result = await importPriceRow({
    backend:provider, importService, catalogService,
    sourceRow, row:{...sourceRow}, ex:null, priorMapping:null, rowIssues:[], rowNeedsReview:false,
    invoiceSources:[], orgId:TEST_ORG, vendorId:TEST_VENDOR,
    sourceDocumentId:'doc-10', completedKey:'row:0', importBatchTime:'2026-10-07',
    group:GROUP, sourceFilePath:null,
    workingCatalogItems, workingCategories, workingVendorItems, workingMappings,
    applySelectedCategory:null,
  });
  t('confirmed unit: needsBasis=false (explicit unit)', result.needsBasis, false);
  const vendorItem10 = await importService.findVendorItem({organizationId:TEST_ORG, vendorId:TEST_VENDOR, code:sourceRow.code});
  const mapping10 = await importService.mapping(TEST_ORG, result.vendorItemId);
  const {data:actualCatalogItem10} = await provider.records.query('catalog_items').select().eq('id', mapping10.catalog_item_id).maybeSingle();
  ok('confirmed unit: catalog item loaded from mapping', !!actualCatalogItem10);
  const evidence = catalogRowEvidence({item:actualCatalogItem10, vendorItem:vendorItem10, mapping:mapping10, vendor:{id:TEST_VENDOR,name:'Test Vendor'}, category:TEST_CATEGORY, peers:[], categories:[TEST_CATEGORY]});
  ok('confirmed unit: accuracy not GUESSED', (evidence?.sellingUnit?.accuracy||0) > 70, 'accuracy: '+evidence?.sellingUnit?.accuracy);
  const assessment = orderGuideAssessment({item:actualCatalogItem10, vendorItem:vendorItem10, mapping:mapping10, vendor:{id:TEST_VENDOR,name:'Test Vendor'}, category:TEST_CATEGORY, peers:[], categories:[TEST_CATEGORY], settings:{}, now:new Date()});
  ok('confirmed unit: sellingUnit not a blocker', !assessment.blockers.includes('sellingUnit'), 'blockers: '+JSON.stringify(assessment.blockers));
}

// ── TEST 11: Inferred unit cannot auto-clear on reimport (resolveQuoteBasis guard) ──
// First import via importPriceRow produces a prior with reviewRequired=true.
// Reimport with that prior must still require review — resolveQuoteBasis returns null.
{
  const {provider, importService, catalogService} = createInMemoryBackend();
  const workingCatalogItems = [TEST_CATALOG_ITEM];
  const workingCategories = [TEST_CATEGORY];
  const workingVendorItems = [];
  const workingMappings = [];

  const sourceRow = {code:'49203', description:'CHIC BRST RAW BNLS RNDM CVP', packSize:'4/10 LB', price:2.06, sellingUnit:'', sellingUnitSource:''};
  const first = await importPriceRow({
    backend:provider, importService, catalogService,
    sourceRow, row:{...sourceRow}, ex:null, priorMapping:null, rowIssues:[], rowNeedsReview:false,
    invoiceSources:[], orgId:TEST_ORG, vendorId:TEST_VENDOR,
    sourceDocumentId:'doc-11', completedKey:'row:0', importBatchTime:'2026-10-07',
    group:GROUP, sourceFilePath:null,
    workingCatalogItems, workingCategories, workingVendorItems, workingMappings,
    applySelectedCategory:null,
  });
  ok('reimport guard: first import requires review', first.needsBasis);

  const prior = await importService.findVendorItem({organizationId:TEST_ORG, vendorId:TEST_VENDOR, code:sourceRow.code});
  ok('reimport guard: prior reviewRequired=true persisted', !!prior?.import_row?.reviewRequired);

  // Reimport the same sheet row against the saved prior
  const p2 = preparePriceImport(sourceRow, prior, null, [], []);
  t('reimport guard: still requiresReview on unchanged reimport', !!p2.requiresReview, true);

  // Direct guard: resolveQuoteBasis must return null when prior has reviewRequired=true,
  // preventing the inferred basis from auto-clearing on reimport without user confirmation.
  const guardResult = resolveQuoteBasis(sourceRow, prior);
  ok('reimport guard: resolveQuoteBasis returns null for reviewRequired prior', guardResult === null,
    'got: '+JSON.stringify(guardResult));
}

// ── TEST 12: Fully resolved row → orderGuideAssessment.ready=true automatically ──
// A row with explicit sellingUnit and priceBasis passes through importPriceRow with
// needsBasis=false and a confirmed price. When the working sets already contain a
// vendor item from a second vendor linked to the same catalog item, matchOrCreate
// returns exact track and engineVerifiable confirms the mapping. All blockers clear.
//
// This proves the engine's end-to-end automatic migration path: two vendors
// confirming the same item + an explicit price quote = ready for the Order Guide
// without any manual review step.
{
  const {provider, importService, catalogService} = createInMemoryBackend();

  // Pre-existing catalog item identified by GTIN, and a prior vendor item from a
  // *different* vendor already linked at exact track. matchOrCreate finds the catalog
  // item via GTIN identifier match (exact track immediately). engineVerifiable
  // confirms the mapping when two vendors share the same GTIN+pack.
  const GTIN = '00012345678901';
  const workingCatalogItems = [{...TEST_CATALOG_ITEM, gtin: GTIN}];
  const workingCategories = [TEST_CATEGORY];
  // Prior vendor item from a different vendor shares the GTIN — proves identity
  const priorVendorItem = {
    id: 'vi-prior', vendor_id: 'v-prior',
    description: 'CHIC BRST RAW BNLS RNDM CVP', pack_size: '4/10 LB',
    brand: null, gtin: GTIN, manufacturer_code: null,
  };
  const priorMappingEntry = {
    id: 'm-prior', catalog_item_id: TEST_CATALOG_ITEM.id,
    vendor_item_id: 'vi-prior', comparison_track: 'exact', confidence_score: 100,
  };
  const workingVendorItems = [priorVendorItem];
  const workingMappings = [priorMappingEntry];

  // Seed the catalog item into the in-memory DB so the post-import lookup finds it.
  // matchOrCreate finds it via GTIN in workingCatalogItems and skips creating a new one;
  // without this seed, the records.query('catalog_items').eq('id', ...) returns null.
  await provider.records.query('catalog_items').insert({...TEST_CATALOG_ITEM, gtin: GTIN}).select().single();

  // Row that arrives fully resolved: selling unit and price basis explicitly stated,
  // GTIN enables identifier-based exact matching
  const sourceRow = {
    code: '49204',
    description: 'CHIC BRST RAW BNLS RNDM CVP',
    packSize: '4/10 LB',
    price: 2.06,
    sellingUnit: 'LB',
    sellingUnitSource: 'price header',
    priceBasis: 'measure',
    gtin: GTIN,
  };
  const result = await importPriceRow({
    backend:provider, importService, catalogService,
    sourceRow, row:{...sourceRow}, ex:null, priorMapping:null, rowIssues:[], rowNeedsReview:false,
    invoiceSources:[], orgId:TEST_ORG, vendorId:TEST_VENDOR,
    sourceDocumentId:'doc-12', completedKey:'row:0', importBatchTime:'2026-10-07',
    group:GROUP, sourceFilePath:null,
    workingCatalogItems, workingCategories, workingVendorItems, workingMappings,
    applySelectedCategory:null,
  });
  t('auto-ready: needsBasis=false', result.needsBasis, false);
  ok('auto-ready: vendorItemId returned', !!result.vendorItemId);

  const vendorItem = await importService.findVendorItem({organizationId:TEST_ORG, vendorId:TEST_VENDOR, code:sourceRow.code});
  const mapping = await importService.mapping(TEST_ORG, result.vendorItemId);
  ok('auto-ready: saved vendor item found', !!vendorItem);
  ok('auto-ready: mapping found', !!mapping);
  // mapping must be at exact track — engineVerifiable confirmed it via second vendor
  t('auto-ready: mapping at exact track', mapping?.comparison_track, 'exact');

  const {data:catalogItem} = await provider.records.query('catalog_items').select().eq('id', mapping.catalog_item_id).maybeSingle();
  ok('auto-ready: catalog item found from mapping', !!catalogItem);
  t('auto-ready: catalog item is the known item', catalogItem?.id, TEST_CATALOG_ITEM.id);

  // price_unavailable must be false: confirmed price, no requiresReview
  t('auto-ready: price_unavailable=false', vendorItem.price_unavailable, false);

  // Derive actual peers: all vendor items linked to the same catalog item, excluding
  // the newly imported one. This is what the Order Guide UI would pass.
  const allMappingsForCatalogItem = workingMappings.filter(m => m.catalog_item_id === mapping.catalog_item_id && m.vendor_item_id !== result.vendorItemId);
  const allVendorItemsById = new Map(workingVendorItems.map(vi => [vi.id, vi]));
  const peers12 = allMappingsForCatalogItem.map(m => allVendorItemsById.get(m.vendor_item_id)).filter(Boolean);
  ok('auto-ready: cross-vendor peer present', peers12.length > 0, 'peers: '+peers12.length);

  const assessment = orderGuideAssessment({
    item:catalogItem, vendorItem, mapping,
    vendor:{id:TEST_VENDOR, name:'Test Vendor'},
    category:TEST_CATEGORY,
    peers:peers12, categories:[TEST_CATEGORY],
    settings:{}, now:new Date(),
  });
  ok('auto-ready: no blockers', assessment.blockers.length === 0,
    'blockers: '+JSON.stringify(assessment.blockers));
  t('auto-ready: ready=true', assessment.ready, true);
}

// ── TEST 13: Single-vendor fresh item — automatic readiness path ─────────────
// A fresh single-vendor item with resolved identity, category, pack and pricing
// must become orderable automatically. A second vendor enables cross-vendor price
// comparison but is not required for ordering.
//
// Engine behavior after the standalone-qualification fix:
//   - matchOrCreate creates a new catalog item (track:"new", no prior links)
//   - The standalone path fires when !peers.length && fieldsReady
//   - The association blocker is suppressed: no conflicting peers, all fields clear
//   - assessment.ready === true immediately after the first import
{
  const {provider, importService, catalogService} = createInMemoryBackend();
  // No prior vendor items — this is the very first import of this item
  const workingCatalogItems = [];
  const workingCategories = [TEST_CATEGORY];
  const workingVendorItems = [];
  const workingMappings = [];

  const sourceRow = {
    code: '49205',
    description: 'CHIC BRST RAW BNLS RNDM CVP',
    packSize: '4/10 LB',
    price: 2.06,
    sellingUnit: 'LB',
    sellingUnitSource: 'price header',
    priceBasis: 'measure',
  };
  const result = await importPriceRow({
    backend:provider, importService, catalogService,
    sourceRow, row:{...sourceRow}, ex:null, priorMapping:null, rowIssues:[], rowNeedsReview:false,
    invoiceSources:[], orgId:TEST_ORG, vendorId:TEST_VENDOR,
    sourceDocumentId:'doc-13', completedKey:'row:0', importBatchTime:'2026-10-07',
    group:GROUP, sourceFilePath:null,
    workingCatalogItems, workingCategories, workingVendorItems, workingMappings,
    applySelectedCategory:null,
  });
  t('single-vendor: needsBasis=false (explicit unit)', result.needsBasis, false);
  // matchOrCreate creates a new catalog item — no existing item could match
  t('single-vendor: match track is new (no prior links)', result.match?.track, 'new');

  const vendorItem = await importService.findVendorItem({organizationId:TEST_ORG, vendorId:TEST_VENDOR, code:sourceRow.code});
  const mapping = await importService.mapping(TEST_ORG, result.vendorItemId);
  const {data:catalogItem} = await provider.records.query('catalog_items').select().eq('id', mapping?.catalog_item_id).maybeSingle();
  ok('single-vendor: vendor item saved', !!vendorItem);
  ok('single-vendor: mapping created', !!mapping);
  ok('single-vendor: new catalog item created', !!catalogItem);
  t('single-vendor: price_unavailable=false', vendorItem.price_unavailable, false);
  // comparison_track is "new", not "exact" — automatic approval not triggered
  t('single-vendor: mapping track is new', mapping?.comparison_track, 'new');

  // Standalone qualification: no peers, all fields resolved → ready immediately.
  // A second vendor enables price comparison; it is not required for ordering.
  const assessment = orderGuideAssessment({
    item:catalogItem, vendorItem, mapping,
    vendor:{id:TEST_VENDOR, name:'Test Vendor'},
    category:TEST_CATEGORY,
    peers:[], categories:[TEST_CATEGORY],
    settings:{}, now:new Date(),
  });
  ok('single-vendor: no association blocker (standalone qualified)', !assessment.blockers.includes('association'),
    'blockers: '+JSON.stringify(assessment.blockers));
  t('single-vendor: ready=true on first complete import', assessment.ready, true);
}

// ── TEST 14: Regression — wrong catalog identity must block standalone ordering ─
// A vendor item whose description is a genuinely different product from its
// matched catalog item must NOT become orderable via the standalone path, even
// when all field-level blockers are clear. The standalone shortcut is only for
// abbreviation/wording uncertainty, not for cross-product mismatches.
{
  const catalogItem = {id:'ci-tomato', organization_id:TEST_ORG, name:'Tomato Whole', category_id:TEST_CATEGORY.id, brand_locked:false};
  const vendorItem = {id:'vi-chic', vendor_id:TEST_VENDOR, organization_id:TEST_ORG,
    description:'CHIC BRST RAW BNLS RNDM CVP', pack_size:'4/10 LB', brand:null,
    gtin:null, manufacturer_code:null, price:2.06, price_unavailable:false,
    selling_unit:'LB', import_row:{reviewRequired:false},
    field_resolutions:{priceBasis:{basis:{basis:'measure',unit:'LB'}}}};
  const mapping = {id:'m-wrong', catalog_item_id:'ci-tomato', vendor_item_id:'vi-chic',
    comparison_track:'new', confidence_score:null, match_method:'rule_based'};
  const assessment = orderGuideAssessment({
    item:catalogItem, vendorItem, mapping,
    vendor:{id:TEST_VENDOR, name:'Test Vendor'},
    category:TEST_CATEGORY,
    peers:[], categories:[TEST_CATEGORY],
    settings:{}, now:new Date(),
  });
  ok('wrong-catalog: association blocker present (different product)', assessment.blockers.includes('association'),
    'blockers: '+JSON.stringify(assessment.blockers));
  t('wrong-catalog: not ready when catalog identity conflicts', assessment.ready, false);
}

// ── TEST 15: Regression — GTIN must not override explicit product conflict ──────
// Two genuinely different products (chicken vs ground beef) that share a GTIN
// (data error or mis-scan) must NOT become "exact" through mappingVerification.
// GTIN resolves abbreviation uncertainty; it does not override active conflicts.
{
  const {mappingVerification:mv} = await import('../services/catalog.js');
  const chicken = {id:'vi-chic', vendor_id:TEST_VENDOR, description:'CHIC BRST RAW BNLS RNDM CVP',
    pack_size:'4/10 LB', brand:null, gtin:'00099999000001', manufacturer_code:null};
  const groundBeef = {id:'vi-beef', vendor_id:'v-other', description:'GROUND BEEF 80/20',
    pack_size:'4/10 LB', brand:null, gtin:'00099999000001', manufacturer_code:null};
  const catalogItem = {id:'ci-chic', name:'Chicken Breast Boneless', category_id:TEST_CATEGORY.id};
  const result = mv(chicken, catalogItem, [groundBeef]);
  t('gtin-conflict: different products sharing GTIN stay at review', result.comparison_track, 'review');
  ok('gtin-conflict: not promoted to exact despite matching GTIN', result.comparison_track !== 'exact',
    'got: '+result.comparison_track);
}

// ── TEST 16: Regression — compareProductIdentity "different" also blocks GTIN exact ─
// Boneless vs. bone-in chicken breast share GTIN and pack (data entry error or
// deliberate separate barcode reuse). compareProductIdentity fully resolves both
// descriptions and returns status="different". The GTIN shortcut must be blocked
// by that explicit "different" result — not only by the zero-overlap path.
{
  const {mappingVerification:mv} = await import('../services/catalog.js');
  const boneless = {id:'vi-bnls', vendor_id:TEST_VENDOR, description:'CHIC BRST RAW BNLS RNDM CVP',
    pack_size:'4/10 LB', brand:null, gtin:'00012345678901', manufacturer_code:null};
  const boneIn = {id:'vi-bonein', vendor_id:'v-other', description:'CHICKEN BREAST BONE IN',
    pack_size:'4/10 LB', brand:null, gtin:'00012345678901', manufacturer_code:null};
  const catalogItem = {id:'ci-bnls', name:'Chicken Breast Boneless', category_id:TEST_CATEGORY.id};
  const result = mv(boneless, catalogItem, [boneIn]);
  t('cut-conflict: boneless vs bone-in sharing GTIN stays at review', result.comparison_track, 'review');
  ok('cut-conflict: not promoted to exact when cut is explicitly different', result.comparison_track !== 'exact',
    'got: '+result.comparison_track);
}

// ── CATALOG MATCHING GATE TESTS (17–25) ────────────────────────────────────────
// Regression tests for the compareProductIdentity + comparePurchasingPack gates
// added to matchOrCreate. Each test seeds a catalog item for the first vendor
// description, then calls matchOrCreate for the second vendor description and
// asserts that the engine does NOT collapse them to the same catalog item, or
// that the match is held at confidence_score 0 (review-only suggestion).
//
// Rules under test:
//   status "different"  → reject match, create new catalog item
//   status "review"     → suggestion only: comparison_track "review", confidence_score 0
//   pack "different"    → create new catalog item (separate purchasing entry)

// Shared helper: seed one catalog item and run matchOrCreate for a second description.
async function matchOrCreateAgainstSeeded(catalogService, seededName, seededPack, incomingDesc, incomingPack) {
  const holdingCategory = {id:'cat-hold', name:'Uncategorized', is_holding_pen:true, range_start:9000, range_end:9999};
  const seededItem = {id:`ci-seed-${Math.random().toString(36).slice(2)}`, name:seededName,
    category_id:'cat-hold', category_review:false, brand_locked:false, master_item_number:9001};
  const workingCatalogItems = [seededItem];
  const workingCategories = [holdingCategory];
  const workingVendorItems = [];
  const workingMappings = [];
  const match = await catalogService.matchOrCreate({
    organizationId:'org-gate', vendorId:'v-gate',
    description:incomingDesc, packSize:incomingPack,
    brand:null, gtin:null, manufacturerCode:null, categoryId:null,
    catalogItems:workingCatalogItems, categories:workingCategories,
    vendorItems:workingVendorItems, mappings:workingMappings,
  });
  return {match, seededId:seededItem.id, workingCatalogItems};
}

// TEST 17: CANDY M&M vs CANDY M&M PEANUT — must get separate catalog items
// M&M Peanut is a genuinely different product from plain M&M. The engine must
// not link them to the same catalog entry, even at review/score=0.
{
  const {catalogService} = createInMemoryBackend();
  const {match, seededId} = await matchOrCreateAgainstSeeded(
    catalogService, 'CANDY M&M', '1/36 CT', 'CANDY M&M PEANUT', '1/36 CT');
  ok('candy-mam-peanut: separate catalog items (different products must not share an entry)',
    match.catalogItemId !== seededId,
    `catalogItemId=${match.catalogItemId} seededId=${seededId} track=${match.track} score=${match.score}`);
  t('candy-mam-peanut: new track (no match found)', match.track, 'new');
}

// TEST 18: CANDY M&M vs CANDY SKITTLES ORIGINAL — must get separate catalog items
// Skittles is a different brand/product from M&M. Separate entries required.
{
  const {catalogService} = createInMemoryBackend();
  const {match, seededId} = await matchOrCreateAgainstSeeded(
    catalogService, 'CANDY M&M', '1/36 CT', 'CANDY SKITTLES ORIGINAL', '1/36 CT');
  ok('candy-skittles: separate catalog items (different products must not share an entry)',
    match.catalogItemId !== seededId,
    `catalogItemId=${match.catalogItemId} seededId=${seededId} track=${match.track} score=${match.score}`);
  t('candy-skittles: new track (no match found)', match.track, 'new');
}

// TEST 19: CANDY M&M vs CANDY SNICKERS SINGLE BARS — must get separate catalog items
// Snickers is a different brand/product from M&M. Separate entries required.
{
  const {catalogService} = createInMemoryBackend();
  const {match, seededId} = await matchOrCreateAgainstSeeded(
    catalogService, 'CANDY M&M', '1/36 CT', 'CANDY SNICKERS SINGLE BARS', '1/36 CT');
  ok('candy-snickers: separate catalog items (different products must not share an entry)',
    match.catalogItemId !== seededId,
    `catalogItemId=${match.catalogItemId} seededId=${seededId} track=${match.track} score=${match.score}`);
  t('candy-snickers: new track (no match found)', match.track, 'new');
}

// TEST 20: SAUSAGE BKF LINK H-C 2.85 OZ vs SAUSAGE BKF PATY B&S 2 WD
// link vs patty: genuinely different products (link sausage vs patty sausage).
// Must get separate catalog entries — not a review-flagged shared entry.
{
  const {catalogService} = createInMemoryBackend();
  const {match, seededId} = await matchOrCreateAgainstSeeded(
    catalogService, 'SAUSAGE BKF LINK H-C 2.85 OZ', '1/64 CT', 'SAUSAGE BKF PATY B&S 2 WD', '1/64 CT');
  ok('sausage-link-patty: separate catalog items (link and patty are different products)',
    match.catalogItemId !== seededId,
    `catalogItemId=${match.catalogItemId} seededId=${seededId} track=${match.track} score=${match.score}`);
  t('sausage-link-patty: new track (no match found)', match.track, 'new');
}

// TEST 21: DRESS HONEY MUSTARD vs HONEY P.C. — must get separate catalog items
// Different products (honey mustard dressing vs honey portion control packets).
{
  const {catalogService} = createInMemoryBackend();
  const {match, seededId} = await matchOrCreateAgainstSeeded(
    catalogService, 'DRESS HONEY MUSTARD', '1/1 GL', 'HONEY P.C.', '200 CT');
  ok('dress-honey-mustard-pc: separate catalog items (different products must not share an entry)',
    match.catalogItemId !== seededId,
    `catalogItemId=${match.catalogItemId} seededId=${seededId} track=${match.track} score=${match.score}`);
  t('dress-honey-mustard-pc: new track (no match found)', match.track, 'new');
}

// TEST 22: MILK WHITE 2% vs MILK WHITE 2% LO/FAT UHT — must get separate catalog items
// UHT (ultra high temperature) is a different product specification — separate entry.
{
  const {catalogService} = createInMemoryBackend();
  const {match, seededId} = await matchOrCreateAgainstSeeded(
    catalogService, 'MILK WHITE 2%', '1/1 GL', 'MILK WHITE 2% LO/FAT UHT', '1/1 GL');
  ok('milk-2pct-uht: separate catalog items (UHT milk is a different product specification)',
    match.catalogItemId !== seededId,
    `catalogItemId=${match.catalogItemId} seededId=${seededId} track=${match.track} score=${match.score}`);
  t('milk-2pct-uht: new track (no match found)', match.track, 'new');
}

// TEST 23: PROD TOMATO 5 X 6 vs PROD TOMATO GRAPE PINTS — must get separate catalog items
// Grape tomatoes are a different variety than 5x6 tomatoes. Separate entries required.
{
  const {catalogService} = createInMemoryBackend();
  const {match, seededId} = await matchOrCreateAgainstSeeded(
    catalogService, 'PROD TOMATO 5 X 6', '1/25 LB', 'PROD TOMATO GRAPE PINTS', '12/1 PT');
  ok('tomato-5x6-grape: separate catalog items (different tomato varieties must not share an entry)',
    match.catalogItemId !== seededId,
    `catalogItemId=${match.catalogItemId} seededId=${seededId} track=${match.track} score=${match.score}`);
  t('tomato-5x6-grape: new track (no match found)', match.track, 'new');
}

// TEST 24: CHEESE PROVOLONE SLICING 3/12 LB vs CHEESE PROVOLONE SLICING 1/12 LB — separate entries
// Same product name, different purchasing packs. Different purchasing packs are always
// separate catalog entries — the pack_conflict review path has been removed.
// A separate catalog item (track="new") is the correct outcome; the seeded 3/12 LB entry
// must not be reused for the 1/12 LB item.
{
  const {catalogService} = createInMemoryBackend();
  const holdingCategory = {id:'cat-hold-cheese', name:'Uncategorized', is_holding_pen:true, range_start:9000, range_end:9999};
  const seededItem = {id:'ci-provolone-3lb', name:'CHEESE PROVOLONE SLICING',
    category_id:'cat-hold-cheese', category_review:false, brand_locked:false, master_item_number:9001};
  // Seed a vendor item with pack 3/12 LB linked to the catalog item so its known pack is set
  const seededVendorItem = {id:'vi-prov-3lb', vendor_id:'v-existing',
    description:'CHEESE PROVOLONE SLICING', pack_size:'3/12 LB', brand:null, gtin:null, manufacturer_code:null};
  const seededMapping = {id:'m-prov-3lb', catalog_item_id:'ci-provolone-3lb', vendor_item_id:'vi-prov-3lb',
    comparison_track:'exact', confidence_score:100};
  const workingCatalogItems = [seededItem];
  const workingCategories = [holdingCategory];
  const workingVendorItems = [seededVendorItem];
  const workingMappings = [seededMapping];
  const match = await catalogService.matchOrCreate({
    organizationId:'org-gate', vendorId:'v-gate',
    description:'CHEESE PROVOLONE SLICING', packSize:'1/12 LB',
    brand:null, gtin:null, manufacturerCode:null, categoryId:null,
    catalogItems:workingCatalogItems, categories:workingCategories,
    vendorItems:workingVendorItems, mappings:workingMappings,
  });
  // Different purchasing packs always produce separate catalog entries.
  // The 1/12 LB item must not reuse the 3/12 LB catalog entry.
  ok('cheese-provolone-pack: separate catalog item for different purchasing pack',
    match.catalogItemId !== 'ci-provolone-3lb',
    `catalogItemId=${match.catalogItemId} track=${match.track}`);
  t('cheese-provolone-pack: new track (separate entry, not reuse)', match.track, 'new');
  ok('cheese-provolone-pack: not promoted to exact (different items)',
    match.track !== 'exact',
    `track=${match.track} method=${match.method}`);
}

// TEST 25: SODA BIRCH WHITE DIET GLASS vs SODA BIRCH WHITE GLASS — review (diet)
{
  const {catalogService} = createInMemoryBackend();
  const {match, seededId} = await matchOrCreateAgainstSeeded(
    catalogService, 'SODA BIRCH WHITE GLASS', '4/6 BT', 'SODA BIRCH WHITE DIET GLASS', '4/6 BT');
  ok('soda-birch-diet: different catalog items or review with score 0',
    match.catalogItemId !== seededId || (match.track === 'review' && match.score === 0),
    `catalogItemId=${match.catalogItemId} seededId=${seededId} track=${match.track} score=${match.score}`);
  if(match.catalogItemId === seededId) {
    t('soda-birch-diet: review track only', match.track, 'review');
    t('soda-birch-diet: confidence_score 0', match.score, 0);
  }
}

// ── TEST 26: Mixed-batch independence — unresolved pack row does not hold back resolved row ─
// The production pipeline (no manually injected issues) must:
//   Row A: fully resolved (explicit sellingUnit, known pack) → saves, lands in Order Guide
//   Row B: ambiguous pack "6/10 CN" (no # prefix) → saves successfully, BUT pack blocker
//          fires in orderGuideAssessment via catalogRowEvidence (dimension:"unknown",
//          accuracy=DOUBTFUL) → stays in Item Catalog
//
// Mechanism for row B:
//   parsePackSize("6/10 CN") → parsed:true, dimension:"unknown", total:60
//   preparePriceImport with explicit sellingUnit:CS, priceBasis:case → requiresReview:false
//     (pricing resolves; only pack accuracy is in question)
//   importPriceRow calls applyQuote normally → price_unavailable:false, reviewRequired:false
//   catalogRowEvidence: pack.accuracy = DOUBTFUL (CN not a named can size, not a dimension)
//   orderGuideAssessment: pack blocker fires → ready:false → Item Catalog
//
// Both row orders tested: B then A, and A then B.
// Categories and peers derived from saved records in each pass.
// Ambiguous total:60 cannot be used in per-unit pricing (measure basis → null).
// Verified: row A remains ready; row B remains held; each is assessed independently.

async function runMixedBatch(label, importRowA_first) {
  const {provider, importService, catalogService} = createInMemoryBackend();
  // range_start and range_end are required by createItem (it must assign master_item_number
  // within the category's range). This is the real production field — not seeded artificially.
  const vegCategory = {id:'cat-veg', name:'Produce & Canned Goods', is_holding_pen:false, range_start:6000, range_end:6999, keywords:['tomatoes','canned','produce','vegetables','fruit']};

  // Seed categories into the backend store so they can be queried back from persisted records.
  // The working arrays are populated from these same records — not constructed inline.
  await provider.records.query('catalog_categories').insert(TEST_CATEGORY).select().single();
  await provider.records.query('catalog_categories').insert(vegCategory).select().single();

  const workingCatalogItems = [];
  const workingCategories = [TEST_CATEGORY, vegCategory];
  const workingVendorItems = [];
  const workingMappings = [];

  const rowA_source = {
    code: '49210',
    description: 'CHIC BRST RAW BNLS RNDM CVP',
    packSize: '4/10 LB',
    price: 2.06,
    sellingUnit: 'LB',
    sellingUnitSource: 'price header',
    priceBasis: 'measure',
  };
  const rowB_source = {
    code: '49211',
    description: 'TOMATOES CANNED WHOLE PEELED',
    packSize: '6/10 CN',
    price: 18.50,
    sellingUnit: 'CS',
    sellingUnitSource: 'price header',
    priceBasis: 'selling-unit',
  };

  const importRow = async (src, key) => importPriceRow({
    backend:provider, importService, catalogService,
    sourceRow:src, row:{...src}, ex:null, priorMapping:null,
    rowIssues:[], rowNeedsReview:false,   // production pipeline — no manual injection
    invoiceSources:[], orgId:TEST_ORG, vendorId:TEST_VENDOR,
    sourceDocumentId:'doc-26', completedKey:key, importBatchTime:'2026-10-07',
    group:GROUP, sourceFilePath:null,
    workingCatalogItems, workingCategories, workingVendorItems, workingMappings,
    applySelectedCategory:null,
  });

  const first  = importRowA_first ? rowA_source : rowB_source;
  const second = importRowA_first ? rowB_source : rowA_source;
  const result1 = await importRow(first,  'row:0');
  const result2 = await importRow(second, 'row:1');
  const resultA = importRowA_first ? result1 : result2;
  const resultB = importRowA_first ? result2 : result1;

  // ── Row A: production pipeline does not require review ──────────────────────
  t(`${label}: row A needsBasis=false`, resultA.needsBasis, false);
  ok(`${label}: row A vendorItemId returned`, !!resultA.vendorItemId);

  const viA = await importService.findVendorItem({organizationId:TEST_ORG, vendorId:TEST_VENDOR, code:rowA_source.code});
  const mapA = await importService.mapping(TEST_ORG, resultA.vendorItemId);
  const {data:ciA} = await provider.records.query('catalog_items').select().eq('id', mapA?.catalog_item_id).maybeSingle();
  t(`${label}: row A price_unavailable=false`, viA?.price_unavailable, false);
  t(`${label}: row A reviewRequired=false`, !!viA?.import_row?.reviewRequired, false);

  // Derive peers for row A from persisted item_mappings, not the in-memory working array.
  // Query the backend for all mappings linked to the same catalog item, excluding row A.
  const {data:allMapsA_db} = await provider.records.query('item_mappings').select().eq('catalog_item_id', mapA?.catalog_item_id);
  const peersA_mapIds = (allMapsA_db||[]).filter(m => m.vendor_item_id !== resultA.vendorItemId).map(m => m.vendor_item_id);
  const peersA = await Promise.all(peersA_mapIds.map(async vid => {
    const {data:vi} = await provider.records.query('vendor_items').select().eq('id', vid).maybeSingle();
    return vi;
  })).then(rs => rs.filter(Boolean));

  // Derive categories from persisted catalog_categories records.
  const {data:persistedCategories} = await provider.records.query('catalog_categories').select();

  // Derive the category for this row from what the matching service wrote to catalog_items.
  // Do not hardcode — read ciA.category_id and look it up from the persisted store.
  const categoryA = persistedCategories.find(c => c.id === ciA?.category_id) || null;
  // Diagnostic: confirm from saved records what the engine actually placed.
  console.log(`  [${label}] row A saved category_id=${ciA?.category_id} → name=${categoryA?.name||'(null)'} is_holding_pen=${categoryA?.is_holding_pen??'(null)'}`);
  ok(`${label}: row A catalog item has a category_id (matchOrCreate wrote it)`,
    !!ciA?.category_id, `ciA.category_id=${ciA?.category_id}`);

  const assessA = orderGuideAssessment({
    item:ciA, vendorItem:viA, mapping:mapA,
    vendor:{id:TEST_VENDOR, name:'Test Vendor'},
    category:categoryA, peers:peersA,
    categories:persistedCategories,
    settings:{}, now:new Date(),
  });
  ok(`${label}: row A no blockers`, assessA.blockers.length === 0,
    'blockers: '+JSON.stringify(assessA.blockers));
  t(`${label}: row A ready=true`, assessA.ready, true);

  // ── Row B: production pipeline — pack blocker fires via catalogRowEvidence ──
  // preparePriceImport returns requiresReview:false (price and unit resolve).
  // importPriceRow calls applyQuote normally → row B saves with no special flags.
  // catalogRowEvidence scores pack as DOUBTFUL (CN, dimension:"unknown", not #-prefixed).
  // orderGuideAssessment fires pack blocker → ready:false → Item Catalog.
  t(`${label}: row B needsBasis=false (pricing resolved, pack ambiguity is accuracy-level)`, resultB.needsBasis, false);
  ok(`${label}: row B vendorItemId returned (row saves successfully)`, !!resultB.vendorItemId);

  const viB = await importService.findVendorItem({organizationId:TEST_ORG, vendorId:TEST_VENDOR, code:rowB_source.code});
  const mapB = await importService.mapping(TEST_ORG, resultB.vendorItemId);
  const {data:ciB} = await provider.records.query('catalog_items').select().eq('id', mapB?.catalog_item_id).maybeSingle();
  t(`${label}: row B price_unavailable=false (row landed in DB)`, viB?.price_unavailable, false);

  // Derive peers for row B from persisted item_mappings.
  const {data:allMapsB_db} = await provider.records.query('item_mappings').select().eq('catalog_item_id', mapB?.catalog_item_id);
  const peersB_mapIds = (allMapsB_db||[]).filter(m => m.vendor_item_id !== resultB.vendorItemId).map(m => m.vendor_item_id);
  const peersB = await Promise.all(peersB_mapIds.map(async vid => {
    const {data:vi} = await provider.records.query('vendor_items').select().eq('id', vid).maybeSingle();
    return vi;
  })).then(rs => rs.filter(Boolean));

  // Derive the category for row B from the saved catalog item's category_id.
  const categoryB = persistedCategories.find(c => c.id === ciB?.category_id) || null;
  // Diagnostic: confirm from saved records what the engine placed for row B.
  console.log(`  [${label}] row B saved category_id=${ciB?.category_id} → name=${categoryB?.name||'(null)'} is_holding_pen=${categoryB?.is_holding_pen??'(null)'}`);
  ok(`${label}: row B catalog item has a category_id (matchOrCreate wrote it)`,
    !!ciB?.category_id, `ciB.category_id=${ciB?.category_id}`);
  ok(`${label}: row B category resolves to a persisted category`,
    !!categoryB, `category_id=${ciB?.category_id} not found in persistedCategories`);

  const assessB = orderGuideAssessment({
    item:ciB, vendorItem:viB, mapping:mapB,
    vendor:{id:TEST_VENDOR, name:'Test Vendor'},
    category:categoryB, peers:peersB,
    categories:persistedCategories,
    settings:{}, now:new Date(),
  });
  ok(`${label}: row B pack blocker present (dimension:unknown, not #-prefixed)`,
    assessB.blockers.includes('pack'),
    'blockers: '+JSON.stringify(assessB.blockers));
  t(`${label}: row B ready=false (held in Item Catalog)`, assessB.ready, false);

  // ── Ambiguous total:60 must not be used as confirmed quantity in any context ──
  // Case-basis: per-case price (18.50) is valid — no division by total required.
  // Measure-basis: any unit requires a known physical dimension; dimension:"unknown"
  //   means the inner quantity is a size code or container designator, not a weight
  //   or volume. casePriceFromQuote must return null for all measure-basis paths.
  // Ranking: comparePurchasingPack with dimension:"unknown" on both sides may not
  //   treat numeric coincidence as pack equivalence. Only same raw string → "same".
  //   A different expression with the same computed total → "review" (not "same").
  const {casePriceFromQuote:cpq, comparePurchasingPack:cpp, bestPurchasingMatch:bpm, bestPurchasingSuggestion:bps, quotePriceOnBasis:qpob} = await import('../procurement.js');

  // Per-case price is valid (basis:case never divides by total)
  const casePrice = cpq(18.50, 'case', 'CS', '6/10 CN');
  ok(`${label}: case-basis price valid (per-case, total not used)`,
    casePrice !== null && Number.isFinite(casePrice));

  // Measure basis with a dimensionless container unit must return null
  const perUnitPriceCN = cpq(18.50, 'measure', 'CN', '6/10 CN');
  t(`${label}: measure/CN returns null (dimension:unknown blocks total:60 as multiplier)`,
    perUnitPriceCN, null);

  // Measure basis with a physical unit but unknown-dimension pack also returns null
  const perUnitPriceLB = cpq(18.50, 'measure', 'LB', '6/10 CN');
  t(`${label}: measure/LB with unknown-dimension pack returns null`,
    perUnitPriceLB, null);

  // Pack equivalence: same raw string → "review" (matching notation does not confirm
  // an ambiguous pack's quantity or equivalence; CN is not a named-can unit)
  const cmpSelf = cpp('6/10 CN', '6/10 CN');
  t(`${label}: 6/10 CN vs 6/10 CN (same string, unknown-dimension) → review`, cmpSelf.status, 'review');

  // Pack equivalence: different expressions with numerically coincident totals → "review"
  const cmpSameTotal = cpp('6/10 CN', '60 CN');
  t(`${label}: 6/10 CN vs 60 CN (coincident total, different structure) → review`,
    cmpSameTotal.status, 'review');

  // Named can vs ambiguous: always "different" (different parse paths, different meaning)
  const cmpNamedCan = cpp('6/10 CN', '6/#10 CN');
  t(`${label}: 6/10 CN vs 6/#10 CN is different (ambiguous ≠ named can)`,
    cmpNamedCan.status, 'different');

  // Named can vs named can with same string: "same" (established meaning, round-trips safely)
  // The "#" prefix is the gate: it marks a named container identity with a settled meaning.
  const cmpNamedSame = cpp('6/#10 CN', '6/#10 CN');
  t(`${label}: 6/#10 CN vs 6/#10 CN → same (named cans are stable identifiers)`,
    cmpNamedSame.status, 'same');

  // ── Ranking-path safety: bestPurchasingMatch must not promote 6/10 CN to "exact" ──
  // A catalog item with an established named-can pack must not match as exact when the
  // incoming row carries an ambiguous "6/10 CN" pack. The pack comparison returns "review",
  // which blocks the exact track. If the product description also matches, the result
  // may still be "similar", but the pack status must not be "same".
  const catalogItemWithKnownPack = {
    id: 'ci-tomatoes-known',
    name: 'TOMATOES CANNED WHOLE PEELED',
    pack_size: '6/#10 CN',
    category_id: 'cat-veg',
    category_review: false,
    brand_locked: false,
    matching_behavior: null,
  };
  const rankResult = bpm('TOMATOES CANNED WHOLE PEELED', '6/10 CN', [catalogItemWithKnownPack]);
  // bestPurchasingMatch returns similar candidates even when pack is "different" — "exact"
  // requires both identity:"same" AND pack:"same". With pack:"different", the track is "similar".
  // Guard: the result must not be "exact".
  ok(`${label}: bestPurchasingMatch with 6/10 CN does not produce exact track`,
    !rankResult || rankResult.track !== 'exact',
    rankResult ? `track=${rankResult.track}` : 'no match');

  // bestPurchasingSuggestion is stricter: it requires pack.status==="same".
  // "6/10 CN" vs "6/#10 CN" is "different", so the catalog item must be filtered out entirely.
  // This is the ranking-path that must block the ambiguous pack from promoting a catalog match.
  const suggResult = bps('TOMATOES CANNED WHOLE PEELED', '6/10 CN', [catalogItemWithKnownPack]);
  t(`${label}: bestPurchasingSuggestion with 6/10 CN vs #10 pack → null (pack different blocks suggestion)`,
    suggResult, null);

  // Additional: bestPurchasingSuggestion with identical ambiguous pack also blocked.
  // Even same-string "6/10 CN" is now "review" — not "same" — so suggestions are not surfaced.
  const catalogItemWithAmbiguousPack = {...catalogItemWithKnownPack, id:'ci-tomatoes-amb', pack_size:'6/10 CN'};
  const suggResultSameAmb = bps('TOMATOES CANNED WHOLE PEELED', '6/10 CN', [catalogItemWithAmbiguousPack]);
  t(`${label}: bestPurchasingSuggestion with 6/10 CN vs 6/10 CN (both ambiguous) → null (pack review blocks suggestion)`,
    suggResultSameAmb, null);

  // ── Price-ranking consumer: quotePriceOnBasis with 6/10 CN ───────────────────
  // quotePriceOnBasis is called by ImportModal to produce a comparable quote for
  // variance calculation: variance = invoicedPrice - comparableQuote.
  // If comparableQuote is null, no variance is recorded — that is the safety valve.
  //
  // Read the actual saved price_basis and selling_unit from the DB — do not assume
  // what priceBasisFor('CS') returns. The test must verify what the service wrote.
  const savedBasis = viB?.price_basis || null;
  const savedSellingUnit = viB?.selling_unit || null;
  console.log(`  [${label}] row B saved price_basis=${savedBasis} selling_unit=${savedSellingUnit}`);
  // savedBasis should be 'case' (priceBasisFor('CS') → {basis:'case'}).
  // If the service wrote something else, the test documents it faithfully.

  // Case: invoice billed per the stored basis — comparable, no division by total required.
  const qpobCase = qpob(
    {price:viB?.price||18.50, basis:savedBasis, unit:savedSellingUnit, packSize:rowB_source.packSize},
    {basis:'case'}
  );
  ok(`${label}: quotePriceOnBasis — case-billed invoice gets a comparable quote`,
    qpobCase != null && Number.isFinite(qpobCase),
    `got ${qpobCase} (saved basis=${savedBasis})`);

  // Measure: invoice billed per CN — comparableQuote must be null (dimension:unknown)
  // This is the ranking safety guard: total:60 must not be used to produce a unit cost.
  const qpobCN = qpob(
    {price:viB?.price||18.50, basis:savedBasis, unit:savedSellingUnit, packSize:rowB_source.packSize},
    {basis:'measure', unit:'CN'}
  );
  t(`${label}: quotePriceOnBasis — CN-billed invoice → null (ambiguous total:60 not used as divisor)`,
    qpobCN, null);

  // Measure: invoice billed per LB — also null (pack has no weight dimension)
  const qpobLB = qpob(
    {price:viB?.price||18.50, basis:savedBasis, unit:savedSellingUnit, packSize:rowB_source.packSize},
    {basis:'measure', unit:'LB'}
  );
  t(`${label}: quotePriceOnBasis — LB-billed invoice with 6/10 CN pack → null (no weight dimension)`,
    qpobLB, null);

  // Confirm: with a proper named-can pack (6/#10 CN), the case price is also valid for case billing.
  // Named cans and ambiguous CN packs both return null on measure-basis comparison (dimension:unknown),
  // but both are valid for case-basis comparison.
  const qpobNamedCanCase = qpob(
    {price:18.50, basis:'case', unit:null, packSize:'6/#10 CN'},
    {basis:'case'}
  );
  ok(`${label}: quotePriceOnBasis — named-can 6/#10 CN, case billing → valid case price`,
    qpobNamedCanCase != null && Number.isFinite(qpobNamedCanCase),
    `got ${qpobNamedCanCase}`);

  // Named can, CN-billed: also null (dimension:unknown, no CN volume meaning)
  const qpobNamedCanCN = qpob(
    {price:18.50, basis:'case', unit:null, packSize:'6/#10 CN'},
    {basis:'measure', unit:'CN'}
  );
  t(`${label}: quotePriceOnBasis — named-can 6/#10 CN, CN-billed → null (dimension:unknown, no unit-cost derivable)`,
    qpobNamedCanCN, null);

  // ── Independence: re-read row A after row B assessment — unchanged ──────────
  // All reads come from the persisted backend, not from working arrays.
  // Category is derived from the saved catalog item's category_id — same as the first assessment.
  const viA2 = await importService.findVendorItem({organizationId:TEST_ORG, vendorId:TEST_VENDOR, code:rowA_source.code});
  const mapA2 = await importService.mapping(TEST_ORG, resultA.vendorItemId);
  const {data:ciA2} = await provider.records.query('catalog_items').select().eq('id', mapA2?.catalog_item_id).maybeSingle();
  const {data:allMapsA2_db} = await provider.records.query('item_mappings').select().eq('catalog_item_id', mapA2?.catalog_item_id);
  const peersA2_ids = (allMapsA2_db||[]).filter(m => m.vendor_item_id !== resultA.vendorItemId).map(m => m.vendor_item_id);
  const peersA2 = await Promise.all(peersA2_ids.map(async vid => {
    const {data:vi} = await provider.records.query('vendor_items').select().eq('id', vid).maybeSingle();
    return vi;
  })).then(rs => rs.filter(Boolean));
  const {data:persistedCats2} = await provider.records.query('catalog_categories').select();
  const categoryA2 = persistedCats2.find(c => c.id === ciA2?.category_id) || null;
  ok(`${label}: row A recheck — category_id still resolves to a persisted category`,
    !!categoryA2, `ciA2.category_id=${ciA2?.category_id}`);
  const assessA2 = orderGuideAssessment({
    item:ciA2, vendorItem:viA2, mapping:mapA2,
    vendor:{id:TEST_VENDOR, name:'Test Vendor'},
    category:categoryA2, peers:peersA2,
    categories:persistedCats2,
    settings:{}, now:new Date(),
  });
  ok(`${label}: row A still no blockers (independent of row B)`, assessA2.blockers.length === 0,
    'blockers: '+JSON.stringify(assessA2.blockers));
  t(`${label}: row A still ready=true (row B did not affect it)`, assessA2.ready, true);
}

// ── TEST 26a: resolved row first, then ambiguous pack row ─────────────────────
await runMixedBatch('26a (A-then-B)', true);

// ── TEST 26b: ambiguous pack row first, then resolved row ─────────────────────
await runMixedBatch('26b (B-then-A)', false);

// ── TEST 27: Holding-pen path — no matching category keywords → category blocker ──
// When a vendor description contains no words matching any category's keyword list,
// suggestCategory returns null, placeInCategory falls through to ensureHoldingCategory,
// and the saved catalog item gets a holding-pen category_id. The category blocker
// in orderGuideAssessment must fire. This test keeps the production gate intact
// and serves as a regression guard against keyword over-broadening.
{
  const {provider, importService, catalogService} = createInMemoryBackend();
  // Category with narrow keywords that will NOT match the description below.
  const narrowCategory = {id:'cat-narrow', name:'Narrow Test Category', is_holding_pen:false,
    range_start:7000, range_end:7999, keywords:['widget','gadget','gizmo']};
  await provider.records.query('catalog_categories').insert(narrowCategory).select().single();

  const workingCatalogItems = [];
  const workingCategories = [narrowCategory];
  const workingVendorItems = [];
  const workingMappings = [];

  // Description with no words from the narrow category keywords.
  const holdingRow = {
    code:'hld-001', description:'UNMATCHED MYSTERY PRODUCT XYZ',
    packSize:'4/10 LB', price:5.00,
    sellingUnit:'LB', sellingUnitSource:'price header', priceBasis:'measure',
  };
  const holdingResult = await importPriceRow({
    backend:provider, importService, catalogService,
    sourceRow:holdingRow, row:{...holdingRow}, ex:null, priorMapping:null,
    rowIssues:[], rowNeedsReview:false,
    invoiceSources:[], orgId:TEST_ORG, vendorId:TEST_VENDOR,
    sourceDocumentId:'doc-27', completedKey:'row:0', importBatchTime:'2026-10-07',
    group:GROUP, sourceFilePath:null,
    workingCatalogItems, workingCategories, workingVendorItems, workingMappings,
    applySelectedCategory:null,
  });
  ok('holding-pen: importPriceRow succeeded', !!holdingResult.vendorItemId);

  const viHld = await importService.findVendorItem({organizationId:TEST_ORG, vendorId:TEST_VENDOR, code:holdingRow.code});
  const mapHld = await importService.mapping(TEST_ORG, holdingResult.vendorItemId);
  const {data:ciHld} = await provider.records.query('catalog_items').select().eq('id', mapHld?.catalog_item_id).maybeSingle();

  const {data:persistedCatsHld} = await provider.records.query('catalog_categories').select();
  const categoryHld = persistedCatsHld.find(c => c.id === ciHld?.category_id) || null;
  console.log(`  [TEST 27] saved category_id=${ciHld?.category_id} → name=${categoryHld?.name||'(null)'} is_holding_pen=${categoryHld?.is_holding_pen??'(null)'}`);

  // The saved category must be the holding pen (is_holding_pen:true or category is null).
  ok('holding-pen: saved category_id resolves (ensureHoldingCategory wrote a record)',
    !!ciHld?.category_id, `ciHld.category_id=${ciHld?.category_id}`);
  ok('holding-pen: resolved category is holding pen (no keyword match → ensureHoldingCategory)',
    !categoryHld || categoryHld.is_holding_pen === true,
    `is_holding_pen=${categoryHld?.is_holding_pen}`);

  const assessHld = orderGuideAssessment({
    item:ciHld, vendorItem:viHld, mapping:mapHld,
    vendor:{id:TEST_VENDOR, name:'Test Vendor'},
    category:categoryHld, peers:[],
    categories:persistedCatsHld,
    settings:{}, now:new Date(),
  });
  ok('holding-pen: category blocker fires (is_holding_pen=true)',
    assessHld.blockers.includes('category'),
    'blockers: '+JSON.stringify(assessHld.blockers));
  t('holding-pen: not ready (category blocker)', assessHld.ready, false);
}

console.log('\n' + passed + ' passed, ' + failed + ' failed');
process.exit(failed ? 1 : 0);
