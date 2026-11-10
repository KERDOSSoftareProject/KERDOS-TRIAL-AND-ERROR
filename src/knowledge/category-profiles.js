import {restaurantUnitCostUnits} from "./restaurant-unit-policy.js";
import {restaurantCategoryContext} from "./restaurant-category-context.js";
import {restaurantPackContext} from "./restaurant-pack-context.js";
import {restaurantPricingPriors} from "./restaurant-pricing-priors.js";
import {restaurantQuoteContext} from "./restaurant-quote-context.js";
import {restaurantProductContext} from "./restaurant-product-context.js";
import {restaurantCellBrands,restaurantDictionaries,restaurantUnitVocabulary,RESTAURANT_DICTIONARY_VERSION} from "./restaurant-dictionaries.js";
import {restaurantAssociations} from './restaurant-associations.js';
import {restaurantClientNames} from './restaurant-client-names.js';

// Profiles supply industry-specific interpretation; procurement stays generic.
const profiles=new Map([["restaurant",{
  category:restaurantCategoryContext,quote:restaurantQuoteContext,product:restaurantProductContext,pack:restaurantPackContext,pricingPriors:restaurantPricingPriors,
  unitCostUnits:restaurantUnitCostUnits,
  dictionaries:restaurantDictionaries,vocabulary:restaurantUnitVocabulary,version:RESTAURANT_DICTIONARY_VERSION,
  associations:restaurantAssociations,
  clientNames:restaurantClientNames,
  cellBrands:restaurantCellBrands,
}]]);
let activeProfile=null;
const literalAssociations={version:'literal-1',concepts:[],facets:[],fragments:[]};

export function getIndustryProfile(industry){
  return profiles.get(String(industry||"").trim().toLowerCase())||null;
}

export function configureCategoryProfile(industry){
  activeProfile=getIndustryProfile(industry);
}

export function getActiveCategoryProfile(){
  return activeProfile;
}

export function quoteContext(row,rows){
  return activeProfile?.quote?.(row,rows)||null;
}

export function associationRules(profile){
  return profile?.associations||literalAssociations;
}

export function industryClientNames(industry){return profiles.get(String(industry||'').toLowerCase())?.clientNames||{};}

// Explicit industry lookup also makes the bundled knowledge inspectable in Admin.
export function industryDictionary(industry){
  const profile=profiles.get(String(industry||"").trim().toLowerCase());
  return {version:profile?.version||null,groups:profile?.dictionaries||{}};
}

export function industryUnitCostDefaults(industry){return profiles.get(String(industry||" ").trim().toLowerCase())?.unitCostUnits||{};}
