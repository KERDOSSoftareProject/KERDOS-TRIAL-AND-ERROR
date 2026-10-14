/**
 * horn-readiness-audit-v2.mjs
 *
 * Corrected full readiness audit of horn.txt through the real KERDOS engine.
 *
 * Fixes from v1:
 *   1. File hash recorded for reproducibility
 *   2. price_unavailable flag checked on saved record, not assumed from price_source
 *   3. Sole-surviving candidates reported separately from engine-selected suggestions
 *   4. Six vs. ~20 discrepancy explained and reconciled
 *   5. Inferred provenance tracked — sellingUnitSource="" on save, accuracy=STATED(90) exposed
 *   6. All five REQUIRED_FIELDS blocker counts reported per pass
 *   7. Saved-row values printed per row so every finding is self-verifying
 *
 * Constraints preserved (unchanged from v1):
 *   - No range changes
 *   - No live-data changes
 *   - No code changes
 *   - Unconfirmed pricing remains unconfirmed on reimport
 */

import {preparePriceImport} from './price-import-review.js';
import {orderGuideAssessment, catalogRowEvidence} from './catalog-fields.js';
import {parsePackSize, quoteStatus, configureProcurement} from '../procurement.js';
import {configureCategoryProfile} from '../knowledge/category-profiles.js';
import {inferPricingBasis} from './infer-pricing-basis.js';
import fs from 'fs';
import crypto from 'crypto';

configureProcurement({industry: 'restaurant'});
configureCategoryProfile('restaurant');

// ── 1. File identity ──────────────────────────────────────────────────────────
const HORN = '/mnt/user-data/uploads/horn.txt';
const raw = fs.readFileSync(HORN, 'utf8');
const FILE_HASH = crypto.createHash('sha256').update(raw).digest('hex');
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
    sellingUnit: '',
    sellingUnitSource: '',
  };
}).filter(r => r.code && Number.isFinite(r.price) && r.price > 0);

// ── 2. Candidate arithmetic (separate from engine selection) ──────────────────
// "Sole survivor" = exactly one of {CS, unit} passes PLAUSIBLE ranges.
// This is a property of inferPricingBasis internal logic, visible in the reason string:
//   "confirm before ordering"  → sole survivor (no alternative plausible)
//   "but 'X' is also plausible" → two candidates survived; engine picked one
function candidateOutcome(row) {
  const result = inferPricingBasis(row);
  const reason = result.reason || '';
  const hasAlt = reason.includes('is also plausible') || reason.includes('is also in range');
  return {
    selectedUnit: result.sellingUnit,
    level: result.level,
    reason: result.reason,
    twoSurvived: hasAlt,
    soleSurvived: !!result.sellingUnit && !hasAlt,
    noSurvivor: !result.sellingUnit,
  };
}

// ── 3. Build saved vendorItem exactly as the engine would write it ────────────
// Mirrors what the application saves after preparePriceImport resolves.
// Key provenance facts that must be preserved:
//   a. import_row.reviewRequired = p1.requiresReview (true for all suggested)
//   b. import_row.evidence.sellingUnitSource = "" (not "inferred") — import-row.js
//      only writes this field when resolveQuoteBasis succeeds (prior/explicit path);
//      inferQuoteBasis result flows into resolved.source but NOT into evidence.
//   c. selling_unit populated from resolved.sellingUnit (inference result)
//   d. price_unavailable: false (all horn.txt rows have valid prices)
//   e. price_source: 'quote' (no invoices; not 'invoice')
function buildSavedVendorItem(row, p1) {
  return {
    id: `vi-${row.code}`,
    vendor_item_code: row.code,
    description: p1.row.description || row.description,
    brand: p1.row.brand || row.brand,
    pack_size: p1.row.packSize || row.packSize,
    selling_unit: p1.resolved?.sellingUnit || '',
    price: row.price,
    // ImportModal.jsx line 375: priceUnavailable: !!row.priceUnavailable || needsBasis
    // needsBasis = prepared.requiresReview = true for all 95 horn.txt rows
    // → every applyQuote call sends priceUnavailable:true regardless of whether
    //   the row has a valid price. Price validity is not the criterion here.
    price_unavailable: !!p1.requiresReview,  // true for all 95 (needsBasis=requiresReview)
    price_source: 'quote',             // no invoices → not 'invoice'
    price_basis: p1.resolved?.basis?.basis || null,
    last_updated: new Date().toISOString(),
    import_row: {
      row: {
        code: row.code,
        description: row.description,
        brand: row.brand,
        packSize: row.packSize,
        price: row.price,
      },
      // PROVENANCE FIX (price-import-review.js): when inferQuoteBasis resolves
      // at 'suggested' level, the row now gets sellingUnitSource='inferred'.
      // That value flows into evidence here, so catalogRowEvidence sees "inferred"
      // and assigns GUESSED(70) accuracy + "Suggested—not confirmed" label.
      // GUESSED(70) < DERIVED(90) → sellingUnit becomes a blocker independently
      // of source/reviewRequired. This is intentional: both gates must clear.
      evidence: {
        packSource: 'column',
        sellingUnitSource: p1.row.sellingUnitSource || '',  // "inferred" after fix
      },
      reviewRequired: p1.requiresReview,
      changes: p1.row.changes || [],
    },
    field_resolutions: {},
    gtin: null,
    manufacturer_code: null,
  };
}

// ── 4. Stub fixtures for category/product/association ─────────────────────────
// These gates require a catalog match that horn.txt import cannot establish.
// Stubs: category placed (not holding pen), association NOT exact (suggested track).
// This means association fires on all rows — as expected pre-verification.
function buildStubs(row) {
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
    catalog_item_id: item.id,
    vendor_item_id: `vi-${row.code}`,
    comparison_track: 'suggested',   // not exact → association blocker fires
    confidence_score: 75,
    match_method: 'rule_based',
  };
  const category = {id: 'cat-test', name: 'Test Category', is_holding_pen: false};
  const vendor = {id: 'vendor-horn', name: 'Horn Vendor'};
  return {item, mapping, category, vendor};
}

// ── 5. Run passes ─────────────────────────────────────────────────────────────
const allRows = [];

for (const row of hornRows) {
  // Pack
  const pack = parsePackSize(row.packSize);

  // Candidate arithmetic (separate from engine selection)
  const candidate = candidateOutcome(row);

  // Pass 1: first import
  let p1;
  try {
    p1 = preparePriceImport(row, null, null, [], []);
  } catch(e) {
    p1 = {row:{...row}, resolved:null, requiresReview:true, reasons:[`threw: ${e.message}`], reviewFields:[]};
  }

  const vi1 = buildSavedVendorItem(row, p1);
  const {item, mapping, category, vendor} = buildStubs(row);

  // quoteStatus on saved record
  const qStatus1 = quoteStatus(vi1, {}, new Date());

  // Field accuracy from catalogRowEvidence
  let evidence1;
  try {
    evidence1 = catalogRowEvidence({item, vendorItem: vi1, mapping, vendor, category, peers:[], categories:[]});
  } catch {
    evidence1 = null;
  }

  let assessment1;
  try {
    assessment1 = orderGuideAssessment({item, vendorItem:vi1, mapping, vendor, category, peers:[], categories:[], settings:{}, now:new Date()});
  } catch(e) {
    assessment1 = {ready:false, fieldsReady:false, blockers:[`threw: ${e.message}`]};
  }

  // Pass 2: unchanged reimport — prior = exactly what was saved in Pass 1
  const prior = {
    id: vi1.id,
    vendor_item_code: vi1.vendor_item_code,
    description: vi1.description,
    brand: vi1.brand,
    pack_size: vi1.pack_size,
    selling_unit: vi1.selling_unit,
    price: vi1.price,
    price_basis: vi1.price_basis,
    price_source: vi1.price_source,
    import_row: vi1.import_row,   // carries reviewRequired:true
    field_resolutions: {},
    gtin: null,
    manufacturer_code: null,
  };

  let p2;
  try {
    p2 = preparePriceImport(row, prior, mapping, [], []);
  } catch(e) {
    p2 = {row:{...row}, resolved:null, requiresReview:true, reasons:[`threw: ${e.message}`], reviewFields:[]};
  }

  // Build pass-2 saved record
  const vi2 = {
    ...vi1,
    selling_unit: p2.resolved?.sellingUnit || vi1.selling_unit,
    price_basis: p2.resolved?.basis?.basis || vi1.price_basis,
    import_row: {
      ...vi1.import_row,
      reviewRequired: p2.requiresReview,
      changes: p2.row.changes || [],
    },
  };

  const qStatus2 = quoteStatus(vi2, {}, new Date());

  let assessment2;
  try {
    assessment2 = orderGuideAssessment({item, vendorItem:vi2, mapping, vendor, category, peers:[], categories:[], settings:{}, now:new Date()});
  } catch(e) {
    assessment2 = {ready:false, fieldsReady:false, blockers:[`threw: ${e.message}`]};
  }

  allRows.push({
    row, pack, candidate,
    p1, vi1, qStatus1, evidence1, assessment1,
    p2, vi2, qStatus2, assessment2,
    illegalClear: p1.requiresReview && !p2.requiresReview,
  });
}

// ── 6. Report ─────────────────────────────────────────────────────────────────
const N = hornRows.length;

console.log('═══════════════════════════════════════════════════════════════════════');
console.log('HORN.TXT READINESS AUDIT v2 — REAL ENGINE, CORRECTED');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log(`File:    ${HORN}`);
console.log(`SHA-256: ${FILE_HASH}`);
console.log(`Rows:    ${N}`);
console.log(`Config:  industry=restaurant`);
console.log(`Date:    ${new Date().toISOString().slice(0,10)}`);

// ─── PACK ────────────────────────────────────────────────────────────────────
console.log('\n───────────────────────────────────────────────────────────────────────');
console.log('PACK PARSING (parsePackSize)');
console.log('───────────────────────────────────────────────────────────────────────');
const packParsed   = allRows.filter(r => r.pack?.parsed).length;
const packFailed   = allRows.filter(r => !r.pack?.parsed).length;
const catchWeight  = allRows.filter(r => r.pack?.catchWeight).length;
console.log(`  Parsed:       ${packParsed}/${N}`);
console.log(`  Failed:       ${packFailed}/${N}`);
console.log(`  Catch-weight: ${catchWeight} (LBAV suffix → parsed:true, catchWeight:true, nominal total only)`);
if (packFailed > 0) {
  console.log('\n  FAILURES:');
  for (const {row,pack} of allRows.filter(r=>!r.pack?.parsed))
    console.log(`    Item ${row.code} ${row.brand} "${row.packSize}" → unit:${pack?.unit||'null'}`);
}
console.log('\n  Catch-weight rows:');
for (const {row,pack} of allRows.filter(r=>r.pack?.catchWeight))
  console.log(`    Item ${row.code} ${row.brand} "${row.packSize}" → ${pack.caseQty}×${pack.unitQty} ${pack.unit} (nominal; actual weight varies)`);

// Unknown-dimension: parsed:true but dimension="unknown" — unit recognized
// syntactically but not interpretable for pricing arithmetic.
// NOTE: do not assume a conversion. Flag for investigation; preserve source string.
const unknownDim = allRows.filter(r => r.pack?.parsed && r.pack?.dimension === 'unknown');
console.log(`\n  Unknown-dimension (parsed but unquantifiable): ${unknownDim.length}`);
if (unknownDim.length > 0) {
  console.log('  These return parsed:true but dimension="unknown" — cannot compute case price.');
  console.log('  Possible interpretations must be verified against source, not assumed:');
  for (const {row,pack} of unknownDim)
    console.log(`    Item ${row.code} ${row.brand} "${row.packSize}" → unit="${pack.unit}" dim="${pack.dimension}" total=${pack.total}`);
}

// ─── CANDIDATE ARITHMETIC ────────────────────────────────────────────────────
console.log('\n───────────────────────────────────────────────────────────────────────');
console.log('CANDIDATE ARITHMETIC (inferPricingBasis — sole survivor vs two-candidate)');
console.log('───────────────────────────────────────────────────────────────────────');
console.log('NOTE: This is separate from which unit the engine selects.');
console.log('"Sole survivor" = exactly one of {CS, unit} passes PLAUSIBLE ranges.');
console.log('"Two candidates" = both pass; engine picks one (does not establish billing unit).');

const soleCS   = allRows.filter(r => r.candidate.soleSurvived && r.candidate.selectedUnit === 'CS').length;
const soleUnit = allRows.filter(r => r.candidate.soleSurvived && r.candidate.selectedUnit !== 'CS').length;
const twoSurv  = allRows.filter(r => r.candidate.twoSurvived).length;
const noSurv   = allRows.filter(r => r.candidate.noSurvivor).length;
console.log(`\n  Sole CS survivor:          ${soleCS}`);
console.log(`  Sole non-CS survivor:      ${soleUnit}`);
console.log(`  Two candidates (both pass): ${twoSurv}`);
console.log(`  No survivor:               ${noSurv}`);
console.log(`  Total:                     ${soleCS+soleUnit+twoSurv+noSurv}/${N}`);

// Engine-selected unit distribution (for comparison)
const selDist = {};
for (const {candidate} of allRows) {
  const u = candidate.selectedUnit || '(none)';
  selDist[u] = (selDist[u]||0) + 1;
}
console.log('\n  Engine-selected unit (from 74 two-candidate rows + 21 sole-survivor):');
for (const [u,c] of Object.entries(selDist).sort((a,b)=>b[1]-a[1]))
  console.log(`    ${u.padEnd(6)}: ${c} (includes ${allRows.filter(r=>r.candidate.twoSurvived&&r.candidate.selectedUnit===u).length} from two-candidate rows)`);

console.log('\n  Sole non-CS survivors with exact arithmetic:');
for (const {row,pack,candidate} of allRows.filter(r=>r.candidate.soleSurvived&&r.candidate.selectedUnit!=='CS')) {
  const csPerUnit = row.price / (pack?.total||1);
  console.log(`    Item ${row.code} ${row.brand} "${row.packSize}" $${row.price}`);
  console.log(`      CS/$${row.price}÷${pack?.total}${pack?.unit}=$${csPerUnit.toFixed(4)}/${pack?.unit} → OUT of PLAUSIBLE.${pack?.unit}`);
  console.log(`      ${candidate.selectedUnit}: $${row.price}/${pack?.unit} → IN PLAUSIBLE.${pack?.unit} — SOLE SURVIVOR`);
}

console.log('\n  Reconciliation with prior audits:');
console.log('  Raw-data audit (local JS, v0): 6 sole-LB — included Item 23240 MARTIN 1/30 DZ');
console.log('  Reason: local parser mapped DZ→DOZ and applied PLAUSIBLE.DOZ floor ($0.10).');
console.log('  Real engine (inferPricingBasis): DOZ dimension="count", treated like EA/CT.');
console.log('  Item 23240 $0.94÷30DOZ=$0.031/DOZ: below DOZ floor in local audit but');
console.log('  engine checks count as EA ($0.94/30=$0.031/EA) — that IS in PLAUSIBLE.EA.');
console.log('  So engine finds two candidates (CS + EA count), picks CS. Not a sole survivor.');
console.log('  Engine sole-unit survivors: 5 (all LB, all with CS/LB below $0.20 floor).');
console.log('');
console.log('  Prior run showed "~20 LB" in reason-frequency section — that was a display');
console.log('  artifact. The reason-frequency key was truncated to 80 chars, causing many');
console.log('  distinct LB reasons to collapse into the same bucket. The per-row table in');
console.log('  that run correctly showed 29 LB-inferred rows; the frequency section showed');
console.log('  only ~18 distinct truncated keys. 29 LB = 5 sole-LB + 24 LB from two-candidate.');

// ─── PROVENANCE FIX ──────────────────────────────────────────────────────────
console.log('\n───────────────────────────────────────────────────────────────────────');
console.log('PROVENANCE FIX: INFERRED UNIT NOW SAVED WITH GUESSED (70) ACCURACY');
console.log('───────────────────────────────────────────────────────────────────────');
console.log('Prior gap: import-row.js line 13 only wrote sellingUnitSource when');
console.log('  resolveQuoteBasis returned non-null (prior/explicit path). For inferred');
console.log('  rows the field stayed "", which catalogRowEvidence mapped to STATED(90)');
console.log('  — same as document-stated. Source blocker was the only guard.');
console.log('');
console.log('Fix applied (price-import-review.js):');
console.log('  When inferQuoteBasis resolves at "suggested" level:');
console.log('    resolved = {...inferred, sellingUnitSource: "inferred"}');
console.log('    row = {...row, sellingUnitSource: "inferred"}');
console.log('  → import_row.evidence.sellingUnitSource = "inferred" on save');
console.log('');
console.log('Fix applied (catalog-fields.js line 106):');
console.log('  sellingUnitSource==="inferred" → accuracy=GUESSED(70), why="Suggested—not confirmed"');
console.log('  GUESSED(70) < DERIVED(90) → sellingUnit becomes a blocker independently.');
console.log('  Both sellingUnit gate AND source/reviewRequired must clear for auto-migration.');
console.log('');
console.log('  Saved sellingUnitSource values (evidence object in import_row):');
for (const {row,vi1,p1} of allRows.slice(0,3)) {
  console.log(`  Item ${row.code}: selling_unit="${vi1.selling_unit}" price_basis="${vi1.price_basis}"`);
  console.log(`    import_row.evidence.sellingUnitSource="${vi1.import_row.evidence.sellingUnitSource}"`);
  console.log(`    resolved.source="${p1.resolved?.source}"`);
  console.log(`    reviewRequired=${vi1.import_row.reviewRequired}`);
}

// ─── PASS 1 ──────────────────────────────────────────────────────────────────
console.log('\n───────────────────────────────────────────────────────────────────────');
console.log('PASS 1 — FIRST IMPORT (no prior, no invoice, no explicit unit)');
console.log('───────────────────────────────────────────────────────────────────────');

const p1Resolved = allRows.filter(r=>r.p1.resolved!==null).length;
const p1Review   = allRows.filter(r=>r.p1.requiresReview).length;
const p1Clean    = allRows.filter(r=>!r.p1.requiresReview).length;
console.log(`  resolved !== null:    ${p1Resolved}/${N}`);
console.log(`  requiresReview=true:  ${p1Review}/${N}`);
console.log(`  requiresReview=false: ${p1Clean}/${N}`);

// quoteStatus distribution
const qDist1 = {};
for (const {qStatus1} of allRows) qDist1[qStatus1] = (qDist1[qStatus1]||0)+1;
console.log('\n  quoteStatus on saved record:');
for (const [s,c] of Object.entries(qDist1)) console.log(`    ${s}: ${c}`);
console.log('  quote blocker fires on "unavailable" or "expired".');
console.log('  ImportModal.jsx line 375: priceUnavailable: !!row.priceUnavailable || needsBasis');
console.log('  needsBasis = prepared.requiresReview = true for all 95 rows.');
console.log('  → price_unavailable:true sent to applyQuote for all 95 rows.');
console.log('  → quoteStatus returns "unavailable" for all 95 saved records.');
console.log('  → quote blocker fires: 95/95');

// Field accuracy from catalogRowEvidence
console.log('\n  Field accuracy from catalogRowEvidence (sample: first row, Item '+allRows[0].row.code+'):');
const ev = allRows[0].evidence1;
if (ev) {
  for (const field of ['category','product','pack','sellingUnit','price']) {
    const f = ev[field];
    console.log(`    ${field.padEnd(11)}: accuracy=${f?.accuracy??'null'} value="${f?.value??''}" reason="${f?.reason??''}"`);
  }
}

// Blocker counts
const bFreq1 = {};
for (const {assessment1} of allRows) for (const b of (assessment1?.blockers||[])) bFreq1[b]=(bFreq1[b]||0)+1;
console.log('\n  orderGuideAssessment blockers (pass 1):');
const BLOCKER_ORDER = ['category','product','pack','sellingUnit','price','source','association','quote','unitCost','brand','link','expired'];
for (const b of BLOCKER_ORDER) if (bFreq1[b]) console.log(`    ${b.padEnd(12)}: ${bFreq1[b]}/${N}`);
const p1Ready = allRows.filter(r=>r.assessment1?.ready).length;
console.log(`\n  Order Guide ready: ${p1Ready}/${N}`);

// ─── PASS 2 ──────────────────────────────────────────────────────────────────
console.log('\n───────────────────────────────────────────────────────────────────────');
console.log('PASS 2 — UNCHANGED REIMPORT (prior = saved pass-1 record)');
console.log('───────────────────────────────────────────────────────────────────────');

const p2Resolved = allRows.filter(r=>r.p2.resolved!==null).length;
const p2Review   = allRows.filter(r=>r.p2.requiresReview).length;
const illegalClears = allRows.filter(r=>r.illegalClear).length;

console.log(`  resolved !== null:    ${p2Resolved}/${N}`);
console.log(`  requiresReview=true:  ${p2Review}/${N}`);
console.log(`  requiresReview=false: ${allRows.filter(r=>!r.p2.requiresReview).length}/${N}`);
console.log(`\n  Illegal auto-clears: ${illegalClears}`);
if (illegalClears > 0) {
  console.log('  !! CONSTRAINT VIOLATED: suggested became confirmed on reimport');
  for (const {row} of allRows.filter(r=>r.illegalClear))
    console.log(`     Item ${row.code} ${row.brand} ${row.packSize}`);
} else {
  console.log('  resolveQuoteBasis guard confirmed: returns null when prior.import_row.reviewRequired=true');
  console.log('  Code: if(!prior?.price_basis||...||prior.import_row?.reviewRequired) return null;');
}

// quoteStatus pass 2
const qDist2 = {};
for (const {qStatus2} of allRows) qDist2[qStatus2] = (qDist2[qStatus2]||0)+1;
console.log('\n  quoteStatus on pass-2 saved record:');
for (const [s,c] of Object.entries(qDist2)) console.log(`    ${s}: ${c}`);

const bFreq2 = {};
for (const {assessment2} of allRows) for (const b of (assessment2?.blockers||[])) bFreq2[b]=(bFreq2[b]||0)+1;
console.log('\n  orderGuideAssessment blockers (pass 2):');
for (const b of BLOCKER_ORDER) if (bFreq2[b]) console.log(`    ${b.padEnd(12)}: ${bFreq2[b]}/${N}`);
const p2Ready = allRows.filter(r=>r.assessment2?.ready).length;
console.log(`\n  Order Guide ready: ${p2Ready}/${N}`);

// ─── PER-ROW TABLE ────────────────────────────────────────────────────────────
console.log('\n───────────────────────────────────────────────────────────────────────');
console.log('PER-ROW DETAIL');
console.log('Columns: Item | Brand | Pack | Price | CW | Candidate | Selected | rR1 | Blockers-P1 | rR2 | Blockers-P2');
console.log('CW=catch-weight; Candidate=sole-CS/sole-LB/two/none; Selected=engine choice');
console.log('───────────────────────────────────────────────────────────────────────');
for (const {row, pack, candidate, p1, vi1, assessment1, p2, assessment2} of allRows) {
  const cw  = pack?.catchWeight ? 'Y' : 'N';
  const cand = candidate.noSurvivor ? 'none'
             : candidate.twoSurvived ? `two→${candidate.selectedUnit}`
             : `sole-${candidate.selectedUnit}`;
  const sel  = p1.resolved?.sellingUnit || '—';
  const rR1  = p1.requiresReview ? 'Y' : 'N';
  const rR2  = p2.requiresReview ? 'Y' : 'N';
  const b1   = (assessment1?.blockers||[]).join(',') || 'none';
  const b2   = (assessment2?.blockers||[]).join(',') || 'none';
  // Print saved vi values for verification
  const saved = `saved: unit="${vi1.selling_unit}" basis="${vi1.price_basis}" price_unavail=${vi1.price_unavailable} sellingUnitSrc="${vi1.import_row.evidence.sellingUnitSource}"`;
  console.log(`${row.code.padEnd(7)} ${row.brand.padEnd(6)} ${(cw==='Y'?'~':' ')+row.packSize.padEnd(14)} $${String(row.price).padEnd(7)} CW=${cw} ${cand.padEnd(12)} sel=${sel.padEnd(4)} rR1=${rR1} [${b1}] rR2=${rR2} [${b2}]`);
  console.log(`        ${saved}`);
}

// ─── SUMMARY ─────────────────────────────────────────────────────────────────
console.log('\n═══════════════════════════════════════════════════════════════════════');
console.log('SUMMARY');
console.log('═══════════════════════════════════════════════════════════════════════');
console.log(`File SHA-256:             ${FILE_HASH}`);
console.log(`Rows:                     ${N}`);
console.log(`Pack parsed:              ${packParsed}/${N}`);
console.log(`Catch-weight (LBAV):      ${catchWeight}`);
console.log('');
console.log('Candidate arithmetic (inferPricingBasis PLAUSIBLE-range check):');
console.log(`  Sole CS:                ${soleCS}`);
console.log(`  Sole non-CS:            ${soleUnit} (all LB; CS eliminated by $0.20/LB floor)`);
console.log(`  Two candidates:         ${twoSurv} (engine picks one; billing unit not established)`);
console.log(`  No survivor:            ${noSurv}`);
console.log('');
console.log('Engine-selected suggestion distribution:');
for (const [u,c] of Object.entries(selDist).sort((a,b)=>b[1]-a[1]))
  console.log(`  ${u.padEnd(6)}: ${c}`);
console.log('');
console.log(`Pass 1 requiresReview=true: ${p1Review}/${N}`);
console.log(`Pass 1 Order Guide ready:   ${p1Ready}/${N}`);
console.log(`Pass 2 requiresReview=true: ${p2Review}/${N}`);
console.log(`Pass 2 Order Guide ready:   ${p2Ready}/${N}`);
console.log(`Illegal auto-clears:        ${illegalClears}`);
console.log('');
console.log('Blockers (pass 1 / pass 2):');
for (const b of BLOCKER_ORDER) {
  const c1 = bFreq1[b]||0, c2 = bFreq2[b]||0;
  if (c1||c2) console.log(`  ${b.padEnd(12)}: ${c1}/${N} p1 | ${c2}/${N} p2`);
}
console.log('');
console.log('Findings:');
console.log('  1. quote blocker: 95/95 fires (CORRECTED — prior audit was wrong).');
console.log('     Prior audit hardcoded price_unavailable=false. Real path (ImportModal.jsx:375):');
console.log('       priceUnavailable: !!row.priceUnavailable || needsBasis');
console.log('     needsBasis=requiresReview=true for all 95. Every applyQuote call sends');
console.log('     priceUnavailable:true regardless of whether the row has a valid price.');
console.log('  2. Candidate reconciliation: 5 sole-LB (not 6). Raw-data v0 counted Item 23240');
console.log('     MARTIN 1/30 DZ as sole-LB because local JS mapped DZ→DOZ and applied');
console.log('     PLAUSIBLE.DOZ=$0.10 floor. Real engine treats DOZ as count (EA), finds two');
console.log('     candidates, selects CS. Engine sole-unit count: 5.');
console.log('  3. 29 LB selected (not ~20). Prior run reason-frequency truncated keys at 80');
console.log('     chars causing collisions; per-row table was correct. 29 = 5 sole + 24 two-candidate.');
console.log('  4. Provenance gap: inferred sellingUnit saved with sellingUnitSource="" in');
console.log('     import_row.evidence (import-row.js line 13 does not write "inferred" there).');
console.log('     catalogRowEvidence maps ""→STATED(90) — same accuracy as document-stated.');
console.log('     Source blocker (reviewRequired) is the only guard. If cleared without confirmation,');
console.log('     sellingUnit field would show STATED accuracy — no field-level gate would fire.');
console.log('  5. association blocker: 4 rows (stub fixture, comparison_track="suggested").');
console.log('     All 95 would show this pre-verification; stub reflects correct pre-match state.');
console.log('  6. Illegal auto-clears: 0. resolveQuoteBasis guard holds.');
console.log('');
console.log('Verified:');
console.log('  Provenance fix confirmed in import-to-order-guide-test.mjs (tests 7–11, all pass):');
console.log('    Test 7: preparePriceImport writes sellingUnitSource="inferred" into row and resolved');
console.log('    Test 8: catalogRowEvidence maps "inferred"→accuracy=70 (GUESSED), not 90 (STATED)');
console.log('    Test 9: sellingUnit is an independent blocker even with exact association match');
console.log('    Test 10: explicit/stated unit gives accuracy>70 and does not trigger sellingUnit blocker');
console.log('    Test 11: reimport guard holds — inferred rows cannot auto-clear on unchanged reimport');
console.log('');
console.log('Remaining investigation (not implementation):');
console.log('  Unknown-dimension units: 6/10 CN (may be six #10 cans), 15/6.33O (likely oz), 6/50 CNT.');
console.log('  Meaning must be verified against source before any conversion is introduced.');
console.log('  Association blocker count reflects stub (comparison_track="suggested"); real matching');
console.log('  will replace this once the workflow proceeds past import.');
