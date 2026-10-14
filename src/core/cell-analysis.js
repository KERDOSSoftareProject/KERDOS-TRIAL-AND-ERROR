/**
 * CELL ANALYSIS ENGINE
 *
 * Principle: look at each cell as if its only job is to understand that one cell.
 * Every cell is analyzed independently — what could this value mean, and what
 * evidence supports that interpretation?
 *
 * Then evidence from all cells in a row is assembled to fill the KERDOS fields.
 *
 * Each interpretation has:
 *   field    — which KERDOS field this proposes to fill
 *   value    — the proposed value
 *   source   — where in the document ("cell A3", "description tail", etc.)
 *   strategy — which rule produced this interpretation
 *   evidence — supporting facts from the cell itself
 *   score    — 0–1: strength of this interpretation in isolation
 *
 * Evidence has an order:
 *   1. Explicit labeled source (column header says "Price" → that cell is price)
 *   2. Cross-cell verification (qty × price = line total)
 *   3. Supported deduction (cell looks like a money amount and sits in price column)
 *   4. Suggestion (cell could be a code but context is ambiguous)
 *
 * Two strategies reading the same signal count as ONE source of evidence.
 * Confidence reflects the strength and independence of evidence, not strategy count.
 */

import {parsePackSize, packFromDescription} from '../procurement.js';

// ── Helpers ──────────────────────────────────────────────────────────────────

function parseMoney(str) {
  if (str == null) return null;
  let cleaned = String(str).replace(/[$€£¥]/g, '').trim();
  // Accounting negatives: (12.50) means -12.50
  let negative = false;
  if (/^\(.*\)$/.test(cleaned)) { negative = true; cleaned = cleaned.slice(1,-1).trim(); }
  if (/^-?\d+,\d{1,2}$/.test(cleaned)) cleaned = cleaned.replace(',', '.'); // euro decimal
  else cleaned = cleaned.replace(/,/g, ''); // thousands separator
  // Price with embedded unit: $2.15/LB → 2.15. Return extracted unit separately.
  const unitMatch = cleaned.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*([a-zA-Z]+)/);
  if (unitMatch) { cleaned = unitMatch[1]; }
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  let n = parseFloat(cleaned);
  if (isNaN(n)) return null;
  return negative ? -Math.abs(n) : n;
}

const KNOWN_BRANDS = new Set([
  'tyson','sysco','usfoods','kraft','heinz','hunts','del monte','dole',
  'kens','ken\'s','hellmann\'s','hellmans','french\'s','frenchs',
  'campbells','campbell\'s','swanson','hormel','oscar mayer','land o lakes',
  'chobani','frito lay','nabisco','sara lee','pepperidge farm',
]);

const PREP_TERMS = new Set([
  'fresh','frozen','chilled','raw','cooked','smoked','cured','marinated',
  'breaded','battered','blanched','roasted','grilled','fried',
]);

const PACKAGING_TERMS = new Set([
  'cs','case','ea','each','pk','pack','bg','bag','bx','box',
  'ct','count','dz','dozen','lb','lbs','oz','gal','qt','pt',
  'bu','bushel','pail','drum','tub','pouch','jar','can','bottle',
]);

const SELLING_UNIT_TERMS = new Set(['cs','case','ea','each','lb','lbs','kg','gal','qt','bu']);

const ORIGIN_PATTERN = /^\(([A-Z]{2,3})\)$/;
const ITEM_CODE_PATTERN = /^[A-Z0-9][A-Z0-9\-\/\.]{2,15}$/i;
const GTIN_PATTERN = /^\d{8}$|^\d{12}$|^\d{13}$|^\d{14}$/;
const MFR_CODE_PATTERN = /^[A-Z]{1,5}-\d{2,8}$/i;

// ── Core cell interpreter ─────────────────────────────────────────────────────

/**
 * Analyze a single cell value and return all plausible interpretations,
 * each with a KERDOS field, proposed value, strategy, and evidence score.
 *
 * @param {string} rawValue  — the raw cell text
 * @param {object} context   — {headerHint, position, rowCells, colIndex}
 * @returns {Array<Interpretation>}
 */
export function analyzeCell(rawValue, context = {}) {
  const raw = String(rawValue ?? '').trim();
  if (!raw) return [];

  const {headerHint = '', position = 'unknown', rowCells = [], colIndex = -1} = context;
  const header = headerHint.toLowerCase().trim();
  const interpretations = [];

  // Helper to add an interpretation
  const propose = (field, value, strategy, evidence, score) => {
    if (value === null || value === undefined || value === '') return;
    interpretations.push({field, value, source: position, strategy, evidence, score});
  };

  // ── 1. PRICE ─────────────────────────────────────────────────────────────
  const moneyVal = parseMoney(raw);
  if (moneyVal !== null) {
    if (moneyVal === 0) {
      // Zero recognized but not a usable purchasing price — flag it.
      interpretations.push({field:'price',value:0,priceUnavailable:true,
        source:position,strategy:'zero-price',
        evidence:'price of 0 — likely a placeholder or not-available marker',score:0.40});
      return interpretations.sort((a,b)=>b.score-a.score);
    }
    // Header explicitly says price
    const priceHeader = /price|cost|rate/.test(header) && !/amount|total|ext(?:ended)?|line/.test(header);
    const yourPrice = /your\s*price|net\s*price|sell\s*price/.test(header);
    const listPrice = /list\s*price/.test(header);
    const pricePerUnit = /\/lb|\/oz|\/gal|\/ea|per\s*lb|per\s*case/.test(header);

    // Negative prices (credit memos, returns) are valid but must be flagged for review
    const isNegative = moneyVal < 0;
    if (isNegative) {
      interpretations.push({field:'price', value:moneyVal, requiresReview:true,
        source:position, strategy:'negative-price',
        evidence:`(${Math.abs(moneyVal)}) — accounting negative, credit or return`, score:0.85});
      return interpretations.sort((a,b)=>b.score-a.score);
    }
    if (yourPrice) propose('price', moneyVal, 'explicit-your-price', `header says "${headerHint}"`, 0.98);
    else if (pricePerUnit) {
      const unit = header.match(/\/(\w+)|per\s+(\w+)/)?.[1] || header.match(/per\s+(\w+)/)?.[1];
      propose('price', moneyVal, 'price-per-unit-header', `header "${headerHint}" implies price per ${unit}`, 0.92);
      propose('priceBasis', 'measure', 'price-per-unit-header', `header indicates measurement basis`, 0.92);
      if (unit) propose('sellingUnit', unit.toUpperCase(), 'price-per-unit-header', `header states unit: ${unit}`, 0.92);
    } else if (priceHeader && !listPrice) {
      propose('price', moneyVal, 'explicit-price-header', `header says "${headerHint}"`, 0.95);
      // If the raw cell contains an embedded unit (e.g. "$2.15/LB"), extract and propose it
      const embeddedUnit = raw.replace(/[$€£¥]/g,'').trim().match(/^-?\d+(?:\.\d+)?\s*\/\s*([a-zA-Z]+)/);
      if (embeddedUnit) {
        propose('sellingUnit', embeddedUnit[1].toUpperCase(), 'price-cell-embedded-unit',
          `"${raw}" contains price per ${embeddedUnit[1]}`, 0.88);
      }
    } else if (listPrice) {
      propose('price', moneyVal, 'list-price-header', `header says "${headerHint}" — lower priority`, 0.70);
    } else {
      // No header — score by position relative to other cells
      const numericPeers = rowCells.filter(c => parseMoney(c) !== null).length;
      // Last numeric cell in a row is most likely the unit price
      const isLastNumeric = colIndex === rowCells.reduce((last, c, i) => parseMoney(c) !== null ? i : last, -1);
      const score = isLastNumeric ? 0.72 : numericPeers === 1 ? 0.68 : 0.45;
      propose('price', moneyVal, 'numeric-position', `numeric value, position ${isLastNumeric ? 'last' : colIndex}`, score);
    }

    // Could also be quantity
    if (Number.isInteger(moneyVal) && moneyVal < 1000 && moneyVal > 0) {
      propose('qty', moneyVal, 'integer-could-be-qty', `integer ${moneyVal} — could be quantity`, 0.30);
    }
  }

  // ── 2. PACK SIZE ──────────────────────────────────────────────────────────
  const packResult = parsePackSize(raw);
  if (packResult?.parsed) {
    const packHeader = /pack|size|uom|unit|pkg/.test(header);
    const score = packHeader ? 0.95 : 0.80;
    const originalRaw = (packResult.originalRaw && packResult.originalRaw !== packResult.raw) ? packResult.originalRaw : raw;
    // originalRaw is metadata on the pack proposal — not a separate interpretation.
    interpretations.push({field:'pack', value:packResult.raw, originalRaw,
      source:position, strategy:'pack-parse',
      evidence:`"${raw}" parses as pack: ${packResult.eachStr}`, score});
  }

  // ── 3. DESCRIPTION / PRODUCT IDENTITY ────────────────────────────────────
  const isText = parseMoney(raw) === null && !parsePackSize(raw)?.parsed;
  if (isText && raw.length >= 3) {
    const descHeader = /desc|name|product|item\s*name/.test(header);
    const hasMultipleWords = raw.split(/\s+/).length >= 2;
    if (descHeader) {
      const cleanDesc = raw.replace(/\s{2,}/g, ' ').trim();
      propose('description', cleanDesc, 'explicit-description-header', `header says "${headerHint}"`, 0.95);
    } else if (hasMultipleWords && !PACKAGING_TERMS.has(raw.toLowerCase())) {
      const cleanDesc2 = raw.replace(/\s{2,}/g, ' ').trim();
      propose('description', cleanDesc2, 'multi-word-text', `multi-word text, likely description`, 0.65);
    }

    // Sub-analysis: preparation terms
    const prepWords = raw.toLowerCase().split(/\s+/).filter(w => PREP_TERMS.has(w));
    if (prepWords.length) {
      propose('preparation', prepWords.join(' '), 'prep-term', `preparation terms: ${prepWords}`, 0.80);
    }

    // Origin qualifier: (USA), (CAL), (NC)
    if (ORIGIN_PATTERN.test(raw)) {
      propose('origin', raw.replace(/[()]/g,''), 'origin-qualifier', `parenthetical origin code`, 0.85);
    }

    // Pack buried in description
    const embeddedPack = packFromDescription(raw);
    if (embeddedPack) {
      propose('pack', embeddedPack, 'pack-from-description', `pack found inside description`, 0.75);
      const descWithoutPack = raw.slice(0, raw.lastIndexOf(embeddedPack)).trim();
      if (descWithoutPack.length >= 2) {
        propose('description', descWithoutPack, 'description-after-pack-strip', `description after removing pack`, 0.75);
      }
    }
  }

  // ── 4. VENDOR ITEM CODE ───────────────────────────────────────────────────
  const codeHeader = /^(?:item\s*(?:no|#|number|code)|sku|code|cust\s*item|vendor\s*(?:no|code|item))/.test(header);
  if (codeHeader) {
    propose('code', raw, 'explicit-code-header', `header says "${headerHint}"`, 0.96);
  } else if (ITEM_CODE_PATTERN.test(raw) && /\d/.test(raw) && parseMoney(raw) === null) {
    // Looks like a code but no header — lower confidence
    propose('code', raw, 'code-pattern', `matches item code pattern`, 0.55);
  }

  // ── 5. GTIN / BARCODE ────────────────────────────────────────────────────
  if (GTIN_PATTERN.test(raw.replace(/\s/g, ''))) {
    const gtinHeader = /upc|gtin|ean|barcode/.test(header);
    propose('gtin', raw.replace(/\s/g, ''), 'gtin-pattern',
      `${raw.length}-digit barcode${gtinHeader ? ` (header: ${headerHint})` : ''}`,
      gtinHeader ? 0.97 : 0.82);
  }

  // ── 6. MANUFACTURER CODE ─────────────────────────────────────────────────
  if (MFR_CODE_PATTERN.test(raw)) {
    const mfrHeader = /mfr|mfg|manufacturer|part/.test(header);
    propose('manufacturerCode', raw, 'mfr-code-pattern',
      `matches manufacturer code pattern${mfrHeader ? ` (header: ${headerHint})` : ''}`,
      mfrHeader ? 0.95 : 0.65);
  }

  // ── 7. BRAND ─────────────────────────────────────────────────────────────
  const brandHeader = /brand|manufacturer|make/.test(header);
  const lowerRaw = raw.toLowerCase();
  if (brandHeader) {
    propose('brand', raw, 'explicit-brand-header', `header says "${headerHint}"`, 0.95);
  } else if (KNOWN_BRANDS.has(lowerRaw)) {
    propose('brand', raw, 'known-brand', `"${raw}" is a recognized brand name`, 0.85);
  } else if (isText && raw.split(/\s+/).length === 1 && raw.length >= 3 && raw.length <= 20
             && raw === raw.toUpperCase() && parseMoney(raw) === null) {
    // Single ALL-CAPS word could be a brand abbreviation
    propose('brand', raw, 'caps-brand-candidate', `single ALL-CAPS word, possible brand`, 0.30);
  }

  // ── 8. SELLING UNIT ──────────────────────────────────────────────────────
  const sellingHeader = /type|selling\s*unit|order\s*unit|quoted\s*per|uom|price\s*basis/.test(header);
  if (sellingHeader) {
    propose('sellingUnit', raw.toUpperCase(), 'explicit-unit-header', `header says "${headerHint}"`, 0.95);
  } else if (SELLING_UNIT_TERMS.has(raw.toLowerCase())) {
    propose('sellingUnit', raw.toUpperCase(), 'unit-term', `"${raw}" is a recognized selling unit`, 0.75);
  }

  // ── 9. QUANTITY ───────────────────────────────────────────────────────────
  const qtyHeader = /^(?:qty|quantity|count|ordered|delivered|dlv)/.test(header);
  if (qtyHeader && parseMoney(raw) !== null) {
    propose('qty', parseMoney(raw), 'explicit-qty-header', `header says "${headerHint}"`, 0.95);
  }

  // ── 10. LINE TOTAL (for cross-checking) ──────────────────────────────────
  const amountHeader = /amount|total|ext(?:ended)?|line\s*total/.test(header);
  if (amountHeader && parseMoney(raw) !== null) {
    propose('lineTotal', parseMoney(raw), 'explicit-amount-header', `header says "${headerHint}"`, 0.95);
  }

  // Sort by descending score so the best interpretation is first
  return interpretations.sort((a, b) => b.score - a.score);
}


// ── Row-level evidence assembly ───────────────────────────────────────────────

/**
 * Given all cells in a row with their per-cell interpretations,
 * assemble the best-supported values for each KERDOS field.
 *
 * Returns a resolved row with:
 *   - filled fields and their evidence
 *   - unresolved fields with the exact missing fact
 *   - conflicts where two cells propose different values for the same field
 */
export function resolveRow(cellInterpretations, headerCells = [], confirmedColIndices = null) {
  // All proposals across all cells
  const allProposals = cellInterpretations.flatMap((cell, colIndex) =>
    cell.interpretations.map(i => ({...i, colIndex, rawCell: cell.rawValue}))
  );

  const KERDOS_FIELDS = ['code','gtin','manufacturerCode','brand','description',
    'pack','price','priceBasis','sellingUnit','qty','lineTotal',
    'preparation','origin'];

  const resolved = {};
  const unresolved = [];
  const conflicts = [];

  // Build a definitive role map ONLY for confirmed columns (explicit header or client decision).
  // Inferred columns (data-shape guesses) must remain challengeable — their role
  // assignment is a best guess, not a constraint on what the cell can mean.
  const definitiveByCol = {};
  for (const cell of cellInterpretations) {
    // Only constrain this column if it was explicitly confirmed
    const isConfirmed = confirmedColIndices === null || confirmedColIndices.has(cell.colIndex);
    if (!isConfirmed) continue;
    const strong = cell.interpretations.find(i => i.score >= 0.90);
    if (strong) definitiveByCol[cell.colIndex] = strong.field;
  }

  for (const field of KERDOS_FIELDS) {
    const candidates = allProposals
      .filter(p => {
        // Secondary/derived fields (priceBasis, sellingUnit, etc.) can co-occur
        // with primary fields — don't suppress them based on column ownership.
        const secondaryFields = new Set(['priceBasis','sellingUnit','preparation','origin']);
        if (secondaryFields.has(field)) return p.field === field;
        // For primary fields: if this column definitively owns a different field, exclude
        const ownerField = definitiveByCol[p.colIndex];
        if (ownerField && ownerField !== field) return false;
        return p.field === field;
      })
      .sort((a, b) => b.score - a.score);

    if (!candidates.length) {
      // Field not found — report what's missing
      // description and price are required; pack is required for unit cost comparison
      if (['description', 'price', 'pack'].includes(field)) {
        unresolved.push({field, reason: `No cell proposed a value for ${field} — cannot calculate unit cost for comparison`});
      }
      continue;
    }

    const best = candidates[0];

    // Check for conflicts — two cells proposing different values at similar confidence
    const runner = candidates.find(c =>
      c.colIndex !== best.colIndex && Math.abs(c.score - best.score) < 0.2
      && String(c.value) !== String(best.value)
    );

    if (runner) {
      conflicts.push({
        field,
        winner: best,
        challenger: runner,
        note: `"${best.value}" (score ${best.score.toFixed(2)}) vs "${runner.value}" (score ${runner.score.toFixed(2)})`
      });
    }

    // Spread the full proposal — all metadata flags (priceUnavailable, requiresReview,
    // originalRaw) must survive to the consumers (ImportModal, Item Catalog).
    resolved[field] = {...best};
  }

  // Cross-check: qty × price should equal lineTotal if all three are present
  const resolvedPrice = resolved.price?.value;
  const resolvedQty = resolved.qty?.value;
  const resolvedTotal = resolved.lineTotal?.value;
  if (resolvedPrice && resolvedQty && resolvedTotal) {
    const calculated = Math.round(resolvedPrice * resolvedQty * 100) / 100;
    const actual = Math.round(resolvedTotal * 100) / 100;
    if (Math.abs(calculated - actual) > 0.02) {
      conflicts.push({
        field: 'price',
        winner: resolved.price,
        challenger: null,
        note: `qty(${resolvedQty}) × price(${resolvedPrice}) = ${calculated} but lineTotal = ${actual} — pricing basis may be per-unit not per-case`
      });
      // Do NOT overwrite the stated price. The conflict means we cannot resolve
      // automatically — both values are preserved and the row requires review.
      // The derivedUnitPrice is carried as a suggestion, not a replacement.
      const derivedUnitPrice = Math.round((resolvedTotal / resolvedQty) * 10000) / 10000;
      resolved._arithmeticConflict = {
        statedPrice: resolvedPrice,
        derivedUnitPrice,
        lineTotal: resolvedTotal,
        qty: resolvedQty,
        note: `qty(${resolvedQty}) × statedPrice(${resolvedPrice}) ≠ lineTotal(${resolvedTotal}). Derived per-unit: ${derivedUnitPrice}`
      };
      // Flag the price as requiring review — do not change its value
      if (resolved.price) resolved.price = {...resolved.price, requiresReview: true,
        evidence: resolved.price.evidence + ' — arithmetic conflict, see _arithmeticConflict'};
    }
  }

  return {resolved, unresolved, conflicts};
}


// ── Full row analysis (entry point for extractRow replacement) ────────────────

/**
 * Analyze all cells in a row using per-cell analysis, then resolve to KERDOS fields.
 * This replaces the column-map-then-read approach with evidence-first analysis.
 *
 * @param {string[]} cells       — raw cell values
 * @param {string[]} headerCells — header row cell values (same order)
 * @param {string}   priceHeader — the text of the price column header if known
 * @returns {{ resolved, unresolved, conflicts, cellAnalysis }}
 */
// Map from column role names (used in columnMap) to header keywords
// that analyzeCell recognizes. This bridges the internal role system to
// the header-hint vocabulary.
const ROLE_TO_HEADER_HINT = {
  price: 'Price', packSize: 'Pack', description: 'Description',
  code: 'Item#', brand: 'Brand', gtin: 'UPC', mfrCode: 'Mfr #',
  sellingUnit: 'Type', qty: 'Qty', amount: 'Extended Price',
  size_only: 'Size',
};

export function analyzeRow(cells, headerCells = [], priceHeader = '', confirmedColIndices = null) {
  const cellAnalysis = cells.map((rawValue, colIndex) => {
    const rawHint = headerCells[colIndex] || '';
    // Translate role names to recognizable header keywords ONLY for confirmed columns.
    // An inferred column (not in confirmedColIndices) gets no header hint — its proposals
    // must be scored on position and content, not on a fake explicit-header match.
    const isConfirmed = confirmedColIndices === null || confirmedColIndices.has(colIndex);
    const headerHint = isConfirmed ? (ROLE_TO_HEADER_HINT[rawHint] || rawHint) : '';
    const interpretations = analyzeCell(rawValue, {
      headerHint,
      position: `col${colIndex}`,
      rowCells: cells,
      colIndex,
    });
    return {rawValue, colIndex, headerHint, interpretations};
  });

  const {resolved, unresolved, conflicts} = resolveRow(cellAnalysis, headerCells, confirmedColIndices);
  return {resolved, unresolved, conflicts, cellAnalysis};
}

// Export analyzeCell as the primary entry point for testing
export default {analyzeCell, analyzeRow, resolveRow};
