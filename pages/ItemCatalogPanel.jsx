import {AssociateAlternatives} from "./AssociateAlternatives.jsx";
import {useMemo,useState} from "react";
import {createCatalogRowsService} from "../services/catalog-rows.js";
import {CatalogRows} from "./CatalogRows.jsx";
import {unitChoices} from "../core/catalog-fields.js";
import {backend} from "../backend/index.js";
import {createCatalogService,mappingVerification,mappingGap,GAP_LABELS} from "../services/catalog.js";
import {createCategoryService} from "../services/categories.js";
import {bestCatalogMatch,bestPurchasingSuggestion,compareProductIdentity,comparePurchasingPack,commonPurchasingPack,parsePackSize,unitsForDimension,suggestCategory,priceBasisFor} from "../procurement.js";
import {blockReason,orderable} from "../core/ordering.js";
import {itemMatchesSearch} from "../core/catalog-browse.js";
import {formatMoney} from "../localization.js";
import {buildCatalogExportCSV,downloadTextFile} from "../reporting.js";
import {btn,chipStyle,inp} from "../ui/styles.js";

const catalogService=createCatalogService(backend);
const categoryService=createCategoryService(backend);

const MULTI_VENDOR_FILTER="__multi_vendor__";
const CATEGORY_REVIEW_FILTER="__category_review__";

export function ItemCatalogPanel({industry="",orgId,role,productList,vendors,catalogItems,mappings,vendorItems,categories,vocabulary=[],settings={},editors={},onUpdated}) {
  const canManage=role==="owner"||role==="manager";
  const [search,setSearch]=useState("");
  const [rowView,setRowView]=useState(true);
  const [showReview,setShowReview]=useState(false);
  const [mappedOnly,setMappedOnly]=useState(false);
  const [categoryFilter,setCategoryFilter]=useState("");
  const [remapOpenFor,setRemapOpenFor]=useState(null);
  const [remapSearch,setRemapSearch]=useState("");
  const [busyMappingId,setBusyMappingId]=useState(null);
  const [packEditFor,setPackEditFor]=useState(null);
  const [packValue,setPackValue]=useState("");
  const [vendorEditId,setVendorEditId]=useState(null);
  const [basisEditId,setBasisEditId]=useState(null);
  const [basisValue,setBasisValue]=useState("");
  const [vendorDraft,setVendorDraft]=useState({description:"",brand:"",packSize:"",caseQty:"",eachQty:"",unit:"EA"});
  const [renamingId,setRenamingId]=useState(null);
  const [renameValue,setRenameValue]=useState("");
  const [categoryEditId,setCategoryEditId]=useState(null);
  // Which catalog item's "map this item's vendors" panel is open. This
  // is separate from remapOpenFor (which mapping's remap-search box is
  // open, below) - a person opens the item's panel first, then may open
  // remap-search on one specific vendor line inside it. Available for
  // EVERY item, not just ones flagged for review - re-pointing a vendor's
  // price to a different catalog item shouldn't require waiting for the
  // system to flag it first.
  const [mapPanelOpenFor,setMapPanelOpenFor]=useState(null);
  const [showItemNumberFor,setShowItemNumberFor]=useState(null);
  // Bulk allocation of unclassified items. One-at-a-time reassignment is
  // fine for a stray item, but an import that leaves dozens unmatched
  // needs to be workable in one pass, not dozens of separate dropdowns.
  const [selectedIds,setSelectedIds]=useState(new Set());
  const [bulkBusy,setBulkBusy]=useState(false);
  // After a manual allocation, the words that would have matched are
  // offered back to the destination category so the SAME correction is
  // never needed twice. This is the dictionary learning from real use
  // rather than waiting on someone to hand-edit keywords.
  const [teach,setTeach]=useState(null); // {categoryId, categoryName, words:[], chosen:Set}
  const [teachBusy,setTeachBusy]=useState(false);
  const [addingItem,setAddingItem]=useState(false);
  const [newItemName,setNewItemName]=useState("");
  const [newItemCategoryId,setNewItemCategoryId]=useState("");
  const [addingBusy,setAddingBusy]=useState(false);
  const [error,setError]=useState("");
  const [busyItemId,setBusyItemId]=useState(null);

  const vMap=useMemo(()=>new Map(vendors.map(v=>[v.id,v])),[vendors]);
  const viMap=useMemo(()=>new Map(vendorItems.map(vi=>[vi.id,vi])),[vendorItems]);
  const ciMap=useMemo(()=>new Map(catalogItems.map(ci=>[ci.id,ci])),[catalogItems]);
  const linkedByCatalog=useMemo(()=>{
    const result=new Map();
    for(const mapping of mappings){const vendorItem=viMap.get(mapping.vendor_item_id);if(!vendorItem)continue;const list=result.get(mapping.catalog_item_id)||[];list.push(vendorItem);result.set(mapping.catalog_item_id,list);}
    return result;
  },[mappings,viMap]);
  function candidateSummary(catalogItemId,sourcePack){
    const linked=linkedByCatalog.get(catalogItemId)||[];
    const packs=[...new Set(linked.map(vi=>vi.pack_size).filter(Boolean))];
    const vendorsCount=new Set(linked.map(vi=>vi.vendor_id)).size;
    const commonPack=commonPurchasingPack(linked.map(vi=>vi.pack_size));
    const compared=commonPack?comparePurchasingPack(sourcePack,commonPack):null;
    return {packs,vendorsCount,brands:[...new Set(linked.map(v=>v.brand||"Brand not stated"))],descriptions:[...new Set(linked.map(v=>v.description))],warning:!commonPack&&packs.length>1?"Mixed or incomplete existing packs — inspect first":compared?.status!=="same"?"Pack needs verification":null};
  }

  // Categories are ordered alphabetically - same as Order Guide, so both screens'
  // category chips read the same way. Internal KERDOS item identifiers
  // are retained in the data but never shown to customers.
  const categoryList=useMemo(()=>{
    const set=new Set(productList.map(p=>p.category));
    return [...set].sort((a,b)=>a.localeCompare(b));
  },[productList]);

  const multiVendorItems=useMemo(()=>productList.filter(item=>new Set(item.options.map(o=>o.vendorId)).size>=2),[productList]);
  const isMapped=item=>item.options.length>0&&item.options.every(o=>!o.unverified);
  const mappedCount=productList.filter(isMapped).length;
  const notMappedCount=productList.length-mappedCount;
  const comparableItems=useMemo(()=>multiVendorItems.filter(item=>{
    const eligible=item.options.filter(orderable);
    return eligible.some((a,i)=>eligible.slice(i+1).some(b=>a.vendorId!==b.vendorId&&comparePurchasingPack(a.packSize,b.packSize).status==="same"));
  }),[multiVendorItems]);
  // Re-evaluate older placements when an industry's context profile improves.
  // This is review-only: a past client choice is never silently overwritten.
  const categoryCorrections=useMemo(()=>new Map(catalogItems.flatMap(item=>{
    const suggested=suggestCategory(item.name,categories,catalogItems);
    return suggested?.category?.id&&suggested.category.id!==item.category_id&&
      suggested.reason?.includes("Prepared product form")?[[item.id,suggested]]:[];
  })),[catalogItems,categories,vocabulary]);
  const uncategorizedName=categories.find(c=>c.is_holding_pen)?.name||"Uncategorized";
  const uncategorizedItems=productList.filter(item=>item.category===uncategorizedName);

  // Full List is one alphabetical client catalog. Selecting a product type
  // narrows that same alphabetized list without changing item identity or
  // client master numbers. Vendor codes remain mappings beneath each item.
  const groupedItems=useMemo(()=>{
    const items=productList.filter(item=>{
      if(mappedOnly&&!isMapped(item))return false;
      if(categoryFilter===MULTI_VENDOR_FILTER){if(new Set(item.options.map(o=>o.vendorId)).size<2)return false;}
      else if(categoryFilter===CATEGORY_REVIEW_FILTER){if(!categoryCorrections.has(item.catalogItemId))return false;}
      else if(categoryFilter&&item.category!==categoryFilter) return false;
      return itemMatchesSearch(item,search);
    });
    // Sort by name within each category so related products (all chicken, all lettuce)
    // cluster together — makes cross-vendor linking visible without any extra filtering.
    const sorted=[...items].sort((a,b)=>a.category.localeCompare(b.category)||a.name.localeCompare(b.name));
    // When a filter is active, return one group with that label.
    // When showing everything, group by category so the category headers are visible.
    if(categoryFilter){
      const label=categoryFilter===MULTI_VENDOR_FILTER?"Multiple Vendors":categoryFilter===CATEGORY_REVIEW_FILTER?"Review categories":categoryFilter;
      return sorted.length?[{category:label,items:sorted}]:[];
    }
    // No filter: one group per category, each sorted by name.
    const byCategory=new Map();
    for(const item of sorted){
      const list=byCategory.get(item.category)||[];list.push(item);byCategory.set(item.category,list);
    }
    return [...byCategory.entries()].map(([category,catItems])=>({category,items:catItems}));
  },[productList,search,categoryFilter,mappedOnly,categoryCorrections]);

  function statusFor(item){
    if(!isMapped(item))return {label:"Not mapped",color:"#B26A00",bg:"#FFF3E0"};
    return {label:"✓ Mapped",color:"#2E7D32",bg:"#E8F5E9"};
  }

  // One wrapper for every catalog action: show the failure where the
  // person is looking, and only refresh when the write actually landed.
  async function act(fn){
    if(!canManage) { setError("Only owners and managers can edit the catalog."); return false; }
    setError("");
    try{ await fn(); onUpdated(); return true; }
    catch(err){ setError(err.message||String(err)); return false; }
  }
  // A confirmation or a move teaches spelling, never product equality:
  // only abbreviation pairs between this listing and the other vendors'
  // wording on the same item are saved (see abbreviationPairs).
  async function learnFrom(vendor,peers){
    if(!vendor||!peers.length)return;
    try{await catalogService.learnAbbreviations({organizationId:orgId,description:vendor.description,references:peers.map(peer=>peer.description),vocabulary});}
    catch{/* learning is a convenience; a failed save never blocks the confirmation */}
  }
  async function handleConfirm(mappingId){
    const mapping=mappings.find(m=>m.id===mappingId);
    const vendor=viMap.get(mapping?.vendor_item_id);
    const target=ciMap.get(mapping?.catalog_item_id);
    const peers=(linkedByCatalog.get(target?.id)||[]).filter(vi=>vi.id!==vendor?.id);
    const verification=mappingVerification(vendor,target,peers);
    if(verification.comparison_track!=="exact"){
      setError("This association needs more product or pack details before it can be confirmed for price comparison. It remains in review.");
      return;
    }
    if(!window.confirm(`Confirm this association?\n\nVendor product: ${vendor?.description||"Unknown"}\nPack: ${vendor?.pack_size||"Not provided"}\nCatalog item: ${target?.name||"Unknown"}\n\nThis approval makes the vendor price eligible for ordering and keeps this link for future imports of the same vendor product.`))return;
    setBusyMappingId(mappingId);
    // Learn first so the refresh that follows the confirmation already
    // reads the new wording.
    await learnFrom(vendor,peers);
    await act(()=>catalogService.confirmMapping(mappingId,verification));
    setBusyMappingId(null);
  }
  // Vendor rows with a price but no stated unit. Most sheets quote per
  // case and simply don't say so; one click applies that to all of them.
  const unstatedBasisRows=useMemo(()=>vendorItems.filter(vi=>vi.organization_id===orgId&&!vi.price_basis&&!vi.selling_unit&&Number(vi.price)>0&&vi.price_source!=="invoice"),[vendorItems,orgId]);
  const [settingBasis,setSettingBasis]=useState(false);
  async function handleSetCaseBasis(){
    if(!unstatedBasisRows.length)return;
    const byVendor=new Map();
    for(const vi of unstatedBasisRows){const name=vendors.find(v=>v.id===vi.vendor_id)?.name||"Vendor";byVendor.set(name,(byVendor.get(name)||0)+1);}
    const lines=[...byVendor].map(([name,n])=>`• ${name}: ${n}`).join("\n");
    if(!window.confirm(`Treat the quoted price as the price of one full case for ${unstatedBasisRows.length} product${unstatedBasisRows.length===1?"":"s"} whose sheet didn't say?\n\n${lines}\n\nRows with a readable pack become priced for ordering. Rows without a pack stay unavailable until the pack is set. Rows that state their own unit are not touched.`))return;
    setSettingBasis(true);
    await act(()=>catalogService.setCaseBasisWhereUnstated({organizationId:orgId,vendorItems:unstatedBasisRows}));
    setSettingBasis(false);
  }
  async function handleSavePack(mappingId){
    const mapping=mappings.find(m=>m.id===mappingId);
    const vendor=viMap.get(mapping?.vendor_item_id);
    const target=ciMap.get(mapping?.catalog_item_id);
    if(!vendor||!target)return setError("This vendor product is no longer available. Refresh the catalog.");
    if(!parsePackSize(packValue)?.parsed)return setError("Enter a readable pack, such as 4/10 LB, 1-40#, or 12/32 OZ.");
    setBusyMappingId(mappingId);
    const saved=await act(()=>catalogService.correctVendorFields({organizationId:orgId,vendorItem:vendor,mappingId,
      description:vendor.description,brand:vendor.brand,packSize:packValue}));
    if(saved){setPackEditFor(null);setPackValue("");}
    setBusyMappingId(null);
  }
  function openVendorEdit(option){
    const parsed=parsePackSize(option.packSize);
    setVendorDraft({description:option.description||"",brand:option.brand||"",packSize:option.packSize||"",
      caseQty:parsed?.parsed?String(parsed.caseQty):"",eachQty:parsed?.parsed?String(parsed.unitQty):"",unit:parsed?.parsed?parsed.unit:"EA"});
    setVendorEditId(option.vendorItemId);
  }
  async function saveVendorEdit(option){
    const vendor=viMap.get(option.vendorItemId);
    if(!vendor)return setError("The vendor item is unavailable. Refresh Item Catalog.");
    setBusyMappingId(option.mappingId);
    const saved=await act(()=>catalogService.correctVendorFields({organizationId:orgId,vendorItem:vendor,mappingId:option.mappingId,
      description:vendorDraft.description,brand:vendorDraft.brand,packSize:vendorDraft.packSize}));
    if(saved)setVendorEditId(null);
    setBusyMappingId(null);
  }
  async function saveBasis(option){
    const vendor=viMap.get(option.vendorItemId);
    const basis=priceBasisFor(basisValue);
    if(!vendor||!basis||!Number.isFinite(Number(vendor.price))||Number(vendor.price)<=0)
      return setError("Choose CASE, EACH, or a recognized unit for this quoted amount.");
    setBusyMappingId(option.mappingId);
    const saved=await act(()=>createCatalogRowsService(backend).save({organizationId:orgId,vendorItem:vendor,
      mapping:mappings.find(m=>m.id===option.mappingId),patch:{selling_unit:basisValue}}));
    if(saved){setBasisEditId(null);setBasisValue("");}
    setBusyMappingId(null);
  }
  async function handleRemapExisting(mappingId,newCatalogItemId){
    const mapping=mappings.find(m=>m.id===mappingId);
    const vendor=viMap.get(mapping?.vendor_item_id);
    const current=ciMap.get(mapping?.catalog_item_id);
    const target=ciMap.get(newCatalogItemId);
    const summary=candidateSummary(newCatalogItemId,vendor?.pack_size);
    const verification=mappingVerification(vendor,target,linkedByCatalog.get(newCatalogItemId)||[]);
    if(!target||!window.confirm(`Move this vendor product?\n\n${vendor?.description||"Unknown vendor product"}\nIts pack: ${vendor?.pack_size||"Not provided"}\n\nFrom: ${current?.name||"Unknown"}\nTo: #${target.master_item_number} ${target.name}\nExisting packs: ${summary.packs.join(", ")||"Not listed"}\nImported brand: ${vendor?.brand||"Not stated"}\nExisting brands: ${summary.brands.join(", ")}\n${summary.warning?`Attention: ${summary.warning}.\n`:""}${verification.comparison_track==="review"?"The association will remain in review and its price will not compete until the product and pack are verified.\n":"The full product descriptions and packs agree; its price may compete.\n"}Only this vendor product moves. The other vendor products stay where they are. This selection is saved for future imports.`))return;
    setBusyMappingId(mappingId);
    if(verification.comparison_track==="exact")await learnFrom(vendor,(linkedByCatalog.get(newCatalogItemId)||[]).filter(peer=>peer.id!==vendor?.id));
    if(await act(()=>catalogService.remapToExisting(mappingId,newCatalogItemId,verification))){ setRemapOpenFor(null); setRemapSearch(""); }
    setBusyMappingId(null);
  }
  async function handleRemapNew(mappingId,description){
    if(!window.confirm(`Create a separate catalog item for "${description}"?\n\nOnly this vendor product will move to the new item. Existing vendor products remain in their current catalog items.`))return;
    setBusyMappingId(mappingId);
    if(await act(()=>catalogService.splitMapping({organizationId:orgId,mappingId,description,catalogItems,categories}))){ setRemapOpenFor(null); setRemapSearch(""); }
    setBusyMappingId(null);
  }

  async function saveRename(catalogItemId){
    const trimmed=renameValue.trim();
    setRenamingId(null);
    if(!trimmed) return;
    await act(()=>catalogService.renameItem(catalogItemId,trimmed));
  }

  // Words shared by the just-allocated items that the destination
  // category does not already match. These are exactly the words whose
  // absence caused the miss, so offering them back closes the gap at its
  // source. Deterministic word frequency - no model, no guessing.
  function suggestKeywords(items,targetCategory){
    const existing=(targetCategory?.keywords||[]).map(k=>String(k).toLowerCase());
    const freq=new Map();
    for(const it of items){
      const seen=new Set();
      for(const w of String(it.name||"").toLowerCase().split(/[^a-z0-9]+/)){
        if(w.length<3||seen.has(w)) continue;
        seen.add(w);
        freq.set(w,(freq.get(w)||0)+1);
      }
    }
    // Drop anything the category already covers, and anything that is
    // just a number or a size token.
    return [...freq.entries()]
      .filter(([w])=>!existing.some(k=>k===w||k.includes(w)||w.includes(k)))
      .filter(([w])=>!/^\d/.test(w))
      .sort((a,b)=>b[1]-a[1])
      .slice(0,8)
      .map(([w,n])=>({word:w,count:n}));
  }

  async function handleBulkAssign(newCategoryId){
    if(!newCategoryId||selectedIds.size===0) return;
    setBulkBusy(true);
    setError("");
    const target=categories.find(c=>c.id===newCategoryId);
    const chosenItems=productList.filter(p=>selectedIds.has(p.catalogItemId));
    try{
      // Numbering must stay collision-free, so assignments run in sequence
      // against a working copy, using the same rule as reclassification.
      const working=[...catalogItems];
      for(const item of chosenItems){
        const n=await categoryService.assignItem({catalogItemId:item.catalogItemId,categoryId:newCategoryId,catalogItems:working,categories});
        const i=working.findIndex(ci=>ci.id===item.catalogItemId);
        if(i>=0) working[i]={...working[i],category_id:newCategoryId,master_item_number:n};
      }
      const words=suggestKeywords(chosenItems,target);
      setSelectedIds(new Set());
      if(words.length) setTeach({categoryId:newCategoryId,categoryName:target?.name||"",words,chosen:new Set()});
      onUpdated();
    }catch(err){
      setError(`Could not move those items: ${err.message||String(err)}`);
    }finally{
      setBulkBusy(false);
    }
  }

  async function saveTeachedKeywords(){
    if(!teach||teach.chosen.size===0){ setTeach(null); return; }
    setTeachBusy(true);
    try{
      const cat=categories.find(c=>c.id===teach.categoryId);
      const merged=[...(cat?.keywords||[]),...[...teach.chosen]];
      await categoryService.updateKeywords(teach.categoryId,merged);
      setTeach(null);
      onUpdated();
    }finally{
      setTeachBusy(false);
    }
  }

  // Per-item rules (brand lock, strict matching, per-unit display unit).
  // A small write, then the same reload every other edit uses.
  async function handleItemSetting(catalogItemId,patch){
    await act(()=>catalogService.updateItemSettings(catalogItemId,patch));
  }

  async function handleAssignCategory(catalogItemId,newCategoryId){
    setCategoryEditId(null);
    if(!newCategoryId) return;
    await act(()=>categoryService.assignItem({catalogItemId,categoryId:newCategoryId,catalogItems,categories}));
  }

  async function handleAddItem(){
    if(!newItemName.trim()) return;
    setAddingBusy(true);
    if(await act(()=>catalogService.createItem({organizationId:orgId,name:newItemName.trim(),categoryId:newItemCategoryId||null,catalogItems,categories}))){
      setNewItemName(""); setNewItemCategoryId(""); setAddingItem(false);
    }
    setAddingBusy(false);
  }

  const lowConfidenceMatches=useMemo(()=>
    mappings.filter(m=>m.comparison_track!=="exact"||m.confidence_score!==100||productList.some(item=>item.catalogItemId===m.catalog_item_id&&item.options.some(option=>option.mappingId===m.id&&option.unverified))).map(m=>{
      const vi=viMap.get(m.vendor_item_id); const ci=ciMap.get(m.catalog_item_id);
      const v=vi?vMap.get(vi.vendor_id):null;
      const others=showReview?catalogItems.filter(c=>c.id!==m.catalog_item_id):[];
      const suggested=showReview&&vi?bestPurchasingSuggestion(vi.description,vi.pack_size,others.map(ci=>{
        const peers=linkedByCatalog.get(ci.id)||[];
        return {...ci,pack_size:commonPurchasingPack(peers.map(peer=>peer.pack_size))};
      })):null;
      const suggestion=suggested|| (showReview&&vi?bestCatalogMatch(vi.description,others):null);
      const suggestedVendor=mappings.filter(link=>link.catalog_item_id===suggestion?.catalogItem?.id).map(link=>viMap.get(link.vendor_item_id)).find(link=>link?.pack_size);
      const detail=vi&&ci?compareProductIdentity(vi.description,ci.name):null;
      const packCheck=vi?comparePurchasingPack(vi.pack_size,suggestedVendor?.pack_size):null;
      const currentVerification=vi&&ci?mappingVerification(vi,ci,linkedByCatalog.get(ci.id)||[]):null;
      const gap=mappingGap(vi,ci,linkedByCatalog.get(ci?.id)||[]);
      return {mappingId:m.id, gap, catalogItemId:m.catalog_item_id, catalogName:ci?.name||"(deleted item)", vendorName:v?.name||"—",
        vendorDescription:vi?.description||"—",packSize:vi?.pack_size||null,brand:vi?.brand||null, confidence:m.confidence_score, track:m.comparison_track,
        canConfirm:currentVerification?.comparison_track==="exact",
        oneVendor:new Set((linkedByCatalog.get(ci?.id)||[]).map(peer=>peer.vendor_id)).size===1,
        reason:!vi?.pack_size?"Pack size missing":currentVerification?.comparison_track==="review"?detail?.status!=="same"?detail?.reason:packCheck?.reason||"Check full product specifications with linked vendors":"Check the full product specifications",
        suggestion:suggestion?{catalogItemId:suggestion.catalogItem.id,name:suggestion.catalogItem.name,score:Math.round(suggestion.score*100)}:null};
    }).sort((a,b)=>a.gap.code.localeCompare(b.gap.code)||(a.confidence??0)-(b.confidence??0)),
  [mappings,viMap,ciMap,vMap,catalogItems,productList,linkedByCatalog,showReview]);

  // One count per reason, so the client sees where the work is instead of
  // a flat list, and a click narrows the list to that reason.
  const [gapFilter,setGapFilter]=useState("");
  const gapCounts=useMemo(()=>{
    const counts=new Map();
    for(const m of lowConfidenceMatches)counts.set(m.gap.code,(counts.get(m.gap.code)||0)+1);
    return Object.keys(GAP_LABELS).filter(code=>counts.get(code)).map(code=>({code,label:GAP_LABELS[code],count:counts.get(code)}));
  },[lowConfidenceMatches]);
  const visibleReviewMatches=gapFilter?lowConfidenceMatches.filter(m=>m.gap.code===gapFilter):lowConfidenceMatches;

  // Item Catalog's review badge is scoped to CATALOG MAPPING issues only
  // (fuzzy vendor-item matches) - invoice-line issues live on Invoices,
  // price-sheet health (unavailable/stale prices) lives on Price Sheets.
  // Each tab shows only what's actually its own job to review.
  const totalCount=lowConfidenceMatches.length;

  return (
    <div>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:14}}>
        <h3 style={{margin:0,fontSize:16,color:"white"}}>Item Catalog</h3>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          {canManage&&<button onClick={()=>setAddingItem(true)} style={{...btn("#003584","white",{fontSize:12,padding:"8px 14px"})}}>+ Add Item</button>}
          <button onClick={()=>downloadTextFile(`catalog-export-${new Date().toISOString().split("T")[0]}.csv`,buildCatalogExportCSV(productList,vendors),"text/csv")}
            disabled={!productList.length} style={{...btn("#2E7D32","white",{fontSize:12,padding:"8px 14px"})}}>
            📄 Export (CSV)
          </button>
        </div>
      </div>

      <div style={{display:"flex",gap:8,marginBottom:12}}><button onClick={()=>setRowView(true)} style={btn(rowView?"#003584":"#EEE",rowView?"white":"#333")}>Edit catalog rows</button><button onClick={()=>setRowView(false)} style={btn(!rowView?"#003584":"#EEE",!rowView?"white":"#333")}>Product details</button></div>
      {error&&<div style={{background:"#FFF3E0",color:"#E65100",padding:"10px 12px",borderRadius:8,fontSize:13,marginBottom:14}}>{error}</div>}

      {canManage&&addingItem&&(
        <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,0.5)",zIndex:1000,display:"flex",alignItems:"center",justifyContent:"center",padding:16}}>
          <div style={{background:"white",borderRadius:12,padding:24,width:"100%",maxWidth:380}}>
            <h3 style={{margin:"0 0 4px",fontSize:16}}>Add a catalog item</h3>
            <p style={{margin:"0 0 14px",fontSize:12,color:"#888"}}>This is your item — name it however makes sense to you. Vendor prices get matched into it as they come in.</p>
            <input style={{...inp,width:"100%",marginBottom:10,boxSizing:"border-box"}} placeholder="Item name" value={newItemName} onChange={e=>setNewItemName(e.target.value)} autoFocus />
            <select style={{...inp,width:"100%",marginBottom:14,boxSizing:"border-box"}} value={newItemCategoryId} onChange={e=>setNewItemCategoryId(e.target.value)}>
              <option value="">No category (Uncategorized)</option>
              {categories.filter(c=>!c.is_holding_pen).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
            <div style={{display:"flex",gap:8}}>
              <button onClick={()=>{setAddingItem(false);setNewItemName("");setNewItemCategoryId("");}} style={{...btn("#EEE","#555"),flex:1}}>Cancel</button>
              <button onClick={handleAddItem} disabled={addingBusy||!newItemName.trim()} style={{...btn("#003584"),flex:2}}>{addingBusy?"Adding...":"Add Item"}</button>
            </div>
          </div>
        </div>
      )}

      <div style={{display:"flex",gap:8,marginBottom:14}}>
        <button onClick={()=>{setShowReview(false);setMappedOnly(false);}} style={{...btn(showReview||mappedOnly?"#E8F1FB":"white","#003584",{fontSize:12,padding:"9px 14px",fontWeight:800})}}>All products ({productList.length})</button>
        <button onClick={()=>{setShowReview(false);setMappedOnly(true);}} style={{...btn(mappedOnly?"#E8F5E9":"white","#2E7D32",{fontSize:12,padding:"9px 14px",fontWeight:800})}}>Mapped ({mappedCount})</button>
        {canManage&&notMappedCount>0&&<button onClick={()=>{setShowReview(true);setMappedOnly(false);}} style={{...btn(showReview?"#E65100":"#FFF3E0",showReview?"white":"#B26A00",{fontSize:12,padding:"9px 14px",fontWeight:800})}}>Not mapped ({notMappedCount})</button>}
        {canManage&&unstatedBasisRows.length>0&&<button disabled={settingBasis} onClick={handleSetCaseBasis} title="Rows with a price but no stated unit" style={{...btn("#EDE7F6","#4527A0",{fontSize:12,padding:"9px 14px",fontWeight:800,marginLeft:"auto"})}}>{settingBasis?"Setting…":`Quoted per case: ${unstatedBasisRows.length} row${unstatedBasisRows.length===1?"":"s"} without a unit`}</button>}
      </div>

      {categoryCorrections.size>0&&<div style={{display:"flex",gap:12,flexWrap:"wrap",marginBottom:14}}>
        {categoryCorrections.size>0&&<button onClick={()=>{setShowReview(false);setMappedOnly(false);setCategoryFilter(CATEGORY_REVIEW_FILTER);}} style={{background:"#FFF8E1",border:"1px solid #E8D79B",borderRadius:9,padding:"11px 14px",cursor:"pointer",textAlign:"left",minWidth:220}}>
          <b style={{display:"block",fontSize:20,color:"#8D6E00"}}>{categoryCorrections.size}</b><span style={{fontSize:12,color:"#405A76"}}>Older category placements to review</span>
        </button>}
      </div>}

      {canManage&&showReview&&totalCount>0&&(
        <div style={{marginBottom:24,paddingBottom:4}}>
          <div style={{marginBottom:20}}>
            <div style={{fontWeight:800,fontSize:13,color:"white",marginBottom:8}}>Vendor products to check</div>
            <p style={{fontSize:12,color:"rgba(255,255,255,0.85)",margin:"0 0 10px"}}>Check where each vendor product belongs. Moving a vendor price here changes only that vendor product.</p>
            <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:12}}>
              {gapCounts.map(g=>(
                <button key={g.code} onClick={()=>setGapFilter(gapFilter===g.code?"":g.code)} title={g.code==="single-vendor-ready"?"Placed automatically once its fields are complete":undefined}
                  style={{...btn(gapFilter===g.code?"white":"rgba(255,255,255,0.15)",gapFilter===g.code?"#B26A00":"white",{fontSize:11,padding:"6px 10px",fontWeight:800,border:"1px solid rgba(255,255,255,0.4)"})}}>
                  {g.label} · {g.count}
                </button>
              ))}
              {gapFilter&&<button onClick={()=>setGapFilter("")} style={{...btn("transparent","white",{fontSize:11,padding:"6px 10px",fontWeight:700,border:"1px dashed rgba(255,255,255,0.5)"})}}>Show all</button>}
            </div>
            {visibleReviewMatches.map(m=>(
              <div key={m.mappingId} style={{background:"white",borderRadius:8,padding:"10px 12px",marginBottom:6,boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
                <div style={{fontSize:11,color:"#666",marginBottom:3}}>Vendor product · {m.vendorName}</div>
                {m.oneVendor&&<div style={{fontSize:11,color:"#9C5A00",fontWeight:800,marginBottom:4}}>Found on one vendor list · places itself once its fields are complete</div>}
                <div style={{fontWeight:700,fontSize:13}}>{m.vendorDescription}</div>
                <div style={{fontSize:11,color:"#555",marginTop:3}}>Pack: <b>{m.packSize||"Not provided"}</b>{m.brand?` · Brand: ${m.brand}`:""}</div>
                <div style={{fontSize:12,color:"#555",marginTop:5,marginBottom:8}}>Currently under <b>{m.catalogName}</b> <span style={{color:"#B26A00"}}>· {m.confidence>0?`${m.confidence}% wording similarity; verify details`:"Awaiting verification"}</span></div>
                <div style={{fontSize:11,color:"#B26A00",marginBottom:8}}><b>{m.gap.label}.</b> {m.packSize?m.gap.detail||m.reason:"Enter the pack shown on the original vendor document."} Similar wording is not proof of the same product.</div>
                {!m.packSize&&<div style={{marginBottom:8}}>{packEditFor===m.mappingId?(
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}><input style={{...inp,width:170,fontSize:12}} value={packValue} onChange={e=>setPackValue(e.target.value)} placeholder="e.g. 4/10 LB" aria-label="Vendor pack size" />
                    <button disabled={busyMappingId===m.mappingId} onClick={()=>handleSavePack(m.mappingId)} style={{...btn("#003584","white",{fontSize:11})}}>Save pack and recheck</button>
                    <button onClick={()=>setPackEditFor(null)} style={{...btn("#EEE","#555",{fontSize:11})}}>Cancel</button></div>
                ):<button onClick={()=>{setPackEditFor(m.mappingId);setPackValue("");}} style={{...btn("#003584","white",{fontSize:11})}}>Enter pack size</button>}</div>}
                {m.suggestion&&(
                  <div style={{fontSize:11,color:"#555",marginBottom:8}}>
                    Another possible item: <b>{m.suggestion.name}</b> <span style={{color:"#999"}}>({m.suggestion.score}% suggested match)</span>
                  </div>
                )}
                {remapOpenFor===m.mappingId?(
                  <div style={{background:"#F7F9FC",borderRadius:6,padding:8}}>
                    <div style={{fontSize:12,fontWeight:700,marginBottom:6}}>Choose the catalog item for this vendor product</div>
                    <input style={{...inp,marginBottom:6,fontSize:12,padding:"7px 9px"}} placeholder="Enter a KERDOS item number or search by product name..." value={remapSearch} onChange={e=>setRemapSearch(e.target.value)} autoFocus />
                    <div style={{maxHeight:140,overflowY:"auto"}}>
                      {catalogItems.filter(ci=>{
                        if(ci.id===m.catalogItemId) return false;
                        const q=remapSearch.trim().toLowerCase();
                        if(!q) return true;
                        return ci.name.toLowerCase().includes(q)||String(ci.master_item_number).includes(q);
                      }).slice(0,8).map(ci=>(
                        <button key={ci.id} disabled={busyMappingId===m.mappingId} onClick={()=>handleRemapExisting(m.mappingId,ci.id)}
                          style={{display:"block",width:"100%",textAlign:"left",background:"white",border:"1px solid #EEE",borderRadius:5,padding:"6px 8px",marginBottom:4,fontSize:12,cursor:"pointer"}}>
                          <span style={{fontFamily:"monospace",color:"#003584",fontWeight:800}}>#{ci.master_item_number}</span> · {ci.name}
                          <span style={{display:"block",paddingLeft:3,fontSize:10,color:candidateSummary(ci.id,m.packSize).warning?"#B26A00":"#39764F"}}>Brand: {candidateSummary(ci.id,m.packSize).brands.join(", ")} · Pack: {candidateSummary(ci.id,m.packSize).packs.join(", ")||"Unknown"} · {candidateSummary(ci.id,m.packSize).vendorsCount} vendor(s){candidateSummary(ci.id,m.packSize).warning?` · ${candidateSummary(ci.id,m.packSize).warning}`:""}</span>
                        </button>
                      ))}
                    </div>
                    <div style={{display:"flex",gap:6,marginTop:6}}>
                      <button disabled={busyMappingId===m.mappingId} onClick={()=>handleRemapNew(m.mappingId,m.vendorDescription)}
                        style={{...btn("#EEE","#555",{fontSize:11,padding:"6px 10px",flex:1})}}>Create a new item for this vendor product</button>
                      <button onClick={()=>{setRemapOpenFor(null);setRemapSearch("");}} style={{...btn("#EEE","#555",{fontSize:11,padding:"6px 10px"})}}>Cancel</button>
                    </div>
                  </div>
                ):(
                  <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                    {m.canConfirm&&<button disabled={busyMappingId===m.mappingId} onClick={()=>handleConfirm(m.mappingId)}
                      style={{...btn("#2E7D32","white",{fontSize:11,padding:"6px 12px"})}}>{busyMappingId===m.mappingId?"Saving...":"Confirm verified match"}</button>}
                    {m.suggestion&&(
                      <button disabled={busyMappingId===m.mappingId} onClick={()=>handleRemapExisting(m.mappingId,m.suggestion.catalogItemId)}
                        style={{...btn("#1565C0","white",{fontSize:11,padding:"6px 12px"})}}>Move to {m.suggestion.name}</button>
                    )}
                    <button disabled={busyMappingId===m.mappingId} onClick={()=>{setRemapOpenFor(m.mappingId);setRemapSearch("");}}
                      style={{...btn("#EEE","#555",{fontSize:11,padding:"6px 12px"})}}>Choose another item or create new</button>
                    {/* Unlink: one-click split for any cross-vendor group — review or confirmed */}
                    {mappings.some(other=>other.catalog_item_id===m.catalogItemId&&other.id!==m.mappingId&&viMap.get(other.vendor_item_id)?.vendor_id!==viMap.get(m.vendorItemId)?.vendor_id)&&(
                      <button disabled={busyMappingId===m.mappingId} onClick={async()=>{
                        if(!window.confirm("Unlink this vendor product? It will get its own KERDOS entry and stay orderable. This survives reimport."))return;
                        setBusyMappingId(m.mappingId);
                        try{await catalogService.splitMapping({organizationId:orgId,mappingId:m.mappingId,description:viMap.get(m.vendorItemId)?.description||"",catalogItems,categories});await onUpdated();}
                        catch(e){setError(e.message);}
                        finally{setBusyMappingId(null);}
                      }} style={{...btn("#FFF3E0","#E65100",{fontSize:11,padding:"6px 12px"})}}>Unlink from group</button>
                    )}
                  </div>
                )}
              </div>
            ))}
          </div>

        </div>
      )}

      {showReview&&productList.some(item=>!item.options.length)&&(
        <div style={{background:"white",borderRadius:8,padding:12,marginBottom:16}}>
          <b style={{fontSize:12,color:"#173C70"}}>Catalog items without a vendor listing</b>
          <div style={{fontSize:12,color:"#555",marginTop:5}}>{productList.filter(item=>!item.options.length).map(item=>item.name).join(", ")}</div>
          <div style={{fontSize:11,color:"#667",marginTop:5}}>Import a vendor price sheet to associate and verify a listing.</div>
        </div>
      )}

      {!showReview&&<>
      <input style={{...inp,marginBottom:10}} placeholder="Search by item, vendor description, or vendor code..." value={search} onChange={e=>setSearch(e.target.value)} />

      <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:18}}>
        <button onClick={()=>setCategoryFilter("")} style={chipStyle(!categoryFilter)}>
          Full List
        </button>
        {uncategorizedItems.length>0&&<button onClick={()=>{setCategoryFilter(uncategorizedName);setShowReview(false);}} style={chipStyle(categoryFilter===uncategorizedName)}>
          Needs a category ({uncategorizedItems.length})
        </button>}
        {multiVendorItems.length>0&&<button onClick={()=>setCategoryFilter(categoryFilter===MULTI_VENDOR_FILTER?"":MULTI_VENDOR_FILTER)} style={chipStyle(categoryFilter===MULTI_VENDOR_FILTER)}>
          Multiple Vendors ({multiVendorItems.length})
        </button>}
        {categoryList.filter(c=>c!==uncategorizedName).map(c=>{
          const isSelected=categoryFilter===c;
          return (
            <button key={c} onClick={()=>setCategoryFilter(isSelected?"":c)} style={chipStyle(isSelected)}>
              {c}
            </button>
          );
        })}
      </div>

      {canManage&&teach&&(
        <div style={{background:"#E8F5E9",border:"2px solid #2E7D32",borderRadius:10,padding:14,marginBottom:12}}>
          <div style={{fontSize:13,fontWeight:700,color:"#1B5E20",marginBottom:4}}>Teach the catalog so this doesn't happen again</div>
          <div style={{fontSize:12,color:"#33691E",marginBottom:8}}>
            Add any of these words to <b>{teach.categoryName}</b> and items like these will classify automatically from now on, on every future import.
          </div>
          <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
            {teach.words.map(({word,count})=>{
              const on=teach.chosen.has(word);
              return (
                <button key={word} onClick={()=>setTeach(t=>{const c=new Set(t.chosen);on?c.delete(word):c.add(word);return {...t,chosen:c};})}
                  style={{fontSize:12,fontWeight:700,padding:"5px 11px",borderRadius:14,cursor:"pointer",
                    background:on?"#2E7D32":"white",color:on?"white":"#33691E",
                    border:on?"2px solid #2E7D32":"2px solid #A5D6A7"}}>
                  {on?"✓ ":""}{word}{count>1?` (${count})`:""}
                </button>
              );
            })}
          </div>
          <div style={{display:"flex",gap:8}}>
            <button onClick={saveTeachedKeywords} disabled={teachBusy||teach.chosen.size===0}
              style={{...btn("#2E7D32","white",{fontSize:12,padding:"8px 14px",opacity:teach.chosen.size===0?0.5:1})}}>
              {teachBusy?"Saving...":`Add ${teach.chosen.size||""} word${teach.chosen.size===1?"":"s"} to ${teach.categoryName}`}
            </button>
            <button onClick={()=>setTeach(null)} style={{...btn("#EEE","#555",{fontSize:12,padding:"8px 14px"})}}>Not now</button>
          </div>
        </div>
      )}

      {canManage&&selectedIds.size>0&&(
        <div style={{background:"white",borderRadius:10,padding:12,marginBottom:12,boxShadow:"0 1px 3px rgba(0,0,0,0.06)",
          display:"flex",alignItems:"center",gap:10,flexWrap:"wrap",position:"sticky",top:8,zIndex:5}}>
          <span style={{fontSize:13,fontWeight:700,color:"#003584"}}>{selectedIds.size} selected</span>
          {selectedIds.size>=2&&<button disabled={bulkBusy} style={{...btn("#003584","white",{fontSize:12,padding:"7px 14px",fontWeight:700})}}
            onClick={async()=>{
              setBulkBusy(true);setError("");
              try{
                // All vendor items linked to the selected catalog entries
                const vids=mappings.filter(m=>selectedIds.has(m.catalog_item_id)).map(m=>m.vendor_item_id);
                // Use the lowest KERDOS number as the target entry
                const linkedEntries=catalogItems.filter(c=>selectedIds.has(c.id)).sort((a,b)=>Number(a.master_item_number)-Number(b.master_item_number));
                const target=linkedEntries[0];
                if(!target||vids.length<2)throw new Error("Select at least two items from different vendors to link.");
                const revisions=Object.fromEntries(vendorItems.filter(vi=>vids.includes(vi.id)).map(vi=>[vi.id,vi.row_revision??0]));
                await backend.catalog.associateAlternatives({organizationId:orgId,vendorItemIds:vids,targetCatalogItemId:target.id,name:target.name,preferredBrand:"",revisions});
                setSelectedIds(new Set());await onUpdated();
              }catch(e){setError(e.message);}finally{setBulkBusy(false);}
            }}>Link selected</button>}
          <AssociateAlternatives orgId={orgId} selectedVendorIds={mappings.filter(m=>selectedIds.has(m.catalog_item_id)).map(m=>m.vendor_item_id)} vendorItems={vendorItems} catalogItems={catalogItems} mappings={mappings} vendors={vendors} onUpdated={onUpdated} onClear={()=>setSelectedIds(new Set())}/>
          <select defaultValue="" disabled={bulkBusy} onChange={e=>{handleBulkAssign(e.target.value);e.target.value="";}}
            style={{...inp,fontSize:12,padding:"7px 9px",width:"auto",flex:"0 1 220px"}}>
            <option value="" disabled>{bulkBusy?"Moving...":"Move all to..."}</option>
            {categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}
          </select>
          <button onClick={()=>setSelectedIds(new Set())} style={{...btn("#EEE","#555",{fontSize:12,padding:"7px 12px"})}}>Clear</button>
        </div>
      )}

      {productList.length===0?(
        <div style={{background:"white",borderRadius:10,padding:20,textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
          <p style={{color:"#888",fontSize:13,margin:0}}>Nothing in the catalog yet — import a price list to get started.</p>
        </div>
      ):groupedItems.length===0?(
        <div style={{background:"white",borderRadius:10,padding:20,textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
          <p style={{color:"#888",fontSize:13,margin:0}}>No items match that search.</p>
        </div>
      ):rowView?<CatalogRows industry={industry} settings={settings} editors={editors} orgId={orgId} items={groupedItems.flatMap(g=>g.items)} catalogItems={catalogItems} vendorItems={vendorItems} mappings={mappings} vendors={vendors} categories={categories} vocabulary={vocabulary} canManage={canManage} onUpdated={onUpdated} onDetails={id=>{setRowView(false);setMapPanelOpenFor(id);}} />:groupedItems.map(group=>(
        <div key={group.category} style={{marginBottom:20}}>
          <div style={{display:"flex",alignItems:"center",gap:8,marginBottom:8,paddingLeft:2}}>
            {canManage&&<input type="checkbox"
              checked={group.items.length>0&&group.items.every(i=>selectedIds.has(i.catalogItemId))}
              onChange={e=>{
                const all=e.target.checked;
                setSelectedIds(prev=>{
                  const next=new Set(prev);
                  group.items.forEach(i=>all?next.add(i.catalogItemId):next.delete(i.catalogItemId));
                  return next;
                });
              }}
              title={`Select every item shown under ${group.category}`} />}
            <span style={{fontWeight:800,fontSize:13,color:"rgba(255,255,255,0.85)"}}>{group.category}</span>
            <span style={{fontSize:11,color:"rgba(255,255,255,0.5)"}}>({group.items.length})</span>
          </div>
          <div style={{background:"white",borderRadius:10,overflowX:"auto",boxShadow:"0 3px 14px rgba(0,20,65,.12)"}}>
            <div style={{minWidth:890}}>
              <div style={{display:"grid",gridTemplateColumns:"28px 28px minmax(210px,1.8fr) minmax(190px,1.5fr) 118px 112px 115px 120px",gap:14,padding:"14px 18px",background:"#E8F0FA",color:"#173C70",fontSize:10,fontWeight:900,letterSpacing:".08em",textTransform:"uppercase"}}>
                <span></span><span></span><span>Item</span><span>Vendor / description</span><span>Pack size</span><span>Case price</span><span>Cost per unit</span><span>Match</span>
              </div>
              {group.items.map((item,index)=>{
                const status=statusFor(item);
                const first=item.options.find(orderable)||item.options[0]||null;
                const expanded=mapPanelOpenFor===item.catalogItemId;
                return <div key={item.catalogItemId} style={{borderTop:"1px solid #E7ECF3",background:expanded?"#F1F7FF":index%2?"#FAFCFF":"white"}}>
                  <div role="button" tabIndex={0} aria-expanded={expanded} onClick={()=>setMapPanelOpenFor(expanded?null:item.catalogItemId)}
                    onKeyDown={e=>{if(e.key==="Enter"||e.key===" "){e.preventDefault();setMapPanelOpenFor(expanded?null:item.catalogItemId);}}}
                    style={{display:"grid",gridTemplateColumns:"28px 28px minmax(210px,1.8fr) minmax(190px,1.5fr) 118px 112px 115px 120px",gap:14,alignItems:"center",padding:"14px 18px",cursor:"pointer",borderLeft:expanded?"4px solid #397CC3":"4px solid transparent"}}>
                    {canManage
                      ?<input type="checkbox" aria-label={`Select ${item.name} for linking`}
                          checked={selectedIds.has(item.catalogItemId)}
                          onChange={e=>{e.stopPropagation();setSelectedIds(prev=>{const n=new Set(prev);e.target.checked?n.add(item.catalogItemId):n.delete(item.catalogItemId);return n;});}}
                          onClick={e=>e.stopPropagation()} style={{cursor:"pointer",width:15,height:15,justifySelf:"center"}}/>
                      :<span/>}
                    <span style={{color:"#2870B8",fontSize:14,fontWeight:900}}>{expanded?"▾":"▸"}</span>
                    <div style={{minWidth:0}}>
                      <div style={{fontWeight:800,fontSize:13,color:"#152D4B"}}>{item.name}</div>
                      <div style={{fontSize:10,color:"#75859A",marginTop:3}}>{item.category} · {new Set(item.options.map(o=>o.vendorId)).size} vendor{new Set(item.options.map(o=>o.vendorId)).size===1?"":"s"} linked</div>
                      {categoryCorrections.has(item.catalogItemId)&&<div style={{fontSize:10,color:"#9C5A00",fontWeight:800,marginTop:4}}>
                        Review category: suggested {categoryCorrections.get(item.catalogItemId).category.name} · open item to change
                      </div>}
                      {item.categoryReview&&<div style={{display:"flex",alignItems:"center",gap:8,flexWrap:"wrap",marginTop:4}}>
                        <span style={{fontSize:10,fontWeight:800,color:"#8D6E00",background:"#FFF8E1",borderRadius:5,padding:"2px 7px"}} title={item.categoryReason||""}>Category is KERDOS's best guess — pick the category to confirm</span>
                        {canManage&&<button onClick={()=>act(()=>catalogService.confirmCategory(item.catalogItemId))} style={{border:0,background:"none",color:"#2E7D32",cursor:"pointer",fontSize:11,fontWeight:700,padding:0}}>Looks right</button>}
                      </div>}
                    </div>
                    <div style={{minWidth:0}}>
                      <div style={{fontWeight:700,fontSize:12,color:"#23466D"}}>{first?.vendorName||"No vendor yet"}</div>
                      <div title={first?.description} style={{fontSize:10,color:"#60758B",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{first?.description||"Add a vendor product to compare prices"}</div>
                    </div>
                    <span style={{fontSize:12,fontWeight:700,color:first?.packSize?"#29445E":"#B26A00"}}>{first?.packSize||"—"}</span>
                    <span style={{fontSize:14,fontWeight:900,color:"#173C70"}}>{first?.casePrice!=null?formatMoney(first.casePrice):"—"}</span>
                    <span style={{fontSize:12,fontWeight:800,color:first?.perUnit?"#087965":"#9AA6B2"}}>{first?.perUnit?`${formatMoney(first.perUnit.price)}/${first.perUnit.unit}`:"—"}</span>
                    <div style={{display:"flex",flexDirection:"column",gap:4,alignItems:"flex-start"}}>
                      <span style={{fontSize:10,fontWeight:800,color:status.color,background:status.bg,padding:"6px 7px",borderRadius:6}}>{status.label}</span>
                      {canManage&&item.options.some(o=>!o.unverified&&o.matchTrack!=="exact")&&(
                        <button onClick={async e=>{e.stopPropagation();
                          setBusyItemId(item.catalogItemId);setError("");
                          try{
                            const toConfirm=mappings.filter(m=>m.catalog_item_id===item.catalogItemId&&m.comparison_track!=="exact");
                            for(const m of toConfirm)await catalogService.confirmMapping(m.id,{comparison_track:"exact",confidence_score:100,match_method:"rule_based"});
                            await onUpdated();
                          }catch(e){setError(e.message);}finally{setBusyItemId(null);}
                        }} disabled={busyItemId===item.catalogItemId}
                        style={{...btn("#2E7D32","white",{fontSize:10,padding:"4px 8px"})}}>
                          {busyItemId===item.catalogItemId?"Moving…":"Migrate →"}
                        </button>
                      )}
                    </div>
                  </div>
                  {expanded&&<div style={{padding:"2px 18px 18px 50px",borderLeft:"4px solid #397CC3"}}>
                    <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:10,marginBottom:10}}>
                      <div style={{display:"flex",alignItems:"center",gap:9}}>
                        {canManage&&<input type="checkbox" checked={selectedIds.has(item.catalogItemId)} title="Select for category change" onChange={e=>setSelectedIds(prev=>{const next=new Set(prev);e.target.checked?next.add(item.catalogItemId):next.delete(item.catalogItemId);return next;})} />}
                        {canManage&&renamingId===item.catalogItemId?<><input autoFocus style={{...inp,width:220,fontSize:12}} value={renameValue} onChange={e=>setRenameValue(e.target.value)} onKeyDown={e=>{if(e.key==="Enter")saveRename(item.catalogItemId);if(e.key==="Escape")setRenamingId(null);}} /><button onClick={()=>saveRename(item.catalogItemId)} style={{...btn("#003584","white",{fontSize:11})}}>Save</button></>:<><strong style={{fontSize:13,color:"#19395F"}}>{item.name}</strong>{canManage&&<button onClick={()=>{setRenamingId(item.catalogItemId);setRenameValue(item.name);}} style={{border:0,background:"none",color:"#2870B8",cursor:"pointer"}}>Rename</button>}</>}
                        {canManage&&categoryEditId===item.catalogItemId?<select autoFocus defaultValue="" onChange={e=>handleAssignCategory(item.catalogItemId,e.target.value)} style={{...inp,width:165,fontSize:11}}><option value="" disabled>Move category to...</option>{categories.filter(c=>c.name!==item.category).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>:canManage&&<button onClick={()=>setCategoryEditId(item.catalogItemId)} style={{border:0,background:"none",color:"#2870B8",cursor:"pointer"}}>Change category</button>}
                      </div>
                      <button onClick={()=>setShowItemNumberFor(showItemNumberFor===item.catalogItemId?null:item.catalogItemId)} style={{border:"1px solid #CBD9E9",borderRadius:6,background:"white",color:"#173C70",padding:"6px 9px",fontWeight:700,cursor:"pointer",fontSize:11}}>{showItemNumberFor===item.catalogItemId?`KERDOS #${item.masterItemNumber} ▴`:"KERDOS number ▾"}</button>
                    </div>
                    <div style={{fontSize:11,fontWeight:800,color:"#597089",textTransform:"uppercase",letterSpacing:".05em",marginBottom:7}}>Vendor products · choose an association to correct it</div>
                    {new Set(item.options.map(o=>o.vendorId)).size>=2&&<div style={{background:comparableItems.some(p=>p.catalogItemId===item.catalogItemId)?"#E6F5ED":"#FFF3E0",color:comparableItems.some(p=>p.catalogItemId===item.catalogItemId)?"#23764C":"#9C5A00",padding:"8px 10px",borderRadius:6,fontSize:11,fontWeight:700,marginBottom:8}}>
                      {comparableItems.some(p=>p.catalogItemId===item.catalogItemId)?"At least two vendors have current, matching-pack offers for this product.":"Multiple vendors are linked, but their current offers or packs are not yet verified as comparable."}
                    </div>}
                    <div style={{display:"grid",gridTemplateColumns:"140px minmax(180px,1fr) 95px 95px 100px 170px",gap:10,padding:"8px 10px",fontSize:10,fontWeight:800,color:"#49617C",background:"#DFEAF7",borderRadius:"6px 6px 0 0"}}><span>Vendor</span><span>Description</span><span>Pack</span><span>Price</span><span>Per unit</span><span>Association</span></div>
                    {item.options.map(o=><div key={o.vendorItemId} style={{display:"grid",gridTemplateColumns:"140px minmax(180px,1fr) 95px 95px 100px 170px",gap:10,padding:"10px",alignItems:"center",background:"white",borderBottom:"1px solid #E8EDF4",fontSize:11}}>
                      <b>{o.vendorName}</b><span>{o.description}{o.brand?` · ${o.brand}`:""}</span><b>{o.packSize||"Unknown"}</b><b>{o.casePrice!=null?formatMoney(o.casePrice):"No quote"}</b><b>{o.perUnit?`${formatMoney(o.perUnit.price)}/${o.perUnit.unit}`:"—"}</b>
                      <button disabled={!canManage} onClick={()=>{setRemapOpenFor(o.mappingId);setRemapSearch("");}} style={{...btn("#E8F1FB","#003584",{fontSize:10,padding:"6px"})}}>Change association</button>
                      {canManage&&<div style={{gridColumn:"1 / -1"}}>
                        <button onClick={()=>vendorEditId===o.vendorItemId?setVendorEditId(null):openVendorEdit(o)} style={{...btn("#E8F1FB","#003584",{fontSize:10,padding:"5px 8px"})}}>{vendorEditId===o.vendorItemId?"Close field editor":"Correct product, brand or pack"}</button>
                        {vendorEditId===o.vendorItemId&&<div style={{display:"flex",gap:8,flexWrap:"wrap",alignItems:"end",padding:10,marginTop:7,background:"#F4F8FE",borderRadius:6}}>
                          <label>Product description<input aria-label="Vendor product description" style={{...inp,width:205,fontSize:11}} value={vendorDraft.description} onChange={e=>setVendorDraft(d=>({...d,description:e.target.value}))} /></label>
                          <label>Brand<input aria-label="Vendor brand, blank if absent" placeholder="Leave blank if absent" style={{...inp,width:130,fontSize:11}} value={vendorDraft.brand} onChange={e=>setVendorDraft(d=>({...d,brand:e.target.value}))} /></label>
                          <label>Pack<input aria-label="Vendor pack size" style={{...inp,width:145,fontSize:11}} value={vendorDraft.packSize} onChange={e=>setVendorDraft(d=>({...d,packSize:e.target.value}))} /></label>
                          <label>Case contains<input aria-label="Inner items per case" type="number" min="1" style={{...inp,width:70,fontSize:11}} value={vendorDraft.caseQty} onChange={e=>setVendorDraft(d=>{const next={...d,caseQty:e.target.value};if(Number(next.caseQty)>0&&Number(next.eachQty)>0)next.packSize=`${next.caseQty}/${next.eachQty} ${next.unit}`;return next;})} /></label>
                          <label>Each size<input aria-label="Size of each inner item" type="number" min="0.001" step="any" style={{...inp,width:75,fontSize:11}} value={vendorDraft.eachQty} onChange={e=>setVendorDraft(d=>{const next={...d,eachQty:e.target.value};if(Number(next.caseQty)>0&&Number(next.eachQty)>0)next.packSize=`${next.caseQty}/${next.eachQty} ${next.unit}`;return next;})} /></label>
                          <label>Unit<select aria-label="Pack measurement unit" style={{...inp,width:95,fontSize:11}} value={vendorDraft.unit} onChange={e=>setVendorDraft(d=>({...d,unit:e.target.value,packSize:Number(d.caseQty)>0&&Number(d.eachQty)>0?`${d.caseQty}/${d.eachQty} ${e.target.value}`:d.packSize}))}>
                            {[...new Set([vendorDraft.unit,...unitChoices(vocabulary,true,industry).map(u=>u.value)])].map(unit=><option key={unit} value={unit}>{unit}</option>)}
                          </select></label>
                          <button disabled={busyMappingId===o.mappingId} onClick={()=>saveVendorEdit(o)} style={{...btn("#003584","white",{fontSize:11})}}>Save correction</button>
                          <div style={{flexBasis:"100%",fontSize:10,color:"#875200"}}>Changing defining fields keeps the KERDOS association but pauses this offer for verification before price comparison.</div>
                        </div>}
                      </div>}
                      {canManage&&o.priceUnavailable&&!o.quoteBasis&&o.quotedPrice!=null&&<div style={{gridColumn:"1 / -1",background:"#FFF3E0",padding:8,borderRadius:6}}>
                        <b>Quoted amount {formatMoney(o.quotedPrice)} · selling unit unknown.</b> The product stays here; this price cannot compete yet.
                        {basisEditId===o.vendorItemId?<div style={{display:"flex",gap:7,marginTop:7,alignItems:"center"}}>
                          <select aria-label="Confirm quoted selling unit" value={basisValue} onChange={e=>setBasisValue(e.target.value)} style={{...inp,width:125,fontSize:11}}><option value="">Select unit</option>{unitChoices(vocabulary,false,industry).map(unit=><option key={unit.value} value={unit.value}>{unit.label}</option>)}</select>
                          <button disabled={busyMappingId===o.mappingId||!basisValue} onClick={()=>saveBasis(o)} style={{...btn("#003584","white",{fontSize:11})}}>Confirm quoted unit</button>
                          <button onClick={()=>setBasisEditId(null)} style={{...btn("#EEE","#555",{fontSize:11})}}>Cancel</button>
                        </div>:<button onClick={()=>{setBasisEditId(o.vendorItemId);setBasisValue("");}} style={{...btn("#FFF","#875200",{fontSize:11,marginLeft:8})}}>Resolve price unit</button>}
                      </div>}
                      <details style={{gridColumn:"1 / -1",fontSize:11,color:"#49617C"}}><summary style={{cursor:"pointer",fontWeight:700}}>Mapping details</summary>
                        <div style={{marginTop:6,padding:"7px 9px",background:"#F4F8FE",borderRadius:6}}>
                          {o.unverified?"Not mapped":"Mapped"} · {o.unverified?o.matchConfidence!=null?`${o.matchConfidence}% wording similarity; verification still needed`:"Verification still needed":"100% verified"} · {o.matchMethod==="manual"?"Association selected by client":o.matchMethod==="rule_based"?"Association selected by KERDOS engine":"Association source unavailable"}
                        </div>
                          {o.cellUnresolved?.length>0&&<div style={{marginTop:6,background:"#FFF8E1",borderRadius:4,padding:"5px 7px"}}>
                            <b style={{color:"#7A5000"}}>Unresolved fields:</b>
                            {o.cellUnresolved.map((u,i)=><div key={i} style={{marginTop:2,color:"#7A5000"}}>{u.field}: {u.reason}</div>)}
                          </div>}
                          {o.cellConflicts?.length>0&&<div style={{marginTop:6,background:"#FFF3E0",borderRadius:4,padding:"5px 7px"}}>
                            <b style={{color:"#7A3000"}}>Import conflicts:</b>
                            {o.cellConflicts.map((c,i)=><div key={i} style={{marginTop:2,color:"#7A3000"}}>{c.field}: {c.note||c.reason}</div>)}
                          </div>}
                      </details>
                      {remapOpenFor===o.mappingId&&<div style={{gridColumn:"1 / -1",background:"#F4F8FE",padding:9,borderRadius:6}}>
                        <div style={{fontSize:12}}>Imported: {o.description} · {o.brand||"Brand not stated"} · {o.packSize||"Pack unknown"}</div><input autoFocus style={{...inp,fontSize:12}} placeholder="Search by KERDOS number or item name" value={remapSearch} onChange={e=>setRemapSearch(e.target.value)} />
                        <div style={{maxHeight:160,overflowY:"auto",marginTop:5}}>{catalogItems.filter(ci=>ci.id!==item.catalogItemId&&(!remapSearch.trim()||ci.name.toLowerCase().includes(remapSearch.trim().toLowerCase())||String(ci.master_item_number).includes(remapSearch.trim()))).slice(0,10).map(ci=><button key={ci.id} disabled={busyMappingId===o.mappingId} onClick={()=>handleRemapExisting(o.mappingId,ci.id)} style={{display:"block",width:"100%",textAlign:"left",background:"white",border:"1px solid #E4EBF3",borderRadius:4,padding:"7px 8px",marginBottom:3,cursor:"pointer"}}><b style={{color:"#003584"}}>#{ci.master_item_number}</b> · {ci.name}<span style={{display:"block",fontSize:10,color:candidateSummary(ci.id,o.packSize).warning?"#B26A00":"#39764F"}}>Brand: {candidateSummary(ci.id,o.packSize).brands.join(", ")} · Pack: {candidateSummary(ci.id,o.packSize).packs.join(", ")||"Unknown"} · {candidateSummary(ci.id,o.packSize).vendorsCount} vendor(s){candidateSummary(ci.id,o.packSize).warning?` · ${candidateSummary(ci.id,o.packSize).warning}`:""}</span></button>)}</div>
                        <div style={{display:"flex",gap:8,marginTop:6}}><button disabled={busyMappingId===o.mappingId} onClick={()=>handleRemapNew(o.mappingId,o.description)} style={{...btn("#E5EEF8","#003584",{fontSize:11})}}>Create separate product</button><button onClick={()=>{setRemapOpenFor(null);setRemapSearch("");}} style={{...btn("#EEE","#555",{fontSize:11})}}>Cancel</button></div>
                      </div>}
                      {!orderable(o)&&<span style={{gridColumn:"1 / -1",fontSize:10,color:"#B26A00"}}>⚠ {blockReason(o)}</span>}
                    </div>)}
                    {!item.options.length&&<div style={{background:"white",padding:14,fontSize:12,color:"#667"}}>No vendor products linked yet.</div>}
                    <div style={{marginTop:15,fontSize:11,fontWeight:800,color:"#597089",textTransform:"uppercase",letterSpacing:".05em",marginBottom:7}}>Product preferences</div>
                    {(()=>{
                      // Brands come from this item's own vendor options - a lock can
                      // only ever name a brand some vendor actually lists.
                      const brands=[...new Set(item.options.map(o=>String(o.brand||"").trim()).filter(Boolean))].sort((a,b)=>a.localeCompare(b));
                      const units=item.unitDimension?unitsForDimension(item.unitDimension):[];
                      const sel={...inp,fontSize:11,padding:"4px 6px",width:"auto"};
                      const lbl={fontSize:10,fontWeight:700,color:"#AAA",letterSpacing:"0.06em",textTransform:"uppercase"};
                      return (
                        <div style={{display:"flex",flexWrap:"wrap",gap:14,alignItems:"flex-end",background:"white",border:"1px solid #EEE",borderRadius:6,padding:"8px 10px",marginBottom:8}}>
                          <div>
                            <label style={{display:"block",fontSize:12}}><input type="checkbox" checked={item.comparisonMode!=="exact"} onChange={e=>handleItemSetting(item.catalogItemId,{comparison_mode:e.target.checked?"alternatives":"exact"})}/> Accept client-approved alternatives across brands</label>
                            <small>To add an alternative, set its KERDOS number to this item's number in Edit catalog rows, then Apply. Each vendor keeps its description, brand and pack.</small>
                          </div>
                          <div>
                            <label style={{display:"block",fontSize:12}}><input type="checkbox" checked={!!item.preferredBrand} disabled={!brands.length} onChange={e=>handleItemSetting(item.catalogItemId,{preferred_brand:e.target.checked?brands[0]:null})}/> Prefer a brand</label>
                            {item.preferredBrand&&<select aria-label={`Preferred brand for ${item.name}`} style={sel} value={item.preferredBrand} onChange={e=>handleItemSetting(item.catalogItemId,{preferred_brand:e.target.value})}>{[...new Set([item.preferredBrand,...brands])].map(b=><option key={b} value={b}>{b}</option>)}</select>}
                            <small style={{display:"block"}}>Alternatives remain available.</small>
                          </div>
                          <div>
                            <div style={lbl}>Require this brand</div>
                            {brands.length?(
                              <select style={sel} value={item.lockedBrand||""}
                                onChange={e=>handleItemSetting(item.catalogItemId,{brand_locked:!!e.target.value,locked_brand:e.target.value||null})}>
                                <option value="">Any brand</option>
                                {brands.map(b=><option key={b} value={b}>{b}</option>)}
                              </select>
                            ):(
                              <div style={{fontSize:11,color:"#AAA",paddingTop:4}}>No vendor lists a brand for this item</div>
                            )}
                          </div>
                          <div>
                            <div style={lbl}>Vendor matching</div>
                            <select style={sel} value={item.matchingBehavior}
                              onChange={e=>handleItemSetting(item.catalogItemId,{matching_behavior:e.target.value})}>
                              <option value="flexible">Flexible — close matches link, flagged for review</option>
                              <option value="strict">Strict — only exact matches link</option>
                            </select>
                          </div>
                          <div>
                            <div style={lbl}>Compare per</div>
                            {units.length?(
                              <select style={sel} value={item.canonicalUnit||""}
                                onChange={e=>handleItemSetting(item.catalogItemId,{canonical_unit:e.target.value||null})}>
                                <option value="">Auto ({item.displayUnit||"—"})</option>
                                {units.map(u=><option key={u} value={u}>{u}</option>)}
                              </select>
                            ):(
                              <div style={{fontSize:11,color:"#AAA",paddingTop:4}}>{item.displayUnit?`per ${item.displayUnit}`:"No readable pack size yet"}</div>
                            )}
                          </div>
                        </div>
                      );
                    })()}                  </div>}
                </div>;
              })}
            </div>
          </div>
        </div>
      ))}
      </>}
    </div>
  );
}
