import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {priceQuoteFixture} from './fixtures/price-quote-db.mjs';
import {importPriceRow} from '../src/core/import-price-row.js';
import {findUncodedVendorListing} from '../src/core/vendor-listing.js';
import {parseDocument} from '../src/ingestion.js';

const db=new PGlite();
try{
  const f=await priceQuoteFixture(db);
  await db.exec(readFileSync(new URL('../knowledge/migration_012_vendor_nvim.sql',import.meta.url),'utf8'));
  await f.actor(db,f.owner);
  const mappings=new Map();
  const importService={mapping:async(_org,id)=>mappings.get(id)||null,createMapping:async row=>{
    const saved={...row,id:randomUUID()};mappings.set(row.vendor_item_id,saved);return saved;
  }};
  const catalogService={matchOrCreate:async()=>({catalogItemId:randomUUID(),score:.9,track:'review'}),confirmMappings:async()=>{}};
  const backend={pricing:{applyQuote:async p=>f.call(db,f.quote(p.sourceDocumentId,{
    item:p.vendorItemId,code:p.vendorItemCode,pack:p.packSize,price:p.price,key:p.importRow.rowKey,
    line:p.sourceLine,description:p.description,brand:p.brand,importRow:p.importRow,
  }))}};
  const doc1=await f.document(),doc2=await f.document();
  const observed=new Map();
  async function importRows(doc,prices){
    for(const [index,[description,packSize,price]] of prices.entries()){
      const {rows:[row]}=parseDocument(`Description,Pack,Price Unit,Price\n${description},${packSize},CASE,${price}`);
      assert.equal(row.code,null);
      assert.equal(row.fieldValidation.fields.code.status,'missing');
      const saved=(await db.query('select * from vendor_items where organization_id=$1 and vendor_id=$2',[f.org,f.vendor])).rows;
      const found=findUncodedVendorListing(row,saved);
      assert.equal(found.conflict,null);
      const ex=found.item;
      const result=await importPriceRow({backend,importService,catalogService,sourceRow:row,row,ex,priorMapping:ex?mappings.get(ex.id):null,
        rowIssues:[],rowNeedsReview:false,invoiceSources:[],orgId:f.org,vendorId:f.vendor,sourceDocumentId:doc,completedKey:`row:${index}`,
        importBatchTime:'2026-11-07T00:00:00Z',group:{name:'Unnumbered.csv'},sourceFilePath:null,
        workingCatalogItems:[],workingCategories:[],workingVendorItems:[],workingMappings:[]});
      assert.equal(result.needsBasis,false);
      const prior=observed.get(description);
      if(prior)assert.equal(result.vendorItemId,prior,'reimport must reuse the same listing');
      observed.set(description,result.vendorItemId);
    }
  }
  const first=[['CIDER APPLE','4/1 GAL',26.15],['CHEESE AMERICAN','5 LB',16.75]];
  await importRows(doc1,first);
  await importRows(doc2,[first[0],['CHEESE AMERICAN','5 LB',18.75]]);
  const beforeReplay=(await db.query('select id,description,vendor_item_code,nvim_number,price,row_revision from vendor_items order by description')).rows;
  assert.deepEqual(beforeReplay.map(r=>[r.description,r.vendor_item_code,Number(r.nvim_number),Number(r.price)]),[
    ['CHEESE AMERICAN',null,2,18.75],['CIDER APPLE',null,1,26.15],
  ]);
  assert.equal(new Set(beforeReplay.map(r=>r.id)).size,2);
  await importRows(doc2,[first[0],['CHEESE AMERICAN','5 LB',18.75]]);
  const afterReplay=(await db.query('select id,nvim_number,row_revision from vendor_items order by description')).rows;
  assert.deepEqual(afterReplay,beforeReplay.map(({id,nvim_number,row_revision})=>({id,nvim_number,row_revision})));
  const history=(await db.query('select source_document_id,source_row_key,price from price_history order by source_document_id,source_row_key')).rows;
  assert.equal(history.length,4);
  assert.deepEqual(history.filter(r=>r.source_row_key==='row:1').map(r=>Number(r.price)).sort(),[16.75,18.75]);
  assert.equal(mappings.size,2);
  console.log('PASS B4 real importer/SQL: two uncoded listings, stable separate NVIN, changed price, source replay with no duplicate history');
}finally{await db.close();}
