import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {priceQuoteFixture} from './fixtures/price-quote-db.mjs';
import {importPriceRow} from '../src/core/import-price-row.js';

// Exercise the real per-row importer against the real price RPC. The same
// scoped code lookup used by ImportModal supplies ex on the changed document.
const db=new PGlite();
try{
 const f=await priceQuoteFixture(db);await f.actor(db,f.owner);
 const mapping=new Map(),catalogId=randomUUID();
 const importService={mapping:async(_org,id)=>mapping.get(id)||null,createMapping:async row=>{
  const saved={...row,id:randomUUID()};mapping.set(row.vendor_item_id,saved);return saved;
 }};
 const catalogService={matchOrCreate:async()=>({catalogItemId:catalogId,score:.9,track:'review'}),confirmMappings:async()=>{}};
 const backend={pricing:{applyQuote:async p=>f.call(db,f.quote(p.sourceDocumentId,{
  item:p.vendorItemId,price:p.price,key:p.importRow.rowKey,line:p.sourceLine,description:p.description,
 }))}};
 const imports=[];
 for(const price of [41.25,43.25]){
  const doc=await f.document();const line=`TEST-1,Example product,2/10 LB,CS,${price}`;
  const row={code:'TEST-1',description:'Example product',packSize:'2/10 LB',sellingUnit:'CS',price,sourceLine:line};
  const existing=(await db.query('select * from vendor_items where organization_id=$1 and vendor_id=$2 and vendor_item_code=$3',[f.org,f.vendor,row.code])).rows[0]||null;
  const before=existing&&{last_updated:existing.last_updated,row_revision:existing.row_revision};
  const result=await importPriceRow({backend,importService,catalogService,sourceRow:row,row,ex:existing,priorMapping:existing?mapping.get(existing.id):null,
   rowIssues:[],rowNeedsReview:false,invoiceSources:[],orgId:f.org,vendorId:f.vendor,sourceDocumentId:doc,completedKey:'row:0',
   importBatchTime:'2026-11-06T12:00:00Z',group:{name:'Synthetic.csv'},sourceFilePath:null,
   workingCatalogItems:[],workingCategories:[],workingVendorItems:[],workingMappings:[]});
  assert.equal(result.needsBasis,false);imports.push({doc,id:result.vendorItemId});
  if(before){const now=(await db.query('select * from vendor_items where id=$1',[result.vendorItemId])).rows[0];
   assert.ok(new Date(now.last_updated)>=new Date(before.last_updated));assert.ok(BigInt(now.row_revision)>BigInt(before.row_revision));}
 }
 assert.equal(imports[0].id,imports[1].id,'changed file must reuse the existing vendor listing');
 assert.equal((await db.query('select count(*)::int n from vendor_items')).rows[0].n,1);
 assert.equal(Number((await db.query('select price from vendor_items where id=$1',[imports[0].id])).rows[0].price),43.25);
 const history=(await db.query('select source_document_id,price from price_history order by effective_date,id')).rows;
 assert.equal(history.length,2);assert.deepEqual(new Set(history.map(x=>x.source_document_id)),new Set(imports.map(x=>x.doc)));
 assert.deepEqual(history.map(x=>Number(x.price)).sort(),[41.25,43.25]);
 assert.equal(mapping.size,1,'mapping must remain attached to one listing');
 console.log('PASS real importer/SQL changed price: same listing and mapping, newer rate/revision, both historical source documents');
}finally{await db.close();}
