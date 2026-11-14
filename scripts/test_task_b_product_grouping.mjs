// Task B acceptance #1–16. Uses the production parser, import worker, and
// row/catalog services. Provider writes are simulated; SQL locking is tested
// separately. Optional KERDOS_TASK_B_SOURCE_ROWS supplies extracted vendor sheets.
import assert from 'node:assert/strict';
import {readFileSync,writeFileSync} from 'node:fs';
import {test} from 'node:test';
import {createPriceImportFixture} from './fixtures/price-import-backend.mjs';
import {importPriceRow} from '../src/core/import-price-row.js';
import {catalogMigrationAssessment} from '../src/core/catalog-migration-tier.js';
import {findUncodedVendorListing} from '../src/core/vendor-listing.js';
import {parseDocument} from '../src/ingestion.js';
import {createProcurementContext} from '../src/procurement.js';
import {createCatalogService} from '../src/services/catalog.js';
import {createImportService} from '../src/services/imports.js';
import {processAttachmentInBackground} from '../supabase/functions/process-attachment/background-import.mjs';

const org = '00000000-0000-4000-8000-000000000001';
const vendorA = '00000000-0000-4000-8000-000000000002';
const vendorB = '00000000-0000-4000-8000-000000000003';
const vendorC = '00000000-0000-4000-8000-000000000004';
const category = {
  id:'00000000-0000-4000-8000-000000000005', organization_id:org, name:'All products',
  range_start:10000, range_end:99999, is_holding_pen:true, keywords:[],
};
const normalizedName = name => String(name).normalize('NFKD').replace(/\p{Diacritic}/gu,'')
  .toLowerCase().replace(/[^\p{L}\p{N}]+/gu,' ').trim();

function setup(text='',vocabulary=[]) {
  const fixture = createPriceImportFixture({text, industry:'restaurant', vocabulary, multiRow:true});
  fixture.categories.push({...category});
  const procurement = createProcurementContext({industry:'restaurant',vocabulary});
  return {
    ...fixture, procurement,
    catalogService:createCatalogService(fixture.backend,procurement),
    importService:createImportService(fixture.backend),
  };
}

function makeRow(description, options={}) {
  return {code:'A',description,packSize:'4/10 LB',price:80,sellingUnit:'CASE',...options};
}

async function manual(state, vendorId, sourceRow, sourceDocumentId='doc-1', index=0) {
  const candidates = state.vendorItems.filter(item=>item.vendor_id===vendorId);
  const ex = sourceRow.code
    ? await state.importService.findVendorItem({organizationId:org,vendorId,code:sourceRow.code})
    : findUncodedVendorListing(sourceRow,candidates,undefined,state.procurement).item;
  const priorMapping = ex ? await state.importService.mapping(org,ex.id) : null;
  return importPriceRow({
    backend:state.backend,importService:state.importService,catalogService:state.catalogService,
    sourceRow,row:sourceRow,ex,priorMapping,rowIssues:[],rowNeedsReview:false,invoiceSources:[],
    orgId:org,vendorId,sourceDocumentId,completedKey:`row:${index}`,
    importBatchTime:'2026-11-13T13:00:00.000Z',group:{name:sourceDocumentId},
    workingCatalogItems:[...state.catalogItems],workingCategories:[...state.categories],
    workingVendorItems:[...state.vendorItems],workingMappings:Object.values(state.mappings),
  },state.procurement);
}

function email(state,vendorId,text) {
  return processAttachmentInBackground(state.backend,{
    id:'attachment',filename:'Prices.csv',content_type:'text/csv',
    storage_path:`${org}/inbound/Prices.csv`,file_size_bytes:Buffer.byteLength(text),
  },{organizationId:org,vendorId,documentType:'pricelist'});
}

const mappingFor = (state, vendorId, code='A') => {
  const listing = state.vendorItems.find(item => item.vendor_id === vendorId && item.vendor_item_code === code);
  assert.ok(listing,`vendor ${vendorId} listing ${code}`);
  const mapping = state.mappings[listing.id];
  assert.ok(mapping,`mapping for ${listing.id}`);
  return mapping;
};

function assertIdentityLink(mapping) {
  assert.equal(mapping.comparison_track,'exact');
  assert.equal(mapping.match_method,'product_label');
  assert.equal(mapping.confidence_score,90);
}

async function baconPair(first,second) {
  const state=setup();
  await manual(state,vendorA,first);
  await manual(state,vendorB,second,'doc-2');
  assert.equal(state.catalogItems.length,1);
  assert.equal(state.catalogItems[0].name,'Bacon');
  assert.equal(state.catalogItems[0].concept_key,'product:bacon');
  assert.ok(state.catalogItems[0].concept_key_set_at);
  assert.equal(state.vendorItems.length,2);
  const [left,right]=[vendorA,vendorB].map(vendorId=>mappingFor(state,vendorId));
  assert.equal(left.catalog_item_id,right.catalog_item_id);
  assertIdentityLink(left);
  assertIdentityLink(right);
  const sourceFields = row => [row.description,row.packSize,row.brand??null,row.price];
  assert.deepEqual(state.vendorItems.map(item=>[item.description,item.pack_size,item.brand,item.price]),
    [first,second].map(sourceFields));
}

test('1. same product and pack from two vendors creates one item and two listings',async()=>{
  await baconPair(makeRow('BACON LAYOUT'),makeRow('BACON LAYOUT'));
});

test('2. different packs and brands link directly to the same item and preserve each offer',async()=>{
  await baconPair(makeRow('BACON LAYOUT',{packSize:'15 LB',brand:'Vendor A brand',price:53}),
    makeRow('BACON LAYOUT',{packSize:'10 LB',brand:'Vendor B brand',price:37}));
});

test('3. shorthand creates the canonical Bacon item in an empty catalog',async()=>{
  await baconPair(makeRow('BCON LAYOUT 15LB',{packSize:'15 LB'}),makeRow('BACON LAYOUT',{packSize:'10 LB'}));
});

test('4. the full Bacon spelling can arrive before shorthand',async()=>{
  await baconPair(makeRow('BACON LAYOUT',{packSize:'10 LB'}),makeRow('BCON LAYOUT 15LB',{packSize:'15 LB'}));
});

test('5. different cuts and forms stay distinct',async()=>{
  const state=setup();
  for(const [index,description] of ['CHICKEN BREAST','CHICKEN THIGH','SAUSAGE LINK','SAUSAGE PATTIES',
    'FRESH ARTICHOKE HEARTS','CANNED ARTICHOKE HEARTS','JARRED ARTICHOKE HEARTS','DRIED ARTICHOKE HEARTS'].entries()){
    await manual(state,vendorA,makeRow(description,{code:`cut-${index}`}), 'cuts',index);
  }
  assert.equal(state.catalogItems.length,8);
  assert.equal(new Set(state.catalogItems.map(item=>item.concept_key)).size,8);
  assert.ok(Object.values(state.mappings).every(mapping=>mapping.comparison_track==='exact'));
});

test('6. levels share one catalog item while original vendor grades remain visible',async()=>{
  const state=setup();
  const descriptions=['WHOLE MILK','SKIM MILK','MILK 2%'];
  for(const [index,vendorId] of [vendorA,vendorB,vendorC].entries()){
    await manual(state,vendorId,makeRow(descriptions[index],{packSize:'4/1 GAL'}),`milk-${index}`);
  }
  assert.equal(state.catalogItems.length,1);
  assert.equal(state.catalogItems[0].name,'Milk');
  assert.deepEqual(state.vendorItems.map(item=>item.description),descriptions);
  assert.deepEqual(state.vendorItems.map(item=>item.import_row.row.description),descriptions);
});

test('7. ambiguous wording flags review without joining an existing item',async()=>{
  const state=setup();
  const known=await manual(state,vendorA,makeRow('CORNED BEEF'));
  const uncertain=await manual(state,vendorB,makeRow('DELI TRIM CRN BEEF'),'ambiguous');
  const mapping=mappingFor(state,vendorB);
  assert.notEqual(mapping.catalog_item_id,known.match.catalogItemId);
  assert.equal(mapping.comparison_track,'review');
  assert.match(JSON.stringify(uncertain.identityReview||uncertain.match?.reason),/corn/i);
  assert.equal(state.catalogItems.find(item=>item.id===mapping.catalog_item_id).concept_key??null,null);
});

test('8. reimport creates neither a new item nor a new link',async()=>{
  const state=setup();
  const source=makeRow('BACON LAYOUT');
  const first=await manual(state,vendorA,source);
  const second=await manual(state,vendorA,source);
  assert.equal(second.vendorItemId,first.vendorItemId);
  assert.equal(second.match,null);
  assert.equal(state.catalogItems.length,1);
  assert.equal(state.calls.createMapping.length,1);
});

test('9. unreadable pack does not block identity linking',async()=>{
  const state=setup();
  const known=await manual(state,vendorA,makeRow('BACON LAYOUT'));
  const incoming=await manual(state,vendorB,makeRow('BCON LAYOUT',{packSize:'SUPPLIER PACK'}),'unreadable');
  const mapping=mappingFor(state,vendorB);
  assert.equal(mapping.catalog_item_id,known.match.catalogItemId);
  assertIdentityLink(mapping);
  assert.equal(state.procurement.parsePackSize('SUPPLIER PACK')?.parsed??false,false);
  assert.equal(incoming.vendorItemId,state.vendorItems[1].id);
  assert.equal(state.vendorItems[1].pack_size,'SUPPLIER PACK');
});

const supplied=process.env.KERDOS_TASK_B_SOURCE_ROWS;
const sourceSheets=supplied?JSON.parse(readFileSync(supplied,'utf8')):null;
const vocabularyPath=process.env.KERDOS_TASK_B_VOCABULARY;
const sourceVocabulary=vocabularyPath?JSON.parse(readFileSync(vocabularyPath,'utf8')).vocabulary:[];
let baseline;
async function baselineImport(){
  if(baseline)return baseline;
  baseline=(async()=>{
    const state=setup('',sourceVocabulary);
    const sheets=sourceSheets||[
      {file:'Sheet 1',rows:[{description:'WHOLE MILK'},{description:'BCON LAYOUT'},{description:'GARLIC PEELED'}]},
      {file:'Sheet 2',rows:[{description:'SKIM MILK'},{description:'BACON'},{description:'GARLIC'}]},
      {file:'Sheet 3',rows:[{description:'MILK 2%'},{description:'TURKEY BACON'},{description:'GARLIC PEELED'}]},
      {file:'Sheet 4',rows:[{description:'MILK 1%'},{description:'SAUSAGE LINKS'},{description:'SAUSAGE PATTIES'}]},
    ];
    let processed=0;
    let held=0;
    const reviews=[];
    for(const [sheetIndex,sheet] of sheets.entries()){
      const vendorId=`00000000-0000-4000-8000-${String(sheetIndex+10).padStart(12,'0')}`;
      for(const [index,row] of sheet.rows.entries()){
        const source = Object.hasOwn(row,'price')
          ? row : makeRow(row.description,{code:`item-${index}`,brand:row.brand??null,packSize:row.pack??null});
        const result=await manual(state,vendorId,source,sheet.file,index);
        assert.ok(result.vendorItemId,`${sheet.file} source row ${index+1} has a listing`);
        processed++;
        if(result.needsBasis)held++;
        if(result.identityReview)reviews.push({sheet:sheet.file,row:index+1,
          description:source.description,reason:result.identityReview.reason});
      }
    }
    assert.equal(processed,sheets.reduce((count,sheet)=>count+sheet.rows.length,0));
    assert.equal(Object.keys(state.mappings).length,state.vendorItems.length);
    state.processedRows=processed;
    state.heldRows=held;
    state.reviews=reviews;
    return state;
  })();
  return baseline;
}
function duplicateGroups(items,keyFor){
  const buckets=Map.groupBy(items.filter(item=>!item.merged_into_id&&!item.concept_split_from_id),keyFor);
  return [...buckets.entries()].filter(([key,items])=>key&&items.length>1)
    .map(([key,items])=>[key,items.map(item=>item.name)]);
}

test('10. after all sheets there are no unintended duplicate product labels',async()=>{
  const state=await baselineImport();
  assert.deepEqual(duplicateGroups(state.catalogItems,item=>item.concept_key),[]);
  if(sourceSheets){
    const assigned=Object.values(state.mappings);
    const catalogById=new Map(state.catalogItems.map(item=>[item.id,item]));
    const review=assigned.filter(mapping=>catalogById.get(mapping.catalog_item_id)?.concept_review_required).length;
    const readerStatus={recognized:0,literal:0,review:0};
    for(const {description,pack_size,brand} of state.vendorItems){
      const {status}=state.procurement.readProductLabel({description,pack_size,brand});
      readerStatus[status]++;
    }
    const noDictionaryProduct=readerStatus.literal+readerStatus.review;
    const groupVendors=new Map();
    for(const listing of state.vendorItems){
      const catalogItemId=state.mappings[listing.id].catalog_item_id;
      const vendors=groupVendors.get(catalogItemId)||new Set();
      vendors.add(listing.vendor_id);
      groupVendors.set(catalogItemId,vendors);
    }
    const crossVendor=[...groupVendors.values()].filter(vendors=>vendors.size>1).length;
    const tiers={1:0,2:0,3:0};
    for(const listing of state.vendorItems){
      const mapping=state.mappings[listing.id];
      const item=catalogById.get(mapping.catalog_item_id);
      const {tier}=catalogMigrationAssessment({item,listing,mapping,procurement:state.procurement,now:'2026-11-13'});
      tiers[tier]++;
    }
    console.log(`Four-sheet replay: ${state.processedRows} source rows, ${state.vendorItems.length} listings, ${state.catalogItems.length} catalog entries, ${crossVendor} cross-vendor groups, ${review} identity reviews, ${noDictionaryProduct} without a dictionary product (${readerStatus.literal} literal, ${readerStatus.review} reader review), ${state.heldRows} source/price holds, tiers ${JSON.stringify(tiers)}.`);
    const reportPath=process.env.KERDOS_TASK_B_REPORT;
    if(reportPath)writeFileSync(reportPath,JSON.stringify({
      sourceRows:state.processedRows,listings:state.vendorItems.length,catalogEntries:state.catalogItems.length,
      crossVendor,review,noDictionaryProduct,readerStatus,identityReviews:state.reviews,sourceHolds:state.heldRows,tiers,
      groupExamples:state.catalogItems.filter(item=>['product:bacon','product:milk'].includes(item.concept_key)).map(item=>({
        itemNumber:item.master_item_number,name:item.name,conceptKey:item.concept_key,
        listings:state.vendorItems.filter(listing=>state.mappings[listing.id].catalog_item_id===item.id)
          .map(({vendor_id,description,pack_size,price,price_basis})=>({vendor_id,description,pack_size,price,price_basis})),
      })),
    },null,2)+'\n');
  }
});

test('11. after all sheets there are no unintended duplicate normalized names',async()=>{
  const state=await baselineImport();
  assert.deepEqual(duplicateGroups(state.catalogItems,item=>normalizedName(item.name)),[]);
});

test('12. a new import preserves client groups, split mappings, and listing corrections',async()=>{
  const state=setup();
  await manual(state,vendorA,makeRow('WHOLE MILK'));
  await manual(state,vendorB,makeRow('SKIM MILK'),'skim');
  const original=state.catalogItems[0];
  const split={...original,id:'client-split',name:'Dino’s Skim Milk',concept_split_from_id:original.id,
    master_item_number:original.master_item_number+1};
  state.catalogItems.push(split);
  const retained=state.vendorItems.find(item=>item.vendor_id===vendorA);
  const corrected=state.vendorItems.find(item=>item.vendor_id===vendorB);
  Object.assign(state.mappings[retained.id],{match_method:'manual',confidence_score:100,reviewed_by:'owner'});
  Object.assign(state.mappings[corrected.id],{catalog_item_id:split.id,match_method:'manual',confidence_score:100,reviewed_by:'owner'});
  corrected.field_resolutions={brand:{source:'manual',value:'Client corrected brand'}};
  const prior={mappings:structuredClone(state.mappings),listing:structuredClone(corrected)};
  await manual(state,vendorC,makeRow('MILK 2%'),'new-vendor');
  assert.deepEqual(state.mappings[retained.id],prior.mappings[retained.id]);
  assert.deepEqual(state.mappings[corrected.id],prior.mappings[corrected.id]);
  assert.deepEqual(corrected,prior.listing);
  assert.equal(mappingFor(state,vendorC).catalog_item_id,original.id);
});

test('13. deliberate same-label split stays separate and a new listing goes to the original',async()=>{
  const state=setup();
  await manual(state,vendorA,makeRow('WHOLE MILK'));
  const original=state.catalogItems[0];
  const split={...original,id:'saved-split',name:'Milk',concept_split_from_id:original.id,
    created_at:'2025-01-01T00:00:00.000Z',master_item_number:original.master_item_number+1};
  state.catalogItems.push(split);
  const before=structuredClone(split);
  const result=await manual(state,vendorB,makeRow('SKIM MILK'),'split-check');
  assert.equal(mappingFor(state,vendorB).catalog_item_id,original.id);
  assert.deepEqual(split,before);
  assert.equal(state.catalogItems.length,2);
  assert.equal(result.match.sameLabelCount,2,'the same-label selection is reported');
});

test('14. simultaneous manual and email imports use one catalog item', {timeout:5000}, async()=>{
  const text='Code,Description,Pack,Price Unit,Price\nA,BACON LAYOUT,10 LB,CASE,37';
  const state=setup(text);
  const findOrCreate=state.backend.catalog.findOrCreateProductItem;
  let releaseLookups;
  const bothLookups=new Promise(resolve=>{releaseLookups=resolve;});
  const lookupResults=[];
  state.backend.catalog.findOrCreateProductItem=async args=>{
    const result=await findOrCreate(args);
    if(!args.p_category_id){
      lookupResults.push(result.item);
      if(lookupResults.length===2)releaseLookups();
      await bothLookups;
    }
    return result;
  };
  const [manualResult,emailResult]=await Promise.all([
    manual(state,vendorA,makeRow('BCON LAYOUT',{packSize:'15 LB'})),
    email(state,vendorB,text),
  ]);
  assert.equal(emailResult.outcome,'auto_imported',emailResult.reason);
  assert.deepEqual(lookupResults,[null,null],'both import paths miss before either creates');
  assert.ok(manualResult.match);
  assert.equal(state.catalogItems.length,1);
  assert.equal(mappingFor(state,vendorA).catalog_item_id,mappingFor(state,vendorB).catalog_item_id);
});

test('15. the same parsed row saves the same label and association through both paths',async()=>{
  const text='Code,Description,Brand,Pack,Price Unit,Price\nA,BCON LAYOUT 15LB,Source Brand,15 LB,CASE,41.25';
  const browser=setup();
  const worker=setup(text);
  const {rows}=parseDocument(text,undefined,browser.procurement);
  assert.equal(rows.length,1);
  await manual(browser,vendorA,rows[0]);
  const result=await email(worker,vendorA,text);
  assert.equal(result.outcome,'auto_imported',result.reason);
  function readSaved(state){
    const {name,concept_key}=state.catalogItems[0];
    const {description,brand,pack_size,price}=state.vendorItems[0];
    const {comparison_track,match_method,confidence_score}=mappingFor(state,vendorA);
    return {name,concept_key,description,brand,pack_size,price,comparison_track,match_method,confidence_score};
  }
  assert.deepEqual(readSaved(browser),readSaved(worker));
  assertIdentityLink(mappingFor(browser,vendorA));
});

test('16. barcode and manufacturer-code columns never change identity grouping',async()=>{
  const codes=['4006381333931','4006381333931','5901234123457'];
  const descriptions=['BACON','TURKEY BACON','BCON LAYOUT'];
  async function importSheet(withIdentifiers){
    const text=['Code,Description,Brand,Pack,Price Unit,Price'+(withIdentifiers?',GTIN,Manufacturer Part':''),
      ...descriptions.map((description,index)=>`${index},${description},Source,10 LB,CASE,41.25`+
        (withIdentifiers?`,${codes[index]},${index===2?'OTHER456':'MFR123'}`:''))].join('\n');
    const state=setup();
    const {rows}=parseDocument(text,undefined,state.procurement);
    assert.equal(rows.length,3);
    if(withIdentifiers)assert.ok(rows.every(row=>row.gtin&&row.manufacturerCode));
    const vendors=[vendorA,vendorB,vendorC];
    for(const [index,row] of rows.entries())await manual(state,vendors[index],row,'barcode',index);
    assert.equal(state.catalogItems.length,2);
    return rows.map((row,index)=>{
      const mapping=mappingFor(state,vendors[index],row.code);
      return state.catalogItems.find(item=>item.id===mapping.catalog_item_id).concept_key;
    });
  }
  assert.deepEqual(await importSheet(true),await importSheet(false));
});
