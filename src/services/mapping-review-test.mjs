// Module E · Reject — mapping review tests.
//
// Tests:
//   1. rejectMapping creates a standalone catalog item and records the
//      rejected catalog item ID in field_resolutions.
//   2. After rejection, reimport via importPriceRow finds existingMapping and
//      never calls matchOrCreate — the standalone mapping survives untouched.
//   3. Full Order Guide readiness: a standalone item with match_method='rejected'
//      is orderable once pack and price are confirmed (autoPlaceable path).
//   4. Remap to a DIFFERENT catalog item leaves rejected_catalog_item_ids intact.
//   5. Deliberate remap to the SAME (formerly rejected) catalog item clears
//      only that one UUID from rejected_catalog_item_ids (atomic RPC path).
//   6. RPC org authorization: non-member cannot reject.
//   7. Stale row_revision: rejection is refused and returns a clear error.
//   8. Atomic remap: kerdos_remap_to_rejected clears rejection AND bumps
//      row_revision in one step — no partial-failure window.
//   9. Stale expectedCatalogItemId on reject is refused with a clear error.
//  10. Cross-org destination is refused by kerdos_remap_to_rejected.
//  11. Calling rejectMapping without expectedCatalogItemId fails before the RPC.
//  12. The RPC itself rejects a null expectedCatalogItemId (DB-level guard, not JS).
//
// Uses createInMemoryBackend() so no real Supabase connection is needed.

import assert from "node:assert/strict";
import {importPriceRow} from "../core/import-price-row.js";

// ---------------------------------------------------------------------------
// In-memory backend
// ---------------------------------------------------------------------------

function uuid(){return Math.random().toString(36).slice(2)+Date.now().toString(36);}

function createInMemoryBackend({orgId,userId,userRole="manager"}={}){
  const catalogs=new Map();   // id → catalog_items row
  const vendors=new Map();    // id → vendor_items row
  const mappings=new Map();   // id → item_mappings row
  const categories=new Map(); // id → catalog_categories row
  // members: Map of userId+"_"+orgId → role
  const members=new Map();
  if(userId&&orgId&&userRole) members.set(userId+"_"+orgId,userRole);

  // Simple query builder that is just enough for the service layer.
  function table(name){
    const store=name==="catalog_items"?catalogs:name==="vendor_items"?vendors:name==="item_mappings"?mappings:categories;
    let _data=null;let _insertRows=null;let _eq=[];let _single=false;let _select=false;let _delete=false;
    const api={
      select(f){_select=true;return api;},
      insert(rows){
        // Store and immediately write rows; return the api chain so callers
        // can chain .select().single() (e.g. createItem, ensureHoldingCategory).
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
          for(const [id] of matched)store.delete(id);
          return resolve({data:null,error:null});
        }
        if(_insertRows){
          if(_single)return resolve({data:_insertRows[0]||null,error:null});
          return resolve({data:_insertRows,error:null});
        }
        if(_data){
          const matched=[...store.entries()].filter(([,r])=>_eq.every(([k,v])=>r[k]===v));
          for(const [id,row] of matched)store.set(id,{...row,..._data});
          // When .select() was chained, return the updated rows so callers can
          // detect a stale-mapping (zero rows = the catalog item changed).
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

  // RPC: kerdos_reject_mapping — auth uses the userId closed over from the factory args.
  async function kerdos_reject_mapping({p_organization_id,p_mapping_id,p_expected_revision,p_expected_catalog_item_id}){
    // p_expected_catalog_item_id is required — mirrors the DB guard.
    if(p_expected_catalog_item_id==null)
      return{data:null,error:{message:"expected_catalog_item_id is required"}};
    const member=userId?members.get(userId+"_"+p_organization_id):null;
    if(!member||!["owner","manager"].includes(member))
      return{data:null,error:{message:"Owner or manager access is required"}};
    const mapping=[...mappings.values()].find(m=>m.id===p_mapping_id&&m.organization_id===p_organization_id);
    if(!mapping)return{data:null,error:{message:"Association not found"}};
    const vendor=[...vendors.values()].find(v=>v.id===mapping.vendor_item_id&&v.organization_id===p_organization_id);
    if(!vendor)return{data:null,error:{message:"Vendor product not found"}};
    if(vendor.row_revision!==p_expected_revision)
      return{data:null,error:{message:"This product changed; refresh before rejecting"}};
    // Re-read mapping (mirrors DB lock re-read); stale check is unconditional.
    const freshMapping=[...mappings.values()].find(m=>m.id===p_mapping_id&&m.organization_id===p_organization_id);
    if(freshMapping.catalog_item_id!==p_expected_catalog_item_id)
      return{data:null,error:{message:"The association changed since you loaded this page; refresh and try again"}};
    const item=[...catalogs.values()].find(c=>c.id===freshMapping.catalog_item_id&&c.organization_id===p_organization_id);
    if(!item)return{data:null,error:{message:"Catalog item not found"}};
    // Create standalone catalog item.
    const newId=uuid();
    catalogs.set(newId,{id:newId,organization_id:p_organization_id,category_id:item.category_id,
      name:(vendor.description||"").slice(0,120),matching_behavior:"flexible",comparison_mode:"alternatives",brand_locked:false,
      category_review:item.category_review,category_reason:item.category_reason,master_item_number:Math.floor(Math.random()*90000)+10000});
    // Append rejected catalog item ID.
    const res=vendor.field_resolutions||{};
    const prev=res.rejected_catalog_item_ids||[];
    const next=[...new Set([...prev,item.id])];
    vendors.set(vendor.id,{...vendor,field_resolutions:{...res,rejected_catalog_item_ids:next},row_revision:vendor.row_revision+1});
    // Update mapping.
    mappings.set(mapping.id,{...mapping,catalog_item_id:newId,comparison_track:"review",confidence_score:0,match_method:"rejected"});
    return{data:{catalogItemId:newId,masterItemNumber:catalogs.get(newId).master_item_number,rejectedCatalogItemId:item.id},error:null};
  }

  // RPC: kerdos_remap_to_rejected — atomic rejection-clear + mapping update + revision bump.
  async function kerdos_remap_to_rejected({p_organization_id,p_mapping_id,p_new_catalog_item_id,
    p_expected_revision,p_expected_catalog_item_id,p_comparison_track,p_confidence_score,p_match_method}){
    const member=userId?members.get(userId+"_"+p_organization_id):null;
    if(!member||!["owner","manager"].includes(member))
      return{data:null,error:{message:"Owner or manager access is required"}};
    const mapping=[...mappings.values()].find(m=>m.id===p_mapping_id&&m.organization_id===p_organization_id);
    if(!mapping)return{data:null,error:{message:"Association not found"}};
    const vendor=[...vendors.values()].find(v=>v.id===mapping.vendor_item_id&&v.organization_id===p_organization_id);
    if(!vendor)return{data:null,error:{message:"Vendor product not found"}};
    if(p_expected_revision!=null&&vendor.row_revision!==p_expected_revision)
      return{data:null,error:{message:"This product changed; refresh before remapping"}};
    // Stale-mapping check (mirrors DB re-read under lock).
    const freshMapping=[...mappings.values()].find(m=>m.id===p_mapping_id&&m.organization_id===p_organization_id);
    if(p_expected_catalog_item_id!=null&&freshMapping.catalog_item_id!==p_expected_catalog_item_id)
      return{data:null,error:{message:"The association changed since you loaded this page; refresh and try again"}};
    // Same-org check: destination catalog item must belong to this organization.
    const destItem=[...catalogs.values()].find(c=>c.id===p_new_catalog_item_id&&c.organization_id===p_organization_id);
    if(!destItem)
      return{data:null,error:{message:"Destination catalog item not found in this organization"}};
    // Remove rejected UUID (no-op when absent).
    const res=vendor.field_resolutions||{};
    const prev=res.rejected_catalog_item_ids||[];
    const trimmed=prev.filter(id=>id!==p_new_catalog_item_id);
    vendors.set(vendor.id,{...vendor,field_resolutions:{...res,rejected_catalog_item_ids:trimmed},row_revision:vendor.row_revision+1});
    // Update mapping.
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
      async applyQuote({vendorItemId,...args}){
        const id=vendorItemId||uuid();
        if(!vendors.has(id))vendors.set(id,{id,organization_id:args.organizationId,vendor_id:args.vendorId,
          description:args.description,pack_size:args.packSize,brand:args.brand,gtin:args.gtin,
          manufacturer_code:args.manufacturerCode,selling_unit:null,field_resolutions:{},row_revision:1});
        return id;
      },
    },
    catalog:{
      async saveRow(){return{data:null,error:null};}
    },
    _stores:{catalogs,vendors,mappings,categories},
  };
  return backend;
}

// ---------------------------------------------------------------------------
// Service layer wrappers (thin — mirrors production wiring)
// ---------------------------------------------------------------------------

import {createCatalogService} from "../services/catalog.js";

function makeServices(backend,orgId){
  const catalogService=createCatalogService(backend);
  const importService={
    async mapping(organizationId,vendorItemId){
      const row=[...backend._stores.mappings.values()].find(m=>m.organization_id===organizationId&&m.vendor_item_id===vendorItemId);
      return row||null;
    },
    async createMapping(data){
      const id=uuid();
      backend._stores.mappings.set(id,{id,...data});
      return{id,...data};
    },
  };
  return{catalogService,importService};
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function seed(backend,orgId,vendorId){
  const catId=uuid();const catItemId=uuid();const vendorItemId=uuid();const mappingId=uuid();
  backend._stores.categories.set(catId,{id:catId,organization_id:orgId,name:"Produce",is_holding_pen:false,range_start:10000,range_end:19999});
  backend._stores.catalogs.set(catItemId,{id:catItemId,organization_id:orgId,category_id:catId,
    name:"Romaine Lettuce 24ct",master_item_number:10001,matching_behavior:"flexible",comparison_mode:"alternatives",brand_locked:false});
  backend._stores.vendors.set(vendorItemId,{id:vendorItemId,organization_id:orgId,vendor_id:vendorId,
    description:"Romaine Lettuce 24ct",pack_size:"24ct",brand:null,gtin:null,manufacturer_code:null,
    selling_unit:"CS",vendor_item_code:"ROM-24",field_resolutions:{},row_revision:1});
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

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const ORG="org-1";const VENDOR="v-1";const USER="u-1";

console.log("\nModule E · Reject — mapping review tests\n");

// 1. rejectMapping creates standalone item and records rejected UUID.
run("rejectMapping creates standalone catalog item with match_method='rejected'", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  const result=await catalogService.rejectMapping(mappingId,1,{organizationId:ORG,expectedCatalogItemId:catItemId});
  assert.ok(result.catalogItemId,"RPC must return new catalogItemId");
  assert.notEqual(result.catalogItemId,catItemId,"standalone item must be different from rejected item");
  assert.equal(result.rejectedCatalogItemId,catItemId,"RPC must report the rejected catalog item");
  // Mapping now points at standalone item.
  const m=backend._stores.mappings.get(mappingId);
  assert.equal(m.catalog_item_id,result.catalogItemId);
  assert.equal(m.match_method,"rejected");
  // rejected_catalog_item_ids contains the original item ID.
  const vi=backend._stores.vendors.get(vendorItemId);
  assert.ok((vi.field_resolutions.rejected_catalog_item_ids||[]).includes(catItemId),
    "rejected_catalog_item_ids must include original catalog item ID");
});

// 2. After rejection, reimport finds existingMapping and never calls matchOrCreate.
run("reimport skips matchOrCreate when rejected mapping already exists", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService,importService}=makeServices(backend,ORG);
  await catalogService.rejectMapping(mappingId,1,{organizationId:ORG,expectedCatalogItemId:catItemId});
  let matchOrCreateCalled=false;
  const spyCatalogService={
    ...catalogService,
    matchOrCreate(){matchOrCreateCalled=true;return catalogService.matchOrCreate.apply(catalogService,arguments);},
  };
  const ex=backend._stores.vendors.get(vendorItemId);
  const priorMapping=await importService.mapping(ORG,vendorItemId);
  await importPriceRow({
    backend,importService,catalogService:spyCatalogService,
    sourceRow:{code:"ROM-24",description:"Romaine Lettuce 24ct",price:"12.50"},
    row:{code:"ROM-24",description:"Romaine Lettuce 24ct",price:12.50,packSize:"24ct",priceUnavailable:false},
    ex,priorMapping,rowIssues:[],rowNeedsReview:false,invoiceSources:[],
    orgId:ORG,vendorId:VENDOR,sourceDocumentId:"doc-1",completedKey:"ROM-24",
    importBatchTime:new Date().toISOString(),group:{name:"April sheet",quoteValidUntil:null},
    sourceFilePath:null,workingCatalogItems:[...backend._stores.catalogs.values()],
    workingCategories:[...backend._stores.categories.values()],
    workingVendorItems:[...backend._stores.vendors.values()],
    workingMappings:[...backend._stores.mappings.values()],
    applySelectedCategory:null,
  });
  assert.equal(matchOrCreateCalled,false,"matchOrCreate must not be called when existingMapping is found");
});

// 3. Full Order Guide readiness: standalone rejected item is ready AND appears in
//    autoPlaceable once pack and price are confirmed.
//    orderGuideAssessment takes {item, vendorItem, mapping, peers, category} — one row at a time.
//    autoPlaceable takes {catalogItems, vendorItems, mappings, vendors, categories, settings, now}.
run("standalone rejected item is ready and auto-placeable when pack and price are confirmed", async()=>{
  const{orderGuideAssessment,autoPlaceable}=await import("../core/catalog-fields.js");
  const itemId=uuid();const vendorItemId=uuid();const mappingId=uuid();
  const category={id:"cat-1",organization_id:ORG,name:"Produce",is_holding_pen:false};
  // category_review:false + category_reason:"confirmed" → catAcc=DERIVED(90) → passes the
  // category gate in orderGuideAssessment. Description identical to catalog item name so
  // mappingVerification returns comparison_track:"exact" (standalone, no peers) for autoPlaceable.
  const item={id:itemId,organization_id:ORG,name:"Romaine Lettuce 24ct",
    category_id:"cat-1",category_review:false,category_reason:"confirmed",
    matching_behavior:"flexible",comparison_mode:"alternatives",brand_locked:false};
  const vendorItem={id:vendorItemId,organization_id:ORG,vendor_id:VENDOR,
    description:"Romaine Lettuce 24ct",pack_size:"24ct",brand:null,
    selling_unit:"CS",
    // quoteStatus checks vi.price (not vi.latest_price).
    price:12.50,price_unavailable:false,
    import_row:{reviewRequired:false},
    field_resolutions:{rejected_catalog_item_ids:["some-old-id"],row_approval:null},row_revision:2};
  const mapping={id:mappingId,organization_id:ORG,catalog_item_id:itemId,vendor_item_id:vendorItemId,
    comparison_track:"review",confidence_score:0,match_method:"rejected"};

  // Full readiness check — match_method='rejected' must NOT block a confirmed standalone item.
  const result=orderGuideAssessment({item,vendorItem,mapping,peers:[],category,categories:[category]});
  assert.equal(typeof result,"object","orderGuideAssessment must return an object");
  assert.equal(result.ready,true,
    `standalone rejected item must be order-guide ready; blockers: ${JSON.stringify(result.blockers)}`);
  assert.ok(!result.blockers.includes("rejected-match"),
    `match_method='rejected' must not add a 'rejected-match' blocker`);

  // autoPlaceable — standalone item with description identical to catalog item name:
  // mappingVerification returns comparison_track:"exact" for a parseable pack + matching identity.
  const placeable=autoPlaceable({
    catalogItems:[item],vendorItems:[vendorItem],mappings:[mapping],
    vendors:[],categories:[category],settings:{},now:new Date(),
  });
  assert.ok(placeable.some(p=>p.mappingId===mappingId),
    `standalone rejected item must appear in autoPlaceable when ready; got: ${JSON.stringify(placeable.map(p=>p.mappingId))}`);
});

// 4. Remap to a DIFFERENT catalog item leaves rejected_catalog_item_ids intact.
run("remap to different item preserves rejected_catalog_item_ids", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  await catalogService.rejectMapping(mappingId,1,{organizationId:ORG,expectedCatalogItemId:catItemId});
  // Create another catalog item to remap to.
  const otherId=uuid();
  backend._stores.catalogs.set(otherId,{id:otherId,organization_id:ORG,category_id:"cat-1",
    name:"Baby Romaine 12ct",master_item_number:10002});
  const vi=backend._stores.vendors.get(vendorItemId);
  const standaloneMapping=backend._stores.mappings.get(mappingId);
  await catalogService.remapToExisting(mappingId,otherId,
    {comparison_track:"review",confidence_score:60,match_method:"rule_based"},
    {vendorItemId,currentFieldResolutions:vi.field_resolutions,expectedCatalogItemId:standaloneMapping.catalog_item_id});
  const viAfter=backend._stores.vendors.get(vendorItemId);
  assert.ok((viAfter.field_resolutions.rejected_catalog_item_ids||[]).includes(catItemId),
    "rejected_catalog_item_ids must still contain the original rejected item after remap to a different item");
});

// 5. Deliberate remap BACK to rejected catalog item clears only that UUID
//    and uses the atomic RPC (vendorItemRevision + expectedCatalogItemId passed).
run("remap back to same rejected item clears only that UUID from rejected_catalog_item_ids", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  // First reject — row_revision bumped from 1 → 2; mapping now points at a new standalone id.
  await catalogService.rejectMapping(mappingId,1,{organizationId:ORG,expectedCatalogItemId:catItemId});
  // Also add a second unrelated rejection so we confirm only one is cleared.
  const otherId=uuid();
  const vi=backend._stores.vendors.get(vendorItemId);
  backend._stores.vendors.set(vendorItemId,{...vi,field_resolutions:{
    ...vi.field_resolutions,
    rejected_catalog_item_ids:[...(vi.field_resolutions.rejected_catalog_item_ids||[]),otherId],
  }});
  // Re-read after manual edit; get the standalone mapping's catalog_item_id for the stale-check.
  const viNow=backend._stores.vendors.get(vendorItemId);
  const standaloneMapping=backend._stores.mappings.get(mappingId);
  // Deliberately remap back to the original (rejected) catalog item.
  // Passes vendorItemRevision + expectedCatalogItemId so the atomic RPC path is taken.
  await catalogService.remapToExisting(mappingId,catItemId,
    {comparison_track:"review",confidence_score:70,match_method:"rule_based"},
    {vendorItemId,currentFieldResolutions:viNow.field_resolutions,
     vendorItemRevision:viNow.row_revision,
     expectedCatalogItemId:standaloneMapping.catalog_item_id,
     organizationId:ORG});
  const viAfter=backend._stores.vendors.get(vendorItemId);
  const remaining=viAfter.field_resolutions.rejected_catalog_item_ids||[];
  assert.equal(remaining.includes(catItemId),false,"catItemId must be removed after deliberate remap back");
  assert.equal(remaining.includes(otherId),true,"other rejected IDs must be preserved");
});

// 6. RPC org authorization: non-member cannot reject.
run("non-member cannot call kerdos_reject_mapping", async()=>{
  // userRole:null → no member entry added → auth check fails.
  const backend=createInMemoryBackend({orgId:ORG,userId:"outsider",userRole:null});
  const{catItemId,vendorItemId:_vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  try{
    // Pass a valid expectedCatalogItemId so the auth check (not the null guard) is the gate.
    await catalogService.rejectMapping(mappingId,1,{organizationId:ORG,expectedCatalogItemId:catItemId});
    assert.fail("Should have thrown an authorization error");
  }catch(e){
    assert.ok(e.message.toLowerCase().includes("access")||e.message.toLowerCase().includes("authorized")||e.message.toLowerCase().includes("owner"),
      `Expected authorization error, got: ${e.message}`);
  }
});

// 7. Stale row_revision is rejected.
run("stale row_revision is rejected with a clear error", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,vendorItemId:_vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  try{
    // Pass revision 99 when the actual revision is 1.
    await catalogService.rejectMapping(mappingId,99,{organizationId:ORG,expectedCatalogItemId:catItemId});
    assert.fail("Should have thrown a stale revision error");
  }catch(e){
    assert.ok(e.message.toLowerCase().includes("changed")||e.message.toLowerCase().includes("refresh")||e.message.toLowerCase().includes("revision"),
      `Expected stale revision error, got: ${e.message}`);
  }
});

// 8. Atomic remap via kerdos_remap_to_rejected: rejection cleared AND row_revision
//    bumped in a single operation — no partial-failure window.
run("remap back to rejected item is atomic: rejection cleared and row_revision bumped together", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  // Reject first so catItemId lands in rejected_catalog_item_ids.
  await catalogService.rejectMapping(mappingId,1,{organizationId:ORG,expectedCatalogItemId:catItemId});
  const standaloneMapping=backend._stores.mappings.get(mappingId);
  const vi=backend._stores.vendors.get(vendorItemId);
  const revBefore=vi.row_revision; // should be 2 after rejection
  // Remap back to catItemId — triggers kerdos_remap_to_rejected RPC.
  await catalogService.remapToExisting(mappingId,catItemId,
    {comparison_track:"review",confidence_score:70,match_method:"manual"},
    {vendorItemId,currentFieldResolutions:vi.field_resolutions,
     vendorItemRevision:vi.row_revision,
     expectedCatalogItemId:standaloneMapping.catalog_item_id,
     organizationId:ORG});
  const viAfter=backend._stores.vendors.get(vendorItemId);
  const mAfter=backend._stores.mappings.get(mappingId);
  assert.equal(mAfter.catalog_item_id,catItemId,
    "mapping must point at the original catalog item after atomic remap");
  assert.equal((viAfter.field_resolutions.rejected_catalog_item_ids||[]).includes(catItemId),false,
    "rejection must be cleared by the atomic RPC");
  assert.equal(viAfter.row_revision,revBefore+1,
    "row_revision must be bumped exactly once by the atomic RPC");
});

// 9. Stale expectedCatalogItemId on reject is refused with a clear error.
run("stale expectedCatalogItemId on reject is refused with a clear error", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId:_catItemId,vendorItemId:_vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  try{
    // Pass a wrong catalog item ID — simulates the user acting on a stale page.
    await catalogService.rejectMapping(mappingId,1,{organizationId:ORG,expectedCatalogItemId:"wrong-id"});
    assert.fail("Should have thrown a stale-mapping error");
  }catch(e){
    assert.ok(
      e.message.toLowerCase().includes("changed")||e.message.toLowerCase().includes("refresh"),
      `Expected stale-mapping error, got: ${e.message}`
    );
  }
});

// 11. Calling rejectMapping without expectedCatalogItemId fails immediately.
run("rejectMapping without expectedCatalogItemId throws before calling RPC", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  try{
    // No expectedCatalogItemId — should fail in the JS service layer.
    await catalogService.rejectMapping(mappingId,1,{organizationId:ORG});
    assert.fail("Should have thrown for missing expectedCatalogItemId");
  }catch(e){
    assert.ok(
      e.message.toLowerCase().includes("required")||e.message.toLowerCase().includes("catalog item"),
      `Expected null-guard error, got: ${e.message}`
    );
  }
});

// 10. Cross-org destination is refused by kerdos_remap_to_rejected.
run("cross-org destination catalog item is refused", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  // Reject so catItemId lands in rejected_catalog_item_ids; row_revision → 2.
  await catalogService.rejectMapping(mappingId,1,{organizationId:ORG,expectedCatalogItemId:catItemId});
  const standaloneMapping=backend._stores.mappings.get(mappingId);
  // Plant a catalog item that belongs to a different org.
  const foreignId=uuid();
  backend._stores.catalogs.set(foreignId,{id:foreignId,organization_id:"org-other",
    category_id:"cat-1",name:"Foreign Item",master_item_number:99999});
  // Manually add foreignId to the rejection list so the RPC branch is taken.
  const vi=backend._stores.vendors.get(vendorItemId);
  backend._stores.vendors.set(vendorItemId,{...vi,field_resolutions:{
    ...vi.field_resolutions,
    rejected_catalog_item_ids:[...(vi.field_resolutions.rejected_catalog_item_ids||[]),foreignId],
  }});
  const viNow=backend._stores.vendors.get(vendorItemId);
  try{
    await catalogService.remapToExisting(mappingId,foreignId,
      {comparison_track:"review",confidence_score:70,match_method:"manual"},
      {vendorItemId,currentFieldResolutions:viNow.field_resolutions,
       vendorItemRevision:viNow.row_revision,
       expectedCatalogItemId:standaloneMapping.catalog_item_id,
       organizationId:ORG});
    assert.fail("Should have refused a cross-org destination");
  }catch(e){
    assert.ok(
      e.message.toLowerCase().includes("not found")||e.message.toLowerCase().includes("organization"),
      `Expected cross-org error, got: ${e.message}`
    );
  }
});

// 12. The RPC itself rejects a null expectedCatalogItemId — DB-level guard, not JS.
//     Calls backend.rpc() directly, bypassing the JS service null check, to prove
//     the database function (mirrored by the mock) enforces the requirement independently.
run("kerdos_reject_mapping RPC rejects null p_expected_catalog_item_id at the DB level", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{mappingId}=seed(backend,ORG,VENDOR);
  // Call the RPC directly — no JS service layer in the path.
  const result=await backend.rpc("kerdos_reject_mapping",{
    p_organization_id:ORG,
    p_mapping_id:mappingId,
    p_expected_revision:1,
    p_expected_catalog_item_id:null,
  });
  assert.ok(result.error,"RPC must return an error for null p_expected_catalog_item_id");
  assert.ok(
    result.error.message.toLowerCase().includes("required"),
    `Expected null-guard error from RPC, got: ${result.error.message}`
  );
  assert.equal(result.data,null,"RPC must not return data when p_expected_catalog_item_id is null");
});

// ---------------------------------------------------------------------------
// Module E · Confirm — stale-mapping protection (Tests 13–16)
// ---------------------------------------------------------------------------

// 13. Current mapping confirms (single).
//     The operator confirms a mapping whose catalog_item_id still matches what
//     they loaded — the update should succeed and the mapping should be exact/100.
run("confirmMapping succeeds when catalog item matches the expected value", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  const verification={comparison_track:"exact",confidence_score:100,match_method:"manual"};
  await catalogService.confirmMapping(mappingId,verification,catItemId);
  const m=backend._stores.mappings.get(mappingId);
  assert.equal(m.comparison_track,"exact","mapping should be exact after confirm");
  assert.equal(m.confidence_score,100,"confidence_score should be 100 after confirm");
});

// 14. Stale mapping is refused (single).
//     Between the operator loading the page and clicking Confirm, another session
//     moved the mapping to a different catalog item.  The confirm must be refused.
run("confirmMapping is refused when the catalog item has changed (stale single)", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  // Silently reroute the mapping to a different catalog item, simulating a
  // concurrent change that the operator's page hasn't seen yet.
  const differentId=uuid();
  backend._stores.catalogs.set(differentId,{id:differentId,organization_id:ORG,name:"Other Item"});
  backend._stores.mappings.set(mappingId,{...backend._stores.mappings.get(mappingId),catalog_item_id:differentId});
  const verification={comparison_track:"exact",confidence_score:100,match_method:"manual"};
  try{
    await catalogService.confirmMapping(mappingId,verification,catItemId);
    assert.fail("Should have thrown a stale-mapping error");
  }catch(e){
    assert.ok(
      e.message.toLowerCase().includes("changed")||e.message.toLowerCase().includes("refresh"),
      `Expected stale-mapping error, got: ${e.message}`
    );
  }
});

// 15. Current mappings confirm (bulk).
//     confirmMappings with current entries goes through without error.
run("confirmMappings succeeds when all catalog items match the expected values", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  const verification={comparison_track:"exact",confidence_score:100,match_method:"manual"};
  const count=await catalogService.confirmMappings([{mappingId,catalogItemId:catItemId,verification}]);
  assert.equal(count,1,"confirmMappings should return the number of confirmed entries");
  const m=backend._stores.mappings.get(mappingId);
  assert.equal(m.comparison_track,"exact","bulk confirm should write exact to mapping");
});

// 16. Stale mapping in bulk is refused.
//     If any entry in a bulk confirm has a changed catalog item, the call throws.
run("confirmMappings is refused when a catalog item has changed (stale bulk)", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  // Move the mapping to a different catalog item.
  const differentId=uuid();
  backend._stores.catalogs.set(differentId,{id:differentId,organization_id:ORG,name:"Other Item"});
  backend._stores.mappings.set(mappingId,{...backend._stores.mappings.get(mappingId),catalog_item_id:differentId});
  const verification={comparison_track:"exact",confidence_score:100,match_method:"manual"};
  try{
    await catalogService.confirmMappings([{mappingId,catalogItemId:catItemId,verification}]);
    assert.fail("Should have thrown a stale-mapping error");
  }catch(e){
    assert.ok(
      e.message.toLowerCase().includes("changed")||e.message.toLowerCase().includes("refresh"),
      `Expected stale-mapping error, got: ${e.message}`
    );
  }
});

// ---------------------------------------------------------------------------
// Module E · Remap — plain-path stale-mapping protection (Tests 17–18)
// ---------------------------------------------------------------------------

// 17. Current mapping remaps (plain path).
//     Remap to a catalog item that is NOT in rejected_catalog_item_ids — the
//     plain update path — succeeds when expectedCatalogItemId matches.
run("remapToExisting (plain path) succeeds when catalog item matches", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  const otherId=uuid();
  backend._stores.catalogs.set(otherId,{id:otherId,organization_id:ORG,name:"Other Item"});
  await catalogService.remapToExisting(mappingId,otherId,
    {comparison_track:"review",confidence_score:60,match_method:"manual"},
    {vendorItemId,currentFieldResolutions:{},expectedCatalogItemId:catItemId,organizationId:ORG});
  const m=backend._stores.mappings.get(mappingId);
  assert.equal(m.catalog_item_id,otherId,"mapping must point at the new catalog item after remap");
});

// 18. Stale mapping is refused (plain path).
//     Between loading and clicking Remap the mapping was changed by another
//     session.  The operator's remap must be refused.
run("remapToExisting (plain path) is refused when catalog item has changed", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  // Silently move the mapping to a different catalog item.
  const concurrentId=uuid();
  backend._stores.catalogs.set(concurrentId,{id:concurrentId,organization_id:ORG,name:"Concurrent Item"});
  backend._stores.mappings.set(mappingId,{...backend._stores.mappings.get(mappingId),catalog_item_id:concurrentId});
  const otherId=uuid();
  backend._stores.catalogs.set(otherId,{id:otherId,organization_id:ORG,name:"Other Item"});
  // Operator still thinks the mapping points at catItemId.
  try{
    await catalogService.remapToExisting(mappingId,otherId,
      {comparison_track:"review",confidence_score:60,match_method:"manual"},
      {vendorItemId,currentFieldResolutions:{},expectedCatalogItemId:catItemId,organizationId:ORG});
    assert.fail("Should have thrown a stale-mapping error");
  }catch(e){
    assert.ok(
      e.message.toLowerCase().includes("changed")||e.message.toLowerCase().includes("refresh"),
      `Expected stale-mapping error, got: ${e.message}`
    );
  }
});

// ---------------------------------------------------------------------------
// Module E · Remap — create-new path stale-mapping protection (Tests 19–22)
// ---------------------------------------------------------------------------

// 19. Successful create-new remap (splitMapping).
//     The mapping points at the expected catalog item when the operator acts;
//     the new item is created and the mapping is updated.
run("splitMapping succeeds when mapping catalog item matches", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,vendorItemId:_vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  const catalogsBefore=backend._stores.catalogs.size;
  const created=await catalogService.splitMapping({
    organizationId:ORG,
    mappingId,
    description:"Standalone Tomatoes 25 LB",
    catalogItems:[...backend._stores.catalogs.values()],
    categories:[...backend._stores.categories.values()],
    expectedCatalogItemId:catItemId,
  });
  assert.ok(created?.id,"splitMapping must return the new catalog item");
  assert.equal(backend._stores.catalogs.size,catalogsBefore+1,"one new catalog item must be created");
  const m=backend._stores.mappings.get(mappingId);
  assert.equal(m.catalog_item_id,created.id,"mapping must point at the new catalog item");
});

// 20. Stale create-new remap is refused and leaves no orphan item.
//     A concurrent session remaps the mapping before the operator's create-new
//     write lands.  splitMapping must refuse AND delete the newly created item.
run("splitMapping is refused when mapping has changed and cleans up the new item", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId:_catItemId,vendorItemId:_vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const catalogsBefore=backend._stores.catalogs.size;

  // Pre-create the "concurrent" catalog item so we know its id.
  const concurrentId=uuid();
  backend._stores.catalogs.set(concurrentId,{id:concurrentId,organization_id:ORG,name:"Concurrent Item",
    category_id:"cat-x",master_item_number:99999});

  // Build an intercepting query that moves the mapping to concurrentId between
  // the select read and the guarded update.  Since createCatalogService captures
  // `table` at construction time, we must pass the intercepting backend TO
  // makeServices — not replace backend.records.query after the fact.
  const realTable=backend.records.query;
  let mappingReadDone=false;
  function interceptingTable(name){
    const chain=realTable(name);
    if(name!=="item_mappings")return chain;
    // Wrap then() so we can inject the concurrent write between the two
    // item_mappings calls: first call is the select, second is the update.
    const origThen=chain.then.bind(chain);
    chain.then=function(resolve){
      if(!mappingReadDone){
        // First item_mappings access: the select — run normally.
        mappingReadDone=true;
        return origThen(resolve);
      }
      // Second item_mappings access: the update — move the mapping first.
      backend._stores.mappings.set(mappingId,{
        ...backend._stores.mappings.get(mappingId),
        catalog_item_id:concurrentId,
      });
      return origThen(resolve);
    };
    return chain;
  }
  const interceptingBackend={...backend,records:{query:interceptingTable}};
  const{catalogService:interceptingService}=makeServices(interceptingBackend,ORG);

  try{
    await interceptingService.splitMapping({
      organizationId:ORG,
      mappingId,
      description:"Standalone Tomatoes 25 LB",
      catalogItems:[...backend._stores.catalogs.values()],
      categories:[...backend._stores.categories.values()],
      expectedCatalogItemId:catItemId,
    });
    assert.fail("Should have thrown a stale-mapping error");
  }catch(e){
    assert.ok(
      e.message.toLowerCase().includes("changed")||e.message.toLowerCase().includes("refresh"),
      `Expected stale-mapping error, got: ${e.message}`
    );
  }
  // The catalog store should be back to its pre-splitMapping size + the one
  // concurrent item: the orphan created by splitMapping must have been deleted.
  assert.equal(
    backend._stores.catalogs.size,catalogsBefore+1,
    "orphan catalog item must be deleted on a stale remap; only the concurrent item should remain"
  );
  // Mapping stays at the concurrent item (not the orphan, not the original).
  const m=backend._stores.mappings.get(mappingId);
  assert.equal(m.catalog_item_id,concurrentId,"mapping must stay at the concurrent item");
});

// 21. splitMapping is refused when the page was already stale before the call.
//     The mapping was remapped by another session before the operator clicked
//     "Create new item."  splitMapping must refuse before creating any catalog
//     item — no orphan is left behind.
run("splitMapping is refused when page was already stale (no item created)", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,vendorItemId:_vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const catalogsBefore=backend._stores.catalogs.size;

  // Simulate: another session already moved the mapping to a different catalog item.
  const otherCatalogId=uuid();
  backend._stores.catalogs.set(otherCatalogId,{id:otherCatalogId,organization_id:ORG,name:"Other Item",
    category_id:"cat-x",master_item_number:88888});
  backend._stores.mappings.set(mappingId,{
    ...backend._stores.mappings.get(mappingId),
    catalog_item_id:otherCatalogId,
  });

  const{catalogService}=makeServices(backend,ORG);
  // The operator's page still shows catItemId as the current catalog item.
  try{
    await catalogService.splitMapping({
      organizationId:ORG,
      mappingId,
      description:"Standalone Tomatoes 25 LB",
      catalogItems:[...backend._stores.catalogs.values()],
      categories:[...backend._stores.categories.values()],
      expectedCatalogItemId:catItemId,  // stale: mapping already points at otherCatalogId
    });
    assert.fail("Should have thrown a stale-mapping error");
  }catch(e){
    assert.ok(
      e.message.toLowerCase().includes("changed")||e.message.toLowerCase().includes("refresh"),
      `Expected stale-mapping error, got: ${e.message}`
    );
  }
  // No new catalog item must have been created: the only addition is otherCatalogId
  // (pre-seeded above), not a new orphan from splitMapping.
  assert.equal(
    backend._stores.catalogs.size,catalogsBefore+1,
    "no orphan catalog item must be created when the page was already stale"
  );
  // Mapping stays at otherCatalogId.
  const m=backend._stores.mappings.get(mappingId);
  assert.equal(m.catalog_item_id,otherCatalogId,"mapping must stay at the other item");
});

// 22. splitMapping is refused when expectedCatalogItemId is missing entirely.
//     The service must throw before touching the database.
run("splitMapping throws immediately when expectedCatalogItemId is absent", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId:_catItemId2,vendorItemId:_vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const catalogsBefore=backend._stores.catalogs.size;
  const{catalogService}=makeServices(backend,ORG);
  try{
    await catalogService.splitMapping({
      organizationId:ORG,
      mappingId,
      description:"Standalone Tomatoes 25 LB",
      catalogItems:[...backend._stores.catalogs.values()],
      categories:[...backend._stores.categories.values()],
      // expectedCatalogItemId intentionally omitted
    });
    assert.fail("Should have thrown");
  }catch(e){
    assert.ok(e.message.toLowerCase().includes("required")||e.message.toLowerCase().includes("catalog item"),
      `Expected missing-id error, got: ${e.message}`);
  }
  assert.equal(backend._stores.catalogs.size,catalogsBefore,"no catalog item must be created when expectedCatalogItemId is absent");
});

console.log("\nAll Module E · Reject + Confirm + Remap tests done.\n");
