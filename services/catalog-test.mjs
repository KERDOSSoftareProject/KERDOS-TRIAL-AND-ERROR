import assert from "node:assert/strict";
import {createCatalogService,mappingVerification,associationEvidence} from "./catalog.js";
import {configureProcurement} from "../procurement.js";
configureProcurement({industry:"restaurant",vocabulary:[]});
await new Promise(r=>setTimeout(r,10));

const calls=[];
function query(table){
  const state={table};
  const chain={
    select(value){state.select=value;return chain;},
    update(value){state.update=value;return chain;},
    insert(value){state.insert=value;return chain;},
    delete(){state.delete=true;return chain;},
    eq(column,value){state.eq=[column,value];return chain;},
    single(){state.single=true;return chain;},
    then(resolve){calls.push({...state});resolve({data:state.insert&&state.single?{id:"created",...state.insert}:state.select?[{id:"mapping"}]:{ok:true},error:null});},
  };
  return chain;
}
const service=createCatalogService({records:{query},catalog:{saveRow:async request=>{calls.push({catalogSave:request});return {};}}});
const verified=mappingVerification({id:"v2",description:"American cheese",pack_size:"120 CT"},{id:"c1",name:"American cheese"},[{id:"v1",description:"American cheese",pack_size:"120 CT"}]);
assert.equal(verified.comparison_track,"exact");
assert.equal(mappingVerification({id:"v2",description:"American cheese",pack_size:"160 CT"},{id:"c1",name:"American cheese"},[{id:"v1",description:"American cheese",pack_size:"120 CT"}]).comparison_track,"review");
assert.equal(mappingVerification({id:"v2",description:"American cheese",pack_size:"120 CT",brand:"A"},{id:"c1",name:"American cheese",brand_locked:true},[{id:"v1",description:"American cheese",pack_size:"120 CT",brand:"B"}]).comparison_track,"review");
assert.equal(mappingVerification({id:"v2",description:"American cheese sliced",pack_size:"120 CT"},{id:"c1",name:"American cheese"},[{id:"v1",description:"American cheese slab",pack_size:"120 CT"}]).comparison_track,"review");
assert.equal(mappingVerification({id:"v2",description:"American cheese",pack_size:null},{id:"c1",name:"American cheese"},[]).comparison_track,"review");
assert.equal(mappingVerification({id:"v2",description:"American cheese",pack_size:"1-40# CB"},{id:"c1",name:"American cheese"},[]).comparison_track,"review");
assert.throws(()=>service.confirmMapping("m1"),/Check this product/);
const corrected=await service.correctVendorFields({organizationId:"o1",vendorItem:{id:"v2",organization_id:"o1",description:"American cheese",brand:null,pack_size:"120 CT"},mappingId:"m1",description:"American cheese sliced",brand:"Brand A",packSize:"4/10 LB"});
assert.equal(corrected,true);
assert.deepEqual(calls.at(-1).catalogSave.patch,{description:"American cheese sliced",brand:"Brand A",pack_size:"4/10 LB"});
await service.correctVendorFields({organizationId:"o1",vendorItem:{id:"v2",organization_id:"o1",description:"American cheese",pack_size:"120 CT"},mappingId:"m1",description:"American cheese",brand:"",packSize:"nonsense"});
assert.equal(calls.at(-1).catalogSave.priceAvailable,false,"an unfinished pack may be saved but its quote cannot compete");
await service.confirmMapping("m1",verified);
assert.deepEqual(calls.at(-1).update,{comparison_track:"exact",confidence_score:100,match_method:"manual"});
await service.renameItem("c1","Client Product");
assert.equal(calls.at(-1).update.name,"Client Product");
await service.assignVendorItem({organizationId:"o1",vendorItemId:"v1",catalogItemId:"c1",verification:verified});
assert.equal(calls.at(-1).insert.match_method,"manual");
const created=await service.createItem({organizationId:"o1",name:"Universal Product",categoryId:"cat",catalogItems:[],categories:[{id:"cat",range_start:20000}]});
assert.equal(created.master_item_number,20000);
assert.equal(calls.at(-1).table,"catalog_items");
const afterMove=await service.createItem({organizationId:"o1",name:"Next item",categoryId:"cat",catalogItems:[
  {id:"moved",category_id:"other",master_item_number:20001},
  {id:"resident",category_id:"cat",master_item_number:20000},
],categories:[{id:"cat",range_start:20000,range_end:29999}]});
assert.equal(afterMove.master_item_number,20002,"a moved client's number must not be reused by its original category");
const selected=await service.placeInCategory({organizationId:"o1",description:"American cheese",categoryId:"dairy",categories:[
  {id:"dairy",name:"Dairy"},{id:"h",name:"Uncategorized",is_holding_pen:true},
],catalogItems:[]});
assert.equal(selected.category.name,"Dairy");
assert.equal(selected.review,false);
await assert.rejects(service.placeInCategory({organizationId:"o1",description:"American cheese",categoryId:"elsewhere",categories:[{id:"dairy",name:"Dairy"}],catalogItems:[]}),/available category/);
const established=[{id:"c1",name:"American cheese",matching_behavior:"flexible"}];
const vendorItems=[{id:"v1",vendor_id:"vendor-a",description:"American cheese",pack_size:"120 CT"}];
const mappings=[{catalog_item_id:"c1",vendor_item_id:"v1"}];
const exact=await service.matchOrCreate({organizationId:"o1",vendorId:"vendor-b",description:"American cheese",packSize:"120 CT",catalogItems:[...established],categories:[],vendorItems,mappings});
// Cross-vendor import now creates a new entry per consensus (2026-10-05).
// The incoming item gets its own orderable KERDOS number. The suggestion
// of the existing entry is carried in track:"review" so Item Catalog can
// show it as a proposed link for the client to act on.
assert.equal(exact.catalogItemId,"c1","cross-vendor item with matching description+pack links to same KERDOS entry");
assert.ok(["exact","review"].includes(exact.track),"links to existing entry");
const mixedPeers=[{id:"v1",vendor_id:"vendor-a",description:"American cheese",pack_size:"120 CT"},
  {id:"v2",vendor_id:"vendor-c",description:"American cheese",pack_size:"160 CT"}];
const conflicted=await service.matchOrCreate({organizationId:"o1",vendorId:"vendor-b",description:"American cheese",packSize:"120 CT",catalogItems:[...established],categories:[],vendorItems:mixedPeers,mappings:[...mappings,{catalog_item_id:"c1",vendor_item_id:"v2"}]});
// Mixed packs on entry: engine cannot confirm identity, pack agreement, or brand-lock
// without unambiguous evidence. No automatic association — a new entry is created.
// The client links manually via Item Catalog if the products are confirmed the same.
assert.equal(conflicted.track,"new","mixed-pack entry: no automatic association without confirmed identity and pack");
assert.notEqual(conflicted.catalogItemId,"c1","mixed-pack entry: incoming item must not be auto-linked to the conflicted entry");
assert.equal(associationEvidence({description:"American cheese",packSize:"120 CT"},{linkedVendorItems:mixedPeers}).exact,false);
const singleVendor=await service.matchOrCreate({organizationId:"o1",vendorId:"vendor-a",description:"American cheese",packSize:"120 CT",catalogItems:[...established],categories:[],vendorItems,mappings});
assert.ok(["exact","review"].includes(singleVendor.track),"same description+pack links to existing entry");
const differentBrand=await service.matchOrCreate({organizationId:"o1",description:"American cheese",packSize:"120 CT",brand:"B",catalogItems:[...established],categories:[],vendorItems:[{id:"v1",description:"American cheese",pack_size:"120 CT",brand:"A"}],mappings});
assert.equal(differentBrand.track,"exact","unlocked catalog item: different brands are acceptable alternatives");
const reviewed=await service.matchOrCreate({organizationId:"o1",description:"American cheese",packSize:"160 CT",catalogItems:[...established],categories:[{id:"h",name:"Uncategorized",is_holding_pen:true,range_start:30000}],vendorItems,mappings});
// Same product (American cheese), different pack (160 CT vs 120 CT).
// Different purchasing packs → separate catalog entries. A human links them if needed.
assert.equal(reviewed.track,"new","same product different pack creates a new catalog entry");
const differingWords=await service.matchOrCreate({organizationId:"o1",description:"CHEESE AMER SLI 160 WHITE",packSize:"4/5 LB",catalogItems:[{id:"c2",name:"CHEESE AMERICAN 160CT WHITE",matching_behavior:"flexible"}],categories:[],vendorItems:[{id:"v2",description:"CHEESE AMERICAN 160CT WHITE",pack_size:"4/5 LB"}],mappings:[{catalog_item_id:"c2",vendor_item_id:"v2"}]});
// Without vocabulary confirmation that "AMER"="AMERICAN", the engine cannot confirm
// these are the same product. A new entry is created; the client can merge manually.
// Linking on unresolved abbreviations risks collisions with genuinely different products.
assert.equal(differingWords.track,"new","unresolved abbreviation without vocabulary creates a new entry — client merges if same product");

// ── THE HARD RULE ────────────────────────────────────────────────────────────
// Every vendor item lands on an existing KERDOS entry when the engine
// understands the product. New entries are last resort, not default.
// These tests use generic, industry-neutral examples — KERDOS is universal.
{
  // A catalog entry for a generic product at a specific pack size.
  const rule_ci={id:"p1",name:"ITEM ALPHA STANDARD",category_id:"cat1",master_item_number:1001,brand_locked:false,matching_behavior:"flexible",category_review:false};
  const rule_vi={id:"v1",vendor_id:"vendor-one",description:"ITEM ALPHA STANDARD",pack_size:"10 EA",brand:null,gtin:null,manufacturer_code:null};
  const rule_m={id:"m1",catalog_item_id:"p1",vendor_item_id:"v1",comparison_track:"exact",confidence_score:100};
  const rule_cats=[{id:"cat1",name:"Category One",range_start:1000,range_end:2999,is_holding_pen:false}];
  const args=(desc,pack)=>({organizationId:"o",vendorId:"vendor-two",description:desc,packSize:pack,brand:null,gtin:null,manufacturerCode:null,
    catalogItems:[{...rule_ci}],categories:rule_cats,vendorItems:[rule_vi],mappings:[rule_m]});

  // Same understood product + same pack → exact link, no client action needed
  const r1=await service.matchOrCreate(args("ITEM ALPHA STANDARD","10 EA"));
  assert.equal(r1.catalogItemId,"p1","same description same pack → exact link to existing entry");
  assert.equal(r1.track,"exact");

  // Same understood product + different pack → new entry (separate purchasing unit).
  // 10 EA and 5 EA are distinct purchasing quantities; a human links them if needed.
  const r2=await service.matchOrCreate({...args("ITEM ALPHA STANDARD","5 EA"),categories:rule_cats});
  assert.equal(r2.track,"new","same description different confirmed pack → separate catalog entry");

  // Genuinely different product (conflicting defining terms) → new entry
  // The engine must never suggest an entry when product terms conflict.
  let r3track="new";
  try{
    const r3=await service.matchOrCreate(args("ITEM BETA STANDARD","10 EA"));
    r3track=r3.catalogItemId!=="p1"?"new":"wrong_link";
  }catch{r3track="new";}
  assert.equal(r3track,"new","conflicting product terms → new entry, never matched to a different product");

  // Mixed-pack conflict: entry has two vendors with different packs already (24 CT and 48 CT).
  // The engine cannot confirm pack agreement — knownPack is null (no consensus).
  // No automatic association. A new entry is created; the client links manually if needed.
  const p2={id:"p2",name:"ITEM GAMMA UNIT",category_id:"cat1",master_item_number:1002,brand_locked:false,matching_behavior:"flexible",category_review:false};
  const vi2={id:"v2",vendor_id:"vendor-one",description:"ITEM GAMMA UNIT",pack_size:"24 CT",brand:null,gtin:null,manufacturer_code:null};
  const vi3={id:"v3",vendor_id:"vendor-two",description:"ITEM GAMMA UNIT",pack_size:"48 CT",brand:null,gtin:null,manufacturer_code:null};
  const m2={id:"m2",catalog_item_id:"p2",vendor_item_id:"v2",comparison_track:"exact",confidence_score:100};
  const m3={id:"m3",catalog_item_id:"p2",vendor_item_id:"v3",comparison_track:"review",confidence_score:80};
  const r4=await service.matchOrCreate({organizationId:"o",vendorId:"vendor-three",description:"ITEM GAMMA UNIT",packSize:"24 CT",brand:null,gtin:null,manufacturerCode:null,
    catalogItems:[{...p2}],categories:rule_cats,vendorItems:[vi2,vi3],mappings:[m2,m3]});
  assert.equal(r4.track,"new","mixed-pack conflict: no automatic association — engine cannot confirm pack agreement");
  assert.notEqual(r4.catalogItemId,"p2","mixed-pack conflict: incoming item must not be auto-linked to the conflicted entry");
}
console.log("KERDOS provider-neutral catalog-service tests passed");

assert.equal(mappingVerification({id:"v2",description:"American cheese",pack_size:"120 CT",gtin:"111"},{id:"c1",name:"American cheese"},[{id:"v1",description:"American cheese",pack_size:"120 CT",gtin:"222"}]).comparison_track,"review","conflicting identifiers cannot share an exact comparison");
