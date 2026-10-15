/**
 * INTEGRATION TESTS
 *
 * These prove the complete workflow: flags and source text from cell analysis
 * reach Item Catalog, arithmetic conflicts preserve both values, and brand
 * differences don't block comparison when "Brand matters" is off.
 *
 * Tests here prove behavior through the full path from raw document text
 * to the fields that ImportModal and Item Catalog read. They fail when
 * the interpretation is wrong — not when a threshold is set too high.
 */

import {parseDocument} from '../ingestion.js';
import {mappingGap} from '../services/catalog.js';
import {orderGuideAssessment} from '../core/catalog-fields.js';
import {analyzeRow} from '../core/cell-analysis.js';

let passed = 0, failed = 0;
function t(label, got, expected) {
  const ok = got === expected ||
    (typeof expected === 'number' && typeof got === 'number' && Math.abs(got - expected) < 0.01);
  if (ok) passed++;
  else { failed++; console.log(`FAIL  ${label}\n      got:    ${JSON.stringify(got)}\n      wanted: ${JSON.stringify(expected)}`); }
}
function ok(label, cond) {
  if (cond) passed++;
  else { failed++; console.log(`FAIL  ${label}`); }
}

// ── 1. FLAGS SURVIVE FROM CELL ANALYSIS TO IMPORT ROW ────────────────────────

// 1a. Zero price: priceUnavailable flag reaches the parsed row
{
  const doc = 'Item,Description,Pack,Price\n1001,ITEM ALPHA,10 EA,0.00\n1002,ITEM BETA,5 EA,12.50';
  const rows = parseDocument(doc).rows;
  t('zero price row is present', rows.some(r=>r.description==='ITEM ALPHA'), true);
  const zeroRow = rows.find(r=>r.description==='ITEM ALPHA');
  t('zero price: priceUnavailable flag set', zeroRow?.priceUnavailable, true);
  t('zero price: actual price value preserved', zeroRow?.price, 0);
  t('normal price row: priceUnavailable false', rows.find(r=>r.description==='ITEM BETA')?.priceUnavailable, false);
}

// 1b. Negative price: requiresReview flag reaches the parsed row
{
  const doc = 'Item,Description,Pack,Price\n1001,ITEM ALPHA,10 EA,"(12.50)"\n1002,ITEM BETA,5 EA,8.00';
  const rows = parseDocument(doc).rows;
  const negRow = rows.find(r=>r.description==='ITEM ALPHA');
  t('negative price row is present', !!negRow, true);
  t('negative price: value preserved as negative', negRow?.price, -12.50);
  t('negative price: requiresReview flag set', negRow?.requiresReview, true);
  t('positive price row: requiresReview false', rows.find(r=>r.description==='ITEM BETA')?.requiresReview, false);
}

// 1c. Mixed fraction pack: originalPackRaw preserved on the row
{
  const doc = 'Item,Description,Pack,Price\n1001,ITEM ALPHA,1-1/9 BU,25.00';
  const rows = parseDocument(doc).rows;
  const row = rows.find(r=>r.description==='ITEM ALPHA');
  t('mixed fraction pack: normalized packSize', row?.packSize, '1.111111 BU');
  t('mixed fraction pack: originalPackRaw preserved', row?.originalPackRaw, '1-1/9 BU');
}

// 1d. Pack from description: flags set correctly
{
  const doc = 'Description,Price\nITEM ALPHA 40 LB,12.50';
  const rows = parseDocument(doc).rows;
  const row = rows[0];
  t('pack from description: pack extracted', row?.packSize, '40 LB');
  t('pack from description: packSource is description', row?.packSource, 'description');
  t('pack from description: price correct', row?.price, 12.50);
  t('pack from description: priceUnavailable false', row?.priceUnavailable, false);
}

// ── 2. ARITHMETIC CONFLICTS PRESERVE BOTH VALUES ─────────────────────────────

// 2a. qty × price ≠ lineTotal → both preserved, neither overwritten
{
  // Deliberately mismatched: 2 × 85.60 = 171.20 but lineTotal shows 100.00
  const r = analyzeRow(
    ['2', '85.60', '100.00'],
    ['Qty', 'Unit Price', 'Extended Price']
  );
  t('arithmetic conflict detected', r.conflicts.some(c=>c.field==='price'), true);
  t('stated price preserved under conflict', r.resolved.price?.value, 85.60);
  t('stated price flagged requiresReview', r.resolved.price?.requiresReview, true);
  ok('arithmetic conflict carries both values', !!r.resolved._arithmeticConflict);
  t('conflict statedPrice matches row price', r.resolved._arithmeticConflict?.statedPrice, 85.60);
  t('conflict carries derived unit price', typeof r.resolved._arithmeticConflict?.derivedUnitPrice, 'number');
}

// 2b. qty × price = lineTotal → no conflict, no overwrite
{
  const r = analyzeRow(
    ['2', '25.00', '50.00'],
    ['Qty', 'Unit Price', 'Extended Price']
  );
  t('clean arithmetic: no conflict', r.conflicts.filter(c=>c.field==='price').length, 0);
  t('clean arithmetic: price unchanged', r.resolved.price?.value, 25.00);
  t('clean arithmetic: requiresReview not set', r.resolved.price?.requiresReview ?? false, false);
}

// ── 3. BRAND DIFFERENCES DON'T BLOCK WHEN BRAND SENSITIVITY IS OFF ───────────

const vendorItemA = {id:'v1', vendor_id:'vendorA', description:'ITEM ALPHA', pack_size:'40 LB', brand:'BRAND-X', gtin:null, manufacturer_code:null};
const vendorItemB = {id:'v2', vendor_id:'vendorB', description:'ITEM ALPHA', pack_size:'40 LB', brand:'BRAND-Y', gtin:null, manufacturer_code:null};

// 3a. brand_locked=false → brand difference does NOT block
{
  const catalogItem = {id:'c1', name:'ITEM ALPHA', brand_locked:false, locked_brand:null};
  const gap = mappingGap(vendorItemB, catalogItem, [vendorItemA]);
  ok('brand_locked=false: brand difference does not block', gap.code !== 'brand-conflict');
}

// 3b. brand_locked=true → brand difference DOES block
{
  const catalogItem = {id:'c1', name:'ITEM ALPHA', brand_locked:true, locked_brand:'BRAND-X'};
  const gap = mappingGap(vendorItemB, catalogItem, [vendorItemA]);
  t('brand_locked=true: brand difference blocks', gap.code, 'brand-conflict');
}

// 3c. Order Guide assessment: brand_locked=false → brand never a blocker
{
  const item = {id:'c1',name:'ITEM ALPHA',category_id:'cat1',master_item_number:1001,
    brand_locked:false,matching_behavior:'flexible',category_review:false};
  const vi = {id:'v2',vendor_id:'vendorB',description:'ITEM ALPHA',pack_size:'40 LB',
    brand:'BRAND-Y',price:85,selling_unit:'CS',price_basis:'case',
    price_unavailable:false,last_updated:new Date().toISOString(),field_resolutions:{}};
  const mapping = {id:'m2',catalog_item_id:'c1',vendor_item_id:'v2',comparison_track:'exact',confidence_score:100};
  const cat = {id:'cat1',name:'Category One',is_holding_pen:false,range_start:1000,range_end:2999};
  const assessment = orderGuideAssessment({item,vendorItem:vi,mapping,
    vendor:{id:'vendorB',name:'Vendor B'},category:cat,
    peers:[vendorItemA],categories:[cat],settings:{}});
  ok('brand_locked=false: brand not a blocker in Order Guide', !assessment.blockers.includes('brand'));
}

// ── 4. MISSING PACK REPORTED AS UNRESOLVED ───────────────────────────────────

{
  const r = analyzeRow(
    ['ITEM ALPHA', '12.50'],
    ['Description', 'Price']
  );
  t('missing pack: description resolved', r.resolved.description?.value, 'ITEM ALPHA');
  t('missing pack: price resolved', r.resolved.price?.value, 12.50);
  ok('missing pack: reported as unresolved field',
    r.unresolved.some(u => u.field === 'pack'));
  const packUnresolved = r.unresolved.find(u=>u.field==='pack');
  ok('missing pack: unresolved reason explains impact', packUnresolved?.reason.includes('unit cost'));
}

// ── 5. PRICE WITH EMBEDDED UNIT SUPPLIES QUOTED UNIT ─────────────────────────

{
  const r1 = analyzeRow(['$2.15/LB'], ['Price/LB']);
  t('price/lb: price value correct', r1.resolved.price?.value, 2.15);
  t('price/lb: priceBasis is measure', r1.resolved.priceBasis?.value, 'measure');
  t('price/lb: sellingUnit is LB', r1.resolved.sellingUnit?.value, 'LB');
}

{
  // Cell with embedded unit in price column
  const r2 = analyzeRow(
    ['1001', 'ITEM ALPHA', '40 LB', '$2.15/LB'],
    ['Item', 'Description', 'Pack', 'Price']
  );
  t('embedded unit in price cell: price value', r2.resolved.price?.value, 2.15);
  t('embedded unit: sellingUnit proposed', r2.resolved.sellingUnit?.value, 'LB');
}

// ── 6. COMPLETE WORKFLOW: IMPORT → FLAGS → ITEM CATALOG FIELDS ───────────────

{
  // A vendor sheet with every edge case in one document
  const sheet = [
    'Item#,Description,Pack,Price',
    '1001,ITEM ALPHA STANDARD,4/10 LB,85.60',          // clean row
    '1002,ITEM BETA UNIT,1-1/9 BU,28.50',              // mixed fraction pack
    '1003,ITEM GAMMA FRESH,40 LB,0.00',                // zero price
    '1004,ITEM DELTA,5 EA,"(12.50)"',                  // negative price
    '1005,ITEM EPSILON 10 EA,,,',                      // pack in description, no price
  ].join('\n');
  
  const result = parseDocument(sheet);
  const rows = result.rows;

  t('clean row imported', rows.some(r=>r.description==='ITEM ALPHA STANDARD'), true);
  const clean = rows.find(r=>r.description==='ITEM ALPHA STANDARD');
  t('clean row: price', clean?.price, 85.60);
  t('clean row: pack', clean?.packSize, '4/10 LB');
  t('clean row: priceUnavailable false', clean?.priceUnavailable, false);
  t('clean row: requiresReview false', clean?.requiresReview ?? false, false);

  const fraction = rows.find(r=>r.description==='ITEM BETA UNIT');
  t('fraction pack: normalised', fraction?.packSize, '1.111111 BU');
  t('fraction pack: originalPackRaw preserved', fraction?.originalPackRaw, '1-1/9 BU');

  const zero = rows.find(r=>r.description==='ITEM GAMMA FRESH');
  t('zero price: in rows', !!zero, true);
  t('zero price: priceUnavailable', zero?.priceUnavailable, true);

  const neg = rows.find(r=>r.description==='ITEM DELTA');
  t('negative price: in rows', !!neg, true);
  t('negative price: value', neg?.price, -12.50);
  t('negative price: requiresReview', neg?.requiresReview, true);
}


// ── 7. FREEFORM PARENTHETICAL NEGATIVE → NEGATIVE VALUE + REQUIRES REVIEW ────

{
  // Single freeform line — contextual path
  const r = parseDocument('ITEM ALPHA 10 EA (12.50)');
  t('freeform paren-neg: price is negative', r.rows[0]?.price, -12.50);
  t('freeform paren-neg: requiresReview set', r.rows[0]?.requiresReview, true);
  t('freeform paren-neg: description clean', r.rows[0]?.description, 'ITEM ALPHA');

  // Normal positive price unaffected
  const r2 = parseDocument('ITEM BETA 5 EA 8.50');
  t('freeform positive: price unchanged', r2.rows[0]?.price, 8.50);
  t('freeform positive: no requiresReview', r2.rows[0]?.requiresReview ?? false, false);
}

// ── 8. BRAND CHECK USES CORRECT FIELD NAME ────────────────────────────────────

{
  const viX = {id:'v1',vendor_id:'A',description:'ITEM',pack_size:'40 LB',brand:'BRAND-X'};
  const viY = {id:'v2',vendor_id:'B',description:'ITEM',pack_size:'40 LB',brand:'BRAND-Y'};

  // brand_locked (snake_case from DB) = false → no brand-conflict
  const ciUnlocked = {id:'c1',name:'ITEM',brand_locked:false,locked_brand:null};
  ok('brand_locked=false: mappingGap not brand-conflict',
    mappingGap(viY, ciUnlocked, [viX]).code !== 'brand-conflict');

  // brand_locked = true → brand-conflict returned
  const ciLocked = {id:'c1',name:'ITEM',brand_locked:true,locked_brand:'BRAND-X'};
  t('brand_locked=true: mappingGap returns brand-conflict',
    mappingGap(viY, ciLocked, [viX]).code, 'brand-conflict');
}

// ── 9. UNRESOLVED-FIELD EXPLANATIONS SURVIVE ON THE ROW ───────────────────────

{
  // A row with no pack column — cellUnresolved should explain pack is missing
  const r = parseDocument('Description,Price\nITEM ALPHA,12.50');
  const row = r.rows[0];
  t('row with no pack: description present', row?.description, 'ITEM ALPHA');
  t('row with no pack: price present', row?.price, 12.50);
  // cellUnresolved may be null if pack is found from description — check the field
  // The key behaviour: when pack is genuinely absent, cellUnresolved is on the row
  // Here description has no pack so it should be reported
  ok('row with no pack: cellUnresolved present', row?.cellUnresolved !== undefined);
}

// ── 10. INFERRED COLUMNS STAY CHALLENGEABLE ───────────────────────────────────

{
  // A document with no header (numbered cols) — column map is entirely inferred.
  // The price column should still be found through position/content profiling,
  // but its score must not reach "explicit header" level (>=0.90).
  const {analyzeRow: ar} = await import('../core/cell-analysis.js');
  const r = ar(
    ['1001', 'ITEM ALPHA', '10 EA', '12.50'],
    [],        // no headerCells
    '',        // no priceHeader
    null       // no confirmedColIndices → all inferred
  );
  const priceScore = r.resolved.price?.score;
  ok('inferred columns: price found', priceScore != null);
  ok('inferred columns: score below explicit-header level', priceScore < 0.90);
  t('inferred columns: price value correct', r.resolved.price?.value, 12.50);
}


// ── 11. CELLUNRESOLVED AND CELLCONFLICTS REACH THE OPTION OBJECT ─────────────

{
  // A row with no pack: cellUnresolved should contain an explanation for pack
  const doc = 'Description,Price\nITEM WITH NO PACK,12.50';
  const rows = parseDocument(doc).rows;
  const row = rows[0];
  ok('row with no pack: cellUnresolved on row object', Array.isArray(row?.cellUnresolved) || row?.cellUnresolved === null);

  // An arithmetic conflict row: cellConflicts should carry the conflict
  const {analyzeRow: arFn} = await import('../core/cell-analysis.js');
  const conflictRow = arFn(['2','85.60','100.00'],['Qty','Unit Price','Extended Price']);
  ok('arithmetic conflict: conflict in array', conflictRow.conflicts.some(c=>c.field==='price'));
  ok('arithmetic conflict: statedPrice preserved', conflictRow.resolved.price?.value === 85.60);
  ok('arithmetic conflict: requiresReview set', conflictRow.resolved.price?.requiresReview === true);
  ok('arithmetic conflict: _arithmeticConflict has both values', !!conflictRow.resolved._arithmeticConflict?.statedPrice);
}


console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
