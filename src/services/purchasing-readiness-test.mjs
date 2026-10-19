// Module F · Purchasing Readiness — Task 1 · Eligibility
//
// Checklist:
//   [1] Valid pack confirmed
//   [2] Quoted unit price available and current
//   [3] Brand resolved (brand_locked enforcement)
//   [4] Price staleness check against org price_refresh_days setting
//   [5] Stale items excluded from cheapest-pick and vendor minimum fill

import assert from "node:assert/strict";
import {quoteStatus} from "../procurement.js";
import {orderable,blockReason,rankVendorOffers,solveOrder} from "../core/ordering.js";
import {orderGuideAssessment} from "../core/catalog-fields.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const uuid=()=>Math.random().toString(36).slice(2)+Math.random().toString(36).slice(2);

// Minimal ordering-layer option — mirrors the shape in ordering-test.mjs.
const opt=(vendorId,price,extra={})=>({
  vendorId,vendorName:vendorId,vendorItemId:`${vendorId}-item`,price,casePrice:price,
  packSize:"24 CT",matchTrack:"exact",matchConfidence:100,...extra,
});

// A fully-ready orderGuideAssessment input.  Every field passes at >= DERIVED(90)
// so any single mutation clearly shows what it breaks.
function readyInput(itemOverrides={},viOverrides={},mappingOverrides={}){
  const itemId=uuid(),viId=uuid(),mappingId=uuid();
  const category={id:"cat-1",organization_id:"org-1",name:"Produce",is_holding_pen:false};
  const item={
    id:itemId,organization_id:"org-1",name:"Romaine Hearts 12ct",
    category_id:"cat-1",category_review:false,category_reason:"confirmed",
    matching_behavior:"flexible",comparison_mode:"alternatives",brand_locked:false,
    master_item_number:null,
    ...itemOverrides,
  };
  const vendorItem={
    id:viId,organization_id:"org-1",vendor_id:"vendor-1",
    description:"Romaine Hearts 12ct",
    pack_size:"24 CT",
    selling_unit:"CS",
    price:12.50,price_unavailable:false,
    import_row:{reviewRequired:false},
    field_resolutions:{row_approval:true},
    row_revision:1,
    ...viOverrides,
  };
  const mapping={
    id:mappingId,organization_id:"org-1",
    catalog_item_id:itemId,vendor_item_id:viId,
    comparison_track:"exact",confidence_score:100,match_method:"manual",
    ...mappingOverrides,
  };
  return {item,vendorItem,mapping,category};
}

let passed=0;
function run(label,fn){
  try{fn();console.log(`  ✓ ${label}`);passed++;}
  catch(err){console.error(`  ✗ ${label}\n    ${err.message}`);process.exitCode=1;}
}

// ---------------------------------------------------------------------------
// Checklist item 1 — Valid pack confirmed
// ---------------------------------------------------------------------------
console.log("\n[1] Valid pack confirmed");

run("orderable() rejects a null packSize",()=>{
  assert.equal(orderable(opt("v",10,{packSize:null})),false);
});

run("orderable() rejects basisUnconvertible",()=>{
  assert.equal(orderable(opt("v",10,{basisUnconvertible:true,quoteBasis:"measure",quoteUnit:"LB"})),false);
  assert.match(blockReason(opt("v",10,{basisUnconvertible:true,quoteBasis:"measure",quoteUnit:"LB"})),/per LB/);
});

run("orderable() accepts a valid pack",()=>{
  assert.equal(orderable(opt("v",10)),true,"standard pack must be orderable");
});

run("orderGuideAssessment reports unitCost blocker when pack is unparseable",()=>{
  // An unparseable pack_size leaves casePrice null which triggers the unitCost blocker.
  const {item,vendorItem,mapping,category}=readyInput({},{pack_size:"???"});
  const result=orderGuideAssessment({item,vendorItem,mapping,peers:[],category,categories:[category]});
  assert.ok(result.blockers.includes("pack")||result.blockers.includes("unitCost"),
    `expected pack or unitCost blocker; got ${JSON.stringify(result.blockers)}`);
  assert.equal(result.ready,false,"unparseable pack must not be ready");
});

run("orderGuideAssessment ready with a known parseable pack",()=>{
  const {item,vendorItem,mapping,category}=readyInput();
  const result=orderGuideAssessment({item,vendorItem,mapping,peers:[],category,categories:[category]});
  assert.equal(result.ready,true,
    `fully-ready fixture must pass; blockers: ${JSON.stringify(result.blockers)}`);
});

// ---------------------------------------------------------------------------
// Checklist item 2 — Quoted unit price available and current
// ---------------------------------------------------------------------------
console.log("\n[2] Quoted unit price available and current");

run("quoteStatus returns invoice_only for invoice-sourced price",()=>{
  assert.equal(quoteStatus({price_source:"invoice",price:40}),"invoice_only");
});

run("quoteStatus returns unavailable when price is zero or absent",()=>{
  assert.equal(quoteStatus({price:0,price_source:"price_list"}),"unavailable");
  assert.equal(quoteStatus({}),"unavailable");
});

run("quoteStatus returns current for a fresh manual quote",()=>{
  const now=new Date("2026-10-19");
  assert.equal(
    quoteStatus({price:12.50,last_updated:"2026-10-01"},{price_refresh_mode:"manual"},now),
    "current"
  );
});

run("orderable() rejects priceUnavailable and invoiceOnly flags",()=>{
  assert.equal(orderable(opt("v",10,{priceUnavailable:true})),false);
  assert.equal(orderable(opt("v",10,{invoiceOnly:true})),false);
});

run("orderGuideAssessment adds quote blocker when price_unavailable",()=>{
  const {item,vendorItem,mapping,category}=readyInput({},{price:null,price_unavailable:true});
  const result=orderGuideAssessment({item,vendorItem,mapping,peers:[],category,categories:[category]});
  assert.ok(result.blockers.includes("quote")||result.blockers.includes("expired"),
    `expected quote/expired blocker; got ${JSON.stringify(result.blockers)}`);
  assert.equal(result.ready,false);
});

// ---------------------------------------------------------------------------
// Checklist item 3 — Brand resolved
// ---------------------------------------------------------------------------
console.log("\n[3] Brand resolved");

run("orderable() rejects brandMismatch",()=>{
  assert.equal(orderable(opt("v",10,{brandMismatch:true})),false);
  assert.match(blockReason(opt("v",10,{brandMismatch:true,brand:"Chiquita"})),/Chiquita/);
});

run("orderGuideAssessment adds brand blocker when brand_locked and vendor brand mismatches",()=>{
  const {item,vendorItem,mapping,category}=readyInput(
    {brand_locked:true,locked_brand:"Dole"},
    {brand:"Chiquita"}
  );
  const result=orderGuideAssessment({item,vendorItem,mapping,peers:[],category,categories:[category]});
  assert.ok(result.blockers.includes("brand"),
    `expected brand blocker; got ${JSON.stringify(result.blockers)}`);
  assert.equal(result.ready,false);
});

run("orderGuideAssessment passes when brand_locked and brand matches",()=>{
  const {item,vendorItem,mapping,category}=readyInput(
    {brand_locked:true,locked_brand:"Dole"},
    {brand:"Dole"}
  );
  const result=orderGuideAssessment({item,vendorItem,mapping,peers:[],category,categories:[category]});
  assert.ok(!result.blockers.includes("brand"),
    `brand blocker must be absent when brands match; blockers: ${JSON.stringify(result.blockers)}`);
});

run("orderGuideAssessment passes when brand_locked is false regardless of vendor brand",()=>{
  const {item,vendorItem,mapping,category}=readyInput(
    {brand_locked:false},
    {brand:"Chiquita"}
  );
  const result=orderGuideAssessment({item,vendorItem,mapping,peers:[],category,categories:[category]});
  assert.ok(!result.blockers.includes("brand"),
    `no brand blocker expected when brand_locked is false; blockers: ${JSON.stringify(result.blockers)}`);
});

// ---------------------------------------------------------------------------
// Checklist item 4 — Price staleness check against org price_refresh_days
// ---------------------------------------------------------------------------
console.log("\n[4] Price staleness check against org price_refresh_days");

run("manual mode never expires a quote by age alone",()=>{
  const now=new Date("2026-10-19");
  // Even with a price_refresh_days setting, manual mode keeps the quote current.
  assert.equal(
    quoteStatus({price:20,last_updated:"2020-01-01"},{price_refresh_mode:"manual",price_refresh_days:7},now),
    "current"
  );
});

run("legacy day-count without explicit mode does not silently expire",()=>{
  // price_refresh_days alone (no price_refresh_mode:'automatic') must not expire.
  const now=new Date("2026-10-19");
  assert.equal(
    quoteStatus({price:20,last_updated:"2020-01-01"},{price_refresh_days:7},now),
    "current"
  );
});

run("automatic mode returns current for a fresh quote within the window",()=>{
  const now=new Date("2026-10-19");
  const twoDaysAgo=new Date(now.getTime()-2*86400000).toISOString();
  assert.equal(
    quoteStatus({price:20,last_updated:twoDaysAgo},{price_refresh_mode:"automatic",price_refresh_days:7},now),
    "current"
  );
});

run("automatic mode expires a quote that is older than price_refresh_days",()=>{
  const now=new Date("2026-10-19");
  const tenDaysAgo=new Date(now.getTime()-10*86400000).toISOString();
  assert.equal(
    quoteStatus({price:20,last_updated:tenDaysAgo},{price_refresh_mode:"automatic",price_refresh_days:7},now),
    "expired"
  );
});

run("automatic mode expires a quote with no last_updated timestamp",()=>{
  const now=new Date("2026-10-19");
  assert.equal(
    quoteStatus({price:20},{price_refresh_mode:"automatic",price_refresh_days:7},now),
    "expired"
  );
});

run("vendor-stated price_quote_valid_until expires regardless of mode",()=>{
  // A vendor-supplied expiry date is honoured even in manual mode.
  const now=new Date(2026,9,19,12); // 2026-10-19 noon
  assert.equal(
    quoteStatus({price:20,price_quote_valid_until:"2026-10-18",last_updated:"2026-10-19"},
      {price_refresh_mode:"manual"},now),
    "expired"
  );
});

// ---------------------------------------------------------------------------
// Checklist item 5 — Stale items excluded from cheapest-pick and vendor minimum fill
// ---------------------------------------------------------------------------
console.log("\n[5] Stale items excluded from cheapest-pick and vendor minimum fill");

run("rankVendorOffers picks the cheapest non-expired option, not the cheapest overall",()=>{
  // vendor-a is cheapest at $8 but its quote is expired.
  // vendor-b quotes $12 and is current.
  const options=[
    opt("vendor-a",8,{expired:true}),
    opt("vendor-b",12),
  ];
  const ranked=rankVendorOffers(options,null);
  // The eligible winner (vendor-b) must sort first.
  assert.equal(ranked[0].vendorId,"vendor-b","expired cheapest must not become the winner");
  assert.equal(ranked[0].difference,0,"the eligible winner must have difference:0");
  // vendor-a must not have a difference (it is blocked, not ranked).
  assert.equal(ranked.find(o=>o.vendorId==="vendor-a")?.difference,null,
    "expired option must have null difference");
});

run("solveOrder assigns the cheapest non-expired vendor",()=>{
  const options=[opt("vendor-a",8,{expired:true}),opt("vendor-b",12)];
  const result=solveOrder([{catalogItemId:"item",quantity:2,orderUnit:"case",options}],[])[0];
  assert.equal(result.assignedVendorId,"vendor-b","stale-only cheapest must not be assigned");
  assert.equal(result.lineTotal,24,"line total must use the current vendor's price");
  assert.equal(result.unorderable,false);
});

run("solveOrder marks item unorderable when ALL options are expired",()=>{
  const options=[opt("vendor-a",8,{expired:true}),opt("vendor-b",10,{expired:true})];
  const result=solveOrder([{catalogItemId:"item",quantity:1,orderUnit:"case",options}],[])[0];
  assert.equal(result.unorderable,true,"all-expired options must yield an unorderable line");
  assert.equal(result.assignedVendorId,null);
});

run("vendor minimum fill does not route through an expired option",()=>{
  // vendor-a has a $60 minimum; it has two items but one is expired.
  // The valid fill for vendor-a is only $30, below the $60 minimum.
  // solveOrder must not count the expired option toward vendor-a's minimum.
  const vendors=[{id:"vendor-a",name:"Vendor A",delivery_minimum_dollar:60}];
  const cartItems=[
    {
      catalogItemId:"item-x",quantity:1,orderUnit:"case",
      options:[
        opt("vendor-a",30),              // valid, $30
        opt("vendor-b",25),              // valid, $25 — cheapest
      ],
    },
    {
      catalogItemId:"item-y",quantity:1,orderUnit:"case",
      options:[
        opt("vendor-a",50,{expired:true}), // expired — cannot be used
        opt("vendor-b",45),                // valid
      ],
    },
  ];

  const assignments=solveOrder(cartItems,vendors);

  // vendor-a cannot reach $60 with only item-x's $30 (item-y's option is expired).
  // The fill loop must not assign item-y to vendor-a via an expired option.
  const itemY=assignments.find(a=>a.catalogItemId==="item-y");
  assert.notEqual(itemY.assignedVendorId,"vendor-a",
    "expired option must not be used to satisfy vendor minimum fill");
});

// ---------------------------------------------------------------------------
console.log(`\nModule F · Task 1 · Eligibility: ${passed} checks passed.\n`);
