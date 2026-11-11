// Retained provenance must survive real authenticated JSON persistence.
// This database is isolated and synthetic; no hosted service is constructed.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {priceQuoteFixture} from './fixtures/price-quote-db.mjs';
import {configureProcurement,createProcurementContext} from '../src/procurement.js';
import {importPriceRow} from '../src/core/import-price-row.js';
import {catalogRowEvidence,orderGuideAssessment} from '../src/core/catalog-fields.js';

configureProcurement({industry:'construction'});
const procurement=createProcurementContext({industry:'construction'});
const db=new PGlite();
try{
  const f=await priceQuoteFixture(db);
  await f.actor(db,f.owner);
  const originalDocumentId=await f.document();
  const original={code:'W-1',description:'STEEL WASHERS',brand:'Example',packSize:'4/5 LB',
    sellingUnit:null,price:35,sourceLine:'W-1,STEEL WASHERS,Example,4/5 LB,,35.00'};
  const originalEvidence={...original,sellingUnit:'CS',sellingUnitSource:'inferred',
    fieldInference:{sellingUnit:{value:'CS',kind:'inferred',source:'cross-vendor comparison',
      accuracy:70,reason:'Synthetic compared-unit proposal'}}};
  const originalImportRow={row:original,evidence:originalEvidence,rowKey:'row:0',
    sourceDocumentId:originalDocumentId,sourceFileName:'Original.csv',
    reviewRequired:true,reviewFields:['selling_unit']};
  const listingId=await f.call(db,f.quote(originalDocumentId,{
    code:original.code,description:original.description,brand:original.brand,
    pack:original.packSize,price:original.price,line:original.sourceLine,
    unavailable:true,importRow:originalImportRow,
  }));
  const read=async()=>{
    const result=await db.query('select * from vendor_items where id=$1 and organization_id=$2',[listingId,f.org]);
    assert.equal(result.rows.length,1,'authenticated owner can read the scoped listing');
    return result.rows[0];
  };
  const initial=await read();
  assert.equal(initial.selling_unit,'CS');
  assert.equal(Number(initial.price),35);
  assert.equal(initial.import_row.row.sellingUnit,null,'the original neutral unit stays blank');
  assert.equal(initial.import_row.evidence.sellingUnitSource,'inferred');

  const category={id:randomUUID(),name:'Supplies',range_start:900000,range_end:999999};
  const item={id:randomUUID(),name:'Steel washers',category_id:category.id,
    category_reason:'confirmed',category_review:false,master_item_number:900001};
  const mapping={id:randomUUID(),organization_id:f.org,vendor_item_id:listingId,
    catalog_item_id:item.id,comparison_track:'exact',confidence_score:100,match_method:'manual'};
  const vendor={id:f.vendor,name:'Synthetic supplier'};
  let quoteCalls=0,reviewWrites=0;
  const backend={pricing:{async applyQuote(){
    quoteCalls++;
    throw new Error('The held importer must not call applyQuote');
  }},records:{query(table){
    assert.equal(table,'vendor_items');
    return {update(patch){
      assert.deepEqual(Object.keys(patch),['import_row'],'the held path only persists pending provenance');
      const filters=new Map();
      const query={
        eq(column,value){
          assert.ok(['id','organization_id'].includes(column));
          filters.set(column,value);return query;
        },
        then(resolve,reject){
          assert.equal(filters.get('id'),listingId);
          assert.equal(filters.get('organization_id'),f.org,'the actual write is organization scoped');
          const result=db.query('update vendor_items set import_row=$1::jsonb where id=$2 and organization_id=$3 returning id',
            [JSON.stringify(patch.import_row),filters.get('id'),filters.get('organization_id')])
            .then(({rows})=>{reviewWrites++;return {data:rows,error:null};});
          return result.then(resolve,reject);
        },
      };
      return query;
    }};
  }}};
  const importService={mapping:async(org,id)=>{
    assert.equal(org,f.org);assert.equal(id,listingId);return mapping;
  }};
  const catalogService={async matchOrCreate(){throw new Error('The existing mapping must be reused');}};
  const input=listing=>({item,vendorItem:listing,mapping,vendor,category,categories:[category],peers:[]});
  const assertProvisional=listing=>{
    const evidence=catalogRowEvidence(input(listing));
    const assessment=orderGuideAssessment(input(listing));
    assert.equal(evidence.sellingUnit.status,'inferred');
    assert.equal(evidence.sellingUnit.accuracy,70);
    assert.equal(evidence.unitCost.status,'inferred');
    assert.equal(evidence.unitCost.accuracy,70);
    assert.match(evidence.unitCost.reason,/Provisional/);
    assert.equal(assessment.ready,false);
    assert.ok(assessment.blockers.includes('sellingUnit'));
  };
  assertProvisional(initial);
  let retainedSource;
  const pendingDocuments=[];
  for(const [index,price] of [36,37].entries()){
    const documentId=await f.document();pendingDocuments.push(documentId);
    const source={...original,price,sourceLine:`W-1,STEEL WASHERS,Example,4/5 LB,,${price}.00`};
    const ex=await read();
    const result=await importPriceRow({backend,importService,catalogService,
      sourceRow:structuredClone(source),row:structuredClone(source),ex,priorMapping:mapping,
      rowIssues:[],rowNeedsReview:false,invoiceSources:[],orgId:f.org,vendorId:f.vendor,
      sourceDocumentId:documentId,completedKey:'row:0',importBatchTime:'2026-11-11T12:00:00Z',
      group:{name:`Pending-${index+1}.csv`},sourceFilePath:null,
      workingCatalogItems:[item],workingCategories:[category],workingVendorItems:[ex],workingMappings:[mapping],
    },procurement);
    assert.equal(result.needsBasis,true);assert.equal(result.vendorItemId,listingId);
    const saved=await read();
    assert.equal(saved.selling_unit,initial.selling_unit,'pending evidence cannot replace the retained unit');
    assert.equal(saved.price_basis,initial.price_basis);
    assert.equal(Number(saved.price),Number(initial.price),'pending evidence cannot replace the retained amount');
    assert.equal(saved.pack_size,initial.pack_size);
    assert.equal(saved.price_unavailable,initial.price_unavailable);
    assert.equal(saved.import_row.sourceDocumentId,documentId,'the newest observation remains available for review');
    assert.equal(saved.import_row.sourceFileName,`Pending-${index+1}.csv`);
    assert.equal(saved.import_row.row.price,price);
    assert.equal(saved.import_row.row.sellingUnit,null);
    assert.equal(saved.import_row.evidence.sellingUnit||null,null);
    assert.equal(saved.import_row.reviewRequired,true);
    assert.ok(saved.import_row.reviewFields.includes('selling_unit'));
    const retained=saved.import_row.retainedSource;
    assert.equal(retained.sourceDocumentId,originalDocumentId);
    assert.equal(retained.sourceFileName,'Original.csv');
    assert.equal(retained.values.selling_unit,'CS');
    assert.equal(Number(retained.values.price),35);
    assert.deepEqual(retained.row,original);
    assert.deepEqual(retained.evidence,originalEvidence);
    if(retainedSource)assert.deepEqual(retained,retainedSource,'a second hold cannot replace the original provenance with the preceding pending row');
    retainedSource=structuredClone(retained);
    assertProvisional(saved);
  }
  assert.equal(quoteCalls,0);
  assert.equal(reviewWrites,2);
  assert.equal(new Set([originalDocumentId,...pendingDocuments]).size,3);
  const counts=(await db.query(`select
    (select count(*)::int from import_documents) as documents,
    (select count(*)::int from vendor_items) as listings,
    (select count(*)::int from price_history) as history`)).rows[0];
  assert.deepEqual(counts,{documents:3,listings:1,history:0},'held observations preserve three sources and do not invent a usable quote history');

  const beforeDenied=await read();
  await f.actor(db,f.outsider);
  assert.equal((await db.query('select id from vendor_items where id=$1',[listingId])).rows.length,0,
    'row-level security hides another organization’s listing');
  const denied=await backend.records.query('vendor_items').update({import_row:{
    row:{sellingUnit:'CASE'},evidence:{sellingUnit:'CASE',sellingUnitSource:'price header'},
    retainedSource:{values:{selling_unit:'CS'},evidence:{sellingUnit:'CS',sellingUnitSource:'price header'}},
  }}).eq('id',listingId).eq('organization_id',f.org);
  assert.equal(denied.error,null);
  assert.deepEqual(denied.data,[],'row-level security prevents an outsider from rewriting the snapshot');
  await f.actor(db,f.owner);
  const afterDenied=await read();
  assert.deepEqual(afterDenied.import_row,beforeDenied.import_row,'the entire saved JSON survives the denied cross-organization update');
  assert.equal(afterDenied.selling_unit,beforeDenied.selling_unit);
  assert.equal(Number(afterDenied.price),Number(beforeDenied.price));
  assertProvisional(afterDenied);
  console.log('PASS retained quote provenance SQL: authenticated owner persisted two held observations; original inferred unit, amount, document and evidence remained bound.');
  console.log('PASS retained quote provenance SQL: readback stays Inferred 70%, unit cost provisional, Order Guide blocked; 3 documents, 1 listing, 0 usable quote-history rows.');
  console.log('PASS retained quote provenance SQL: outsider RLS denied the JSON update and the saved snapshot remained byte-for-byte equivalent as JSON.');
}finally{await db.close();}
