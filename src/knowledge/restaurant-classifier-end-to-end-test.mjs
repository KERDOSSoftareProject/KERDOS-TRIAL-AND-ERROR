/**
 * restaurant-classifier-end-to-end-test.mjs
 *
 * Tests the FULL classification pipeline — suggestCategory from procurement.js —
 * not only restaurantCategoryContext in isolation.
 *
 * This matters because restaurantCategoryContext can return null or an exclusion
 * object that only affects keyword fallback. These tests verify that keyword
 * fallback does NOT undo a context-level exclusion.
 *
 * Key cases exercised here:
 *   - Seafood exclusion survives keyword fallback (vegan salmon, salmon seasoning)
 *   - Hashbrowns without frozen/fresh evidence → General (not Frozen Foods)
 *   - Misleading keyword matches are blocked by context exclusions
 *
 * Run: node src/knowledge/restaurant-classifier-end-to-end-test.mjs
 * from the project root directory.
 */

import {suggestCategory} from "../procurement.js";
import {configureProcurement} from "../procurement.js";

configureProcurement({industry:"restaurant",vocabulary:[]});
await new Promise(r=>setTimeout(r,10));

// ── Category fixtures ────────────────────────────────────────────────────────

// Rich tree with Seafood category whose keywords include "salmon" and "tuna".
// Without the context exclusion, keyword fallback would confidently route
// "SALMON SEASONING" and "VEGAN SALMON" here.
const RICH_WITH_SEAFOOD_KEYWORDS=[
  {id:"produce",name:"Produce",keywords:["tomato","garlic","onion","potato","lettuce"],is_holding_pen:false},
  {id:"meat",name:"Meat",keywords:["beef","pork","chicken","turkey"],is_holding_pen:false},
  {id:"seafood",name:"Seafood",keywords:["fish","shrimp","tuna","salmon","cod","tilapia"],is_holding_pen:false},
  {id:"deli",name:"Deli",keywords:["pepperoni","salami","ham","turkey"],is_holding_pen:false},
  {id:"dairy",name:"Dairy",keywords:["cheese","milk","butter"],is_holding_pen:false},
  {id:"bakery",name:"Bakery",keywords:["bread","muffin","bagel"],is_holding_pen:false},
  {id:"frozen",name:"Frozen Foods",keywords:["frozen"],is_holding_pen:false},
  {id:"bev",name:"Beverages",keywords:["juice","soda","water"],is_holding_pen:false},
  {id:"cond",name:"Condiments",keywords:["ketchup","mustard","mayo"],is_holding_pen:false},
  {id:"pantry",name:"Pantry",keywords:["oil","vinegar","salt"],is_holding_pen:false},
  {id:"general",name:"General",keywords:[],is_holding_pen:false},
];

// Five-category fixture (for hashbrown routing)
const FIVE_CAT=[
  {id:"produce",name:"Produce",keywords:["tomato","garlic","onion","potato","lettuce","pepper","carrot","broccoli","spinach","eggplant","artichoke"],is_holding_pen:false},
  {id:"meat",name:"Meat",keywords:["beef","pork","chicken","turkey","lamb","veal"],is_holding_pen:false},
  {id:"dairy",name:"Dairy",keywords:["cheese","milk","butter","cream","yogurt"],is_holding_pen:false},
  {id:"paper",name:"Paper Goods",keywords:["napkin","towel","tissue"],is_holding_pen:false},
  {id:"general",name:"General",keywords:[],is_holding_pen:false},
];

// ── Helpers ──────────────────────────────────────────────────────────────────

function classify(desc, cats) {
  const result = suggestCategory(desc, cats, []);
  return result?.category?.name ?? "(none)";
}

let passed=0, failed=0;
function t(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`        expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`);
    failed++;
  }
}

// ── Seafood exclusion survives keyword fallback ──────────────────────────────
// The Seafood category has "salmon" and "tuna" as keywords.
// Without a context exclusion, keyword scoring would confidently route
// "SALMON SEASONING" and "VEGAN SALMON" to Seafood.
console.log("\n── Full classifier: seafood keyword fallback blocked ──");

t("SALMON SEASONING full-classifier → not Seafood",
  classify("SALMON SEASONING", RICH_WITH_SEAFOOD_KEYWORDS), "(none)");

t("TUNA SPICE RUB full-classifier → not Seafood",
  classify("TUNA SPICE RUB", RICH_WITH_SEAFOOD_KEYWORDS), "(none)");

t("SALMON SEASONING BLEND full-classifier → not Seafood",
  classify("SALMON SEASONING BLEND", RICH_WITH_SEAFOOD_KEYWORDS), "(none)");

t("VEGAN SALMON FILLET full-classifier → not Seafood",
  classify("VEGAN SALMON FILLET", RICH_WITH_SEAFOOD_KEYWORDS), "(none)");

t("PLANT BASED TUNA SALAD full-classifier → not Seafood",
  classify("PLANT BASED TUNA SALAD", RICH_WITH_SEAFOOD_KEYWORDS), "(none)");

t("IMPOSSIBLE SALMON BURGER full-classifier → not Seafood",
  classify("IMPOSSIBLE SALMON BURGER", RICH_WITH_SEAFOOD_KEYWORDS), "(none)");

// Genuine seafood should still route correctly
t("SALMON FILLET full-classifier → Seafood",
  classify("SALMON FILLET", RICH_WITH_SEAFOOD_KEYWORDS), "Seafood");

t("TUNA LOIN full-classifier → Seafood",
  classify("TUNA LOIN", RICH_WITH_SEAFOOD_KEYWORDS), "Seafood");

t("CALAMARI RINGS full-classifier → Seafood",
  classify("CALAMARI RINGS", RICH_WITH_SEAFOOD_KEYWORDS), "Seafood");

// ── Hashbrowns: ambiguous case must not assert frozen storage ────────────────
console.log("\n── Full classifier: hashbrown storage evidence ──");

// Explicit frozen: Frozen Foods is correct
t("HASHBROWN PATTIES FRZN full-classifier → Frozen Foods",
  classify("HASHBROWN PATTIES FRZN", RICH_WITH_SEAFOOD_KEYWORDS), "Frozen Foods");

t("HASHBROWNS FROZEN full-classifier → Frozen Foods",
  classify("HASHBROWNS FROZEN", RICH_WITH_SEAFOOD_KEYWORDS), "Frozen Foods");

// No storage evidence: General (do not assert frozen)
t("HASHBROWNS plain full-classifier → General",
  classify("HASHBROWNS", RICH_WITH_SEAFOOD_KEYWORDS), "General");

t("HASHBROWNS plain (5-cat) full-classifier → General",
  classify("HASHBROWNS", FIVE_CAT), "General");

t("FF HASHBROWNS (5-cat) full-classifier → General (FF unresolved)",
  classify("FF HASHBROWNS", FIVE_CAT), "General");

// Explicit fresh: should not go to Frozen Foods
t("HASHBROWNS FRESH full-classifier → General",
  classify("HASHBROWNS FRESH", RICH_WITH_SEAFOOD_KEYWORDS), "General");

t("HASHBROWNS FRESH (5-cat) full-classifier → General",
  classify("HASHBROWNS FRESH", FIVE_CAT), "General");

// ── Charcuterie keyword fallback also blocked ────────────────────────────────
// Pepperoni keyword could fire if context exclusion didn't propagate
console.log("\n── Full classifier: charcuterie spice/plant-based guards ──");

t("CHORIZO SEASONING full-classifier → not Meat/Deli",
  classify("CHORIZO SEASONING", RICH_WITH_SEAFOOD_KEYWORDS), "(none)");

t("BEYOND MEAT PEPPERONI full-classifier → not Deli",
  classify("BEYOND MEAT PEPPERONI", RICH_WITH_SEAFOOD_KEYWORDS), "(none)");

// ── Multiple matching categories excluded (filter, not find) ────────────────
// A client with both "Seafood" AND "Fish" categories must have BOTH excluded
// when a spice/plant-based guard fires — not just the first one find() returns.
console.log("\n── Full classifier: multiple protein categories excluded ──");

const WITH_SEAFOOD_AND_FISH=[
  {id:"meat",name:"Meat",keywords:["beef","pork","chicken"],is_holding_pen:false},
  {id:"seafood",name:"Seafood",keywords:["salmon","tuna","shrimp"],is_holding_pen:false},
  {id:"fish",name:"Fish",keywords:["salmon","tuna","cod","halibut"],is_holding_pen:false},
  {id:"proteins",name:"Proteins",keywords:["salmon","tuna","chicken","beef"],is_holding_pen:false},
  {id:"deli",name:"Deli",keywords:["pepperoni","salami"],is_holding_pen:false},
  {id:"charcuterie",name:"Charcuterie",keywords:["pepperoni","salami","prosciutto"],is_holding_pen:false},
  {id:"general",name:"General",keywords:[],is_holding_pen:false},
];

// Seafood AND Fish both have "salmon" as keyword; both must be excluded
t("VEGAN SALMON — Seafood excluded (multi-cat)",
  classify("VEGAN SALMON FILLET", WITH_SEAFOOD_AND_FISH), "(none)");

t("SALMON SEASONING — Fish also excluded (multi-cat)",
  classify("SALMON SEASONING", WITH_SEAFOOD_AND_FISH), "(none)");

// "TUNA" appears in Seafood, Fish, and Proteins — all three must be excluded
t("VEGAN TUNA — all protein cats excluded",
  classify("VEGAN TUNA SALAD", WITH_SEAFOOD_AND_FISH), "(none)");

// Both Deli AND Charcuterie categories must be excluded for plant-based charcuterie
t("BEYOND PEPPERONI — Deli and Charcuterie both excluded",
  classify("BEYOND PEPPERONI", WITH_SEAFOOD_AND_FISH), "(none)");

t("CHORIZO SPICE RUB — Deli and Charcuterie both excluded",
  classify("CHORIZO SPICE RUB", WITH_SEAFOOD_AND_FISH), "(none)");

// Genuine seafood still routes to first matching protein category
t("SALMON FILLET — Seafood (not Fish) when Seafood listed first",
  classify("SALMON FILLET", WITH_SEAFOOD_AND_FISH), "Seafood");

// ── Hashbrowns: Prepared Foods preferred when available ─────────────────────
console.log("\n── Full classifier: hashbrown routes to Prepared Foods when available ──");

const WITH_PREPARED_FOODS=[
  {id:"produce",name:"Produce",keywords:["tomato","lettuce","potato"],is_holding_pen:false},
  {id:"meat",name:"Meat",keywords:["beef","pork","chicken"],is_holding_pen:false},
  {id:"frozen",name:"Frozen Foods",keywords:["frozen"],is_holding_pen:false},
  {id:"prepared",name:"Prepared Foods",keywords:["prepared","ready"],is_holding_pen:false},
  {id:"general",name:"General",keywords:[],is_holding_pen:false},
];

// Plain hashbrowns → Prepared Foods (not Frozen Foods, not General)
t("HASHBROWNS plain → Prepared Foods (when available)",
  classify("HASHBROWNS", WITH_PREPARED_FOODS), "Prepared Foods");

// Frozen hashbrowns → Frozen Foods (explicit wins over Prepared Foods)
t("HASHBROWNS FRZN → Frozen Foods (explicit frozen evidence)",
  classify("HASHBROWNS FRZN", WITH_PREPARED_FOODS), "Frozen Foods");

// Fresh hashbrowns → Prepared Foods (refrigerated prep, not frozen)
t("HASHBROWNS FRESH → Prepared Foods (fresh/refrigerated prep)",
  classify("HASHBROWNS FRESH", WITH_PREPARED_FOODS), "Prepared Foods");

// ── Conflicting fresh + frozen labels ────────────────────────────────────────
console.log("\n── Full classifier: conflicting fresh/frozen storage labels ──");

// "FRESH FROZEN" is a real distributor label — evidence conflicts; no confident storage claim
t("HASHBROWNS FRESH FROZEN → Prepared Foods (conflict, no storage assertion)",
  classify("HASHBROWNS FRESH FROZEN", WITH_PREPARED_FOODS), "Prepared Foods");

t("HASHBROWNS FRESH FROZEN (5-cat) → General (conflict, no Prepared Foods cat)",
  classify("HASHBROWNS FRESH FROZEN", FIVE_CAT), "General");

// Without Prepared Foods, conflicts fall to General not Frozen Foods
t("HASHBROWNS FRESH FRZN → General (conflict, fallback)",
  classify("HASHBROWNS FRESH FRZN", RICH_WITH_SEAFOOD_KEYWORDS), "General");

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed?1:0);
