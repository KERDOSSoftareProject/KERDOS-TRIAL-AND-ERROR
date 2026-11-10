import assert from "node:assert/strict";
import {parseDocument,placeDocumentFields} from "../ingestion.js";
import {identifyRowFields} from "./field-identification.js";
import {inferDetailBrand,interpretDocumentFields} from "./document-interpretation.js";
import {placeStructuredDocument,parseStructuredDocument} from "./document-structuring.js";
import {configureProcurement,createProcurementContext} from "../procurement.js";

const layout = {
  cells: ["$25.10", "Long Supplier Brand", "American Cheese\nWhite Sliced"],
  columnMap: {price: 0, brand: 1, description: 2},
  sourceHeaders: ["Price", "Brand", "Description"],
  fieldOrigins: {price: "stated", brand: "stated", description: "stated"},
  rowIndex: 7,
};
const original = structuredClone(layout);
const bound = identifyRowFields(layout);
assert.equal(bound.anchor.status, "identified");
assert.equal(bound.anchor.rawValue, "American Cheese\nWhite Sliced");
assert.deepEqual(bound.bindings.price, {
  rowIndex: 7, columnIndex: 0, header: "Price", rawValue: "$25.10", evidence: "stated",
});
assert.equal(bound.values.brand, "Long Supplier Brand");
assert.deepEqual(layout, original);

const repeated = parseDocument([
  "Code,Description,Brand,Pack,Price Unit,Price",
  "B4-001,,Long Brand,12/1 QT,CASE,25.10",
  "Price,Pack,Brand,Description,Price Unit,Code",
  "26.20,12/1 QT,Other Brand,Eggs,CASE,B4-002",
].join("\n")).rows;
assert.deepEqual(repeated.map(row => [row.description, row.brand, row.price]), [
  ["", "Long Brand", 25.1], ["Eggs", "Other Brand", 26.2],
]);
assert.equal(repeated[0].fieldIdentification.anchor.rawValue, "");
assert.equal(repeated[0].fieldIdentification.anchor.status, "missing");
assert.equal(repeated[1].fieldIdentification.anchor.columnIndex, 3);
assert.equal(repeated[1].fieldIdentification.anchor.status, "identified");
assert.equal(repeated[1].fieldIdentification.bindings.price.columnIndex, 0);

const [unassigned] = parseDocument("Brand,Pack,Tariff\nLong Brand,12/1 QT,25.10", {
  layoutAnswers: {2: "price"},
}).rows;
assert.equal(unassigned.description, "");
assert.equal(unassigned.requiresReview, true);
assert.equal(unassigned.brand, "Long Brand");
assert.equal(unassigned.fieldIdentification.anchor.columnIndex, null);
assert.equal(unassigned.fieldIdentification.bindings.price.evidence, "remembered");
assert.equal(unassigned.fieldIdentification.bindings.price.rawValue, "25.10");

const [ignored] = parseDocument("Description,Brand,Price\nMilk,Brand A,25.10", {
  layoutAnswers: {0: "ignore"},
}).rows;
assert.equal(ignored.description, "");
assert.equal(ignored.fieldIdentification.bindings.description, undefined);
assert.ok(!ignored.details.includes("Milk"));

const [ambiguous] = parseDocument("Product Price,Pack\n25.10,20 LB").rows;
assert.equal(ambiguous.description, "");
assert.equal(ambiguous.price, 25.1);
assert.equal(ambiguous.fieldIdentification.anchor.status, "ambiguous");
assert.deepEqual(ambiguous.fieldIdentification.anchor.conflicts, ["price"]);
assert.ok(ambiguous.issues.some(issue => issue.kind === "ambiguous-description"));

const inferred = parseDocument("Chicken Breast,20 LB,25.10\nTurkey Breast,30 LB,26.20").rows;
assert.deepEqual(inferred.map(row => row.fieldIdentification.anchor.rawValue), ["Chicken Breast", "Turkey Breast"]);
assert.ok(inferred.every(row => row.fieldIdentification.anchor.status === "inferred"));
assert.ok(inferred.every(row => row.fieldIdentification.bindings.price.evidence === "inferred"));

const blocks = parseDocument("Description,Brand,Price,Description,Brand,Price\nMilk,Brand A,25.10,Eggs,Brand B,26.20").rows;
assert.deepEqual(blocks.map(row => row.fieldIdentification.anchor.columnIndex), [0, 3]);
assert.deepEqual(blocks.map(row => row.fieldIdentification.bindings.price.columnIndex), [2, 5]);
assert.deepEqual(blocks.map(row => row.fieldIdentification.anchor.rowIndex), [1, 1]);

console.log("PASS B4 field binding: raw values, evidence origins, ignored/ambiguous descriptions, and coordinates across repeated layouts.");

const source = "Code,Description,Pack,Price Unit,Price,Note\nM-301,BRIGHT  PAPER 5 RLX,,CASE,20.40,Acme\nM-302,LINER 4/10 LB,2/5 LB,CASE,21.75,Acme";
const settings = {vocabulary:[{kind:"unit",term:"rlx",canonical:"LB"}]};
const placed = placeDocumentFields(source);
const untouched = structuredClone(placed);
configureProcurement(settings);
try {
  assert.deepEqual(placeDocumentFields(source),untouched,"the active workspace cannot change placement");
} finally {
  configureProcurement();
}
const [unfilled,stated] = placed.rows;
assert.equal(unfilled.description,"BRIGHT  PAPER 5 RLX");
assert.equal(unfilled.fieldIdentification.anchor.rawValue,unfilled.description);
assert.equal(unfilled.packSize,null);
assert.equal(unfilled.brand,null);
assert.deepEqual(unfilled.details,["Acme"]);
assert.equal(unfilled.fieldValidation.fields.packSize.accuracy,0);
assert.equal(stated.packSize,"2/5 LB");
assert.equal(stated.fieldValidation.fields.packSize.accuracy,100);

const configured = createProcurementContext(settings);
const inferredRow = interpretDocumentFields(placed,configured).rows[0];
assert.equal(interpretDocumentFields(placed,createProcurementContext()).rows[0].packSize,null);
assert.equal(inferredRow.packSize,"5 RLX");
assert.equal(inferredRow.sourceDescription,unfilled.description);
assert.equal(inferredRow.fieldInference.packSize.kind,"inferred");
assert.equal(inferredRow.fieldInference.packSize.accuracy,90);
assert.equal(inferredRow.fieldInference.packSize.evidence.rawValue,unfilled.description);
assert.equal(inferredRow.fieldInference.packSize.evidence.columnIndex,1);
assert.equal(inferredRow.fieldValidation.fields.packSize.accuracy,0,"inference never rewrites source validation");
assert.equal(interpretDocumentFields(placed,configured).rows[1].packSize,"2/5 LB","description cannot replace a stated pack");
const brand = inferDetailBrand(inferredRow,["Acme"],configured);
assert.equal(brand.brand,"Acme");
assert.equal(brand.fieldInference.brand.kind,"inferred");
assert.equal(brand.fieldInference.brand.accuracy,70);
assert.equal(brand.fieldInference.brand.evidence.rawValue,"Acme");
assert.deepEqual(placed,untouched,"interpretation must leave source placements immutable");

const worksheetRows=source.split("\n").map(line=>line.split(","));
const reading={kind:"workbook",filename:"boundary.xlsx",worksheets:[{
  name:"Prices",text:source,rows:worksheetRows,
  cells:worksheetRows.flatMap((cells,row)=>cells.map((value,column)=>({row,column,value,address:String.fromCharCode(65+column)+(row+1)}))),
}]};
const structured=placeStructuredDocument(source,reading);
assert.equal(structured.rows[0].packSize,null);
assert.equal(structured.rows[0].sourceProvenance.worksheet,"Prices");
const combined=parseStructuredDocument(source,reading,undefined,configured);
assert.equal(combined.rows[0].packSize,"5 RLX");
assert.deepEqual(combined.rows[0].sourceProvenance,structured.rows[0].sourceProvenance);
console.log("PASS B/C handoff: neutral placement, immutable wording and coordinates, workspace-scoped inference, and distinct source and inference evidence.");
