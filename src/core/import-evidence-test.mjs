import assert from "node:assert/strict";
import {explainImportRow} from "./import-evidence.js";

const row={description:"Chicken breast",brand:"",packSize:"4/10 LB",price:80,sellingUnit:"CASE",sourceLine:"Chicken breast 4/10 LB 80.00"};
const result=explainImportRow(row,{vendor:{name:"Supplier A"},categories:[{id:"meat",name:"Meat",keywords:["chicken"]}]});
assert.match(result.vendor.value,/Supplier A · NVIM assigned on save/);
assert.equal(result.brand.value,null);
assert.equal(result.brand.accuracy,null);
assert.equal(result.pack.value,"4/10 LB");
assert.equal(result.pack.accuracy,90);
assert.equal(result.price.value,80);
assert.equal(result.unitCost.value,2);
assert.equal(result.sellingUnit.value,"CASE");
assert.equal(result.unitCost.unit,"LB");
const corrected=explainImportRow({...row,price:3.83,priceEdited:true,sellingUnit:"LB",sellingUnitSource:"manual"});
assert.equal(corrected.price.value,3.83);
assert.equal(corrected.price.source,"manual correction");
assert.equal(corrected.sellingUnit.source,"manual selection");
assert.equal(corrected.unitCost.value,3.83);
assert.equal(corrected.unitCost.unit,"LB");
assert.equal(result.itemNumber.value,null);
const noBasis=explainImportRow({...row,sellingUnit:"",price:80});
assert.equal(noBasis.price.value,80);
assert.equal(noBasis.unitCost.value,null);
assert.match(noBasis.unitCost.reason,/Selling unit/);
const noPack=explainImportRow({...row,packSize:null});
assert.equal(noPack.unitCost.value,null);
assert.equal(noPack.pack.accuracy,null);
const manuallyCategorized=explainImportRow({...row,description:"American cheese",categoryId:"dairy"},{categories:[
  {id:"dairy",name:"Dairy"},{id:"h",name:"Uncategorized",is_holding_pen:true},
]});
assert.equal(manuallyCategorized.category.value,"Dairy");
assert.equal(manuallyCategorized.category.accuracy,90);
assert.equal(manuallyCategorized.category.source,"manual selection");
console.log("KERDOS field evidence tests passed");
