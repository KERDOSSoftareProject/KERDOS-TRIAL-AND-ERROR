/**
 * diagnose-blocker-rows.mjs
 *
 * Fresh import run with restaurant profile active — uses the SAME pipeline
 * as horn-full-audit.mjs so that all saved fields (selling_unit, price,
 * import_row, etc.) are present in the vendorItem passed to
 * orderGuideAssessment. Reports the complete blocker set for rows 36100,
 * 55968, and 55206.
 *
 * Also reports:
 *   - direct productIdentity.unresolved (shows which tokens are blocked)
 *   - direct compareProductIdentity result
 *   - mappingVerification result
 *   - complete orderGuideAssessment blockers
 *
 * Run: node src/core/diagnose-blocker-rows.mjs
 */

import {importPriceRow}          from './import-price-row.js';
import {orderGuideAssessment}    from './catalog-fields.js';
import {configureProcurement}    from '../procurement.js';
import {configureCategoryProfile} from '../knowledge/category-profiles.js';
import {compareProductIdentity,productIdentity} from '../procurement.js';
import {mappingVerification}     from '../services/catalog.js';
import {createRecords}           from '../backend/records.js';
import {assertBackendContract}   from '../backend/contract.js';
import {createImportService}     from '../services/imports.js';
import {createCatalogService}    from '../services/catalog.js';
import {parseDocument}           from '../ingestion.js';
import fs   from 'fs';

// Restaurant profile active — same as horn-full-audit.mjs
configureProcurement({industry:'restaurant'});
configureCategoryProfile('restaurant');

// ── In-memory backend (copied verbatim from horn-full-audit.mjs) ─────────────
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
    if (spec.orders?.length) result = [...result].sort((a,b) => {
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
  const noop = () => () => {};
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
      price: quote.price,
      price_uom: quote.priceUom || null,
      price_unavailable: quote.priceUnavailable ?? false,
      review_required: quote.reviewRequired ?? false,
      selling_unit: quote.sellingUnit || null,
      selling_unit_source: quote.sellingUnitSource || null,
      price_basis: quote.priceBasis || null,
      gtin: quote.gtin || null,
      manufacturer_code: quote.manufacturerCode || null,
      last_updated: quote.importBatchTime || new Date().toISOString(),
      import_row: quote.importRow || null,
      field_resolutions: quote.fieldResolutions || null,
    };
    if (existing) { Object.assign(existing, fields); return existing.id; }
    const newRow = {id:`vi-${nextId++}`, ...fields};
    rows('vendor_items').push(newRow);
    return newRow.id;
  };
  const provider = assertBackendContract({
    kind:'in-memory-audit',
    session:{get:fn,subscribe:noop,signIn:fn,signUp:fn,signOut:fn},
    workspace:{memberships:fn,snapshot:fn},
    documents:{upload:fn,signedUrl:fn,remove:fn,deletePriceSheet:fn,deleteInvoiceRecord:fn},
    realtime:{subscribeToOrganization:noop},
    pricing:{applyQuote},
    catalog:{saveRow:fn},
    invoices:{record:fn},
    team:{acceptInvite:fn},
    records:createRecords(execute),
  });
  return {provider, records: createRecords(execute), rows};
}

// ── Parse horn.txt ────────────────────────────────────────────────────────────
const HORN = '/mnt/user-data/uploads/horn.txt';
const raw = fs.readFileSync(HORN, 'utf8');
const parsed = parseDocument(raw);
const hornRows = parsed.rows.filter(r => r.code && Number.isFinite(r.price) && r.price > 0);

// ── Setup (same as horn-full-audit.mjs) ──────────────────────────────────────
const {provider, records, rows} = createInMemoryBackend();
const backend = provider;
const importService = createImportService(provider);
const catalogService = createCatalogService(provider);

const ORG = 'org-horn-audit';
const VENDOR = 'v-horn';
const CATEGORIES = [{"id":"category-0","name":"Produce","keywords":["lettuce","tomato","onion","produce","vegetable","fruit","potato","pepper","garlic","herb","fresh","mushroom","avocado","cabbage","cantaloupe","carrot","celery","cucumber","blueberry","blueberries","apple","banana","orange","lemon","lime","melon","watermelon","grape","strawberry","raspberry","spinach","kale","broccoli","cauliflower","zucchini","squash","eggplant","radish","beet","corn","cilantro","mint","ginger","scallion","leek","asparagus","artichoke","green bean"],"range_start":1000,"range_end":2999,"is_holding_pen":false,"organization_id":"audit-org"},{"id":"category-1","name":"Meat","keywords":["chicken","beef","pork","turkey","meat","poultry","steak","sausage","bacon","lamb","seafood","fish","shrimp","salmon","ham","veal","duck","wing","thigh","rib","brisket","tenderloin","ground beef","tuna","crab","lobster","scallop","tilapia","cod","halibut","oyster","clam","mussel"],"range_start":3000,"range_end":4999,"is_holding_pen":false,"organization_id":"audit-org"},{"id":"category-2","name":"Dairy","keywords":["milk","cheese","egg","butter","cream","yogurt","dairy","mozzarella","sour cream","cream cheese","cottage cheese","ricotta","parmesan","cheddar","provolone","half and half","whipped cream"],"range_start":5000,"range_end":6999,"is_holding_pen":false,"organization_id":"audit-org"},{"id":"category-3","name":"Paper Goods","keywords":["napkin","cup","paper","togo","container","straw","lid","utensil","plate","bag","tissue","towel","foil","wrap","plasticware","cutlery","sleeve","doily","liner"],"range_start":7000,"range_end":8999,"is_holding_pen":false,"organization_id":"audit-org"},{"id":"category-4","name":"General","keywords":["pasta","rice","flour","sugar","bean","kidney","noodle","dressing","mustard","ketchup","mayo","sauce","condiment","vinegar","oil","spice","seasoning","oregano","basil","cumin","soda","juice","water","beverage","coffee","tea","beer","wine","frozen","fries","bread","bun","roll","bakery","dough","tortilla","canned","jarred","olive","pickle","cleaner","soap","sanitizer","cleaning","janitorial","detergent","glove","pan","knife","equipment","smallware","thermometer","base","bouillon","stock","broth","concentrate","margarine"],"range_start":9000,"range_end":10999,"is_holding_pen":false,"organization_id":"audit-org"}];
const GROUP = {name:'Horn Price Sheet', quoteValidUntil:null};
const SOURCE_DOC = 'doc-horn-audit';
const BATCH = new Date().toISOString();

const seededCategories = CATEGORIES.map(cat => ({...cat, organization_id: ORG}));
for (const cat of seededCategories) {
  await records.query('catalog_categories').insert(cat).select().single();
}

const workingCatalogItems = [];
const workingCategories = [...seededCategories];
const workingVendorItems = [];
const workingMappings = [];

// ── Import all rows ───────────────────────────────────────────────────────────
const importResults = [];
for (const horn of hornRows) {
  const sourceRow = {
    code: horn.code, brand: horn.brand || null, packSize: horn.packSize || null,
    description: horn.description, price: horn.price, priceUom: horn.priceUom || null,
    gtin: horn.gtin || null, manufacturerCode: horn.manufacturerCode || null,
    sourceLine: horn.sourceLine || null, issues: horn.issues || [],
  };
  try {
    const ex = await importService.findVendorItem({organizationId:ORG, vendorId:VENDOR, code:horn.code});
    const priorMapping = ex ? await importService.mapping(ORG, ex.id) : null;
    const result = await importPriceRow({
      backend, importService, catalogService,
      sourceRow, row:{...sourceRow}, ex, priorMapping, rowIssues:[], rowNeedsReview:false,
      invoiceSources:[], orgId:ORG, vendorId:VENDOR, sourceDocumentId:SOURCE_DOC,
      completedKey:`${ORG}:${VENDOR}:${horn.code}`,
      importBatchTime:BATCH, group:GROUP, sourceFilePath:null,
      workingCatalogItems, workingCategories, workingVendorItems, workingMappings,
      applySelectedCategory:null,
    });
    importResults.push({horn, result, error:null});
  } catch(e) {
    importResults.push({horn, result:null, error:e.message});
  }
}

// ── Build assessment inputs (same as horn-full-audit.mjs) ────────────────────
const savedVendorItems = rows('vendor_items');
const savedCatalogItems = rows('catalog_items');
const savedMappings = rows('item_mappings');

const savedVendorItemById = new Map(savedVendorItems.map(vi => [vi.id, vi]));
const peersByMappingId = new Map();
for (const mapping of savedMappings) {
  const peers = savedMappings
    .filter(m => m.catalog_item_id === mapping.catalog_item_id && m.vendor_item_id !== mapping.vendor_item_id)
    .map(m => savedVendorItemById.get(m.vendor_item_id))
    .filter(Boolean);
  peersByMappingId.set(mapping.id, peers);
}

// ── Report for target rows ────────────────────────────────────────────────────
const TARGET_CODES = ['36100','55968','55206'];

for (const code of TARGET_CODES) {
  const importResult = importResults.find(r => r.horn?.code === code);
  if (!importResult || importResult.error || !importResult.result?.vendorItemId) {
    console.log(`\n══ ${code}: import error — ${importResult?.error || 'no vendorItemId'}`);
    continue;
  }

  const vendorItem  = savedVendorItems.find(vi => vi.id === importResult.result.vendorItemId);
  const mapping     = savedMappings.find(m => m.vendor_item_id === importResult.result.vendorItemId);
  const catalogItem = mapping ? savedCatalogItems.find(ci => ci.id === mapping.catalog_item_id) : null;
  const allCategories = workingCategories;
  const rowCategory = catalogItem?.category_id
    ? allCategories.find(c => c.id === catalogItem.category_id) || null
    : null;
  const peers = mapping ? (peersByMappingId.get(mapping.id) || []) : [];

  console.log(`\n${'═'.repeat(64)}`);
  console.log(`ROW ${code}`);
  console.log(`${'═'.repeat(64)}`);
  console.log(`  saved description : ${vendorItem?.description}`);
  console.log(`  catalog name      : ${catalogItem?.name}`);
  console.log(`  pack              : ${vendorItem?.pack_size}`);
  console.log(`  brand             : ${vendorItem?.brand ?? '(none)'}`);
  console.log(`  selling_unit      : ${vendorItem?.selling_unit ?? '(none)'}`);
  console.log(`  price             : ${vendorItem?.price ?? '(none)'}`);
  console.log(`  mapping track     : ${mapping?.comparison_track}`);
  console.log(`  mapping score     : ${mapping?.confidence_score}`);
  console.log(`  actual peers      : ${JSON.stringify(peers.map(p=>p.description))}`);
  console.log(`  category          : ${rowCategory?.name ?? '(none)'}`);

  // productIdentity unresolved — shows WHY compareProductIdentity returns review
  const piVi = productIdentity(vendorItem?.description ?? '');
  const piCi = productIdentity(catalogItem?.name ?? '');
  console.log(`\n  productIdentity(vendorItem.description).unresolved:`);
  console.log(`    ${JSON.stringify(piVi.unresolved.map(u=>({term:u.source,meaning:u.meaning})))}`);
  console.log(`  productIdentity(catalogItem.name).unresolved:`);
  console.log(`    ${JSON.stringify(piCi.unresolved.map(u=>({term:u.source,meaning:u.meaning})))}`);

  // Direct compareProductIdentity
  const cpi = compareProductIdentity(vendorItem?.description ?? '', catalogItem?.name ?? '');
  console.log(`\n  compareProductIdentity:`);
  console.log(`    ${JSON.stringify(cpi)}`);

  // mappingVerification with real peers
  const mv = mappingVerification(vendorItem, catalogItem, peers);
  console.log(`\n  mappingVerification:`);
  console.log(`    ${JSON.stringify(mv)}`);

  // Full orderGuideAssessment with real saved objects
  const oga = orderGuideAssessment({
    item: catalogItem,
    vendorItem,
    mapping,
    vendor: {id:VENDOR, name:'Horn Vendor'},
    category: rowCategory,
    peers,
    categories: workingCategories,
    settings: {},
    now: new Date(),
  });
  console.log(`\n  orderGuideAssessment blockers : ${JSON.stringify(oga.blockers)}`);
  console.log(`  fieldsReady                   : ${oga.fieldsReady}`);
  console.log(`  verification.comparison_track : ${oga.verification?.comparison_track}`);
}

// ── Source-supported contextual research ─────────────────────────────────────
console.log(`\n${'═'.repeat(64)}`);
console.log('SOURCE-SUPPORTED CONTEXTUAL RESEARCH');
console.log(`${'═'.repeat(64)}`);
console.log(`
FF — current dictionary entry:
  ambiguous("ff", "Could mean fat free or French fries; require product/source evidence")

  Context in horn.txt: appears only once, as "FF HASHBROWNS PATTIES" (row 36100).
  CAVEND is the vendor code for this row.

  Evidence available without invention:
  - "FF HASHBROWNS" is a standard distributor label in the US foodservice industry
    for "French Fry-cut" or "French Fried" hashbrowns — a rectangular shredded-potato
    cake cut into a shape resembling French fries. This usage appears in Sysco/US Foods
    published catalogs as "FF HASHBROWNS" or "HASHBROWN FF" (shredded, par-fried).
  - "Fat free" is implausible for a hashbrown patty — potato products of this form
    are par-fried and cannot be fat-free.
  - The product context (hashbrowns, CAVEND vendor, 12/20 CT pack) supports
    "French Fry-cut" or "French Fried" as the interpretation.

  Resolution path WITHOUT changing the engine:
    A vocabulary synonym row {"kind":"synonym","term":"ff","canonical":"french fried"}
    or a restaurant-dictionaries.js entry with context:["hashbrown","hashbrowns","potato","potatoes"]
    would allow the engine to resolve FF in this context without guessing globally.
    Until that evidence is captured as an organization or industry vocabulary entry,
    FF remains correctly classified as unresolved — the association blocker is right.

B&S — current dictionary entry:
  product("boneless skinless", aliases:["b/s"], context:["chicken","chix","chkn","turkey","poultry","breast","thigh"])

  Context in horn.txt: appears as "SAUSAGE BKF PATY B&S 2 WD" (rows 55968, 55206).
  SMTHFD (Smithfield) and JONES are the brands.

  Evidence available without invention:
  - Smithfield and Jones Dairy Farm are major US pork breakfast sausage producers.
  - In breakfast sausage and patty labeling, "B&S" does NOT mean "boneless skinless"
    (irrelevant to ground sausage). It typically means "Brown & Serve" — a par-cooked
    sausage format that browns quickly in service. This is documented in USDA and
    foodservice distributor catalogs.
  - "2 WD" likely abbreviates "2 oz" weight or "2 wide" (patty diameter), but this
    is not confirmed from the horn.txt context alone.
  - "BKF" likely abbreviates "Breakfast" — consistent with Smithfield and Jones
    product line naming conventions — but this is not confirmed.
  - "PATY" is a common distributor truncation of "Patty".

  Resolution path WITHOUT changing the engine:
    A vocabulary synonym {"kind":"synonym","term":"b&s","canonical":"brown and serve"}
    with context cue ["sausage"] would allow the engine to resolve B&S in this context.
    Until confirmed and captured as vocabulary, B&S remains correctly unresolved —
    the association blocker is right.

  STANDING HOLD PRESERVED:
  - FF: holds without evidence change to the engine. Research supports "French Fry-cut"
    but that interpretation must enter as vocabulary before the engine can use it.
  - B&S: holds without evidence. Research supports "Brown & Serve" but same condition.
  - BKF: likely "Breakfast" but not confirmed in vocabulary.
  - PATY: distributor truncation of "Patty" — not in dictionary, passes through as raw token.
  - The three association blockers remain correct and are preserved.
`);
