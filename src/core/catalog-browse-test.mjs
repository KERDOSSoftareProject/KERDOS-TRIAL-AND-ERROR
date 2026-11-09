import assert from 'node:assert/strict';
import {compareItems,itemMatchesSearch,comparisonReviewCandidates} from './catalog-browse.js';
const items=[
 {name:"Ham Deli",masterItemNumber:7002,createdAt:"2026-09-02",options:[{description:"BOARS HEAD HAM",vendorItemCode:"B12"}]},
 {name:"American Cheese",masterItemNumber:7001,createdAt:"2026-09-03",options:[{description:"LAND O LAKES AMER",vendorItemCode:"A9"}]},
 {name:"Bacon",masterItemNumber:null,createdAt:null,options:[{description:"SMITHFIELD BACON 15LB",vendorItemCode:"10"}]},
];
let ok=0,bad=0;const t=(n,c)=>{c?ok++:(bad++,console.log("FAIL",n));};
t("empty search matches",itemMatchesSearch(items[0],""));
t("name match",itemMatchesSearch(items[0],"ham"));
t("vendor wording match",itemMatchesSearch(items[1],"land o"));
t("vendor code exact",itemMatchesSearch(items[0],"b12"));
t("NVIN label finds unnumbered listing",itemMatchesSearch({...items[0],options:[{description:"HAM",vendorNvim:7}]},"nvin-7"));
t("legacy NVIM search still finds listing",itemMatchesSearch({...items[0],options:[{description:"HAM",vendorNvim:7}]},"nvim-7"));
t("master number",itemMatchesSearch(items[1],"7001"));
t("no false match",!itemMatchesSearch(items[0],"cheese"));
const s=m=>[...items].sort((a,b)=>compareItems(a,b,m)).map(i=>i.name).join(",");
t("alpha",s("alpha")==="American Cheese,Bacon,Ham Deli");
t("itemNumber, missing sinks",s("itemNumber")==="American Cheese,Ham Deli,Bacon");
t("vendorCode numeric-aware",s("vendorCode")==="Bacon,American Cheese,Ham Deli");
t("added, missing sinks",s("added")==="Ham Deli,American Cheese,Bacon");
const guideItem={catalogItemId:"client-1",options:[{vendorId:"v1",vendorItemId:"a",description:"NAKED CELLO LETTUCE",packSize:"24 CT"}]};
const review=comparisonReviewCandidates(guideItem,[
 {id:"a",vendor_id:"v1",description:"NAKED CELLO LETTUCE",pack_size:"24 CT",price:55.9},
 {id:"b",vendor_id:"v2",description:"NAKED CELLO LETTUCE",pack_size:"24 CT",price:56.9,price_source:"price_list"},
 {id:"c",vendor_id:"v3",description:"NAKED CELLO LETTUCE",pack_size:"12 CT",price:45,price_source:"price_list"},
 {id:"d",vendor_id:"v4",description:"NAKED CELLO CABBAGE",pack_size:"24 CT",price:40,price_source:"price_list"},
],[{catalog_item_id:"client-1",vendor_item_id:"a"}],[{id:"v1",name:"Minores"},{id:"v2",name:"Cityline"},{id:"v3",name:"Different pack"},{id:"v4",name:"Different item"}]);
t("only a plausible same-pack vendor is proposed for review",review.length===1&&review[0].vendorName==="Cityline"&&review[0].price===56.9);
console.log(`${ok} passed, ${bad} failed`);

const {sourceOnlyListings}=await import('./source-only-listings.js');
assert.equal(sourceOnlyListings([]),false,'an item without a supplier is not metadata');
assert.equal(sourceOnlyListings([{description:'American Cheese'}]),false,'one supplier is a valid product');
const sourceOnly={field_resolutions:{source_classification:{kind:'document_metadata',confirmedBy:'reviewer'}}};
assert.equal(sourceOnlyListings([sourceOnly]),true);
assert.equal(sourceOnlyListings([sourceOnly,{description:'American Cheese'}]),false,'a real listing preserves the item');
assert.equal(sourceOnlyListings([{field_resolutions:{source_classification:{kind:'document_metadata'}}}]),false,'unconfirmed proposals cannot hide items');
