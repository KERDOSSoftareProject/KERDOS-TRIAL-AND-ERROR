/**
 * CELL ANALYSIS TESTS
 *
 * Each test represents a real cell from a real vendor file, or a class of
 * ugly input that the engine must interpret correctly.
 *
 * Test structure:
 *   - raw cell value
 *   - context (header hint if any, neighboring cells)
 *   - expected: which KERDOS field should win, and at what minimum score
 *   - expected NOT: fields this cell must NOT claim as its primary interpretation
 */

import {analyzeCell, analyzeRow} from './cell-analysis.js';

let passed = 0, failed = 0;
function t(label, got, expected) {
  const ok = got === expected || (typeof expected === 'number' && typeof got === 'number' && Math.abs(got - expected) < 0.01);
  if (ok) passed++;
  else { failed++; console.log(`FAIL ${label}\n     got: ${JSON.stringify(got)}\n  wanted: ${JSON.stringify(expected)}`); }
}
function tAbove(label, got, min) {
  const ok = typeof got === 'number' && got >= min;
  if (ok) passed++;
  else { failed++; console.log(`FAIL ${label}: score ${got} < minimum ${min}`); }
}
function tField(label, interpretations, field, minScore = 0.5) {
  const hit = interpretations.find(i => i.field === field);
  if (hit && hit.score >= minScore) { passed++; }
  else {
    failed++;
    const found = interpretations.map(i => `${i.field}(${i.score.toFixed(2)})`).join(', ');
    console.log(`FAIL ${label}: expected field="${field}" score>=${minScore}, got [${found}]`);
  }
}
function tNoField(label, interpretations, field) {
  const hit = interpretations.find(i => i.field === field && i.score >= 0.7);
  if (!hit) passed++;
  else { failed++; console.log(`FAIL ${label}: field "${field}" should not be primary (score ${hit.score})`); }
}
function tWinner(label, interpretations, field) {
  const winner = interpretations[0];
  if (winner?.field === field) passed++;
  else { failed++; console.log(`FAIL ${label}: winner is "${winner?.field}" not "${field}"`); }
}

// ══════════════════════════════════════════════════════════════════════════════
// PRICE CELLS
// ══════════════════════════════════════════════════════════════════════════════

// Clean price with explicit header
const p1 = analyzeCell('85.60', {headerHint: 'Unit Price', position: 'col4'});
tWinner('explicit price header wins', p1, 'price');
tAbove('explicit price header score', p1.find(i=>i.field==='price')?.score, 0.90);

// Your price beats list price (tested via analyzeRow)
const priceRow = analyzeRow(
  ['1001', 'ITEM ALPHA', '10 EA', '15.00', '12.50'],
  ['Item', 'Description', 'Pack', 'List Price', 'Your Price']
);
t('your price beats list price', priceRow.resolved.price?.value, 12.50);
t('your price strategy', priceRow.resolved.price?.strategy, 'explicit-your-price');

// Dollar sign
const p2 = analyzeCell('$12.50', {headerHint: 'Price'});
tWinner('dollar sign price', p2, 'price');
t('dollar sign value', p2.find(i=>i.field==='price')?.value, 12.50);

// European decimal comma with semicolon context
const p3 = analyzeCell('12,50', {headerHint: 'Price'});
tWinner('european decimal price', p3, 'price');
t('european decimal value', p3.find(i=>i.field==='price')?.value, 12.50);

// Thousands separator
const p4 = analyzeCell('8,025.00', {headerHint: 'Price'});
tWinner('thousands separator price', p4, 'price');
t('thousands separator value', p4.find(i=>i.field==='price')?.value, 8025.00);

// Price per LB header → also proposes priceBasis
const p5 = analyzeCell('2.15', {headerHint: 'Price/LB'});
tField('price/lb proposes price', p5, 'price', 0.85);
tField('price/lb proposes measure basis', p5, 'priceBasis', 0.85);

// Ambiguous number — could be price or qty or code
// An integer alone cannot establish which — both are proposed at LOW confidence.
// Neither should dominate; the test verifies proposals exist, not that they score high.
const p6 = analyzeCell('2', {headerHint: '', rowCells: ['1001', 'ITEM', '10 EA', '2', '25.00'], colIndex: 3});
tField('bare integer proposes price at low confidence', p6, 'price', 0.35);
tField('bare integer also proposes qty at low confidence', p6, 'qty', 0.20);
// Verify neither dominates: winner should not claim high confidence
const p6winner = p6[0];
const p6ok = !p6winner || p6winner.score < 0.80;
t('bare integer: no field claims high confidence without context', p6ok, true);

// Line total — separate from price
const p7 = analyzeCell('250.00', {headerHint: 'Extended Price'});
tWinner('line total header', p7, 'lineTotal');

// ══════════════════════════════════════════════════════════════════════════════
// PACK CELLS
// ══════════════════════════════════════════════════════════════════════════════

// Standard pack
const pk1 = analyzeCell('4/10 LB', {headerHint: 'Pack Size'});
tWinner('standard pack with header', pk1, 'pack');
tAbove('standard pack score', pk1.find(i=>i.field==='pack')?.score, 0.90);

// Pack without header
const pk2 = analyzeCell('40 LB', {headerHint: ''});
tWinner('pack without header', pk2, 'pack');

// Mixed fraction pack — originalRaw is metadata ON the pack proposal, not a separate field
const pk3 = analyzeCell('1-1/9 BU', {headerHint: 'Pack'});
tField('mixed fraction pack', pk3, 'pack', 0.90);
const pk3pack = pk3.find(i=>i.field==='pack');
t('mixed fraction normalised value', pk3pack?.value, '1.111111 BU');
t('mixed fraction original preserved in metadata', pk3pack?.originalRaw, '1-1/9 BU');

// Count × size
const pk4 = analyzeCell('24/15.5 OZ', {headerHint: 'Pack'});
tWinner('compound pack', pk4, 'pack');

// Hash weight
const pk5 = analyzeCell('35#', {headerHint: ''});
tField('hash weight is pack', pk5, 'pack', 0.70);

// Weight range
const pk6 = analyzeCell('8-10 LB AVG', {headerHint: 'Pack'});
tField('weight range is pack', pk6, 'pack', 0.70);

// Pack embedded in description (no pack column)
const pk7 = analyzeCell('ITEM ALPHA 40 LB', {headerHint: 'Description'});
tField('pack embedded in description', pk7, 'pack', 0.70);
tField('description still found after pack strip', pk7, 'description', 0.70);

// Pack in parentheses mid-description
const pk8 = analyzeCell('ITEM ALPHA (40 LB) FRESH', {headerHint: 'Description'});
tField('parenthetical pack extracted', pk8, 'pack', 0.70);

// ══════════════════════════════════════════════════════════════════════════════
// DESCRIPTION CELLS
// ══════════════════════════════════════════════════════════════════════════════

// Clean description
const d1 = analyzeCell('CHICKEN BREAST BONELESS SKINLESS', {headerHint: 'Description'});
tWinner('explicit description header', d1, 'description');
tAbove('explicit description score', d1.find(i=>i.field==='description')?.score, 0.90);

// Abbreviated vendor description
const d2 = analyzeCell('CHIX BRST BNLS SKNLS', {headerHint: 'Description'});
tWinner('abbreviated description', d2, 'description');

// Preparation term embedded in description
const d3 = analyzeCell('BEEF GROUND FRESH', {headerHint: 'Description'});
tField('fresh is prep term', d3, 'preparation', 0.75);

// Origin qualifier
const d4 = analyzeCell('(USA)', {headerHint: ''});
tWinner('origin qualifier', d4, 'origin');
t('origin value', d4.find(i=>i.field==='origin')?.value, 'USA');

// Asterisk flags stripped — description should win, not flag
const d5 = analyzeCell('*ITEM ALPHA*', {headerHint: 'Description'});
tWinner('asterisk-wrapped description', d5, 'description');

// ALL-CAPS single word — could be brand or description
const d6 = analyzeCell('TYSON', {headerHint: ''});
tWinner('known brand wins', d6, 'brand');

const d7 = analyzeCell('FROZEN', {headerHint: ''});
tWinner('prep term wins over description', d7, 'preparation');

// ══════════════════════════════════════════════════════════════════════════════
// VENDOR ITEM CODE CELLS
// ══════════════════════════════════════════════════════════════════════════════

// Clean code with header
const c1 = analyzeCell('ABC-1001', {headerHint: 'Item No'});
tWinner('item code with header', c1, 'code');
tAbove('item code score', c1.find(i=>i.field==='code')?.score, 0.90);

// Alphanumeric code without header
const c2 = analyzeCell('XYZ-0042', {headerHint: ''});
tField('alphanumeric code without header', c2, 'code', 0.50);

// Pure numeric — could be code or price
const c3 = analyzeCell('1234567', {headerHint: 'Item#'});
tWinner('numeric code with header', c3, 'code');

// Leading zeros — must not be parsed as a number
const c4 = analyzeCell('00123', {headerHint: 'Item#'});
tWinner('leading zero code', c4, 'code');
t('leading zeros preserved', c4.find(i=>i.field==='code')?.value, '00123');

// ══════════════════════════════════════════════════════════════════════════════
// GTIN / BARCODE CELLS
// ══════════════════════════════════════════════════════════════════════════════

const g1 = analyzeCell('00012345678905', {headerHint: 'UPC'});
tWinner('gtin with upc header', g1, 'gtin');
tAbove('gtin score', g1.find(i=>i.field==='gtin')?.score, 0.95);

const g2 = analyzeCell('012345678905', {headerHint: ''});
tField('gtin without header', g2, 'gtin', 0.75);

// ══════════════════════════════════════════════════════════════════════════════
// BRAND CELLS
// ══════════════════════════════════════════════════════════════════════════════

const b1 = analyzeCell('TYSON', {headerHint: 'Brand'});
tWinner('brand with header', b1, 'brand');
tAbove('brand score', b1.find(i=>i.field==='brand')?.score, 0.90);

const b2 = analyzeCell('KRAFT', {headerHint: ''});
tWinner('known brand without header', b2, 'brand');

// Size/grade words must NOT become brand
const b3 = analyzeCell('XL', {headerHint: ''});
tNoField('XL is not a brand at high confidence', b3, 'brand');

const b4 = analyzeCell('18 IN', {headerHint: ''});
tNoField('measurement is not a brand', b4, 'brand');

// ══════════════════════════════════════════════════════════════════════════════
// SELLING UNIT CELLS
// ══════════════════════════════════════════════════════════════════════════════

const su1 = analyzeCell('CS', {headerHint: 'Type'});
tWinner('CS selling unit with header', su1, 'sellingUnit');

const su2 = analyzeCell('LB', {headerHint: 'UOM'});
tWinner('LB selling unit with header', su2, 'sellingUnit');

const su3 = analyzeCell('EA', {headerHint: ''});
tField('EA selling unit without header', su3, 'sellingUnit', 0.70);

// ══════════════════════════════════════════════════════════════════════════════
// MANUFACTURER CODE CELLS
// ══════════════════════════════════════════════════════════════════════════════

const m1 = analyzeCell('TY-1001', {headerHint: 'Mfr #'});
tWinner('mfr code with header', m1, 'manufacturerCode');

const m2 = analyzeCell('AB-12345', {headerHint: ''});
tField('mfr code without header', m2, 'manufacturerCode', 0.60);

// ══════════════════════════════════════════════════════════════════════════════
// CROSS-CELL ROW ANALYSIS
// ══════════════════════════════════════════════════════════════════════════════

// Clean row — all fields solvable
const r1 = analyzeRow(
  ['1001', 'ITEM ALPHA STANDARD', '10 EA', '12.50'],
  ['Item#', 'Description', 'Pack', 'Price']
);
t('clean row: code', r1.resolved.code?.value, '1001');
t('clean row: description', r1.resolved.description?.value, 'ITEM ALPHA STANDARD');
t('clean row: pack', r1.resolved.pack?.value, '10 EA');
t('clean row: price', r1.resolved.price?.value, 12.50);

// Row with no headers — profiling only
const r2 = analyzeRow(
  ['A001', 'ITEM BETA UNIT', '5 EA', '8.00'],
  []
);
t('headerless row finds description', r2.resolved.description?.value, 'ITEM BETA UNIT');
t('headerless row finds price', r2.resolved.price?.value, 8.00);

// Row with invoice arithmetic: qty × price = total
const r3 = analyzeRow(
  ['2', '25.00', '50.00'],
  ['Qty', 'Unit Price', 'Extended']
);
t('invoice row: qty', r3.resolved.qty?.value, 2);
t('invoice row: price', r3.resolved.price?.value, 25.00);
t('invoice row: line total', r3.resolved.lineTotal?.value, 50.00);
t('invoice row: no conflict', r3.conflicts.filter(c=>c.field==='price').length, 0);

// Row where qty × price ≠ lineTotal → pricing basis conflict flagged
const r4 = analyzeRow(
  ['2', '85.60', '17.12'],
  ['Qty', 'Case Price', 'Per LB']
);
t('pricing basis conflict detected', r4.conflicts.some(c=>c.field==='price'), true);

// Minimal row: description + price only
const r5 = analyzeRow(
  ['ITEM GAMMA', '22.00'],
  ['Description', 'Price']
);
t('minimal row description', r5.resolved.description?.value, 'ITEM GAMMA');
t('minimal row price', r5.resolved.price?.value, 22.00);
t('minimal row no unresolved critical', r5.unresolved.filter(u=>['description','price'].includes(u.field)).length, 0);

// Pack missing row — unresolved field reported
const r6 = analyzeRow(
  ['ITEM DELTA', '18.50'],
  ['Description', 'Price']
);
t('missing pack: description present', r6.resolved.description?.value, 'ITEM DELTA');
t('missing pack: price present', r6.resolved.price?.value, 18.50);
// pack will be unresolved — that's correct, not an error

// ══════════════════════════════════════════════════════════════════════════════
// UGLY VENDOR FILE CELLS
// ══════════════════════════════════════════════════════════════════════════════

// "P" flag — vendor type code, not a price or product
const ugly1 = analyzeCell('P', {headerHint: 'Type'});
tWinner('"P" type flag is selling unit', ugly1, 'sellingUnit');

// "BOX LIME" — product, not a packaging word
const ugly2 = analyzeCell('BOX LIME', {headerHint: 'Description'});
tWinner('BOX LIME is a description', ugly2, 'description');

// Vendor item number looks like a price — "42.00" as item code
const ugly3 = analyzeCell('42.00', {headerHint: 'Item#'});
tWinner('money-looking item code wins on header', ugly3, 'code');

// Price cell with unit embedded: "$2.15/LB"
const ugly4 = analyzeCell('$2.15/LB', {headerHint: 'Price'});
tWinner('price with unit wins as price', ugly4, 'price');
t('price with unit value', ugly4.find(i=>i.field==='price')?.value, 2.15);

// Extra whitespace and case variations
const ugly5 = analyzeCell('  ITEM  ALPHA  ', {headerHint: 'Description'});
tWinner('whitespace-padded description', ugly5, 'description');
t('whitespace trimmed', ugly5.find(i=>i.field==='description')?.value.includes('  '), false);

// Mixed content: "ITEM ALPHA 40 LB $12.50" all in one cell (freeform)
const ugly6 = analyzeCell('ITEM ALPHA 40 LB', {headerHint: ''});
tField('freeform description+pack: pack found', ugly6, 'pack', 0.70);

// Negative price (credit memo) — preserved and flagged for review
const ugly7 = analyzeCell('(12.50)', {headerHint: 'Price'});
tWinner('negative price in parens', ugly7, 'price');
t('negative price value', ugly7.find(i=>i.field==='price')?.value, -12.50);
t('negative price flagged for review', ugly7.find(i=>i.field==='price')?.requiresReview, true);

// Zero price — recognized as a price value but flagged as not a usable purchasing price
const ugly8 = analyzeCell('0.00', {headerHint: 'Price'});
tWinner('zero price is recognized', ugly8, 'price');
t('zero price is flagged unavailable', ugly8.find(i=>i.field==='price')?.priceUnavailable, true);
t('zero price score is low (not a usable price)', ugly8.find(i=>i.field==='price')?.score < 0.60, true);

// Very long item code
const ugly9 = analyzeCell('PROD-ALPHA-001-XL', {headerHint: 'Item#'});
tWinner('long item code', ugly9, 'code');

// Percentage — never a price or pack
const ugly10 = analyzeCell('15%', {headerHint: ''});
tNoField('percentage not a price', ugly10, 'price');

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
