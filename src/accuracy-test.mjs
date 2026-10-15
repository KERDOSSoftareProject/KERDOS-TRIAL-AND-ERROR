import {configureProcurement} from "./procurement.js";
import assert from "node:assert/strict";
import {catalogRowEvidence,orderGuideReady,initialsFor} from "./core/catalog-fields.js";
import {prepareCatalogCorrection} from "./services/catalog-rows.js";
import {createImportService} from "./services/imports.js";

let passed=0;
const test=async(name,fn)=>{try{await fn();passed++;}catch(err){console.error(`FAIL ${name}`);throw err;}};

const vendor={id:"A",name:"Mina"};
const category={id:"meat",name:"Meat",is_holding_pen:false};
const item={id:"c1",name:"BACON LAYOUT 30 LB HATFIELD",master_item_number:1010001,category_id:"meat",category_review:false};
const mapping={id:"m1",catalog_item_id:"c1",vendor_item_id:"v1",comparison_track:"exact",confidence_score:100};
const base={id:"v1",vendor_id:"A",description:"BACON LAYOUT 30 LB HATFIELD",brand:"Hatfield",pack_size:"1/30 LB",price:2.89,selling_unit:"LB",price_basis:"measure",price_unavailable:false,field_resolutions:{},import_row:{row:{packSource:"column"}}};
const ev=(vi,extra={})=>catalogRowEvidence({item:extra.item||item,vendorItem:vi,mapping:extra.mapping||mapping,vendor,category:extra.category||category,peers:extra.peers||[]});

// --- accuracy is about being right, not being present ---
await test("an empty cell has no percentage",()=>{
  const e=ev({...base,brand:null,pack_size:null,selling_unit:null});
  assert.equal(e.brand.accuracy,null);assert.equal(e.pack.accuracy,null);assert.equal(e.sellingUnit.accuracy,null);assert.equal(e.unitCost.accuracy,null);
});
await test("a stated or entered value starts at 90 until independently corroborated",()=>{
  const e=ev(base);
  assert.equal(e.pack.accuracy,90);assert.equal(e.price.accuracy,90);assert.equal(e.sellingUnit.accuracy,90);assert.equal(e.brand.accuracy,90);assert.equal(e.product.accuracy,90);
});
await test("a pack read from the description is 90; a sheet-wide unit is 90; a guessed category is 70",()=>{
  const e=ev({...base,import_row:{row:{packSource:"description",sellingUnitSource:"sheet"}}},{item:{...item,category_review:true,category_reason:"Best guess from existing items"}});
  assert.equal(e.pack.accuracy,90);assert.equal(e.sellingUnit.accuracy,90);assert.equal(e.category.accuracy,70);
});
await test("a value the client typed reads 100% with their initials; a contradiction stays as a note",()=>{
  const e=catalogRowEvidence({item,vendorItem:{...base,pack_size:"1/160 CT",field_resolutions:{pack_size:{confirmedBy:"u1"}}},mapping,vendor,category,peers:[],editors:{u1:{email:"dino.maniatis@example.com"}}});
  assert.equal(e.pack.accuracy,100);assert.equal(e.pack.by,"DM");assert.match(e.pack.reason,/^Set by DM/);assert.match(e.pack.reason,/doesn't fit a price quoted per/);
  assert.equal(e.unitCost.value,null);
});
await test("initials come from a name when there is one, else the email",()=>{
  assert.equal(initialsFor({name:"Spiro Maniatis"}),"SM");
  assert.equal(initialsFor({email:"dino.maniatis@x.com"}),"DM");
  assert.equal(initialsFor({email:"spiro@x.com"}),"SP");
  assert.equal(initialsFor(null),"");
});
await test("a pack that disagrees with another vendor on the same item drops to 70 and says so",()=>{
  const e=ev(base,{peers:[{id:"v2",vendor_id:"B",description:"BACON LAYOUT",pack_size:"1/15 LB",brand:"Hatfield"}]});
  assert.equal(e.pack.accuracy,70);assert.match(e.pack.reason,/another vendor lists 1\/15 LB/);
});
await test("a price that changed on the newest sheet is 70 until looked at",()=>{
  const e=ev({...base,import_row:{reviewRequired:true,changes:[{field:"price"}],row:{}}});
  assert.equal(e.price.accuracy,70);assert.match(e.price.reason,/last quote/);
});
await test("an item name copied from a vendor is 70 and a client name still needs validation",()=>{
  assert.equal(ev(base).itemName.accuracy,70);
  assert.equal(ev(base,{item:{...item,name:"Bacon"}}).itemName.accuracy,90);
});
await test("independent vendor agreement can corroborate identity fields",()=>{
  const e=ev({...base,gtin:"123456"},{peers:[{id:"v2",vendor_id:"B",description:base.description,pack_size:base.pack_size,brand:base.brand,gtin:"123456"}]});
  assert.equal(e.product.accuracy,100);assert.equal(e.pack.accuracy,100);assert.equal(e.brand.accuracy,100);
});
await test("same wording without an independent identifier does not prove accuracy",()=>{
  const e=ev(base,{peers:[{id:"v2",vendor_id:"B",description:base.description,pack_size:base.pack_size,brand:base.brand}]});
  assert.equal(e.product.accuracy,90);assert.equal(e.pack.accuracy,90);assert.equal(e.brand.accuracy,90);
});
await test("a typed brand that contradicts the source keeps 100% and shows the contradiction as a note",()=>{
  const e=ev({...base,brand:"Other",field_resolutions:{brand:{sourceValue:"Hatfield"}}});
  assert.equal(e.brand.accuracy,100);assert.match(e.brand.reason,/^Set by you/);assert.match(e.brand.reason,/original source/);
});
await test("unit cost is as sure as the least sure of pack, unit and price",()=>{
  const e=ev({...base,import_row:{row:{packSource:"description"}}});
  assert.equal(e.unitCost.accuracy,90);
});
await test("an unreadable pack is 60 with the reason, not 0",()=>{
  const e=ev({...base,pack_size:"random"});
  assert.equal(e.pack.accuracy,60);assert.match(e.pack.reason,/can read/);
});

// --- placement uses the same numbers: every required cell at 90 or better ---
await test("a row at 90 or better everywhere is Order Guide ready; a 70 cell holds it back",()=>{
  assert.equal(orderGuideReady({item,vendorItem:base,mapping,vendor,category}),true);
  assert.equal(orderGuideReady({item,vendorItem:base,mapping,vendor,category,peers:[{id:"v2",vendor_id:"B",description:"BACON LAYOUT",pack_size:"1/15 LB"}]}),false);
  assert.equal(orderGuideReady({item:{...item,category_review:true},vendorItem:base,mapping,vendor,category}),false,"a guessed category (catAcc=70) holds a priced row back until confirmed");
  assert.equal(orderGuideReady({item,vendorItem:base,mapping,vendor,category:{id:"pen",name:"Uncategorized",is_holding_pen:true}}),false,"no real category does");
});

// --- one-write apply: the item name rides in the same patch ---
await test("item_name is an allowed patch field and is trimmed",()=>{
  const prepared=prepareCatalogCorrection({organizationId:"o",vendorItem:{...base,organization_id:"o",row_revision:3},mapping:{...mapping,organization_id:"o"},patch:{item_name:"  Bacon  ",brand:"Hatfield"}});
  assert.equal(prepared.patch.item_name,"Bacon");assert.equal(prepared.expectedRevision,3);
});
await test("an empty item name is refused before any write",()=>{
  assert.throws(()=>prepareCatalogCorrection({organizationId:"o",vendorItem:{...base,organization_id:"o"},mapping:{...mapping,organization_id:"o"},patch:{item_name:"  "}}),/item name/);
});

// --- resumable import: progress is recorded, and a finished file reports its keys ---
await test("recordProgress and finalizeDocument write completed keys",async()=>{
  const writes=[];
  const query=name=>({update:v=>({eq:(col,id)=>{writes.push({table:name,id,...v});return Promise.resolve({data:null,error:null});}})});
  const service=createImportService({records:{query}});
  await service.recordProgress("d1",["code:1001","code:1002"]);
  await service.finalizeDocument("d1","complete",["code:1001","code:1002","code:1003"]);
  assert.deepEqual(writes[0],{table:"import_documents",id:"d1",completed_keys:["code:1001","code:1002"],status:"processing"});
  assert.deepEqual(writes[1],{table:"import_documents",id:"d1",status:"complete",completed_keys:["code:1001","code:1002","code:1003"]});
});

console.log(`${passed} passed, 0 failed`);

await test("manual KERDOS association is carried in the atomic row patch",()=>{
 const target="00000000-0000-0000-0000-000000000070";
 const prepared=prepareCatalogCorrection({organizationId:"o",vendorItem:{...base,organization_id:"o",row_revision:4},mapping:{...mapping,organization_id:"o"},patch:{catalog_item_id:target,brand:"Hatfield"}});
 assert.equal(prepared.patch.catalog_item_id,target);assert.equal(prepared.expectedRevision,4);
 assert.throws(()=>prepareCatalogCorrection({organizationId:"o",vendorItem:{...base,organization_id:"o"},mapping:{...mapping,organization_id:"o"},patch:{catalog_item_id:"2010"}}),/existing KERDOS/);
});

await test("a prepared vegetable saved as Produce is flagged even when manually assigned",()=>{
 configureProcurement({industry:"Restaurant",vocabulary:[]});
 const categories=[{id:"p",name:"Produce",keywords:["eggplant"]},{id:"g",name:"General",keywords:[]}];
 const e=catalogRowEvidence({item:{...item,category_id:"p"},vendorItem:{...base,description:"BREADED EGGPLANT"},mapping,vendor,category:categories[0],categories});
 assert.equal(e.category.accuracy,70);
});

// Apply approval and override must retain their JSON types through preparation.
{
 const input={organizationId:"o",vendorItem:{id:"vi",organization_id:"o",description:"Foil",price:44.3,pack_size:"",selling_unit:"",row_revision:2},mapping:{id:"m",organization_id:"o",vendor_item_id:"vi"}};
 const approved=prepareCatalogCorrection({...input,patch:{approve_row:true,unit_cost_override:null}});
 assert.equal(approved.patch.approve_row,true);
 assert.equal(approved.patch.unit_cost_override,null);
 const override=prepareCatalogCorrection({...input,patch:{approve_row:true,unit_cost_override:{price:"0.0886",unit:"FT",packPrice:"44.3"}}});
 const transported=JSON.parse(JSON.stringify(override.patch));
 assert.equal(transported.approve_row,true);
 assert.deepEqual(transported.unit_cost_override,{price:0.0886,unit:"FT",packPrice:44.3});
 assert.throws(()=>prepareCatalogCorrection({...input,patch:{approve_row:false}}),/approval/);
 assert.throws(()=>prepareCatalogCorrection({...input,patch:{approve_row:true,unit_cost_override:{price:0,unit:"FT",packPrice:44.3}}}),/positive/);
 console.log("Apply approval and override retain their JSON types.");
}
