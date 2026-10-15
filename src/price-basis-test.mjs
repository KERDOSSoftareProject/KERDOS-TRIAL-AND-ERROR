import assert from "node:assert/strict";
import {priceBasisFor,casePriceFromQuote,quotePriceOnBasis,configureVocabulary,parsePackSize} from "./procurement.js";
import {createCatalogService} from "./services/catalog.js";

let passed=0;
const test=async(name,fn)=>{try{await fn();passed++;}catch(err){console.error(`FAIL ${name}`);throw err;}};
await test("vendor packs without a leading zero still resolve their measurement",()=>{
  assert.equal(parsePackSize("200/.5OZ")?.total,100);
  assert.equal(parsePackSize("4/.5 GAL")?.total,2);
});

// --- basis recognition: what the vendor's selling unit means ---
await test("case words",()=>{for(const w of ["CS","case","Bx","PK","CT","cs."])assert.equal(priceBasisFor(w).basis,"case",w);});
await test("each words",()=>{for(const w of ["EA","each","PC","unit"])assert.equal(priceBasisFor(w).basis,"each",w);});
await test("measure words carry the unit",()=>{
  assert.deepEqual(priceBasisFor("LB"),{basis:"measure",unit:"LB"});
  assert.deepEqual(priceBasisFor("lbs"),{basis:"measure",unit:"LB"});
  assert.deepEqual(priceBasisFor("GAL"),{basis:"measure",unit:"GAL"});
});
await test("an organization's own packaging and unit words set the basis",()=>{
  assert.equal(priceBasisFor("REAM"),null);
  configureVocabulary([{kind:"packaging",term:"ream"},{kind:"unit",term:"sqft",canonical:"SQFT"}]);
  assert.deepEqual(priceBasisFor("REAM"),{basis:"case",unit:null});
  assert.deepEqual(priceBasisFor("sqft"),{basis:"measure",unit:"SQFT"});
  assert.equal(casePriceFromQuote(2,"measure","SQFT","1/500 SQFT"),1000);
  assert.equal(casePriceFromQuote(2,"measure","SQFT","4/10 LB"),null);
  configureVocabulary([]);
});
await test("unknown or blank selling unit gives no basis",()=>{assert.equal(priceBasisFor("XYZ"),null);assert.equal(priceBasisFor(""),null);assert.equal(priceBasisFor(null),null);});

// --- converting a quote to the price of one full pack ---
await test("legacy quote with no basis is already the pack price",()=>assert.equal(casePriceFromQuote(85.6,null,null,"4/10 LB"),85.6));
await test("case quote passes through",()=>assert.equal(casePriceFromQuote(85.6,"case",null,"4/10 LB"),85.6));
await test("per-pound quote times the case weight",()=>assert.equal(casePriceFromQuote(2.14,"measure","LB","4/10 LB"),85.6));
await test("per-pound quote works across units of the same dimension",()=>assert.equal(casePriceFromQuote(1,"measure","LB","1/16 OZ"),1));
await test("per-each quote times the count per case",()=>assert.equal(casePriceFromQuote(3,"each",null,"12/1 EA"),36));
await test("per-pound quote on an each-counted pack cannot convert",()=>assert.equal(casePriceFromQuote(2.14,"measure","LB","12/1 EA"),null));
await test("any non-case quote with an unreadable pack cannot convert",()=>{
  assert.equal(casePriceFromQuote(2.14,"measure","LB",null),null);
  assert.equal(casePriceFromQuote(3,"each",null,"random weight"),null);
});
await test("non-positive prices never convert",()=>{assert.equal(casePriceFromQuote(0,"case",null,"1 CS"),null);assert.equal(casePriceFromQuote("abc","case",null,"1 CS"),null);});

// --- expressing a stored quote on the basis an invoice bills in ---
const caseQuote={price:85.6,basis:"case",unit:null,packSize:"4/10 LB"};
await test("invoice billed per case compares to the case price",()=>assert.equal(quotePriceOnBasis(caseQuote,{basis:"case"}),85.6));
await test("invoice billed per pound compares to the per-pound price",()=>assert.equal(quotePriceOnBasis(caseQuote,{basis:"measure",unit:"LB"}),2.14));
await test("invoice billed per each compares to the per-unit price",()=>assert.equal(quotePriceOnBasis(caseQuote,{basis:"each"}),21.4));
await test("invoice billed in another dimension cannot compare",()=>assert.equal(quotePriceOnBasis(caseQuote,{basis:"measure",unit:"GAL"}),null));
await test("per-pound quote against per-pound invoice round-trips",()=>assert.equal(quotePriceOnBasis({price:2.14,basis:"measure",unit:"LB",packSize:"4/10 LB"},{basis:"measure",unit:"LB"}),2.14));
await test("no target basis means the pack price",()=>assert.equal(quotePriceOnBasis(caseQuote,null),85.6));

// --- bulk confirm persistence goes through the records contract, one update per mapping ---
await test("confirmMappings writes each verified entry and refuses unverified ones",async()=>{
  const writes=[];
  const query=()=>({update:v=>({eq:(col,id)=>{writes.push({id,...v});return Promise.resolve({data:null,error:null});}})});
  const service=createCatalogService({records:{query}});
  const ready=[{mappingId:"m1",verification:{comparison_track:"exact",confidence_score:100,match_method:"manual"}}];
  const count=await service.confirmMappings(ready);
  assert.equal(count,1);assert.deepEqual(writes,[{id:"m1",comparison_track:"exact",confidence_score:100,match_method:"manual"}]);
  await assert.rejects(()=>service.confirmMappings([{mappingId:"m2",verification:{comparison_track:"review"}}]),/fully verified/);
});

console.log(`${passed} passed, 0 failed`);
