import assert from "node:assert/strict";
import {configureProcurement,parsePackSize,packsEquivalent,pricePerUnit,priceBasisFor} from "../procurement.js";
import {parseDocument} from "../ingestion.js";
import {preparePriceImport} from "./price-import-review.js";
import {explainImportRow} from "./import-evidence.js";

// Synthetic cases only. No client/vendor fixture, prices or item list ships.
for(const industry of [null,"Restaurant","Building Supply"]){
  configureProcurement({industry});
  for(const [a,b] of [["18-LBS","18 LB"],["8/3-LB","8/3 LB"],["6/10-OZ","6/10 OZ"],
    ["250-CT","250 CT"],["7-FT","7 FT"],["3/8-MM","3/8 MM"],["5‑KG","5 KG"],
    ["9–CM","9 CM"],["8/QT","8/1 QT"],["6/PINTS","6/1 PT"],["1/PCE","1 EA"]]){
    assert.ok(packsEquivalent(a,b),`${industry}: ${a} vs ${b}`);
  }
  assert.equal(pricePerUnit(36,"18-LBS","LB").price,2);
  assert.equal(parsePackSize("8/QT").caseQty,8);
  assert.equal(parsePackSize("8/QT").unitQty,1);
  assert.equal(priceBasisFor("PCE").basis,"each");
  for(const text of ["12/3","46320","CASE","1-PC 7#","8/3-LB + 2 EA","1-40# CB","8/QT EXTRA","-3-LB","0/3 LB"])
    assert.ok(!parsePackSize(text)?.parsed,`${text}: don't invent or ignore a missing/conflicting spec`);
  assert.equal(packsEquivalent("8/3-LB","1/24 LB"),false,"case structure survives punctuation normalization");
  assert.equal(packsEquivalent("18-LBS AVG","18 LB"),false,"catch weight survives punctuation normalization");
}
configureProcurement();
const source=parseDocument('Item#,Pack & Size:,Type:,Brand:,Description:,Sell\nA-001,18-LBS,CSE,Example,Material Alpha,36').rows[0];
assert.ok(source,"exercise the document parser as well as the row review decision");
const prior={id:"listing",vendor_item_code:"A-001",description:"Material Alpha",pack_size:"18 LB",brand:"Example",selling_unit:"CASE",price_basis:"case",price:30};
const exact={vendor_item_id:"listing",catalog_item_id:"catalog",comparison_track:"exact",confidence_score:100};
const pending={...exact,comparison_track:"review",confidence_score:70};
for(const mapping of [null,pending,exact]){
  const result=preparePriceImport(source,prior,mapping);
  assert.equal(result.requiresReview,false,JSON.stringify(result.reasons));
  assert.equal(result.row.price,36);
  assert.equal(result.resolved.basis.basis,"case");
}
const originals=structuredClone({source,prior,exact});
for(const [patch,field] of [[{packSize:"24 LB"},"packSize"],[{brand:"Other"},"brand"],
  [{description:"Different Material"},"description"],[{gtin:"999"},"gtin"]]){
  const result=preparePriceImport({...source,...patch},{...prior,gtin:"111"},pending);
  assert.equal(result.requiresReview,true);
  assert.ok(result.row.changes.some(c=>c.field===field));
}
assert.deepEqual({source,prior,exact},originals,"review never mutates saved data or associations");
const unreadable=preparePriceImport({...source,packSize:"CASE"},{...prior,pack_size:"CASE"},pending);
assert.equal(unreadable.requiresReview,true);
assert.ok(unreadable.reasons.some(r=>/unreadable/.test(r)));
assert.equal(unreadable.row.changes.length,0,"same unresolved text isn't reported as a changed pack");
const omitted=preparePriceImport({code:"A-001",price:32},prior,exact);
assert.equal(omitted.requiresReview,false,"confirmed code-only repeat keeps saved specifications");
assert.equal(omitted.row.packSize,"18 LB");
const corrected={...prior,pack_size:"18 LB",field_resolutions:{pack_size:{sourceValue:"CASE",value:"18 LB"}},import_row:{row:{packSize:"CASE"}}};
assert.equal(preparePriceImport({...source,packSize:"CASE"},corrected,pending).requiresReview,false,"known source shorthand retains manual correction");
assert.equal(preparePriceImport({...source,packSize:"BOX"},corrected,pending).requiresReview,true,"changed corrected field is saved for review, not thrown away");
assert.equal(preparePriceImport({...source,sellingUnit:"GAL"},prior,pending).requiresReview,true,"incompatible measure cannot become a current quotation");
assert.equal(preparePriceImport({...source,sellingUnit:"?"},prior,pending).requiresReview,true);
assert.equal(preparePriceImport(source,prior,exact,["Invoice disagrees"]).requiresReview,true);
assert.equal(preparePriceImport({...source,packSize:null}).requiresReview,true,"new incomplete rows enter review too");
const changedUnavailable=preparePriceImport({...source,packSize:"24 LB",priceUnavailable:true},prior,exact);
assert.equal(changedUnavailable.requiresReview,true,"unavailable price doesn't bypass changed identity review");
assert.throws(()=>preparePriceImport({...source,code:"001"},prior,exact),/code/);
const preview=explainImportRow({...source,packSize:"BOX"},{vendor:{id:"vendor",name:"Example supplier"},
  vendorItems:[{...corrected,vendor_id:"vendor"}],mappings:[pending]});
assert.ok(preview.conflicts.some(reason=>/changed from the known source/.test(reason)),"preview retains the same review reasons as persistence instead of crashing");
assert.equal(preview.qualification.ready,false);
const invoiceRow={code:"A-001",description:"Material Alpha",price:36,sellingUnit:"CASE"};
const invoiceProof=[{id:"invoice",row:{code:"A-001",description:"Material Alpha",packSize:"18 LB"}}];
assert.equal(preparePriceImport(invoiceRow,null,null,[],invoiceProof).row.packSize,"18 LB","new quote handling retains invoice pack evidence");
console.log("Universal pack syntax and repeated price import review tests passed.");
