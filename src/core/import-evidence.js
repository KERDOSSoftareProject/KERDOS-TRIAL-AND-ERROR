// The import preview uses exactly the field rules used after persistence.
import {suggestCategory,priceBasisFor,bestPurchasingMatch,commonPurchasingPack,productKnowledge} from "../procurement.js";
import {catalogRowEvidence,importResolutions,orderGuideAssessment} from "./catalog-fields.js";
import {preparePriceImport} from "./price-import-review.js";
import {quoteContext} from "../knowledge/category-profiles.js";
import {findUncodedVendorListing,vendorListingLabel} from "./vendor-listing.js";
import {enrichFromInvoices,invoiceEvidence} from "./invoice-evidence.js";

export function explainImportRow(source,{vendor=null,categories=[],catalogItems=[],vendorItems=[],mappings=[],documentRows=[],invoices=[]}={}){
  const listings=vendorItems.filter(vi=>vi.vendor_id===vendor?.id);
  const enriched=enrichFromInvoices(source,invoices);
  const prior=(source.selectedVendorItemId?listings.find(vi=>vi.id===source.selectedVendorItemId):null)
    ||(source.code?listings.find(vi=>String(vi.vendor_item_code)===String(source.code)):null)
    ||findUncodedVendorListing(enriched,listings).item;
  const savedMapping=prior?mappings.find(m=>m.vendor_item_id===prior.id):null;
  const savedItem=savedMapping?catalogItems.find(c=>c.id===savedMapping.catalog_item_id):null;
  const prepared=preparePriceImport(source,prior,savedMapping,[...(source.issues||[]),...invoiceEvidence(source,invoices).conflicts],invoices);
  const row=prepared.row;
  const selectedCategory=source.categoryId?categories.find(c=>c.id===source.categoryId&&!c.is_holding_pen):savedItem?categories.find(c=>c.id===savedItem.category_id):null;
  const placement=selectedCategory?{category:selectedCategory,confidence:savedItem?.category_review&&!source.categoryId?"guess":"confident",reason:savedItem?.category_reason||"Category selected for this row"}:suggestCategory(row.description,categories,catalogItems);
  const category=placement?.category||null;
  const item=savedItem?{...savedItem,...(source.categoryId?{category_id:source.categoryId,category_review:false,category_reason:"Category selected for this row"}:{})}:
    {id:"preview-item",name:row.description,category_id:category?.id,category_review:placement?.confidence!=="confident",category_reason:placement?.reason};
  const mapping=savedMapping||{id:"preview-mapping",catalog_item_id:item.id,comparison_track:"new"};
  const conflicts=prepared.reasons;
  const vi={...prior,id:prior?.id||"preview-listing",vendor_id:vendor?.id,description:row.description,brand:row.brand,
    pack_size:row.packSize,selling_unit:row.sellingUnit,price_basis:priceBasisFor(row.sellingUnit)?.basis||null,price:row.price,
    gtin:row.gtin,manufacturer_code:row.manufacturerCode,price_unavailable:!!row.priceUnavailable,
    price_source:"pricelist",price_expired_at:null,price_quote_valid_until:null,
    field_resolutions:importResolutions(source,prior||{}),
    import_row:{row:{...source,...source.originalFields},evidence:row,reviewRequired:!!conflicts.length||!!row.priceNeedsReview,reviewFields:prepared.reviewFields,changes:row.changes||[]}};
  const byId=new Map(vendorItems.map(entry=>[entry.id,entry]));
  const peers=savedItem?mappings.filter(entry=>entry.catalog_item_id===savedItem.id&&entry.vendor_item_id!==prior?.id).map(entry=>byId.get(entry.vendor_item_id)).filter(Boolean):[];
  const input={item,vendorItem:vi,mapping,vendor,category,peers,categories};
  const evidence=catalogRowEvidence(input);
  for(const field of Object.values(evidence))if(field.value==="")field.value=null;
  evidence.vendor.value=vendor?.name?`${vendor.name} · ${row.code?`Vendor #${row.code}`:vendorListingLabel(prior)||"NVIM assigned on save"}`:null;
  evidence.category.source=selectedCategory?"manual selection":"category profile";
  evidence.price.source=source.manualFields?.includes("price")||source.priceEdited?"manual correction":"document";
  evidence.sellingUnit.source=row.sellingUnitSource==="remembered"?"confirmed vendor item":row.sellingUnitSource==="manual"?"manual selection":row.sellingUnitSource||"document";
  const basis=priceBasisFor(row.sellingUnit);
  const proposed=!basis?quoteContext(row,documentRows):null;
  evidence.priceBasis={value:basis?.basis||null,accuracy:evidence.sellingUnit.accuracy,reason:evidence.sellingUnit.reason,source:evidence.sellingUnit.source};
  // A plausible unit is a suggestion, never a calculated or qualified quote.
  if(proposed){
    evidence.sellingUnit.reason+=`. Suggested ${proposed.sellingUnit}: ${proposed.reason} Needs evidence.`;
    evidence.unitSuggestion={...proposed,accuracy:70};
  }
  if(!basis)evidence.unitCost.reason="Selling unit unknown or absent; cannot calculate unit cost";
  if(!savedItem){
    const candidates=catalogItems.map(candidate=>{
      const packs=mappings.filter(entry=>entry.catalog_item_id===candidate.id).map(entry=>byId.get(entry.vendor_item_id)?.pack_size);
      return {...candidate,pack_size:commonPurchasingPack(packs)};
    });
    const possible=bestPurchasingMatch(row.description,row.packSize,candidates);
    evidence.itemNumber={value:possible?.catalogItem?.master_item_number??null,accuracy:possible?70:null,
      reason:possible?"Possible existing item; association is checked when saved":"New KERDOS item number will be assigned on import"};
  }
  return {...evidence,qualification:orderGuideAssessment(input),knownItem:!!row.knownVendorItem,conflicts,
    changes:row.changes||[],terminology:productKnowledge(row.description),source:source.sourceLine||source.description};
}
