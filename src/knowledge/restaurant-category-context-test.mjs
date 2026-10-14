/**
 * restaurant-category-context-test.mjs
 *
 * Verifies restaurantCategoryContext against two category trees:
 *   FIVE_CAT  — the 5-category audit fixture (Produce, Meat, Dairy, Paper Goods, General)
 *   RICH_CAT  — a richer tree with Seafood, Deli, Bakery, Frozen Foods, Beverages, Condiments, Pantry
 *
 * Positive cases confirm classification of real product classes.
 * Negative cases confirm that ambiguous or spice-blend descriptions are NOT
 * incorrectly routed — they return null (or fall through to General) rather than
 * misfiring on a keyword.
 *
 * Run: node src/knowledge/restaurant-category-context-test.mjs
 * from the project root directory.
 */

import {restaurantCategoryContext} from "./restaurant-category-context.js";
import {configureProcurement} from "../procurement.js";

configureProcurement({industry:"restaurant",vocabulary:[]});
await new Promise(r=>setTimeout(r,10));

// ── Category fixtures ────────────────────────────────────────────────────────

const FIVE_CAT=[
  {id:"produce",name:"Produce",keywords:["tomato","garlic","onion","potato","lettuce","pepper","carrot","broccoli","spinach","eggplant","artichoke"],is_holding_pen:false},
  {id:"meat",name:"Meat",keywords:["beef","pork","chicken","turkey","lamb","veal"],is_holding_pen:false},
  {id:"dairy",name:"Dairy",keywords:["cheese","milk","butter","cream","yogurt"],is_holding_pen:false},
  {id:"paper",name:"Paper Goods",keywords:["napkin","towel","tissue"],is_holding_pen:false},
  {id:"general",name:"General",keywords:[],is_holding_pen:false},
];

const RICH_CAT=[
  {id:"produce",name:"Produce",keywords:["tomato","garlic","onion","potato","lettuce"],is_holding_pen:false},
  {id:"meat",name:"Meat",keywords:["beef","pork","chicken","turkey"],is_holding_pen:false},
  {id:"seafood",name:"Seafood",keywords:["fish","shrimp","tuna","salmon"],is_holding_pen:false},
  {id:"deli",name:"Deli",keywords:["pepperoni","salami","ham","turkey"],is_holding_pen:false},
  {id:"dairy",name:"Dairy",keywords:["cheese","milk","butter"],is_holding_pen:false},
  {id:"bakery",name:"Bakery",keywords:["bread","muffin","bagel"],is_holding_pen:false},
  {id:"frozen",name:"Frozen Foods",keywords:["frozen"],is_holding_pen:false},
  {id:"bev",name:"Beverages",keywords:["juice","soda","water"],is_holding_pen:false},
  {id:"cond",name:"Condiments",keywords:["ketchup","mustard","mayo"],is_holding_pen:false},
  {id:"pantry",name:"Pantry",keywords:["oil","vinegar","salt"],is_holding_pen:false},
  {id:"general",name:"General",keywords:[],is_holding_pen:false},
];

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Replicates canonicalWord from procurement.js exactly. */
function canonicalWord(w){
  w=String(w||"").toLowerCase().replace(/[^a-z0-9]/g,"");
  if(w.length>4&&w.endsWith("ies"))w=w.slice(0,-3)+"y";
  else if(w.length>4&&/(?:oes|xes|zes|ches|shes)$/.test(w))w=w.slice(0,-2);
  else if(w.length>3&&w.endsWith("s")&&!w.endsWith("ss"))w=w.slice(0,-1);
  return w;
}

function normalize(desc){
  return desc.toLowerCase().replace(/[^a-z0-9]+/g," ").trim().split(/\s+/).map(canonicalWord).filter(Boolean);
}

function classify(desc,cats){
  const r=restaurantCategoryContext(normalize(desc),cats);
  return r&&r.category?r.category.name:"(none)";
}
/** Returns the full context result for confidence-level assertions. */
function classifyFull(desc,cats){
  return restaurantCategoryContext(normalize(desc),cats);
}

let passed=0,failed=0;
function t(label,actual,expected){
  if(actual===expected){
    console.log(`  PASS  ${label}`);
    passed++;
  }else{
    console.error(`  FAIL  ${label}`);
    console.error(`        expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`);
    failed++;
  }
}

// ── Charcuterie / cured meats ────────────────────────────────────────────────
console.log("\n── Charcuterie / cured meats ──");
// No Deli category: fall back to Meat
t("PEPPERONI LEONI SLICING (5-cat) → Meat",        classify("PEPPERONI LEONI SLICING",FIVE_CAT),"Meat");
t("SALAMI SNDWCH MAKER-GEN (5-cat) → Meat",        classify("SALAMI SNDWCH MAKER-GEN",FIVE_CAT),"Meat");
// Deli category available: prefer it
t("PEPPERONI LEONI SLICING (rich) → Deli",         classify("PEPPERONI LEONI SLICING",RICH_CAT),"Deli");
t("SALAMI SNDWCH MAKER-GEN (rich) → Deli",         classify("SALAMI SNDWCH MAKER-GEN",RICH_CAT),"Deli");
t("PROSCIUTTO DI PARMA (rich) → Deli",             classify("PROSCIUTTO DI PARMA",RICH_CAT),"Deli");
t("CHORIZO SEASONING (5-cat) → none",              classify("CHORIZO SEASONING",FIVE_CAT),"(none)");
t("SALAMI FLAVORED CHIPS (rich) → none",           classify("SALAMI FLAVORED CHIPS",RICH_CAT),"(none)");
t("BEYOND MEAT PEPPERONI (rich) → none",           classify("BEYOND MEAT PEPPERONI",RICH_CAT),"(none)");

// ── Beef cuts ────────────────────────────────────────────────────────────────
console.log("\n── Beef cuts ──");
t("RIBEYE STEAK 16OZ (5-cat) → Meat",              classify("RIBEYE STEAK 16OZ",FIVE_CAT),"Meat");
t("NY STRIP LOIN (5-cat) → Meat",                  classify("NY STRIP LOIN",FIVE_CAT),"Meat");
t("SIRLOIN TIPS BEEF (5-cat) → Meat",              classify("SIRLOIN TIPS BEEF",FIVE_CAT),"Meat");
t("BRISKET FLAT BEEF (5-cat) → Meat",              classify("BRISKET FLAT BEEF",FIVE_CAT),"Meat");
// Loin requires companion word
t("TUNA LOIN (rich) → Seafood (not beef)",         classify("TUNA LOIN",RICH_CAT),"Seafood");
t("LAMB LOIN CHOP (5-cat) → none (species block)", classify("LAMB LOIN CHOP",FIVE_CAT),"(none)");
t("PORK LOIN (5-cat) → none (species block)",      classify("PORK LOIN",FIVE_CAT),"(none)");
// Plant-based guard
t("VEGGIE BURGER PATTY (rich) → none",             classify("VEGGIE BURGER PATTY",RICH_CAT),"(none)");
t("IMPOSSIBLE BURGER (rich) → none",               classify("IMPOSSIBLE BURGER",RICH_CAT),"(none)");
// Hamburger patty
t("HAMBURGER PATTY 80/20 (5-cat) → Meat",         classify("HAMBURGER PATTY 80/20",FIVE_CAT),"Meat");

// ── Seafood by species ───────────────────────────────────────────────────────
console.log("\n── Seafood by species ──");
t("CALAMARI RINGS (rich) → Seafood",               classify("CALAMARI RINGS",RICH_CAT),"Seafood");
t("OCTOPUS TENTACLES (rich) → Seafood",            classify("OCTOPUS TENTACLES",RICH_CAT),"Seafood");
t("MAHI MAHI FILLET (rich) → Seafood",             classify("MAHI MAHI FILLET",RICH_CAT),"Seafood");
t("SNAPPER RED WHOLE (rich) → Seafood",            classify("SNAPPER RED WHOLE",RICH_CAT),"Seafood");
t("WAHOO STEAK (rich) → Seafood",                  classify("WAHOO STEAK",RICH_CAT),"Seafood");

// ── Cheese and dairy ─────────────────────────────────────────────────────────
console.log("\n── Cheese and dairy ──");
t("CHEDDAR CHEESE SHREDDED (5-cat) → Dairy",      classify("CHEDDAR CHEESE SHREDDED",FIVE_CAT),"Dairy");
t("MOZZARELLA SHREDDED (5-cat) → Dairy",          classify("MOZZARELLA SHREDDED",FIVE_CAT),"Dairy");
t("PROVOLONE SLICED (5-cat) → Dairy",             classify("PROVOLONE SLICED",FIVE_CAT),"Dairy");
t("SWISS CHEESE SLICED (5-cat) → Dairy",          classify("SWISS CHEESE SLICED",FIVE_CAT),"Dairy");
t("GORGONZOLA CHEESE (rich) → Dairy",             classify("GORGONZOLA CHEESE",RICH_CAT),"Dairy");
t("BLEU CHEESE CRUMBLES (rich) → Dairy",          classify("BLEU CHEESE CRUMBLES",RICH_CAT),"Dairy");
t("ROQUEFORT WEDGE (rich) → Dairy",               classify("ROQUEFORT WEDGE",RICH_CAT),"Dairy");
// Cheese rule guards against dressing context for named varieties:
// when "dressing" appears without "cheese", gorgonzola does not force Dairy
// (it falls through to keyword scoring, which routes it via "dressing" keyword)
t("GORGONZOLA DRESSING (rich) → none from context engine",
                                                   classify("GORGONZOLA DRESSING",RICH_CAT),"(none)");

// ── Salad dressings ──────────────────────────────────────────────────────────
console.log("\n── Salad dressings ──");
t("CAESAR DRESSING (rich) → Condiments",           classify("CAESAR DRESSING",RICH_CAT),"Condiments");
t("RANCH DRESSING (rich) → Condiments",            classify("RANCH DRESSING",RICH_CAT),"Condiments");
t("BALSAMIC VINAIGRETTE DRESSING (rich) → Condiments",
                                                   classify("BALSAMIC VINAIGRETTE DRESSING",RICH_CAT),"Condiments");
t("THOUSAND ISLAND DRESSING (rich) → Condiments", classify("THOUSAND ISLAND DRESSING",RICH_CAT),"Condiments");
// Context word required: variety alone is not enough
t("CAESAR CHICKEN BREAST (5-cat) → none",         classify("CAESAR CHICKEN BREAST",FIVE_CAT),"(none)");
t("RANCH CHICKEN BREAST (rich) → none",           classify("RANCH CHICKEN BREAST",RICH_CAT),"(none)");
// Thousand Island: requires both words + context
t("THOUSAND ISLAND no context (rich) → none",     classify("THOUSAND ISLAND",RICH_CAT),"(none)");

// ── Named brand spreads ──────────────────────────────────────────────────────
console.log("\n── Named brand spreads ──");
t("NUTELLA HAZELNUT SPREAD (rich) → Condiments",  classify("NUTELLA HAZELNUT SPREAD",RICH_CAT),"Condiments");
t("JIF PEANUT BUTTER (rich) → Condiments",        classify("JIF PEANUT BUTTER",RICH_CAT),"Condiments");
// Generic spread does not fire the brand rule
t("CHOCOLATE SPREAD (rich) → none",               classify("CHOCOLATE SPREAD",RICH_CAT),"(none)");

// ── Bakery ───────────────────────────────────────────────────────────────────
console.log("\n── Bakery ──");
t("BLUEBERRY MUFFIN (rich) → Bakery",             classify("BLUEBERRY MUFFIN",RICH_CAT),"Bakery");
t("SPINACH WRAP TORTILLA (rich) → Bakery",        classify("SPINACH WRAP TORTILLA",RICH_CAT),"Bakery");
t("SPINACH WRAP TORTILLA (5-cat) → General",      classify("SPINACH WRAP TORTILLA",FIVE_CAT),"General");
// Equipment guard
t("MUFFIN TIN (5-cat) → none",                    classify("MUFFIN TIN",FIVE_CAT),"(none)");
t("MUFFIN PAN (5-cat) → none",                    classify("MUFFIN PAN",FIVE_CAT),"(none)");

// ── Hash browns ──────────────────────────────────────────────────────────────
console.log("\n── Hash browns ──");
t("HASHBROWN PATTIES FRZN (rich) → Frozen Foods", classify("HASHBROWN PATTIES FRZN",RICH_CAT),"Frozen Foods");
t("HASHBROWNS (5-cat) → General",                 classify("HASHBROWNS",FIVE_CAT),"General");
t("FF HASHBROWNS (5-cat) → General (FF=unresolved)",
                                                   classify("FF HASHBROWNS",FIVE_CAT),"General");

// ── Hot chocolate / cocoa beverages ─────────────────────────────────────────
console.log("\n── Hot chocolate / cocoa beverages ──");
t("HOT CHOCOLATE PACKET (rich) → Beverages",      classify("HOT CHOCOLATE PACKET",RICH_CAT),"Beverages");
t("COCOA INSTANT PKG (rich) → Beverages",         classify("COCOA INSTANT PKG",RICH_CAT),"Beverages");

// ── Stuffing ─────────────────────────────────────────────────────────────────
console.log("\n── Stuffing ──");
t("STUFFING MIX HERB (rich) → Pantry",            classify("STUFFING MIX HERB",RICH_CAT),"Pantry");
// Stuffing rule is guarded against dressing varieties — no false fire
t("CAESAR SALAD DRESSING MIX (rich) → Condiments",classify("CAESAR SALAD DRESSING MIX",RICH_CAT),"Condiments");

// ── Candy ────────────────────────────────────────────────────────────────────
console.log("\n── Candy ──");
// No candy category → General is the expected fallback
t("GUMMY BEARS 5LB (5-cat) → General",            classify("GUMMY BEARS 5LB",FIVE_CAT),"General");
t("GUMMY BEARS 5LB (rich) → General",             classify("GUMMY BEARS 5LB",RICH_CAT),"General");
// With an explicit candy category, candy goes there
{
  const withCandy=[...RICH_CAT,{id:"candy",name:"Candy",keywords:[],is_holding_pen:false}];
  t("GUMMY BEARS (with Candy cat) → Candy",       classify("GUMMY BEARS",withCandy),"Candy");
  t("LICORICE TWISTS (with Candy cat) → Candy",   classify("LICORICE TWISTS",withCandy),"Candy");
}

// ── Produce routing ──────────────────────────────────────────────────────────
console.log("\n── Produce routing (prepared forms) ──");
// Prepared/dried/frozen produce should NOT land in Produce
t("GARLIC POWDER (5-cat) → General",              classify("GARLIC POWDER",FIVE_CAT),"General");
t("TOMATO CANNED (5-cat) → General",              classify("TOMATO CANNED",FIVE_CAT),"General");
t("POTATO FROZEN DICED (5-cat) → General",        classify("POTATO FROZEN DICED",FIVE_CAT),"General");
t("SPINACH DRIED (5-cat) → General",              classify("SPINACH DRIED",FIVE_CAT),"General");

// ── Holding pen excluded ─────────────────────────────────────────────────────
console.log("\n── Holding pen excluded ──");
t("RIBEYE STEAK with holding pen → Meat",
  classify("RIBEYE STEAK",[{id:"meat",name:"Meat",keywords:[],is_holding_pen:false},{id:"h",name:"Uncategorized",is_holding_pen:true}]),
  "Meat");

// ── ChatGPT regression cases (v2 fixes) ─────────────────────────────────────
// Rich tree extended with Canned Goods for the canned-tomato test
const RICH_CAT_CANNED=[
  ...RICH_CAT.filter(c=>c.id!=="general"),
  {id:"canned",name:"Canned Goods",keywords:[],is_holding_pen:false},
  {id:"general",name:"General",keywords:[],is_holding_pen:false},
];

console.log("\n── ChatGPT regression: caesar salad kit ──");
t("CAESAR SALAD KIT (rich) → none (not Condiments)",
  classify("CAESAR SALAD KIT",RICH_CAT),"(none)");
t("CAESAR SALAD KIT (5-cat) → none (not Condiments)",
  classify("CAESAR SALAD KIT",FIVE_CAT),"(none)");

console.log("\n── ChatGPT regression: chocolate bar ──");
t("CHOCOLATE BAR INDIVIDUAL (rich) → none (not Beverages)",
  classify("CHOCOLATE BAR INDIVIDUAL",RICH_CAT),"(none)");
t("DARK CHOCOLATE BAR 72% (rich) → none (not Beverages)",
  classify("DARK CHOCOLATE BAR 72%",RICH_CAT),"(none)");
// Packet form should still route to Beverages
t("HOT CHOCOLATE PACKET (rich) → Beverages (packet = beverage form)",
  classify("HOT CHOCOLATE PACKET",RICH_CAT),"Beverages");

console.log("\n── ChatGPT regression: fresh hashbrowns ──");
t("HASHBROWNS FRESH (rich) → General (not Frozen Foods)",
  classify("HASHBROWNS FRESH",RICH_CAT),"General");
t("HASHBROWNS FRESH (5-cat) → General (not Frozen Foods)",
  classify("HASHBROWNS FRESH",FIVE_CAT),"General");
// Frozen form should still route to Frozen Foods
t("HASHBROWN PATTIES FRZN (rich) → Frozen Foods",
  classify("HASHBROWN PATTIES FRZN",RICH_CAT),"Frozen Foods");

console.log("\n── ChatGPT regression: salmon seasoning ──");
t("SALMON SEASONING (rich) → none (not Seafood)",
  classify("SALMON SEASONING",RICH_CAT),"(none)");
t("TUNA SPICE RUB (rich) → none (not Seafood)",
  classify("TUNA SPICE RUB",RICH_CAT),"(none)");

console.log("\n── ChatGPT regression: vegan salmon ──");
t("VEGAN SALMON FILLET (rich) → none (not Seafood)",
  classify("VEGAN SALMON FILLET",RICH_CAT),"(none)");
t("PLANT BASED TUNA (rich) → none (not Seafood)",
  classify("PLANT BASED TUNA",RICH_CAT),"(none)");

console.log("\n── ChatGPT regression: canned tomatoes → Canned Goods ──");
t("TOMATOES CANNED (with Canned Goods) → Canned Goods",
  classify("TOMATOES CANNED",RICH_CAT_CANNED),"Canned Goods");
t("TOMATO CANNED (5-cat, no Canned Goods) → General",
  classify("TOMATO CANNED",FIVE_CAT),"General");

console.log("\n── EYE ROUND NR phrase regression ──");
t("EYE ROUND NR (5-cat) → Meat",
  classify("EYE ROUND NR",FIVE_CAT),"Meat");
t("EYE ROUND ROAST (5-cat) → Meat",
  classify("EYE ROUND ROAST",FIVE_CAT),"Meat");
// "round" alone must not fire
t("DINNER ROLL ROUND (5-cat) → none (round alone ambiguous)",
  classify("DINNER ROLL ROUND",FIVE_CAT),"(none)");

// ── Blue cheese: companion-word + form-word requirement ──────────────────────
// "blue" alone is a color — must not route to Dairy.
// "blue" + a cheese companion word (cheese, chs, chse) establishes a cheese
// REFERENCE in the text — it does not confirm the finished-product form.
// "CHUNKY BLUE CHS KENS KEN" has a cheese reference but no form word
// (crumbles, shredded, sliced, wedge, block, chunk) — product type is
// unresolved; context engine returns null and keyword scoring decides.
// Only route to Dairy confidently when a form word confirms solid cheese.
// Unambiguous variety names (gorgonzola, bleu, swiss, etc.) do not require
// a form word — the variety name is sufficient evidence on its own.
console.log("\n── Blue cheese: companion-word + form-word requirement ──");
// Abbreviated description, form unresolved → confidence:"review" (Dairy suggested, type ambiguous).
// The context engine now returns a "review" confidence result so keyword scoring cannot
// override it. The category name is Dairy — but the confidence is NOT "confident".
t("CHUNKY BLUE CHS KENS KEN (rich) → Dairy (review confidence: form unresolved, type ambiguous)",
  classify("CHUNKY BLUE CHS KENS KEN",RICH_CAT),"Dairy");
t("CHUNKY BLUE CHS KENS KEN (rich) → confidence:review (not confident, blocks Order Guide)",
  classifyFull("CHUNKY BLUE CHS KENS KEN",RICH_CAT)?.confidence,"review");
// Form word "crumbles" present → Dairy confirmed
t("BLUE CHEESE CRUMBLES (rich) → Dairy (form word 'crumbles' confirms solid cheese)",
  classify("BLUE CHEESE CRUMBLES",RICH_CAT),"Dairy");
// "bleu" is an unambiguous variety name — form word not required
t("BLEU CHEESE CRUMBLES (rich) → Dairy",
  classify("BLEU CHEESE CRUMBLES",RICH_CAT),"Dairy");
// Abbreviated form with form word
t("BLUE CHS CRUMBLES (rich) → Dairy (chs companion + crumbles form word)",
  classify("BLUE CHS CRUMBLES",RICH_CAT),"Dairy");
// Abbreviated dressing forms: cheese rule blocked by dressing guard, dressing rule catches
t("BLUE CHS DRESSING (rich) → Condiments (blue+chs companion, dressing guard active)",
  classify("BLUE CHS DRESSING",RICH_CAT),"Condiments");
t("BLEU CHS DRESSING (rich) → Condiments (bleu in DRESSING_VARIETIES + dressing guard)",
  classify("BLEU CHS DRESSING",RICH_CAT),"Condiments");
// "blue" alone (no cheese companion) must NOT route to Dairy
t("BLUE NAPKINS (5-cat) → none ('blue' alone is a color)",
  classify("BLUE NAPKINS",FIVE_CAT),"(none)");
t("BLUE APRONS (5-cat) → none ('blue' alone is a color)",
  classify("BLUE APRONS",FIVE_CAT),"(none)");
t("BLUE GLOVES (5-cat) → none ('blue' alone is a color)",
  classify("BLUE GLOVES",FIVE_CAT),"(none)");
// Blue cheese dressing/dip: cheese rule blocked by guard, dressing rule catches it
t("BLUE CHEESE DRESSING (rich) → Condiments",
  classify("BLUE CHEESE DRESSING",RICH_CAT),"Condiments");
t("CHUNKY BLUE CHEESE DRESSING (rich) → Condiments",
  classify("CHUNKY BLUE CHEESE DRESSING",RICH_CAT),"Condiments");
t("BLUE CHEESE DIP (rich) → Condiments",
  classify("BLUE CHEESE DIP",RICH_CAT),"Condiments");
// Blue cheese dressing without a cheese companion: dressing rule still fires (blue in DRESSING_VARIETIES + context word)
t("BLUE DRESSING (rich) → Condiments",
  classify("BLUE DRESSING",RICH_CAT),"Condiments");
// Bleu in dressing context — guarded by dressing keyword
t("BLEU CHEESE DRESSING (rich) → Condiments",
  classify("BLEU CHEESE DRESSING",RICH_CAT),"Condiments");

// ── Exact screenshot descriptions ─────────────────────────────────────────────
// These are the live import descriptions from the screenshots. The expected result
// from the context engine is "(none)" — they fall to keyword scoring. The actual
// live classification depends on category.keywords in the database, which is not
// available here. Reported as "(none)" to confirm no rule fires incorrectly.
console.log("\n── Screenshot descriptions through context engine ──");
t("(KENS) PARM.PEPPERCORN (rich) → none (no rule fires)",
  classify("(KENS) PARM.PEPPERCORN",RICH_CAT),"(none)");
t("HALF DEEP PAN (rich) → none (no context rule; keyword-driven)",
  classify("HALF DEEP PAN",RICH_CAT),"(none)");
// "CHUNKY BLUE CHS KENS KEN" — blue+chs is a cheese reference but form is
// unresolved (no crumbles/shredded/block/wedge); context returns confidence:"review".
// Dairy is the suggested category, but the confidence is explicitly NOT "confident" —
// keyword scoring cannot override this signal, and the uncertainty survives into
// import_row.reviewRequired=true, blocking the Order Guide until a human resolves it.
t("CHUNKY BLUE CHS KENS KEN (rich) → Dairy (screenshot row: review confidence, blocks Order Guide)",
  classify("CHUNKY BLUE CHS KENS KEN",RICH_CAT),"Dairy");
t("CHUNKY BLUE CHS KENS KEN (rich) → confidence:review (not overridable by keyword scoring)",
  classifyFull("CHUNKY BLUE CHS KENS KEN",RICH_CAT)?.confidence,"review");

// ── Italian cheese and Caesar salad kit — direct classification ───────────────
// Tests the classification engine directly (not compareProductIdentity).
// "ITALIAN CHEESE": no recognized cheese variety, no dressing variety → none
// "CAESAR SALAD KIT": caesar in DRESSING_VARIETIES but "salad" not in DRESSING_CONTEXT → none
// Both fall to keyword scoring against live categories.
console.log("\n── Italian cheese and Caesar salad kit classification ──");
t("ITALIAN CHEESE (rich) → none (no cheese variety word triggers context rule)",
  classify("ITALIAN CHEESE",RICH_CAT),"(none)");
t("CAESAR SALAD KIT (rich) → none ('salad' excluded from DRESSING_CONTEXT)",
  classify("CAESAR SALAD KIT",RICH_CAT),"(none)");
t("KENS CAESAR DRESSING (rich) → Condiments",
  classify("KENS CAESAR DRESSING",RICH_CAT),"Condiments");
// "KENS ITALIAN DRESSING": 'italian' not in DRESSING_VARIETIES → none (keyword-driven)
t("KENS ITALIAN DRESSING (rich) → none ('italian' not in DRESSING_VARIETIES)",
  classify("KENS ITALIAN DRESSING",RICH_CAT),"(none)");

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed?1:0);
