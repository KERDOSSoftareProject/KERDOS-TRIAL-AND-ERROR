// KERDOS deterministic procurement primitives.
// Pure functions only: no UI, database, client, vendor, or industry assumptions.
import {categoryContext,packContext,configureCategoryProfile,industryProductContext,industryVocabulary} from "./knowledge/category-profiles.js";
import {compileDictionary} from "./core/term-dictionary.js";

// One named place for the auto-link cutoff instead of the same magic
// number repeated at each call site. At or above this score two
// descriptions are treated as the same product and linked automatically;
// below it, the pair is kept for human review rather than silently
// merged.
const MATCH_POLICY = Object.freeze({
  autoLink: 0.85,   // at/above: same product, linked automatically
  reviewFloor: 0.5, // at/above (but below autoLink): linked, flagged for review
});                 // below reviewFloor: not the same product

// ── VOCABULARY ────────────────────────────────────────────────────
// The engine ships a small base vocabulary and knows nothing beyond it.
// Everything industry- or language-specific arrives as data rows and is
// merged in by configureVocabulary(): the org's own vocabulary, seeded
// from its industry's pack and taught by its own corrections. Four kinds
// of row:
//   unit      term -> canonical unit code (an existing code, or a new one
//                     such as SHEET that compares only against itself)
//   packaging term is a container word, never a product word
//   stopword  term carries no meaning for matching
//   synonym   term -> canonical word, so "chix" reads as "chicken"
const BASE_STOPWORDS = ["the","a","an","of","and","or","with","in","new"];

const UNIT_DEFINITIONS = {
  // mass -> grams
  G:{dimension:"mass",base:"G",factor:1,aliases:["g","gram","grams"]},
  KG:{dimension:"mass",base:"G",factor:1000,aliases:["kg","kgs","kilogram","kilograms"]},
  OZ:{dimension:"mass",base:"G",factor:28.349523125,aliases:["oz","ounce","ounces"]},
  LB:{dimension:"mass",base:"G",factor:453.59237,aliases:["lb","lbs","pound","pounds"]},
  // volume -> milliliters
  ML:{dimension:"volume",base:"ML",factor:1,aliases:["ml","milliliter","milliliters"]},
  L:{dimension:"volume",base:"ML",factor:1000,aliases:["l","liter","liters","litre","litres"]},
  FLOZ:{dimension:"volume",base:"ML",factor:29.5735295625,aliases:["fl oz","floz","fluid ounce","fluid ounces"]},
  PT:{dimension:"volume",base:"ML",factor:473.176473,aliases:["pt","pint","pints"]},
  QT:{dimension:"volume",base:"ML",factor:946.352946,aliases:["qt","quart","quarts"]},
  GAL:{dimension:"volume",base:"ML",factor:3785.411784,aliases:["gal","gallon","gallons","gl","ga"]},
  // length -> millimeters
  MM:{dimension:"length",base:"MM",factor:1,aliases:["mm","millimeter","millimeters"]},
  CM:{dimension:"length",base:"MM",factor:10,aliases:["cm","centimeter","centimeters"]},
  M:{dimension:"length",base:"MM",factor:1000,aliases:["m","meter","meters","metre","metres"]},
  IN:{dimension:"length",base:"MM",factor:25.4,aliases:["in","inch","inches"]},
  FT:{dimension:"length",base:"MM",factor:304.8,aliases:["ft","foot","feet"]},
  YD:{dimension:"length",base:"MM",factor:914.4,aliases:["yd","yard","yards"]},

  // Agricultural dry measure. dimension:"bushel" is intentionally isolated so BU never
  // converts to or compares with gallons, liters, or any other volume unit.
  BU:{dimension:"bushel",base:"BU",factor:1,aliases:["bu","bus","bushel","bushels"]},
  // count -> each
  EA:{dimension:"count",base:"EA",factor:1,aliases:["ea","each","piece","pieces","pc","pcs","pce","pces"]},
  CT:{dimension:"count",base:"EA",factor:1,aliases:["ct","count"]},
  DOZ:{dimension:"count",base:"EA",factor:12,aliases:["doz","dozen","dz"]},
};

const BASE_PACKAGING = [
  "case","cases","cs","carton","cartons","box","boxes","bx","bag","bags",
  "pack","packs","pk","pallet","pallets","roll","rolls","container","containers",
  "bottle","bottles","can","cans","jar","jars","tub","tubs","tray","trays",
];

// The live vocabulary: base plus whatever configureVocabulary() merged in.
// One organization is active per session, so this is process state rather
// than a parameter threaded through every call.
let STOPWORDS, PACKAGING_ALIASES, UNIT_LOOKUP, SYNONYMS, UNIT_ALTERNATION, MEASURE_RE, customTerms;

function escapeRegExp(text) { return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"); }

function configureVocabulary(rows=[],includeIndustry=true) {
  STOPWORDS = new Set(BASE_STOPWORDS);
  PACKAGING_ALIASES = new Set(BASE_PACKAGING);
  UNIT_LOOKUP = new Map();
  SYNONYMS = new Map();
  customTerms=compileDictionary({organization:(rows||[]).filter(r=>r.kind==="synonym"&&r.term&&r.canonical)
    .map(r=>({term:r.canonical,aliases:[r.term],meaning:"Saved organization vocabulary",kind:"product"}))});
  for (const [code, def] of Object.entries(UNIT_DEFINITIONS)) {
    UNIT_LOOKUP.set(code.toLowerCase(), code);
    for (const alias of def.aliases) UNIT_LOOKUP.set(alias.toLowerCase(), code);
  }
  for (const r of [...(includeIndustry?industryVocabulary():[]),...(rows||[])]) {
    const term = String(r?.term || "").trim().toLowerCase();
    const canonical = String(r?.canonical || "").trim();
    if (!term) continue;
    if (r.kind === "unit" && canonical) UNIT_LOOKUP.set(term, canonical.toUpperCase());
    else if (r.kind === "packaging") PACKAGING_ALIASES.add(term);
    else if (r.kind === "stopword") STOPWORDS.add(canonicalWord(term));
    else if (r.kind === "synonym" && canonical) SYNONYMS.set(canonicalWord(term), canonicalWord(canonical));
  }
  // Measurements in free text are recognised by the unit vocabulary too,
  // so a unit taught to the org is found in descriptions as well as in
  // pack sizes. Single letters are excluded: "3 g" is too easily a code.
  const words = [...UNIT_LOOKUP.keys()].filter(k => k.length > 1)
    .sort((a, b) => b.length - a.length).map(k => escapeRegExp(k).replace(/\s+/g, "\\s*"));
  UNIT_ALTERNATION = words.join("|");
  MEASURE_RE = new RegExp(`\\b(\\d+(?:\\.\\d+)?)\\s*(${UNIT_ALTERNATION})\\b`, "g");
}

function round(n, places=6) {
  const p = 10 ** places;
  return Math.round((n + Number.EPSILON) * p) / p;
}

function canonicalWord(word) {
  let w = String(word || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  if (w.length > 4 && w.endsWith("ies")) w = w.slice(0,-3) + "y";
  else if (w.length > 4 && /(?:oes|xes|zes|ches|shes)$/.test(w)) w = w.slice(0,-2);
  else if (w.length > 3 && w.endsWith("s") && !w.endsWith("ss")) w = w.slice(0,-1);
  return w;
}

function normalizeForMatch(value) {
  return productKnowledge(value).text.toLowerCase().replace(/[^a-z0-9\s]/g," ").split(/\s+/)
    .map(canonicalWord).map(w => SYNONYMS.get(w) || w).filter(w => w.length > 1 && !STOPWORDS.has(w));
}

// Initialize base vocabulary without reading the profile during module cycles.
configureVocabulary([],false);

function productKnowledge(value){
  const custom=customTerms(value);
  const result=industryProductContext(custom.text);
  return {...result,evidence:[...custom.evidence,...result.evidence]};
}

// Activate the industry and this organization's additions together, including
// on refresh/offline restore and when changing organizations.
function configureProcurement({industry=null,vocabulary=[]}={}){
  configureCategoryProfile(industry);
  configureVocabulary(vocabulary);
}

function wordsMatch(a,b) { return canonicalWord(a) === canonicalWord(b); }

// Interpret the whole description. Keywords are vocabulary hints, while
// approved catalog items are contextual examples whose identity, modifiers,
// and measurements participate in the decision.
function classifyCategory(description, categories=[], catalogItems=[]) {
  const descWords = normalizeForMatch(description);
  if (!descWords.length) return null;
  const context=categoryContext(descWords,categories);
  if(context?.category)return context.category;
  if(context?.excludedCategoryIds)categories=categories.filter(c=>!context.excludedCategoryIds.includes(c.id));
  const scored=[];
  for (const category of categories) {
    if(category.is_holding_pen)continue;
    let vocabularyScore=0;
    let longestPhrase=0;
    const vocabulary=[category.name,...(Array.isArray(category.keywords)?category.keywords:[])].filter(Boolean);
    for (const keyword of vocabulary) {
      const kwWords=normalizeForMatch(keyword);
      if (kwWords.length && kwWords.every(k => descWords.some(d => wordsMatch(k,d)))) {
        // Specific phrases outrank generic one-word hits without embedding
        // product-specific exceptions in the engine.
        vocabularyScore += kwWords.length * kwWords.length;
        longestPhrase=Math.max(longestPhrase,kwWords.length);
      }
    }
    const examples=catalogItems.filter(item=>item.category_id===category.id && item.name);
    const contextualScore=examples.reduce((best,item)=>Math.max(best,safeProductScore(description,item.name)),0);
    if (vocabularyScore>0||contextualScore>=MATCH_POLICY.reviewFloor) scored.push({category,vocabularyScore,longestPhrase,contextualScore});
  }
  scored.sort((a,b)=>b.contextualScore-a.contextualScore || b.longestPhrase-a.longestPhrase || b.vocabularyScore-a.vocabularyScore);
  if (!scored.length) return null;
  // Close contextual results are ambiguous. Never let list order force them.
  if (scored[1]) {
    const a=scored[0], b=scored[1];
    if (a.contextualScore===b.contextualScore && a.longestPhrase===b.longestPhrase && a.vocabularyScore===b.vocabularyScore) return null;
    if (a.contextualScore>0 && b.contextualScore>0 && a.contextualScore-b.contextualScore<0.12) return null;
  }
  return scored[0].category;
}

// A new product should land in the most likely category, not in the
// holding pen, so the client reviews a placement instead of making one.
// "confident" is classifyCategory's own decision. "guess" is the best of
// the remaining evidence: a vocabulary hit that lost a tie, a weaker
// resemblance to items already in a category, or a category name that
// shares a defining word with the product. Anything weaker is null and
// the item goes to the holding pen as before.
function suggestCategory(description, categories=[], catalogItems=[]) {
  const contextWords=normalizeForMatch(description);
  const contextualPlacement=categoryContext(contextWords,categories);
  if (contextualPlacement?.category) return contextualPlacement;
  if(contextualPlacement?.excludedCategoryIds)categories=categories.filter(c=>!contextualPlacement.excludedCategoryIds.includes(c.id));
  const confident=classifyCategory(description,categories,catalogItems);
  if (confident) return {category:confident,confidence:"confident",reason:"Vocabulary and existing items point here"};
  const descWords=normalizeForMatch(description);
  if (!descWords.length) return null;
  const scored=[];
  for (const category of categories) {
    if (category.is_holding_pen) continue;
    const vocabulary=[category.name,...(Array.isArray(category.keywords)?category.keywords:[])].filter(Boolean);
    let vocabularyScore=0;
    for (const keyword of vocabulary) {
      const kwWords=normalizeForMatch(keyword);
      if (!kwWords.length) continue;
      const hits=kwWords.filter(k=>descWords.some(d=>wordsMatch(k,d))).length;
      if (hits) vocabularyScore=Math.max(vocabularyScore,hits/kwWords.length);
    }
    const examples=catalogItems.filter(item=>item.category_id===category.id && item.name);
    const contextualScore=examples.reduce((best,item)=>Math.max(best,safeProductScore(description,item.name)),0);
    const score=Math.max(vocabularyScore,contextualScore);
    if (score>=0.34) scored.push({category,score,via:vocabularyScore>=contextualScore?"vocabulary":"existing items"});
  }
  if (!scored.length) return null;
  scored.sort((a,b)=>b.score-a.score);
  const best=scored[0];
  return {category:best.category,confidence:"guess",score:round(best.score,2),
    reason:scored[1]&&scored[1].score===best.score?`Best guess between ${best.category.name} and ${scored[1].category.name} (${best.via})`:`Best guess from ${best.via}`};
}

function nextCategoryRange(categories=[], blockSize=10000) {
  const maxEnd=categories.reduce((max,c)=>Math.max(max,Number(c.range_end)||0),0);
  const start=Math.ceil((maxEnd+1)/blockSize)*blockSize || blockSize;
  return {range_start:start,range_end:start+blockSize-1};
}

function normalizeUnit(raw) {
  if (!raw) return null;
  const key=String(raw).trim().toLowerCase().replace(/\./g,"").replace(/\s+/g," ");
  return UNIT_LOOKUP.get(key) || String(raw).trim().toUpperCase();
}

function measurement(quantity, unitRaw) {
  const quantityNumber=Number(quantity);
  if (!Number.isFinite(quantityNumber) || quantityNumber <= 0) return null;
  const unit=normalizeUnit(unitRaw);
  const def=UNIT_DEFINITIONS[unit];
  return def
    ? {quantity:quantityNumber,unit,dimension:def.dimension,baseUnit:def.base,baseQuantity:round(quantityNumber*def.factor)}
    : {quantity:quantityNumber,unit,dimension:"unknown",baseUnit:unit,baseQuantity:quantityNumber};
}

// Parses common packaging expressions without restricting KERDOS to a fixed industry.
// Unknown units remain valid and comparable only to the same unknown unit.
// Catch-weight markers: the case holds roughly this much, and the vendor
// bills the delivered weight. A catch-weight pack and a fixed-weight
// pack of the same nominal size are different purchasing configurations.
const CATCH_WEIGHT_RE=/\b(?:av|avg|ave|average|approx|approximately|catch\s*wt|catch\s*weight|c\/w|cw|rw|random\s*wt|random\s*weight|var(?:iable)?\s*wt|var(?:iable)?\s*weight)\.?$/i;


// Normalize mixed-number fractions so the pack parser can read them.
// "1-1/9 bu" -> "1.111 bu". The raw original is kept on the row.
// Bushels never convert to other units; this only normalises the notation.
function normalizeMixedFraction(str){
  if(!str) return str;
  return String(str).replace(/(\d+)-(\d+)\/(\d+)/g, function(m, w, n, d){
    // 6 decimal places gives exact representation for common fractions (1/9, 1/3, 2/3)
    return (Number(w) + Number(n)/Number(d)).toFixed(6).replace(/\.?0+$/, "");
  });
}
function parsePackSize(raw) {
  if (!raw || !String(raw).trim()) return null;
  const originalRaw=String(raw).trim();
  const source=normalizeMixedFraction(originalRaw);
  // "4/10 LBAV", "4/10 LB AVG", "2/10# AVG": the marker is read and then
  // set aside so the rest parses as an ordinary pack.
  let working=source.toLowerCase().replace(/(lb|lbs)(av|avg)\b/g,"$1 $2");
  const catchWeight=CATCH_WEIGHT_RE.test(working);
  if(catchWeight) working=working.replace(CATCH_WEIGHT_RE,"").trim();
  // "#10" after a slash is a can size, not pounds: "6/#10 CN" is six cans
  // of the #10 size, a count of an unknown-volume unit.
  const canSize=working.match(/^(\d+)\s*[\/x]\s*#\s*(\d+(?:\.\d+)?)\s*(?:cn|can|cans)?\s*$/);
  if(canSize){
    const outerQty=Number(canSize[1]),unit=`#${canSize[2]} CAN`;
    return {raw:source,parsed:true,caseQty:outerQty,unitQty:1,unit,total:outerQty,dimension:"unknown",baseUnit:unit,baseTotal:outerQty,catchWeight:false,
      levels:outerQty>1?[{quantity:outerQty,type:"PACKAGE"},{quantity:1,type:unit}]:[{quantity:1,type:unit}],
      eachStr:`1 ${unit}`,caseStr:outerQty>1?`${outerQty}/1 ${unit}`:`1 ${unit}`};
  }
  const context=packContext(working);
  working=context.working;
  // A dash between a quantity and a unit is punctuation, not a missing
  // measurement. Keep number/number case structure and trailing qualifiers.
  const clean=working.replace(/[×x]/g,"x").replace(/(\d)\s*[-]\s*(?=\d)/g,"$1/")
    .replace(/(\d)\s*[-‐‑–]\s*(?=[a-z])/g,"$1 ")
    .replace(/#/g," lb ").replace(/\s+/g," ").trim();
  // Vendor packs routinely omit the leading zero: 200/.5 OZ, 4/.5 GAL.
  const number="((?:\\d+(?:\\.\\d+)?|\\.\\d+))";
  // A known unit (any number of words, longest first) is preferred; an
  // unknown single word is still accepted as a unit of its own.
  const unit=`(${UNIT_ALTERNATION}|[a-z]+)`;
  let m=clean.match(new RegExp(`^${number}\\s*(?:/|x|\\s)\\s*${number}\\s*${unit}\\b`));
  let outerQty=1, innerQty, unitRaw;
  if (m) { outerQty=Number(m[1]); innerQty=Number(m[2]); unitRaw=m[3]; }
  else {
    // "8/QT" states eight one-quart units. Only known units/container
    // words qualify; "8/12" still lacks a unit and must remain unresolved.
    const shorthand=clean.match(new RegExp(`^${number}\\s*/\\s*${unit}\\s*$`));
    if(shorthand&&(UNIT_LOOKUP.has(shorthand[2])||PACKAGING_ALIASES.has(shorthand[2]))){
      m=shorthand;outerQty=Number(m[1]);innerQty=1;unitRaw=m[2];
    }else{
      m=clean.match(new RegExp(`^${number}\\s*${unit}\\b`));
      if (!m) return {raw:source,parsed:false,levels:[],total:null,unit:null,dimension:"unknown"};
      innerQty=Number(m[1]); unitRaw=m[2];
    }
  }
  // A readable prefix is not a complete pack specification. Extra case
  // components, variable-weight markers or unfamiliar qualifiers require
  // review, even when the leading quantity and unit look identical.
  const remainder=clean.slice(m[0].length).replace(/^[\s.,]+|[\s.,]+$/g,"").trim();
  if(remainder&&!PACKAGING_ALIASES.has(remainder))
    return {raw:source,parsed:false,levels:[],total:null,unit:null,dimension:"unknown"};
  if(!Number.isFinite(outerQty)||outerQty<=0)return null;
  const measure=measurement(innerQty,unitRaw);
  if (!measure) return null;
  const total=outerQty*innerQty;
  return {
    raw:source,originalRaw,parsed:true,caseQty:outerQty,unitQty:innerQty,unit:measure.unit,total,catchWeight,qualifiers:context.qualifiers,
    dimension:measure.dimension,baseUnit:measure.baseUnit,baseTotal:round(outerQty*measure.baseQuantity),
    levels: outerQty>1 ? [{quantity:outerQty,type:"PACKAGE"},{quantity:innerQty,type:measure.unit}] : [{quantity:innerQty,type:measure.unit}],
    eachStr:`${innerQty} ${measure.unit}`,caseStr:outerQty>1?`${outerQty}/${innerQty} ${measure.unit}`:`${innerQty} ${measure.unit}`,
  };
}

function normalizedPrice(price, pack) {
  const p=parsePackSize(pack), n=Number(price);
  if (!p?.parsed || !Number.isFinite(n) || !p.baseTotal) return null;
  return {price:round(n/p.baseTotal),unit:p.baseUnit,dimension:p.dimension};
}

// Numeric totals alone do not identify a pack: 1 gram, 1 milliliter,
// 1 sheet, and 1 each are different purchasing configurations. Unknown
// units intentionally compare only with the same normalized custom unit.
function packsEquivalent(a, b) {
  return comparePurchasingPack(a,b).status==="same";
}

// Brand equality is case/space-insensitive; an empty brand never matches
// a locked one, since "unknown brand" is not the same as "this brand".
function brandsMatch(a, b) {
  const norm = v => String(v || "").trim().toLowerCase().replace(/\s+/g, " ");
  const x = norm(a), y = norm(b);
  return !!x && !!y && x === y;
}

function eachPrice(casePrice, pack) {
  const p=parsePackSize(pack), n=Number(casePrice);
  if (!p?.parsed || !Number.isFinite(n) || p.caseQty<=1) return null;
  return {price:round(n/p.caseQty,2),size:p.eachStr};
}

// Price per one unit of measure, for honest comparison across vendors
// whose packs are expressed differently (4/1 GAL against 6/32 FL OZ).
// `targetUnit` is the unit the client wants to read the price in; when
// it is absent, or belongs to a different dimension than this pack, the
// price is given per the pack's own unit instead - never silently
// converted across dimensions. Unknown units stay comparable only to
// the same unknown unit, same rule as parsePackSize.
function pricePerUnit(price, pack, targetUnit) {
  const p=parsePackSize(pack), n=Number(price);
  if (!p?.parsed || !Number.isFinite(n) || !p.total) return null;
  const target=targetUnit ? normalizeUnit(targetUnit) : p.unit;
  const def=UNIT_DEFINITIONS[target];
  if (def && def.dimension===p.dimension && p.baseTotal) {
    return {price:round(n/(p.baseTotal/def.factor),4),unit:target,dimension:p.dimension};
  }
  return {price:round(n/p.total,4),unit:p.unit,dimension:p.dimension};
}

// ---- Learning from confirmations -------------------------------------
// When a client confirms that "CHIX BRST BNLS" is the same product as
// "CHICKEN BREAST BONELESS", the only safe lesson is spelling: a word on
// one side that is an abbreviation of a word on the other. Two words are
// paired only when the short one starts the long one's first letter and
// its letters appear in the long one in order ("brst" in "breast", "bnls"
// in "boneless"). "Breast" and "thigh" never pair, so a confirmation can
// teach wording but never that two products are the same.
function isAbbreviationOf(short,long){
  const a=canonicalWord(short),b=canonicalWord(long);
  if(!a||!b||a===b||a.length>=b.length||a.length<2||b.length<4)return false;
  if(a[0]!==b[0])return false;
  let i=0;
  for(const ch of b){if(ch===a[i])i++;if(i===a.length)break;}
  return i===a.length;
}
function abbreviationPairs(description,references=[]){
  const own=new Set(productCoreWords(description));
  const pairs=new Map();
  for(const reference of references){
    const theirs=new Set(productCoreWords(reference));
    const onlyOwn=[...own].filter(w=>!theirs.has(w)),onlyTheirs=[...theirs].filter(w=>!own.has(w));
    for(const w of onlyOwn){
      const expansions=onlyTheirs.filter(t=>isAbbreviationOf(w,t));
      if(expansions.length===1)pairs.set(w,expansions[0]);
    }
    for(const t of onlyTheirs){
      const expansions=onlyOwn.filter(w=>isAbbreviationOf(t,w));
      if(expansions.length===1)pairs.set(t,expansions[0]);
    }
  }
  return [...pairs].map(([term,canonical])=>({term,canonical}));
}

// ---- Identifiers -----------------------------------------------------
// A barcode (GTIN/UPC/EAN) names one trade item regardless of how each
// vendor words it. When two vendors quote the same GTIN in the same pack,
// identity is proven without comparing descriptions. The check digit
// keeps stray numbers (phone numbers, account numbers) from being
// mistaken for a barcode.
function normalizeGtin(raw){
  if(raw==null) return null;
  const digits=String(raw).replace(/\D/g,"");
  if(![8,12,13,14].includes(digits.length)) return null;
  const padded=digits.padStart(14,"0");
  let sum=0;
  for(let i=0;i<13;i++) sum+=Number(padded[i])*(i%2===0?3:1);
  if((10-(sum%10))%10!==Number(padded[13])) return null;
  return padded;
}

// Manufacturer part numbers are only meaningful alongside the maker.
function normalizeManufacturerCode(raw){
  if(raw==null) return null;
  const clean=String(raw).trim().toUpperCase().replace(/\s+/g,"");
  return clean.length>=3&&/[0-9]/.test(clean)?clean:null;
}

// Vendors often write the pack at the end of the description instead of
// in its own column ("CHICKEN BREAST 4/10 LB", "OIL CANOLA 35#"). When
// the pack column is empty, the tail of the description is the pack if
// KERDOS can read it as one; the description itself is left untouched.
function packFromDescription(description){
  const text=normalizeMixedFraction(String(description||"").trim());
  if(!text) return null;
  // Parenthetical pack anywhere in description: (40 LB), (4/10 LB)
  const parenMatch=text.match(/\(\s*((?:\d+(?:\.\d+)?\s*[\/x\xd7-]\s*)?\d+(?:\.\d+)?\s*(?:#|[a-z]{1,8}(?:\s+[a-z]{1,8})?)?)\s*\)/i);
  if(parenMatch){const pc=parenMatch[1].trim();const pp=parsePackSize(pc);if(pp?.parsed)return pc;}
  const tail=text.match(/(?:^|\s)((?:\d+(?:\.\d+)?\s*[\/x×-]\s*)?\d+(?:\.\d+)?\s*(?:#|[a-z]{1,8}(?:\s+[a-z]{1,8})?)\.?)\s*$/i);
  if(!tail) return null;
  const candidate=tail[1].replace(/\.$/,"").trim();
  const parsed=parsePackSize(candidate);
  if(!parsed?.parsed) return null;
  // A bare count with an unknown word ("2 CHICKEN") is not a pack.
  if(parsed.dimension==="unknown"&&!PACKAGING_ALIASES.has(parsed.unit.toLowerCase())&&!/#/.test(candidate)) return null;
  return candidate;
}

// ---- Price basis -----------------------------------------------------
// A vendor's selling unit says which quantity its price is for: the whole
// pack as listed ("case"), one inner unit ("each"), or one unit of measure
// such as a pound or a gallon ("measure"). KERDOS ranks vendors on the
// price of one full pack, so every quote is converted to that basis
// before it is compared, and a quote that cannot be converted is held
// for review rather than compared on the wrong footing.
const CASE_WORDS=new Set(["cs","case","cases","cse","bx","box","boxes","pk","pack","packs","ct","ctn","carton","cartons","pallet","pallets","bag","bags","bdl","bundle","roll","rolls","tray","trays","flat","flats","sleeve","sleeves","tub","tubs","pail","pails","jug","jugs","drum","drums","cn","can","cans","jar","jars","btl","bottle","bottles","kit","kits"]);
const EACH_WORDS=new Set(["ea","each","pc","pcs","pce","pces","piece","pieces","un","unit","units","hd","head","heads","bn","bunch","bunches","lp","loaf","loaves"]);

function priceBasisFor(sellingUnit){
  if(sellingUnit==null||!String(sellingUnit).trim()) return null;
  const key=String(sellingUnit).trim().toLowerCase().replace(/\./g,"").replace(/\s+/g," ");
  // Packaging words an organization has taught KERDOS (reams, skids,
  // drums, whatever its industry ships in) count as the whole pack too.
  if(CASE_WORDS.has(key)||PACKAGING_ALIASES.has(key)) return {basis:"case",unit:null};
  if(EACH_WORDS.has(key)) return {basis:"each",unit:null};
  // Built-in units and units the organization taught KERDOS both count.
  if(UNIT_LOOKUP.has(key)) return {basis:"measure",unit:normalizeUnit(key)};
  return null;
}

function assertKnownPriceBasis(sellingUnit){
  const basis=priceBasisFor(sellingUnit);
  if(String(sellingUnit||"").trim()&&!basis)
    throw new Error(`Unknown selling unit "${sellingUnit}"; the quote was not applied. Teach KERDOS the unit or correct this row.`);
  return basis;
}

// Price of one full pack from a quote on any basis. A quote with no
// recorded basis is a legacy row, which was always the pack price.
function casePriceFromQuote(price,basis,unit,pack){
  const n=Number(price);
  if(!Number.isFinite(n)||n<=0) return null;
  if(!basis||basis==="case") return round(n,4);
  const p=parsePackSize(pack);
  if(!p?.parsed) return null;
  if(basis==="each") return round(n*p.caseQty,4);
  if(basis==="measure"){
    const code=normalizeUnit(unit),def=UNIT_DEFINITIONS[code];
    // A unit with no conversion table (one the organization taught) is
    // convertible only when the pack is stated in that same unit.
    if(!def) return p.unit===code&&p.total?round(n*p.total,4):null;
    if(def.dimension!==p.dimension||!p.baseTotal) return null;
    return round(n*(p.baseTotal/def.factor),4);
  }
  return null;
}

// Express a stored quote on the basis an invoice line is billed in, so
// the variance compares like with like. null means "cannot compare".
function quotePriceOnBasis(quote,target){
  const casePrice=casePriceFromQuote(quote.price,quote.basis,quote.unit,quote.packSize);
  if(casePrice==null) return null;
  const basis=target?.basis||"case";
  if(basis==="case") return casePrice;
  const p=parsePackSize(quote.packSize);
  if(!p?.parsed) return null;
  if(basis==="each") return round(casePrice/p.caseQty,4);
  if(basis==="measure"){
    const per=pricePerUnit(casePrice,quote.packSize,target.unit);
    if(!per||per.unit!==normalizeUnit(target.unit)) return null;
    return per.price;
  }
  return null;
}

// The units a client may choose to read a price in, for one dimension.
// Driven by UNIT_DEFINITIONS so adding a unit there is enough.
function unitsForDimension(dimension) {
  return Object.entries(UNIT_DEFINITIONS).filter(([,d])=>d.dimension===dimension).map(([code])=>code);
}

function extractComparableMeasurements(value) {
  const text=String(value||"").toLowerCase();
  const out=[];
  const re=new RegExp(MEASURE_RE.source, "g");
  let m;
  while ((m=re.exec(text))) {
    const x=measurement(Number(m[1]),m[2]);
    if (x) out.push(`${x.dimension}:${x.baseUnit}:${round(x.baseQuantity,3)}`);
  }
  const ratios=[...text.matchAll(/\b(\d+)\s*[\/x]\s*(\d+)\b/g)].map(m=>`ratio:${m[1]}x${m[2]}`);
  return new Set([...out,...ratios]);
}

function productCoreWords(value) {
  const unitWords=new Set([...UNIT_LOOKUP.keys(),...PACKAGING_ALIASES]);
  return normalizeForMatch(value).filter(w => !/^\d+(?:\.\d+)?$/.test(w) && !unitWords.has(w));
}

// Product identity is evaluated BEFORE overlap scores. This is intentionally
// industry-neutral: a shared generic term never proves two products identical.
// Organization vocabulary supplies contextual aliases; unrecognized defining
// words stay significant instead of being silently discarded.
function productIdentity(description) {
  const text=String(description||"");
  const measurements=extractComparableMeasurements(text);
  // A count with an unfamiliar industry term is still a defining detail:
  // 120 slices and 160 slices must not collapse to "sliced cheese".
  const unknownCounts=[...text.toLowerCase().matchAll(/\b(\d+(?:\.\d+)?)\s+([a-z]{3,})\b/g)];
  for(const [,quantity,word] of unknownCounts){
    if(!UNIT_LOOKUP.has(word) && !PACKAGING_ALIASES.has(word)) measurements.add(`count:${canonicalWord(word)}:${quantity}`);
  }
  const clean=text.replace(new RegExp(MEASURE_RE.source,"gi")," ").replace(/\b\d+\s*[\/x]\s*\d+\b/gi," ");
  const knowledge=productKnowledge(clean);
  return {core:new Set(productCoreWords(knowledge.text)),measurements,attributes:knowledge.attributes,
    evidence:knowledge.evidence,unresolved:knowledge.unresolved};
}
function compareProductIdentity(a,b) {
  const x=productIdentity(a), y=productIdentity(b);
  const shared=[...x.core].filter(w=>y.core.has(w));
  for(const field of new Set([...Object.keys(x.attributes),...Object.keys(y.attributes)])){
    const left=x.attributes[field],right=y.attributes[field],label=field.replace(/_/g," ");
    if(left&&right&&left!==right)return {status:"different",reason:`Different ${label}: ${left} versus ${right}`,field};
    if(!left||!right)return {status:"review",reason:`${label} is ${left||right} on one listing and unstated on the other`,field};
  }
  const unknown=[...x.unresolved,...y.unresolved];
  if(unknown.length)return {status:"review",reason:`Unresolved term: ${unknown[0].source||unknown[0].term}. ${unknown[0].meaning}`,field:"terminology"};
  if(!shared.length) return {status:"different",reason:"No shared defining product terms"};
  const onlyA=[...x.core].filter(w=>!y.core.has(w));
  const onlyB=[...y.core].filter(w=>!x.core.has(w));
  // Different defining terms on BOTH sides cannot be explained by an
  // omitted field: "chicken base" vs "chicken breast", "breast" vs
  // "thigh", "tomato sauce" vs "tomato paste" remain separate.
  if(onlyA.length&&onlyB.length) return {status:"different",reason:`Conflicting product terms: ${onlyA.join(", ")} vs ${onlyB.join(", ")}`};
  if(onlyA.length||onlyB.length) return {status:"review",reason:`Unverified defining terms: ${[...onlyA,...onlyB].join(", ")}`};
  const aSpecs=x.measurements,bSpecs=y.measurements;
  if(aSpecs.size&&bSpecs.size){
    if(aSpecs.size!==bSpecs.size||[...aSpecs].some(z=>!bSpecs.has(z)))
      return {status:"review",reason:"Different or incomplete measurements / purchasing configurations"};
  }else if(aSpecs.size||bSpecs.size) return {status:"review",reason:"A measurement is missing from one description"};
  return {status:"same",reason:"All recognized defining product terms and measurements agree"};
}

function safeProductScore(a,b) {
  const aWords=new Set(productCoreWords(a)), bWords=new Set(productCoreWords(b));
  if (!aWords.size || !bWords.size) return 0;
  let shared=0;
  for (const w of aWords) if (bWords.has(w)) shared++;
  if (!shared) return 0;

  const specsA=extractComparableMeasurements(a), specsB=extractComparableMeasurements(b);
  if (specsA.size && specsB.size && ![...specsA].some(x=>specsB.has(x))) return 0;

  const subset=shared/Math.min(aWords.size,bWords.size);
  const union=shared/(aWords.size+bWords.size-shared);
  // Keeps legitimate abbreviated/subset descriptions viable while penalizing
  // near-neighbors such as "chicken breast" vs "chicken thigh".
  return round(0.65*subset + 0.35*union,4);
}

// Picks which existing catalog item a vendor description belongs to.
// "strict" items only accept auto-link-grade matches: a partial
// resemblance must never attach to them, because that is exactly how two
// genuinely different products get merged. "flexible" (the default) also
// accepts review-grade matches, flagged as "similar" for a person to
// confirm. Below the review floor nothing matches and the caller creates
// a new item.
function bestCatalogMatch(description, catalogItems=[], policy=MATCH_POLICY) {
  let best=null,bestScore=0,bestTrack=null;
  for(const ci of catalogItems){
    if(!ci?.name) continue;
    const identity=compareProductIdentity(description,ci.name);
    if(identity.status==="different") continue;
    const score=safeProductScore(description,ci.name);
    if(identity.status==="same" && score>=policy.autoLink && score>bestScore){
      best=ci; bestScore=score; bestTrack="exact";
    }
  }
  // Prefer an established identity over any fuzzy candidate.
  if(best) return {catalogItem:best,score:bestScore,track:bestTrack};
  for(const ci of catalogItems){
    if(!ci?.name||ci.matching_behavior==="strict") continue;
    const identity=compareProductIdentity(description,ci.name);
    if(identity.status!=="review") continue;
    const score=safeProductScore(description,ci.name);
    if(score>=policy.reviewFloor&&score>bestScore){best=ci;bestScore=score;bestTrack="similar";}
  }
  // A similar candidate is only a suggestion: CALLERS MUST NOT link it.
  return best?{catalogItem:best,score:bestScore,track:bestTrack}:null;
}

// The catalog's display name is not a complete purchasing specification.
// Compare an incoming vendor pack to verified packs on the existing item.
// Missing or conflicting pack data stays review-only; total volume alone
// cannot prove two different case configurations interchangeable.
function comparePurchasingPack(incoming,existing){
  const a=parsePackSize(incoming),b=parsePackSize(existing);
  if(!a?.parsed||!b?.parsed)return {status:"review",reason:"Pack size missing or unreadable"};
  if(a.dimension!==b.dimension||a.baseUnit!==b.baseUnit||a.baseTotal!==b.baseTotal)
    return {status:"different",reason:`Pack size differs: ${incoming} versus ${existing}`};
  if(a.caseQty!==b.caseQty||Math.abs(a.unitQty*measurement(1,a.unit).baseQuantity-b.unitQty*measurement(1,b.unit).baseQuantity)>0.001)
    return {status:"review",reason:`Case configuration differs: ${incoming} versus ${existing}`};
  if(JSON.stringify(a.qualifiers||[])!==JSON.stringify(b.qualifiers||[]))
    return {status:"review",reason:`Pack qualifiers differ: ${incoming} versus ${existing}`};
  if(!!a.catchWeight!==!!b.catchWeight)
    return {status:"review",reason:`One pack is catch-weight and the other fixed-weight: ${incoming} versus ${existing}`};
  return {status:"same",reason:"Pack sizes agree"};
}

// Equivalent spellings do not erase a catalog's known pack. Every supplied
// pack must be readable and agree, including inner quantities and dimensions.
function commonPurchasingPack(values=[]){
  if(!values.length||values.some(value=>!parsePackSize(value)?.parsed))return null;
  return values.every(value=>comparePurchasingPack(value,values[0]).status==="same")?values[0]:null;
}

function bestPurchasingMatch(description,packSize,catalogItems=[]){
  const candidates=catalogItems.map(ci=>({...ci,name:ci.name,matching_behavior:ci.matching_behavior}));
  const ranked=candidates.map(ci=>{
    const identity=compareProductIdentity(description,ci.name);
    if(identity.status==="different")return null;
    const pack=comparePurchasingPack(packSize,ci.pack_size);
    const score=safeProductScore(description,ci.name);
    if(score<MATCH_POLICY.reviewFloor)return null;
    const exact=identity.status==="same"&&pack.status==="same"&&score>=MATCH_POLICY.autoLink;
    if(ci.matching_behavior==="strict"&&!exact)return null;
    return {catalogItem:ci,score,track:exact?"exact":"similar",
      reason:identity.status==="review"?identity.reason:pack.reason};
  }).filter(Boolean).sort((a,b)=>(b.track==="exact")-(a.track==="exact")||b.score-a.score);
  return ranked[0]||null;
}

// A candidate can be worth showing even when its descriptions contain
// different unrecognized words. This NEVER links or prices the products:
// a complete, identical purchasing pack is required even for a suggestion.
function bestPurchasingSuggestion(description,packSize,catalogItems=[]){
  return catalogItems.map(ci=>({catalogItem:ci,score:safeProductScore(description,ci.name),pack:comparePurchasingPack(packSize,ci.pack_size)}))
    .filter(candidate=>candidate.pack.status==="same"&&candidate.score>=0.35)
    .sort((a,b)=>b.score-a.score)[0]||null;
}

function bestInvoiceMatch(description,candidates=[],threshold=MATCH_POLICY.autoLink) {
  const ranked=[];
  for(const candidate of candidates){
    if(!candidate?.description||compareProductIdentity(description,candidate.description).status!=="same") continue;
    const score=safeProductScore(description,candidate.description);
    if(score>=threshold)ranked.push({vendorItem:candidate,score});
  }
  ranked.sort((a,b)=>b.score-a.score);
  // Similarity cannot select a winner between two credible vendor products.
  if(ranked.length>1&&ranked[0].score-ranked[1].score<0.05)return null;
  return ranked[0]||null;
}

// A current quotation is NOT a past invoice charge. Expiry can be client-
// configured or manual, but an explicit vendor validity date always wins.
function quoteStatus(item,settings={},now=new Date()){
  if(!item||item.price_source==="invoice") return "invoice_only";
  if(item.price_unavailable||item.price==null||!Number.isFinite(Number(item.price))||Number(item.price)<=0) return "unavailable";
  if(item.price_expired_at) return "expired";
  const date=now instanceof Date?now:new Date(now);
  if(!Number.isFinite(date.getTime())) return "expired";
  const localDate=`${date.getFullYear()}-${String(date.getMonth()+1).padStart(2,"0")}-${String(date.getDate()).padStart(2,"0")}`;
  if(item.price_quote_valid_until && String(item.price_quote_valid_until).slice(0,10)<localDate) return "expired";
  const days=Number(settings?.price_refresh_days);
  // Manual is always the default. A legacy day count alone must never
  // silently remove prices from the Order Guide; the client has to choose
  // automatic expiration explicitly.
  const mode=settings?.price_refresh_mode==="automatic"?"automatic":"manual";
  if(mode==="automatic"&&days>0){
    const updated=new Date(item.last_updated);
    if(!item.last_updated||!Number.isFinite(updated.getTime())) return "expired";
    if((date.getTime()-updated.getTime())/(86400000)>days) return "expired";
  }
  return "current";
}

export {
  MATCH_POLICY, UNIT_DEFINITIONS, configureVocabulary, configureProcurement, productKnowledge, normalizeUnit, measurement, parsePackSize, packsEquivalent, normalizedPrice, eachPrice,
  unitsForDimension, pricePerUnit, brandsMatch, priceBasisFor, casePriceFromQuote, quotePriceOnBasis, normalizeGtin, normalizeManufacturerCode, packFromDescription, isAbbreviationOf, abbreviationPairs,
  normalizeForMatch, wordsMatch, classifyCategory, suggestCategory, nextCategoryRange,
  safeProductScore, productIdentity, compareProductIdentity, comparePurchasingPack, commonPurchasingPack, bestPurchasingMatch, bestPurchasingSuggestion, quoteStatus, bestCatalogMatch, bestInvoiceMatch, assertKnownPriceBasis,
  normalizeMixedFraction,
};
