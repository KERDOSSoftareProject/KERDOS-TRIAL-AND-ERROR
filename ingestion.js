// ════════════════════════════════════════════════════════════════════
import {applySourceUnits,documentQuoteUnit} from "./core/source-units.js";
import {pricingUnitHeader} from "./core/billing-unit-evidence.js";
import {analyzeRow} from "./core/cell-analysis.js";
import {measurement,normalizeGtin,normalizeManufacturerCode,packFromDescription,parsePackSize,normalizeMixedFraction} from "./procurement.js";
import {readHeaderLayout,applyLayoutAnswers,checkRowCells} from "./core/sheet-layout.js";
// KERDOS INGESTION MODULE
// ════════════════════════════════════════════════════════════════════
//
// PURPOSE
// Turns any pasted or dropped document (price list or invoice, in any
// vendor's format) into clean structured rows: description, code,
// quantity, unit price, line total.
//
// DESIGN
// Unlike the old line-by-line guessing, this works in four stages:
//   1. SNIFF STRUCTURE  — figure out how the document is delimited
//                          (tabs, commas, or fixed-width columns)
//   2. FIND HEADER       — locate the real header row, even if it's
//                          mid-document or oddly labeled
//   3. MAP COLUMNS       — match header text to meaning (description,
//                          qty, price, total, etc). If no header is
//                          found, fall back to profiling each column's
//                          data to infer its role.
//   4. EXTRACT ROWS      — read each data row using that structure,
//                          skipping page furniture (totals, addresses,
//                          disclaimers) rather than misreading it.
//
// Nothing here calls any AI or external service. It is plain,
// deterministic JavaScript — same input always produces same output.
//
// This module does NOT touch the database or the UI. It only turns
// text into structured data. The caller decides what to do with the
// result (show a review screen, save it, flag it, etc).
// ════════════════════════════════════════════════════════════════════


// ── Column roles we understand ─────────────────────────────────────
// Every column in a document gets matched to one of these, or "unknown".
const COLUMN_ROLES = {
  description: ["description", "desc", "product", "name", "item description", "product description", "product name", "item name"],
  code:        ["item no", "item#", "itm#", "item", "sku", "code", "cust item no", "item number", "item no.", "part no", "part number", "vendor item", "vendor code", "vendor no"],
  brand:       ["brand", "manufacturer", "make"],
  gtin:        ["upc", "gtin", "ean", "barcode", "bar code", "upc code", "upc/ean"],
  mfrCode:     ["mfr #", "mfg #", "mfr no", "mfg no", "mfr item", "mfg item", "manufacturer item", "manufacturer no", "manufacturer #", "manufacturer part", "mfr part", "part no", "part number", "model"],
  sellingUnit: ["type", "selling unit", "order unit", "quoted per", "price unit", "price uom", "pricing unit", "pricing basis", "price basis", "unit of sale"],
  qty:         ["qty", "quantity", "count", "ordered", "order qty", "ord qty", "delivered", "dlv", "dlvd"],
  packSize:    ["unit", "size", "pack", "uom", "pack size", "pk", "pkg", "package", "pack/size", "pack & size", "pack & size:", "package size", "unit size"],
  price:       ["price", "pr", "prc", "unit price", "cost", "unit cost", "rate", "your price", "net price", "sell price", "selling price", "quote price", "quoted price", "list price", "price/case", "price per case", "price/ea", "price/lb", "price/gal"],
  amount:      ["amount", "total", "ext", "extended", "ext price", "ext. price", "line total", "line amount", "extended price", "total price", "total amount"],
};

// Rows that are clearly not item data — invoice/pricelist "furniture".
const JUNK_ROW_PATTERNS = [
  /^page \d+ of \d+/i,
  /^total\b/i,
  /^subtotal\b/i,
  /^grand total/i,
  /^cash total/i,
  /^card total/i,
  /^signature/i,
  /^note:/i,
  /^terms:/i,
  /^ship to/i,
  /^sold to/i,
  /^tel:|^fax:/i,
  /^order\b/i,
  /^[A-Z]{1,4}:\s*$/,
  /perishable agricultural/i,
  /paca trust/i,
  /return policy/i,
];

// A narrower set — these genuinely mark "the item table has ended"
// (totals, signatures, legal disclaimers). Unlike the broader junk
// list above, these are only used to find where the table stops; a
// stray order-reference line or a bare unit-code label can appear in
// the middle of a table without meaning it's over.
const TABLE_END_PATTERNS = [
  /^total\b/i,
  /^subtotal\b/i,
  /^grand total/i,
  /^cash total/i,
  /^card total/i,
  /^signature/i,
  /^note:/i,
  /perishable agricultural/i,
  /paca trust/i,
  /return policy/i,
];

function isTableEndMarker(cells) {
  const joined = cells.join(" ").trim();
  return TABLE_END_PATTERNS.some(pat => pat.test(joined));
}


// ── Small utilities ─────────────────────────────────────────────────

function parseMoney(str) {
  if (str == null) return null;
  let cleaned = String(str).replace(/[$]/g, "").trim();
  // European decimal comma: "12,50" means 12.50 (not 12 thousands 50)
  // Detect: digits, single comma, 1-2 digits, end — no dot present
  if (/^-?\d+,\d{1,2}$/.test(cleaned)) cleaned = cleaned.replace(",", ".");
  else cleaned = cleaned.replace(/,/g, ""); // strip thousands separators
  // Accounting-style negatives — "(24.00)" meaning -24.00 — are common in
  // bookkeeper-produced spreadsheets (QuickBooks-style exports, manual
  // credit memos) even when nobody on staff would type an actual minus sign.
  let negative = false;
  if (/^\(.*\)$/.test(cleaned)) {
    negative = true;
    cleaned = cleaned.slice(1, -1).trim();
  }
  if (!/^-?\d+(\.\d+)?$/.test(cleaned)) return null;
  let n = parseFloat(cleaned);
  if (isNaN(n)) return null;
  if (negative) n = -Math.abs(n);
  return n;
}

// A non-technical worker very often types a price and its unit into the
// SAME cell instead of using separate columns — "$12.50 ea", "45.00/cs",
// "3.99/LB", "50.00 per case". The real number is always the leading
// token; everything after it is a qualifier, never part of the value.
// Deliberately kept separate from parseMoney (used for exact/strict
// checks like header scoring and column-role profiling, where a stray
// numeric-looking description shouldn't be mistaken for a price column) —
// this lenient version is only used once a column's role is already known
// to be price/amount/qty, at final row extraction.
function parseMoneyLenient(str) {
  if (str == null) return null;
  const exact = parseMoney(str);
  if (exact !== null) return exact;
  const s = String(str).trim();
  const m = s.match(/^\(?-?\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?/);
  if (!m || !m[0].trim()) return null;
  return parseMoney(m[0]);
}

function isJunkRow(cells) {
  const joined = cells.join(" ").trim();
  if (joined.length < 3) return true;
  return JUNK_ROW_PATTERNS.some(pat => pat.test(joined));
}


// ── Stage 1: Sniff document structure ───────────────────────────────
// Tries tab-split, comma-split, and multi-space-split on every line,
// and picks whichever delimiter gives the most CONSISTENT cell count
// across lines (a real table has the same number of columns row to
// row; noise doesn't).

function sniffDelimiter(lines) {
  const candidates = [
    { name: "tab", regex: /\t/ },
    { name: "comma", regex: /,(?=(?:[^"]*"[^"]*")*[^"]*$)/ },
    { name: "semicolon", regex: /;/ },
    { name: "pipe", regex: /\|/ },
    { name: "multispace", regex: /\s{2,}/ },
  ];

  let best = { name: null, consistency: -1 };

  // Exclude blank lines and address/noise lines from coverage measurement.
  // A vendor file with 7 lines of header noise + 3 data lines is still
  // a comma-delimited file — the noise shouldn't dilute the count.
  const substantiveLines = lines.filter(l => {
    const t = l.trim();
    if (t.length < 3) return false;                    // blank or near-blank
    if (/^[-=*#]{3,}$/.test(t)) return false;         // divider lines
    return true;
  });
  const denominator = substantiveLines.length || lines.length;

  for (const cand of candidates) {
    const linesWithDelim = substantiveLines.filter(l => cand.regex.test(l));
    // A real table uses this delimiter on most lines, not just a
    // scattered few (a handful of junk lines with incidental double
    // spaces shouldn't be mistaken for a whole tabular document).
    const coverage = linesWithDelim.length / denominator;
    if (coverage < 0.4) continue;  // lowered from 0.6 to handle noisy headers

    const counts = linesWithDelim.map(l => l.split(cand.regex).length);
    const modeCount = mostCommon(counts);
    const matchingRows = counts.filter(c => c === modeCount).length;
    const consistency = matchingRows / counts.length;

    if (modeCount >= 2 && (consistency > best.consistency ||
        (consistency === best.consistency && modeCount > (best.modeCount||0)))) {
      best = { name: cand.name, consistency, modeCount };
    }
  }

  // No reliable tabular delimiter — this is typical of text pulled out
  // of a PDF, where columns are just single spaces apart with no
  // consistent structure. We deliberately return null rather than
  // forcing a bad split; the caller switches to "freeform" mode instead
  // of pretending this is a table.
  if (best.consistency < 0.5) return null;
  return best.name;
}

function mostCommon(arr) {
  const freq = new Map();
  for (const v of arr) freq.set(v, (freq.get(v) || 0) + 1);
  let best = arr[0], bestCount = 0;
  for (const [v, c] of freq) if (c > bestCount) { best = v; bestCount = c; }
  return best;
}

function splitRow(line, delimiterName) {
  if (delimiterName === "tab") return line.split(/\t/);
  if (delimiterName === "semicolon") return line.split(/;/);
  if (delimiterName === "pipe") return line.split(/\|/);
  if (delimiterName === "comma") return line.split(/,(?=(?:[^"]*"[^"]*")*[^"]*$)/);
  return line.split(/\s{2,}/);
}

function cleanCell(cell) {
  const value=cell.trim();
  return value.startsWith('"')&&value.endsWith('"')?value.slice(1,-1).replace(/""/g,'"'):value;
}


// ── Stage 2: Find the header row ────────────────────────────────────
// Scores each of the first several rows on how "header-like" it is:
// mostly text, contains recognized header words, and its column count
// matches the most common column count in the document (meaning it's
// structurally part of the table, not a stray title line).

function scoreHeaderRow(cells, modeColumnCount) {
  if (cells.length < 2) return { score: 0, keywordHits: 0, numericCells: 0 };

  let score = 0;

  // Structural fit: does this row have the same number of columns
  // as most other rows in the document?
  if (cells.length === modeColumnCount) score += 3;

  // Keyword match: how many cells look like known header words?
  const allKeywords = Object.values(COLUMN_ROLES).flat();
  const keywordHits = cells.filter(cell => {
    const lower = cell.toLowerCase().trim();
    return allKeywords.some(kw => lower === kw || lower.includes(kw));
  }).length;
  score += keywordHits * 2;

  // Text-heaviness: headers are mostly words, not numbers.
  const numericCells = cells.filter(c => parseMoney(c) !== null).length;
  if (numericCells === 0) score += 1;

  return { score, keywordHits, numericCells };
}

function findHeaderRow(grid) {
  const columnCounts = grid.map(r => r.cells.length);
  const modeColumnCount = mostCommon(columnCounts);

  const searchLimit = Math.min(grid.length, 15);
  let best = { index: -1, score: 0 };

  for (let i = 0; i < searchLimit; i++) {
    const { score, keywordHits, numericCells } = scoreHeaderRow(grid[i].cells, modeColumnCount);
    // A single coincidental keyword inside an otherwise ordinary data row
    // — e.g. a hand-typed description like "1 pallet unit" containing the
    // word "unit" — must never be enough on its own to promote that row
    // to "header". Real headers almost always name 2+ recognizable
    // columns; the one-hit exception is only allowed when the row is
    // entirely non-numeric (still plausibly a genuine, if sparse, header).
    const eligible = keywordHits >= 2 || (keywordHits >= 1 && numericCells === 0);
    if (!eligible) continue;
    if (score > best.score) best = { index: i, score };
  }

  // Require a minimum score so we don't mistake a random line for
  // a header when the document genuinely has none.
  return best.score >= 4 ? best.index : -1;
}


// ── Stage 3: Map columns to roles ───────────────────────────────────

// Price columns ordered by preference. When multiple price columns exist,
// the first match in this list wins. "your price" beats "list price".
const PRICE_PRIORITY = ["your price","net price","sell price","selling price",
  "quote price","quoted price","unit price","price/case","price per case",
  "price","pr","prc","cost","unit cost","rate","list price"];

function mapColumnsFromHeader(headerCells) {
  const map = {};
  // Two-pass: first map all non-price roles, then apply price priority.
  const priceCandidates = [];
  headerCells.forEach((cell,idx)=>{
    const lower=cell.toLowerCase().trim().replace(/\s+/g," ");
    const choices=[];
    for(const [role,keywords] of Object.entries(COLUMN_ROLES)){
      if(role==="price")continue; // handle separately
      for(const kw of keywords){
        if(lower===kw||lower.includes(kw)) choices.push({role,score:kw.length+(lower===kw?100:0)});
      }
    }
    choices.sort((a,b)=>b.score-a.score);
    const chosen=choices.find(c=>map[c.role]===undefined);
    if(chosen)map[chosen.role]=idx;
    // collect price candidates — store full cell text for priority matching
    for(const kw of COLUMN_ROLES.price){
      if(lower===kw||lower.includes(kw)){priceCandidates.push({idx,kw,lower,exact:lower===kw});break;}
    }
  });
  // Pick the highest-priority price column by matching the FULL cell text
  if(priceCandidates.length){
    for(const preferred of PRICE_PRIORITY){
      const hit=priceCandidates.find(c=>c.lower===preferred||c.lower.includes(preferred));
      if(hit){map.price=hit.idx;break;}
    }
    if(map.price===undefined) map.price=priceCandidates[0].idx;
  }
  return map;
}

// Profiles each column's DATA (rather than its header text) to guess
// its role, based on shape: how numeric it is, how long the text is,
// etc. Used in two situations:
//   - no header row exists at all
//   - a header row exists, but its label doesn't match any known word
//     (e.g. Excel's generic "Column2" instead of "Price") — in that
//     case we only use this to fill in whatever roles are still
//     missing, not to override roles we already matched by name.
function profileColumns(grid, dataStartIndex) {
  const dataRows = grid.slice(dataStartIndex);
  const columnCount = mostCommon(dataRows.map(r => r.cells.length));
  const usableRows = dataRows.filter(r => r.cells.length === columnCount);
  if (!usableRows.length) return {};

  const activeRowCount=usableRows.filter(r=>r.cells.some(cell=>cell.trim())).length;
  const columnStats = [];
  for (let col = 0; col < columnCount; col++) {
    const values = usableRows.map(r => r.cells[col]).filter(v => v !== "");
    if (!values.length) continue;
    const numericValues = values.map(parseMoney).filter(v => v !== null);
    columnStats.push({
      col,
      coverage:values.length/activeRowCount,
      numericRatio: numericValues.length / values.length,
      avgLength: values.reduce((s, v) => s + v.length, 0) / values.length,
    });
  }

  const map = {};
  const numericCols = columnStats.filter(c => c.numericRatio > 0.6 && c.coverage >= 0.4);
  if (numericCols.length >= 2) {
    map.price = numericCols[numericCols.length - 2].col;
    map.amount = numericCols[numericCols.length - 1].col;
  } else if (numericCols.length === 1) {
    map.price = numericCols[0].col;
  }

  const textCols = columnStats.filter(c => c.numericRatio < 0.3);
  if (textCols.length) {
    const widest = textCols.reduce((a, b) => (b.avgLength > a.avgLength ? b : a));
    map.description = widest.col;
  }

  // An unlabeled workbook often places the product in the first column and
  // the purchasing size beside it. Infer size from repeated measurements,
  // never from a single row or a product-specific word.
  const sizeLike=value=>/\b\d+(?:\.\d+)?\s*(?:LB|LBS|OZ|GAL|GALLON|QT|PT|CT|COUNT|DOZ|EA|FT|IN|ML|KG|G)\b/i.test(value);
  const sizeColumns=columnStats.filter(c=>c.col!==map.description&&c.col!==map.price&&c.col!==map.amount)
    .map(c=>{const populated=usableRows.filter(r=>r.cells[c.col]?.trim());return {col:c.col,ratio:populated.length>=10?populated.filter(r=>sizeLike(r.cells[c.col])).length/populated.length:0};})
    .sort((a,b)=>b.ratio-a.ratio);
  if(sizeColumns[0]?.ratio>=0.5)map.packSize=sizeColumns[0].col;

  return map;
}

// Fills in any role the header-text pass didn't find, using the data
// profile — without overwriting anything already matched by name.
function fillMissingRolesFromData(columnMap, grid, dataStartIndex) {
  const usedColumns = new Set(Object.values(columnMap));
  const dataProfile = profileColumns(grid, dataStartIndex);

  const filled = { ...columnMap };
  for (const [role, col] of Object.entries(dataProfile)) {
    if (filled[role] !== undefined) continue;   // already matched by header text
    if (usedColumns.has(col)) continue;          // column already claimed by another role
    filled[role] = col;
    usedColumns.add(col);
  }
  return filled;
}


// ── Stage 4: Extract structured rows ────────────────────────────────

// A vendor sometimes lists a real product with no price yet - "N/A",
// "TBD", "call", "market price", a bare dash. That's not a parsing
// failure to report as an error - it's the vendor telling us pricing
// genuinely isn't available for that product right now. Recognized as
// an exact (not substring) match against the cell so it never
// misfires on a real description that happens to contain one of these
// words.
const NO_PRICE_MARKERS = new Set([
  "n/a","na","n.a.","tbd","tba","call","mp","market price","pending",
  "-","--","---","call for price","see rep","out of stock","discontinued",
]);
function isNoPricePlaceholder(str) {
  if (str == null) return false;
  const s = String(str).trim().toLowerCase().replace(/\.$/, "");
  return NO_PRICE_MARKERS.has(s);
}

// Spreadsheets turn a pack like "12/10" or "6/10" into a date before the
// file ever reaches KERDOS ("2025-12-10", "12/10/2025", "10-Dec"). When the
// pack column holds a date, the vendor almost certainly wrote outer/inner
// counts. The month and day are read back as that pack; the year is the
// spreadsheet's invention and is dropped. Anything that is not a date is
// returned untouched.
export function unmangleExcelDatePack(value){
  const text=String(value||"").trim();
  if(!text) return text;
  let m=text.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[ T]\d{2}:\d{2}(?::\d{2})?)?$/);           // 2025-12-10 00:00:00
  if(m) return `${Number(m[2])}/${Number(m[3])}`;
  m=text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/);                                        // 12/10/2025
  if(m) return `${Number(m[1])}/${Number(m[2])}`;
  const months={jan:1,feb:2,mar:3,apr:4,may:5,jun:6,jul:7,aug:8,sep:9,oct:10,nov:11,dec:12};
  m=text.match(/^(\d{1,2})-([A-Za-z]{3})(?:-\d{2,4})?$/);                                        // 10-Dec, 10-Dec-25
  if(m&&months[m[2].toLowerCase()]) return `${months[m[2].toLowerCase()]}/${Number(m[1])}`;
  m=text.match(/^([A-Za-z]{3})-(\d{1,2})(?:-\d{2,4})?$/);                                        // Dec-10
  if(m&&months[m[1].toLowerCase()]) return `${months[m[1].toLowerCase()]}/${Number(m[2])}`;
  return text;
}

// Two things a pack column often holds that are packs in the vendor's
// mind but not in KERDOS's grammar. A packaging word alone ("CASE",
// "BOX", "BAG") means one of that packaging with the contents unstated,
// which is exactly how produce and bulk goods are sold: it becomes
// "1 CASE". A bare whole number ("1000", "2500") in a pack column is a
// count of units: it becomes "1000 CT". Anything else is left as written.
const PACKAGING_ONLY=/^(case|cs|cse|box|bx|bag|bg|tub|pail|bucket|bkt|crate|crt|carton|ctn|flat|sack|drum|pallet|tray|sleeve|bundle|bdl|roll|rl|jug|can|jar|bottle|btl|piece|pc|pce|each|ea)\.?$/i;
export function normalizeColumnPack(value){
  const text=String(value||"").trim();
  if(!text) return text;
  if(PACKAGING_ONLY.test(text)) return `1 ${text.replace(/\.$/,"").toUpperCase()}`;
  if(/^\d{2,}$/.test(text)) return `${Number(text)} CT`;
  // Normalize mixed fractions: 1-1/9 BU → 1.111111 BU
  return normalizeMixedFraction(text);
}

function extractRow(cells, columnMap, priceHeader="", confirmedColIndices=null, sourceHeaders=[]) {
  const get = role => (columnMap[role] !== undefined ? cells[columnMap[role]] : undefined);

  const priceRaw = get("price");
  const amountRaw = get("amount");
  const price = parseMoneyLenient(priceRaw);
  const amount = parseMoneyLenient(amountRaw);

  const priceUnavailable = price === null && amount === null &&
    (isNoPricePlaceholder(priceRaw) || isNoPricePlaceholder(amountRaw));

  // A row needs at least one valid money value to be usable - UNLESS
  // it's a recognized "no price listed" placeholder, in which case the
  // product itself is still real and worth keeping, just flagged.
  if (price === null && amount === null && !priceUnavailable) return null;

  let description = (get("description") || "").trim();
  // If we don't know which column is the description, fall back to
  // the longest non-numeric, non-placeholder cell in the row.
  if (!description) {
    description = cells
      .filter(c => parseMoney(c) === null && !isNoPricePlaceholder(c))
      .sort((a, b) => b.length - a.length)[0] || "";
  }
  description = description.trim()
    .replace(/\s+\*{2,}[A-Z0-9]+\*{2,}/gi, '') // **NEW** **SPECIAL** flags — must run FIRST
    .replace(/\*+([^*]+)\*+/g, '$1')  // *ITEM* → ITEM (keep content)
    .replace(/\*+/g, '')               // remaining lone asterisks
    .replace(/\s{2,}/g, ' ')           // double spaces → single
    .trim();
  if (description.length < 2) return null;
  // A row whose description is itself a non-product line (fuel surcharge,
  // delivery fee etc) should be skipped even when it came from a CSV column.
  if (NON_PRODUCT_LINE.test(description.trim())) return null;

  const code = (get("code") || "").trim() || null;
  const brand = (get("brand") || "").trim() || null;
  const sellingUnit = (get("sellingUnit") || "").trim() || null;
  const gtin = normalizeGtin(get("gtin"));
  const manufacturerCode = normalizeManufacturerCode(get("mfrCode"));
  // The pack column wins; when it is empty, a pack written at the end of
  // the description is used and its origin recorded for review.
  const columnPack = normalizeColumnPack(unmangleExcelDatePack((get("packSize") || "").trim())) || null;
  // When no pack column exists, pull the pack from the description tail.
  // description is let so we can strip the pack text from it.
  const descriptionPackRaw = columnPack ? null : packFromDescription(description);
  let descriptionPack = null;
  if(descriptionPackRaw && !columnPack){
    descriptionPack = descriptionPackRaw;
    const packPos = description.lastIndexOf(descriptionPackRaw);
    if(packPos > 4) description = description.slice(0, packPos).replace(/[,\s]+$/, "").trim();
  }
  const packSize = columnPack || descriptionPack;
  const packSource = columnPack ? "column" : descriptionPack ? "description" : null;
  const qty = parseMoneyLenient(get("qty"));
  // Cells in columns the sheet never labeled (a brand, a grade, a type)
  // are kept with the row as details and shown in the item name as the
  // vendor wrote them. They are not a problem to resolve on import; the
  // engine may later place one in the brand box, and the client can
  // correct any of it in Item Catalog.
  let details=cells.map((value,index)=>({value:value.trim(),index}))
    .filter(cell=>cell.value&&!Object.values(columnMap).includes(cell.index)&&parseMoney(cell.value)===null&&!isNoPricePlaceholder(cell.value))
    .map(cell=>cell.value);
  // A row with no item code whose unlabeled cell looks like one ("X2700",
  // "1234567", "AB-100") gets that cell as its code; the engine says so.
  let rowCode=code;
  let codeSource=code?"column":null;
  if(!rowCode){
    const codeLike=details.find(detail=>/^[A-Z0-9][A-Z0-9\-\/\.]{2,15}$/i.test(detail)&&/\d/.test(detail)&&!/^\d+(?:\.\d+)?[/-]\d+(?:\.\d+)?$/.test(detail)&&!parsePackSize(detail)?.parsed);
    if(codeLike){rowCode=codeLike;codeSource="details";details=details.filter(detail=>detail!==codeLike);}
  }
  const fullDescription=[description,...details.filter(detail=>!description.toLowerCase().includes(detail.toLowerCase()))].join(" ").trim();
  const issues=[];

  // Run cell analysis to pick up flags and metadata the column-map path doesn't surface:
  // priceUnavailable (zero price), requiresReview (negative price), originalRaw on pack.
  // Build a header-hint array from the column map: each cell gets its role name as the hint.
  const roleByCol = Object.fromEntries(Object.entries(columnMap).map(([role,idx])=>[idx,role]));
  const headerHints = cells.map((_,i) => roleByCol[i] || '');
  const cellEvidence = analyzeRow(cells, headerHints, priceHeader, confirmedColIndices);
  const priceProposal = cellEvidence.resolved.price;
  const packProposal  = cellEvidence.resolved.pack;
  const finalPriceUnavailable = priceUnavailable || priceProposal?.priceUnavailable || false;
  const finalRequiresReview   = priceProposal?.requiresReview || false;
  const finalOriginalRaw      = packProposal?.originalRaw || null;
  // Preserve unresolved-field explanations and conflict details on the row so they
  // survive into importRow.evidence and are visible in Item Catalog.
  const cellUnresolved = cellEvidence.unresolved?.length ? cellEvidence.unresolved : null;
  const cellConflicts  = cellEvidence.conflicts?.length  ? cellEvidence.conflicts  : null;

  return applySourceUnits({
    code: rowCode,
    codeSource,
    brand,
    gtin,
    manufacturerCode,
    sellingUnit,
    sellingUnitHeader:sourceHeaders[columnMap.sellingUnit]||null,
    sellingUnitSource:sourceHeaders[columnMap.sellingUnit]?`header: ${sourceHeaders[columnMap.sellingUnit]}`:null,
    billingUnitEvidence:sellingUnit&&pricingUnitHeader(sourceHeaders[columnMap.sellingUnit])?{kind:'pricing-unit-header',header:sourceHeaders[columnMap.sellingUnit],unit:sellingUnit}:null,
    priceHeader,
    description: fullDescription.slice(0, 120),
    details,
    packSize,
    packSource,
    originalPackRaw: finalOriginalRaw,
    qty: qty !== null ? qty : null,
    price: price !== null ? price : amount,
    amount: amount !== null ? amount : price,
    priceUnavailable: finalPriceUnavailable,
    requiresReview: finalRequiresReview,
    cellUnresolved,
    cellConflicts,
    sourceLine:cells.join("\t"),
    issues,
  },{priceCell:priceRaw,priceHeader});
}


// Keep price and document metadata distinct. A bare integer in a date,
// item code, quantity, or pack cannot be interpreted as a monetary quote.
const METADATA_LINE = /^(?:from|to|cc|bcc|subject|sent|reply-to|invoice(?:\s*(?:no\.?|number|#|date))?|inv\s*#|date|delivery\s+date|due\s+date|phone|fax|email|bill\s+to|ship\s+to|purchase\s+order|po\s*#|account|customer|tax|balance|payment|subtotal|total|grand\s+total|page|thank\s+you|terms)\b\s*[:#-]?/i;

// Charges and fees that appear on price sheets but are not orderable products.
// Universal — not food-specific. A vendor calling it "FUEL LEVY" instead will still
// pass through; only clear non-product patterns are filtered.
// Only lines that are unambiguously not a purchasable item. "BOX LIME" is a product
// (a box of limes); "BOX TOMATOES" is a product. Remove BOX from this filter.
// When uncertain, flag for review rather than discard.
const NON_PRODUCT_LINE = /^(?:fuel\s+surcharge|surcharge|delivery\s+(?:fee|charge)|freight|shipping(?:\s+(?:fee|charge|cost))?|handling(?:\s+(?:fee|charge))?)\b/i;
function isDocumentMetadata(line){
  const t=line.trim();
  return METADATA_LINE.test(t)||NON_PRODUCT_LINE.test(t)||/^(?:https?:\/\/|www\.|@)/i.test(t);
}
function contextualFreeformRow(line){
  if(isDocumentMetadata(line)) return null;
  const labeled=extractLabeledFields(line);
  if(labeled){
    const result={...labeled,sourceLine:line,issues:[]};
    if(result.qty!=null&&line.match(/(?:total|amount|ext(?:ended)?)\s*[:#]/i)&&
       result.price!=null&&result.amount!=null&&Math.abs(result.qty*result.price-result.amount)>0.02){
      result.issues.push("Quantity x unit price does not equal the stated line total");
    }
    return result;
  }
  // Only literal currency or decimal amounts can be freeform prices;
  // otherwise "40 lb", "Invoice #8765", and dates become fictitious
  // quotations. Keep those undecidable lines for review instead.
  // Also detect parenthetical negatives: (12.50) — must be recognized before
  // the general money scan strips the parens away.
  const parenNegRe=/\((\$?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?)\)/g;
  const parenTokens=[...line.matchAll(parenNegRe)].map(m=>({
    raw:m[1], start:m.index, end:m.index+m[0].length, isParenNeg:true
  }));
  const money=[...parenTokens,...[...line.matchAll(/(?:^|[\s=:;,(])((?:\$\s*)?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(?=\s|$|[;,)\/])/g)]
    .map(m=>({raw:m[1],start:m.index+m[0].indexOf(m[1]),end:m.index+m[0].indexOf(m[1])+m[1].length}))
    .filter(t=>{
      // Skip tokens that are inside a paren-negative match we already captured
      if(parenTokens.some(p=>t.start>=p.start&&t.end<=p.end)) return false;
      return /[\$.]/.test(t.raw) && !/\d+[\/x]\d+/i.test(line.slice(Math.max(0,t.start-2),t.end+3));
    })]
    .sort((a,b)=>a.start-b.start);
  if(!money.length) return null;
  const prices=money.filter(t=>!/^\d{4}$/.test(t.raw)&&!/(?:\d{1,2}\/){1,2}\d{1,4}/.test(line.slice(Math.max(0,t.start-3),t.end+5)));
  if(!prices.length)return null;
  const chosen=prices[prices.length-1];
  const prior=prices.length>1?prices[prices.length-2]:null;
  const head=line.slice(0,prior?.start??chosen.start).trim().replace(/[,;:—–-]\s*$/,'').trim();
  if(head.length<3||!/[a-z]{2}/i.test(head)) return null;
  const qtyMatch=head.match(/^(\d+(?:\.\d+)?)\s+(?!lb\b|kg\b|oz\b|gal\b|ct\b)/i);
  const qty=qtyMatch?Number(qtyMatch[1]):null;
  const description=(qtyMatch?head.slice(qtyMatch[0].length):head).trim();
  if(!description||isDocumentMetadata(description)) return null;
  const price=Number((prior||chosen).raw.replace(/[$,\s]/g,''));
  const amount=Number(chosen.raw.replace(/[$,\s]/g,''));
  if(!Number.isFinite(price)||price<=0||price>1000000||!Number.isFinite(amount))return null;
  // Use full pack parser on the description tail. sourceLine is the unmodified original.
  let cfDescription=description;
  let cfPack=null;
  const cfPackStr=packFromDescription(description);
  let cfPackOriginal=null;
  if(cfPackStr){const cfIdx=normalizeMixedFraction(description)
    .lastIndexOf(cfPackStr);if(cfIdx>4){cfPack=cfPackStr;cfPackOriginal=description.slice(cfIdx).replace(/[.,\s]+$/,"").trim();cfDescription=description.slice(0,cfIdx).replace(/[,\s]+$/,"").trim();}}
  const issues=[];
  if(prior&&qty!=null&&Math.abs(qty*price-amount)>0.02)issues.push("Quantity x unit price does not equal the stated line total");
  if(!prior&&qty!=null&&qty>1)issues.push("Only one price is listed; unit price versus extended total is ambiguous");
  const priceToken=prior||chosen;
  const requiresReview=!!(priceToken.isParenNeg||chosen.isParenNeg)||undefined;
  const finalPrice=priceToken.isParenNeg?-Math.abs(Number(priceToken.raw.replace(/[$,\s]/g,''))):price;
  const finalAmount=chosen.isParenNeg?-Math.abs(Number(chosen.raw.replace(/[$,\s]/g,''))):amount;
  return {code:null,description:cfDescription.slice(0,120),packSize:cfPack,packSource:cfPack?"description":null,originalPackSize:cfPackOriginal||null,
    qty,price:finalPrice,amount:prior?finalAmount:null,priceUnavailable:false,requiresReview,sourceLine:line,issues};
}

function detectDocumentKind(text){
  const lines=String(text||'').split('\n');
  const top=lines.slice(0,25).join(' ');
  const invoice=/\binvoice\b|\bbill to\b|\bamount due\b|\bremit\b|order\s+acknowledgement|order\s+confirmation|purchase\s+order\s+receipt/i.test(top);
  const quote=/\b(?:price\s+(?:sheet|list|update|effective)|new\s+prices?|updated\s+prices?|quote|quotation|new\s+cost|new\s+pricing)\b/i.test(top);
  return invoice&&quote?'mixed':invoice?'invoice':quote?'pricelist':'unknown';
}

function findQuoteValidity(text){
  const top=String(text||'').split('\n').slice(0,30).join('\n');
  const lines=top.split('\n');
  for(const line of lines){
    if(!/\b(?:through|until|expires?|valid\s+(?:through|until|to))\b/i.test(line))continue;
    const endClause=line.split(/\b(?:through|until|expires?|valid\s+(?:through|until|to))\b/i).at(-1);
    const date=findDate('Date: '+endClause);
    if(date)return date;
  }
  return null;
}

function reviewUncertainRows(rows,documentKind){
  return rows.map(row=>{
    const issues=[...(row.issues||[])];
    if(documentKind==="invoice"){
      // An invoice line must be fully understood before it can touch a
      // quote; unlabeled cells on it still need a person.
      if(row.details?.length)issues.push(`Unlabeled invoice details need identification: ${row.details.join(" | ").slice(0,100)}`);
      if(row.qty==null)issues.push("Invoice quantity or selling unit could not be verified from the source line");
      if(!row.code&&/^\d+[\s\-]/.test(row.description||""))issues.push("Vendor item code may have been included in the product description");
      if(row.qty!=null&&row.amount!=null&&row.price!=null&&Math.abs(row.qty*row.price-row.amount)>0.02)
        issues.push("Invoice quantity, unit price and extended total do not reconcile");
    }else if(documentKind==="pricelist"&&row.amount!=null&&row.price!=null&&row.amount!==row.price){
      issues.push("Two different prices were read from one line; verify that adjacent columns were not combined");
    }
    return {...row,issues};
  });
}

// Service invoices often quote fractional rates (for example $0.099 per
// towel). The generic freeform money scanner only accepts cents and can
// silently turn that into $99. Read this layout by its column headings and
// reconcile each row; do not infer its structure from a vendor name.
function parseServiceInvoice(lines,text){
  const heading=lines.findIndex(line=>/\bMATERIAL\b.*\bDESCRIPTION\b.*\bFREQ\b.*\bEXCH\b.*\bQTY\b.*\bUNIT PRICE\b.*\bLINE TOTAL\b/i.test(line));
  if(heading<0)return null;
  const rows=[],skipped=[];
  const rowPattern=/^\s*([A-Z0-9-]{3,})\s+(.+?)\s+(\d{2})\s+([A-Z])\s+(\d+(?:\.\d+)?)\s+(\d+\.\d{3})\s+(\d+\.\d{2})\s*([YN])?\s*$/i;
  for(const line of lines.slice(heading+1)){
    if(/^\s*(?:SUBTOTAL|SALES TAX|TOTAL USD|Signature)\b/i.test(line))break;
    const match=line.match(rowPattern);
    if(!match){if(line.trim())skipped.push({line,reason:"Non-item or wrapped service detail"});continue;}
    const [,code,description,,exchange,quantity,rate,total]=match;
    const qty=Number(quantity),price=Number(rate),amount=Number(total);
    const issues=[];
    if(Math.abs(qty*price-amount)>0.011)issues.push("Service quantity and three-decimal rate do not reconcile with the line total");
    rows.push({code,description:description.trim(),packSize:null,qty,price,amount,sellingUnit:"service",exchange,
      priceUnavailable:false,sourceLine:line,issues});
  }
  return {mode:"service-invoice",headerFound:true,columnMap:{},rows,skipped,documentKind:"invoice",quoteValidUntil:findQuoteValidity(text)};
}

// Some invoices state an ordered/delivered count and a separate measured
// quantity for billing. Recognize the column roles, then use the selling
// unit's dimension; this applies equally to any trade and supplier.
function parseGoodsInvoice(lines,text){
  const heading=lines.findIndex(line=>/\bItem(?:\s*\/\s*Xref|\s*(?:No\.?|#))?\b.*\b(?:ORD|ORDERED)\b.*\b(?:DLV|DELIVERED)\b.*\b(?:UOM|UNIT)\b.*\bDescription\b.*\bPack\s*Size\b.*\b(?:Weight|Billed\s+Quantity)\b.*\bUnit\s*Price\b.*\b(?:Extended|Line\s+Total)\b/i.test(line));
  if(heading<0)return null;
  const rows=[],skipped=[];
  const rowPattern=/^\s*([A-Z0-9][A-Z0-9-]{2,})\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s+([A-Z][A-Z0-9]{1,7})\s+(.+?)\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})\s*$/i;
  const packPattern=/(?:^|\s)(\d+(?:\.\d+)?(?:\s*[-/x]\s*\d+(?:\.\d+)?)?\s*(?:#|LB|LBS|OZ|GAL|QT|CT|EA)\.?)(?=\s*$)/i;
  for(const line of lines.slice(heading+1)){
    if(/^\s*(?:SUBTOTAL|TOTAL|AMOUNT DUE|SIGNATURE)\b/i.test(line))break;
    const match=line.match(rowPattern);
    if(!match){if(line.trim())skipped.push({line,reason:"Non-item or wrapped invoice detail"});continue;}
    const [,code,ordered,delivered,uom,body,rawPrice,rawAmount]=match;
    const measure=measurement(1,uom),measuredUnit=measure?.dimension==="mass"||measure?.dimension==="volume"||measure?.dimension==="length";
    const weightMatch=measuredUnit?body.match(/\s+(\d+\.\d{2})\s*$/):null;
    const weightPart=weightMatch?Number(weightMatch[1]):null;
    const withoutWeight=weightMatch?body.slice(0,weightMatch.index).trim():body.trim();
    const packMatch=withoutWeight.match(packPattern);
    const packSize=packMatch?.[1]?.replace(/\.$/,'')||null;
    const description=packMatch?withoutWeight.slice(0,packMatch.index).trim():withoutWeight;
    const qty=measuredUnit?weightPart:Number(delivered);
    const price=Number(rawPrice.replaceAll(',','')),amount=Number(rawAmount.replaceAll(',',''));
    const issues=[];
    if(!description)issues.push('Product description could not be identified');
    if(!packSize)issues.push('Pack size needs review');
    if(measure?.dimension==="unknown"&&!/^(?:CS|CASE|BX|BOX|PK|PACK|CT|CARTON|PALLET)$/i.test(uom))issues.push('Selling unit is not recognized; verify the billed quantity basis');
    if(qty===null||!Number.isFinite(qty))issues.push('Measured billed quantity is missing for this selling unit');
    else if(Math.abs(qty*price-amount)>0.025)issues.push('Billed quantity and unit price do not reconcile with extended total');
    rows.push({code,description:description.slice(0,120),packSize,qty,orderedQty:Number(ordered),deliveredQty:Number(delivered),weight:weightPart,
      sellingUnit:uom.toUpperCase(),sellingUnitSource:'goods invoice billed UOM',
      billingUnitEvidence:{kind:'goods-invoice-billed-unit',header:'UOM',unit:uom.toUpperCase()},
      price,amount,priceBasis:measuredUnit?'measure':'selling-unit',
      priceUnavailable:false,sourceLine:line,issues});
  }
  return {mode:'goods-invoice',headerFound:true,columnMap:{},rows,skipped,documentKind:'invoice',quoteValidUntil:findQuoteValidity(text)};
}

// ── Freeform extraction (no reliable column delimiter) ──────────────
// PDF text commonly comes out as single-space-separated words with no
// consistent column structure — "6 GREENLEAF LETTUCE GREENLEAF 24CT
// (USA) 23.00 138.00" — a real table, but not one a delimiter can
// split cleanly. Instead of forcing it into fake columns, we read each
// line by its actual shape: numbers at the end are price/amount, an
// optional short code near the start, everything else is the
// description.

function findMoneyTokens(line) {
  // Two alternatives, tried in order at each position:
  //  1. A genuine negative number — minus sign preceded by start-of-line or
  //     whitespace, so a credit like "-12.50" is captured correctly without
  //     mistaking the dash inside a hyphenated code like "SKU-4821" for one.
  //  2. A plain positive number, matched anywhere (including right after
  //     punctuation like ";" or "," in a delimited row) — this must stay
  //     unrestricted or numbers in semicolon/comma-delimited cells stop
  //     matching entirely.
  // Also matches parenthetical negatives: (12.50) — common in credit lines and adjustments.
  const moneyRe = /(?:\(\$?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\))|(?:(?:^|(?<=\s))-\$?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\b)|(?:\$?\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?\b)/g;
  const isDigit = c => c >= "0" && c <= "9";
  // \d{1,3} can only match 3 digits at a time, so a longer run like a
  // 4-digit year ("2026") gets captured starting mid-number. Walk past
  // the full contiguous digit run in both directions before checking for
  // an adjacent slash, so date/ratio detection isn't fooled by that.
  function isSlashAdjacent(start, end) {
    let i = start - 1;
    while (i >= 0 && isDigit(line[i])) i--;
    if (line[i] === "/") return true;
    let j = end;
    while (isDigit(line[j])) j++;
    return line[j] === "/" && isDigit(line[j + 1]);
  }

  return [...line.matchAll(moneyRe)].map(m => {
    const start = m.index, end = m.index + m[0].length;
    // A number directly followed by "%" is a percentage, not a price
    // (e.g. "10% off" should never be read as a $10 line item).
    if (line[end] === "%") return null;
    // A number that's part of an NN/NN or NN/NN/NNNN slash notation is a
    // date (03/14/2026) or a ratio like ground beef's "80/20" fat content
    // — never a real price. Per-unit pricing like "5.99/lb" is still kept,
    // since what follows the slash there is a unit, not another digit.
    if (isSlashAdjacent(start, end)) return null;
    const isParenNegative = m[0].startsWith('(') && m[0].endsWith(')');
    const rawValue = isParenNegative ? '-' + m[0].slice(1,-1) : m[0];
    return {
      value: parseMoney(rawValue),
      index: start,
      length: m[0].length,
      raw: m[0],
      requiresReview: isParenNegative || undefined,
    };
  }).filter(t => t !== null && t.value !== null);
}

// Some invoices split a line's true extended price onto its own
// separate line just below the item's main details — a column that
// got pushed onto its own row by the document's layout. We stitch
// these back together before extraction, so the "last two numbers on
// the line = price, then amount" logic sees both values together.
function mergeBareDollarContinuations(lines) {
  const bareDollar = /^\$?\d{1,3}(?:,\d{3})*\.\d{2}$/;
  const merged = [];
  for (const line of lines) {
    const trimmed = line.trim();
    const prev = merged[merged.length - 1];
    if (
      bareDollar.test(trimmed) &&
      prev !== undefined &&
      !isJunkRow([prev]) &&
      findMoneyTokens(prev).length > 0
    ) {
      merged[merged.length - 1] = prev + " " + trimmed;
    } else {
      merged.push(line);
    }
  }
  return merged;
}


function extractRowFreeform(line) {
  const tokens = findMoneyTokens(line);
  if (tokens.length === 0) return null;

  // The rightmost money-looking number is the line total; the one
  // before it (if present) is the unit price — UNLESS that "price"
  // token is actually just the line's leading quantity. A bare integer
  // (no decimal point, no $ sign, no thousands comma) sitting at the
  // very start of the line, with nothing before it, is almost always
  // a quantity like "5 Swiss Cheese 5lb block  24.99" — not a second
  // real price. Only treat it as a genuine price if it looks like one.
  const amountTok = tokens[tokens.length - 1];
  let priceTok = amountTok;
  if (tokens.length >= 2) {
    const candidate = tokens[tokens.length - 2];
    const looksLikeCurrency = /[.$,]/.test(candidate.raw);
    const isLeadingBareNumber = !looksLikeCurrency && line.slice(0, candidate.index).trim() === "";
    if (!isLeadingBareNumber) priceTok = candidate;
  }

  if (amountTok.value === 0 || Math.abs(amountTok.value) > 1000000) return null;

  // Everything before the price token is candidate description text.
  let head = line.slice(0, priceTok.index).trim();

  // Strip up to two leading quantity numbers — some formats show an
  // ordered quantity and a separate shipped/adjustment quantity back
  // to back. Only the first is kept as the real quantity.
  let qty = null;
  for (let pass = 0; pass < 2; pass++) {
    const qtyMatch = head.match(/^(\d+(?:\.\d+)?)\s+/);
    if (!qtyMatch) break;
    if (pass === 0) qty = parseFloat(qtyMatch[1]);
    head = head.slice(qtyMatch[0].length);
  }

  // Strip a short unit-type token (CS, EA, LB, BX...) when it comes
  // right before the real item code, so it isn't mistaken for the
  // code itself.
  const unitTypeMatch = head.match(/^([A-Z]{2,4})\s+(?=[A-Z0-9]{4,})/);
  if (unitTypeMatch) {
    head = head.slice(unitTypeMatch[0].length);
  }

  // Strip a leading item code, e.g. "GREENLEAF LETTUCE GREENLEAF..."
  // A code looks like a short all-caps/alphanumeric token immediately
  // followed by more descriptive text.
  let code = null;
  const codeMatch = head.match(/^([A-Z0-9\-]{3,14})\s+/);
  if (codeMatch) {
    code = codeMatch[1];
    head = head.slice(codeMatch[0].length);
  }

  const description = head.trim();
  if (description.length < 2) return null;

  // A parenthetical token like (12.50) is a negative amount — preserve the
  // negative value and flag for review. Document context determines meaning.
  const priceRequiresReview = !!(priceTok.requiresReview || amountTok.requiresReview);
  return {
    code,
    description: description.slice(0, 120),
    packSize: null,
    qty,
    price: priceTok.value,
    amount: amountTok.value,
    requiresReview: priceRequiresReview || undefined,
  };
}


// Some PDFs place an item's code, or the tail end of a wrapped
// description, on its own line — visually part of the same row, but
// positioned slightly differently so our line-grouping sees it as
// separate. Before extracting rows, we merge any short, price-less
// line into the row it visually belongs to: any such "orphan" line
// appearing between one priced line and the next belongs to the row
// that came before it.
function mergeOrphanLines(lines) {
  const merged = [];
  let pendingBase = null;
  let pendingExtras = [];

  const flush = () => {
    if (pendingBase !== null) {
      merged.push([pendingBase, ...pendingExtras].join(" "));
      pendingBase = null;
      pendingExtras = [];
    }
  };

  for (const line of lines) {
    const hasMoney = findMoneyTokens(line).length > 0;
    const junk = isJunkRow([line]);

    if (junk) {
      flush();
      merged.push(line); // pass through untouched; filtered downstream
    } else if (hasMoney) {
      flush();
      pendingBase = line;
    } else if (pendingBase !== null) {
      pendingExtras.push(line); // orphan text belongs to the pending row
    } else {
      merged.push(line); // no row to attach to; left as-is
    }
  }
  flush();
  return merged;
}


// Even free-flowing PDF text usually has a real header line somewhere
// ("Qty Item no Description Price Amount") and a clear end ("Total",
// "Signature", disclaimers). We find both boundaries first, so we only
// ever extract from inside the actual item table — never from invoice
// numbers, phone numbers, zip codes, or footer text that happen to
// contain digits.
function findFreeformHeaderIndex(lines) {
  const allKeywords = Object.values(COLUMN_ROLES).flat();
  const searchLimit = Math.min(lines.length, 20);
  for (let i = 0; i < searchLimit; i++) {
    // A line that itself parses as a labeled data row (e.g. "Item: X
    // Qty: 5 Price: $10") is data, not a header — even though it
    // contains header-like keywords, it also has real values attached.
    if (extractLabeledFields(lines[i])) continue;
    const lower = lines[i].toLowerCase();
    const hits = allKeywords.filter(kw => lower.includes(kw)).length;
    if (hits >= 3) return i;
  }
  return -1;
}


// ── Date detection ───────────────────────────────────────────────────
// Finds the invoice/document date, handling several common formats,
// by scanning near the top of the document (where dates typically
// appear) and normalizing to YYYY-MM-DD. Prefers dates that sit near
// a relevant word ("date", "invoice", "delivered", "ship") over any
// other date-looking number nearby (e.g. a phone number fragment).

const MONTH_NAMES = {
  jan:1, january:1, feb:2, february:2, mar:3, march:3, apr:4, april:4,
  may:5, jun:6, june:6, jul:7, july:7, aug:8, august:8,
  sep:9, sept:9, september:9, oct:10, october:10, nov:11, november:11,
  dec:12, december:12,
};

function pad2(n) { return String(n).padStart(2, "0"); }

function isValidDate(y, m, d) {
  return y >= 2000 && y <= 2100 && m >= 1 && m <= 12 && d >= 1 && d <= new Date(Date.UTC(y,m,0)).getUTCDate();
}

function findDate(text) {
  const lines = text.split("\n").slice(0, 30);
  const monthPattern = "jan|january|feb|february|mar|march|apr|april|may|jun|june|jul|july|aug|august|sep|sept|september|oct|october|nov|november|dec|december";

  const patterns = [
    { re: /\b(20\d{2})[\/\-](\d{1,2})[\/\-](\d{1,2})\b/g,
      toISO: m => isValidDate(+m[1], +m[2], +m[3]) ? `${m[1]}-${pad2(m[2])}-${pad2(m[3])}` : null },
    { re: /\b(\d{1,2})[\/\-](\d{1,2})[\/\-](20\d{2})\b/g,
      toISO: m => isValidDate(+m[3], +m[1], +m[2]) ? `${m[3]}-${pad2(m[1])}-${pad2(m[2])}` : null },
    { re: new RegExp(`\\b(${monthPattern})\\.?\\s+(\\d{1,2}),?\\s+(20\\d{2})\\b`, "gi"),
      toISO: m => { const mo = MONTH_NAMES[m[1].toLowerCase()]; return mo && isValidDate(+m[3], mo, +m[2]) ? `${m[3]}-${pad2(mo)}-${pad2(m[2])}` : null; } },
    { re: new RegExp(`\\b(\\d{1,2})\\s+(${monthPattern})\\.?,?\\s+(20\\d{2})\\b`, "gi"),
      toISO: m => { const mo = MONTH_NAMES[m[2].toLowerCase()]; return mo && isValidDate(+m[3], mo, +m[1]) ? `${m[3]}-${pad2(mo)}-${pad2(m[1])}` : null; } },
  ];

  const candidates = [];
  lines.forEach((line, idx) => {
    for (const pat of patterns) {
      pat.re.lastIndex = 0;
      let m;
      while ((m = pat.re.exec(line))) {
        const iso = pat.toISO(m);
        if (iso) {
          const nearKeyword = /date|invoice|delivered|ship/i.test(line);
          candidates.push({ iso, lineIndex: idx, nearKeyword });
        }
      }
    }
  });

  if (!candidates.length) return null;

  candidates.sort((a, b) => {
    if (a.nearKeyword !== b.nearKeyword) return a.nearKeyword ? -1 : 1;
    return a.lineIndex - b.lineIndex;
  });

  return candidates[0].iso;
}


// ── Invoice number detection ────────────────────────────────────────
// Looks near the top of the document for something labeled as the
// invoice number ("Invoice #4821", "INVOICE 330228", "Inv No: X-99").
// Works off the label itself, not any particular vendor's format.

function findInvoiceNumber(text) {
  const lines = text.split("\n").slice(0, 20);
  const patterns = [
    /\binvoice[\.\-]?\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-]{2,14})\b/i,
    /\binv(?!oice)[\.\-]?\s*(?:no\.?|number|#)?\s*[:\-]?\s*([A-Z0-9][A-Z0-9\-]{2,14})\b/i,
  ];
  const nonAnswers = /^(date|no|number|for|the|price|amount|list)$/i;

  for (const line of lines) {
    for (const pat of patterns) {
      const m = line.match(pat);
      if (m && !nonAnswers.test(m[1])) {
        return m[1];
      }
    }
  }
  return null;
}


// ── Inline-labeled-field extraction ─────────────────────────────────
// Some documents have no real header row at all, because whoever made
// them typed field labels directly into each line instead of using
// columns — e.g. "Item: Paper Towels Qty: 12 Price: $3.50". This reads
// a line by its explicit labels rather than guessing from position,
// which is more reliable than plain number-guessing whenever labels
// are actually present.
function extractLabeledFields(line) {
  const fieldPatterns = {
    code: /(?:sku|item\s*#|item\s*no\.?)\s*[:#]\s*([A-Z0-9\-]{2,15})/i,
    qty: /(?:qty|quantity)\s*[:#]\s*(\d+(?:\.\d+)?)/i,
    price: /(?:unit\s*price|price|cost)\s*[:#]\s*\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)/i,
    amount: /(?:total|amount|ext(?:ended)?(?:\s*price)?)\s*[:#]\s*\$?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?)/i,
    description: /(?:item|description|desc|product)\s*[:#]\s*(.+)/i,
  };

  const matches = {};
  let hits = 0;
  for (const [key, re] of Object.entries(fieldPatterns)) {
    const m = line.match(re);
    if (m) {
      const valueStart = m.index + m[0].indexOf(m[1]);
      matches[key] = { value: m[1].trim(), labelStart: m.index, valueStart };
      hits++;
    }
  }

  if (hits < 2) return null;

  const price = matches.price ? parseMoneyLenient(matches.price.value) : null;
  const amount = matches.amount ? parseMoneyLenient(matches.amount.value) : null;
  if (price === null && amount === null) return null;

  let description = matches.description ? matches.description.value : "";
  if (description && matches.description) {
    const laterLabelStarts = Object.entries(matches)
      .filter(([k]) => k !== "description")
      .map(([, v]) => v.labelStart)
      .filter(s => s > matches.description.valueStart);
    if (laterLabelStarts.length) {
      const cutoff = Math.min(...laterLabelStarts) - matches.description.valueStart;
      description = description.slice(0, cutoff);
    }
  }
  description = description.trim().replace(/[,;:]+$/, "");
  if (description.length < 2) return null;

  return {
    code: matches.code ? matches.code.value : null,
    description: description.slice(0, 120),
    packSize: null,
    qty: matches.qty ? parseFloat(matches.qty.value) : null,
    price: price !== null ? price : amount,
    amount: amount !== null ? amount : price,
  };
}


// ── Main entry point ─────────────────────────────────────────────────
//
// parseDocument(text) -> {
//   headerFound: boolean,
//   columnMap: { role: columnIndex, ... },
//   rows: [ { code, description, packSize, qty, price, amount }, ... ],
//   skipped: [ { line, reason }, ... ]   // for transparency in the review UI
// }

function parseDocumentRows(text, options={}) {
  const rawLines = text.split("\n").map(l => l.trimEnd()).filter(l => l.trim().length > 0);

  const serviceInvoice=parseServiceInvoice(rawLines,text);
  if(serviceInvoice)return serviceInvoice;
  const goodsInvoice=parseGoodsInvoice(rawLines,text);
  if(goodsInvoice)return goodsInvoice;

  const delimiter = sniffDelimiter(rawLines);

  // Informal emails have no table boundaries. Their subject, invoice
  // numbers and narrative cannot safely become product rows.
  if (delimiter===null && findFreeformHeaderIndex(rawLines)===-1) {
    // The header test above deliberately does not force a table: rows are
    // interpreted independently and every uncertain line stays visible.
    const rows=[],skipped=[];
    for(const line of rawLines){
      const row=contextualFreeformRow(line);
      if(row) rows.push(row);
      else skipped.push({line,reason:isDocumentMetadata(line)?"document metadata, not a product":"no unambiguous product and monetary price"});
    }
    const documentKind=detectDocumentKind(text);
    return {mode:"contextual",headerFound:false,columnMap:{},rows:reviewUncertainRows(rows,documentKind),skipped,documentKind,quoteValidUntil:findQuoteValidity(text)};
  }

  // ── FREEFORM MODE ──
  // No reliable column delimiter was found (typical of PDF-extracted
  // text). Read each line by its shape instead of forcing fake columns.
  if (delimiter === null) {
    const stitchedLines = mergeBareDollarContinuations(rawLines);
    const headerIdx = findFreeformHeaderIndex(stitchedLines);
    let dataStart = headerIdx !== -1 ? headerIdx + 1 : 0;

    // Junk can appear both before the real item table (addresses,
    // order-reference lines) and after it (totals, disclaimers). A
    // junk line only marks "the end" once real item data has actually
    // started — so first find where a genuine, parseable row begins.
    for (let i = dataStart; i < stitchedLines.length; i++) {
      if (isJunkRow([stitchedLines[i]])) continue;
      if (extractLabeledFields(stitchedLines[i]) || extractRowFreeform(stitchedLines[i])) {
        dataStart = i;
        break;
      }
    }

    // Now find where the item table ends: the first genuine end-marker
    // line after real data has begun (Total, Signature, disclaimers).
    // Ordinary noise (a stray order line, a bare unit label) can occur
    // mid-table without meaning the table has ended.
    let dataEnd = stitchedLines.length;
    for (let i = dataStart; i < stitchedLines.length; i++) {
      if (isTableEndMarker([stitchedLines[i]])) { dataEnd = i; break; }
    }

    const beforeCount = dataStart;
    const afterCount = stitchedLines.length - dataEnd;
    const itemLines = stitchedLines.slice(dataStart, dataEnd);
    const mergedLines = mergeOrphanLines(itemLines);

    const rows = [];
    const skipped = [];
    for (const line of mergedLines) {
      if (isJunkRow([line])) {
        skipped.push({ line, reason: "looks like a total/note/address line" });
        continue;
      }
      const row = extractLabeledFields(line) || extractRowFreeform(line);
      if (!row) {
        skipped.push({ line, reason: "couldn't find a valid price or description" });
        continue;
      }
      rows.push(row);
    }
    if (beforeCount > 0) {
      skipped.unshift({ line: `(${beforeCount} header/address lines before the item table)`, reason: "outside the item table" });
    }
    if (afterCount > 0) {
      skipped.push({ line: `(${afterCount} footer/note lines after the item table)`, reason: "outside the item table" });
    }
    const documentKind=detectDocumentKind(text);
    return { mode: "freeform", headerFound: headerIdx !== -1, columnMap: {}, rows:reviewUncertainRows(rows,documentKind), skipped, documentKind,quoteValidUntil:findQuoteValidity(text) };
  }

  // ── TABULAR MODE ──
  // A real, consistent delimiter was found — treat this as a proper
  // table with columns.
  const grid = rawLines.map(line => ({
    line,
    cells: splitRow(line, delimiter).map(cleanCell),
  }));

  const headerIndex = findHeaderRow(grid);
  const headerFound = headerIndex !== -1;
  const dataStart = headerFound ? headerIndex + 1 : 0;

  // Start with whatever the header text tells us (most reliable when
  // it's clearly labeled), then use the actual column data to fill in
  // any role the header didn't clearly name — covers both "no header
  // at all" and "header exists but is mislabeled" (e.g. "Column2").
  // Header first. The engine's own reading of the header row, then the
  // client's remembered answers for this vendor's layout on top of it,
  // and only then the data-shape guesses for whatever is still unnamed.
  const headerCells=headerFound?grid[headerIndex].cells:[];
  const engineMap=headerFound?mapColumnsFromHeader(headerCells):{};
  const answered=applyLayoutAnswers(engineMap,options.layoutAnswers||{});
  let columnMap = fillMissingRolesFromData(answered, grid, dataStart);
  // confirmedRoles: columns whose role is supported by explicit header text or client decision.
  // Inferred roles (data-shape guesses from fillMissingRolesFromData) are NOT confirmed.
  // Cell analysis only constrains confirmed columns; inferred roles remain challengeable.
  const confirmedColIndices = new Set(Object.values(answered));
  const layout=headerFound?readHeaderLayout({headerCells,columnMap:answered,remembered:options.layoutAnswers||{}}):{headers:[],unknown:[],fingerprint:""};
  let priceHeader=headerFound?grid[headerIndex].cells[columnMap.price]:"";
  let sourceHeaders=headerFound?grid[headerIndex].cells:[];
  const rows = [];
  const skipped = [];

  for (let i = dataStart; i < grid.length; i++) {
    const { line, cells } = grid[i];

    if (isJunkRow(cells)) {
      skipped.push({ line, reason: "looks like a total/note/address line" });
      continue;
    }

    // Repeated table headers can change the quoted unit. Do not leak a
    // preceding worksheet's price header into the next table.
    const header=mapColumnsFromHeader(cells);
    if(header.description!==undefined&&header.price!==undefined&&parseMoneyLenient(cells[header.price])===null){
      columnMap=header;priceHeader=cells[header.price];sourceHeaders=cells;continue;
    }
    const row = extractRow(cells, columnMap, priceHeader, confirmedColIndices, sourceHeaders);
    if (!row) {
      skipped.push({ line, reason: "couldn't find a valid price or description" });
      continue;
    }
    // Every cell against its column's meaning. A failing cell is flagged
    // on the row with the reason; the row is kept.
    const cellIssues=checkRowCells(cells,columnMap);
    if(Object.keys(cellIssues).length)row.cellIssues=cellIssues;

    rows.push(row);
  }

  const documentKind=detectDocumentKind(text);
  return { mode: "tabular", headerFound, columnMap, layout, rows:reviewUncertainRows(rows,documentKind), skipped, documentKind,quoteValidUntil:findQuoteValidity(text) };
}


function parseDocument(text, options={}){
  const result=parseDocumentRows(text, options);
  const documentUnit=documentQuoteUnit(text);
  return {...result,rows:result.rows.map(row=>applySourceUnits(row,{documentUnit}))};
}

// Exported for use elsewhere in the app.
export { parseDocument, findDate, findInvoiceNumber, detectDocumentKind, findQuoteValidity };
