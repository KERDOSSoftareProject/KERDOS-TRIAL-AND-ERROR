import assert from "node:assert/strict";
import {parseDocument} from "../ingestion.js";
import {identifyRowFields} from "./field-identification.js";

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
