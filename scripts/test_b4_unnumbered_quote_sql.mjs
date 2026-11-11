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
  const backend={pricing:{applyQuote:async p=>{
    const command=f.quote(p.sourceDocumentId,{
      item:p.vendorItemId,code:p.vendorItemCode,pack:p.packSize,price:p.price,key:p.importRow.rowKey,
      line:p.sourceLine,description:p.description,brand:p.brand,importRow:p.importRow,unavailable:p.priceUnavailable,
    });
    command.args[14]=p.sellingUnit;
    command.args[15]=p.priceBasis;
    return f.call(db,command);
  }}};
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
  await importRows(await f.document(),[['SYNTHETIC WASHERS 4/5 LB','',32.40]]);
  const inferred=(await db.query("select import_row from vendor_items where description='SYNTHETIC WASHERS'")).rows[0].import_row;
  assert.equal(inferred.evidence.sourceDescription,'SYNTHETIC WASHERS 4/5 LB');
  assert.equal(inferred.row.fieldIdentification.bindings.packSize.rawValue,'');
  assert.equal(inferred.evidence.fieldValidation.fields.packSize.status,'missing');
  assert.equal(inferred.evidence.fieldInference.packSize.value,'4/5 LB');
  assert.equal(inferred.evidence.fieldInference.packSize.kind,'inferred');
  assert.equal(inferred.evidence.fieldInference.packSize.accuracy,90);
  const {rows:[unpricedBasis]}=parseDocument('Code,Description,Pack,Price\nX-1,SYNTHETIC WASHERS,4/10 LB,2.06');
  const held=await importPriceRow({backend,importService,catalogService,sourceRow:unpricedBasis,row:unpricedBasis,ex:null,priorMapping:null,
    rowIssues:[],rowNeedsReview:false,invoiceSources:[],orgId:f.org,vendorId:f.vendor,sourceDocumentId:await f.document(),completedKey:'row:0',
    importBatchTime:'2026-11-10T00:00:00Z',group:{name:'MissingBasis.csv'},sourceFilePath:null,
    workingCatalogItems:[],workingCategories:[],workingVendorItems:[],workingMappings:[]});
  assert.equal(held.needsBasis,true);
  const missing=(await db.query('select * from vendor_items where id=$1',[held.vendorItemId])).rows[0];
  assert.equal(missing.selling_unit,null);
  assert.equal(missing.price_basis,null);
  assert.equal(Number(missing.price),2.06);
  assert.equal(missing.price_unavailable,true);
  assert.equal(missing.import_row.reviewRequired,true);
  assert.ok(missing.import_row.reviewFields.includes('selling_unit'));
  assert.equal(missing.import_row.row.sellingUnit,null);
  assert.notEqual(missing.import_row.evidence.sellingUnitSource,'inferred');
  assert.deepEqual(missing.import_row.evidence.quoteBasisReview.alternatives.map(option=>option.sellingUnit),['CASE','EACH','LB']);
  const heldHistory=(await db.query('select selling_unit,price_basis from price_history where vendor_item_id=$1',[held.vendorItemId])).rows;
  assert.ok(heldHistory.every(row=>row.selling_unit===null&&row.price_basis===null));
  await db.query('reset role');
  const references=[];
  for(const price of [80,82]){
    const vendor=randomUUID(),id=randomUUID();await db.query('insert into vendors(id,organization_id) values($1,$2)',[vendor,f.org]);
    const importRow={reviewRequired:false,row:{sellingUnit:'CASE'},evidence:{sellingUnitSource:'price header'}};
    await db.query("insert into vendor_items(id,organization_id,vendor_id,description,pack_size,price,selling_unit,price_basis,price_source,import_row) values($1,$2,$3,'SYNTHETIC WASHERS','4/10 LB',$4,'CASE','case','pricelist',$5)",[id,f.org,vendor,price,JSON.stringify(importRow)]);
    references.push((await db.query('select * from vendor_items where id=$1',[id])).rows[0]);
  }
  await f.actor(db,f.owner);
  const {rows:[crossRow]}=parseDocument('Code,Description,Pack,Price\nX-2,SYNTHETIC WASHERS,4/10 LB,81');
  const cross=await importPriceRow({backend,importService,catalogService,sourceRow:crossRow,row:crossRow,ex:null,priorMapping:null,
    rowIssues:[],rowNeedsReview:false,invoiceSources:[],orgId:f.org,vendorId:f.vendor,sourceDocumentId:await f.document(),completedKey:'row:0',
    importBatchTime:'2026-11-10T00:00:00Z',group:{name:'CrossVendor.csv'},sourceFilePath:null,
    workingCatalogItems:[],workingCategories:[],workingVendorItems:references,workingMappings:[]});
  const savedGuess=(await db.query('select * from vendor_items where id=$1',[cross.vendorItemId])).rows[0];
  assert.equal(savedGuess.selling_unit,'CASE');assert.equal(savedGuess.price_unavailable,true);assert.equal(cross.needsBasis,true);
  assert.equal(savedGuess.import_row.row.sellingUnit,null);assert.equal(savedGuess.import_row.evidence.fieldInference.sellingUnit.accuracy,70);
  assert.equal(savedGuess.import_row.evidence.fieldInference.sellingUnit.evidence.references.length,2);
  console.log('PASS C1.5 actual SQL: compared source-backed vendor quotes fill a held inferred unit, preserve the blank original, and retain both references.');
  console.log('PASS C1.5 SQL: amount retained, quoted-per and basis null, review required, no guessed history.');
  console.log('PASS B/C SQL persistence: original blank pack binding and exact description survive alongside separately inferred pack evidence.');
  console.log('PASS B4 real importer/SQL: two uncoded listings, stable separate NVIN, changed price, source replay with no duplicate history');
}finally{await db.close();}
