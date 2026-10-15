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
