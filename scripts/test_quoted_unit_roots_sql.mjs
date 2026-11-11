// Durable quoted-unit roots must survive actual authenticated SQL persistence.
// All organizations, documents, products and actors below are synthetic.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {priceQuoteFixture} from './fixtures/price-quote-db.mjs';
import {parseDocument} from '../src/ingestion.js';
import {configureProcurement,createProcurementContext} from '../src/procurement.js';
import {importPriceRow} from '../src/core/import-price-row.js';
import {catalogRowEvidence,orderGuideAssessment} from '../src/core/catalog-fields.js';
import {quotedUnitOrigin} from '../src/core/listing-provenance.js';

configureProcurement({industry:'construction'});
const procurement=createProcurementContext({industry:'construction'});
const db=new PGlite();
try{
  const f=await priceQuoteFixture(db);
  await f.actor(db,f.owner);
  const category={id:randomUUID(),name:'Supplies',range_start:900000,range_end:999999};
  const item={id:randomUUID(),name:'Steel washers',category_id:category.id,
    category_reason:'confirmed',category_review:false,master_item_number:900001};
  const vendor={id:f.vendor,name:'Synthetic supplier'};
  const mappings=new Map();
  let quoteWrites=0,reviewWrites=0;
  const mappingFor=id=>{
    if(!mappings.has(id))mappings.set(id,{id:randomUUID(),organization_id:f.org,vendor_item_id:id,
      catalog_item_id:item.id,comparison_track:'exact',confidence_score:100,match_method:'manual'});
    return mappings.get(id);
  };
  const backend={pricing:{async applyQuote(p){
    assert.equal(p.organizationId,f.org);assert.equal(p.vendorId,f.vendor);
    const command=f.quote(p.sourceDocumentId,{
      item:p.vendorItemId,code:p.vendorItemCode,description:p.description,brand:p.brand,
      pack:p.packSize,price:p.price,key:p.importRow.rowKey,line:p.sourceLine,
      unavailable:p.priceUnavailable,importRow:p.importRow,
    });
    command.args[8]=p.effectiveDate;
    command.args[9]=p.quoteValidUntil;
    command.args[10]=p.sourceFilePath;
    command.args[11]=p.sourceFileName;
    command.args[14]=p.sellingUnit;
    command.args[15]=p.priceBasis;
    command.args[16]=p.gtin;
    command.args[17]=p.manufacturerCode;
    command.args[19]=JSON.stringify(p.fieldResolutions);
    const id=await f.call(db,command);quoteWrites++;return id;
  }},records:{query(table){
    assert.equal(table,'vendor_items');
    return {update(patch){
      assert.deepEqual(Object.keys(patch),['import_row']);
      const filters=new Map();
      const query={
        eq(key,value){assert.ok(['id','organization_id'].includes(key));filters.set(key,value);return query;},
        then(resolve,reject){
          assert.ok(filters.get('id'));assert.equal(filters.get('organization_id'),f.org);
          return db.query('update vendor_items set import_row=$1::jsonb where id=$2 and organization_id=$3 returning id',
            [JSON.stringify(patch.import_row),filters.get('id'),filters.get('organization_id')])
            .then(({rows})=>{reviewWrites++;return {data:rows,error:null};}).then(resolve,reject);
        },
      };
      return query;
    }};
  }}};
  const importService={mapping:async(org,id)=>{
    assert.equal(org,f.org);return mappingFor(id);
  }};
  const catalogService={async matchOrCreate(){throw new Error('The synthetic existing mapping must be reused');}};
  const read=async id=>{
    const {rows}=await db.query('select * from vendor_items where id=$1 and organization_id=$2',[id,f.org]);
    assert.equal(rows.length,1);return rows[0];
  };
  const evidenceFor=listing=>({item,vendorItem:listing,mapping:mappingFor(listing.id),vendor,category,categories:[category],peers:[]});
  const sourceRow=(code,price,unit='')=>{
    const parsed=parseDocument(`Code,Description,Brand,Pack,Price Unit,Price\n${code},STEEL WASHERS,Example,4/5 LB,${unit},${price}`);
    assert.equal(parsed.rows.length,1);return parsed.rows[0];
  };
  async function importRow(source,{ex=null,documentId,fileName='Synthetic.csv'}={}){
    const result=await importPriceRow({backend,importService,catalogService,
      sourceRow:structuredClone(source),row:structuredClone(source),ex,
      priorMapping:ex?mappingFor(ex.id):null,rowIssues:[],rowNeedsReview:false,invoiceSources:[],
      orgId:f.org,vendorId:f.vendor,sourceDocumentId:documentId,completedKey:'row:0',
      importBatchTime:'2026-11-11T12:00:00Z',group:{name:fileName},sourceFilePath:null,
      workingCatalogItems:[item],workingCategories:[category],workingVendorItems:ex?[ex]:[],
      workingMappings:ex?[mappingFor(ex.id)]:[],
    },procurement);
    return {result,listing:await read(result.vendorItemId)};
  }

  // Begin with a real parsed, stated price-unit source, then replace only the
  // active observations twice. The root must still point at the first document.
  const statedDocumentId=await f.document();
  const stated=sourceRow('W-1',35,'CASE');
  const first=await importRow(stated,{documentId:statedDocumentId,fileName:'Stated.csv'});
  assert.equal(first.result.needsBasis,false);
  const originalRoot=first.listing.import_row.evidence.fieldEvidence?.sellingUnit;
  assert.ok(originalRoot,'the actual SQL readback must include the stated unit root');
  assert.equal(originalRoot.source,'sheet');
  assert.equal(originalRoot.value,'CASE');
  assert.equal(originalRoot.organizationId,f.org);assert.equal(originalRoot.vendorId,f.vendor);
  assert.deepEqual(originalRoot.documentIds,[statedDocumentId]);
  assert.equal(originalRoot.reference,'Stated.csv');
  assert.equal(originalRoot.binding.header,'Price Unit');
  assert.equal(originalRoot.binding.rawValue,'CASE');
  assert.equal(originalRoot.binding.evidence,'stated');
  assert.equal(originalRoot.sourceLine,stated.sourceLine);
  const rootJSON=JSON.stringify(originalRoot);
  let current=first.listing;
  for(const [index,price] of [36,37].entries()){
    const documentId=await f.document();
    const incoming=sourceRow('W-1',price);
    assert.equal(incoming.sellingUnit,null);
    const saved=await importRow(incoming,{ex:current,documentId,fileName:`Blank-${index+1}.csv`});
    assert.equal(saved.result.needsBasis,false);
    current=saved.listing;
    assert.equal(current.id,first.listing.id);
    assert.equal(Number(current.price),price,'each new source retains its own price amount');
    assert.equal(current.import_row.sourceDocumentId,documentId);
    assert.equal(current.import_row.row.sellingUnit,null,'blank neutral source is never rewritten');
    assert.equal(current.import_row.evidence.sellingUnitSource,'remembered');
    assert.equal(JSON.stringify(current.import_row.evidence.fieldEvidence.sellingUnit),rootJSON,
      'the root JSON survives both successful database roundtrips without becoming the latest document');
    const origin=quotedUnitOrigin(current,procurement);
    assert.equal(origin.status,'confirmed');
    assert.deepEqual(origin.root,current.import_row.evidence.fieldEvidence.sellingUnit);
    assert.deepEqual(origin.root.documentIds,[statedDocumentId]);
  }
  assert.equal(quoteWrites,3);
  assert.equal(reviewWrites,0);
  const validHistory=(await db.query('select source_document_id,price from price_history where vendor_item_id=$1',[current.id])).rows;
  assert.equal(validHistory.length,3);
  assert.deepEqual(validHistory.map(row=>Number(row.price)).sort(),[35,36,37]);

  // A legacy remembered marker is no replacement for an actual stated source,
  // recorded client confirmation, or verified invoice root.
  const prooflessDocumentId=await f.document();
  const prooflessSource=sourceRow('W-2',45);
  const prooflessId=await f.call(db,f.quote(prooflessDocumentId,{
    code:'W-2',description:'STEEL WASHERS',brand:'Example',pack:'4/5 LB',price:45,
    importRow:{row:prooflessSource,evidence:{...prooflessSource,sellingUnit:'CS',sellingUnitSource:'remembered'},
      sourceDocumentId:prooflessDocumentId,sourceFileName:'Legacy.csv',rowKey:'row:0',reviewRequired:false},
  }));
  const prooflessInitial=await read(prooflessId);
  const assertHeld=listing=>{
    const fields=catalogRowEvidence(evidenceFor(listing)),assessment=orderGuideAssessment(evidenceFor(listing));
    assert.equal(fields.sellingUnit.status,'inferred');assert.equal(fields.sellingUnit.accuracy,70);
    assert.equal(fields.unitCost.status,'inferred');assert.match(fields.unitCost.reason,/Provisional/);
    assert.equal(assessment.ready,false);assert.ok(assessment.blockers.includes('sellingUnit'));
    assert.notEqual(quotedUnitOrigin(listing,procurement).status,'confirmed');
  };
  assertHeld(prooflessInitial);
  let held=prooflessInitial,retainedSource;
  for(const [index,price] of [46,47].entries()){
    const documentId=await f.document();
    const saved=await importRow(sourceRow('W-2',price),{ex:held,documentId,fileName:`Unproven-${index+1}.csv`});
    assert.equal(saved.result.needsBasis,true);held=saved.listing;
    assert.equal(held.selling_unit,'CS');assert.equal(Number(held.price),45);
    assert.equal(held.import_row.sourceDocumentId,documentId);
    assert.equal(held.import_row.row.price,price);assert.equal(held.import_row.row.sellingUnit,null);
    assert.equal(held.import_row.reviewRequired,true);assert.ok(held.import_row.reviewFields.includes('selling_unit'));
    assert.equal(held.import_row.retainedSource.sourceDocumentId,prooflessDocumentId);
    if(retainedSource)assert.deepEqual(held.import_row.retainedSource,retainedSource);
    retainedSource=structuredClone(held.import_row.retainedSource);assertHeld(held);
  }
  assert.equal(quoteWrites,3,'proofless held imports cannot invoke the quote RPC');
  assert.equal(reviewWrites,2);
  const heldHistory=(await db.query('select price from price_history where vendor_item_id=$1',[prooflessId])).rows;
  assert.equal(heldHistory.length,1,'held imports cannot add a usable quotation to history');
  assert.equal(Number(heldHistory[0].price),45);

  // The same authenticated SQL policy protects the durable root from a user
  // outside the organization, rather than relying on an in-memory denial.
  const beforeDenied=structuredClone(current.import_row);
  await f.actor(db,f.outsider);
  assert.equal((await db.query('select id from vendor_items where id=$1',[current.id])).rows.length,0);
  const denied=await backend.records.query('vendor_items').update({import_row:{
    ...beforeDenied,evidence:{...beforeDenied.evidence,fieldEvidence:{sellingUnit:{...originalRoot,source:'client confirmation',confirmedBy:f.outsider}}},
  }}).eq('id',current.id).eq('organization_id',f.org);
  assert.equal(denied.error,null);assert.deepEqual(denied.data,[]);
  await f.actor(db,f.owner);
  assert.deepEqual((await read(current.id)).import_row,beforeDenied,'outsider cannot rewrite any root JSON');
  console.log('PASS quoted-unit roots SQL: stated source → two blank-unit imports preserve the same original document, cell and root through real quote RPC saves.');
  console.log('PASS quoted-unit roots SQL: proofless remembered unit stays inferred 70%, provisional and held across two imports; original amount and quote history stay unchanged.');
  console.log('PASS quoted-unit roots SQL: real row-level security prevents outsider root changes.');
}finally{await db.close();}
