// Module G · Order Guide — Task 4 · Export
//
// Checklist:
//   [1] Full Catalog Export — every item, best price, all vendor prices side by side
//   [2] Price Variance Report — invoice overcharges vs quoted price (both signs)
//   [3] CSV baseline format — commas, quotes, newlines, carriage returns

import assert from "node:assert/strict";
import {buildCatalogExportCSV,buildVarianceReportCSV} from "../reporting.js";
import {formatMoney} from "../localization.js";

let passed=0;
function run(label,fn){
  try{fn();console.log(`  ✓ ${label}`);passed++;}
  catch(err){console.error(`  ✗ ${label}\n    ${err.message}`);process.exitCode=1;}
}

// Minimal orderable option shape (matches orderable()'s 8 conditions).
const opt=(vendorId,name,price,extra={})=>({
  vendorId,vendorName:name,
  price,casePrice:price,
  packSize:"1 CS",
  matchTrack:"exact",matchConfidence:100,
  ...extra,
});

// ── [1] Catalog Export ─────────────────────────────────────────────────────
console.log("\n[1] Full Catalog Export");

run("every item appears and vendor columns follow vendor-array order",()=>{
  const vendors=[{id:"v1",name:"Vendor 1"},{id:"v2",name:"Vendor 2"}];
  const productList=[
    {name:"Apples",category:"Produce",options:[opt("v1","Vendor 1",10),opt("v2","Vendor 2",12)]},
    {name:"Butter",category:"Dairy",  options:[opt("v2","Vendor 2",8)]},
  ];
  const rows=buildCatalogExportCSV(productList,vendors).split("\r\n");
  // Header: 7 fixed + 2 vendor columns
  const header=rows[0].split(",");
  assert.equal(header[7],"Vendor 1","first vendor column must follow vendor-array order");
  assert.equal(header[8],"Vendor 2","second vendor column must follow vendor-array order");
  assert.equal(rows.length,3,"header + 2 data rows");
  // Apples: both vendor prices filled
  const apples=rows[1].split(",");
  assert.equal(apples[7],formatMoney(10),"Vendor 1 price in its column");
  assert.equal(apples[8],formatMoney(12),"Vendor 2 price in its column");
  // Butter: Vendor 1 column empty, Vendor 2 filled
  const butter=rows[2].split(",");
  assert.equal(butter[7],"","Vendor 1 cell empty when vendor has no offer for that item");
  assert.equal(butter[8],formatMoney(8),"Vendor 2 price in its column");
});

run("Best Price uses the cheapest eligible offer, not the cheapest overall",()=>{
  const vendors=[{id:"v1",name:"Vendor 1"},{id:"v2",name:"Vendor 2"}];
  // v1 is cheaper overall but its quote is expired; v2 is the cheapest eligible.
  const productList=[{
    name:"Eggs",category:"Dairy",
    options:[opt("v1","Vendor 1",5,{expired:true}),opt("v2","Vendor 2",8)],
  }];
  const rows=buildCatalogExportCSV(productList,vendors).split("\r\n");
  const data=rows[1].split(",");
  assert.equal(data[2],formatMoney(8),"Best Price must use the cheapest eligible offer");
  assert.equal(data[3],"Vendor 2","Best Vendor must match the cheapest eligible offer");
});

run("ineligible offer price appears in its vendor column but does not win Best Price",()=>{
  const vendors=[{id:"v1",name:"Vendor 1"},{id:"v2",name:"Vendor 2"}];
  // v1 has a known price but the quote is expired — ineligible for Best Price.
  // v2 is orderable and more expensive.
  const productList=[{
    name:"Flour",category:"Dry Goods",
    options:[opt("v1","Vendor 1",5,{expired:true}),opt("v2","Vendor 2",9)],
  }];
  const rows=buildCatalogExportCSV(productList,vendors).split("\r\n");
  const data=rows[1].split(",");
  // Vendor columns (indices 7 and 8): v1's known price must appear even though expired.
  assert.equal(data[7],formatMoney(5),"ineligible offer price must appear in its vendor column");
  assert.equal(data[8],formatMoney(9),"orderable offer price must appear in its vendor column");
  // Best Price must be the cheapest ELIGIBLE offer (v2), not the cheapest overall (v1).
  assert.equal(data[2],formatMoney(9),"Best Price must not use an ineligible offer");
  assert.equal(data[3],"Vendor 2","Best Vendor must match the cheapest eligible offer");
});

run("item with no eligible offer still appears — Best Price and Best Vendor are empty",()=>{
  const vendors=[{id:"v1",name:"Vendor 1"}];
  const productList=[{
    name:"OldItem",category:"Produce",
    options:[opt("v1","Vendor 1",10,{expired:true})],
  }];
  const rows=buildCatalogExportCSV(productList,vendors).split("\r\n");
  assert.equal(rows.length,2,"header + 1 data row — item must appear even with no eligible offer");
  const data=rows[1].split(",");
  assert.equal(data[2],"","Best Price must be empty when no offer is eligible");
  assert.equal(data[3],"","Best Vendor must be empty when no offer is eligible");
});

// ── [2] Variance Report ────────────────────────────────────────────────────
console.log("\n[2] Price Variance Report");

const vendorList=[{id:"vend-a",name:"Acme Meats"}];

run("lines below the $0.005 rounding threshold are excluded",()=>{
  const invoices=[{
    invoice_date:"2026-10-01",vendor_id:"vend-a",invoice_number:"INV-1",
    invoice_lines:[
      {description:"Beef",   unit_price:20,line_total:200,price_variance:0.004},   // excluded
      {description:"Pork",   unit_price:15,line_total:150,price_variance:-0.004},  // excluded
      {description:"Chicken",unit_price:12,line_total:120,price_variance:0.005},   // included (at threshold)
    ],
  }];
  const rows=buildVarianceReportCSV(invoices,vendorList).split("\r\n");
  assert.equal(rows.length,2,"only lines at or above the threshold must appear");
  assert.ok(rows[1].includes("Chicken"),"the threshold line must be included");
});

run("overcharges and undercharges both appear",()=>{
  const invoices=[{
    invoice_date:"2026-10-05",vendor_id:"vend-a",invoice_number:"INV-2",
    invoice_lines:[
      {description:"Overcharged item", unit_price:22,line_total:220,price_variance:2},
      {description:"Undercharged item",unit_price:18,line_total:180,price_variance:-1.5},
    ],
  }];
  const rows=buildVarianceReportCSV(invoices,vendorList).split("\r\n");
  assert.equal(rows.length,3,"header + 2 variance lines");
  const over=rows[1].split(",");
  const under=rows[2].split(",");
  // Column 6 = Difference = formatMoney(price_variance)
  assert.equal(over[6], formatMoney(2),  "overcharge Difference must be positive");
  assert.equal(under[6],formatMoney(-1.5),"undercharge Difference must be negative");
});

run("line total impact scales per-unit variance by quantity",()=>{
  // unit_price=$10, line_total=$50 → qty=5; variance=$1 → impact=$5
  const invoices=[{
    invoice_date:"2026-10-10",vendor_id:"vend-a",invoice_number:"INV-3",
    invoice_lines:[{description:"Tomatoes",unit_price:10,line_total:50,price_variance:1}],
  }];
  const rows=buildVarianceReportCSV(invoices,vendorList).split("\r\n");
  const data=rows[1].split(",");
  // Column 7 = Line Total Impact
  assert.equal(data[7],formatMoney(5),"impact must equal variance × quantity (1 × 5 = $5.00)");
});

// ── [3] CSV baseline format ────────────────────────────────────────────────
console.log("\n[3] CSV baseline format — escaping");

run("comma in a cell is quoted per RFC 4180",()=>{
  const vendors=[{id:"v1",name:"Vendor 1"}];
  const productList=[{name:"Salt, Kosher",category:"Spices",options:[opt("v1","Vendor 1",5)]}];
  const csv=buildCatalogExportCSV(productList,vendors);
  assert.ok(csv.includes('"Salt, Kosher"'),"cell containing comma must be double-quoted");
});

run("double-quote in a cell is doubled and the cell is quoted",()=>{
  const vendors=[{id:"v1",name:"Vendor 1"}];
  const productList=[{name:'6" Roll',category:"Bakery",options:[opt("v1","Vendor 1",3)]}];
  const csv=buildCatalogExportCSV(productList,vendors);
  assert.ok(csv.includes('"6"" Roll"'),'embedded double-quote must be doubled; cell must be quoted');
});

run("line feed (\\n) in a cell is quoted per RFC 4180",()=>{
  const vendors=[{id:"v1",name:"Vendor 1"}];
  const productList=[{name:"Line\nBreak",category:"Other",options:[opt("v1","Vendor 1",4)]}];
  const csv=buildCatalogExportCSV(productList,vendors);
  assert.ok(csv.includes('"Line\nBreak"'),"cell containing LF must be double-quoted");
});

run("carriage return (\\r) in a cell is quoted per RFC 4180",()=>{
  const vendors=[{id:"v1",name:"Vendor 1"}];
  const productList=[{name:"CR\rValue",category:"Other",options:[opt("v1","Vendor 1",4)]}];
  const csv=buildCatalogExportCSV(productList,vendors);
  assert.ok(csv.includes('"CR\rValue"'),"cell containing bare CR must be double-quoted");
});

// ──────────────────────────────────────────────────────────────────────────
const total=11;
console.log(`\nModule G · Task 4 · Export: ${passed}/${total} checks passed.\n`);
