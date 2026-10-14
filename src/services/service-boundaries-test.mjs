import assert from "node:assert/strict";
import {createVendorService} from "./vendors.js";
import {createOperationsService} from "./operations.js";
import {createImportService} from "./imports.js";
import {createDocumentService} from "./documents.js";

const calls=[];
function query(table){
  const state={table};
  const chain={select(value){state.select=value;return chain;},insert(value){state.insert=value;return chain;},update(value){state.update=value;return chain;},delete(){state.delete=true;return chain;},eq(column,value){(state.eq??=[]).push([column,value]);return chain;},in(column,value){state.in=[column,value];return chain;},lte(column,value){state.lte=[column,value];return chain;},order(column,options){(state.order??=[]).push([column,options]);return chain;},range(from,to){state.range=[from,to];return chain;},limit(value){state.limit=value;return chain;},maybeSingle(){state.maybeSingle=true;return chain;},single(){state.single=true;return chain;},then(resolve){calls.push({...state});resolve({data:state.single?{id:"created"}:state.maybeSingle?null:[],error:null});}};
  return chain;
}
const backend={records:{query},orders:{async submit(value){calls.push({order:value});return {id:"created"};}}};
const vendors=createVendorService(backend);
await vendors.add({organizationId:"o1",name:" Vendor ",email:"",minimumDollar:"100",minimumUnits:"5"});
assert.equal(calls.at(-1).insert.name,"Vendor");
await vendors.expireQuotes({organizationId:"o1",vendorId:"v1",vendorItemIds:["i1","i2"]});
assert.deepEqual(calls.at(-1).in,["id",["i1","i2"]]);

const operations=createOperationsService(backend);
await operations.updateInvoice("inv1",{invoice_number:"42"});
assert.deepEqual(calls.at(-1).update,{invoice_number:"42"});
await operations.olderPriceHistory("o1",2000);
assert.deepEqual(calls.at(-1).range,[2000,3999]);
const documents=createDocumentService(backend);
await documents.olderPriceDocuments("o1",500);
assert.equal(calls.at(-1).table,"import_documents","archive pagination loads actual documents, not price transactions");
assert.deepEqual(calls.at(-1).eq,[["organization_id","o1"],["document_kind","pricelist"]]);
assert.deepEqual(calls.at(-1).range,[500,999]);
assert.deepEqual(calls.at(-1).order.map(([key])=>key),["created_at","id"]);
await operations.submitOrder({organizationId:"o1",userId:"u1",basket:{vendorId:"v2",vendorName:"Vendor",dollar:24,items:[{catalogItemId:"c1_split_case",vendorItemId:"vi2",quantity:2,price:12,lineTotal:24,orderUnit:"case"}]}});
assert.equal(calls.at(-1).order.p_lines[0].catalog_item_id,"c1","split line must retain the client catalog ID in the purchase order");

assert.equal(calls.at(-1).order.p_lines[0].quantity,2);
assert.equal(calls.at(-1).order.p_lines[0].order_unit,"case");
const imports=createImportService(backend);
assert.equal(await imports.duplicateInvoice({organizationId:"o1",vendorId:"v1",invoiceNumber:"42",rawText:""}),false);
assert.deepEqual(calls.at(-1).eq.at(-1),["invoice_number","42"]);
await imports.createMapping({organization_id:"o1",vendor_item_id:"i1",catalog_item_id:"c1"});
assert.equal(calls.at(-1).table,"item_mappings");
await imports.resumeSources("o1","v1","doc1");
const sourceQuery=calls.find(call=>call.table==="price_history"&&call.select==="source_row_key,source_line");
assert.deepEqual(sourceQuery.eq,[["organization_id","o1"],["source_document_id","doc1"]]);
assert.deepEqual(sourceQuery.range,[0,499]);
assert.deepEqual(calls.at(-1).eq,[["organization_id","o1"],["vendor_id","v1"]]);
assert.deepEqual(calls.at(-1).range,[0,499]);
console.log("KERDOS vendor, operations and import service-boundary tests passed");
