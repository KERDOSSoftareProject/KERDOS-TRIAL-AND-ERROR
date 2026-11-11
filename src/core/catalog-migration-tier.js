import {getProcurementContext} from '../procurement.js';
import {listingSourceForField, quotedUnitOrigin} from './listing-provenance.js';

// Older imports saved unresolved quote bases as unavailable prices. Recognize
// those recorded reasons for display without clearing any persisted hold.
const basisReviewReason=/^(?:Pricing basis .* suggested but not confirmed|Could not determine pricing basis|No basis could be inferred|Product type prior favors .* basis|Quoted unit is (?:inferred|unresolved)|The incoming price basis needs review)/i;
const ordinaryBrandChange=/^Brand changed from /i;

export function catalogMigrationTier({item, listing, mapping, settings, now, procurement=getProcurementContext()}){
  if(!item||!listing||!mapping)return null;
  const saved=listing.import_row||{};
  const source=listingSourceForField(listing,'selling_unit');
  const packSource=listingSourceForField(listing,'pack_size');
  const pack=procurement.parsePackSize(listing.pack_size);
  const basis=procurement.priceBasisFor(listing.selling_unit);
  const origin=quotedUnitOrigin(listing,procurement);
  const conflicts=saved.reviewRequired?(saved.conflicts||[]):[];
  const basisReview=conflicts.some(reason=>basisReviewReason.test(reason));
  const amountListing=basisReview&&!source.row.priceUnavailable?{...listing,price_unavailable:false}:listing;
  const descriptionChanged=saved.reviewRequired&&(saved.changes||[]).some(change=>
    change.field==='description'&&procurement.compareProductIdentity(change.before,change.after).status!=='same');
  const sourceHold=conflicts.some(reason=>!basisReviewReason.test(reason)&&!ordinaryBrandChange.test(reason))||
    (saved.reviewRequired&&!conflicts.length&&(saved.reviewFields||[]).some(field=>field!=='selling_unit'&&field!=='brand'));
  const associationHold=mapping.comparison_track!=='exact'&&
    procurement.compareProductIdentity(listing.description,item.description||item.name).status!=='same';
  const packMissing=!pack?.parsed||pack.dimension==='unknown'&&!/^#\d/.test(pack.unit||'');
  const brandMismatch=item.brand_locked&&!procurement.brandsMatch(listing.brand,item.locked_brand);
  if(procurement.quoteStatus(amountListing,settings,now)!=='current'||packMissing||
    brandMismatch||sourceHold||descriptionChanged||associationHold)return 4;

  if(!basis||!origin.root&&origin.status!=='inferred'){
    const hasSourceRow=source.sourceDocumentId&&saved.rowKey&&Object.keys(source.row).length>0;
    return hasSourceRow?3:4;
  }
  if(procurement.casePriceFromQuote(listing.price,basis.basis,basis.unit||listing.selling_unit,listing.pack_size)==null)return 4;

  const inferredPack=!listing.field_resolutions?.pack_size&&
    (packSource.evidence.packSource==='description'||!!packSource.evidence.fieldInference?.packSize);
  return inferredPack||origin.status==='inferred'?2:1;
}
