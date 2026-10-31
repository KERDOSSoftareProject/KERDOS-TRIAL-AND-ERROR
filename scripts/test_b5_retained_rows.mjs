import assert from 'node:assert/strict';
import {createSourceRowSnapshot} from '../src/core/import-resume.js';
import {retainedUnlinkedRows} from '../src/core/retained-import-rows.js';
import {findUncodedVendorListing} from '../src/core/vendor-listing.js';
import {createImportService} from '../src/services/imports.js';
import {createRecords} from '../src/backend/records.js';
const snapshot=createSourceRowSnapshot([
 {description:'Chicken Breast',price:31,sourceLine:'Chicken Breast 31.00',sourceProvenance:{page:1,lines:[2],cells:[{text:'31.00'}]}},
 {description:'Chicken Breast',price:29,sourceLine:'Chicken Breast 29.00',sourceProvenance:{page:2,lines:[3]}},
 {description:'Split Mint',packSize:'3CT',price:8.25},
]);
const doc={id:'d',vendor_id:'v',document_kind:'pricelist',status:'partial',file_name:'source.pdf',source_rows:snapshot,completed_keys:['row:2']};
let passed=0;async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
await check('all unlinked observations retained independently, including repeated descriptions and different amounts',()=>{
 const before=JSON.stringify(doc),rows=retainedUnlinkedRows([doc]);assert.equal(rows.length,2);assert.deepEqual(rows.map(r=>r.price),[31,29]);assert.notEqual(rows[0].id,rows[1].id);assert.equal(rows[1].position.page,2);assert.equal(rows[0].sellingUnit,null);assert.equal(JSON.stringify(doc),before);
});
await check('completed source rows do not reappear; completed documents are excluded',()=>{
 assert.equal(retainedUnlinkedRows([{...doc,completed_keys:['row:0','row:1','row:2']}]).length,0);
 assert.equal(retainedUnlinkedRows([{...doc,status:'complete'}]).length,0);
});
await check('legacy, unknown versions and wrong ordinal proofs are not silently assigned a source identity',()=>{
 for(const source_rows of [null,{version:2,rows:snapshot.rows},{version:1,rows:[{...snapshot.rows[0],key:'row:9'}]}])assert.equal(retainedUnlinkedRows([{...doc,source_rows}]).length,0);
});
const existing={id:'old',description:'Split Mint',brand:null,pack_size:'1LB',vendor_item_code:null};
const row={description:'Split Mint',brand:null,packSize:'3CT',price:8.25};
await check('manual explicit alternate pack creates a separate offering without weakening default worker policy',()=>{
 assert.match(findUncodedVendorListing(row,[existing]).conflict,/pack/);
 assert.deepEqual(findUncodedVendorListing(row,[existing],{allowDistinctPack:true}),{item:null,conflict:null});
});
await check('missing/ambiguous packs and brand conflicts cannot become a new inferred identity',()=>{
 for(const incoming of [{...row,packSize:null},{...row,packSize:'unknown'},{...row,brand:'Other brand'}])assert.ok(findUncodedVendorListing(incoming,[existing],{allowDistinctPack:true}).conflict);
 assert.ok(findUncodedVendorListing({...row,gtin:'same'},[{...existing,gtin:'same'}],{allowDistinctPack:true}).conflict);
});
await check('alternate pack replay selects its unique listing and preserves duplicate ambiguity guard',()=>{
 const alternate={...existing,id:'new',pack_size:'3CT'};
 assert.equal(findUncodedVendorListing(row,[existing,alternate],{allowDistinctPack:true}).item.id,'new');
 assert.match(findUncodedVendorListing(row,[alternate,{...alternate,id:'second'}],{allowDistinctPack:true}).conflict,/More than one/);
});
await check('retained-row service is read-only, organization-scoped and paginated',async()=>{
 const calls=[];const service=createImportService({records:createRecords(spec=>{calls.push(spec);return {data:spec.range.from===0?Array.from({length:50},(_,i)=>({...doc,id:String(i)})):[doc],error:null};})});
 const docs=await service.retainedPartialDocuments('org');assert.equal(docs.length,51);assert.equal(calls.length,2);
 for(const spec of calls){assert.equal(spec.action,'select');assert.ok(spec.filters.some(f=>f.column==='organization_id'&&f.value==='org'));assert.ok(spec.filters.some(f=>f.column==='status'&&f.value==='partial'));}
});
await check('retained-row read failure surfaces rather than masquerading as no pending rows',async()=>{
 const service=createImportService({records:createRecords(()=>({data:null,error:{message:'Permission denied'}}))});await assert.rejects(service.retainedPartialDocuments('org'),/Permission denied/);
});
console.log(`${passed}/8 B5 source-retention checks passed (local; no hosted writes).`);
