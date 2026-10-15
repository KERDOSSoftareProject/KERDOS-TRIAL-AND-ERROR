/**
 * horn-readiness-audit.mjs
 *
 * Full readiness audit of horn.txt through the real KERDOS engine.
 * Tests two passes:
 *   Pass 1 — first import (no prior, no invoices, no explicit unit)
 *   Pass 2 — unchanged reimport (prior = saved row from Pass 1, same data)
 *
 * Verifies:
 *   - preparePriceImport → requiresReview, resolved, reasons
 *   - parsePackSize → parsed, catchWeight (LBAV rows)
 *   - quoteStatus → quote/expired blocker
 *   - orderGuideAssessment → all blockers (category, product, pack,
 *       sellingUnit, price, source, association, quote, unitCost, brand, link)
 *
 * Constraints preserved:
 *   - No range changes
 *   - No live-data changes
 *   - Unconfirmed pricing remains unconfirmed on reimport
 *   - Script is self-contained and reproducible
 */

import {preparePriceImport} from './price-import-review.js';
import {orderGuideAssessment} from './catalog-fields.js';
import {parsePackSize, configureProcurement} from '../procurement.js';
import {configureCategoryProfile} from '../knowledge/category-profiles.js';
import fs from 'fs';

configureProcurement({industry: 'restaurant'});
configureCategoryProfile('restaurant');

// ── Parse horn.txt ────────────────────────────────────────────────────────────
const HORN = '/mnt/user-data/uploads/horn.txt';
const raw = fs.readFileSync(HORN, 'utf8');
const lines = raw.trim().split('\n').map(l => l.replace(/\r$/, ''));
const hornRows = lines.slice(1).map(line => {
  const cols = line.split('\t');
  return {
    code:        cols[0]?.trim() || '',
    brand:       cols[1]?.trim() || '',
    packSize:    cols[2]?.trim() || '',
    description: cols[3]?.trim() || '',
    comments:    cols[4]?.trim() || '',
    price:       parseFloat(cols[5]?.trim()),
    sellingUnit: '',           // horn.txt has no explicit unit column
    sellingUnitSource: '',
  };
}).filter(r => r.code && Number.isFinite(r.price) && r.price > 0);

// ── Minimal catalog fixtures ──────────────────────────────────────────────────
// These are stubs: the engine needs item/mapping/category objects to run
// orderGuideAssessment. We build the minimum structure for each row.
// Category is deliberately set to a real (non-holding-pen) category so the
// category gate is not a blocker from the fixture side — the audit focuses
// on what horn.txt itself can and cannot establish.

function makeFixtures(row, passOneResult) {
  const vi = {
    id: `vi-${row.code}`,
    vendor_id: 'vendor-horn',
    vendor_item_code: row.code,
    description: passOneResult.row.description || row.description,
    brand: passOneResult.row.brand || row.brand,
    pack_size: passOneResult.row.packSize || row.packSize,
    selling_unit: passOneResult.resolved?.sellingUnit || '',
    price: row.price,
    price_unavailable: false,
    price_source: 'quote',
    price_basis: passOneResult.resolved?.basis?.basis || null,
    last_updated: new Date().toISOString(),
    import_row: {
      row: {
        code: row.code, description: row.description, brand: row.brand,
        packSize: row.packSize, price: row.price,
      },
      evidence: {packSource: 'column', sellingUnitSource: passOneResult.resolved?.source || ''},
      reviewRequired: passOneResult.requiresReview,
      changes: passOneResult.row.changes || [],
    },
    field_resolutions: {},
  };
  const item = {
    id: `ci-${row.code}`,
    name: row.description,
    category_id: 'cat-test',
    category_reason: 'Placed by test fixture',
    category_review: false,
    brand_locked: false,
    master_item_number: `KDX-${row.code}`,
  };
  const mapping = {
    id: `map-${row.code}`,
    catalog_item_id: `ci-${row.code}`,
    vendor_item_id: `vi-${row.code}`,
    comparison_track: 'suggested',  // not yet exact — association gate not cleared
    confidence_score: 75,
    match_method: 'rule_based',
  };
  const category = {id: 'cat-test', name: 'Test Category', is_holding_pen: false};
  const vendor = {id: 'vendor-horn', name: 'Horn Vendor'};
  return {vi, item, mapping, category, vendor};
}

// ── Run audits ────────────────────────────────────────────────────────────────
const pass1Results = [];
const pass2Results = [];

for (const row of hornRows) {
  // ── PASS 1: first import, no prior ──────────────────────────────────────
  let p1;
  try {
    p1 = preparePriceImport(row, null, null, [], []);
  } catch(e) {
    p1 = {row: {...row}, resolved: null, requiresReview: true, reasons: [`preparePriceImport threw: ${e.message}`], reviewFields: []};
  }

  const pack1 = parsePackSize(row.packSize);
  const {vi, item, mapping, category, vendor} = makeFixtures(row, p1);

  let assessment1;
  try {
    assessment1 = orderGuideAssessment({item, vendorItem: vi, mapping, vendor, category, peers: [], categories: [], settings: {}, now: new Date()});
  } catch(e) {
    assessment1 = {ready: false, fieldsReady: false, blockers: [`assessment threw: ${e.message}`], evidence: null};
  }

  pass1Results.push({row, p1, pack1, assessment1});

  // ── PASS 2: unchanged reimport, prior = saved record from pass 1 ─────────
  // The prior reflects what was saved: if requiresReview was true on pass 1,
  // prior.import_row.reviewRequired is true — the engine must NOT auto-clear it.
  const prior = {
    id: vi.id,
    vendor_item_code: row.code,
    description: vi.description,
    brand: vi.brand,
    pack_size: vi.pack_size,
    selling_unit: vi.selling_unit,
    price_basis: vi.price_basis,
    price_source: 'quote',
    import_row: vi.import_row,
    field_resolutions: {},
    gtin: null, manufacturer_code: null,
  };

  let p2;
  try {
    p2 = preparePriceImport(row, prior, mapping, [], []);
  } catch(e) {
    p2 = {row: {...row}, resolved: null, requiresReview: true, reasons: [`preparePriceImport threw: ${e.message}`], reviewFields: []};
  }

  // Build pass-2 vendorItem reflecting what the engine would save
  const vi2 = {
    ...vi,
    selling_unit: p2.resolved?.sellingUnit || vi.selling_unit,
    price_basis: p2.resolved?.basis?.basis || vi.price_basis,
    import_row: {
      ...vi.import_row,
      reviewRequired: p2.requiresReview,
      changes: p2.row.changes || [],
    },
  };

  let assessment2;
  try {
    assessment2 = orderGuideAssessment({item, vendorItem: vi2, mapping, vendor, category, peers: [], categories: [], settings: {}, now: new Date()});
  } catch(e) {
    assessment2 = {ready: false, fieldsReady: false, blockers: [`assessment threw: ${e.message}`], evidence: null};
  }

  pass2Results.push({row, p2, assessment2});
}

// ── Aggregate counts ──────────────────────────────────────────────────────────
function _blockerCounts(results) {
  const counts = {};
  for (const {assessment1, assessment2} of results.map((r,i) => ({assessment1: pass1Results[i]?.assessment1, assessment2: r.assessment2}))) {
    const assessment = assessment1 ?? assessment2;
    if (!assessment) continue;
    for (const b of (assessment.blockers || [])) counts[b] = (counts[b] || 0) + 1;
  }
  return counts;
}

function _countBy(results, fn) {
  return results.filter(fn).length;
}

// ── Report ────────────────────────────────────────────────────────────────────
console.log('═══════════════════════════════════════════════════════════════════');
console.log('HORN.TXT FULL READINESS AUDIT — REAL ENGINE, ISOLATED TEST BACKEND');
console.log('═══════════════════════════════════════════════════════════════════');
console.log(`Source: ${HORN}`);
console.log(`Rows:   ${hornRows.length}`);
console.log(`Date:   ${new Date().toISOString().slice(0,10)}`);

// ── Pack section ─────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────────────────────────');
console.log('PACK PARSING (parsePackSize — real engine)');
console.log('──────────────────────────────────────────────────────────────────');
const packParsed    = pass1Results.filter(r => r.pack1?.parsed).length;
const packFailed    = pass1Results.filter(r => !r.pack1?.parsed).length;
const catchWeight   = pass1Results.filter(r => r.pack1?.catchWeight).length;
console.log(`  Parsed successfully:   ${packParsed}/${hornRows.length}`);
console.log(`  Failed to parse:       ${packFailed}/${hornRows.length}`);
console.log(`  Catch-weight (LBAV):   ${catchWeight}`);

if (packFailed > 0) {
  console.log('\n  Pack parse failures:');
  for (const {row, pack1} of pass1Results.filter(r => !r.pack1?.parsed)) {
    console.log(`    Item ${row.code} | ${row.brand} | "${row.packSize}" → parsed:false unit:${pack1?.unit||'null'}`);
  }
}
if (catchWeight > 0) {
  console.log('\n  Catch-weight rows (variable weight — approximate case total):');
  for (const {row, pack1} of pass1Results.filter(r => r.pack1?.catchWeight)) {
    console.log(`    Item ${row.code} | ${row.brand} | "${row.packSize}" → ${pack1.caseQty}×${pack1.unitQty} ${pack1.unit} catchWeight:true`);
  }
}

// ── Pass 1: preparePriceImport ────────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────────────────────────');
console.log('PASS 1 — FIRST IMPORT (no prior, no invoice, no explicit unit)');
console.log('──────────────────────────────────────────────────────────────────');
const p1Resolved     = pass1Results.filter(r => r.p1.resolved !== null).length;
const p1NeedsReview  = pass1Results.filter(r => r.p1.requiresReview).length;
const p1Clean        = pass1Results.filter(r => !r.p1.requiresReview).length;
console.log(`  resolved !== null:     ${p1Resolved}/${hornRows.length}`);
console.log(`  requiresReview=true:   ${p1NeedsReview}/${hornRows.length}`);
console.log(`  requiresReview=false:  ${p1Clean}/${hornRows.length}`);

// Reason frequency
const reasonFreq1 = {};
for (const {p1} of pass1Results) {
  for (const r of p1.reasons) {
    const key = r.length > 80 ? r.slice(0,80)+'…' : r;
    reasonFreq1[key] = (reasonFreq1[key] || 0) + 1;
  }
}
console.log('\n  Reason frequency (pass 1):');
for (const [reason, count] of Object.entries(reasonFreq1).sort((a,b) => b[1]-a[1])) {
  console.log(`    [${count}×] ${reason}`);
}

// ── Pass 1: orderGuideAssessment ──────────────────────────────────────────────
console.log('\n  orderGuideAssessment blockers (pass 1):');
const blockerFreq1 = {};
for (const {assessment1} of pass1Results) {
  for (const b of (assessment1?.blockers || [])) {
    blockerFreq1[b] = (blockerFreq1[b] || 0) + 1;
  }
}
for (const [b, count] of Object.entries(blockerFreq1).sort((a,b) => b[1]-a[1])) {
  console.log(`    ${b.padEnd(12)} ${count}/${hornRows.length}`);
}
const p1Ready = pass1Results.filter(r => r.assessment1?.ready).length;
console.log(`\n  Order Guide ready (pass 1): ${p1Ready}/${hornRows.length}`);

// ── Pass 2: reimport with prior ───────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────────────────────────');
console.log('PASS 2 — UNCHANGED REIMPORT (prior = saved pass-1 record)');
console.log('──────────────────────────────────────────────────────────────────');
const p2Resolved     = pass2Results.filter(r => r.p2.resolved !== null).length;
const p2NeedsReview  = pass2Results.filter(r => r.p2.requiresReview).length;
const p2Clean        = pass2Results.filter(r => !r.p2.requiresReview).length;
console.log(`  resolved !== null:     ${p2Resolved}/${hornRows.length}`);
console.log(`  requiresReview=true:   ${p2NeedsReview}/${hornRows.length}`);
console.log(`  requiresReview=false:  ${p2Clean}/${hornRows.length}`);

// Verify: if pass 1 set reviewRequired, pass 2 must not auto-clear it
const illegalClears = pass2Results.filter((r2, i) => {
  const r1 = pass1Results[i];
  return r1.p1.requiresReview && !r2.p2.requiresReview;
}).length;
console.log(`\n  Illegal auto-clears (p1 reviewRequired → p2 cleared): ${illegalClears}`);
if (illegalClears > 0) {
  console.log('  !! CONSTRAINT VIOLATED: unconfirmed pricing was auto-confirmed on reimport');
  for (const [i, r2] of pass2Results.entries()) {
    const r1 = pass1Results[i];
    if (r1.p1.requiresReview && !r2.p2.requiresReview) {
      console.log(`     Item ${r2.row.code} | ${r2.row.brand} | ${r2.row.packSize}`);
    }
  }
}

const p2Ready = pass2Results.filter(r => r.assessment2?.ready).length;
const blockerFreq2 = {};
for (const {assessment2} of pass2Results) {
  for (const b of (assessment2?.blockers || [])) {
    blockerFreq2[b] = (blockerFreq2[b] || 0) + 1;
  }
}
console.log('\n  orderGuideAssessment blockers (pass 2):');
for (const [b, count] of Object.entries(blockerFreq2).sort((a,b) => b[1]-a[1])) {
  console.log(`    ${b.padEnd(12)} ${count}/${hornRows.length}`);
}
console.log(`\n  Order Guide ready (pass 2): ${p2Ready}/${hornRows.length}`);

// ── Per-row detail ────────────────────────────────────────────────────────────
console.log('\n──────────────────────────────────────────────────────────────────');
console.log('PER-ROW DETAIL (pass 1 | pass 2)');
console.log('──────────────────────────────────────────────────────────────────');
console.log('Item       Brand   Size               Price   P1-basis      P1-rR P1-blockers             P2-rR P2-blockers');
for (const [i, {row, p1, pack1, assessment1}] of pass1Results.entries()) {
  const {p2, assessment2} = pass2Results[i];
  const basis = p1.resolved?.sellingUnit || '—';
  const p1rR  = p1.requiresReview ? 'Y' : 'N';
  const p2rR  = p2.requiresReview ? 'Y' : 'N';
  const p1b   = (assessment1?.blockers || []).join(',') || 'none';
  const p2b   = (assessment2?.blockers || []).join(',') || 'none';
  const cw    = pack1?.catchWeight ? '~' : ' ';
  console.log(`${row.code.padEnd(10)} ${row.brand.padEnd(6)}  ${(cw+row.packSize).padEnd(17)} $${String(row.price).padEnd(7)} ${basis.padEnd(12)}  ${p1rR}    ${p1b.padEnd(24)} ${p2rR}    ${p2b}`);
}

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════════');
console.log('SUMMARY');
console.log('═══════════════════════════════════════════════════════════════════');
console.log(`Total rows audited:              ${hornRows.length}`);
console.log(`Pack parsed (real engine):       ${packParsed}/${hornRows.length}`);
console.log(`Catch-weight (LBAV):             ${catchWeight}`);
console.log(`Pass 1 — requiresReview=true:   ${p1NeedsReview}/${hornRows.length}`);
console.log(`Pass 1 — Order Guide ready:     ${p1Ready}/${hornRows.length}`);
console.log(`Pass 2 — requiresReview=true:   ${p2NeedsReview}/${hornRows.length}`);
console.log(`Pass 2 — Order Guide ready:     ${p2Ready}/${hornRows.length}`);
console.log(`Illegal auto-clears:             ${illegalClears}`);
console.log('');
console.log('Blocker gate definitions (from orderGuideAssessment source):');
console.log('  category    — category placed and not holding pen, accuracy ≥ 90');
console.log('  product     — description accuracy ≥ 90');
console.log('  pack        — pack accuracy ≥ 90 (parsed + source evidence)');
console.log('  sellingUnit — unit accuracy ≥ 90');
console.log('  price       — price accuracy ≥ 90');
console.log('  source      — import_row.reviewRequired is true');
console.log('  association — comparison_track !== "exact"');
console.log('  quote       — price_unavailable or price null/invalid');
console.log('  unitCost    — pack+unit+price present but cannot compute case price');
console.log('  brand       — item brand_locked and vendor brand does not match');
console.log('  link        — no item/vendorItem/mapping found');
console.log('');
console.log('Note on fixtures:');
console.log('  category, product, association gates use minimal stubs.');
console.log('  Real catalog match would change category/product/association counts.');
console.log('  source, pack, sellingUnit, price, quote, unitCost gates');
console.log('  reflect real engine output on actual horn.txt data.');
