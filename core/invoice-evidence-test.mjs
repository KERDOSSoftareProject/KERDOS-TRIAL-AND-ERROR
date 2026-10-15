import assert from "node:assert/strict";
import {invoiceEvidence} from "./invoice-evidence.js";

const invoice={row:{code:"1001",description:"Chicken Breast",packSize:"4/10 LB",sellingUnit:"LB"},number:"INV-42"};
const missing=invoiceEvidence({code:"1001",description:"Chicken Breast",packSize:"",price:30},[invoice]);
assert.equal(missing.suggestions.packSize.value,"4/10 LB");
assert.equal(missing.suggestions.sellingUnit.value,"LB");
assert.equal(missing.suggestions.price,undefined,"Invoice payment cannot become a price-sheet quote");
assert.equal(missing.conflicts.length,0);
const wrongProduct=invoiceEvidence({code:"1001",description:"American Cheese",packSize:""},[invoice]);
assert.equal(wrongProduct.matches.length,0);
assert.match(wrongProduct.conflicts[0],/different product/);
const wrongPack=invoiceEvidence({code:"1001",description:"Chicken Breast",packSize:"2/10 LB"},[invoice]);
assert.ok(wrongPack.conflicts.some(message=>message.includes("packSize")));
assert.equal(invoiceEvidence({code:"1002",description:"Chicken Breast"},[invoice]).matches.length,0);
console.log("Invoice evidence cross-reference tests passed");
