// Step 6 · Place Alternative Interpretations — Database Test
//
// Acceptance spec (verbatim):
//   "After a move, the new group link, inferred values, and rationale
//    survive reload; original source values preserved; any listing
//    that relied on old group evidence is rechecked."
//
// What is exercised here:
//   1. Reimport of an existing listing whose catalog peers have different
//      packs (cross-pack). Without group links → inference blocked.
//      With group links (peerA + peerB both exact/100 at catItemX) →
//      inference succeeds. Since needsBasis=true && ex exists, the
//      import-price-row code writes ONLY import_row (not selling_unit),
//      capturing the inferred value and rationale in the DB record.
//   2. Reload: values survive (read them back from backend._stores).
//   3. Move: peerA's mapping shifts to catItemY. Now only peerB at X →
//      1 vendor, below the ≥2 threshold → inference fails.
//   4. Recheck: re-import subject → import_row.evidence.sellingUnit
//      is cleared and conflicts updated to "unresolved" — the listing
//      is flagged for manual review.
//
// Uses createInMemoryBackend() — no real Supabase connection needed.

import assert from 'node:assert/strict';
import {importPriceRow} from './import-price-row.js';
import {createCatalogService} from '../services/catalog.js';

// ---------------------------------------------------------------------------
// In-memory backend  (same pattern as reimport-persistence-test.mjs)
// ---------------------------------------------------------------------------

function uuid(){return Math.random().toString(36).slice(2)+Date.now().toString(36);}

function createInMemoryBackend(){
  const catalogs=new Map();
  const vendors=new Map();
  const mappings=new Map();
  const categories=new Map();

  function table(name){
    const store=
      name==='catalog_items'?catalogs:
      name==='vendor_items'?vendors:
      name==='item_mappings'?mappings:
      categories;
    let _data=null,_insertRows=null,_eq=[],_single=false,_delete=false;
    const api={
      select(){return api;},
      insert(rows){
        const arr=Array.isArray(rows)?rows:[rows];
        const ids=arr.map(r=>{const id=uuid();store.set(id,{id,...r});return id;});
        _insertRows=arr.map((r,i)=>({id:ids[i],...r}));
        return api;
      },
      update(data){_data=data;return api;},
      delete(){_delete=true;return api;},
      eq(k,v){_eq.push([k,v]);return api;},
      single(){_single=true;return api;},
      async then(resolve){
        if(_delete){
          const matched=[...store.entries()].filter(([,r])=>_eq.every(([k,v])=>r[k]===v));
          for(const[id]of matched)store.delete(id);
          return resolve({data:null,error:null});
        }
        if(_insertRows){
          if(_single)return resolve({data:_insertRows[0]||null,error:null});
          return resolve({data:_insertRows,error:null});
        }
        if(_data){
          const matched=[...store.entries()].filter(([,r])=>_eq.every(([k,v])=>r[k]===v));
          for(const[id,row]of matched)store.set(id,{...row,..._data});
          return resolve({data:null,error:null});
        }
        const rows=[...store.values()].filter(r=>_eq.every(([k,v])=>r[k]===v));
        if(_single)return resolve({data:rows[0]||null,error:rows[0]?null:'not found'});
        return resolve({data:rows,error:null});
      },
    };
    return api;
  }

  const backend={
    records:{query:table},
    rpc:()=>Promise.resolve({data:null,error:{message:'rpc not wired'}}),
    pricing:{
      _priceHistory:new Map(),
      async applyQuote({vendorItemId,...args}){
        const id=vendorItemId||uuid();
        if(!vendors.has(id))
          vendors.set(id,{id,organization_id:args.organizationId,vendor_id:args.vendorId,
            description:args.description,pack_size:args.packSize,brand:args.brand||null,
            gtin:args.gtin||null,manufacturer_code:args.manufacturerCode||null,
            selling_unit:args.sellingUnit||null,
            field_resolutions:args.fieldResolutions||{},row_revision:1});
        else{
          const ex=vendors.get(id);
          vendors.set(id,{...ex,
            selling_unit:args.sellingUnit||ex.selling_unit,
            field_resolutions:args.fieldResolutions!=null?args.fieldResolutions:ex.field_resolutions,
          });
        }
        const prior=backend.pricing._priceHistory.get(id)||[];
        backend.pricing._priceHistory.set(id,[...prior,{sourceDocumentId:args.sourceDocumentId,price:args.price}]);
        return id;
      },
    },
    catalog:{async saveRow(){return{data:null,error:null};}},
    _stores:{catalogs,vendors,mappings,categories},
  };
  return backend;
}

function makeServices(backend){
  const catalogService=createCatalogService(backend);
  const importService={
    async mapping(organizationId,vendorItemId){
      return[...backend._stores.mappings.values()].find(
        m=>m.organization_id===organizationId&&m.vendor_item_id===vendorItemId)||null;
    },
    async createMapping(data){
      const id=uuid();backend._stores.mappings.set(id,{id,...data});return{id,...data};
    },
  };
  return{catalogService,importService};
}

// ---------------------------------------------------------------------------
// Test setup
// ---------------------------------------------------------------------------

// Pack math:
//   peerA / peerB: pack='2/5 LB' → 2 × 5 LB = 10 LB, price=13.725/CASE
//     → 13.725 / 10 LB = 1.3725 / LB
//   subject:       pack='4/5 LB' → 4 × 5 LB = 20 LB, price=27.45/CASE
//     → 27.45 / 20 LB = 1.3725 / LB  ✓  same unit cost → inference fires

const ORG   = 'org-s6';
const V_SBJ = 'v-subject';
const V_A   = 'v-peerA';
const V_B   = 'v-peerB';

function seed(backend){
  const catId=uuid();
  backend._stores.categories.set(catId,{id:catId,organization_id:ORG,
    name:'Maintenance',is_holding_pen:false,range_start:1000,range_end:1999});

  // The shared catalog item that all three vendor items map to.
  const catItemXId=uuid();
  backend._stores.catalogs.set(catItemXId,{id:catItemXId,organization_id:ORG,
    category_id:catId,name:'Steel Washers',master_item_number:1001,
    matching_behavior:'flexible',comparison_mode:'alternatives',
    brand_locked:false,category_review:false,category_reason:null});

  // A second catalog item used as the move destination for peerA.
  const catItemYId=uuid();
  backend._stores.catalogs.set(catItemYId,{id:catItemYId,organization_id:ORG,
    category_id:catId,name:'Steel Washers (alt)',master_item_number:1002,
    matching_behavior:'flexible',comparison_mode:'alternatives',
    brand_locked:false,category_review:false,category_reason:null});

  // peerA: verified peer (exact/100 to X), different pack from subject
  // price:13.725 × (20 LB / 10 LB) = 27.45 — same unit cost as subject
  const peerAId=uuid();
  backend._stores.vendors.set(peerAId,{id:peerAId,organization_id:ORG,
    vendor_id:V_A,vendor_item_code:'WA-A',
    description:'STEEL WASHERS',pack_size:'2/5 LB',brand:null,gtin:null,
    manufacturer_code:null,selling_unit:'CASE',price_basis:'case',price:13.725,
    price_source:'pricelist',field_resolutions:{},row_revision:1,
    // import_row.row.sellingUnit must match selling_unit for quotedUnitOrigin
    // to return status:'confirmed' — enabling this peer as inference evidence.
    import_row:{
      sourceDocumentId:'doc-a',reviewRequired:false,
      row:{sellingUnit:'CASE'},
      evidence:{sellingUnitSource:'price header'},
    },
  });
  const peerAMappingId=uuid();
  backend._stores.mappings.set(peerAMappingId,{id:peerAMappingId,
    organization_id:ORG,catalog_item_id:catItemXId,
    vendor_item_id:peerAId,comparison_track:'exact',confidence_score:100,
    match_method:'manual'});

  // peerB: same as peerA, independent vendor
  const peerBId=uuid();
  backend._stores.vendors.set(peerBId,{id:peerBId,organization_id:ORG,
    vendor_id:V_B,vendor_item_code:'WA-B',
    description:'STEEL WASHERS',pack_size:'2/5 LB',brand:null,gtin:null,
    manufacturer_code:null,selling_unit:'CASE',price_basis:'case',price:13.72,
    price_source:'pricelist',field_resolutions:{},row_revision:1,
    import_row:{
      sourceDocumentId:'doc-b',reviewRequired:false,
      row:{sellingUnit:'CASE'},
      evidence:{sellingUnitSource:'price header'},
    },
  });
  const peerBMappingId=uuid();
  backend._stores.mappings.set(peerBMappingId,{id:peerBMappingId,
    organization_id:ORG,catalog_item_id:catItemXId,
    vendor_item_id:peerBId,comparison_track:'exact',confidence_score:100,
    match_method:'manual'});

  // subject: existing listing, different pack, unresolved selling_unit
  const subjectId=uuid();
  backend._stores.vendors.set(subjectId,{id:subjectId,organization_id:ORG,
    vendor_id:V_SBJ,vendor_item_code:'WASH-X',
    description:'STEEL WASHERS',pack_size:'4/5 LB',brand:null,gtin:null,
    manufacturer_code:null,selling_unit:null,price_basis:null,
    price_source:'pricelist',field_resolutions:{},row_revision:1,
    import_row:null,
  });
  const subjectMappingId=uuid();
  backend._stores.mappings.set(subjectMappingId,{id:subjectMappingId,
    organization_id:ORG,catalog_item_id:catItemXId,
    vendor_item_id:subjectId,comparison_track:'exact',confidence_score:100,
    match_method:'manual'});

  return{catItemXId,catItemYId,
    peerAId,peerAMappingId,
    peerBId,peerBMappingId,
    subjectId,subjectMappingId};
}

// ---------------------------------------------------------------------------
// Helper: run one import of the subject row using current store state
// ---------------------------------------------------------------------------

async function importSubject(backend,ids,services,workingMappings){
  const{subjectId,subjectMappingId}=ids;
  const{catalogService,importService}=services;

  const ex       =backend._stores.vendors.get(subjectId);
  const priorMapping=backend._stores.mappings.get(subjectMappingId);

  return importPriceRow({
    backend,importService,catalogService,
    sourceRow:{code:'WASH-X',description:'STEEL WASHERS',price:'27.45',packSize:'4/5 LB'},
    row:      {code:'WASH-X',description:'STEEL WASHERS',price: 27.45, packSize:'4/5 LB'},
    ex,priorMapping,rowIssues:[],rowNeedsReview:false,invoiceSources:[],
    orgId:ORG,vendorId:V_SBJ,
    sourceDocumentId:'doc-sbj',completedKey:'WASH-X',
    importBatchTime:new Date().toISOString(),
    group:{name:'Weekly sheet',quoteValidUntil:null},
    sourceFilePath:null,
    workingCatalogItems:[...backend._stores.catalogs.values()],
    workingCategories :[...backend._stores.categories.values()],
    workingVendorItems:[...backend._stores.vendors.values()],
    workingMappings,
    applySelectedCategory:null,
  });
}

// ---------------------------------------------------------------------------
// Test runner
// ---------------------------------------------------------------------------

function run(label,fn){
  const p=fn();
  if(p&&typeof p.then==='function'){
    return p.then(
      ()=>console.log(`  ✓  ${label}`),
      e =>{console.error(`  ✗  ${label}\n     ${e.message}`);process.exitCode=1;});
  }
  console.log(`  ✓  ${label}`);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

console.log('\nStep 6 · Place Alternative Interpretations — database tests\n');

// ---- 1. Cross-pack import without group links leaves selling_unit null ----
//
// Confirm that the group-link gate actually blocks inference when the peer
// mappings are NOT in the workingMappings.  (Counter-test for the gate.)

run('without group links, cross-pack reimport leaves selling_unit and import_row.evidence.sellingUnit null', async()=>{
  const backend=createInMemoryBackend();
  const ids=seed(backend);
  const services=makeServices(backend);

  // Pass only the subject's own mapping — no peer mappings.
  const subjectOnlyMappings=[backend._stores.mappings.get(ids.subjectMappingId)];
  const result=await importSubject(backend,ids,services,subjectOnlyMappings);

  assert.equal(result.needsBasis,true,'basis unresolved without peer evidence');
  const vi=backend._stores.vendors.get(ids.subjectId);
  assert.ok(!vi.import_row?.evidence?.sellingUnit,
    'selling_unit evidence must be absent — cross-pack inference blocked without group links');
  assert.equal(vi.selling_unit,null,'selling_unit not written to DB');
});

// ---- 2. With group links: inferred value and rationale saved; source preserved ----
//
// peerA + peerB are both exact/100 at catItemX → linkedPeerIds = {peerAId, peerBId}.
// Cross-pack inference succeeds.  Since needsBasis=true and ex exists, importPriceRow
// takes the needsBasis&&ex path: writes only import_row (not selling_unit).
// The inferred unit and "inferred" rationale must survive a reload from the store.

run('with group links, inferred sellingUnit and rationale are saved to import_row; original source preserved', async()=>{
  const backend=createInMemoryBackend();
  const ids=seed(backend);
  const services=makeServices(backend);

  // All three mappings: subject + both peers at catItemX (exact/100).
  const allMappings=[...backend._stores.mappings.values()];
  const result=await importSubject(backend,ids,services,allMappings);

  assert.equal(result.needsBasis,true,'basis is inferred — still needs review');

  // Reload from store (simulates a fresh read after the import completes).
  const vi=backend._stores.vendors.get(ids.subjectId);

  // Inferred value captured in import_row.evidence.
  assert.equal(vi.import_row?.evidence?.sellingUnit,'CASE',
    'inferred sellingUnit saved to import_row.evidence after reload');
  assert.equal(vi.import_row?.evidence?.sellingUnitSource,'inferred',
    'sellingUnitSource marked inferred in import_row.evidence');

  // Review flag set.
  assert.equal(vi.import_row?.reviewRequired,true,
    'reviewRequired true — listing held for manual confirmation');

  // Rationale present.
  const conflicts=vi.import_row?.conflicts||[];
  assert.ok(conflicts.some(c=>/inferred/i.test(c)),
    'rationale includes "inferred" — explains why review is needed');

  // selling_unit NOT written — the value is unconfirmed.
  assert.equal(vi.selling_unit,null,
    'selling_unit not written to DB; applyQuote not called on needsBasis path');

  // Original source values untouched.
  assert.equal(vi.description,'STEEL WASHERS','original description preserved');
  assert.equal(vi.pack_size,'4/5 LB','original pack preserved');
});

// ---- 3. After a move, the relying listing is rechecked ----
//
// peerA moves to catItemY.  On the next reimport the subject's group at X
// has only peerB (1 vendor) — below the ≥2 threshold.  Inference returns
// null, reasons include "unresolved", import_row is updated accordingly.
// Crucially, the original source values (description, pack) are still
// unchanged — only the import_row reflects the lost evidence.

run('after a peer moves out of the group, the relying listing is rechecked and original source preserved', async()=>{
  const backend=createInMemoryBackend();
  const ids=seed(backend);
  const services=makeServices(backend);

  // --- First reimport: peerA + peerB at X → inference works ---
  const allMappings=[...backend._stores.mappings.values()];
  await importSubject(backend,ids,services,allMappings);

  // Confirm baseline: inferred value present.
  const afterFirst=backend._stores.vendors.get(ids.subjectId);
  assert.equal(afterFirst.import_row?.evidence?.sellingUnit,'CASE','baseline: inferred value present');

  // --- Move peerA to catItemY ---
  const peerAMapping=backend._stores.mappings.get(ids.peerAMappingId);
  backend._stores.mappings.set(ids.peerAMappingId,{
    ...peerAMapping,catalog_item_id:ids.catItemYId,
  });

  // --- Second reimport: only peerB at X → inference fails (1 vendor) ---
  const mappingsAfterMove=[...backend._stores.mappings.values()];
  const result2=await importSubject(backend,ids,services,mappingsAfterMove);

  assert.equal(result2.needsBasis,true,'basis unresolved after peer moves');

  // Reload.
  const afterMove=backend._stores.vendors.get(ids.subjectId);

  // Recheck: inferred value gone — group evidence lost.
  assert.ok(!afterMove.import_row?.evidence?.sellingUnit,
    'import_row.evidence.sellingUnit cleared — group evidence lost after peer moves');
  assert.equal(afterMove.import_row?.reviewRequired,true,
    'reviewRequired still true — listing rechecked for manual resolution');

  // Rationale updated to unresolved.
  const conflictsAfterMove=afterMove.import_row?.conflicts||[];
  assert.ok(conflictsAfterMove.some(c=>/unresolved/i.test(c)),
    'rationale updated to "unresolved" after peer moves out of group');

  // Original source values still preserved — move only affects group evidence.
  assert.equal(afterMove.description,'STEEL WASHERS','description unchanged after peer moves');
  assert.equal(afterMove.pack_size,'4/5 LB','pack unchanged after peer moves');
  assert.equal(afterMove.selling_unit,null,'selling_unit still null — was never confirmed');
});

console.log('');
