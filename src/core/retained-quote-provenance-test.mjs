// Regression: an unresolved reimport must not promote the provenance of the
// retained quoted unit. The production importer and catalog/readiness helpers
// run against local capture objects only; no hosted backend is instantiated.
import assert from 'node:assert/strict';
import {configureProcurement,createProcurementContext} from '../procurement.js';
import {importPriceRow} from './import-price-row.js';
import {catalogRowEvidence,orderGuideAssessment} from './catalog-fields.js';
import {resolveQuoteBasis} from './quote-basis.js';
import {parseDocument} from '../ingestion.js';

configureProcurement({industry:'construction'});
const procurement=createProcurementContext({industry:'construction'});
const organizationId='synthetic-organization';
const vendorId='synthetic-vendor';
const category={id:'synthetic-category',name:'Supplies',range_start:900000,range_end:999999};
const item={id:'synthetic-item',name:'Steel washers',category_id:category.id,
  category_reason:'confirmed',category_review:false,master_item_number:900001};
const mapping={id:'synthetic-mapping',organization_id:organizationId,
  vendor_item_id:'synthetic-listing',catalog_item_id:item.id,
  comparison_track:'exact',confidence_score:100,match_method:'manual'};
const vendor={id:vendorId,name:'Synthetic supplier'};
const editors={editor:{full_name:'Kai Morgan'}};
const original={code:'W-1',description:'STEEL WASHERS',brand:'Example',packSize:'4/5 LB',
  sellingUnit:null,price:35,sourceLine:'W-1,STEEL WASHERS,Example,4/5 LB,,35.00'};

function seed({inferred=true}={}){
  const row={...original,...(!inferred?{sellingUnit:'CASE'}:{})};
  return {id:mapping.vendor_item_id,organization_id:organizationId,vendor_id:vendorId,
    vendor_item_code:original.code,description:original.description,brand:original.brand,
    pack_size:original.packSize,selling_unit:inferred?'CS':'CASE',price_basis:'case',
    price:35,price_source:'pricelist',price_unavailable:inferred,field_resolutions:{},
    import_row:{row,evidence:{...row,sellingUnitSource:inferred?'inferred':'price header'},
      sourceDocumentId:'original-document',sourceFileName:'Original.csv',
      reviewRequired:inferred,reviewFields:inferred?['selling_unit']:[]}};
}

function fixture(initial=seed()){
  let listing=structuredClone(initial);
  const calls={reviewPatches:[],priceQuotes:[]};
  const chain={
    eq(column,value){
      assert.equal(listing[column],value,'review writes remain scoped to the existing listing');
      return chain;
    },
    then(resolve,reject){return Promise.resolve({data:null,error:null}).then(resolve,reject);},
  };
  const backend={records:{query(table){
    assert.equal(table,'vendor_items');
    return {update(value){calls.reviewPatches.push(structuredClone(value));listing={...listing,...structuredClone(value)};return chain;}};
  }},pricing:{async applyQuote(quote){
    calls.priceQuotes.push(structuredClone(quote));
    listing={...listing,description:quote.description,brand:quote.brand,pack_size:quote.packSize,
      selling_unit:quote.sellingUnit,price_basis:quote.priceBasis,price:quote.price,
      price_unavailable:quote.priceUnavailable,import_row:structuredClone(quote.importRow),
      field_resolutions:structuredClone(quote.fieldResolutions)};
    return listing.id;
  }}};
  const input=current=>({item,vendorItem:current,mapping,vendor,category,categories:[category],peers:[],editors});
  return {
    calls,
    read:()=>structuredClone(listing),
    evidence:()=>catalogRowEvidence(input(listing)),
    assessment:()=>orderGuideAssessment(input(listing)),
    async import(source,{documentId='incoming-document',rowIssues=[],invoiceSources=[]}={}){
      const before=structuredClone(source);
      const result=await importPriceRow({backend,
        importService:{mapping:async(org,id)=>{
          assert.equal(org,organizationId);assert.equal(id,listing.id);return mapping;
        }},catalogService:{},sourceRow:structuredClone(source),row:structuredClone(source),
        ex:structuredClone(listing),priorMapping:structuredClone(mapping),
        rowIssues,rowNeedsReview:rowIssues.length>0,invoiceSources,
        orgId:organizationId,vendorId,sourceDocumentId:documentId,completedKey:'row:0',
        importBatchTime:'2026-11-10T23:44:54Z',group:{name:documentId+'.csv'},sourceFilePath:null,
        workingCatalogItems:[structuredClone(item)],workingCategories:[structuredClone(category)],
        workingVendorItems:[structuredClone(listing)],workingMappings:[structuredClone(mapping)],
      },procurement);
      assert.deepEqual(source,before,'the caller source remains unchanged');
      return result;
    },
  };
}

let passed=0;
async function test(name,run){await run();passed++;console.log('PASS '+name);}

await test('unresolved reimport retains the inferred unit, its accuracy and provisional cost',async()=>{
  const f=fixture(),before=f.read();
  assert.equal(f.evidence().sellingUnit.status,'inferred');
  assert.equal(f.evidence().sellingUnit.accuracy,70);
  assert.equal(f.evidence().unitCost.status,'inferred');
  const incoming={...original,price:36,sourceLine:'W-1,STEEL WASHERS,Example,4/5 LB,,36.00'};
  assert.equal((await f.import(incoming)).needsBasis,true);
  const after=f.read();
  // Assert the reported false-green symptom before inspecting storage details.
  assert.equal(f.evidence().sellingUnit.status,'inferred');
  assert.equal(f.evidence().sellingUnit.accuracy,70);
  assert.equal(f.evidence().unitCost.status,'inferred');
  assert.equal(f.calls.priceQuotes.length,0,'an unresolved observation cannot replace the quote');
  assert.equal(f.calls.reviewPatches.length,1);
  assert.equal(after.selling_unit,before.selling_unit);
  assert.equal(after.price,before.price);
  assert.equal(after.import_row.row.price,36,'incoming neutral data remains available for review');
  assert.equal(after.import_row.evidence.sellingUnit||null,null,'incoming interpretation remains unresolved');
  assert.equal(after.import_row.row.sellingUnit,null,'the neutral incoming unit remains blank');
  assert.equal(after.import_row.retainedSource.values.selling_unit,'CS');
  assert.deepEqual(after.import_row.retainedSource.row,before.import_row.row);
  assert.deepEqual(after.import_row.retainedSource.evidence,before.import_row.evidence);
  assert.equal(after.import_row.retainedSource.sourceDocumentId,'original-document');
  assert.equal(after.import_row.retainedSource.sourceFileName,'Original.csv');
  assert.equal(f.evidence().sellingUnit.status,'inferred');
  assert.equal(f.evidence().sellingUnit.accuracy,70);
  assert.equal(f.evidence().unitCost.status,'inferred');
  assert.match(f.evidence().unitCost.reason,/Provisional/);
  assert.equal(f.assessment().ready,false);
  assert.ok(f.assessment().blockers.includes('sellingUnit'));
  assert.ok(f.assessment().blockers.includes('source'));
});

await test('repeated held imports keep the original value-bound source rather than the preceding pending row',async()=>{
  const f=fixture();
  await f.import({...original,price:36},{documentId:'first-pending-document'});
  const retained=structuredClone(f.read().import_row.retainedSource);
  await f.import({...original,price:37},{documentId:'second-pending-document'});
  const after=f.read();
  assert.equal(f.calls.priceQuotes.length,0);
  assert.equal(f.calls.reviewPatches.length,2);
  assert.equal(after.import_row.sourceDocumentId,'second-pending-document');
  assert.equal(after.import_row.row.price,37);
  assert.deepEqual(after.import_row.retainedSource,retained);
  assert.equal(after.selling_unit,'CS');assert.equal(after.price,35);
  assert.equal(f.evidence().sellingUnit.status,'inferred');
  assert.equal(f.evidence().sellingUnit.accuracy,70);
  assert.equal(f.assessment().ready,false);
});

await test('a source-backed retained case keeps its own confirmation while a different pending unit remains under review',async()=>{
  const f=fixture(seed({inferred:false}));
  const incoming={...original,packSize:'8/5 LB',sellingUnit:'LB',sellingUnitSource:'price header',price:2};
  assert.equal((await f.import(incoming)).needsBasis,true);
  const after=f.read();
  assert.equal(after.selling_unit,'CASE');assert.equal(after.pack_size,'4/5 LB');assert.equal(after.price,35);
  assert.equal(after.import_row.evidence.sellingUnit,'LB');
  assert.equal(after.import_row.row.packSize,'8/5 LB');
  assert.equal(after.import_row.retainedSource.evidence.sellingUnit,'CASE');
  assert.equal(f.evidence().sellingUnit.status,'confirmed');
  assert.match(f.evidence().sellingUnit.reason,/sheet|header/i);
  assert.equal(f.assessment().ready,false,'a valid retained value does not accept the pending observation');
});

await test('a stale manual resolution for pounds cannot confirm a retained case value',async()=>{
  const listing=seed();
  listing.field_resolutions.selling_unit={value:'LB',confirmedBy:'editor',confirmedAt:'2026-11-09T12:00:00Z'};
  const f=fixture(listing);
  assert.notEqual(f.evidence().sellingUnit.status,'confirmed');
  assert.ok(f.evidence().sellingUnit.accuracy<=70);
});

await test('matching client confirmation can confirm the value, including equivalent case spellings and actor',async()=>{
  const listing=seed();
  listing.field_resolutions.selling_unit={value:'CASE',sourceValue:null,confirmedBy:'editor',confirmedAt:'2026-11-09T12:00:00Z'};
  const f=fixture(listing),evidence=f.evidence();
  assert.equal(evidence.sellingUnit.status,'confirmed');
  assert.equal(evidence.sellingUnit.accuracy,100);
  assert.equal(evidence.sellingUnit.by,'KM');
  assert.match(evidence.sellingUnit.reason,/KM/);
  await f.import({...original,packSize:'8/5 LB'},{documentId:'client-confirmed-held-document'});
  assert.equal(f.read().field_resolutions.selling_unit.confirmedBy,'editor');
  assert.equal(f.evidence().sellingUnit.status,'confirmed');
  assert.equal(f.evidence().sellingUnit.by,'KM');
});

await test('absent proof cannot turn a saved unit into a Confirmed label',async()=>{
  const listing=seed();
  listing.import_row={row:{description:original.description,packSize:original.packSize,price:35},evidence:{}};
  const f=fixture(listing);
  assert.notEqual(f.evidence().sellingUnit.status,'confirmed');
  await f.import({...original,price:38});
  assert.notEqual(f.evidence().sellingUnit.status,'confirmed');
});

await test('a successful source-backed quote replaces retained provenance instead of inheriting a previous guess',async()=>{
  const f=fixture();await f.import({...original,price:36});
  assert.ok(f.read().import_row.retainedSource);
  const incoming={...original,sellingUnit:'CASE',sellingUnitSource:'price header',price:40};
  assert.equal((await f.import(incoming,{documentId:'new-stated-document'})).needsBasis,false);
  const after=f.read();
  assert.equal(f.calls.priceQuotes.length,1);
  assert.equal(after.selling_unit,'CASE');assert.equal(after.price,40);
  assert.equal(after.import_row.sourceDocumentId,'new-stated-document');
  assert.equal(after.import_row.retainedSource,undefined);
  assert.equal(after.import_row.evidence.sellingUnitSource,'price header');
  assert.equal(f.evidence().sellingUnit.status,'confirmed');
  assert.notEqual(f.evidence().unitCost.status,'inferred');
});

// These additional controls inspect the new shared accessor after the
// importer regression above has already exercised the original failure.
const {captureRetainedSource,listingSourceForField,quotedUnitOrigin}=await import('./listing-provenance.js');

await test('a retained unit cannot borrow pending proof when its value binding is missing or mismatched',async()=>{
  for(const values of [{price:35},{selling_unit:'LB'}]){
    const listing=seed({inferred:false});
    listing.import_row={retainedSource:{values,row:{sellingUnit:'CASE'},evidence:{sellingUnit:'CASE',sellingUnitSource:'price header'},sourceDocumentId:'unbound-old-document'},
      row:{...original,sellingUnit:'CASE'},evidence:{sellingUnit:'CASE',sellingUnitSource:'price header'},sourceDocumentId:'pending-document',reviewRequired:false};
    listing.field_resolutions.selling_unit={value:'LB',confirmedBy:'editor',confirmedAt:'2026-11-09T12:00:00Z'};
    const source=listingSourceForField(listing,'selling_unit');
    assert.equal(source.bound,false);
    assert.equal(quotedUnitOrigin(listing,procurement).status,null);
    assert.equal(resolveQuoteBasis(original,listing,procurement),null);
    const f=fixture(listing);
    assert.notEqual(f.evidence().sellingUnit.status,'confirmed');
    assert.ok(f.evidence().sellingUnit.accuracy<=70,'unbound retained proof and stale manual proof cannot qualify the unit');
    assert.equal(f.assessment().ready,false);
    assert.ok(f.assessment().blockers.includes('sellingUnit'));
  }
});

await test('a price-only change does not invalidate independent proof for the unchanged quoted unit',async()=>{
  const listing=seed({inferred:false}),retained=captureRetainedSource(listing);
  const changed={...listing,price:40,import_row:{retainedSource:retained,row:{...original,sellingUnit:'LB'},evidence:{sellingUnit:'LB',sellingUnitSource:'price header'},sourceDocumentId:'pending-document',reviewRequired:true}};
  assert.equal(listingSourceForField(changed,'selling_unit').bound,true);
  assert.equal(listingSourceForField(changed,'price').bound,false);
  const origin=quotedUnitOrigin(changed,procurement);
  assert.equal(origin.status,'confirmed');
  assert.equal(origin.sourceDocumentId,'original-document');
  assert.equal(origin.evidence.sellingUnit,'CASE');
  assert.equal(fixture(changed).evidence().sellingUnit.status,'confirmed');
});

await test('a matching client confirmation authorizes later prior reuse while a stale different-unit resolution does not',async()=>{
  const listing=seed(),retained=captureRetainedSource(listing);
  listing.import_row={...listing.import_row,retainedSource:retained,reviewRequired:false,
    row:{...original,sellingUnit:null},evidence:{...original,sellingUnitSource:null},sourceDocumentId:'latest-pending-document'};
  listing.field_resolutions.selling_unit={value:'CASE',sourceValue:null,confirmedBy:'editor',confirmedAt:'2026-11-09T12:00:00Z'};
  const origin=quotedUnitOrigin(listing,procurement);
  assert.equal(origin.status,'confirmed');
  assert.equal(origin.confirmation.confirmedBy,'editor');
  assert.equal(origin.sourceDocumentId,'original-document');
  assert.equal(resolveQuoteBasis(original,listing,procurement).source,'confirmed vendor item');
  assert.equal(resolveQuoteBasis(original,listing,procurement).sellingUnit,'CS');
  listing.field_resolutions.selling_unit={...listing.field_resolutions.selling_unit,value:'LB'};
  assert.equal(quotedUnitOrigin(listing,procurement).status,'inferred');
  assert.equal(resolveQuoteBasis(original,listing,procurement),null);
  assert.equal(fixture(listing).evidence().sellingUnit.accuracy,70);
});

await test('verified invoice billing evidence replaces the held inference without copying the invoice amount',async()=>{
  const f=fixture();await f.import({...original,price:36});
  const invoice=parseDocument('Item,Description,Pack,Price Unit,Qty,Unit Price,Extended Price\nW-1,STEEL WASHERS,4/5 LB,CASE,2,35,70').rows[0];
  assert.ok(invoice.billingUnitEvidence);
  const invoiceSources=[{row:invoice,id:'verified-invoice',number:'SYNTHETIC-INVOICE',organizationId,vendorId}];
  const result=await f.import({...original,price:40},{documentId:'price-sheet-after-invoice',invoiceSources});
  assert.equal(result.needsBasis,false);
  const after=f.read();
  assert.equal(after.price,40,'verified billing unit must not copy the historical invoice price');
  assert.equal(after.import_row.evidence.sellingUnitSource,'invoice');
  assert.equal(after.import_row.evidence.quoteBasisEvidence.references[0].documentId,'verified-invoice');
  assert.equal(after.import_row.retainedSource,undefined);
  assert.equal(f.evidence().sellingUnit.status,'confirmed');
  assert.match(f.evidence().sellingUnit.reason,/invoice/);
});

await test('a matching inferred value cannot become confirmed merely because its source flag was omitted',async()=>{
  const listing=seed();
  listing.import_row.evidence={...original,sellingUnit:'CS',fieldInference:{sellingUnit:{value:'CASE',kind:'inferred',source:'cross-vendor comparison',accuracy:70,reason:'Synthetic compared proposal'}}};
  assert.equal(listing.import_row.evidence.sellingUnitSource,undefined);
  assert.equal(quotedUnitOrigin(listing,procurement).status,'inferred');
  const f=fixture(listing);
  assert.equal(f.evidence().sellingUnit.status,'inferred');
  assert.ok(f.evidence().sellingUnit.accuracy<=70);
  assert.equal(f.evidence().unitCost.status,'inferred');
  assert.equal(f.assessment().ready,false);
});

await test('a raw case statement cannot borrow the source attribution of mismatched invoice pounds',async()=>{
  const listing=seed({inferred:false});
  listing.import_row.evidence={...listing.import_row.evidence,sellingUnit:'LB',sellingUnitSource:'invoice',
    quoteBasisEvidence:{source:'invoice billing unit',unit:'LB',references:[{documentId:'different-unit-invoice'}]}};
  const origin=quotedUnitOrigin(listing,procurement);
  assert.doesNotMatch(String(origin.source),/invoice/i);
  const evidence=fixture(listing).evidence();
  assert.doesNotMatch(evidence.sellingUnit.reason,/invoice/i,'the displayed CASE cannot claim the mismatched invoice as its proof');
});

console.log(`${passed} retained-quote provenance regression cases passed (isolated in-memory importer; no hosted writes).`);
