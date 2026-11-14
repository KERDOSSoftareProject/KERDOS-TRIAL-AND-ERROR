// The import preview uses exactly the field rules used after persistence.
import {getProcurementContext,suggestCategory,priceBasisFor,productKnowledge} from "../procurement.js";
import {catalogRowEvidence,importResolutions,orderGuideAssessment} from "./catalog-fields.js";
import {preparePriceImport} from "./price-import-review.js";
import {findUncodedVendorListing,vendorListingLabel} from "./vendor-listing.js";
import {enrichFromInvoices,invoiceEvidence} from "./invoice-evidence.js";

function previewProductItem(label,organizationId,catalogItems,mappings){
  if(!label.key)return null;
  const rejectedIds=new Set(mappings.filter(mapping=>mapping.match_method==='rejected').map(mapping=>mapping.catalog_item_id));
  const normalize=value=>String(value||'').trim().replace(/\s+/g,' ').toLowerCase();
  const name=normalize(label.label?.slice(0,120));
  const eligible=catalogItems.filter(item=>!item.merged_into_id&&!item.retired_at
    &&(!item.lifecycle_state||item.lifecycle_state==='active')&&!item.concept_split_from_id
    &&!item.concept_review_required&&!rejectedIds.has(item.id)
    &&(!organizationId||!item.organization_id||item.organization_id===organizationId));
  const byAge=(a,b)=>String(a.created_at||'').localeCompare(String(b.created_at||''))||String(a.id).localeCompare(String(b.id));
  return eligible.filter(item=>item.concept_key===label.key).sort(byAge)[0]
    ||eligible.filter(item=>!item.concept_key&&normalize(item.name)===name).sort(byAge)[0];
}

export function explainImportRow(source,{organizationId=null,vendor=null,categories=[],catalogItems=[],vendorItems=[],mappings=[],invoices=[],procurement=getProcurementContext()}={}){
  const listings=vendorItems.filter(vi=>vi.vendor_id===vendor?.id);
  const enriched=enrichFromInvoices(source,invoices);
  const prior=(source.selectedVendorItemId?listings.find(vi=>vi.id===source.selectedVendorItemId):null)
    ||(source.code?listings.find(vi=>String(vi.vendor_item_code)===String(source.code)):null)
    ||findUncodedVendorListing(enriched,listings).item;
  const savedMapping=prior?mappings.find(m=>m.vendor_item_id===prior.id):null;
  const savedItem=savedMapping?catalogItems.find(c=>c.id===savedMapping.catalog_item_id):null;
  const org=organizationId||vendor?.organization_id;
  const scope=org&&vendor?.id?{organizationId:org,vendorId:vendor.id}:null;
  const prepared=preparePriceImport(source,prior,savedMapping,[...(source.issues||[]),...invoiceEvidence(source,invoices).conflicts],invoices,scope,procurement,vendorItems);
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
  evidence.vendor.value=vendor?.name?`${vendor.name} · ${row.code?`Vendor #${row.code}`:vendorListingLabel(prior)||"NVIN assigned on save"}`:null;
  evidence.category.source=selectedCategory?"manual selection":"category profile";
  evidence.price.source=source.manualFields?.includes("price")||source.priceEdited?"manual correction":"document";
  evidence.sellingUnit.source=row.sellingUnitSource==="remembered"?"confirmed vendor item":row.sellingUnitSource==="manual"?"manual selection":row.sellingUnitSource||"document";
  const basis=priceBasisFor(row.sellingUnit);
  evidence.priceBasis={value:basis?.basis||null,accuracy:evidence.sellingUnit.accuracy,reason:evidence.sellingUnit.reason,source:evidence.sellingUnit.source};
  if(!basis)evidence.unitCost.reason="Selling unit unknown or absent; cannot calculate unit cost";
  if(!savedItem){
    const label=procurement.readProductLabel(row);
    const number=previewProductItem(label,org,catalogItems,mappings)?.master_item_number??null;
    evidence.itemNumber={value:number,accuracy:number==null?null:90,
      reason:number==null?"KERDOS item assignment is checked on save":"Product label matches an existing item; assignment is checked on save"};
  }
  return {...evidence,quoteBasisReview:row.quoteBasisReview,statedPriceQuotes:row.statedPriceQuotes||[],qualification:orderGuideAssessment(input),knownItem:!!row.knownVendorItem,conflicts,
    changes:row.changes||[],terminology:productKnowledge(row.description),source:source.sourceLine||source.description};
}
