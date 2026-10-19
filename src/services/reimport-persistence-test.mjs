// Module E · Reimport Persistence — Task #8
//
// Four Task #8 checklist requirements:
//   1. Manual confirmations survive reimport
//   2. Vendor links and price history preserved
//   3. KERDOS item numbers permanent after commit
//   4. Corrections survive — no regression on reimport
//
// Active import path traced:
//   importPriceRow → preparePriceImport (returns requiresReview, resolved)
//   → applyQuote (appends to price_history, writes field_resolutions)
//   → existingMapping check (line 132) → skips matchOrCreate when mapping found
//   → else if applySelectedCategory && row.categoryId → calls the callback
//
// Row shape used: sellingUnit:"LB", packSize:"4/10 LB", price:1.50
//   - resolveQuoteBasis resolves on the explicit sellingUnit
//   - parsePackSize("4/10 LB") parses → no "Pack unreadable" reason
//   - casePriceFromQuote produces a valid case price
//   → requiresReview:false → applyQuote is called (not the needsBasis bypass)
//
// Uses createInMemoryBackend() — no real Supabase connection needed.

import assert from "node:assert/strict";
import {importPriceRow} from "../core/import-price-row.js";
import {createCatalogService} from "../services/catalog.js";

// ---------------------------------------------------------------------------
// In-memory backend  (same pattern as mapping-review-test.mjs)
// ---------------------------------------------------------------------------

function uuid(){return Math.random().toString(36).slice(2)+Date.now().toString(36);}

function createInMemoryBackend({orgId,userId,userRole="manager"}={}){
  const catalogs=new Map();
  const vendors=new Map();
  const mappings=new Map();
  const categories=new Map();
  const members=new Map();
  if(userId&&orgId&&userRole)members.set(userId+"_"+orgId,userRole);

  function table(name){
    const store=name==="catalog_items"?catalogs:name==="vendor_items"?vendors:name==="item_mappings"?mappings:categories;
    let _data=null;let _insertRows=null;let _eq=[];let _single=false;let _select=false;let _delete=false;
    const api={
      select(f){_select=true;return api;},
      insert(rows){
        const arr=Array.isArray(rows)?rows:[rows];
        const ids=arr.map(r=>{const id=uuid();store.set(id,{id,...r});return id;});
        _insertRows=arr.map((r,i)=>({id:ids[i],...r}));
        return api;
      },
      update(data){_data=data;return api;},
      delete(){_delete=true;return api;},
      eq(k,v){_eq.push([k,v]);return api;},
      single(){_single=true;return api;},
      async then(resolve){
        if(_delete){
          const matched=[...store.entries()].filter(([,r])=>_eq.every(([k,v])=>r[k]===v));
          for(const[id]of matched)store.delete(id);
          return resolve({data:null,error:null});
        }
        if(_insertRows){
          if(_single)return resolve({data:_insertRows[0]||null,error:null});
          return resolve({data:_insertRows,error:null});
        }
        if(_data){
          const matched=[...store.entries()].filter(([,r])=>_eq.every(([k,v])=>r[k]===v));
          for(const[id,row]of matched)store.set(id,{...row,..._data});
          if(_select)return resolve({data:matched.map(([id])=>store.get(id)),error:null});
          return resolve({data:null,error:null});
        }
        let rows=[...store.values()].filter(r=>_eq.every(([k,v])=>r[k]===v));
        if(_single)return resolve({data:rows[0]||null,error:rows[0]?null:"not found"});
        return resolve({data:rows,error:null});
      },
    };
    return api;
  }

  async function kerdos_reject_mapping({p_organization_id,p_mapping_id,p_expected_revision,p_expected_catalog_item_id}){
    if(p_expected_catalog_item_id==null)return{data:null,error:{message:"expected_catalog_item_id is required"}};
    const member=userId?members.get(userId+"_"+p_organization_id):null;
    if(!member||!["owner","manager"].includes(member))return{data:null,error:{message:"Owner or manager access is required"}};
    const mapping=[...mappings.values()].find(m=>m.id===p_mapping_id&&m.organization_id===p_organization_id);
    if(!mapping)return{data:null,error:{message:"Association not found"}};
    const vendor=[...vendors.values()].find(v=>v.id===mapping.vendor_item_id&&v.organization_id===p_organization_id);
    if(!vendor)return{data:null,error:{message:"Vendor product not found"}};
    if(vendor.row_revision!==p_expected_revision)return{data:null,error:{message:"This product changed; refresh before rejecting"}};
    const freshMapping=[...mappings.values()].find(m=>m.id===p_mapping_id&&m.organization_id===p_organization_id);
    if(freshMapping.catalog_item_id!==p_expected_catalog_item_id)return{data:null,error:{message:"The association changed since you loaded this page; refresh and try again"}};
    const item=[...catalogs.values()].find(c=>c.id===freshMapping.catalog_item_id&&c.organization_id===p_organization_id);
    if(!item)return{data:null,error:{message:"Catalog item not found"}};
    const newId=uuid();
    catalogs.set(newId,{id:newId,organization_id:p_organization_id,category_id:item.category_id,
      name:(vendor.description||"").slice(0,120),matching_behavior:"flexible",comparison_mode:"alternatives",brand_locked:false,
      category_review:item.category_review,category_reason:item.category_reason,master_item_number:Math.floor(Math.random()*90000)+10000});
    const res=vendor.field_resolutions||{};
    const prev=res.rejected_catalog_item_ids||[];
    const next=[...new Set([...prev,item.id])];
    vendors.set(vendor.id,{...vendor,field_resolutions:{...res,rejected_catalog_item_ids:next},row_revision:vendor.row_revision+1});
    mappings.set(mapping.id,{...mapping,catalog_item_id:newId,comparison_track:"review",confidence_score:0,match_method:"rejected"});
    return{data:{catalogItemId:newId,masterItemNumber:catalogs.get(newId).master_item_number,rejectedCatalogItemId:item.id},error:null};
  }

  async function kerdos_remap_to_rejected({p_organization_id,p_mapping_id,p_new_catalog_item_id,
    p_expected_revision,p_expected_catalog_item_id,p_comparison_track,p_confidence_score,p_match_method}){
    const member=userId?members.get(userId+"_"+p_organization_id):null;
    if(!member||!["owner","manager"].includes(member))return{data:null,error:{message:"Owner or manager access is required"}};
    const mapping=[...mappings.values()].find(m=>m.id===p_mapping_id&&m.organization_id===p_organization_id);
    if(!mapping)return{data:null,error:{message:"Association not found"}};
    const vendor=[...vendors.values()].find(v=>v.id===mapping.vendor_item_id&&v.organization_id===p_organization_id);
    if(!vendor)return{data:null,error:{message:"Vendor product not found"}};
    if(p_expected_revision!=null&&vendor.row_revision!==p_expected_revision)return{data:null,error:{message:"This product changed; refresh before remapping"}};
    const freshMapping=[...mappings.values()].find(m=>m.id===p_mapping_id&&m.organization_id===p_organization_id);
    if(p_expected_catalog_item_id!=null&&freshMapping.catalog_item_id!==p_expected_catalog_item_id)return{data:null,error:{message:"The association changed since you loaded this page; refresh and try again"}};
    const destItem=[...catalogs.values()].find(c=>c.id===p_new_catalog_item_id&&c.organization_id===p_organization_id);
    if(!destItem)return{data:null,error:{message:"Destination catalog item not found in this organization"}};
    const res=vendor.field_resolutions||{};
    const prev=res.rejected_catalog_item_ids||[];
    const trimmed=prev.filter(id=>id!==p_new_catalog_item_id);
    vendors.set(vendor.id,{...vendor,field_resolutions:{...res,rejected_catalog_item_ids:trimmed},row_revision:vendor.row_revision+1});
    mappings.set(mapping.id,{...mapping,catalog_item_id:p_new_catalog_item_id,
      comparison_track:p_comparison_track,confidence_score:p_confidence_score,match_method:p_match_method});
    return{data:null,error:null};
  }

  const backend={
    records:{query:table},
    rpc:(name,args)=>
      name==="kerdos_reject_mapping"?kerdos_reject_mapping(args):
      name==="kerdos_remap_to_rejected"?kerdos_remap_to_rejected(args):
      Promise.resolve({data:null,error:{message:`Unknown RPC ${name}`}}),
    pricing:{
      // _priceHistory: vendorItemId → [{sourceDocumentId, price}]
      // Mirrors the price_history table appended by kerdos_apply_price_quote in production.
      // applyQuote also writes back fieldResolutions, just as the production RPC does,
      // so that field-correction tests exercise the actual preservation logic
      // (importResolutions spreads prior.field_resolutions first, so manual corrections survive).
      _priceHistory:new Map(),
      async applyQuote({vendorItemId,...args}){
        const id=vendorItemId||uuid();
        if(!vendors.has(id))vendors.set(id,{id,organization_id:args.organizationId,vendor_id:args.vendorId,
          description:args.description,pack_size:args.packSize,brand:args.brand,gtin:args.gtin,
          manufacturer_code:args.manufacturerCode,selling_unit:args.sellingUnit||null,
          field_resolutions:args.fieldResolutions||{},row_revision:1});
        else{
          // Update mutable fields on existing vendor item, matching what the production RPC does.
          const existing=vendors.get(id);
          vendors.set(id,{...existing,
            selling_unit:args.sellingUnit||existing.selling_unit,
            field_resolutions:args.fieldResolutions!=null?args.fieldResolutions:existing.field_resolutions,
          });
        }
        const prior=backend.pricing._priceHistory.get(id)||[];
        backend.pricing._priceHistory.set(id,[...prior,{sourceDocumentId:args.sourceDocumentId,price:args.price}]);
        return id;
      },
    },
    catalog:{async saveRow(){return{data:null,error:null};}},
    _stores:{catalogs,vendors,mappings,categories},
  };
  return backend;
}

function makeServices(backend,orgId){
  const catalogService=createCatalogService(backend);
  const importService={
    async mapping(organizationId,vendorItemId){
      return[...backend._stores.mappings.values()].find(m=>m.organization_id===organizationId&&m.vendor_item_id===vendorItemId)||null;
    },
    async createMapping(data){
      const id=uuid();
      backend._stores.mappings.set(id,{id,...data});
      return{id,...data};
    },
  };
  return{catalogService,importService};
}

// Pack "4/10 LB" parses cleanly; sellingUnit "LB" resolves the quote basis explicitly
// so requiresReview:false and applyQuote is called (not the needsBasis bypass).
function seed(backend,orgId,vendorId){
  const catId=uuid();const catItemId=uuid();const vendorItemId=uuid();const mappingId=uuid();
  backend._stores.categories.set(catId,{id:catId,organization_id:orgId,name:"Produce",is_holding_pen:false,range_start:9000,range_end:10999});
  backend._stores.catalogs.set(catItemId,{id:catItemId,organization_id:orgId,category_id:catId,
    name:"Romaine Lettuce",master_item_number:9001,matching_behavior:"flexible",comparison_mode:"alternatives",
    brand_locked:false,category_review:true,category_reason:null});
  backend._stores.vendors.set(vendorItemId,{id:vendorItemId,organization_id:orgId,vendor_id:vendorId,
    description:"Romaine Lettuce",pack_size:"4/10 LB",brand:null,gtin:null,manufacturer_code:null,
    selling_unit:"LB",vendor_item_code:"ROM-LB",price_basis:"LB",price_source:"price_list",
    field_resolutions:{},row_revision:1,import_row:null});
  backend._stores.mappings.set(mappingId,{id:mappingId,organization_id:orgId,
    catalog_item_id:catItemId,vendor_item_id:vendorItemId,comparison_track:"review",confidence_score:55,match_method:"rule_based"});
  return{catId,catItemId,vendorItemId,mappingId};
}

function run(label,fn){
  try{
    const p=fn();
    if(p&&typeof p.then==="function"){
      return p.then(()=>console.log(`  ✓  ${label}`),e=>{console.error(`  ✗  ${label}: ${e.message}`);process.exitCode=1;});
    }
    console.log(`  ✓  ${label}`);
  }catch(e){console.error(`  ✗  ${label}: ${e.message}`);process.exitCode=1;}
}

// Runs importPriceRow for a price-update reimport of an existing vendor item.
// sellingUnit:"LB" forces resolveQuoteBasis to resolve explicitly, so requiresReview:false
// and applyQuote is called via the normal path (not the needsBasis bypass).
// opts.rowOverrides and opts.applySelectedCategory let individual tests customize.
async function reimport(backend,{orgId,vendorId,vendorItemId,mappingId,catalogService,importService},opts={}){
  const ex=backend._stores.vendors.get(vendorItemId);
  const priorMapping=backend._stores.mappings.get(mappingId);
  const rowBase={
    code:ex.vendor_item_code,
    description:ex.description,
    price:1.50,
    packSize:ex.pack_size,
    sellingUnit:"LB",
    priceUnavailable:false,
  };
  return importPriceRow({
    backend,importService,catalogService,
    sourceRow:{code:ex.vendor_item_code,description:ex.description,price:"1.50",sellingUnit:"LB"},
    row:{...rowBase,...(opts.rowOverrides||{})},
    ex,priorMapping,rowIssues:[],rowNeedsReview:false,invoiceSources:[],
    orgId,vendorId,sourceDocumentId:"doc-2",completedKey:ex.vendor_item_code,
    importBatchTime:new Date().toISOString(),group:{name:"Next week sheet",quoteValidUntil:null},
    sourceFilePath:null,
    workingCatalogItems:[...backend._stores.catalogs.values()],
    workingCategories:[...backend._stores.categories.values()],
    workingVendorItems:[...backend._stores.vendors.values()],
    workingMappings:[...backend._stores.mappings.values()],
    applySelectedCategory:opts.applySelectedCategory||null,
  });
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ORG="org-1";const VENDOR="v-1";const USER="u-1";

console.log("\nModule E · Reimport Persistence tests\n");

// 1. Manual confirmations survive reimport (checklist item 1)
//    + vendor link and price history preserved (checklist item 2)
//    + KERDOS item number permanent (checklist item 3)
//
//    Exercises the normal import path (requiresReview:false, applyQuote called).
//    Pre-seeds a prior price history entry (doc-1) and verifies that after a
//    reimport (doc-2), the prior entry survives alongside the new one.
run("manually confirmed mapping survives reimport — track, method, vendor link, item number, and price history preserved", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const masterItemNumberBefore=backend._stores.catalogs.get(catItemId).master_item_number;
  // Simulate prior manual confirmation.
  backend._stores.mappings.set(mappingId,{
    ...backend._stores.mappings.get(mappingId),
    comparison_track:"exact",confidence_score:100,match_method:"manual",
  });
  // Simulate prior price history from an earlier import (doc-1).
  backend.pricing._priceHistory.set(vendorItemId,[{sourceDocumentId:"doc-1",price:1.40}]);

  const{catalogService,importService}=makeServices(backend,ORG);
  const result=await reimport(backend,{orgId:ORG,vendorId:VENDOR,vendorItemId,mappingId,catalogService,importService});

  // Checklist 1: manual decision fields unchanged
  const m=backend._stores.mappings.get(mappingId);
  assert.equal(m.comparison_track,"exact","comparison_track must remain 'exact' after reimport");
  assert.equal(m.confidence_score,100,"confidence_score must remain 100 after reimport");
  assert.equal(m.match_method,"manual","match_method must remain 'manual' after reimport");

  // Checklist 2: vendor item ID stable (vendor link preserved)
  assert.equal(result.vendorItemId,vendorItemId,
    "vendorItemId must be stable — the vendor link and its associated price records are keyed to it");

  // Checklist 2: price history preserved — prior entry survives, new entry added
  const history=backend.pricing._priceHistory.get(vendorItemId)||[];
  assert.ok(history.some(e=>e.sourceDocumentId==="doc-1"),"prior price history entry (doc-1) must survive reimport");
  assert.ok(history.some(e=>e.sourceDocumentId==="doc-2"),"new price quote (doc-2) must be recorded after reimport");
  assert.equal(history.length,2,"price history must have exactly 2 entries: prior + reimport");

  // Checklist 3: KERDOS item number permanent
  const ci=backend._stores.catalogs.get(catItemId);
  assert.equal(ci.master_item_number,masterItemNumberBefore,"master_item_number must not change on reimport");
});

// 2. A remapped mapping retains its catalog_item_id on reimport (checklist items 1, 2, 3)
//    After the client uses Remap to point a vendor item at a different catalog item,
//    the next price-sheet import must not re-evaluate the destination, and the new
//    catalog item's master_item_number must stay permanent.
run("remapped mapping retains catalog_item_id and master_item_number on reimport", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  // Simulate a prior remap to a different catalog item.
  const remappedItemId=uuid();
  const remappedMasterNumber=9002;
  backend._stores.catalogs.set(remappedItemId,{id:remappedItemId,organization_id:ORG,
    name:"Romaine Hearts",category_id:null,master_item_number:remappedMasterNumber,
    matching_behavior:"flexible",comparison_mode:"alternatives",brand_locked:false,
    category_review:true,category_reason:null});
  backend._stores.mappings.set(mappingId,{
    ...backend._stores.mappings.get(mappingId),
    catalog_item_id:remappedItemId,
    comparison_track:"exact",confidence_score:100,match_method:"manual",
  });
  const{catalogService,importService}=makeServices(backend,ORG);
  await reimport(backend,{orgId:ORG,vendorId:VENDOR,vendorItemId,mappingId,catalogService,importService});
  const m=backend._stores.mappings.get(mappingId);

  // Checklist 1 + 2: mapping destination unchanged
  assert.equal(m.catalog_item_id,remappedItemId,
    "catalog_item_id must remain the remapped destination after reimport");
  assert.notEqual(m.catalog_item_id,catItemId,
    "catalog_item_id must not revert to the original catalog item");

  // Checklist 3: KERDOS item number permanent on the remapped destination
  const ci=backend._stores.catalogs.get(remappedItemId);
  assert.equal(ci.master_item_number,remappedMasterNumber,"remapped item's master_item_number must not change on reimport");
});

// 3. A rejected mapping retains its standalone catalog item on reimport (checklist items 1, 2, 3)
//    After the client rejects a mapping (match_method:"rejected"), the next
//    price-sheet import must not re-run matchOrCreate — the standalone catalog
//    item and its item number stay intact.
run("rejected mapping retains standalone catalog item and its master_item_number on reimport", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService,importService}=makeServices(backend,ORG);
  await catalogService.rejectMapping(mappingId,1,{organizationId:ORG,expectedCatalogItemId:catItemId});
  const standaloneId=backend._stores.mappings.get(mappingId).catalog_item_id;
  assert.notEqual(standaloneId,catItemId,"rejectMapping must have created a standalone item");
  const standaloneMasterNumber=backend._stores.catalogs.get(standaloneId).master_item_number;

  let matchOrCreateCalled=false;
  const spyCatalogService={
    ...catalogService,
    matchOrCreate(){matchOrCreateCalled=true;return catalogService.matchOrCreate.apply(catalogService,arguments);},
  };
  await reimport(backend,{orgId:ORG,vendorId:VENDOR,vendorItemId,mappingId,catalogService:spyCatalogService,importService});

  // Checklist 1: rejected decision not overridden
  assert.equal(matchOrCreateCalled,false,"matchOrCreate must not be called when existingMapping is found on reimport");
  const m=backend._stores.mappings.get(mappingId);
  assert.equal(m.catalog_item_id,standaloneId,"standalone catalog item must be retained after reimport");
  assert.equal(m.match_method,"rejected","match_method:'rejected' must be retained after reimport");

  // Checklist 3: item number on the standalone item permanent
  const ci=backend._stores.catalogs.get(standaloneId);
  assert.equal(ci.master_item_number,standaloneMasterNumber,"standalone item's master_item_number must not change on reimport");
});

// 4. Corrections survive reimport — no regression (checklist item 4)
//    Two representative corrections, both exercised through the production path:
//
//    a) A manual field correction in field_resolutions (selling_unit:"LB" corrected
//       via the client) must survive reimport. importResolutions spreads
//       prior.field_resolutions first; the in-memory applyQuote writes it back,
//       matching the production RPC. The test verifies the correction is not wiped.
//
//    b) A confirmed category (category_review:false, category_reason:"confirmed")
//       must not be reset. The test also exercises the ImportModal production path:
//       row.categoryId + applySelectedCategory are passed, reaching the
//       "else if (applySelectedCategory && row.categoryId)" branch in importPriceRow
//       (line 182-184). The callback is called, but the confirmed flags must survive.
run("confirmed category and manual field correction both survive reimport — ImportModal applySelectedCategory path exercised", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catId,catItemId,vendorItemId,mappingId}=seed(backend,ORG,VENDOR);

  // Simulate a prior category confirmation on the catalog item.
  backend._stores.catalogs.set(catItemId,{
    ...backend._stores.catalogs.get(catItemId),
    category_review:false,category_reason:"confirmed",
  });

  // Simulate a prior manual field correction: client corrected selling_unit to "LB"
  // (recorded in field_resolutions so it survives field-content changes).
  // importResolutions spreads prior.field_resolutions, so "LB" must survive.
  backend._stores.vendors.set(vendorItemId,{
    ...backend._stores.vendors.get(vendorItemId),
    field_resolutions:{selling_unit:"LB"},
  });

  // Track applySelectedCategory calls — exercises the ImportModal path (line 182-184
  // of import-price-row.js): "else if (applySelectedCategory && row.categoryId)".
  const applySelectedCategoryCalls=[];
  const applySelectedCategory=async(catalogItemId,categoryId)=>{
    applySelectedCategoryCalls.push({catalogItemId,categoryId});
  };

  const{catalogService,importService}=makeServices(backend,ORG);
  await reimport(
    backend,{orgId:ORG,vendorId:VENDOR,vendorItemId,mappingId,catalogService,importService},
    {
      rowOverrides:{categoryId:catId},
      applySelectedCategory,
    }
  );

  // b) Production ImportModal path: applySelectedCategory was called with the existing
  //    mapping's catalog_item_id (not a new item ID).
  assert.ok(applySelectedCategoryCalls.length>0,
    "applySelectedCategory must be called when row.categoryId and callback are provided");
  assert.ok(applySelectedCategoryCalls.every(c=>c.catalogItemId===catItemId),
    "applySelectedCategory must be called with the existing (confirmed) catalog item ID");

  // b) Confirmed category not reset despite applySelectedCategory being called.
  const ci=backend._stores.catalogs.get(catItemId);
  assert.equal(ci.category_review,false,"category_review must remain false after reimport");
  assert.equal(ci.category_reason,"confirmed","category_reason must remain 'confirmed' after reimport");

  // a) Manual field correction preserved: importResolutions spreads prior.field_resolutions,
  //    so selling_unit:"LB" survives the applyQuote write-back in the in-memory backend.
  const vi=backend._stores.vendors.get(vendorItemId);
  assert.ok(vi.field_resolutions,"field_resolutions must exist after reimport");
  assert.equal(vi.field_resolutions.selling_unit,"LB",
    "manual selling_unit correction must survive reimport — importResolutions preserves prior.field_resolutions");
});

console.log("\nAll Module E · Reimport Persistence tests done.\n");
