import {getProcurementContext} from '../procurement.js';
import {listingSourceForField, quotedUnitOrigin} from './listing-provenance.js';
import {verifiedFullPackPrice} from './quote-controls.js';
import {PRICE_UNIT_CONFLICT_REASON} from './source-units.js';

// Older imports saved unresolved quote bases as unavailable prices. Recognize
// those recorded reasons for display without clearing any persisted hold.
const basisReviewReason=/^(?:Pricing basis .* suggested but not confirmed|Could not determine pricing basis|No basis could be inferred|Product type prior favors .* basis|Quoted unit is (?:inferred|unresolved)|Pricing basis is (?:inferred|unresolved)|Pricing basis needs review|The incoming price basis needs review)/i;
const ordinaryBrandChange=/^Brand changed from /i;
const productChange=/^(?:Product wording changed from |Product description changed\b|Product needs review:)/i;
const basisConflictReason=/^(?:Quoted unit|Pricing basis) .*(?:differs|conflicts)/i;
const reviewColumn={description:'product',pack_size:'pack',packSize:'pack',selling_unit:'sellingUnit',sellingUnit:'sellingUnit',price:'price'};

export function catalogMigrationAssessment({item, listing, mapping, settings, now, procurement=getProcurementContext()}){
  if(!item||!listing||!mapping)return null;
  const saved=listing.import_row||{};
  const source=listingSourceForField(listing,'selling_unit');
  const packSource=listingSourceForField(listing,'pack_size');
  const pack=procurement.parsePackSize(listing.pack_size);
  const basis=procurement.priceBasisFor(listing.selling_unit);
  const origin=quotedUnitOrigin(listing,procurement);
  const reviewFields=saved.reviewRequired?(saved.reviewFields||[]):[];
  const priceUnitPending=!reviewFields.length||reviewFields.some(field=>['price','selling_unit','sellingUnit'].includes(field));
  const conflicts=saved.reviewRequired?(saved.conflicts||[]).filter(reason=>reason!==PRICE_UNIT_CONFLICT_REASON||priceUnitPending):[];
  const reviewPriceUnitConflict=saved.reviewRequired&&priceUnitPending&&
    (conflicts.includes(PRICE_UNIT_CONFLICT_REASON)||saved.row?.issues?.includes(PRICE_UNIT_CONFLICT_REASON));
  const basisReview=reviewPriceUnitConflict||conflicts.some(reason=>basisReviewReason.test(reason));
  const amountListing=basisReview&&!source.row.priceUnavailable?{...listing,price_unavailable:false}:listing;
  const descriptionChanged=saved.reviewRequired&&(saved.changes||[]).some(change=>
    change.field==='description'&&procurement.compareProductIdentity(change.before,change.after).status!=='same');
  const basisConflict=reviewPriceUnitConflict||conflicts.some(reason=>basisConflictReason.test(reason));
  const priceOrPackReview=reviewFields.length<5&&reviewFields.some(field=>
    field==='pack_size'||field==='packSize'||field==='price'&&listing.quoteBasisInference?.price==null);
  const sourceHold=basisConflict||priceOrPackReview||
    conflicts.some(reason=>!basisReviewReason.test(reason)&&!ordinaryBrandChange.test(reason)&&!productChange.test(reason))||
    (saved.reviewRequired&&!conflicts.length&&reviewFields.some(field=>!['selling_unit','brand','description'].includes(field)));
  const associationHold=mapping.comparison_track!=='exact'&&
    procurement.compareProductIdentity(listing.description,item.description||item.name).status!=='same';
  const packMissing=!pack?.parsed||pack.dimension==='unknown'&&!/^#\d/.test(pack.unit||'');
  const brandMismatch=item.brand_locked&&!procurement.brandsMatch(listing.brand,item.locked_brand);
  const fields=new Set();
  const holdFields=new Set();
  if(procurement.quoteStatus(amountListing,settings,now)!=='current')fields.add('price');
  if(packMissing)fields.add('pack');
  if(brandMismatch||conflicts.some(reason=>ordinaryBrandChange.test(reason))||
    reviewFields.length<5&&reviewFields.includes('brand'))holdFields.add('brand');
  if(descriptionChanged||associationHold||conflicts.some(reason=>productChange.test(reason))||
    reviewFields.length<5&&reviewFields.includes('description'))holdFields.add('product');
  if(sourceHold){
    // The legacy fallback assigned every field to unknown errors.
    if(reviewFields.length<5)for(const field of reviewFields){
      if(reviewColumn[field])fields.add(reviewColumn[field]);
    }
    for(const change of saved.changes||[]){
      if(change.field!=='description'&&reviewColumn[change.field])fields.add(reviewColumn[change.field]);
    }
    if(basisConflict||conflicts.some(reason=>/^(?:Quoted unit|Pricing basis) .*needs review/i.test(reason)))fields.add('sellingUnit');
  }
  // A brand or association hold can coexist with a usable quote calculation.
  const quoteHold=fields.size||sourceHold;
  for(const field of holdFields)fields.add(field);
  if(quoteHold){
    if(listing.quoteBasisInference)fields.add('sellingUnit');
    if(listing.quoteBasisInference?.packSize)fields.add('pack');
    return {tier:3,fields,...(reviewPriceUnitConflict?{reviewPriceUnitConflict:true}:{})};
  }

  const pending={tier:2,fields,...(holdFields.size?{holdFields}:{})};
  if(listing.quoteBasisInference){
    fields.add('sellingUnit');
    const inferredUnit=listing.quoteBasisInference.value;
    const inferredBasis=procurement.priceBasisFor(inferredUnit);
    if(listing.quoteBasisInference.kind!=='inferred'||!inferredBasis||
      procurement.casePriceFromQuote(listing.price,inferredBasis.basis,inferredBasis.unit||inferredUnit,listing.pack_size)==null)
      return {tier:3,fields};
    if(listing.quoteBasisInference.packSize)fields.add('pack');
    return pending;
  }

  if(!basis||!origin.root&&origin.status!=='inferred'){
    // A retained, explicitly stated pack price can be confirmed directly.
    fields.add('sellingUnit');
    return verifiedFullPackPrice(listing,procurement)!==null?pending:{tier:3,fields};
  }
  if(origin.status!=='inferred'&&(reviewFields.includes('selling_unit')||
    !reviewFields.length&&basisReview)){
    fields.add('sellingUnit');
    return {tier:3,fields};
  }
  if(procurement.casePriceFromQuote(listing.price,basis.basis,basis.unit||listing.selling_unit,listing.pack_size)==null){
    fields.add(pack.catchWeight?'pack':'sellingUnit');
    return {tier:3,fields};
  }

  const inferredPack=!listing.field_resolutions?.pack_size&&
    (packSource.evidence.packSource==='description'||!!packSource.evidence.fieldInference?.packSize);
  if(inferredPack)fields.add('pack');
  if(origin.status==='inferred')fields.add('sellingUnit');
  return fields.size?pending:{tier:1,fields};
}
