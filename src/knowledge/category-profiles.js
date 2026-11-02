import {restaurantUnitCostUnits} from "./restaurant-unit-policy.js";
import {restaurantCategoryContext} from "./restaurant-category-context.js";
import {restaurantPackContext} from "./restaurant-pack-context.js";
import {restaurantPricingPriors} from "./restaurant-pricing-priors.js";
import {restaurantQuoteContext} from "./restaurant-quote-context.js";
import {restaurantProductContext} from "./restaurant-product-context.js";
import {restaurantDictionaries,restaurantUnitVocabulary,RESTAURANT_DICTIONARY_VERSION} from "./restaurant-dictionaries.js";
import {restaurantAssociations} from './restaurant-associations.js';
import {restaurantClientNames} from './restaurant-client-names.js';

// Profiles supply industry-specific interpretation; procurement stays generic.
const profiles=new Map([["restaurant",{
  category:restaurantCategoryContext,quote:restaurantQuoteContext,product:restaurantProductContext,pack:restaurantPackContext,pricingPriors:restaurantPricingPriors,
  unitCostUnits:restaurantUnitCostUnits,
  dictionaries:restaurantDictionaries,vocabulary:restaurantUnitVocabulary,version:RESTAURANT_DICTIONARY_VERSION,
  associations:restaurantAssociations,
  clientNames:restaurantClientNames,
}]]);
let activeProfile=null;

export function configureCategoryProfile(industry){
  activeProfile=profiles.get(String(industry||"").trim().toLowerCase())||null;
}

export function categoryContext(words,categories){
  return activeProfile?.category?.(words,categories)||null;
}

export function quoteContext(row,rows){
  return activeProfile?.quote?.(row,rows)||null;
}

export function industryProductContext(text){
  return activeProfile?.product?.(text)||{text:String(text||""),attributes:{},evidence:[],unresolved:[]};
}

export function industryVocabulary(){return activeProfile?.vocabulary||[];}
export function industryAssociationProfile(){return activeProfile?.associations||{version:'literal-1',concepts:[],facets:[],fragments:[]};}
export function industryClientNames(industry){return profiles.get(String(industry||'').toLowerCase())?.clientNames||{};}

// Explicit industry lookup also makes the bundled knowledge inspectable in Admin.
export function industryDictionary(industry){
  const profile=profiles.get(String(industry||"").trim().toLowerCase());
  return {version:profile?.version||null,groups:profile?.dictionaries||{}};
}

export function packContext(text){return activeProfile?.pack?.(text)||{working:text,qualifiers:[]};}

// Returns product type priors for pricing basis inference.
// Each industry profile can declare which product types are typically
// weight-priced or count-priced. Returns empty signals when no profile is loaded.
export function productTypePriors(description){
  return activeProfile?.pricingPriors?.(description)||{weightPriced:false,countPriced:false};
}

export function industryUnitCostDefaults(industry){return profiles.get(String(industry||" ").trim().toLowerCase())?.unitCostUnits||{};}
