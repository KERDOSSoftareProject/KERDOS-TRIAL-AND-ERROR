import { classifyCategory, safeProductScore, normalizedPrice, eachPrice, measurement, nextCategoryRange, parsePackSize, packsEquivalent,
  pricePerUnit, unitsForDimension, brandsMatch, bestCatalogMatch, bestPurchasingMatch, comparePurchasingPack, configureVocabulary, compareProductIdentity, quoteStatus, MATCH_POLICY } from "./procurement.js";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

// The dictionary lives in knowledge/ at the repo root; fall back to a copy
// beside this file so the test runs from any working directory.
const here = path.dirname(fileURLToPath(import.meta.url));
const dictPath = [path.join(here,"..","knowledge","restaurant_food_dictionary_v1.sql"), path.join(here,"restaurant_food_dictionary_v1.sql")]
  .find(p => fs.existsSync(p));
if (!dictPath) { console.error("restaurant_food_dictionary_v1.sql not found in knowledge/ or beside regression.mjs"); process.exit(1); }
const sql = fs.readFileSync(dictPath,"utf8");
const rows=[...sql.matchAll(/\('Restaurant','([^']+)','(\[.*?\])'::jsonb,\d+\)/g)];
const cats = rows.map(m=>({name:m[1], keywords:JSON.parse(m[2])}));
console.log("Loaded dictionary categories:", cats.map(c=>`${c.name}(${c.keywords.length})`).join(", "));

let pass=0, fail=0;
const t=(label,got,exp)=>{const ok=String(got)===String(exp);console.log(`${ok?"PASS":"FAIL"}  ${label.padEnd(46)} got=${String(got).padEnd(14)}exp=${exp}`);ok?pass++:fail++;};

console.log("\n-- CLASSIFICATION (byproducts must not be meat/dairy/produce) --");
for(const [d,e] of [["CHICKEN BASE","General"],["BEEF BASE","General"],["CHICKEN BROTH","General"],
 ["COCONUT MILK","General"],["PEANUT BUTTER","General"],["IMITATION CRAB MEAT","General"],
 ["EGG SUBSTITUTE","General"],["POTATO CHIPS","General"],["ONION POWDER","General"],
 ["CHICKEN BREAST","Meat"],["BEEF TENDERLOIN","Meat"],["CRAB LEGS","Meat"],
 ["WHITE MUSHROOM","Produce"],["ROMA TOMATOES","Produce"],["EGGS X/LG","Dairy"],["UNSALTED BUTTER","Dairy"]])
  { const c=classifyCategory(d,cats); t(`"${d}"`, c?c.name:"UNCATEGORIZED", e); }

console.log("\n-- MATCHING (0.85 = auto-link threshold) --");
for(const [a,b,e] of [["Roma Tomatoes 25lb","Roma Tomatoes, 25 lb","LINK"],
 ["Chicken Breast 40lb","Chicken Thighs 40lb","review"],["Bacon 1lb","Bacon 5lb","review"],
 ["Tomato Sauce","Tomato Paste","review"],["TOMATO","GRAPE TOMATO","review"]])
  { const s=safeProductScore(a,b); t(`${a} | ${b}`, s>=0.85?"LINK":"review", e); }

console.log("\n-- UNITS (construction readiness) --");
t("8 ft is length", measurement(8,"ft")?.dimension, "length");
t("2 in is length", measurement(2,"in")?.dimension, "length");
t("50 lb is mass", measurement(50,"lb")?.dimension, "mass");
t("5 gal is volume", measurement(5,"gal")?.dimension, "volume");
t("24 ct is count", measurement(24,"ct")?.dimension, "count");
t("unknown unit kept", measurement(3,"sheet")?.dimension, "unknown");

console.log("\n-- PACK / PRICE --");
t("4/1 GAL each price", eachPrice(74.89,"4/1 GAL")?.price, 18.72);
t("50 LB normalized unit", normalizedPrice(25,"50 LB")?.unit, "G");
t("category block", JSON.stringify(nextCategoryRange([{range_end:19999}])), '{"range_start":20000,"range_end":29999}');
t("same normalized pack",packsEquivalent("4/1 GAL","4 x 1 gallon"),true);
t("same total but different case configuration is not interchangeable",packsEquivalent("4/1 GAL","2/2 GAL"),false);
t("same number, different dimensions",packsEquivalent("1 G","1 ML"),false);
t("same custom unit",packsEquivalent("24 SHEET","24 sheet"),true);
t("different custom units",packsEquivalent("24 SHEET","24 TILE"),false);

console.log("\n-- PER-UNIT PRICE (pack sizes made comparable) --");
t("50 LB @ $45 -> per LB", pricePerUnit(45,"50 LB","LB")?.price, 0.9);
t("4/1 GAL @ $74.89 -> per GAL", pricePerUnit(74.89,"4/1 GAL","GAL")?.price, 18.7225);
t("4/1 GAL @ $74.89 -> per FL OZ", pricePerUnit(74.89,"4/1 GAL","fl oz")?.price, 0.1463);
t("wrong dimension keeps pack unit", pricePerUnit(45,"50 LB","GAL")?.unit, "LB");
t("no target -> pack unit", pricePerUnit(45,"50 LB")?.unit, "LB");
t("unknown unit 24 SHEET @ $12", pricePerUnit(12,"24 SHEET")?.price, 0.5);
t("mass units listed", unitsForDimension("mass").join(","), "G,KG,OZ,LB");

console.log("\n-- BRAND LOCK --");
t("same brand, case/space differ", brandsMatch(" Tyson ","tyson"), true);
t("different brand", brandsMatch("Tyson","Perdue"), false);
t("missing brand never matches a lock", brandsMatch("","Tyson"), false);

console.log("\n-- CATALOG MATCH SELECTION (flexible vs strict) --");
t("different cuts never link", bestCatalogMatch("Chicken Breast 40lb",[{name:"Chicken Thighs 40lb"}]), null);
t("strict: different cuts rejected", bestCatalogMatch("Chicken Breast 40lb",[{name:"Chicken Thighs 40lb",matching_behavior:"strict"}]), null);
t("strict: exact-grade still links", bestCatalogMatch("Chicken Breasts 40 lb case",[{name:"Chicken Breast 40lb",matching_behavior:"strict"}])?.track, "exact");
t("below review floor -> null", bestCatalogMatch("Paper Towels",[{name:"Chicken Thighs 40lb"}]), null);
t("policy names the floor", MATCH_POLICY.reviewFloor, 0.5);

console.log("\n-- VOCABULARY (the engine learns a trade from data rows) --");
configureVocabulary([
  {kind:"unit",term:"sheets",canonical:"SHEET"},{kind:"unit",term:"sheet",canonical:"SHEET"},
  {kind:"unit",term:"bdft",canonical:"BF"},{kind:"unit",term:"board feet",canonical:"BF"},
  {kind:"packaging",term:"bundle"},{kind:"stopword",term:"premium"},
  {kind:"synonym",term:"chix",canonical:"chicken"},{kind:"synonym",term:"plywd",canonical:"plywood"},
]);
t("taught unit parses a pack", parsePackSize("24 sheets")?.unit, "SHEET");
t("taught unit prices per unit", pricePerUnit(48,"24 sheets","sheet")?.price, 2);
t("two-word taught unit", parsePackSize("500 board feet")?.unit, "BF");
t("pack syntax variants agree", packsEquivalent("4-5LB","4/5 LB"), true);
t("space-separated pack agrees", packsEquivalent("12 32 OZ","12-32OZ"), true);
t("a second pack component requires review", parsePackSize("4/5 LB + 2 EA")?.parsed, false);
t("variable-weight marker requires review", parsePackSize("1-40# CB")?.parsed, false);
t("taught unit: size conflict still blocks", safeProductScore("Plywood 24 sheets","Plywood 12 sheets"), 0);
t("synonym links two spellings", safeProductScore("Chix Breast 40lb","Chicken Breast 40lb")>=MATCH_POLICY.autoLink, true);
t("synonym in another trade", safeProductScore("PLYWD 3/4 4x8","Plywood 3/4 4x8")>=MATCH_POLICY.autoLink, true);
t("packaging word is not a product word", safeProductScore("Shingles bundle","Shingles"), 1);
t("stopword carries no meaning", safeProductScore("Premium Widgets","Widgets"), 1);
configureVocabulary();
t("reset: synonym forgotten", safeProductScore("Chix Breast 40lb","Chicken Breast 40lb")>=MATCH_POLICY.autoLink, false);
t("reset: base unit still works", pricePerUnit(45,"50 LB","LB")?.price, 0.9);

console.log("\n-- CONTEXT IDENTITY + PRICE LIFECYCLE --");
for(const [a,b,e] of [
  ["Chicken base","Chicken breast","different"],
  ["Chicken thighs","Chicken breast","different"],
  ["Boneless chicken breast","Bone-in chicken breast","different"],
  ["Boneless chicken breast","Chicken breast","review"],
  ["Chicken breast 40lb","Chicken breast 20lb","review"],
  ["Chicken breast 40lb","Chicken breast, 40 lb","same"],
  ["Tomato sauce","Tomato paste","different"],
  ["Plywood 2x4","Plywood 2x6","review"],
]) t(`${a} vs ${b}`, compareProductIdentity(a,b).status,e);
t("uncertain boneless not auto linked",bestCatalogMatch("Boneless chicken breast",[{name:"Chicken breast"}])?.track,"similar");
t("same identity wins over fuzzy candidate",bestCatalogMatch("Chicken breast 40lb",[{name:"Chicken breast"},{name:"Chicken breast 40 lb"}])?.catalogItem?.name,"Chicken breast 40 lb");
t("slice counts remain distinct",compareProductIdentity("American cheese 120 slices","American cheese 160 slices").status,"review");
t("equal total with different case configuration needs review",comparePurchasingPack("4/1 GAL","2/2 GAL").status,"review");
t("different count packs cannot automatically compete",bestPurchasingMatch("American cheese","160 CT",[{name:"American cheese",pack_size:"120 CT"}])?.track,"similar");
t("identical product and pack can auto link",bestPurchasingMatch("American cheese","120 CT",[{name:"American cheese",pack_size:"120 CT"}])?.track,"exact");
t("missing pack is never an exact product match",bestPurchasingMatch("American cheese",null,[{name:"American cheese",pack_size:"120 CT"}])?.track,"similar");
t("invoice price cannot become live quote",quoteStatus({price_source:"invoice",price:40}),"invoice_only");
t("manual quote remains current",quoteStatus({price_source:"price_list",price:40,last_updated:"2020-01-01"},{price_refresh_mode:"manual"},new Date("2026-09-21")),"current");
t("legacy day count cannot silently enable expiration",quoteStatus({price_source:"price_list",price:40,last_updated:"2020-01-01"},{price_refresh_days:7},new Date("2026-09-21")),"current");
t("automatic 7-day quote expires",quoteStatus({price:40,last_updated:"2026-09-01"},{price_refresh_mode:"automatic",price_refresh_days:7},new Date("2026-09-21")),"expired");
t("automatic quote without timestamp expires",quoteStatus({price:40},{price_refresh_mode:"automatic",price_refresh_days:7},new Date("2026-09-21")),"expired");
t("malformed quote timestamp expires",quoteStatus({price:40,last_updated:"not-a-date"},{price_refresh_mode:"automatic",price_refresh_days:7},new Date("2026-09-21")),"expired");
t("manual expiration overrides policy",quoteStatus({price:40,price_expired_at:"2026-09-20",last_updated:"2026-09-21"},{price_refresh_mode:"manual"},new Date("2026-09-21")),"expired");
t("vendor stated expiry overrides manual",quoteStatus({price:40,price_quote_valid_until:"2026-09-20",last_updated:"2026-09-21"},{price_refresh_mode:"manual"},new Date(2026,8,21,12)),"expired");
t("unpriced offer not orderable",quoteStatus({price:0,price_source:"price_list"}),"unavailable");
console.log(`\n${pass} passed, ${fail} failed`);
process.exit(fail?1:0);
