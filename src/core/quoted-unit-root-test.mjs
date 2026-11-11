// Real importer regression: remembered quoted units retain a durable root,
// rather than treating the word "remembered" as confirmation of itself.
import assert from 'node:assert/strict';
import {configureProcurement,createProcurementContext} from '../procurement.js';
import {parseDocument} from '../ingestion.js';
import {importPriceRow} from './import-price-row.js';
import {catalogRowEvidence,orderGuideAssessment} from './catalog-fields.js';
import {quotedUnitOrigin} from './listing-provenance.js';

configureProcurement({industry:'construction'});
const procurement=createProcurementContext({industry:'construction'});
const organizationId='synthetic-organization',vendorId='synthetic-vendor',listingId='synthetic-listing';
const category={id:'synthetic-category',name:'Supplies',range_start:900000,range_end:999999};
const item={id:'synthetic-item',name:'Steel washers',category_id:category.id,
  category_reason:'confirmed',category_review:false,master_item_number:900001};
const vendor={id:vendorId,name:'Synthetic supplier'};
const initialMapping={id:'synthetic-mapping',organization_id:organizationId,vendor_item_id:listingId,
  catalog_item_id:item.id,comparison_track:'exact',confidence_score:100,match_method:'manual'};
const editors={editor:{full_name:'Kai Morgan'}};
const parsed=(price=35,unit='CASE',pack='4/5 LB')=>{
  const row=parseDocument(`Code,Description,Brand,Pack,Price Unit,Price\nW-1,STEEL WASHERS,Example,${pack},${unit},${price}`).rows[0];
  assert.ok(row,'exercise actual neutral document placement');
  return row;
};
const unitRoot=listing=>listing.import_row?.evidence?.fieldEvidence?.sellingUnit;

function fixture(initial=null){
  let listing=initial?structuredClone(initial):null;
  let mapping=initial?structuredClone(initialMapping):null;
  const calls={quotes:[],holds:[]};
  const backend={pricing:{async applyQuote(quote){
    calls.quotes.push(structuredClone(quote));
    listing={...listing,id:listingId,organization_id:organizationId,vendor_id:vendorId,
      vendor_item_code:quote.vendorItemCode,description:quote.description,brand:quote.brand,
      pack_size:quote.packSize,selling_unit:quote.sellingUnit,price_basis:quote.priceBasis,
      price:quote.price,price_source:'price_list',price_unavailable:quote.priceUnavailable,
      last_updated:quote.effectiveDate,import_row:structuredClone(quote.importRow),
      field_resolutions:structuredClone(quote.fieldResolutions)};
    return listing.id;
  }},records:{query(table){
    assert.equal(table,'vendor_items');
    return {update(patch){
      calls.holds.push(structuredClone(patch));
      const filters=[];
      const chain={
        eq(key,value){filters.push([key,value]);return chain;},
        then(resolve,reject){
          assert.deepEqual(filters,[['id',listingId],['organization_id',organizationId]]);
          listing={...listing,...structuredClone(patch)};
          return Promise.resolve({error:null}).then(resolve,reject);
        },
      };
      return chain;
    }};
  }}};
  const input=()=>({item,vendorItem:listing,mapping,vendor,category,categories:[category],peers:[],editors,
    now:new Date('2026-11-11T12:00:00Z')});
  return {
    calls,read:()=>structuredClone(listing),origin:()=>quotedUnitOrigin(listing,procurement),
    evidence:()=>catalogRowEvidence(input()),assessment:()=>orderGuideAssessment(input()),
    async import(source,{documentId='synthetic-original-document',invoiceSources=[],interpretedRow=null}={}){
      const untouched=structuredClone(source);
      const result=await importPriceRow({backend,
        importService:{mapping:async(org,id)=>{assert.equal(org,organizationId);assert.equal(id,listingId);return mapping;},
          createMapping:async value=>{mapping={...value,id:initialMapping.id};return mapping;}},
        catalogService:{matchOrCreate:async()=>({catalogItemId:item.id,score:1,track:'exact'}),confirmMappings:async()=>{}},
        sourceRow:structuredClone(source),row:structuredClone(interpretedRow||source),ex:listing?structuredClone(listing):null,
        priorMapping:mapping,rowIssues:[],rowNeedsReview:false,invoiceSources,
        orgId:organizationId,vendorId,sourceDocumentId:documentId,completedKey:'row:0',
        importBatchTime:'2026-11-11T12:00:00Z',group:{name:`${documentId}.csv`},sourceFilePath:null,
        workingCatalogItems:[structuredClone(item)],workingCategories:[structuredClone(category)],
        workingVendorItems:listing?[structuredClone(listing)]:[],workingMappings:mapping?[structuredClone(mapping)]:[],
      },procurement);
      assert.deepEqual(source,untouched,'root construction cannot mutate the neutral caller row');
      return result;
    },
  };
}

const rememberedSeed=()=>({id:listingId,organization_id:organizationId,vendor_id:vendorId,
  vendor_item_code:'W-1',description:'STEEL WASHERS',brand:'Example',pack_size:'4/5 LB',
  selling_unit:'CS',price_basis:'case',price:35,price_source:'price_list',price_unavailable:false,
  field_resolutions:{},import_row:{row:parsed(35,''),evidence:{...parsed(35,''),sellingUnit:'CS',sellingUnitSource:'remembered'},
    sourceDocumentId:'synthetic-unproven-document',sourceFileName:'Unproven.csv',reviewRequired:false}});

let passed=0;
async function test(name,run){await run();passed++;console.log('PASS '+name);}

await test('stated document root survives two actual blank-unit imports without a remembered self-confirmation',async()=>{
  const f=fixture(),source=parsed();
  assert.equal((await f.import(source)).needsBasis,false);
  const first=f.read(),root=structuredClone(unitRoot(first));
  assert.ok(root,'the original importer save records its own quoted-unit root');
  assert.equal(root.source,'sheet');assert.equal(root.value,'CASE');
  assert.deepEqual(root.documentIds,['synthetic-original-document']);
  assert.equal(root.reference,'synthetic-original-document.csv');
  assert.equal(root.organizationId,organizationId);assert.equal(root.vendorId,vendorId);
  assert.equal(root.vendorItemCode,'W-1');
  assert.equal(root.binding.header,'Price Unit');assert.equal(root.binding.rawValue,'CASE');
  assert.equal(root.binding.evidence,'stated');
  for(const [index,price] of [36,37].entries()){
    const documentId=`synthetic-blank-document-${index+1}`;
    assert.equal((await f.import(parsed(price,''),{documentId})).needsBasis,false);
    const saved=f.read();
    assert.equal(saved.price,price);assert.equal(saved.selling_unit,'CASE');
    assert.equal(saved.import_row.row.sellingUnit,null);
    assert.equal(saved.import_row.sourceDocumentId,documentId,'new quote keeps its own source document');
    assert.deepEqual(unitRoot(saved),root,'the unit proof remains the first stated observation');
    assert.deepEqual(f.origin().root,root);
    assert.equal(f.origin().status,'confirmed');
    assert.match(f.evidence().sellingUnit.reason,/synthetic-original-document/);
  }
  assert.equal(f.calls.quotes.length,3);assert.equal(f.calls.holds.length,0);
});

await test('a recorded matching client confirmation retains the actual actor and timestamp through both reimports',async()=>{
  const seed=rememberedSeed();
  seed.field_resolutions.selling_unit={value:'CASE',sourceValue:null,confirmedBy:'editor',confirmedAt:'2026-11-10T10:15:00Z'};
  const f=fixture(seed);
  let root;
  for(const [index,price] of [36,37].entries()){
    assert.equal((await f.import(parsed(price,''),{documentId:`client-blank-${index+1}`})).needsBasis,false);
    const current=unitRoot(f.read());
    assert.equal(current.source,'client confirmation');
    assert.equal(current.confirmedBy,'editor');assert.equal(current.confirmedAt,'2026-11-10T10:15:00Z');
    if(root)assert.deepEqual(current,root,'a later price cannot recreate the client action with a new date');
    root=structuredClone(current);
    assert.equal(f.evidence().sellingUnit.status,'confirmed');assert.equal(f.evidence().sellingUnit.accuracy,100);
    assert.equal(f.evidence().sellingUnit.by,'KM');
  }
});

await test('verified invoice root remains traceable while subsequent price sheets retain their own prices',async()=>{
  const invoice=parseDocument('Item,Description,Pack,Price Unit,Qty,Unit Price,Extended Price\nW-1,STEEL WASHERS,4/5 LB,CASE,2,35,70').rows[0];
  assert.ok(invoice.billingUnitEvidence);
  const invoiceSources=[{row:invoice,id:'synthetic-invoice-document',number:'SYNTHETIC-INVOICE',organizationId,vendorId}];
  const f=fixture();
  assert.equal((await f.import(parsed(40,''),{documentId:'sheet-supported-by-invoice',invoiceSources})).needsBasis,false);
  const root=structuredClone(unitRoot(f.read()));
  assert.ok(root);assert.equal(root.source,'invoice');
  assert.ok(root.documentIds.includes('synthetic-invoice-document'));
  assert.equal(root.references[0].documentId,'synthetic-invoice-document');
  assert.equal(root.references[0].billingUnitEvidence.header,'Price Unit');
  for(const [index,price] of [41,42].entries()){
    assert.equal((await f.import(parsed(price,''),{documentId:`invoice-root-blank-${index+1}`})).needsBasis,false);
    assert.equal(f.read().price,price,'the original invoice price is never copied into a new quote');
    assert.deepEqual(unitRoot(f.read()),root);
    assert.equal(f.origin().status,'confirmed');
  }
});

await test('a proofless remembered value remains visible as inferred70 and both new observations stay held',async()=>{
  const f=fixture(rememberedSeed());
  assert.equal(f.evidence().sellingUnit.status,'inferred');
  assert.equal(f.evidence().sellingUnit.accuracy,70);
  for(const [index,price] of [36,37].entries()){
    const documentId=`unsupported-blank-${index+1}`;
    assert.equal((await f.import(parsed(price,''),{documentId})).needsBasis,true);
    const saved=f.read();
    assert.equal(saved.selling_unit,'CS');assert.equal(saved.price,35);
    assert.equal(saved.import_row.sourceDocumentId,documentId);
    assert.equal(saved.import_row.row.price,price);
    assert.equal(saved.import_row.reviewRequired,true);
    assert.equal(f.evidence().sellingUnit.status,'inferred');assert.equal(f.evidence().sellingUnit.accuracy,70);
    assert.equal(f.evidence().unitCost.status,'inferred');assert.match(f.evidence().unitCost.reason,/Provisional/);
    assert.equal(f.assessment().ready,false);
    assert.ok(f.assessment().blockers.includes('sellingUnit'));
  }
  assert.equal(f.calls.quotes.length,0);assert.equal(f.calls.holds.length,2);
});

await test('stale client confirmation cannot authorize a different remembered unit',async()=>{
  const seed=rememberedSeed();
  seed.field_resolutions.selling_unit={value:'LB',confirmedBy:'editor',confirmedAt:'2026-11-10T10:15:00Z'};
  const f=fixture(seed);
  assert.equal((await f.import(parsed(36,''))).needsBasis,true);
  assert.notEqual(f.evidence().sellingUnit.status,'confirmed');
  assert.ok(f.evidence().sellingUnit.accuracy<=70);assert.equal(f.calls.quotes.length,0);
});

await test('a matching value with no recorded client actor or timestamp cannot fabricate a confirmation root',async()=>{
  const seed=rememberedSeed();
  seed.field_resolutions.selling_unit={value:'CASE'};
  const f=fixture(seed);
  assert.equal(f.evidence().sellingUnit.status,'inferred');
  assert.equal(f.evidence().sellingUnit.accuracy,70);
  assert.equal(f.origin().root,null);
  assert.equal((await f.import(parsed(36,''))).needsBasis,true);
  assert.equal(f.calls.quotes.length,0);
  assert.equal(f.evidence().sellingUnit.status,'inferred');
  assert.equal(f.evidence().sellingUnit.accuracy,70);
});

await test('a stripped root on a modern remembered observation cannot be reconstructed from its own remembered unit',async()=>{
  const source=fixture();await source.import(parsed());
  await source.import(parsed(36,''),{documentId:'first-modern-blank'});
  const seed=source.read();
  assert.ok(unitRoot(seed));
  delete seed.import_row.evidence.fieldEvidence.sellingUnit;
  assert.equal(seed.import_row.row.sellingUnit,null);
  assert.equal(seed.import_row.evidence.sellingUnitSource,'remembered');
  const f=fixture(seed);
  assert.equal(f.origin().root,null);
  assert.equal(f.evidence().sellingUnit.status,'inferred');
  assert.equal((await f.import(parsed(37,''),{documentId:'second-modern-blank'})).needsBasis,true);
  assert.equal(f.read().price,36);
  assert.equal(f.calls.quotes.length,0);
  assert.equal(f.origin().root,null);
  assert.equal(f.evidence().sellingUnit.accuracy,70);
});

await test('an already interpreted remembered input without a root cannot bypass the missing-root hold',async()=>{
  const f=fixture(rememberedSeed()),source=parsed(36,'');
  const interpretedRow={...source,sellingUnit:'CASE',sellingUnitSource:'remembered'};
  assert.equal((await f.import(source,{interpretedRow})).needsBasis,true);
  assert.equal(f.read().selling_unit,'CS');assert.equal(f.read().price,35);
  assert.equal(f.calls.quotes.length,0);
  assert.equal(f.evidence().sellingUnit.status,'inferred');assert.equal(f.evidence().sellingUnit.accuracy,70);
});

await test('a root for a different client, vendor, unit, product or pack cannot certify the saved unit',async()=>{
  const source=fixture();await source.import(parsed());
  const valid=source.read();
  for(const change of [{organizationId:'different-client'},{vendorId:'different-vendor'},{value:'LB'},
    {description:'STEEL BOLTS'},{packSize:'8/5 LB'}]){
    const seed=structuredClone(valid);
    seed.import_row.row=parsed(35,'');
    seed.import_row.evidence={...parsed(35,''),sellingUnit:'CASE',sellingUnitSource:'remembered',
      fieldEvidence:{sellingUnit:{...unitRoot(seed),...change}}};
    seed.import_row.sourceDocumentId='synthetic-later-blank';
    const f=fixture(seed);
    assert.equal((await f.import(parsed(36,''))).needsBasis,true,JSON.stringify(change));
    assert.notEqual(f.evidence().sellingUnit.status,'confirmed',JSON.stringify(change));
    assert.equal(f.calls.quotes.length,0,JSON.stringify(change));
  }
});

await test('a new directly stated unit establishes its own root instead of retaining an obsolete document',async()=>{
  const f=fixture();await f.import(parsed());
  const originalRoot=structuredClone(unitRoot(f.read()));
  assert.equal((await f.import(parsed(38,'CASE'),{documentId:'new-stated-document'})).needsBasis,false);
  const current=unitRoot(f.read());
  assert.equal(current.source,'sheet');assert.deepEqual(current.documentIds,['new-stated-document']);
  assert.notDeepEqual(current,originalRoot);
});

await test('a changed incoming pack stays pending while the retained unit keeps its original root',async()=>{
  const f=fixture();await f.import(parsed());
  const root=structuredClone(unitRoot(f.read()));
  assert.equal((await f.import(parsed(39,'','8/5 LB'),{documentId:'changed-pack-document'})).needsBasis,true);
  const saved=f.read();
  assert.equal(saved.pack_size,'4/5 LB');assert.equal(saved.price,35);
  assert.equal(saved.import_row.row.packSize,'8/5 LB');
  assert.equal(saved.import_row.sourceDocumentId,'changed-pack-document');
  assert.deepEqual(f.origin().root,root);
  assert.equal(f.assessment().ready,false);
});

console.log(`${passed} quoted-unit root regression cases passed (actual importer, synthetic in-memory save sink; no hosted writes).`);
