import {automaticAlternativeVerified} from "./alternative-groups.js";
import {vendorListingLabel} from "./vendor-listing.js";
import {calculatedUnitCost} from "./quote-controls.js";
import {casePriceFromQuote,parsePackSize,priceBasisFor,compareProductIdentity,comparePurchasingPack,suggestCategory,quoteStatus,brandsMatch} from "../procurement.js";
import {mappingVerification,mappingGap} from "../services/catalog.js";

export const CATALOG_COLUMNS=[
  ["itemNumber","KERDOS item #"],["vendor","Vendor name"],["vendorItemNumber","Vendor item number"],["category","Category"],
  ["itemName","Item name"],["product","Vendor description"],["brand","Brand"],["pack","Pack"],
  ["price","Quoted price"],["sellingUnit","Quoted per"],["unitCost","Unit cost"],
];
const BASE_UNITS=[["CASE","Case / full pack"],["EACH","Each / inner item"],["LB","Pounds (LB)"],["OZ","Ounces, weight (OZ)"],
  ["GAL","Gallons (US)"],["QT","Quarts (US)"],["PT","Pints (US)"],["FLOZ","Fluid ounces (US)"],
  ["KG","Kilograms"],["G","Grams"],["L","Liters"],["ML","Milliliters"],["DOZ","Dozen"],
  ["FT","Feet"],["IN","Inches"],["YD","Yards"],["M","Meters"],["CM","Centimeters"],["MM","Millimeters"]];
export function unitChoices(vocabulary=[],pack=false,industry=""){
  const restaurant=String(industry).trim().toLowerCase()==="restaurant";
  const lengthUnits=new Set(["FT","IN","YD","M","CM","MM"]);
  const base=restaurant?BASE_UNITS.filter(([code])=>!lengthUnits.has(code)):BASE_UNITS;
  const choices=pack?[["EA","Each / count"],...base.filter(([code])=>!["CASE","EACH"].includes(code))]:base;
  // Industry defaults are short. Vocabulary aliases resolve to one choice,
  // rather than showing both "pound" and "pounds" or "bunch" and "bunches".
  const seen=new Set();
  return [...choices,...(restaurant?[]:vocabulary.filter(v=>v.kind==="unit"||(!pack&&v.kind==="packaging")).map(v=>[v.term,v.term]))]
    .filter(([value])=>{
      const basis=priceBasisFor(value);
      const canonical=basis?.basis==="measure"?basis.unit:basis?.basis;
      if(!value||!basis||seen.has(canonical))return false;
      seen.add(canonical);return true;
    }).map(([value,label])=>({value,label}));
}

const field=(value,accuracy,reason)=>({value,accuracy,reason});

// ---- Accuracy ----------------------------------------------------------
// The percentage on a cell is how likely its value is to be RIGHT, whoever
// put it there. Missing cells have no percentage. A source statement or
// manual entry alone is 90, and an independent matching vendor can raise
// an identity field to 100. Contradictions lower confidence regardless
// of who entered the value. These are rule-based estimates, not measured
// error rates.
const STATED=90,DERIVED=90,GUESSED=70,DOUBTFUL=60;
const empty=(value)=>value==null||value==="";

// A person's initials from what the system knows about them: a display
// name if there is one, otherwise the name part of their email. "Spiro
// Maniatis" → SM; "dino.maniatis@…" → DM; "spiro@…" → SP.
export function initialsFor(person){
  if(!person)return "";
  const name=String(person.name||person.full_name||"").trim();
  const source=name||String(person.email||"").split("@")[0];
  const parts=source.split(/[^A-Za-z]+/).filter(Boolean);
  if(!parts.length)return "";
  if(parts.length===1)return parts[0].slice(0,2).toUpperCase();
  return parts.slice(0,3).map(part=>part[0].toUpperCase()).join("");
}

export function catalogRowEvidence({item,vendorItem,mapping,vendor,category,peers=[],categories=[],industry="",editors={}}){
  const vi=vendorItem,pack=parsePackSize(vi.pack_size),basis=priceBasisFor(vi.selling_unit);
  const amount=vi.price==null||vi.price===""?null:Number(vi.price);
  const hasPrice=Number.isFinite(amount)&&amount>0;
  const row=vi.import_row?.row||{};
  const provenance=vi.import_row?.evidence||row;
  const changes=vi.import_row?.reviewRequired?(vi.import_row?.changes||[]).map(c=>c.field):[];
  const casePrice=hasPrice&&basis?casePriceFromQuote(amount,basis.basis,basis.unit||vi.selling_unit,vi.pack_size):null;
  const per=calculatedUnitCost(vi,{industry});
  const manual=vi.field_resolutions||{};
  const byClient=(key)=>Object.hasOwn(manual,key);
  const otherVendors=peers.filter(p=>p.vendor_id&&p.vendor_id!==vi.vendor_id);
  const comparableAlternatives=automaticAlternativeVerified(vi,item,peers);
  const source=(key,rawKey)=>manual[key]?.sourceValue??row[rawKey];
  // A second vendor on the same catalog item is not automatically an
  // independent witness. Require a matching trade identifier first.
  const provenPeers=otherVendors.filter(p=>
    (vi.gtin&&p.gtin&&vi.gtin===p.gtin)||
    (vi.manufacturer_code&&p.manufacturer_code&&vi.manufacturer_code===p.manufacturer_code&&vi.brand&&p.brand&&vi.brand.toLowerCase()===p.brand.toLowerCase()));

  // Pack: where it came from, then whether it agrees with the quoted unit
  // and with the other vendors on this item.
  let packAcc=null,packWhy="";
  if(!empty(vi.pack_size)){
    if(!pack?.parsed){packAcc=DOUBTFUL;packWhy="Not a complete pack KERDOS can read";}
    else{
      packAcc=byClient("pack_size")?STATED:provenance.packSource==="description"?DERIVED:provenance.packSource==="column"||!provenance.packSource?STATED:DERIVED;
      packWhy=byClient("pack_size")?"Set by you":provenance.packSource==="description"?"Read from the end of the description":provenance.packSource==="invoice"?"Filled from the vendor's invoice":"Read from the sheet";
      if(pack.dimension==="unknown"){
        // Named can sizes (#10 CAN) are a known container identity: the count
        // is certain, only the inner volume is unspecified. These are priceable
        // per-case and do not require a pack blocker.
        // Bare unresolved container codes (CN, TUB, JAR with a numeric size
        // but no # prefix) are ambiguous — flag them for client confirmation.
        const isNamedCanSize=/^#\d/.test(pack.unit||"");
        if(!isNamedCanSize){packAcc=Math.min(packAcc,DOUBTFUL);packWhy+="; unit '"+pack.unit+"' is not a recognised dimension — confirm whether this is a can size code, a count abbreviation, or something else";}
      }else if(basis?.basis==="measure"&&casePrice==null){packAcc=Math.min(packAcc,DOUBTFUL);packWhy+="; doesn't fit a price quoted per "+(basis.unit||vi.selling_unit);}
      const disagree=!comparableAlternatives&&otherVendors.find(p=>p.pack_size&&parsePackSize(p.pack_size)?.parsed&&comparePurchasingPack(vi.pack_size,p.pack_size).status!=="same");
      if(disagree){packAcc=Math.min(packAcc,GUESSED);packWhy+=`; another vendor lists ${disagree.pack_size}`;}
      else if(provenPeers.length&&provenPeers.every(p=>comparePurchasingPack(vi.pack_size,p.pack_size).status==="same")){
        packAcc=100;packWhy+="; corroborated by another vendor";
      }
      if(comparableAlternatives)packWhy+="; alternatives may use different purchasing packs";
      const sourcePack=source("pack_size","packSize");
      if(byClient("pack_size")&&sourcePack&&comparePurchasingPack(vi.pack_size,sourcePack).status!=="same"){
        packAcc=Math.min(packAcc,GUESSED);packWhy+="; differs from the original source";
      }
      if(changes.includes("packSize")){packAcc=Math.min(packAcc,GUESSED);packWhy+="; changed on the newest sheet";}
    }
  }

  // Quoted unit: stated on the sheet, chosen for the whole sheet, or set here.
  let unitAcc=null,unitWhy="";
  if(!empty(vi.selling_unit)){
    if(!basis){unitAcc=DOUBTFUL;unitWhy=["WEIGHT","VOLUME","MEASURE"].includes(vi.selling_unit)?"Choose the measurement for this quoted price":"Not a unit KERDOS recognises";}
    else{
      unitAcc=byClient("selling_unit")?STATED:provenance.sellingUnitSource==="sheet"?DERIVED:provenance.sellingUnitSource==="inferred"?GUESSED:STATED;
      unitWhy=provenance.sellingUnitSource==="remembered"?"Reused from this vendor’s verified product and pack":byClient("selling_unit")?"Set by you":provenance.sellingUnitSource==="sheet"?"Applied to the whole sheet at import":provenance.sellingUnitSource==="inferred"?"Suggested—not confirmed":"Stated on the sheet";
      if(!byClient("selling_unit")&&["price cell","price header","document note"].includes(provenance.sellingUnitSource))unitWhy=`Stated in the ${provenance.sellingUnitSource}`;
      if(basis.basis==="measure"&&pack?.parsed&&casePrice==null){unitAcc=Math.min(unitAcc,DOUBTFUL);unitWhy+="; the pack isn't measured in "+(basis.unit||vi.selling_unit);}
      if(vi.price_basis&&vi.price_basis!==basis.basis){unitAcc=Math.min(unitAcc,DOUBTFUL);unitWhy+="; saved price basis conflicts with quoted unit";}
      const sourceUnit=source("selling_unit","sellingUnit");
      if(byClient("selling_unit")&&sourceUnit&&JSON.stringify(priceBasisFor(sourceUnit))!==JSON.stringify(basis)){
        unitAcc=Math.min(unitAcc,GUESSED);unitWhy+="; differs from the original source";
      }
    }
  }

  // Price: the number as quoted, checked against the vendor's own last quote.
  let priceAcc=null,priceWhy="";
  if(hasPrice){
    priceAcc=byClient("price")?STATED:STATED;priceWhy=byClient("price")?"Set by you":"As quoted on the sheet";
    if(changes.includes("price")){priceAcc=GUESSED;priceWhy+="; differs from this vendor's last quote";}
    const originalPrice=source("price","price");
    if(originalPrice!=null&&originalPrice!==""&&Number(originalPrice)!==amount){
      priceAcc=Math.min(priceAcc,GUESSED);priceWhy+="; differs from the original quoted amount";
    }
    // No universal minimum/maximum market price: cents per fastener and
    // expensive industrial equipment are both legitimate source quotes.
    if(per&&(!Number.isFinite(per.price)||per.price<=0)){priceAcc=Math.min(priceAcc,DOUBTFUL);priceWhy+="; unit cost cannot be represented as a positive finite amount";}
  }

  // Category: confident placement, best guess, or set by the client.
  let catAcc=null,catWhy="";
  if(category&&!category.is_holding_pen){
    catAcc=item.category_review?GUESSED:item.category_reason?DERIVED:STATED;
    catWhy=item.category_review?(item.category_reason||"Best guess"):item.category_reason?item.category_reason:"Set or accepted";
    const independent=categories.length?suggestCategory(vi.description,categories,[]):null;
    if(item.category_review&&independent?.confidence==="confident"&&independent.category?.id===category.id){
      catAcc=DERIVED;catWhy=independent.reason;
    }
    if((independent?.confidence==="confident"||independent?.reason?.includes("Prepared product form"))&&independent.category?.id!==category.id){
      catAcc=Math.min(catAcc,GUESSED);
      catWhy+=`; description points to ${independent.category.name}; check the source and category`;
    }
  }

  // Brand: printed in a labeled column, pulled from an unlabeled cell, or typed.
  let brandAcc=null,brandWhy="";
  if(!empty(vi.brand)){
    brandAcc=byClient("brand")?STATED:provenance.brandSource==="details"?GUESSED:STATED;
    brandWhy=byClient("brand")?"Set by you":provenance.brandSource==="details"?"Taken from an unlabeled cell; it matched a brand you already carry":"Printed on the sheet";
    const clash=otherVendors.find(p=>p.brand&&p.brand.trim().toLowerCase()!==vi.brand.trim().toLowerCase());
    if(clash){brandAcc=Math.min(brandAcc,GUESSED);brandWhy+=`; another vendor lists ${clash.brand}`;}
    else if(provenPeers.length&&provenPeers.every(p=>p.brand&&p.brand.trim().toLowerCase()===vi.brand.trim().toLowerCase())){
      brandAcc=100;brandWhy+="; corroborated by another vendor";
    }
    const sourceBrand=source("brand","brand");
    if(byClient("brand")&&sourceBrand&&sourceBrand.trim().toLowerCase()!==vi.brand.trim().toLowerCase()){
      brandAcc=Math.min(brandAcc,GUESSED);brandWhy+="; differs from the original source";
    }
  }

  // Description: the vendor's own words are the vendor's own words.
  const descriptionCorroborated=provenPeers.length>0&&provenPeers.every(p=>p.description&&compareProductIdentity(vi.description,p.description).status==="same");
  const originalDescription=source("description","description");
  const descriptionConflict=byClient("description")&&originalDescription&&compareProductIdentity(vi.description,originalDescription).status!=="same";
  const descAcc=empty(vi.description)?null:descriptionConflict?GUESSED:descriptionCorroborated?100:STATED;
  const descWhy=descriptionConflict?"Edited description differs from original source; verify the product":descriptionCorroborated?"Product identity corroborated by a matching trade identifier":byClient("description")?"Cleaned up by you; verify against source":"As the vendor wrote it";

  // Item name: yours once you've typed it; until then it is only the vendor's wording.
  const named=!empty(item.name)&&item.name!==vi.description;
  const nameAcc=empty(item.name)?null:named?STATED:GUESSED;
  const nameWhy=named?"Your name for this product":"Still the vendor's wording; rename it when you like";

  // Association: proven by identifier or a second vendor, exact, or under review.
  const exact=mapping?.comparison_track==="exact"&&mapping?.confidence_score===100;
  const numAcc=item.master_item_number==null?null:exact?descriptionCorroborated&&packAcc===100?100:STATED:mapping?.confidence_score!=null?Math.max(DOUBTFUL,Math.min(GUESSED,mapping.confidence_score)):GUESSED;
  // The KERDOS number carries no percentage. It says how the association
  // was made: Automated by the engine, or Manual once a person changed it.
  const manualLink=mapping?.match_method==="manual"||Object.hasOwn(manual,"catalog_item_id");
  const numWhy=manualLink?"Manual association":"Automated association";

  // Unit cost only exists when pack, unit and price all hold up; it is as
  // sure as the least sure of the three.

  // A value the client typed is theirs: it reads 100% and carries their
  // initials. A later contradiction (another vendor's pack, the sheet's
  // original value) stays visible as a note on the cell, and nothing
  // about the row is held back because of it.
  const CLIENT=100;
  const byPerson=(key)=>{
    const entry=manual[key];
    if(!entry)return null;
    const who=entry.confirmedBy?editors[entry.confirmedBy]:null;
    return {initials:initialsFor(who)||"",at:entry.confirmedAt||null};
  };
  const clientField=(key,value,accuracy,reason)=>{
    const f=field(value,accuracy,reason);
    if(!byClient(key)||empty(value))return f;
    const person=byPerson(key);
    const notes=String(reason||"").split("; ").filter(part=>part&&!/^Set by you$/i.test(part)).join("; ");
    return {...f,accuracy:CLIENT,by:person?.initials||"",reason:`Set by ${person?.initials||"you"}${notes?"; "+notes:""}`};
  };

  const packField=clientField("pack_size",vi.pack_size||"",packAcc,packWhy||"No pack yet");
  const priceField=clientField("price",hasPrice?amount:null,priceAcc,priceWhy||"No price");
  const unitField=clientField("selling_unit",vi.selling_unit||"",unitAcc,unitWhy||"Choose what the quoted price is per");
  // Unit cost is as sure as the least sure of the three it comes from.
  const costAccuracy=per?.manual?100:per?Math.min(packField.accuracy??0,unitField.accuracy??0,priceField.accuracy??0):null;

  return {
    itemNumber:{...field(item.master_item_number,numAcc,numWhy),label:manualLink?"Manual":"Automated"},
    vendor:field(vendor?.name||"",vendor?STATED:null,"Vendor selected at import"),
    vendorItemNumber:field(String(vi.vendor_item_code||"").trim()||vendorListingLabel(vi)||"",vi.vendor_item_code||vendorListingLabel(vi)?100:null,"Vendor code or persistent NVIM number"),
    category:clientField("category_id",category?.name||"Uncategorized",catAcc,catWhy||"No category yet"),
    itemName:clientField("item_name",item.name||"",nameAcc,nameWhy),
    product:clientField("description",vi.description,descAcc,descWhy),
    brand:clientField("brand",vi.brand||"",brandAcc,brandWhy||"Blank when absent"),
    pack:packField,
    price:priceField,
    sellingUnit:unitField,
    unitCost:{...field(per?.price??null,costAccuracy,per?.manual?`Client-approved unit cost per ${per.unit}`:per?`Calculated per ${per.unit}${pack?.catchWeight?"; case weight is an estimate":""}`:"Needs a readable pack and a compatible quoted unit"),unit:per?.unit||null},
  };
}

// Order Guide worthy: every field of the row is solved. Category placed
// (holding pen doesn't count; a best-guess placement does — the client can
// still move it), description present, readable pack, a quoted unit that
// converts to a full-pack price, a current price, and the association
// itself either exact already or pointing at an item whose name agrees
// with the vendor wording. Rows like that are placed without a click.
export const REQUIRED_FIELDS=["category","product","pack","sellingUnit","price"];
export const BLOCKER_LABELS={category:"Category needs evidence",product:"Description needs evidence",pack:"Pack needs details",
  sellingUnit:"Quoted unit missing or unresolved",price:"Quoted amount needs evidence",unitCost:"Pack and price unit cannot convert",
  association:"Product association needs verification",quote:"No current quotation",expired:"Quote expired",
  source:"Source conflict needs review",brand:"Locked brand does not match",link:"Catalog link missing"};
export function orderGuideAssessment(input){
  const {item,vendorItem,mapping,vendor,category,peers=[],categories=[],settings={},now}=input;
  if(!item||!vendorItem||!mapping)return {ready:false,fieldsReady:false,blockers:["link"],evidence:null,verification:null};
  const evidence=catalogRowEvidence({item,vendorItem,mapping,vendor,category,peers,categories});
  // A category only has to be a real one; a best-guess placement is still a
  // placement and the price is no less right for it. The other required
  // cells must be worked out from strong evidence or better.
  const clientApproved=mapping.comparison_track==="exact"&&mapping.confidence_score===100&&mapping.match_method==="manual"&&!!vendorItem.field_resolutions?.row_approval;
  const override=clientApproved&&!!vendorItem.field_resolutions?.unit_cost_override?.value;
  const blockers=REQUIRED_FIELDS.filter(key=>key==="category"?(!category||category.is_holding_pen||evidence.category.accuracy==null):(evidence[key].accuracy??0)<DERIVED);
  if(override){for(const key of ["pack","sellingUnit"])if(blockers.includes(key))blockers.splice(blockers.indexOf(key),1);}
  if(evidence.unitCost.value==null&&!blockers.includes("pack")&&!blockers.includes("sellingUnit")&&!blockers.includes("price"))blockers.push("unitCost");
  const status=quoteStatus(vendorItem,settings,now);
  if(status!=="current")blockers.push(status==="expired"?"expired":"quote");
  if(vendorItem.import_row?.reviewRequired)blockers.push("source");
  if(item.brand_locked&&!brandsMatch(vendorItem.brand,item.locked_brand))blockers.push("brand");
  const fieldsReady=blockers.length===0;
  const approved=mapping.comparison_track==="exact"&&mapping.confidence_score===100;
  // A first-import item with no other vendor listing yet qualifies on field quality alone.
  // A second vendor enables cross-vendor price comparison; it is not required for ordering.
  // The association blocker applies when peers exist and disagree, or when a manual
  // association has not been verified (approved=false and peers are present).
  // Standalone qualification: no other vendor lists this item yet, all fields are
  // resolved, and the vendor description is not a different product from the catalog
  // item it was matched to. A second vendor enables cross-vendor price comparison;
  // it is not required for ordering. The gap check ensures the description and
  // catalog item name share at least some product identity — a chicken row matched
  // to a tomato catalog item ("No shared defining product terms") does not qualify.
  const gap=!peers.length&&fieldsReady?mappingGap(vendorItem,item,[]):null;
  const standaloneQualified=!!gap&&gap.code==="single-vendor-ready";
  const verification=approved&&((clientApproved&&item.comparison_mode!=="exact")||automaticAlternativeVerified(vendorItem,item,peers)||!peers.length)?mapping:mappingVerification(vendorItem,item,peers);
  if(!standaloneQualified&&verification.comparison_track!=="exact")blockers.push("association");
  return {ready:blockers.length===0,fieldsReady,blockers,evidence,verification};
}
export function orderGuideReady(input){return orderGuideAssessment(input).ready;}

export function qualificationSummary({catalogItems=[],vendorItems=[],mappings=[],vendors=[],categories=[],settings={},now}={}){
  const ci=new Map(catalogItems.map(row=>[row.id,row])),vi=new Map(vendorItems.map(row=>[row.id,row]));
  const vendorById=new Map(vendors.map(row=>[row.id,row])),categoryById=new Map(categories.map(row=>[row.id,row]));
  const rows=mappings.flatMap(mapping=>{
    const item=ci.get(mapping.catalog_item_id),vendorItem=vi.get(mapping.vendor_item_id);
    if(!item||!vendorItem)return [];
    const peers=mappings.filter(other=>other.catalog_item_id===item.id&&other.id!==mapping.id).map(other=>vi.get(other.vendor_item_id)).filter(Boolean);
    return [{mappingId:mapping.id,vendorItemId:vendorItem.id,...orderGuideAssessment({item,vendorItem,mapping,
      vendor:vendorById.get(vendorItem.vendor_id),category:categoryById.get(item.category_id),peers,categories,settings,now})}];
  });
  const linked=new Set(rows.map(row=>row.vendorItemId));
  for(const vendorItem of vendorItems)if(!linked.has(vendorItem.id))rows.push({vendorItemId:vendorItem.id,ready:false,blockers:["link"]});
  const counts={};for(const row of rows)for(const code of row.blockers)counts[code]=(counts[code]||0)+1;
  return {total:rows.length,ready:rows.filter(row=>row.ready).length,blocked:rows.filter(row=>!row.ready).length,
    blockers:Object.entries(counts).map(([code,count])=>({code,count,label:BLOCKER_LABELS[code]})).sort((a,b)=>b.count-a.count||a.code.localeCompare(b.code)),rows};
}

// Rows the app can place in the Order Guide on its own: ready by the rule
// above and not yet an exact association. Multi-vendor items also need
// the other vendor's row to agree on identity, brand and pack; single-
// vendor items only need the row to agree with its own catalog item.
export function autoPlaceable({catalogItems=[],vendorItems=[],mappings=[],vendors=[],categories=[],settings={},now}){
  const ciById=new Map(catalogItems.map(ci=>[ci.id,ci]));
  const viById=new Map(vendorItems.map(vi=>[vi.id,vi]));
  const vById=new Map(vendors.map(v=>[v.id,v]));
  const cById=new Map(categories.map(c=>[c.id,c]));
  const byCatalog=new Map();
  for(const m of mappings){const list=byCatalog.get(m.catalog_item_id)||[];list.push(m);byCatalog.set(m.catalog_item_id,list);}
  const out=[];
  for(const m of mappings){
    if(m.comparison_track==="exact"&&m.confidence_score===100)continue;
    const vi=viById.get(m.vendor_item_id),ci=ciById.get(m.catalog_item_id);
    if(!vi||!ci)continue;
    const category=cById.get(ci.category_id);
    const allOnEntry=(byCatalog.get(m.catalog_item_id)||[]);
    const peers=allOnEntry.filter(o=>o.id!==m.id).map(o=>viById.get(o.vendor_item_id)).filter(Boolean);
    if(!orderGuideReady({item:ci,vendorItem:vi,mapping:m,vendor:vById.get(vi.vendor_id),category,peers,categories,settings,now}))continue;
    const verification=mappingVerification(vi,ci,peers);
    if(verification.comparison_track!=="exact")continue;
    out.push({mappingId:m.id,vendorItemId:vi.id,catalogItemId:ci.id,description:vi.description,packSize:vi.pack_size,
      verification:{...verification,match_method:"rule_based"},clearCategoryReview:!!ci.category_review});
  }
  return out;
}

// A correction belongs to this vendor's item code. Remember the original
// field too: repeat vendor shorthand must not erase a client's clean wording.
const FIELDS={description:"description",brand:"brand",packSize:"pack_size"};
export function rememberImportRow(row,prior,mapping=null){
  if(!prior||(row.code?String(row.code)!==String(prior.vendor_item_code):!!prior.vendor_item_code))return row;
  if(mapping?.vendor_item_id===prior.id&&mapping.comparison_track==="exact"&&mapping.confidence_score===100){
    // The import resolved this vendor listing first. The saved association
    // and field corrections survive changes in document row order.
    const changes=knownItemChanges(row,prior);
    const conflicts=changes.map(change=>change.reason);
    const learnedUnit=prior.price_source!=="invoice"&&prior.price_basis&&priceBasisFor(prior.selling_unit)?.basis===prior.price_basis?prior.selling_unit:null;
    return {...row,description:prior.description,brand:prior.brand||"",packSize:prior.pack_size,
      sellingUnit:learnedUnit||row.sellingUnit||"",sellingUnitSource:learnedUnit?"remembered":row.sellingUnitSource,
      knownVendorItem:true,priceNeedsReview:conflicts.length>0,conflicts,changes};
  }
  const result={...row};
  const raw=prior.import_row?.row||{};
  for(const [input,saved] of Object.entries(FIELDS)){
    const remembered=prior.field_resolutions?.[saved];
    if(!remembered||row.manualFields?.includes(input))continue;
    const incoming=String(row[input]||"").trim();
    const original=String(remembered.sourceValue??raw[input]??"").trim();
    const corrected=String(remembered.value??"").trim();
    const same=incoming===original||incoming===corrected||!incoming||
      (input==="description"&&[original,corrected].filter(Boolean).some(d=>compareProductIdentity(incoming,d).status==="same"))||
      (input==="packSize"&&[original,corrected].filter(Boolean).some(p=>comparePurchasingPack(incoming,p).status==="same"));
    if(!same)throw new Error(`Vendor item ${row.code||`NVIM-${prior.nvim_number}`}: ${input} changed from the known source. The saved correction and association were kept; review this field.`);
    result[input]=remembered.value??"";
  }
  return result;
}
export function importResolutions(row,prior={},date=new Date().toISOString()){
  const fields={...prior.field_resolutions};
  // A fresh quote replaces the amount evidence; old price edits are not
  // permanent product corrections.
  delete fields.price;
  delete fields.unit_cost_override;
  for(const input of row.manualFields||[]){
    const key=FIELDS[input]||(input==="sellingUnit"?"selling_unit":input==="price"?"price":null);
    if(key)fields[key]={value:row[input]??"",sourceValue:row.originalFields?.[input]??prior.import_row?.row?.[input]??row[input]??"",confirmedAt:date};
  }
  return fields;
}

// Oversight is a comparison to accepted source fields after the item-number
// lookup. It never searches the catalog or changes the existing association.
const normalize=text=>String(text??"").trim().toUpperCase().replace(/[^A-Z0-9]+/g," ").trim();
export function knownItemChanges(row,prior){
  const baseline=prior.import_row?.baseline||prior.import_row?.row||{};
  const saved={description:prior.description,brand:prior.brand,packSize:prior.pack_size,sellingUnit:prior.selling_unit,gtin:prior.gtin,manufacturerCode:prior.manufacturer_code};
  const labels={description:"Product wording",brand:"Brand",packSize:"Pack",sellingUnit:"Quoted unit",gtin:"Barcode",manufacturerCode:"Manufacturer code"};
  const changes=[];
  for(const [field,label] of Object.entries(labels)){
    const after=row[field];
    if(after==null||String(after).trim()==="")continue; // a code-and-price sheet can omit known fields
    const before=baseline[field]||saved[field]||"";
    if(normalize(after)===normalize(before)||normalize(after)===normalize(saved[field]))continue;
    if(field==="packSize"&&[before,saved[field]].filter(Boolean).some(value=>comparePurchasingPack(after,value).status==="same"))continue;
    if(field==="sellingUnit"){
      const incoming=priceBasisFor(after),old=priceBasisFor(before);
      if(!before||incoming&&old&&incoming.basis===old.basis&&incoming.unit===old.unit)continue;
    }
    changes.push({field,before,after,reason:`${label} changed from “${before||"not stated"}” to “${after}”.`});
  }
  return changes;
}
