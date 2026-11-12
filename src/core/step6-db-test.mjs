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
//   3. Move (peer out): peerA's mapping shifts to catItemY. Now only
//      peerB at X → 1 vendor, below the ≥2 threshold → inference fails.
//   4. Recheck: re-import subject → import_row.evidence.sellingUnit
//      is cleared and conflicts updated to "unresolved" — the listing
//      is flagged for manual review.
//   5. New listing lifecycle: (a) first import, no ex, no priorMapping →
//      matchOrCreate places listing at catItemX, selling_unit=null (no group
//      evidence yet — knownCatalogItemId is null without a priorMapping);
//      (b) second import (ex+priorMapping both present) → linkedPeerIds
//      resolves to {peerA, peerB} → inference fires → import_row captures
//      sellingUnit='CASE'.  This is the first import WITH group evidence
//      after the listing has been placed in the destination catalog group.
//   6. Move (subject in): subject starts at catItemY (no peers). After
//      its mapping is moved to catItemX (peerA+peerB), the next import
//      re-evaluates with the new group evidence and sets
//      import_row.evidence.sellingUnit='CASE'.
//   7. Step 7 tier agreement: after a group-linked inference import the
//      tier returned by catalogMigrationAssessment must be consistent with
//      the saved import_row state (reviewRequired=true ⇒ tier ≥ 2,
//      fields includes 'sellingUnit').
//
// Uses createInMemoryBackend() — no real Supabase connection needed.

import assert from 'node:assert/strict';
import {importPriceRow} from './import-price-row.js';
import {createCatalogService} from '../services/catalog.js';
import {catalogMigrationAssessment} from './catalog-migration-tier.js';

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
            vendor_item_code:args.vendorItemCode||null,
            description:args.description,pack_size:args.packSize,brand:args.brand||null,
            gtin:args.gtin||null,manufacturer_code:args.manufacturerCode||null,
            selling_unit:args.sellingUnit||null,
            field_resolutions:args.fieldResolutions||{},
            import_row:args.importRow||null,
            row_revision:1});
        else{
          const ex=vendors.get(id);
          vendors.set(id,{...ex,
            selling_unit:args.sellingUnit||ex.selling_unit,
            field_resolutions:args.fieldResolutions!=null?args.fieldResolutions:ex.field_resolutions,
            import_row:args.importRow!=null?args.importRow:ex.import_row,
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
    manufacturer_code:null,selling_unit:null,price_basis:'case',price:27.45,
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

// ---- 4. New listing lifecycle: matchOrCreate then verified group evidence ----
//
// A brand-new vendor code (no ex, no priorMapping) triggers matchOrCreate on
// its first import.  matchOrCreate finds catItemX by description match and
// links the listing there (pack differs → track=review).  Because priorMapping
// is null, knownCatalogItemId is null, so linkedPeerIds is null — no group
// evidence is applied on import 1.
//
// On import 2, ex and priorMapping both exist.  linkedPeerIds resolves from
// peerA+peerB (exact/100 at catItemX) and cross-pack inference fires.
// Since needsBasis=true && ex exists, the needsBasis&&ex path writes only
// import_row (not selling_unit), capturing sellingUnit='CASE' as evidence.
//
// This is the "destination-group evidence used on the import AFTER the
// listing has been placed in the group" scenario that the spec describes.

run('new listing: matchOrCreate places it at catItemX, next import uses verified destination-group evidence', async()=>{
  const backend=createInMemoryBackend();
  const ids=seed(backend);
  const services=makeServices(backend);
  const{catalogService,importService}=services;

  // Only peer mappings — the subject does not exist yet on this vendor.
  const peerMappings=[
    backend._stores.mappings.get(ids.peerAMappingId),
    backend._stores.mappings.get(ids.peerBMappingId),
  ];

  // --- Import 1: brand-new code, no ex, no priorMapping ---
  // matchOrCreate finds catItemX (description='STEEL WASHERS' match, pack differs
  // → track=review).  No group evidence: linkedPeerIds=null because priorMapping=null.
  const result1=await importPriceRow({
    backend,importService,catalogService,
    sourceRow:{code:'WASH-NEW',description:'STEEL WASHERS',price:'27.45',packSize:'4/5 LB'},
    row:      {code:'WASH-NEW',description:'STEEL WASHERS',price: 27.45, packSize:'4/5 LB'},
    ex:null,priorMapping:null,rowIssues:[],rowNeedsReview:false,invoiceSources:[],
    orgId:ORG,vendorId:V_SBJ,
    sourceDocumentId:'doc-new-1',completedKey:'WASH-NEW',
    importBatchTime:new Date().toISOString(),
    group:{name:'Weekly sheet',quoteValidUntil:null},
    sourceFilePath:null,
    workingCatalogItems:[...backend._stores.catalogs.values()],
    workingCategories :[...backend._stores.categories.values()],
    workingVendorItems:[...backend._stores.vendors.values()],
    workingMappings:peerMappings,
    applySelectedCategory:null,
  });

  assert.ok(result1.vendorItemId,'import 1 created a new vendor item');

  // matchOrCreate must have linked the new item to catItemX.
  const mapping1=await importService.mapping(ORG,result1.vendorItemId);
  assert.ok(mapping1,'mapping created by matchOrCreate on first import');
  assert.equal(mapping1.catalog_item_id,ids.catItemXId,
    'matchOrCreate placed new listing at catItemX (description match)');

  // No group evidence on first import — linkedPeerIds was null without priorMapping.
  const vi1=backend._stores.vendors.get(result1.vendorItemId);
  assert.ok(vi1,'new vendor item in store after first import');
  assert.ok(!vi1.import_row?.evidence?.sellingUnit,
    'no group evidence on first import — linkedPeerIds null without priorMapping');

  // --- Import 2: ex and priorMapping both exist → group evidence available ---
  const ex2=backend._stores.vendors.get(result1.vendorItemId);
  const allMappings2=[...backend._stores.mappings.values()];

  const result2=await importPriceRow({
    backend,importService,catalogService,
    sourceRow:{code:'WASH-NEW',description:'STEEL WASHERS',price:'27.45',packSize:'4/5 LB'},
    row:      {code:'WASH-NEW',description:'STEEL WASHERS',price: 27.45, packSize:'4/5 LB'},
    ex:ex2,priorMapping:mapping1,rowIssues:[],rowNeedsReview:false,invoiceSources:[],
    orgId:ORG,vendorId:V_SBJ,
    sourceDocumentId:'doc-new-2',completedKey:'WASH-NEW',
    importBatchTime:new Date().toISOString(),
    group:{name:'Weekly sheet',quoteValidUntil:null},
    sourceFilePath:null,
    workingCatalogItems:[...backend._stores.catalogs.values()],
    workingCategories :[...backend._stores.categories.values()],
    workingVendorItems:[...backend._stores.vendors.values()],
    workingMappings:allMappings2,
    applySelectedCategory:null,
  });

  assert.equal(result2.needsBasis,true,'basis still inferred — awaiting confirmation');

  const vi2=backend._stores.vendors.get(result1.vendorItemId);
  assert.equal(vi2.import_row?.evidence?.sellingUnit,'CASE',
    'import_row.evidence.sellingUnit=CASE — destination-group evidence used after listing placed at catItemX');
  assert.equal(vi2.import_row?.evidence?.sellingUnitSource,'inferred',
    'sellingUnitSource=inferred — cross-vendor group inference');
  assert.equal(vi2.import_row?.reviewRequired,true,
    'reviewRequired=true — inferred unit awaits confirmation');
  assert.equal(vi2.selling_unit,null,
    'selling_unit null — reimport path holds inferred value pending confirmation');
});

// ---- 5. Moving a listing INTO a group triggers re-evaluation ----
//
// Subject starts at catItemY (no peers there).  On its first import the
// selling-unit inference is blocked.  When the user remaps the subject to
// catItemX (which has peerA + peerB), the NEXT import re-evaluates with the
// new group evidence and sets import_row.evidence.sellingUnit='CASE'.
//
// This is the inverse of test 3: rather than a peer moving out of the group
// and causing the subject to lose evidence, the SUBJECT itself moves into a
// group and gains evidence on the next import.

run('moving a listing into a peer group triggers re-evaluation on next import', async()=>{
  const backend=createInMemoryBackend();
  const ids=seed(backend);
  const services=makeServices(backend);

  // --- Move subject to catItemY before first import ---
  // catItemY has no peers → inference will be blocked.
  const subjectMapping=backend._stores.mappings.get(ids.subjectMappingId);
  backend._stores.mappings.set(ids.subjectMappingId,{
    ...subjectMapping,catalog_item_id:ids.catItemYId,
  });

  // --- Import 1: subject at catItemY (no peers) → inference blocked ---
  const mappingsAtY=[...backend._stores.mappings.values()];
  const result1=await importSubject(backend,ids,services,mappingsAtY);

  assert.equal(result1.needsBasis,true,'basis unresolved at catItemY — no peers');

  const afterFirst=backend._stores.vendors.get(ids.subjectId);
  assert.ok(!afterFirst.import_row?.evidence?.sellingUnit,
    'no group evidence at catItemY — import_row.evidence.sellingUnit absent after import 1');

  // --- Move subject to catItemX ---
  backend._stores.mappings.set(ids.subjectMappingId,{
    ...subjectMapping,catalog_item_id:ids.catItemXId,
  });

  // --- Import 2: subject now at catItemX (peerA + peerB) → re-evaluation ---
  const mappingsAtX=[...backend._stores.mappings.values()];
  const result2=await importSubject(backend,ids,services,mappingsAtX);

  assert.equal(result2.needsBasis,true,'basis still needs review — inference not yet confirmed');

  const afterMove=backend._stores.vendors.get(ids.subjectId);

  // Re-evaluation: group evidence now available.
  assert.equal(afterMove.import_row?.evidence?.sellingUnit,'CASE',
    'import_row.evidence.sellingUnit=CASE after subject moves into peer group');
  assert.equal(afterMove.import_row?.evidence?.sellingUnitSource,'inferred',
    'sellingUnitSource=inferred — group evidence used on re-evaluation');
  assert.equal(afterMove.import_row?.reviewRequired,true,
    'reviewRequired=true — still needs confirmation after move-in re-evaluation');

  // selling_unit unchanged — the reimport path only writes import_row.
  assert.equal(afterMove.selling_unit,null,
    'selling_unit remains null — reimport path holds inferred value for review');
  assert.equal(afterMove.description,'STEEL WASHERS','description unchanged through move');
  assert.equal(afterMove.pack_size,'4/5 LB','pack unchanged through move');
});

// ---- 6. After reload, Step 7 tier agrees with interpretation ----
//
// After a group-linked inference import the saved state is:
//   selling_unit = null   (needsBasis path: applyQuote not called)
//   import_row.reviewRequired = true
//   import_row.evidence.sellingUnit = 'CASE'
//
// catalogMigrationAssessment (Step 7 tier) must agree:
//   tier must NOT be 1 (fully resolved) while the interpretation is unconfirmed.
//   The 'sellingUnit' field must appear in the returned field set so the UI
//   can direct the user to resolve it.

run('Step 7 tier agrees with saved interpretation: tier≥2 and sellingUnit in fields when reviewRequired=true', async()=>{
  const backend=createInMemoryBackend();
  const ids=seed(backend);
  const services=makeServices(backend);

  // Run the group-linked inference import (same state as test 2).
  const allMappings=[...backend._stores.mappings.values()];
  await importSubject(backend,ids,services,allMappings);

  // Reload listing, item, and mapping from store — the same objects the UI
  // and Step 7 tier logic would receive after a database read.
  const listing=backend._stores.vendors.get(ids.subjectId);
  const item   =backend._stores.catalogs.get(ids.catItemXId);
  const mapping=backend._stores.mappings.get(ids.subjectMappingId);
  const settings={priceValidDays:90};

  // Sanity: confirm the state we're evaluating is the expected one.
  assert.equal(listing.selling_unit,null,'precondition: selling_unit null (not confirmed)');
  assert.equal(listing.import_row?.reviewRequired,true,'precondition: reviewRequired true');
  assert.equal(listing.import_row?.evidence?.sellingUnit,'CASE','precondition: inferred CASE');

  // Step 7 tier assessment.
  const assessment=catalogMigrationAssessment({item,listing,mapping,settings,now:new Date()});

  assert.ok(assessment,'catalogMigrationAssessment returned a result');

  // Tier must reflect the unconfirmed state:
  //   tier 3 = source row present, selling unit needs resolution
  //   tier 4 = no source row
  //   tier 2 = inferred/tentative — still needs attention
  //   tier 1 = fully resolved  ← must NOT occur when reviewRequired=true
  assert.notEqual(assessment.tier,1,
    'tier must not be 1 (fully resolved) while import_row.reviewRequired is true');
  assert.ok(assessment.tier>=2,
    'tier≥2 — system acknowledges the selling unit is not yet confirmed');

  // sellingUnit must appear in the fields that need attention.
  const fields=[...(assessment.fields||[])];
  assert.ok(fields.includes('sellingUnit'),
    'sellingUnit in assessment fields — UI can direct user to resolve the inferred unit');
});

console.log('');
