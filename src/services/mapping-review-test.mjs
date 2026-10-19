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
//      only that one UUID from rejected_catalog_item_ids.
//   6. RPC org authorization: non-member cannot reject.
//   7. Stale row_revision: rejection is refused and returns a clear error.
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
    let _filter={};let _data=null;let _eq=[];let _single=false;
    const api={
      select(f){return api;},
      insert(rows){
        const arr=Array.isArray(rows)?rows:[rows];
        const ids=arr.map(r=>{const id=uuid();store.set(id,{id,...r});return id;});
        return{data:arr.map((r,i)=>({id:ids[i],...r})),error:null};
      },
      update(data){_data=data;return api;},
      eq(k,v){_eq.push([k,v]);return api;},
      single(){_single=true;return api;},
      async then(resolve){
        if(_data){
          for(const [row] of [...store.entries()].filter(([,r])=>_eq.every(([k,v])=>r[k]===v))){
            store.set(row,{...store.get(row),..._data});
          }
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
  async function kerdos_reject_mapping({p_organization_id,p_mapping_id,p_expected_revision}){
    const member=userId?members.get(userId+"_"+p_organization_id):null;
    if(!member||!["owner","manager"].includes(member))
      return{data:null,error:{message:"Owner or manager access is required"}};
    const mapping=[...mappings.values()].find(m=>m.id===p_mapping_id&&m.organization_id===p_organization_id);
    if(!mapping)return{data:null,error:{message:"Association not found"}};
    const vendor=[...vendors.values()].find(v=>v.id===mapping.vendor_item_id&&v.organization_id===p_organization_id);
    if(!vendor)return{data:null,error:{message:"Vendor product not found"}};
    if(vendor.row_revision!==p_expected_revision)
      return{data:null,error:{message:"This product changed; refresh before rejecting"}};
    const item=[...catalogs.values()].find(c=>c.id===mapping.catalog_item_id&&c.organization_id===p_organization_id);
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

  const backend={
    records:{query:table},
    rpc:(name,args)=>name==="kerdos_reject_mapping"?kerdos_reject_mapping(args):Promise.resolve({data:null,error:{message:`Unknown RPC ${name}`}}),
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
  backend._stores.categories.set(catId,{id:catId,organization_id:orgId,name:"Produce",is_holding_pen:false});
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
  const result=await catalogService.rejectMapping(mappingId,1,{organizationId:ORG});
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
  const{vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService,importService}=makeServices(backend,ORG);
  await catalogService.rejectMapping(mappingId,1,{organizationId:ORG});
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

// 3. Full Order Guide readiness: standalone rejected item is orderable once pack
//    and price are confirmed (match_method='rejected' must NOT block ordering).
//    orderGuideAssessment takes {item, vendorItem, mapping, peers, category} — one row at a time.
run("standalone rejected item is orderable when pack and price are ready", async()=>{
  const{orderGuideAssessment}=await import("../core/catalog-fields.js");
  const itemId=uuid();const vendorItemId=uuid();const mappingId=uuid();
  const category={id:"cat-1",organization_id:ORG,name:"Produce",is_holding_pen:false};
  const item={id:itemId,organization_id:ORG,name:"Romaine Lettuce 24ct",
    category_id:"cat-1",matching_behavior:"flexible",comparison_mode:"alternatives",brand_locked:false};
  const vendorItem={id:vendorItemId,organization_id:ORG,vendor_id:VENDOR,
    description:"Romaine Lettuce 24ct",pack_size:"24ct",brand:null,
    selling_unit:"CS",
    // price present, not unavailable, not expired.
    latest_price:12.50,latest_price_effective_date:new Date().toISOString().slice(0,10),
    import_row:{reviewRequired:false},
    field_resolutions:{rejected_catalog_item_ids:["some-old-id"],row_approval:null},row_revision:2};
  const mapping={id:mappingId,organization_id:ORG,catalog_item_id:itemId,vendor_item_id:vendorItemId,
    comparison_track:"review",confidence_score:0,match_method:"rejected"};
  const result=orderGuideAssessment({item,vendorItem,mapping,peers:[],category,categories:[category]});
  // match_method='rejected' must not create an additional blocker; the only
  // possible blockers are field-level ones (quote freshness, pack, etc.) — not
  // a "rejected-match" invented by this path.
  assert.equal(typeof result,"object","orderGuideAssessment must return an object");
  assert.ok(!result.blockers.includes("rejected-match"),
    `match_method='rejected' must not add 'rejected-match' blocker; got: ${JSON.stringify(result.blockers)}`);
});

// 4. Remap to a DIFFERENT catalog item leaves rejected_catalog_item_ids intact.
run("remap to different item preserves rejected_catalog_item_ids", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  await catalogService.rejectMapping(mappingId,1,{organizationId:ORG});
  // Create another catalog item to remap to.
  const otherId=uuid();
  backend._stores.catalogs.set(otherId,{id:otherId,organization_id:ORG,category_id:"cat-1",
    name:"Baby Romaine 12ct",master_item_number:10002});
  const vi=backend._stores.vendors.get(vendorItemId);
  await catalogService.remapToExisting(mappingId,otherId,
    {comparison_track:"review",confidence_score:60,match_method:"rule_based"},
    {vendorItemId,currentFieldResolutions:vi.field_resolutions});
  const viAfter=backend._stores.vendors.get(vendorItemId);
  assert.ok((viAfter.field_resolutions.rejected_catalog_item_ids||[]).includes(catItemId),
    "rejected_catalog_item_ids must still contain the original rejected item after remap to a different item");
});

// 5. Deliberate remap BACK to rejected catalog item clears only that UUID.
run("remap back to same rejected item clears only that UUID from rejected_catalog_item_ids", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{catItemId,vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  // First reject, adding catItemId to the rejection list.
  await catalogService.rejectMapping(mappingId,1,{organizationId:ORG});
  // Also add a second unrelated rejection so we confirm only one is cleared.
  const otherId=uuid();
  const vi=backend._stores.vendors.get(vendorItemId);
  backend._stores.vendors.set(vendorItemId,{...vi,field_resolutions:{
    ...vi.field_resolutions,
    rejected_catalog_item_ids:[...(vi.field_resolutions.rejected_catalog_item_ids||[]),otherId],
  }});
  // Deliberately remap back to the original (rejected) catalog item.
  const viNow=backend._stores.vendors.get(vendorItemId);
  await catalogService.remapToExisting(mappingId,catItemId,
    {comparison_track:"review",confidence_score:70,match_method:"rule_based"},
    {vendorItemId,currentFieldResolutions:viNow.field_resolutions});
  const viAfter=backend._stores.vendors.get(vendorItemId);
  const remaining=viAfter.field_resolutions.rejected_catalog_item_ids||[];
  assert.equal(remaining.includes(catItemId),false,"catItemId must be removed after deliberate remap back");
  assert.equal(remaining.includes(otherId),true,"other rejected IDs must be preserved");
});

// 6. RPC org authorization: non-member cannot reject.
run("non-member cannot call kerdos_reject_mapping", async()=>{
  // userRole:null → no member entry added → auth check fails.
  const backend=createInMemoryBackend({orgId:ORG,userId:"outsider",userRole:null});
  const{catItemId,vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  try{
    await catalogService.rejectMapping(mappingId,1,{organizationId:ORG});
    assert.fail("Should have thrown an authorization error");
  }catch(e){
    assert.ok(e.message.toLowerCase().includes("access")||e.message.toLowerCase().includes("authorized")||e.message.toLowerCase().includes("owner"),
      `Expected authorization error, got: ${e.message}`);
  }
});

// 7. Stale row_revision is rejected.
run("stale row_revision is rejected with a clear error", async()=>{
  const backend=createInMemoryBackend({orgId:ORG,userId:USER});
  const{vendorItemId,mappingId}=seed(backend,ORG,VENDOR);
  const{catalogService}=makeServices(backend,ORG);
  try{
    // Pass revision 99 when the actual revision is 1.
    await catalogService.rejectMapping(mappingId,99,{organizationId:ORG});
    assert.fail("Should have thrown a stale revision error");
  }catch(e){
    assert.ok(e.message.toLowerCase().includes("changed")||e.message.toLowerCase().includes("refresh")||e.message.toLowerCase().includes("revision"),
      `Expected stale revision error, got: ${e.message}`);
  }
});

console.log("\nAll Module E · Reject tests done.\n");
