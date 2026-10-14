import assert from "node:assert/strict";
import {readHeaderLayout,applyLayoutAnswers,checkCell,checkRowCells,headerFingerprint,rememberedLayout,withRememberedLayout,COLUMN_ROLE_LABELS,COLUMN_ROLES_FOR_CHOICE} from "./sheet-layout.js";
import {parseDocument} from "../ingestion.js";

let passed=0;
const test=(name,fn)=>{try{fn();passed++;}catch(err){console.error(`FAIL ${name}`);throw err;}};

// --- header reading: recognised, remembered, unknown ---
test("every column gets a meaning or is reported unknown, once",()=>{
  const layout=readHeaderLayout({headerCells:["Item#","Description","Pk/Sz","Sell","Type"],columnMap:{code:0,description:1,sellingUnit:4}});
  assert.deepEqual(layout.headers.map(h=>h.how),["recognised","recognised","unknown","unknown","recognised"]);
  assert.deepEqual(layout.unknown.map(h=>h.label),["Pk/Sz","Sell"]);
});
test("a remembered answer turns an unknown header into a known one",()=>{
  const layout=readHeaderLayout({headerCells:["Item#","Description","Pk/Sz","Sell"],columnMap:{code:0,description:1},remembered:{2:"packSize",3:"price"}});
  assert.equal(layout.unknown.length,0);
  assert.equal(layout.headers[2].how,"remembered");
});
test("the fingerprint ignores case, punctuation and spacing but keeps order",()=>{
  assert.equal(headerFingerprint(["Item#","Pack & Size:","Sell"]),headerFingerprint(["ITEM#","pack & size","SELL"]));
  assert.notEqual(headerFingerprint(["Sell","Item#"]),headerFingerprint(["Item#","Sell"]));
});

// --- answers applied on top of the engine's reading ---
test("an answer assigns a role and displaces the engine's guess for that role",()=>{
  const map=applyLayoutAnswers({code:0,description:1,price:5},{3:"price",4:"sellingUnit",5:"ignore"});
  assert.deepEqual(map,{code:0,description:1,price:3,sellingUnit:4});
});
test("ignore removes a column the engine had guessed",()=>{
  assert.deepEqual(applyLayoutAnswers({code:0,brand:2},{2:"ignore"}),{code:0});
});

// --- cells checked against their column's meaning ---
test("a price must be money, a pack must be a pack, a unit must be a unit",()=>{
  assert.equal(checkCell("price","$3.50").ok,true);
  assert.equal(checkCell("price","call").ok,false);
  assert.equal(checkCell("packSize","4/10 LB").ok,true);
  assert.equal(checkCell("packSize","24/15.5").ok,false);
  assert.equal(checkCell("sellingUnit","CSE").ok,true);
  assert.equal(checkCell("sellingUnit","P").ok,false);
  assert.equal(checkCell("gtin","012345678905").ok,true);
  assert.equal(checkCell("gtin","2035551234").ok,false);
});
test("an empty cell is not a failure, and quantity is not cell-checked",()=>{
  assert.equal(checkCell("packSize","").ok,true);
  assert.deepEqual(checkRowCells(["#1","two","40-LB","P","x"],{code:0,qty:1,packSize:2,sellingUnit:3}),{sellingUnit:'"P" is not a unit KERDOS recognises'});
});

// --- remembered per vendor and layout in the organization's settings ---
test("answers are remembered per vendor and header layout",()=>{
  const settings=withRememberedLayout({price_refresh_days:7},"vendorA","item#|pk/sz|sell",{2:"packSize",3:"price"});
  assert.equal(settings.price_refresh_days,7);
  assert.deepEqual(rememberedLayout(settings,"vendorA","item#|pk/sz|sell"),{2:"packSize",3:"price"});
  assert.deepEqual(rememberedLayout(settings,"vendorB","item#|pk/sz|sell"),{});
  assert.deepEqual(rememberedLayout(settings,"vendorA","other"),{});
});

// --- end to end through the parser, three different vendor habits ---
test("unfamiliar headings are reported once and answered once",()=>{
  const sheet="SKU,Desc,Pk/Sz,Sell,Per\nA1,YUKON GOLD POTATOES,50 LB,17.90,CS\nA2,RED POTATOES,50 LB,16.50,CS";
  const first=parseDocument(sheet);
  assert.deepEqual(first.layout.unknown.map(h=>h.label),["Sell","Per"]); // Pk/Sz now recognized as packSize
  const answered=parseDocument(sheet,{layoutAnswers:{3:"price",4:"sellingUnit"}});
  assert.equal(answered.layout.unknown.length,0);
  assert.equal(answered.rows.length,2);
  assert.equal(answered.rows[0].packSize,"50 LB");assert.equal(answered.rows[0].price,17.9);assert.equal(answered.rows[0].sellingUnit,"CS");
});
test("a fully recognised header needs no question",()=>{
  const sheet="Item Number,Description,Pack Size,Price,Selling Unit\n1001,BOLT HEX 1/2 X 2,100 CT,22.00,BX";
  const r=parseDocument(sheet);
  assert.equal(r.layout.unknown.length,0);assert.equal(r.rows[0].packSize,"100 CT");assert.equal(r.rows[0].sellingUnit,"BX");
});
test("a failing cell is flagged on its row with the reason; the row is kept",()=>{
  const sheet="Item Number,Description,Pack Size,Price,Selling Unit\n1001,ROPE NYLON 3/8,600 FT,88.00,ROLL\n1002,ROPE NYLON 1/2,24/15.5,120.00,ZZ";
  const r=parseDocument(sheet);
  assert.equal(r.rows.length,2);
  assert.equal(r.rows[0].cellIssues,undefined);
  assert.match(r.rows[1].cellIssues.packSize,/not a complete pack/);
  assert.match(r.rows[1].cellIssues.sellingUnit,/not a unit/);
});
test("the choice list offers every meaning plus ignore",()=>{
  for(const role of COLUMN_ROLES_FOR_CHOICE)assert.ok(COLUMN_ROLE_LABELS[role],role);
});

console.log(`${passed} passed, 0 failed`);
