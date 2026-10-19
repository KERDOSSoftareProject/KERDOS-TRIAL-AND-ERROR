// Module G · Order Guide — Task 1 · Power Ranked
//
// Checklist:
//   [1] Normalize unit costs across different pack sizes
//   [2] Select the cheapest comparable offer
//   [3] Show the price difference for other offers
//   [4] Exclude stale and ineligible offers

import assert from "node:assert/strict";
import {orderable,rankVendorOffers,offerDollarDifference,solveOrder} from "../core/ordering.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// Minimal ordering-layer option — base case is a valid, eligible offer.
const opt=(vendorId,price,extra={})=>({
  vendorId,vendorName:vendorId,vendorItemId:`${vendorId}-item`,
  price,casePrice:price,packSize:"1 CS",
  matchTrack:"exact",matchConfidence:100,
  ...extra,
});

// Option with a per-unit price so rankVendorOffers can normalize by common unit.
const wopt=(vendorId,casePrice,perUnitPrice,unit="LB",packSize="1 CS",extra={})=>
  opt(vendorId,casePrice,{casePrice,packSize,perUnit:{price:perUnitPrice,unit},...extra});

let passed=0;
function run(label,fn){
  try{fn();console.log(`  ✓ ${label}`);passed++;}
  catch(err){console.error(`  ✗ ${label}\n    ${err.message}`);process.exitCode=1;}
}

// ---------------------------------------------------------------------------
// Checklist item 1 — Normalize unit costs across different pack sizes
// ---------------------------------------------------------------------------
console.log("\n[1] Normalize unit costs across different pack sizes");

run("ranks by per-unit cost when all options share a common weight unit",()=>{
  // 10-LB pack at $20 ($2/LB) vs 4-LB pack at $12 ($3/LB).
  // The 10-LB pack is cheaper per pound and must rank first.
  const options=[
    wopt("large-pack",20,2,"LB","1/10 LB"),
    wopt("small-pack",12,3,"LB","1/4 LB"),
  ];
  const ranked=rankVendorOffers(options);
  assert.equal(ranked[0].vendorId,"large-pack",
    "higher pack price / lower per-LB cost must win");
  assert.equal(ranked[0].difference,0,
    "the per-unit winner carries difference:0");
});

run("actual order price is the case price, not the normalized comparison price",()=>{
  // Ranking uses per-unit price, but the basket uses the real pack price.
  const options=[
    wopt("large-pack",20,2,"LB","1/10 LB"),
    wopt("small-pack",12,3,"LB","1/4 LB"),
  ];
  const ranked=rankVendorOffers(options);
  assert.equal(ranked[0].unitPrice,20,
    "order price must reflect the pack price, not the per-LB comparison price");
});

run("falls back to case price when options have no per-unit data",()=>{
  // No perUnit field → comparisonUnit is null → cheapest case price wins.
  const options=[opt("a",30),opt("b",25),opt("c",35)];
  const ranked=rankVendorOffers(options);
  assert.equal(ranked[0].vendorId,"b",
    "without perUnit, cheapest case price must rank first");
});

run("option with incompatible unit is marked unverified upstream and excluded from ranking",()=>{
  // App.jsx sets unverified:true on any orderable option that cannot share a
  // comparison unit with its peers.  When units disagree (LB vs OZ here),
  // the option without a usable perUnit is flagged before rankVendorOffers runs.
  // The test simulates that upstream mark and verifies exclusion, not case-price fallback.
  const options=[
    wopt("by-lb",20,2,"LB"),
    opt("by-oz",15,{unverified:true,
      qualificationReason:"Choose a shared comparison measurement or correct the pack before ranking alternatives"}),
  ];
  const ranked=rankVendorOffers(options);
  assert.equal(ranked.find(o=>o.vendorId==="by-oz").difference,null,
    "an option marked unverified must be excluded from ranking (difference:null)");
  assert.equal(ranked.find(o=>o.vendorId==="by-lb").difference,0,
    "the remaining eligible option anchors the ranking");
});

run("option without per-unit data is marked unverified upstream and excluded from ranking",()=>{
  // When some options carry perUnit and one does not, App.jsx marks the one
  // lacking perUnit as unverified — it cannot be compared on equal footing.
  // rankVendorOffers then excludes it via orderable(), not by silently
  // falling back to a case-price comparison.
  const options=[
    wopt("with-per-unit",20,2,"LB"),
    opt("without-per-unit",15,{unverified:true,
      qualificationReason:"Choose a shared comparison measurement or correct the pack before ranking alternatives"}),
  ];
  const ranked=rankVendorOffers(options);
  assert.equal(ranked.find(o=>o.vendorId==="without-per-unit").difference,null,
    "an option missing per-unit data must be excluded from ranking after being marked unverified");
  assert.equal(ranked.find(o=>o.vendorId==="with-per-unit").difference,0,
    "the eligible per-unit option anchors the ranking");
});

// ---------------------------------------------------------------------------
// Checklist item 2 — Select the cheapest comparable offer
// ---------------------------------------------------------------------------
console.log("\n[2] Select the cheapest comparable offer");

run("cheapest eligible offer ranks first with difference:0",()=>{
  const ranked=rankVendorOffers([opt("a",30),opt("b",25),opt("c",35)]);
  assert.equal(ranked[0].vendorId,"b");
  assert.equal(ranked[0].difference,0);
});

run("solveOrder assigns the cheapest eligible vendor and computes line total",()=>{
  const result=solveOrder([{
    catalogItemId:"item",quantity:2,orderUnit:"case",
    options:[opt("a",30),opt("b",25),opt("c",35)],
  }],[])[0];
  assert.equal(result.assignedVendorId,"b");
  assert.equal(result.lineTotal,50);
});

run("cheapest ineligible offer is skipped; next cheapest eligible offer wins",()=>{
  const ranked=rankVendorOffers([
    opt("cheapest-expired",20,{expired:true}),
    opt("next-valid",30),
  ]);
  assert.equal(ranked[0].vendorId,"next-valid",
    "an expired cheapest must not rank first");
  assert.equal(ranked[0].difference,0);
});

run("all options ineligible yields an unorderable item in solveOrder",()=>{
  const result=solveOrder([{
    catalogItemId:"item",quantity:1,orderUnit:"case",
    options:[
      opt("a",10,{expired:true}),
      opt("b",12,{priceUnavailable:true}),
    ],
  }],[])[0];
  assert.equal(result.unorderable,true);
  assert.equal(result.assignedVendorId,null);
});

run("forced vendor overrides the cheaper alternative",()=>{
  const result=solveOrder([{
    catalogItemId:"item",quantity:1,orderUnit:"case",
    forcedVendorId:"b",
    options:[opt("a",10),opt("b",15)],
  }],[])[0];
  assert.equal(result.assignedVendorId,"b");
  assert.equal(result.locked,true);
  assert.equal(result.premiumPaid,5);
});

run("negotiated price shifts the winner to the agreed vendor",()=>{
  // vendor-a quotes $12, vendor-b quotes $10.
  // A negotiated agreement drops vendor-a to $8 → vendor-a becomes cheapest.
  const options=[
    {...opt("vendor-a",12),casePrice:12},
    {...opt("vendor-b",10),casePrice:10},
  ];
  const ranked=rankVendorOffers(options,{"vendor-a":8});
  assert.equal(ranked[0].vendorId,"vendor-a",
    "a negotiated price below the quoted competitor must make that vendor the winner");
  assert.equal(ranked[0].difference,0);
});

// ---------------------------------------------------------------------------
// Checklist item 3 — Show the price difference for other offers
// ---------------------------------------------------------------------------
console.log("\n[3] Show the price difference for other offers");

run("equal packs: difference equals the raw price gap from the winner",()=>{
  const ranked=rankVendorOffers([opt("a",30),opt("b",35),opt("c",40)]);
  assert.deepEqual(
    ranked.map(o=>[o.vendorId,o.difference]),
    [["a",0],["b",5],["c",10]],
  );
});

run("ineligible options carry null difference",()=>{
  const ranked=rankVendorOffers([
    opt("valid",30),
    opt("expired-offer",25,{expired:true}),
  ]);
  const expiredEntry=ranked.find(o=>o.vendorId==="expired-offer");
  assert.equal(expiredEntry.difference,null,
    "an ineligible offer must have difference:null, not 0");
});

run("offerDollarDifference scales the premium to the best pack quantity",()=>{
  // best: 10-LB pack at $20 ($2/LB); other: 4-LB pack at $12 ($3/LB).
  // Buying the equivalent of 10 LB from the 4-LB vendor costs $30.
  // Dollar premium: $30 − $20 = $10.
  const options=[
    opt("large",20,{casePrice:20,packSize:"1/10 LB",perUnit:{price:2,unit:"LB"}}),
    opt("small",12,{casePrice:12,packSize:"1/4 LB", perUnit:{price:3,unit:"LB"}}),
  ];
  const ranked=rankVendorOffers(options);
  const best=ranked.find(o=>o.vendorId==="large");
  const other=ranked.find(o=>o.vendorId==="small");
  assert.equal(offerDollarDifference(other,best),10,
    "dollar difference must reflect the cost to buy the same quantity as the best pack");
});

run("offerDollarDifference returns null for an ineligible option",()=>{
  const best=opt("a",30);
  const blocked=opt("b",25,{expired:true});
  assert.equal(offerDollarDifference(blocked,best),null,
    "an ineligible option must not produce a dollar difference");
});

run("winner carries difference:0 even when its price was negotiated lower",()=>{
  const options=[
    {...opt("negotiated",12),casePrice:12},
    {...opt("competitor",10),casePrice:10},
  ];
  const ranked=rankVendorOffers(options,{"negotiated":8});
  assert.equal(ranked.find(o=>o.vendorId==="negotiated").difference,0);
  assert.ok((ranked.find(o=>o.vendorId==="competitor").difference??-1)>0,
    "the now-more-expensive competitor must carry a positive difference");
});

// ---------------------------------------------------------------------------
// Checklist item 4 — Exclude stale and ineligible offers
// ---------------------------------------------------------------------------
console.log("\n[4] Exclude stale and ineligible offers");

run("expired offer does not set the best price even when cheapest",()=>{
  const ranked=rankVendorOffers([
    opt("cheapest-expired",5,{expired:true}),
    opt("valid",15),
  ]);
  assert.equal(ranked.find(o=>o.vendorId==="valid").difference,0,
    "the valid offer must anchor the ranking");
  assert.equal(ranked.find(o=>o.vendorId==="cheapest-expired").difference,null);
});

run("invoiceOnly offer is excluded from the ranking",()=>{
  const ranked=rankVendorOffers([
    opt("invoice-priced",8,{invoiceOnly:true}),
    opt("quoted",12),
  ]);
  assert.equal(ranked.find(o=>o.vendorId==="quoted").difference,0,
    "an invoice-only offer must not set the benchmark price");
  assert.equal(ranked.find(o=>o.vendorId==="invoice-priced").difference,null);
});

run("priceUnavailable offer is excluded from the ranking",()=>{
  const ranked=rankVendorOffers([
    opt("no-price",0,{priceUnavailable:true}),
    opt("priced",20),
  ]);
  assert.equal(ranked.find(o=>o.vendorId==="priced").difference,0);
  assert.equal(ranked.find(o=>o.vendorId==="no-price").difference,null);
});

run("unverified offer is excluded from the ranking",()=>{
  const ranked=rankVendorOffers([
    opt("unverified-offer",7,{unverified:true}),
    opt("verified",18),
  ]);
  assert.equal(ranked.find(o=>o.vendorId==="verified").difference,0);
  assert.equal(ranked.find(o=>o.vendorId==="unverified-offer").difference,null);
});

run("basisUnconvertible offer is excluded from the ranking",()=>{
  const ranked=rankVendorOffers([
    opt("unconvertible",5,{basisUnconvertible:true,quoteBasis:"measure",quoteUnit:"LB"}),
    opt("convertible",22),
  ]);
  assert.equal(ranked.find(o=>o.vendorId==="convertible").difference,0);
  assert.equal(ranked.find(o=>o.vendorId==="unconvertible").difference,null);
});

run("mix of ineligible offers: only eligible offers determine the best price",()=>{
  // expired $5 (cheapest overall), invoice-only $8, valid $15.
  // The benchmark must be $15 — the only eligible offer.
  const ranked=rankVendorOffers([
    opt("expired-cheap",5,{expired:true}),
    opt("invoice-cheap",8,{invoiceOnly:true}),
    opt("valid-expensive",15),
  ]);
  const valid=ranked.find(o=>o.vendorId==="valid-expensive");
  assert.equal(valid.difference,0,
    "the only eligible offer must anchor the ranking");
  assert.equal(ranked.filter(o=>o.difference!==null).length,1,
    "exactly one offer must have a non-null difference");
});

// ---------------------------------------------------------------------------
console.log(`\nModule G · Task 1 · Power Ranked: ${passed} checks passed.\n`);
