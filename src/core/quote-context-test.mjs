import assert from "node:assert/strict";
import {configureCategoryProfile,quoteContext} from "../knowledge/category-profiles.js";
import {explainImportRow} from "./import-evidence.js";

const bacon={code:"47432",description:"BACON LAYOUT 18-22 FROZEN",packSize:"1/15 LB",price:3.83,sellingUnit:null};
const rows=[bacon,
  {description:"CHIC BRST RAW BNLS",packSize:"4/10 LB",price:2.05},
  {description:"CHEESE AMER SLI 160 WHITE",packSize:"4/5 LB",price:2.45},
  {description:"PROD CARROT CUT",packSize:"1/50 LB",price:28.9},
];
configureCategoryProfile("restaurant");
const suggested=quoteContext(bacon,rows);
assert.equal(suggested?.sellingUnit,"LB");
assert.equal(suggested?.accuracy,90);
assert.match(suggested.reason,/57\.45 per case/);
const explained=explainImportRow(bacon,{documentRows:rows});
assert.equal(explained.priceBasis.accuracy,null);
assert.equal(explained.unitCost.value,null);
assert.equal(explained.unitSuggestion.sellingUnit,"LB");
assert.equal(explained.unitSuggestion.accuracy,70);
assert.equal(quoteContext(rows[3],rows),null,"produce case quote is not made per-pound from price alone");
configureCategoryProfile("construction");
assert.equal(quoteContext(bacon,rows),null,"industry-neutral core cannot apply restaurant clues in construction");
console.log("KERDOS industry quote-context tests passed");
