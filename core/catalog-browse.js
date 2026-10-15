// Shared browsing helpers used by both Item Catalog and Order Guide.
import {safeProductScore,compareProductIdentity,comparePurchasingPack,casePriceFromQuote,quoteStatus} from "../procurement.js";

// A listing on another catalog item (or with no mapping) is evidence worth
// reviewing, never an orderable offer. The same pack is required before even
// proposing a price comparison. Confirming the link remains an Item Catalog
// action, which persists the client's decision for subsequent imports.
export function comparisonReviewCandidates(item, vendorItems, mappings, vendors, settings={}){
  const mappedHere=new Set(mappings.filter(m=>m.catalog_item_id===item.catalogItemId).map(m=>m.vendor_item_id));
  const linkedVendorIds=new Set(item.options.map(o=>o.vendorId));
  const vendorById=new Map(vendors.map(v=>[v.id,v]));
  const references=item.options.filter(o=>o.packSize);
  if(!references.length)return [];
  return vendorItems.filter(vi=>!mappedHere.has(vi.id)&&!linkedVendorIds.has(vi.vendor_id))
    .map(vi=>{
      const witness=references.find(o=>comparePurchasingPack(vi.pack_size,o.packSize).status==="same"&&
        compareProductIdentity(vi.description,o.description).status!=="different"&&
        safeProductScore(vi.description,o.description)>=0.5);
      if(!witness)return null;
      const vendor=vendorById.get(vi.vendor_id);
      if(!vendor)return null;
      const price=quoteStatus(vi,settings)==="current"
        ?casePriceFromQuote(vi.price,vi.price_basis||null,vi.selling_unit||null,vi.pack_size):null;
      return {vendorId:vi.vendor_id,vendorName:vendor.name,description:vi.description,packSize:vi.pack_size,
        price,score:safeProductScore(vi.description,witness.description)};
    }).filter(Boolean).sort((a,b)=>b.score-a.score||a.vendorName.localeCompare(b.vendorName));
}

// Three ways to order items within a category (or a full/unfiltered list):
// alphabetical by name, this org's own client item-number sequence, or the
// vendor's own item code (taken from that item's cheapest/first-listed
// vendor option, since one client item can carry several vendors' different
// codes - there's no single "the" vendor code). Items missing whatever key
// the current mode needs sink to the end rather than disappearing. Shared
// by Item Catalog (mapping work) and Order Guide (placing orders) - same
// browsing idea, different job each screen is doing with the result.
export function compareItems(a,b,mode){
  if(mode==="itemNumber"){
    const na=a.masterItemNumber,nb=b.masterItemNumber;
    if(na==null&&nb==null) return a.name.localeCompare(b.name);
    if(na==null) return 1; if(nb==null) return -1;
    return na-nb;
  }
  if(mode==="vendorCode"){
    const ca=a.options[0]?.vendorItemCode,cb=b.options[0]?.vendorItemCode;
    if(!ca&&!cb) return a.name.localeCompare(b.name);
    if(!ca) return 1; if(!cb) return -1;
    return String(ca).localeCompare(String(cb),undefined,{numeric:true});
  }
  if(mode==="added"){
    // Chronological = the order items actually entered the catalog, oldest
    // first - not alphabetical, not the numbering scheme. Falls back to
    // name order for anything missing a timestamp rather than dropping it.
    const ta=a.createdAt?new Date(a.createdAt).getTime():null,tb=b.createdAt?new Date(b.createdAt).getTime():null;
    if(ta==null&&tb==null) return a.name.localeCompare(b.name);
    if(ta==null) return 1; if(tb==null) return -1;
    return ta-tb;
  }
  return a.name.localeCompare(b.name);
}

// Search finds an item by the client's own name for it, by any vendor's
// wording for it, or by any vendor's item code - whichever the person
// has in front of them.
export function itemMatchesSearch(item, query){
  const q=String(query||"").trim().toLowerCase();
  if(!q) return true;
  if(item.name.toLowerCase().includes(q)) return true;
  if(String(item.masterItemNumber||"")===q) return true;
  return item.options.some(o=>String(o.description||"").toLowerCase().includes(q)||String(o.vendorItemCode||"").toLowerCase()===q||
    (o.vendorNvim!=null&&(`nvim-${o.vendorNvim}`===q||String(o.vendorNvim)===q)));
}
