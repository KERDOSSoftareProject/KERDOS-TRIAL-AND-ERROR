import {comparisonUnits} from "../core/quote-controls.js";
import {priceBasisFor,casePriceFromQuote,parsePackSize} from "../procurement.js";

export function prepareCatalogCorrection({organizationId,vendorItem,mapping,patch}){
  if(!vendorItem?.id||!mapping?.id||vendorItem.organization_id!==organizationId||mapping.organization_id!==organizationId||mapping.vendor_item_id!==vendorItem.id)
    throw new Error("Choose a linked item from this organization.");
  const allowed=new Set(["description","brand","pack_size","price","selling_unit","category_id","item_name","catalog_item_id","unit_cost_unit","approve_row","unit_cost_override"]);
  if(Object.keys(patch).some(key=>!allowed.has(key)))throw new Error("Unsupported catalog field.");
  const cleaned={...patch};
  for(const key of ["description","brand","pack_size","selling_unit","item_name","unit_cost_unit"])if(key in cleaned)cleaned[key]=String(cleaned[key]??"").trim();
  if("description" in cleaned&&!cleaned.description)throw new Error("Enter a product description.");
  if("item_name" in cleaned&&!cleaned.item_name)throw new Error("Enter an item name.");
  if("price" in cleaned){
    cleaned.price=cleaned.price===""||cleaned.price==null?null:Number(cleaned.price);
    if(cleaned.price!=null&&(!Number.isFinite(cleaned.price)||cleaned.price<=0))throw new Error("Enter a positive quoted price, or leave it blank.");
  }
  if("catalog_item_id" in cleaned){
    if(!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(cleaned.catalog_item_id||""))throw new Error("Choose an existing KERDOS item.");
    if("category_id" in cleaned||"item_name" in cleaned)throw new Error("Save item name/category changes separately from an association change.");
  }
  if("approve_row" in cleaned&&cleaned.approve_row!==true)throw new Error("Row approval must be explicit.");
  if("unit_cost_override" in cleaned&&cleaned.unit_cost_override!=null){
    const o=cleaned.unit_cost_override;
    if(![o.price,o.packPrice].every(v=>Number.isFinite(Number(v))&&Number(v)>0)||!priceBasisFor(o.unit))throw new Error("Enter positive unit cost and purchasing pack price, and select a measurement.");
    cleaned.unit_cost_override={price:Number(o.price),packPrice:Number(o.packPrice),unit:o.unit};
  }
  const next={...vendorItem,...cleaned},basis=priceBasisFor(next.selling_unit),pack=parsePackSize(next.pack_size);
  if(next.selling_unit&&!basis&&!["WEIGHT","VOLUME","MEASURE"].includes(next.selling_unit))throw new Error("Select a recognized quoted unit.");
  if("unit_cost_unit" in cleaned&&cleaned.unit_cost_unit){
    const options=comparisonUnits(next.pack_size);
    if(options.length&&!options.includes(cleaned.unit_cost_unit))throw new Error("Select a unit cost metric compatible with the pack.");
  }
  // Any field may be saved while others are missing. Calculations wait.
  const convertible=basis&&pack?.parsed&&Number(next.price)>0&&casePriceFromQuote(Number(next.price),basis.basis,basis.unit||next.selling_unit,next.pack_size)!=null;
  return {organizationId,vendorItemId:vendorItem.id,mappingId:mapping.id,expectedRevision:vendorItem.row_revision||0,
    patch:cleaned,priceBasis:basis?.basis||null,priceAvailable:!!convertible};
}
export function createCatalogRowsService(backend){
  return {save(input){return backend.catalog.saveRow(prepareCatalogCorrection(input));}};
}
