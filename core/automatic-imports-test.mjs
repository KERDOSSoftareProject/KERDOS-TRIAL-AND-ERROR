import {verifyResumeRows} from "./import-resume.js";
import assert from "node:assert/strict";
import {parseDocument} from "../ingestion.js";
import {parsePackSize,comparePurchasingPack,suggestCategory,priceBasisFor} from "../procurement.js";
import {configureCategoryProfile} from "../knowledge/category-profiles.js";
import {categories,automaticImports} from "../fixtures/automatic-imports.js";
import {explainImportRow} from "./import-evidence.js";
import {prepareImportRow} from "./import-row.js";
import {findUncodedVendorListing} from "./vendor-listing.js";
import {resolveQuoteBasis} from "./quote-basis.js";
import {catalogRowEvidence,autoPlaceable,orderGuideAssessment,qualificationSummary,importResolutions} from "./catalog-fields.js";
import {enrichFromInvoices,invoiceEvidence} from "./invoice-evidence.js";

configureCategoryProfile("Restaurant");
const vendor={id:"v",name:"Supplier"};
let ready=0,incorrect=0;
for(const fixture of automaticImports){
  const parsed=parseDocument(fixture.text);
  assert.equal(parsed.rows.length,1,fixture.name+": one product row");
  const evidence=explainImportRow(parsed.rows[0],{categories,vendor});
  const actual=evidence.qualification.ready;
  if(actual)ready++;
  if(actual!==fixture.ready)incorrect++;
  assert.equal(actual,fixture.ready,fixture.name);
  if(fixture.category)assert.equal(evidence.category.value,categories.find(c=>c.id===fixture.category).name,fixture.name);
  for(const key of ["product","pack","price","sellingUnit","category"])
    assert.ok(evidence[key].accuracy==null||evidence[key].accuracy<=90,"a source statement is never 100");
}
assert.equal(incorrect,0);
const repeated=parseDocument("Description\tPack\tPrice per LB\nBeef\t10 LB\t3.50\nDescription\tPack\tPrice per case\nChicken\t10 LB\t25.00");
assert.deepEqual(repeated.rows.map(r=>r.sellingUnit),["LB","CASE"]);
const ratio=parseDocument("Description\tPack\tDetail\tPrice\nBacon layout\t15 LB\t18/22\t3.24").rows[0];
assert.equal(ratio.code,null);assert.match(ratio.description,/18\/22/);
assert.equal(parsePackSize("10 LB FRESH").parsed,true);
assert.equal(parsePackSize("7 LB IMP").parsed,true);
assert.equal(parsePackSize("2/9.5").parsed,false);
assert.equal(comparePurchasingPack("10 LB FRESH","10 LB FROZEN").status,"review");
assert.equal(suggestCategory("SWISS CHARD",categories).category.id,"produce");
assert.equal(suggestCategory("PLASTIC WRAP",categories).category.id,"paper");

const prior={id:"vi",vendor_id:"v",description:"Beef",brand:null,pack_size:"10 LB",selling_unit:"LB",price_basis:"measure",price:3.5};
const item={id:"ci",name:"Beef",category_id:"meat",master_item_number:20001};
const mapping={id:"map",vendor_item_id:"vi",catalog_item_id:"ci",comparison_track:"review",confidence_score:70};
const source={description:"Beef",brand:null,packSize:"10 LB",price:3.6};
const found=findUncodedVendorListing(source,[prior]);assert.equal(found.item.id,"vi");
const row=prepareImportRow(source,{prior:found.item,mapping});
assert.equal(row.sellingUnit,"LB","unique same-vendor NVIM learns basis without requiring an exact mapping");
assert.equal(resolveQuoteBasis(source,prior),null,"uncoded history needs the unique-listing resolution first");
assert.equal(findUncodedVendorListing(source,[prior,{...prior,id:"second"}]).item,null,"ambiguous NVIM cannot lend its basis");
assert.equal(prepareImportRow(source,{prior:{...prior,price_basis:null},mapping}).sellingUnit,undefined);
assert.equal(prepareImportRow(source,{prior:{...prior,price_source:"invoice"},mapping}).sellingUnit,undefined);
const exact={...mapping,comparison_track:"exact",confidence_score:100};
assert.equal(prepareImportRow(source,{prior:{...prior,price_basis:null},mapping:exact}).sellingUnit,"","legacy unit alone is not remembered as a confirmed basis");
assert.equal(explainImportRow(source,{vendor:{id:"other",name:"Other"},categories,vendorItems:[prior],mappings:[mapping],catalogItems:[item]}).sellingUnit.value,null);
const vi={...prior,price:row.price,import_row:{row:source,evidence:row}};
const input={item,vendorItem:vi,mapping,vendor,category:categories[0],categories};
const preview=explainImportRow(source,{vendor,categories,vendorItems:[prior],mappings:[mapping],catalogItems:[item]});
const saved=catalogRowEvidence(input);
for(const key of ["category","product","pack","price","sellingUnit","unitCost"]){
  assert.equal(preview[key].accuracy,saved[key].accuracy,key+": preview and saved percentages agree");
  assert.equal(preview[key].value,saved[key].value,key+": preview and saved values agree");
}
const snapshot={catalogItems:[item],vendorItems:[vi],mappings:[mapping],vendors:[vendor],categories};
assert.equal(autoPlaceable(snapshot).length,1);
assert.equal(autoPlaceable(snapshot)[0].verification.match_method,"rule_based");
assert.equal(qualificationSummary(snapshot).ready,1);
assert.equal(orderGuideAssessment({...input,vendorItem:{...vi,price_quote_valid_until:"2000-01-01"}}).ready,false);
assert.equal(orderGuideAssessment({...input,vendorItem:{...vi,import_row:{reviewRequired:true}}}).ready,false);
assert.equal(orderGuideAssessment({...input,item:{...item,brand_locked:true,locked_brand:"Chosen"}}).ready,false);
assert.equal(orderGuideAssessment({...input,item:{...item,name:"Our house product"},mapping:exact}).ready,true,"renaming an already verified catalog item does not undo its association");
const adjusted={...vi,price:9};
assert.equal(catalogRowEvidence({...input,vendorItem:adjusted}).price.accuracy,70,"a stored price that differs from the source with no record of who changed it drops to 70");
assert.equal(catalogRowEvidence({...input,vendorItem:{...adjusted,field_resolutions:{price:{sourceValue:3.6}}}}).price.accuracy,100,"the same change recorded as the client's reads 100%");
assert.equal(importResolutions(source,{field_resolutions:{price:{value:9,sourceValue:3.5}}}).price,undefined,"new quote replaces old amount evidence");
const manual=explainImportRow({...source,price:9,manualFields:["price"],originalFields:{price:3.6}},{vendor,categories});
assert.equal(manual.price.accuracy,100,"a price corrected by hand during import is the client's: 100%, with the difference from the sheet noted");
assert.match(manual.price.reason,/^Set by/);

const invoice={id:"invoice-1",number:"I-1",row:{code:"100",description:"Beef",packSize:"10 LB",sellingUnit:"LB",price:2.5}};
const missing={code:"100",description:"Beef",price:35};
const enriched=enrichFromInvoices(missing,[invoice]);
assert.equal(enriched.packSize,"10 LB");assert.equal(enriched.sellingUnit,undefined);assert.equal(enriched.price,35);
assert.deepEqual(enriched.fieldEvidence.packSize.documentIds,["invoice-1"]);
assert.equal(enrichFromInvoices({...missing,packSize:"",manualFields:["packSize"]},[invoice]).packSize,"");
assert.equal(enrichFromInvoices(missing,[invoice,{...invoice,row:{...invoice.row,packSize:"20 LB"}}]).packSize,undefined);
assert.equal(invoiceEvidence({...missing,packSize:"10 LB",sellingUnit:"CASE"},[invoice]).conflicts.length,0,"compatible invoice billing unit need not be the quote's unit");
assert.equal(explainImportRow({...missing,sellingUnit:"CASE"},{vendor,categories,invoices:[invoice]}).qualification.ready,true);
assert.equal(invoiceEvidence({...missing,packSize:"10 LB",sellingUnit:"CASE"},[invoice,{...invoice,row:{...invoice.row,sellingUnit:"CASE"}}]).conflicts.length,0);
assert.equal(priceBasisFor(enriched.sellingUnit),null);
verifyResumeRows([{sourceLine:"one"},{sourceLine:"two"}],["row:0"],[{key:"row:0",sourceLine:"one"}]);
assert.throws(()=>verifyResumeRows([{sourceLine:"two"},{sourceLine:"one"}],["row:0"],[{key:"row:0",sourceLine:"one"}]),/positions differ/);
assert.throws(()=>verifyResumeRows([{sourceLine:"one"}],["row:0"],[]),/no matching saved source/);
assert.throws(()=>verifyResumeRows([{sourceLine:"one"}],[],[{key:"row:0",sourceLine:"two"}]),/positions differ/,"uncheckpointed writes are checked too");
configureCategoryProfile(null);
assert.equal(parsePackSize("SLICING12LB").parsed,false,"industry interpretation stays in its profile");
const industrialCategories=[{id:"hardware",name:"Hardware",keywords:["bolt","bolts"]},{id:"materials",name:"Materials",keywords:["adhesive","rope"]}];
for(const [description,pack,price,unit] of [["Steel bolts","100/1 CT","0.25","EACH"],["Adhesive","4/1 GAL","12.00","GAL"],["Rope","500 FT","0.30","FT"]]){
  const row=parseDocument(`Description\tPack\tPrice per ${unit}\n${description}\t${pack}\t${price}`).rows[0];
  const evidence=explainImportRow(row,{vendor,categories:industrialCategories});
  assert.equal(evidence.qualification.ready,true,`${description}: industry-neutral process qualifies the row without a Restaurant profile`);
  assert.equal(evidence.sellingUnit.accuracy,90);
}
for(const price of [0.25,2500000]){
  const row={description:"Steel bolts",packSize:"100 CT",price,sellingUnit:"CASE"};
  assert.equal(explainImportRow(row,{vendor,categories:industrialCategories}).price.accuracy,90,"a global market-price cutoff cannot judge every industry");
}


console.log(`Automatic-import regression: ${automaticImports.length} fixtures, ${ready} ready without edits, ${automaticImports.length-ready} correctly held, ${incorrect} incorrect outcomes; history, source disagreement, invoice, expiry, qualifiers, preview/persistence and three non-food industry cases passed.`);
