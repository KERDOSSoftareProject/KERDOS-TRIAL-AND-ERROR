/**
 * PRICING BASIS INFERENCE
 *
 * Determines what a vendor's quoted price covers when no explicit selling
 * unit is stated on the document.
 *
 * Three output levels:
 *   supported   — two independent signals agree, no conflicts.
 *                 Auto-populated. No client action needed.
 *   suggested   — plausible but not confirmed.
 *                 Show the proposed basis with reason. Client confirms.
 *   conflicting — signals disagree or price is implausible.
 *                 Show alternatives and request selection.
 *
 * Hard rules:
 *   - Pack structure narrows choices. It does not confirm.
 *   - Product type priors come from the active industry vocabulary, not
 *     from hardcoded lists in this module.
 *   - Price plausibility eliminates candidates. Plausibility alone does
 *     not confirm.
 *   - When two bases remain plausible, show both for review. Never pick
 *     a winner silently.
 *   - Prior confirmed basis is the strongest evidence; only reused when
 *     the item matches and reviewRequired is not set.
 */

import {parsePackSize} from '../procurement.js';
import {productTypePriors} from '../knowledge/category-profiles.js';

// ── Plausibility ranges by unit ───────────────────────────────────────────────
// These define the plausible per-unit range for a given dimension unit.
// A price outside this range is implausible as a per-unit price.
// Ranges are intentionally wide — implausibility is a strong signal, not a
// tight bound. Do not tighten these ranges to force a winner.

const PLAUSIBLE = {
  LB:  [0.20,  500],   // per pound: $0.20–$500
  KG:  [0.40, 1000],   // per kilogram
  OZ:  [0.02,   40],   // per ounce
  GAL: [0.50,  300],   // per gallon
  QT:  [0.15,  100],   // per quart
  PT:  [0.10,   60],   // per pint
  DOZ: [0.10,  200],   // per dozen (eggs, rolls, etc.)
  EA:  [0.01, 1000],   // per each
};

function inRange(unit, value) {
  const r = PLAUSIBLE[unit];
  if (!r) return value > 0;
  return value >= r[0] && value <= r[1];
}

// ── Main inference function ───────────────────────────────────────────────────

export function inferPricingBasis(row) {
  const price = Number(row.price);
  const desc  = String(row.description || '').toLowerCase();
  const pack  = parsePackSize(row.packSize);

  const evidence  = [];

  // ── 1. Pack required ──────────────────────────────────────────────────────
  // Note: prior confirmed basis is handled by resolveQuoteBasis before this
  // function is called. inferPricingBasis is inference-only: pack structure,
  // product type priors, and price mathematics. It never returns 'supported'.
  if (!pack?.parsed) {
    return {
      level: 'conflicting', basis: null, sellingUnit: null,
      reason: 'Pack is missing or unreadable — cannot infer pricing basis',
      evidence: [], conflicts: ['No parseable pack size'],
    };
  }

  if (!Number.isFinite(price) || price <= 0) {
    return {
      level: 'conflicting', basis: null, sellingUnit: null,
      reason: 'Price is zero or missing — cannot infer basis',
      evidence: [], conflicts: ['No valid price'],
    };
  }

  const dim     = pack.dimension;   // 'mass'|'volume'|'count'|'length'|'unknown'
  const caseQty = pack.caseQty;     // outer count (e.g. 4 in "4/1 GAL")
  const total   = pack.total;       // total base units (e.g. 40 for "4/10 LB")
  const unit    = pack.unit;        // base unit (e.g. 'LB', 'GAL', 'DOZ')

  // ── 2. Product type priors from industry vocabulary ───────────────────────
  const {weightPriced, countPriced} = productTypePriors(desc);
  if (weightPriced) evidence.push('Product type is typically priced by weight (from industry vocabulary)');
  if (countPriced)  evidence.push('Product type is typically priced per each (from industry vocabulary)');

  // ── 3. Build candidate bases with plausibility checks ────────────────────
  const candidates = [];

  // Case basis: price covers the whole pack.
  // For weight/volume packs: check the implied per-unit cost is plausible.
  // $2.06 for 40 LB = $0.0515/LB — below the LB floor of $0.20 → not plausible.
  const casePlausible = (() => {
    if (dim === 'mass' && total && unit) {
      return inRange(unit, price / total);
    }
    if (dim === 'volume' && total && unit) {
      return inRange(unit, price / total);
    }
    if (dim === 'count' && total) {
      // For count packs, check per-inner-unit price
      return inRange('EA', price / total);
    }
    return price > 0;
  })();

  // Measure basis: price is per unit of measure (per LB, per GAL, per DOZ, etc.)
  const measureUnit = (() => {
    if (dim === 'mass') return unit;   // LB, KG, OZ
    if (dim === 'volume') return unit; // GAL, QT, PT
    if (dim === 'count' && unit === 'DOZ') return 'DOZ'; // per dozen
    return null;
  })();

  const measurePlausible = (() => {
    if (!measureUnit) return false;
    return inRange(measureUnit, price);
  })();

  // Each basis: price is per individual inner item.
  // Only applies when there is a meaningful outer count to divide by.
  const eachPlausible = (() => {
    if (!caseQty || caseQty <= 1) return false; // no outer count to divide by
    if (dim !== 'count') return false;           // only for count packs
    return inRange('EA', price / caseQty);
  })();

  // Build candidate descriptions with the arithmetic so the client sees the math
  const r2 = v => Math.round(v * 100) / 100;
  const caseDesc = (() => {
    if (dim === 'mass' && total && unit) return '$'+price+' for '+total+' '+unit+' ($'+r2(price/total)+'/'+unit+')';
    if (dim === 'volume' && total && unit) return '$'+price+' for '+total+' '+unit+' ($'+r2(price/total)+'/'+unit+')';
    if (dim === 'count' && total) {
      const unitLabel = unit || 'unit';
      // For dozen packs, show both the dozen count and the individual count
      const eggNote = (unit === 'DOZ') ? ' ('+total*12+' each)' : '';
      return '$'+price+' for '+total+' '+unitLabel+eggNote+' ($'+r2(price/total)+'/'+unitLabel+')';
    }
    return '$'+price+' for the pack';
  })();
  const measureDesc = measureUnit
    ? '$'+price+'/'+measureUnit+' (case total: $'+r2(price*(total||1))+')'
    : null;
  const eachDesc = (caseQty > 1)
    ? '$'+price+'/each (case total: $'+r2(price*caseQty)+')'
    : null;

  if (casePlausible)    candidates.push({basis:{basis:'case',unit:null},  sellingUnit:'CS',  signal:'case',  calc:caseDesc});
  if (measurePlausible) candidates.push({basis:{basis:'measure',unit:measureUnit}, sellingUnit:measureUnit, signal:'measure', calc:measureDesc});
  if (eachPlausible)    candidates.push({basis:{basis:'each',unit:null},  sellingUnit:'EA',  signal:'each',  calc:eachDesc});

  if (candidates.length === 0) {
    return {
      level: 'conflicting', basis: null, sellingUnit: null,
      reason: 'Price $' + price + ' is implausible under every basis for pack "' + row.packSize + '"',
      evidence, conflicts: ['$' + price + ' with pack "' + row.packSize + '" does not yield a plausible per-unit cost'],
    };
  }

  // ── 4. Resolve: single candidate ─────────────────────────────────────────
  // Plausibility and product type priors are useful clues. They do not prove
  // what the vendor charges for. Only a prior confirmed basis (handled above)
  // or explicit source evidence (handled by resolveQuoteBasis before this
  // function is called) can produce 'supported'. Everything else is 'suggested'.
  if (candidates.length === 1) {
    const c = candidates[0];
    const signals = [...evidence];

    return {
      level: 'suggested',
      basis: c.basis,
      sellingUnit: c.sellingUnit,
      reason: 'Suggested "' + c.sellingUnit + '": ' + (c.calc || 'plausible') + ' — confirm before ordering',
      evidence: signals,
      conflicts: [],
    };
  }

  // ── 5. Resolve: multiple candidates — show alternatives for review ────────
  // When two bases remain plausible, do not pick a winner silently.
  // Product type prior may suggest a preference but cannot override.
  if (candidates.length > 1) {
    // Product type prior creates a preference but not a confirmed winner
    let preferred = null;
    if (weightPriced && candidates.find(c => c.signal === 'measure')) {
      preferred = candidates.find(c => c.signal === 'measure');
      evidence.push('Product type prior favors weight basis — but case basis is also plausible');
    }
    const winner = preferred || candidates[0];
    const others = candidates.filter(c => c !== winner);
    const altList = others.map(c => '"' + c.sellingUnit + '"').join(' or ');

    return {
      level: 'suggested',
      basis: winner.basis,
      sellingUnit: winner.sellingUnit,
      reason: 'Suggested "' + winner.sellingUnit + '": ' + (winner.calc || '') + ' — but ' + altList + ' is also plausible. Confirm the correct basis.',
      evidence,
      conflicts: others.map(c => c.sellingUnit + ': ' + (c.calc || 'plausible')),
    };
  }

  return {
    level: 'conflicting', basis: null, sellingUnit: null,
    reason: 'Could not determine pricing basis from available evidence',
    evidence, conflicts: ['No basis could be inferred'],
  };
}
