/**
 * Restaurant industry product type priors for pricing basis inference.
 *
 * These are priors — not rules. A product matching a weight-priced category
 * might still be sold per case. The prior raises the confidence of a
 * weight-basis proposal; it never confirms it alone.
 *
 * Maintained here so they can be updated alongside the restaurant vocabulary
 * without touching core inference logic.
 */

// Products typically priced by weight in restaurant foodservice.
// Single words or short phrases that appear in vendor descriptions.
const WEIGHT_PRICED = [
  // Meat
  'beef','steak','steaks','pork','lamb','veal','chop','chops',
  'loin','rib','ribs','tenderloin','brisket','chuck','shank','roast',
  'ground beef','ground lamb','ground pork',
  'burger','patty','patties',
  // Poultry
  'chicken','chic','turkey','duck','poultry',
  'breast','brst','thigh','wing','leg','drumstick','tender',
  // Cured/processed — some are per-lb, some per-case; weight-priced is a prior only
  'bacon','ham','prosciutto','pancetta','salami','sausage',
  // Seafood
  'fish','salmon','tuna','cod','halibut','tilapia','mahi','swordfish',
  'shrimp','scallop','scallops','lobster','crab','octopus','squid','pulpo',
  // Cheese — sold by weight in many cases
  'cheese','mozz','provolone','cheddar','swiss','pepper jack','brie','gouda',
];

// Products typically priced per each or per dozen in restaurant foodservice.
const COUNT_PRICED = [
  'egg','eggs',
  'avocado','avocadoes','avocados',
  'lemon','lemons','lime','limes',
  'artichoke','artichokes',
];

/**
 * Returns product type priors for a vendor description.
 * @param {string} description — lowercased vendor description
 * @returns {{weightPriced: boolean, countPriced: boolean}}
 */
export function restaurantPricingPriors(description) {
  const desc = String(description || '').toLowerCase();
  const weightPriced = WEIGHT_PRICED.some(kw => desc.includes(kw));
  const countPriced  = COUNT_PRICED.some(kw => desc.includes(kw));
  return {weightPriced, countPriced};
}
