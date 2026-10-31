import {compareProductIdentity,comparePurchasingPack,brandsMatch} from "../procurement.js";

// NVIM is a persistent database identity; it is never inferred from sheet row
// position. For a sheet with no vendor code, reuse an identity only when the
// product, brand and physical pack agree with exactly one saved listing.
export function findUncodedVendorListing(row,listings,{allowDistinctPack=false}={}){
  const sameProduct=listings.filter(item=>!item.vendor_item_code&&
    [item.description,item.import_row?.row?.description,item.field_resolutions?.description?.sourceValue]
      .filter(Boolean).some(name=>compareProductIdentity(row.description,name).status==="same"));
  const compatible=sameProduct.filter(item=>{
    const brands=[item.brand];
    if(item.import_row?.row&&Object.hasOwn(item.import_row.row,"brand"))brands.push(item.import_row.row.brand);
    if(item.field_resolutions?.brand&&Object.hasOwn(item.field_resolutions.brand,"sourceValue"))
      brands.push(item.field_resolutions.brand.sourceValue);
    return row.packSize&&[item.pack_size,item.import_row?.row?.packSize,item.field_resolutions?.pack_size?.sourceValue]
      .filter(Boolean).some(pack=>comparePurchasingPack(row.packSize,pack).status==="same")&&
      brands.some(brand=>!row.brand&&!brand||row.brand&&brand&&brandsMatch(row.brand,brand))&&
      (!row.gtin||!item.gtin||row.gtin===item.gtin)&&
      (!row.manufacturerCode||!item.manufacturer_code||row.manufacturerCode===item.manufacturer_code);
  });
  if(compatible.length===1)return {item:compatible[0],conflict:null};
  if(compatible.length>1)return {item:null,conflict:"More than one saved listing fits this unnumbered vendor item. Choose the existing listing before applying a new quote."};
  // A separately stated, physically different pack is another offering, not
  // an update to the first listing. Missing/uncertain packs still fail closed.
  // Opt in only for the manual source-retention flow; worker policy is unchanged.
  if(allowDistinctPack&&sameProduct.length&&row.packSize&&sameProduct.every(item=>
    comparePurchasingPack(row.packSize,item.pack_size).status==="different"&&
    !(row.gtin&&item.gtin&&row.gtin===item.gtin)&&
    (!row.brand&&!item.brand||row.brand&&item.brand&&brandsMatch(row.brand,item.brand))))
    return {item:null,conflict:null};
  if(sameProduct.length)return {item:null,conflict:"A similar unnumbered vendor item exists, but brand or pack is missing or differs. Review the saved listing before assigning a new NVIM."};
  return {item:null,conflict:null};
}

export function vendorListingLabel(item){
  if(String(item?.vendor_item_code||"").trim())return null;
  const n=Number(item?.nvim_number);
  return Number.isSafeInteger(n)&&n>0?`NVIM-${n}`:null;
}
