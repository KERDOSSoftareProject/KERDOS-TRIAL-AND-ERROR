import assert from "node:assert/strict";
import {blockReason,orderable,priceForOffer,rankVendorOffers,offerDollarDifference,solveOrder} from "./ordering.js";
const option=(vendorId,price,extra={})=>({vendorId,vendorName:vendorId,vendorItemId:`${vendorId}-item`,price,packSize:"1 CT",matchTrack:"exact",matchConfidence:100,...extra});
assert.equal(orderable(option("a",10)),true);
assert.equal(orderable(option("a",10,{matchTrack:"new"})),false);
assert.equal(orderable(option("a",10,{matchConfidence:99})),false);
assert.equal(orderable(option("a",10,{packSize:null})),false);
assert.equal(orderable(option("a",10,{expired:true})),false);
assert.equal(orderable(option("a",10,{basisUnconvertible:true,quoteBasis:"measure",quoteUnit:"LB"})),false);
assert.match(blockReason(option("a",10,{basisUnconvertible:true,quoteBasis:"measure",quoteUnit:"LB"})),/per LB/);
const variable=option('variable',4,{packSize:'2/6-8 LBA',casePrice:null,basisUnconvertible:true,quoteBasis:'measure',quoteUnit:'LB'});
assert.equal(orderable(variable),false);
assert.match(blockReason(variable),/variable case weight/);
const variableOrder=solveOrder([{catalogItemId:'variable',quantity:2,orderUnit:'case',options:[variable]}],[])[0];
assert.equal(variableOrder.unorderable,true);assert.equal(variableOrder.lineTotal,0,'raw rate or estimate cannot become a basket charge');
assert.equal(blockReason(option("a",10,{priceUnavailable:true})),"No current quoted price");
const cheapest=solveOrder([{catalogItemId:"item",quantity:2,orderUnit:"case",options:[option("a",10),option("b",12)]}],[])[0];
assert.equal(cheapest.assignedVendorId,"a");assert.equal(cheapest.lineTotal,20);
const forced=solveOrder([{catalogItemId:"item",quantity:1,orderUnit:"case",forcedVendorId:"b",options:[option("a",10),option("b",12)]}],[])[0];
assert.equal(forced.assignedVendorId,"b");assert.equal(forced.locked,true);
const blocked=solveOrder([{catalogItemId:"item",quantity:1,orderUnit:"case",options:[option("a",10,{expired:true})]}],[])[0];
assert.equal(blocked.unorderable,true);
const split=solveOrder([
  {catalogItemId:"item",quantity:3,orderUnit:"case",forcedVendorId:"a",options:[option("a",10),option("b",12)]},
  {catalogItemId:"item_split_case",quantity:2,orderUnit:"case",forcedVendorId:"b",options:[option("a",10),option("b",12)]},
],[]);
assert.deepEqual(split.map(line=>[line.assignedVendorId,line.quantity,line.lineTotal]),[["a",3,30],["b",2,24]],"short stock can be allocated across two vendor baskets");
const quotes=[{...option("a",12),casePrice:12,eachPrice:3},{...option("b",10),casePrice:10,eachPrice:2}];
const agreement={vendorId:"a",price:8};
assert.equal(priceForOffer(quotes[0],agreement),8);
assert.equal(priceForOffer(quotes[0],{a:8,b:9}),8);
assert.equal(priceForOffer(quotes[1],{a:8,b:9}),9,"every vendor keeps its own agreed price");
assert.equal(priceForOffer(quotes[1],agreement),10,"another vendor must retain its own quote");
assert.equal(priceForOffer(quotes[0],null,"each"),3,"an each quote is unchanged without its own agreement");
const ranked=rankVendorOffers([{...option("minores",55.9),casePrice:55.9},{...option("cityline",56.9),casePrice:56.9},{...option("mina",57),casePrice:57}],null);
assert.deepEqual(ranked.map(o=>[o.vendorId,o.difference]),[["minores",0],["cityline",1],["mina",1.1]]);
const customRank=rankVendorOffers(ranked,{cityline:54.5,mina:57});
assert.deepEqual(customRank.map(o=>[o.vendorId,o.difference]),[["cityline",0],["minores",1.4],["mina",2.5]]);
const reranked=solveOrder([{catalogItemId:"cheese",quantity:1,options:quotes.map(o=>({...o,price:priceForOffer(o,agreement)}))}],[])[0];
assert.equal(reranked.assignedVendorId,"a","the agreed vendor becomes the winner when its price is lowest");
const chosen=solveOrder([{catalogItemId:"cheese",quantity:1,forcedVendorId:"b",options:quotes.map(o=>({...o,price:priceForOffer(o,agreement)}))}],[])[0];
assert.equal(chosen.assignedVendorId,"b","a deliberate replacement vendor stays selected");
console.log("KERDOS universal ordering-core tests passed");

const unequal=[option("small",12,{casePrice:12,perUnit:{price:3,unit:"LB"}}),option("large",20,{casePrice:20,perUnit:{price:2,unit:"LB"}})];
const normalized=rankVendorOffers(unequal);
assert.equal(normalized[0].vendorId,"large","alternatives rank by common unit cost, not cheaper small pack");
assert.equal(normalized[1].difference,1);
assert.equal(normalized[0].unitPrice,20,"actual order pack price is retained");
assert.equal(rankVendorOffers(unequal,{small:4})[0].vendorId,"small","negotiated amounts normalize using the same pack");
const normalizedOrder=solveOrder([{catalogItemId:"alternatives",quantity:2,orderUnit:"case",options:unequal}],[])[0];
assert.equal(normalizedOrder.assignedVendorId,"large");
assert.equal(normalizedOrder.lineTotal,40,"order totals use actual pack prices");
console.log("Alternative ranking passed: unequal packs, common unit prices, negotiated amounts, and actual basket totals.");

const sameVendorChoice=solveOrder([{catalogItemId:"choice",quantity:1,orderUnit:"case",forcedVendorId:"vendor-premium",options:[option("vendor",5,{vendorItemId:"vendor-basic"}),option("vendor",7,{vendorItemId:"vendor-premium"})]}],[])[0];
assert.equal(sameVendorChoice.vendorItemId,"vendor-premium","selecting a listing must retain the chosen product even within one vendor");

const ounceOffers=rankVendorOffers([55.9,56.9,57].map((price,index)=>option(String(index),price,{casePrice:price,packSize:"6/66.5 OZ",perUnit:{price:Math.round(price/399*10000)/10000,unit:"OZ"}})));
assert.deepEqual(ounceOffers.map(o=>offerDollarDifference(o,ounceOffers[0])),[0,1,1.1],"dollar differences retain the full pack premium despite per-ounce rounding");
const packOffers=rankVendorOffers([option("big",20,{casePrice:20,packSize:"1/10 LB",perUnit:{price:2,unit:"LB"}}),option("small",12,{casePrice:12,packSize:"1/4 LB",perUnit:{price:3,unit:"LB"}})]);
assert.equal(offerDollarDifference(packOffers[1],packOffers[0]),10,"different packs compare equivalent purchasing quantities in dollars");
console.log("Dropdown dollar differences passed: equal packs, small per-ounce premiums and unequal purchasing packs.");


const replacementOffers=[
  option("minores",29.90,{vendorItemId:"minores-celery",casePrice:29.90,description:"CELERY 24 CT",packSize:"24 CT"}),
  option("mina",17.99,{vendorItemId:"mina-celery",casePrice:17.99,description:"CELERY 24 COUNT",packSize:"24 CT"}),
];
const explicitReplacement=solveOrder([{catalogItemId:"celery",quantity:3,orderUnit:"case",forcedVendorId:"minores-celery",options:replacementOffers}],[])[0];
assert.equal(explicitReplacement.vendorItemId,"minores-celery","selected listing replaces the default cheapest listing");
assert.equal(explicitReplacement.assignedVendorName,"minores","replacement updates vendor");
assert.equal(explicitReplacement.packSize,"24 CT","replacement retains selected pack");
assert.equal(explicitReplacement.price,29.90,"replacement retains selected price");
assert.equal(explicitReplacement.lineTotal,89.70,"basket total uses selected listing price");
const heldReplacement=solveOrder([{catalogItemId:"celery",quantity:1,orderUnit:"case",forcedVendorId:"mina-celery",options:replacementOffers.map(o=>o.vendorId==="mina"?{...o,unverified:true}:o)}],[])[0];
assert.equal(heldReplacement.unorderable,true,"held selected listing cannot silently fall back to another vendor");
assert.equal(heldReplacement.assignedVendorId,null,"held selection must not order the original winner");
console.log("Power Ranked replacement and held-offer safety tests passed.");

// Module G · Task 2 · Order — checklist coverage
//   [1] Case / each selection per item
//   [4] Vendor dollar and unit minimums tracked

// [1] Each-unit ranking uses eachPrice, not casePrice.
// vendor-a: case $20, each $2 (cheaper per each).  vendor-b: case $12, each $3 (cheaper per case).
// rankVendorOffers with unit="each" must rank vendor-a first despite its higher case price.
const eachOptions=[
  option("vendor-a",20,{casePrice:20,eachPrice:2}),
  option("vendor-b",12,{casePrice:12,eachPrice:3}),
];
const eachRanked=rankVendorOffers(eachOptions,null,"each");
assert.equal(eachRanked[0].vendorId,"vendor-a","each-unit ranking must use eachPrice, not casePrice");
assert.equal(eachRanked[0].difference,0,"the each-price winner carries difference:0");
assert.equal(eachRanked[1].difference,1,"the more expensive each-price option carries the correct premium");
console.log("Each-unit ranking uses eachPrice passed.");

// [4a] Dollar-minimum fill — path A success.
// item-x: vendor-a $30 (wins initially), vendor-b $60.
// item-y: vendor-b $35 (wins initially), vendor-a $40.
// vendor-a basket starts at $30, short of $60 minimum.
// Path A moves item-y to vendor-a ($30+$40=$70 ≥ $60); path B costs $95. Path A wins.
const dollarMinVendors=[{id:"vendor-a",name:"Vendor A",delivery_minimum_dollar:60}];
const dollarMinFilled=solveOrder([
  {catalogItemId:"item-x",quantity:1,orderUnit:"case",options:[option("vendor-a",30),option("vendor-b",60)]},
  {catalogItemId:"item-y",quantity:1,orderUnit:"case",options:[option("vendor-a",40),option("vendor-b",35)]},
],dollarMinVendors);
assert.equal(dollarMinFilled.find(a=>a.catalogItemId==="item-x").assignedVendorId,"vendor-a","item-x stays on vendor-a");
assert.equal(dollarMinFilled.find(a=>a.catalogItemId==="item-y").assignedVendorId,"vendor-a","item-y moved to vendor-a to meet dollar minimum");
const vendorADollar=dollarMinFilled.filter(a=>a.assignedVendorId==="vendor-a").reduce((s,a)=>s+a.lineTotal,0);
assert.ok(vendorADollar>=60,`vendor-a basket must meet the $60 dollar minimum after fill; got $${vendorADollar}`);
console.log("Dollar-minimum fill (path A success) passed.");

// [4b] Unit-minimum fill — path A success.
// item-x: vendor-a $10 (wins initially, qty 1), vendor-b $50.
// item-y: vendor-b $15 (wins initially, qty 2), vendor-a $20.
// vendor-a basket starts at 1 unit, short of 3-unit minimum.
// Path A moves item-y (qty 2) to vendor-a (total 3 ≥ 3); path B costs $80 vs path A $50. Path A wins.
const unitMinVendors=[{id:"vendor-a",name:"Vendor A",delivery_minimum_units:3}];
const unitMinFilled=solveOrder([
  {catalogItemId:"item-x",quantity:1,orderUnit:"case",options:[option("vendor-a",10),option("vendor-b",50)]},
  {catalogItemId:"item-y",quantity:2,orderUnit:"case",options:[option("vendor-a",20),option("vendor-b",15)]},
],unitMinVendors);
assert.equal(unitMinFilled.find(a=>a.catalogItemId==="item-y").assignedVendorId,"vendor-a","item-y moved to vendor-a to meet unit minimum");
const vendorAUnits=unitMinFilled.filter(a=>a.assignedVendorId==="vendor-a").reduce((s,a)=>s+a.quantity,0);
assert.ok(vendorAUnits>=3,`vendor-a basket must meet the 3-unit minimum after fill; got ${vendorAUnits}`);
console.log("Unit-minimum fill (path A success) passed.");
