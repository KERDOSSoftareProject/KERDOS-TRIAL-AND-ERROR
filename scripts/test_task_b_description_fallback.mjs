// Task B acceptance. Run explicitly with:
//   node --test scripts/test_task_b_description_fallback.mjs
// Uses actual catalog and import paths with in-memory persistence. Task A alone
// does not satisfy the saved-label routing assertions.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createPriceImportFixture} from './fixtures/price-import-backend.mjs';
import {importPriceRow} from '../src/core/import-price-row.js';
import {createProcurementContext} from '../src/procurement.js';
import {createCatalogService} from '../src/services/catalog.js';
import {createImportService} from '../src/services/imports.js';

const organizationId = 'task-b-org';
const incumbentVendor = 'incumbent-vendor';
const incomingVendor = 'incoming-vendor';
const packSize = '4/10 LB';
const category = {id:'category', name:'Uncategorized', range_start:10000, is_holding_pen:true};
const comparisonMethods = ['compareProductIdentity', 'safeProductScore'];

function setup() {
  const state = createPriceImportFixture({text:''});
  const context = createProcurementContext({industry:'restaurant'});
  const comparisonCalls = [];
  const procurement = {...context};
  for (const method of comparisonMethods) {
    procurement[method] = (...args) => {
      comparisonCalls.push(method);
      return context[method](...args);
    };
  }
  return {
    ...state, context, comparisonCalls, procurement,
    catalogService:createCatalogService(state.backend, procurement),
    importService:createImportService(state.backend),
  };
}

function seed(state, {id, name, description, conceptKey = null}) {
  const item = {
    id, name, organization_id:organizationId, category_id:category.id,
    master_item_number:category.range_start + state.catalogItems.length,
    concept_key:conceptKey, concept_key_set_at:conceptKey ? '2026-11-13T12:00:00Z' : null,
  };
  const listing = {
    id:`listing-${id}`, vendor_id:incumbentVendor, organization_id:organizationId,
    description, pack_size:packSize,
  };
  const mapping = {id:`mapping-${id}`, vendor_item_id:listing.id, catalog_item_id:id, organization_id:organizationId};
  state.catalogItems.push(item);
  state.vendorItems.push(listing);
  state.mappings[listing.id] = mapping;
  return item;
}

function match(state, description) {
  return state.catalogService.matchOrCreate({
    organizationId, vendorId:incomingVendor, description, packSize,
    catalogItems:[...state.catalogItems], categories:[category],
    vendorItems:[...state.vendorItems], mappings:Object.values(state.mappings),
  });
}

test('description fallback runs only after the label lookup finds no item', async () => {
  const hit = setup();
  const description = 'AMERICAN CHEESE';
  const label = hit.context.readProductLabel({description});
  assert.equal(label.status, 'recognized');
  const saved = seed(hit, {id:'saved-label', name:'Deli Counter Cheese', description, conceptKey:label.key});
  seed(hit, {
    id:'wording-rival', name:description, description:'SLICED AMERICAN CHEESE',
    conceptKey:hit.context.readProductLabel({description:'SLICED AMERICAN CHEESE'}).key,
  });
  const hitResult = await match(hit, description);

  const miss = setup();
  const legacy = seed(miss, {id:'legacy-item', name:'FRESH GARLIC', description:'FRESH GARLIC'});
  const missResult = await match(miss, 'GARLIC');

  assert.equal(hitResult.catalogItemId, saved.id, 'a saved product label wins over competing wording');
  assert.deepEqual(hit.comparisonCalls, [], 'a saved-label hit skips description comparison');
  assert.deepEqual(hit.calls.createCatalog, []);
  assert.equal(missResult.catalogItemId, legacy.id, 'with no saved-label or exact name match, a clear wording match may link');
  assert.ok(miss.comparisonCalls.includes('compareProductIdentity'), 'a label miss reaches description comparison');
});

test('reimport keeps an already label-placed listing and skips description fallback', async () => {
  const state = setup();
  const description = 'AMERICAN CHEESE';
  const label = state.context.readProductLabel({description});
  const placed = seed(state, {id:'saved-label', name:'Deli Counter Cheese', description, conceptKey:label.key});
  seed(state, {id:'wording-rival', name:description, description});
  const code = 'CHEESE-1';
  const vendorItemId = await state.backend.pricing.applyQuote({
    organizationId, vendorId:incomingVendor, vendorItemCode:code, description, packSize,
    sellingUnit:'CASE', priceBasis:'CASE', price:20,
  });
  const existing = state.vendorItems.find(row => row.id === vendorItemId);
  assert.ok(existing);
  const mapping = {
    id:'existing-label-mapping', organization_id:organizationId, vendor_item_id:vendorItemId,
    catalog_item_id:placed.id, comparison_track:'exact', confidence_score:100, match_method:'rule_based',
  };
  state.mappings[vendorItemId] = mapping;
  const before = structuredClone(mapping);
  const row = {code, description, packSize, price:21, sellingUnit:'CASE'};
  let matchCalls = 0;
  const catalogService = {
    ...state.catalogService,
    matchOrCreate(args) {
      matchCalls++;
      return state.catalogService.matchOrCreate(args);
    },
  };

  const result = await importPriceRow({
    backend:state.backend, importService:state.importService, catalogService,
    row, sourceRow:row, ex:existing, priorMapping:null, rowIssues:[], rowNeedsReview:false, invoiceSources:[],
    orgId:organizationId, vendorId:incomingVendor, sourceDocumentId:'reimport', completedKey:code,
    importBatchTime:'2026-11-13T13:00:00Z', group:{name:'Updated prices'},
    workingCatalogItems:[...state.catalogItems], workingCategories:[category],
    workingVendorItems:[...state.vendorItems], workingMappings:Object.values(state.mappings),
  }, state.procurement);

  assert.equal(result.vendorItemId, vendorItemId);
  assert.equal(result.needsBasis, false);
  assert.equal(state.calls.applyQuote.length, 2, 'the reimport really saved a new quote for the existing listing');
  assert.equal(matchCalls, 0, 'a placed listing is never passed to matchOrCreate again');
  assert.equal(result.match, null);
  assert.deepEqual(await state.importService.mapping(organizationId, vendorItemId), before);
  assert.deepEqual(state.calls.createMapping, []);
  assert.deepEqual(state.calls.createCatalog, []);
});

test('description fallback never joins different cuts or forms recognized by the reader', async () => {
  const specimens = [
    ['DICED CELERY', 'CELERY'],
    ['GARLIC PEELED', 'GARLIC'],
    ['DRIED SAGE', 'SAGE'],
  ];
  const wrongLinks = [];
  for (const [incoming, incumbent] of specimens) {
    const state = setup();
    const incomingLabel = state.context.readProductLabel({description:incoming});
    const incumbentLabel = state.context.readProductLabel({description:incumbent});
    assert.equal(incomingLabel.status, 'recognized');
    assert.equal(incumbentLabel.status, 'recognized');
    assert.notEqual(incomingLabel.key, incumbentLabel.key);
    const saved = seed(state, {id:'saved-item', name:incumbent, description:incumbent, conceptKey:incumbentLabel.key});
    assert.equal(state.context.compareProductIdentity(incoming, incumbent).status, 'review',
      'fixture has a plausible legacy wording candidate');
    const result = await match(state, incoming);
    if (result?.catalogItemId === saved.id) wrongLinks.push(`${incoming} → ${incumbent}`);
  }
  assert.deepEqual(wrongLinks, [], 'wording must never link products with different cuts or forms, even for review');
});
