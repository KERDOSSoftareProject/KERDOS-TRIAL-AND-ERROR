import assert from "node:assert/strict";
import {findUncodedVendorListing,vendorListingLabel} from "./vendor-listing.js";

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
assert.equal(vendorListingLabel(bacon),"NVIM-1");
console.log("KERDOS vendor listing identity tests passed");
