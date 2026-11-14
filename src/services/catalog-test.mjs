import assert from "node:assert/strict";
import {createCatalogService,mappingVerification,associationEvidence} from "./catalog.js";
import {configureProcurement,getProcurementContext} from "../procurement.js";
import {prepareCatalogCorrection} from "./catalog-rows.js";
import {fixtureProductItemRpc} from "../../scripts/fixtures/price-import-backend.mjs";
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
    eq(column,value){(state.eqs=state.eqs||[]).push([column,value]);return chain;},
    single(){state.single=true;return chain;},
    then(resolve){calls.push({...state});resolve({data:state.insert&&state.single?{id:"created",...state.insert}:state.select?[{id:"mapping"}]:{ok:true},error:null});},
  };
  return chain;
}
const savedProducts=[];
const rpc=fixtureProductItemRpc(savedProducts,[],value=>{const row={id:"keyed-"+(savedProducts.length+1),...value};savedProducts.push(row);return row;});
const service=createCatalogService({records:{query},rpc,catalog:{saveRow:async request=>{calls.push({catalogSave:request});return {};}}});
const verified=mappingVerification({id:"v2",description:"American cheese",pack_size:"120 CT"},{id:"c1",name:"American cheese"},[{id:"v1",description:"American cheese",pack_size:"120 CT"}]);
assert.equal(verified.comparison_track,"exact");
assert.equal(mappingVerification({id:"v2",description:"American cheese",pack_size:"160 CT"},{id:"c1",name:"American cheese"},[{id:"v1",description:"American cheese",pack_size:"120 CT"}]).comparison_track,"review");
assert.equal(mappingVerification({id:"v2",description:"American cheese",pack_size:"120 CT",brand:"A"},{id:"c1",name:"American cheese",brand_locked:true},[{id:"v1",description:"American cheese",pack_size:"120 CT",brand:"B"}]).comparison_track,"review");
assert.equal(mappingVerification({id:"v2",description:"American cheese sliced",pack_size:"120 CT"},{id:"c1",name:"American cheese"},[{id:"v1",description:"American cheese slab",pack_size:"120 CT"}]).comparison_track,"review");
assert.equal(mappingVerification({id:"v2",description:"American cheese",pack_size:null},{id:"c1",name:"American cheese"},[]).comparison_track,"review");
assert.equal(mappingVerification({id:"v2",description:"American cheese",pack_size:"1-40# CB"},{id:"c1",name:"American cheese"},[]).comparison_track,"review");
assert.throws(()=>service.confirmMapping("m1"),/Check this product/);
await assert.rejects(()=>service.confirmMapping("m1",verified),/catalog item ID is required/);
const corrected=await service.correctVendorFields({organizationId:"o1",vendorItem:{id:"v2",organization_id:"o1",description:"American cheese",brand:null,pack_size:"120 CT"},mappingId:"m1",description:"American cheese sliced",brand:"Brand A",packSize:"4/10 LB"});
assert.equal(corrected,true);
assert.deepEqual(calls.at(-1).catalogSave.patch,{description:"American cheese sliced",brand:"Brand A",pack_size:"4/10 LB"});
await service.correctVendorFields({organizationId:"o1",vendorItem:{id:"v2",organization_id:"o1",description:"American cheese",pack_size:"120 CT"},mappingId:"m1",description:"American cheese",brand:"",packSize:"nonsense"});
assert.equal(calls.at(-1).catalogSave.priceAvailable,false,"an unfinished pack may be saved but its quote cannot compete");
const legacyOrderingUnit={id:"v2",organization_id:"o1",description:"American cheese",price:20,price_basis:"case",
  pack_size:"4/10 LB",selling_unit:"CSE",import_row:{sourceDocumentId:"sheet",row:{sellingUnit:"CSE",sellingUnitSource:"header: Type:"}}};
const prepare=patch=>prepareCatalogCorrection({organizationId:"o1",vendorItem:legacyOrderingUnit,
  mapping:{id:"m1",organization_id:"o1",vendor_item_id:"v2"},patch});
assert.equal(prepare({price:22}).priceAvailable,false,"a Type-only listing cannot publish new history when its amount is edited");
assert.equal(prepare({selling_unit:"LB"}).priceAvailable,true,"an explicit price unit supports the pack calculation");
await service.confirmMapping("m1",verified,"c1");
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
const labelKey=description=>getProcurementContext().readProductLabel({description}).key;
const established=[{id:"c1",organization_id:"o1",name:"American cheese",matching_behavior:"flexible",concept_key:labelKey("American cheese")}];
savedProducts.push(...established);
const vendorItems=[{id:"v1",vendor_id:"vendor-a",description:"American cheese",pack_size:"120 CT"}];
const mappings=[{catalog_item_id:"c1",vendor_item_id:"v1"}];
const hold={id:"h",name:"Uncategorized",is_holding_pen:true,range_start:30000};
function assertLabelMatch(result,id){
  assert.equal(result.catalogItemId,id);
  assert.equal(result.track,"exact");
  assert.equal(result.method,"product_label");
  assert.equal(result.score,.9);
}
function matchCheese({description="American cheese",packSize="120 CT",brand,items=established,peers=vendorItems,links=mappings}={}){
  return service.matchOrCreate({organizationId:"o1",vendorId:"vendor-b",description,packSize,brand,
    catalogItems:[...items],categories:[hold],vendorItems:peers,mappings:links});
}
assertLabelMatch(await matchCheese(),"c1");
const mixedPeers=[...vendorItems,{id:"v2",vendor_id:"vendor-c",description:"American cheese",pack_size:"160 CT"}];
const mixedMappings=[...mappings,{catalog_item_id:"c1",vendor_item_id:"v2"}];
assertLabelMatch(await matchCheese({peers:mixedPeers,links:mixedMappings}),"c1");
assertLabelMatch(await matchCheese({packSize:"160 CT"}),"c1");
assertLabelMatch(await matchCheese({packSize:null}),"c1");
assertLabelMatch(await matchCheese({brand:"B",peers:[{...vendorItems[0],brand:"A"}]}),"c1");
assert.equal(associationEvidence({description:"American cheese",packSize:"120 CT"},{linkedVendorItems:mixedPeers}).exact,false,
  "joining a group leaves pack compatibility to purchasing verification");

// The same saved product label is sufficient with or without a prior client approval.
const groupedItem={id:"oil",organization_id:"o1",name:"Olive Oil",comparison_mode:"alternatives",concept_key:labelKey("Olive Oil")};
savedProducts.push(groupedItem);
const approvedOil={
  id:"oil-listing",vendor_id:"vendor-a",description:"POMACE OIL 100%",brand:"A",pack_size:"4/1 GAL",
  field_resolutions:{product_group:{catalogItemId:"oil",description:"POMACE OIL 100%",brand:"A",confirmed:true}},
};
const approvedLink={
  vendor_item_id:approvedOil.id,catalog_item_id:groupedItem.id,
  match_method:"manual",comparison_track:"exact",confidence_score:100,
};
const matchOil=(peer,links)=>service.matchOrCreate({
  organizationId:"o1",vendorId:"vendor-b",description:"POMACE OIL 100%",packSize:"4/3 L",brand:"B",
  catalogItems:[groupedItem],categories:[hold],vendorItems:[peer],mappings:links,
});
assertLabelMatch(await matchOil(approvedOil,[approvedLink]),groupedItem.id);
assertLabelMatch(await matchOil({...approvedOil,field_resolutions:{}},[]),groupedItem.id);

const sliced=await matchCheese({description:"CHEESE AMER SLI 160 WHITE",packSize:"4/5 LB"});
assert.notEqual(sliced.catalogItemId,"c1","wording must not join sliced and unsliced cheese");

// Literal product labels also group across purchasing packs in another industry.
configureProcurement({industry:"construction"});
const genericCategory={id:"cat1",name:"Category One",range_start:1000,range_end:2999,is_holding_pen:false};
const generic={id:"p1",organization_id:"o",name:"Item Alpha",category_id:"cat1",master_item_number:1001,concept_key:labelKey("ITEM ALPHA")};
savedProducts.push(generic);
const genericArgs={organizationId:"o",vendorId:"vendor-two",categoryId:"cat1",categories:[genericCategory],catalogItems:[generic]};
assertLabelMatch(await service.matchOrCreate({...genericArgs,description:"ITEM ALPHA",packSize:"10 EA"}),"p1");
assertLabelMatch(await service.matchOrCreate({...genericArgs,description:"ALPHA ITEM",packSize:"5 EA"}),"p1");
assert.notEqual((await service.matchOrCreate({...genericArgs,description:"ITEM BETA",packSize:"10 EA"})).catalogItemId,"p1");
configureProcurement({industry:"restaurant",vocabulary:[]});
console.log("KERDOS provider-neutral catalog-service tests passed");

assert.equal(mappingVerification({id:"v2",description:"American cheese",pack_size:"120 CT",gtin:"111"},{id:"c1",name:"American cheese"},[{id:"v1",description:"American cheese",pack_size:"120 CT",gtin:"222"}]).comparison_track,"review","conflicting identifiers cannot share an exact comparison");
