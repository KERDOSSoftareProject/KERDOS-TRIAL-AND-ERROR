import {compareProductIdentity,comparePurchasingPack,brandsMatch} from "../procurement.js";

// NVIN (No Vendor Item Number) is a persistent database identity; it is never inferred from sheet row
// position. For a sheet with no vendor code, reuse an identity only when the
// product, brand and physical pack agree with exactly one saved listing.
export function findUncodedVendorListing(row,listings,{allowDistinctPack=false}={}){
  const sameProduct=listings.filter(item=>!item.vendor_item_code&&
    [item.description,item.import_row?.row?.description,item.field_resolutions?.description?.sourceValue]
      .filter(Boolean).some(name=>compareProductIdentity(row.description,name).status==="same"));
  // A detail retained from an unlabeled source cell may distinguish two
  // otherwise identical products. Do not silently update one with the other.
  const sameDetails=item=>{
    const prior=item.import_row?.row?.details;
    if(!Array.isArray(prior)||!Array.isArray(row.details))return true;
    const normalize=values=>values.map(value=>String(value).trim().replace(/\s+/g," ").toLowerCase());
    return JSON.stringify(normalize(prior))===JSON.stringify(normalize(row.details));
  };
  const compatible=sameProduct.filter(item=>{
    const brands=[item.brand];
    if(item.import_row?.row&&Object.hasOwn(item.import_row.row,"brand"))brands.push(item.import_row.row.brand);
    if(item.field_resolutions?.brand&&Object.hasOwn(item.field_resolutions.brand,"sourceValue"))
      brands.push(item.field_resolutions.brand.sourceValue);
    return sameDetails(item)&&row.packSize&&[item.pack_size,item.import_row?.row?.packSize,item.field_resolutions?.pack_size?.sourceValue]
      .filter(Boolean).some(pack=>comparePurchasingPack(row.packSize,pack).status==="same")&&
      brands.some(brand=>!row.brand&&!brand||row.brand&&brand&&brandsMatch(row.brand,brand))&&
      (!row.gtin||!item.gtin||row.gtin===item.gtin)&&
      (!row.manufacturerCode||!item.manufacturer_code||row.manufacturerCode===item.manufacturer_code);
  });
  if(compatible.length===1)return {item:compatible[0],conflict:null};
  if(compatible.length>1)return {item:null,conflict:"More than one saved listing fits this unnumbered vendor item. Choose the existing listing before applying a new quote."};
  if(sameProduct.some(item=>!sameDetails(item)))
    return {item:null,conflict:"A saved unnumbered vendor item has different source details. Review the source row before applying its price or assigning a new NVIN."};
  // A separately stated, physically different pack is another offering, not
  // an update to the first listing. Missing/uncertain packs still fail closed.
  // Opt in only for the manual source-retention flow; worker policy is unchanged.
  if(allowDistinctPack&&sameProduct.length&&row.packSize&&sameProduct.every(item=>
    comparePurchasingPack(row.packSize,item.pack_size).status==="different"&&
    !(row.gtin&&item.gtin&&row.gtin===item.gtin)&&
    (!row.brand&&!item.brand||row.brand&&item.brand&&brandsMatch(row.brand,item.brand))))
    return {item:null,conflict:null};
  if(sameProduct.length)return {item:null,conflict:"A similar unnumbered vendor item exists, but brand or pack is missing or differs. Review the saved listing before assigning a new NVIN."};
  // A review-grade description overlap is not proof of a new product. Hold
  // an uncoded quote when its brand and physical pack could still be the
  // saved listing; a clearly different pack or brand stays independent.
  const reviewOverlap=listings.some(item=>{
    if(item.vendor_item_code)return false;
    const names=[item.description,item.import_row?.row?.description,item.field_resolutions?.description?.sourceValue].filter(Boolean);
    if(!names.some(name=>compareProductIdentity(row.description,name).status==="review"))return false;
    const packs=[item.pack_size,item.import_row?.row?.packSize].filter(Boolean);
    const brands=[item.brand,item.import_row?.row?.brand].filter(Boolean);
    return (!row.packSize||!packs.length||packs.some(pack=>comparePurchasingPack(row.packSize,pack).status!=="different"))&&
      (!row.brand||!brands.length||brands.some(brand=>brandsMatch(row.brand,brand)));
  });
  if(reviewOverlap)return {item:null,conflict:"A saved unnumbered listing may match this source product, but its description needs review. Check the saved listing before assigning another NVIN."};
  // A formerly unnumbered listing may now carry a vendor-printed code. An
  // older code-free sheet must not allocate a second identity for that same
  // offering, and must not overwrite a coded listing without review.
  const codedOverlap=!row.code&&listings.some(item=>{
    if(!item.vendor_item_code)return false;
    const names=[item.description,item.import_row?.row?.description,item.field_resolutions?.description?.sourceValue].filter(Boolean);
    if(!names.some(name=>compareProductIdentity(row.description,name).status==="same"))return false;
    const packs=[item.pack_size,item.import_row?.row?.packSize].filter(Boolean);
    const brands=[item.brand,item.import_row?.row?.brand].filter(Boolean);
    return (!row.packSize||!packs.length||packs.some(pack=>comparePurchasingPack(row.packSize,pack).status!=="different"))&&
      (!row.brand||!brands.length||brands.some(brand=>brandsMatch(row.brand,brand)));
  });
  if(codedOverlap)return {item:null,conflict:"A saved listing with a vendor item number may be this code-free source row. Review its vendor number before applying a quote or assigning a new NVIN."};
  return {item:null,conflict:null};
}

export function vendorListingLabel(item){
  if(String(item?.vendor_item_code||"").trim())return null;
  const n=Number(item?.nvim_number);
  return Number.isSafeInteger(n)&&n>0?`NVIN-${n}`:null;
}
