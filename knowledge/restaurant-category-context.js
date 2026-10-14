// Restaurant-only product state cues. Keep industry vocabulary outside the
// procurement engine. A prepared form outweighs its raw ingredient category.
const PREPARED = new Set(["prepared", "breaded", "battered", "fried", "fries", "fry", "parfried", "precooked", "cooked", "roasted", "grilled", "canned", "jarred", "marinated", "pickled"]);

// ── Charcuterie / cured meat ──────────────────────────────────────────────────
// These product names are specific enough to establish class without the word
// "meat" or "pork" in the description. A spice-blend or seasoning with the same
// name (e.g. "CHORIZO SEASONING") is excluded by the spice-product guard below.
const CHARCUTERIE = new Set(["pepperoni","salami","bologna","prosciutto","chorizo","mortadella","sopressata","capicola","coppa","pancetta"]);
// Words that indicate a seasoning, spice blend, or flavored product rather than
// the meat itself — used as a negative guard on several rules.
const SPICE_PRODUCT = new Set(["seasoning","spice","spices","flavor","flavored","flavoring","mix","powder","rub","extract","sauce","marinade"]);

// ── Beef cuts ─────────────────────────────────────────────────────────────────
// Only cut names unambiguous enough to establish "beef" without the word appearing.
// Excluded single words that are too generic:
//   "round"   — fires on DINNER ROLL ROUND, PIZZA DOUGH ROUND 8IN, ROUND LETTUCE
//   "chuck"   — fires on CHUCK WAGON SEASONING; too common a colloquial word
//   "hanger"  — fires on equipment (hanger hook, pot hanger)
//   "skirt"   — fires on apparel/equipment
// "eye round" IS included as a two-word phrase (both words required together).
// "loin" requires a beef-specific companion word (see LOIN_COMPANIONS) to prevent
// "TUNA LOIN", "LAMB LOIN CHOP" etc. from firing (lamb IS guarded by species list,
// but tuna is not, so companion check is the safeguard there too).
const BEEF_CUT_WORDS = new Set(["ribeye","brisket","flank","shank","sirloin","striploin"]);
// "loin" on its own is ambiguous (tuna loin, pork loin, lamb loin — pork/lamb guarded
// but tuna is not). Require a companion word that only co-occurs with beef cuts.
const LOIN_COMPANIONS = new Set(["strip","ny","new","york","short","top","bottom","prime"]);
// Species words that block the beef-cut rules even if a cut name is present.
const NON_BEEF_SPECIES = new Set(["pork","veal","lamb","chicken","turkey","fish","seafood","tuna","salmon","swordfish","ahi","cod","halibut","mahi","tilapia","snapper","grouper","trout"]);
// Plant-based guard: applies to beef-cut, patty, charcuterie, and seafood rules.
const PLANT_BASED = new Set(["veggie","vegetable","plant","plantbased","vegan","vegetarian","soy","tofu","beyond","impossible","bean","lentil","falafel","mushroom"]);
// Vegetable words that appear as primary ingredient in non-meat "cutlets" etc.
const VEGETABLE_CUTLETS = new Set(["eggplant","cauliflower","zucchini","portobello","chickpea","squash","artichoke"]);

// ── Seafood by species ────────────────────────────────────────────────────────
// Species not found in typical category keyword lists. These are checked BEFORE
// the beef-cut rules so that "TUNA LOIN" fires seafood, not beef.
// Note: canonical word form strips trailing -s when length>3 and not -ss,
// so "octopus" normalizes to "octopu" — stored here in canonical form.
// "tuna","salmon","cod" etc. are in NON_BEEF_SPECIES but also listed here so
// that "TUNA LOIN" routes to Seafood rather than falling through.
// SPICE_PRODUCT and PLANT_BASED guards: "SALMON SEASONING" and "VEGAN SALMON"
// are not seafood products.
const SEAFOOD_SPECIES = new Set([
  "octopu","squid","calamari","pulpo","wahoo","branzino","dorade","opakapaka","monkfish","cuttlefish","surimi",
  "tuna","salmon","cod","halibut","mahi","tilapia","snapper","grouper","trout","swordfish","ahi",
]);

// ── Salad dressings ───────────────────────────────────────────────────────────
// Variety names that establish "salad dressing / condiment" context.
// Removed: gorgonzola, bleu, roquefort — these are cheese varieties that should
// route to Dairy/Cheese, not condiments (handled at the cheese rule above).
// "thousand" is kept but requires "island" as companion (too generic alone).
const DRESSING_VARIETIES = new Set(["caesar","ranch","vinaigrette","balsamic","tzatziki"]);
// A dressing variety alone is insufficient — the description must also contain a
// word establishing dressing/condiment context. "salad" is intentionally excluded:
//   "CAESAR SALAD KIT" should not route to Condiments — it is a salad product.
//   Only words that specifically name a condiment form (dressing, dip, sauce)
//   establish the context here.
const DRESSING_CONTEXT = new Set(["dress","dressing","dip","sauce"]);

// ── Brand-name spreads ────────────────────────────────────────────────────────
// Specific brand names whose product class is unambiguous. Kept separate from
// generic "spread" logic to avoid "CHOCOLATE SPREAD" or ingredient spread guesses.
const NAMED_SPREADS = new Set(["nutella","vegemite","marmite","jif","skippy"]);

// ── Cheese varieties that the main guard doesn't cover ───────────────────────
// Includes blue-mold cheeses that also appear in dressing names; cheese context wins.
const BLUE_MOLD_CHEESES = new Set(["gorgonzola","roquefort","stilton","bleu"]);

// ── Beverage form indicators ──────────────────────────────────────────────────
// Establishes that the product is a drinkable / hot-beverage product, not just
// an ingredient or confection. "individual" alone is insufficient — "CHOCOLATE BAR
// INDIVIDUAL" is confection, not beverage. Require packaging words specific to
// beverage service (packet, sachet, pod, pouch) or explicit "hot" or "instant".
const BEVERAGE_FORM = new Set(["packet","pkg","pkgs","sachet","pod","pouch","instant","hot","canister","tin"]);

export function restaurantCategoryContext(words, categories) {
  const usable=categories.filter(category=>!category.is_holding_pen);
  const choose=(names,reason)=>{
    const category=names.map(name=>usable.find(c=>name.test(c.name||""))).find(Boolean);
    return category?{category,confidence:"confident",reason}:null;
  };
  const has=(...terms)=>terms.some(term=>words.includes(term));

  // ── Prepared/preserved early shortcut ────────────────────────────────────
  // Route obviously prepared non-produce items to General when no more specific
  // category is available. IMPORTANT: this shortcut must NOT fire for items that
  // carry a produce ingredient word (e.g. "TOMATOES CANNED") because the produce
  // section below routes preserved produce to Canned Goods when that category
  // exists. The shortcut only fires here when no better category is discoverable
  // from the remaining rules — it is a last resort, not a first destination.
  // We intentionally do NOT intercept canned/jarred/marinated/pickled here;
  // those forms are handled in the produce section with proper category preference.
  if(words.some(w=>PREPARED.has(w)&&w!=="canned"&&w!=="jarred"&&w!=="marinated"&&w!=="pickled")) {
    const general=choose([/^general$/i],"Prepared product belongs in General");
    if(general)return general;
  }

  // Product form takes precedence over an ingredient word. The fallback
  // names are the bundled Restaurant template; no categories are created.
  if(has("jam","jelly","jellies","preserves","marmalade"))
    return choose([/^(preserves|condiments|dry goods|grocery)$/i,/^general$/i],"Preserved spread, not fresh produce");
  if(has("wrap","wraps")&&has("wheat","white","spinach","tortilla","tortillas")&&!has("plastic","film","paper","foil"))
    return choose([/^(bakery|bread|breads|bread and bakery)$/i,/^general$/i],"Edible bread wrap");
  if(has("base","bouillon","stock")&&has("beef","chicken","clam","lobster","vegetable"))
    return choose([/^(dry goods|grocery|soup bases|pantry)$/i,/^general$/i],"Prepared soup base or stock");

  // Recognized hard cheese varieties — includes blue-mold cheeses that also appear
  // in dressing contexts. Cheese identity wins when no competing form word is present.
  if((has("swiss","provolone","cheddar","mozzarella")||words.some(w=>BLUE_MOLD_CHEESES.has(w)))
    &&!has("chard","dressing","sauce","bread","cracker","crackers","powder","sandwich","flavored"))
    return choose([/^dairy$/i,/^cheese$/i],"Recognized cheese variety");

  // ── Seafood by species (before beef-cut rules to protect TUNA LOIN etc.) ────
  // SPICE_PRODUCT guard: "SALMON SEASONING" is a spice blend, not seafood.
  // PLANT_BASED guard: "VEGAN SALMON" is a plant-based substitute, not seafood.
  // When either guard fires, return an exclusion so keyword fallback cannot
  // route the product to Seafood via the category's keyword list (e.g. "salmon").
  if(words.some(w=>SEAFOOD_SPECIES.has(w))){
    if(words.some(w=>SPICE_PRODUCT.has(w))||words.some(w=>PLANT_BASED.has(w))){
      // Use filter (not find) so every category matching each pattern is excluded,
      // e.g. both "Seafood" and "Fish" when a client has both.
      const excluded=usable.filter(c=>/^(seafood|fish|meat|proteins?)$/i.test(c.name||"")).map(c=>c.id);
      return excluded.length?{excludedCategoryIds:excluded,reason:"Seafood species word present but product is a spice/plant-based substitute — exclude all protein categories"}:null;
    }
    return choose([/^(seafood|fish)$/i,/^(meat|proteins?)$/i,/^general$/i],"Seafood by species name");
  }

  // ── Charcuterie / cured meat ──────────────────────────────────────────────
  // Excluded when the description establishes a spice/seasoning product or a
  // plant-based substitute rather than the meat itself.
  // When blocked, return an exclusion so keyword fallback cannot route via
  // protein category names (e.g. "BEYOND MEAT PEPPERONI" contains the word
  // "meat" which would otherwise match the Meat category name).
  if(words.some(w=>CHARCUTERIE.has(w))){
    if(words.some(w=>SPICE_PRODUCT.has(w))||words.some(w=>PLANT_BASED.has(w))){
      // Use filter (not find) so every category matching each pattern is excluded,
      // e.g. both "Deli" and "Charcuterie" when a client has both.
      const excluded=usable.filter(c=>/^(deli|charcuterie|meat|proteins?)$/i.test(c.name||"")).map(c=>c.id);
      return excluded.length?{excludedCategoryIds:excluded,reason:"Charcuterie name present but product is a spice blend or plant-based substitute — exclude all protein/deli categories"}:null;
    }
    return choose([/^(deli|charcuterie)$/i,/^(meat|proteins?)$/i,/^general$/i],"Cured/deli meat product");
  }

  // ── Specific beef cut names (without "beef" in description) ──────────────
  // "ribeye", "brisket", "flank", "shank", "sirloin", "striploin" are
  // unambiguous beef cuts when no competing protein species is present.
  if(words.some(w=>BEEF_CUT_WORDS.has(w))
    &&!words.some(w=>NON_BEEF_SPECIES.has(w))
    &&!words.some(w=>PLANT_BASED.has(w))
    &&!words.some(w=>VEGETABLE_CUTLETS.has(w)))
    return choose([/^(meat|proteins?)$/i],"Beef cut by name");

  // "loin" requires a beef-specific companion word because pork loin, tuna loin,
  // lamb loin chop all contain "loin" — and some (tuna) are not in the species guard.
  if(has("loin")
    &&words.some(w=>LOIN_COMPANIONS.has(w))
    &&!words.some(w=>NON_BEEF_SPECIES.has(w))
    &&!words.some(w=>PLANT_BASED.has(w)))
    return choose([/^(meat|proteins?)$/i],"Beef loin cut with location/grade indicator");

  // "Eye round" is a specific beef cut. Both words must be present together.
  // "round" alone is too generic (fires on DINNER ROLL ROUND, PIZZA DOUGH ROUND,
  // ROUND LETTUCE); the phrase "eye round" is unambiguous.
  if(has("eye")&&has("round")
    &&!words.some(w=>NON_BEEF_SPECIES.has(w))
    &&!words.some(w=>PLANT_BASED.has(w)))
    return choose([/^(meat|proteins?)$/i],"Eye round — beef cut by phrase");

  // ── Hamburger / ground-beef patties ──────────────────────────────────────
  // "patt" (canonical of patty) and "hamb" (abbreviation for hamburger) together.
  // A plant-based guard prevents veggie/beyond/impossible patties routing to Meat.
  // "hamb bun" is bakery: the rule requires both the patty word and the hamburger word.
  if(has("patt","patty")&&has("hamb","hamburger","burger")
    &&!words.some(w=>PLANT_BASED.has(w)))
    return choose([/^(meat|proteins?)$/i],"Hamburger patty");

  // ── Salad dressings ───────────────────────────────────────────────────────
  // A known dressing variety plus a dressing-context word (dressing, dip, sauce).
  // "salad" is intentionally NOT a context word here: "CAESAR SALAD KIT" is a
  // salad product, not a condiment. Only words naming a condiment form count.
  if(words.some(w=>DRESSING_VARIETIES.has(w))&&words.some(w=>DRESSING_CONTEXT.has(w)))
    return choose([/^(condiments?|dressings?)$/i,/^(general|dry goods|grocery|pantry)$/i],"Known dressing variety");

  // "Thousand Island" needs both words because "thousand" alone is a quantity term.
  if(has("thousand")&&has("island")&&words.some(w=>DRESSING_CONTEXT.has(w)))
    return choose([/^(condiments?|dressings?)$/i,/^(general|dry goods|grocery|pantry)$/i],"Thousand Island dressing");

  // ── Named brand spreads ───────────────────────────────────────────────────
  // Specific brand names whose product class is unambiguous.
  if(words.some(w=>NAMED_SPREADS.has(w)))
    return choose([/^(condiments?|pantry|dry goods|grocery)$/i,/^general$/i],"Named brand spread");

  // ── Candy and confections ─────────────────────────────────────────────────
  if(has("candy","candies","confection","confections","gummi","gummy","lollipop","lollipops","licorice"))
    return choose([/^(candy|confection)$/i,/^(general|grocery|dry goods)$/i],"Candy or confection product");

  // ── Bakery items ──────────────────────────────────────────────────────────
  // Muffins are bakery. Guard against equipment (tin, pan, liner, mold, rack).
  if(has("muffin","muffins")&&!has("tin","pan","liner","liners","mold","molds","rack","paper"))
    return choose([/^(bakery|bread|breads|bread and bakery)$/i,/^(general|grocery)$/i],"Baked good — muffin");

  // ── Stuffing / stuffing mix ───────────────────────────────────────────────
  // Requires a stuffing-class word AND a dry-mix qualifier.
  // Negative guard on dressing varieties prevents "SALAD DRESSING MIX" from firing.
  if(has("stuffing")&&has("mix","seasoned","seasoning","bread","herb","sage","traditional","trad")
    &&!words.some(w=>DRESSING_VARIETIES.has(w)))
    return choose([/^(dry goods|grocery|pantry)$/i,/^general$/i],"Stuffing or stuffing mix — dry goods");

  // ── Hot chocolate / cocoa beverage products ───────────────────────────────
  // Requires a beverage form indicator (packet, sachet, pod, instant, hot…).
  // "individual" alone is excluded — "CHOCOLATE BAR INDIVIDUAL" is confection.
  // "bar" explicitly blocks this rule: a chocolate bar is confection, not beverage.
  if(has("choc","chocolate","cocoa")
    &&words.some(w=>BEVERAGE_FORM.has(w))
    &&!has("bar","square","tablet","truffle","brownie","cake","chip","chips"))
    return choose([/^(beverage|beverages)$/i,/^(general|dry goods|grocery|pantry)$/i],"Hot chocolate or cocoa beverage product");

  // ── Hash browns ───────────────────────────────────────────────────────────
  // Hash browns are a prepared potato product, not fresh produce.
  // Frozen Foods is preferred only when the product is explicitly frozen or
  // when no competing freshness indicator is present. "FRESH" means it is a
  // refrigerated / fresh-prep item — do not route to Frozen Foods.
  if(has("hashbrown","hashbrowns")){
    // "frzn" is the standard abbreviation for "frozen" in distributor catalogs.
    const isFrozen=has("frozen","frzn");
    const isFresh=has("fresh");
    // Conflicting evidence (both fresh and frozen labels): do not assert storage state.
    if(isFrozen&&isFresh)
      return choose([/^(prepared foods|prepared)$/i,/^general$/i],"Hash brown — conflicting fresh/frozen labels; storage state unresolvable");
    if(isFrozen)
      return choose([/^(frozen foods|frozen)$/i,/^general$/i],"Hash brown — explicitly frozen prepared potato");
    if(isFresh)
      return choose([/^(prepared foods|prepared|refrigerated)$/i,/^general$/i],"Hash brown — fresh/refrigerated prepared potato");
    // No storage indicator: prefer Prepared Foods if available, then General.
    return choose([/^(prepared foods|prepared)$/i,/^general$/i],"Hash brown — prepared potato, storage state unknown");
  }

  // ── Produce section ───────────────────────────────────────────────────────
  const produce=usable.find(c=>/^produce$/i.test(c.name||""));
  if(!produce)return null;
  const produceTerms=new Set((Array.isArray(produce.keywords)?produce.keywords:[])
    .flatMap(term=>String(term).toLowerCase().split(/[^a-z]+/)).filter(Boolean));
  const vegetables=["garlic","tomato","tomatoes","onion","potato","eggplant","artichoke","pepper","carrot","lettuce","broccoli","spinach"];
  const hasIngredient=words.some(w=>produceTerms.has(w)||produceTerms.has(`${w}s`)||vegetables.includes(w));
  if(!hasIngredient)return null;
  const chooseForm=(names,reason)=>choose(names,reason)||{excludedCategoryIds:[produce.id],reason};
  // Fresh Produce excludes preserved, dried, frozen and prepared forms.
  // Specific preparation words outweigh the raw ingredient's keyword.
  // The Canned Goods category (when available) is preferred over General for
  // canned/jarred/pickled produce so that "TOMATOES CANNED" lands there.
  if(has("granulated","powder","powdered","dehydrated","dried","sundried","dry"))
    return chooseForm([/^(dry goods|grocery|pantry|spices|seasonings)$/i,/^general$/i],"Prepared product form: dried or powdered ingredient is not fresh produce");
  if(has("canned","jarred","marinated","pickled","preserved"))
    return chooseForm([/^(canned goods|canned|preserved foods)$/i,/^(grocery|dry goods|pantry)$/i,/^general$/i],"Prepared product form: preserved ingredient is not fresh produce");
  if(has("frozen"))
    return chooseForm([/^(frozen foods|frozen|frozen prepared foods)$/i,/^general$/i],"Prepared product form: frozen ingredient is not fresh produce");
  if(words.some(w=>PREPARED.has(w))){
    const placement=chooseForm([/^(prepared foods|prepared|frozen prepared foods)$/i,/^general$/i],"Prepared product form: prepared ingredient is not fresh produce");
    return {...placement,confidence:"guess"};
  }
  return null;
}
