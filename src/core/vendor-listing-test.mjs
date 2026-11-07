import assert from "node:assert/strict";
import {findUncodedVendorListing,vendorListingLabel} from "./vendor-listing.js";
import {parseDocument} from "../ingestion.js";

const bacon={id:"v1",vendor_item_code:null,nvim_number:1,description:"BACON FROZEN",brand:"Smithfield",pack_size:"1/15 LB"};
const item={description:"Bacon frozen",brand:"Smithfield",packSize:"1/15 LB",price:3.83};
assert.equal(findUncodedVendorListing(item,[bacon]).item.id,"v1");
assert.equal(findUncodedVendorListing({...item,price:4.25},[bacon]).item.id,"v1","price changes do not change identity");
assert.equal(findUncodedVendorListing({...item,packSize:"1/10 LB"},[bacon]).item,null);
assert.match(findUncodedVendorListing({...item,packSize:"1/10 LB"},[bacon]).conflict,/pack/);
assert.match(findUncodedVendorListing(item,[bacon,{...bacon,id:"v2",nvim_number:2}]).conflict,/More than one/);
assert.match(findUncodedVendorListing({...item,brand:"Different"},[bacon]).conflict,/brand/);
assert.match(findUncodedVendorListing({...item,brand:""},[bacon]).conflict,/brand/,"missing brand cannot assume a branded listing");
assert.equal(findUncodedVendorListing({...item,description:"Sweet potato fries"},[bacon]).item,null);
const cleaned={...bacon,description:"Smithfield bacon, frozen",brand:"Smithfield",pack_size:"1/15 LB",
  import_row:{row:{description:"BCN FRZ",brand:"",packSize:"1/15 LB"}}};
assert.equal(findUncodedVendorListing({description:"BCN FRZ",brand:"",packSize:"1/15 LB"},[cleaned]).item.id,"v1","saved edits do not lose an original sheet identity");
const noteRow=value=>parseDocument(`Product,Pack,Price,Notes\nVITAMIN B12,100 CT,12.50,${value}`).rows[0];
const firstNote=noteRow("AB-100");
const savedWithNote={id:"note-1",vendor_item_code:null,description:firstNote.description,brand:null,pack_size:firstNote.packSize,
  import_row:{row:firstNote}};
assert.equal(findUncodedVendorListing(noteRow("AB-100"),[savedWithNote]).item.id,"note-1","unchanged source detail reuses the listing");
const changedNote=findUncodedVendorListing(noteRow("AB-101"),[savedWithNote]);
assert.equal(changedNote.item,null,"changed source detail cannot update the prior listing");
assert.match(changedNote.conflict,/different source details/i,"changed source detail is held for review rather than assigned a new NVIN");
const numberedLater={...bacon,vendor_item_code:"43700"};
assert.equal(findUncodedVendorListing(item,[numberedLater]).item,null,"a code-free row never overwrites a coded listing");
assert.match(findUncodedVendorListing(item,[numberedLater]).conflict,/saved listing with a vendor item number/i,
  "the old code-free sheet is held before allocating a duplicate NVIN");
assert.match(findUncodedVendorListing(item,[{...numberedLater,brand:"Corrected",pack_size:"1/20 LB",
  import_row:{row:{description:"BACON FROZEN",brand:"Smithfield",packSize:"1/15 LB"}}}]).conflict,/vendor item number/i,
  "saved field corrections do not hide the original coded-listing overlap");
assert.equal(findUncodedVendorListing({...item,packSize:"1/10 LB"},[numberedLater]).conflict,null,
  "a stated different pack remains a separate offering");
assert.equal(findUncodedVendorListing({...item,brand:"Other"},[numberedLater]).conflict,null,
  "a stated different brand remains a separate offering");
assert.equal(findUncodedVendorListing({...item,code:"47432"},[numberedLater]).conflict,null,
  "a separately printed vendor code is not mistaken for the old code-free sheet");
assert.equal(vendorListingLabel(bacon),"NVIN-1");
console.log("KERDOS vendor listing identity tests passed");
