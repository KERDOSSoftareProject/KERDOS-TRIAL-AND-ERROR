import assert from 'node:assert/strict';
import {createProcurementContext,configureProcurement} from '../procurement.js';
import {inferCrossVendorQuoteBasis,normalizeCatalogQuote} from './quote-basis.js';
import {preparePriceImport} from './price-import-review.js';
import {explainImportRow} from './import-evidence.js';
import {catalogMigrationAssessment} from './catalog-migration-tier.js';
import {orderGuideAssessment} from './catalog-fields.js';
import {calculatedUnitCost} from './quote-controls.js';
const scope={organizationId:'org',vendorId:'incoming'};
const row={code:'X',description:'STEEL WASHERS',packSize:'4/5 LB',price:35,sellingUnit:null};
const peers=[34,36].map((price,i)=>({id:'ref-'+i,organization_id:'org',vendor_id:'other-'+i,description:row.description,pack_size:row.packSize,
 price,selling_unit:'CASE',price_basis:'case',price_source:'pricelist',import_row:{sourceDocumentId:'doc-'+i,reviewRequired:false,row:{sellingUnit:'CASE'},evidence:{sellingUnitSource:'price header'}}}));
for(const industry of ['restaurant','construction']){
 const context=createProcurementContext({industry});configureProcurement({industry});
 const source=structuredClone(row);
 const guess=inferCrossVendorQuoteBasis(row,peers,scope,context);
 assert.equal(guess.value,'CASE');assert.equal(guess.accuracy,70);assert.equal(guess.evidence.references.length,2);
 assert.equal(inferCrossVendorQuoteBasis({...row,price:2},peers,scope,context)?.value,'LB');
 assert.equal(inferCrossVendorQuoteBasis({...row,price:8.75},peers,scope,context)?.value,'EACH');
 const prepared=preparePriceImport(row,null,null,[],[],scope,context,peers);
 assert.equal(prepared.row.sellingUnit,'CASE');assert.equal(prepared.row.sellingUnitSource,'inferred');assert.equal(prepared.requiresReview,true);
 assert.equal(prepared.reviewFields.includes('selling_unit'),true);
 const changed=preparePriceImport({...prepared.row,packSize:'8/5 LB'},null,null,[],[],scope,context,peers);
 assert.equal(changed.row.sellingUnit,null,'pack changes invalidate unsupported old suggestions');
 const preview=explainImportRow(row,{organizationId:'org',vendor:{id:'incoming'},vendorItems:peers});
 assert.equal(preview.sellingUnit.value,'CASE');assert.equal(preview.sellingUnit.status,'inferred');assert.equal(preview.sellingUnit.accuracy,70);
 assert.equal(preview.unitCost.accuracy,70);assert.equal(preview.unitCost.status,'inferred');assert.match(preview.unitCost.reason,/Provisional/);
 const confirmed=explainImportRow({...row,sellingUnit:'CASE',sellingUnitSource:'manual'},{organizationId:'org',vendor:{id:'incoming'},vendorItems:peers});
 assert.equal(confirmed.sellingUnit.status,'confirmed');
 assert.deepEqual(row,source,'original source stays blank');
 const accepted=peers.map(peer=>({...peer,field_resolutions:{selling_unit:{value:'CASE',confirmedBy:'reviewer',confirmedAt:'2026-11-11T00:00:00Z'}},import_row:{reviewRequired:false,row:{sellingUnit:null},evidence:{sellingUnitSource:'inferred'}}}));
 assert.equal(inferCrossVendorQuoteBasis(row,accepted,scope,context).value,'CASE','client-confirmed values can support later reviews');
 for(const bad of [peers.slice(0,1),peers.map(p=>({...p,vendor_id:'same'})),peers.map(p=>({...p,organization_id:'other-org'})),
   peers.map(p=>({...p,vendor_id:'incoming'})),peers.map(p=>({...p,price_source:'invoice'})),peers.map(p=>({...p,price_expired_at:'2026-01-01'})),
   peers.map(p=>({...p,pack_size:'8/5 LB'})),peers.map(p=>({...p,description:'COPPER PIPE'})),
   peers.map(p=>({...p,import_row:{...p.import_row,reviewRequired:true}})),
   peers.map(p=>({...p,import_row:{...p.import_row,evidence:{sellingUnitSource:'inferred'}}})),
   peers.map(p=>({...p,import_row:{row:{sellingUnit:'LB'}}})),[peers[0],{...peers[1],price:100}]]){
   assert.equal(inferCrossVendorQuoteBasis(row,bad,scope,context),null);
 }
 assert.equal(inferCrossVendorQuoteBasis(row,peers,null,context),null);
 assert.equal(inferCrossVendorQuoteBasis({...row,sellingUnit:'LB'},peers,scope,context),null);
 assert.equal(inferCrossVendorQuoteBasis({...row,price:10000},peers,scope,context),null);
 assert.deepEqual(inferCrossVendorQuoteBasis(row,[...peers].reverse(),scope,context),guess,'reference ordering does not change inference');

 const item={id:'catalog',name:row.description};
 const mapping={catalog_item_id:item.id,comparison_track:'exact',confidence_score:100};
 const saved={...peers[0],id:'saved',vendor_id:scope.vendorId,vendor_item_code:row.code,price:16.75,
  import_row:{sourceDocumentId:'raw',row:{description:row.description,price:16.75,sellingUnit:null}},
  field_resolutions:{selling_unit:{value:'CASE',confirmedBy:'reviewer'}}};
 const comparables=peers.map((peer,i)=>({...peer,price:[54.90,65.64][i]}));
 const original=structuredClone(saved);
 const normalized=normalizeCatalogQuote(saved,comparables,{item,mapping,procurement:context});
 assert.equal(normalized.selling_unit,'EACH');
 assert.equal(normalized.price_basis,'each');
 assert.equal(normalized.price,16.75);
 assert.equal(normalized.quoteBasisInference.evidence.inferredCasePrice,67);
 assert.equal(calculatedUnitCost(normalized,{procurement:context}).price,3.35);
 const mixedPacks=[
   {...comparables[0],pack_size:'2/5 LB',price:27.45},
   {...comparables[1],pack_size:'2/20 LB',price:131.28},
 ];
 const groupMappings=mixedPacks.map(peer=>({...mapping,vendor_item_id:peer.id}));
 const mixed=normalizeCatalogQuote(saved,mixedPacks,{item,mapping,groupMappings,procurement:context});
 assert.equal(mixed.selling_unit,'EACH','verified mixed packs use comparable physical quantities');
 assert.deepEqual(mixed.quoteBasisInference.evidence.references.map(peer=>peer.comparableCharge),[54.9,65.64]);
 assert.equal(normalizeCatalogQuote(saved,mixedPacks,{item,mapping,procurement:context}),saved,
   'different packs require verified catalog links');
 const revisedAmount={...saved,price:17};
 assert.equal(normalizeCatalogQuote(revisedAmount,mixedPacks,{item,mapping,groupMappings,procurement:context,checkEditedAmount:true}).selling_unit,'EACH');
 assert.equal(normalizeCatalogQuote({...revisedAmount,field_resolutions:{...saved.field_resolutions,
   price:{value:17,confirmedBy:'reviewer'}}},mixedPacks,{item,mapping,groupMappings,procurement:context}).selling_unit,'EACH',
   'saving an edit does not bypass the same comparison');

 assert.equal(catalogMigrationAssessment({item,listing:normalized,mapping,procurement:context}).tier,2);
 assert.ok(orderGuideAssessment({item,vendorItem:normalized,mapping,procurement:context}).blockers.includes('sellingUnit'));
 assert.deepEqual(saved,original,'the calculation must preserve the saved quote and the original document');
 const singleUnit={...saved,import_row:{...saved.import_row,row:{...saved.import_row.row,description:`${row.description} 5 lb.`}}};
 const projectedPack=normalizeCatalogQuote(singleUnit,comparables,{item,mapping,procurement:context});
 assert.equal(projectedPack.pack_size,'5 lb');
 assert.equal(projectedPack.selling_unit,'EACH');
 assert.equal(calculatedUnitCost(projectedPack,{procurement:context}).price,3.35);
 assert.ok(catalogMigrationAssessment({item,listing:projectedPack,mapping,procurement:context}).fields.has('pack'));
 assert.ok(orderGuideAssessment({item,vendorItem:projectedPack,mapping,procurement:context}).blockers.includes('sellingUnit'));
 const confirmedAt='2026-11-11T18:41:25Z';
 const wronglyApproved={...singleUnit,last_updated:confirmedAt,field_resolutions:{...singleUnit.field_resolutions,
  row_approval:{catalogItemId:item.id,confirmedAt,confirmedBy:'reviewer'}}};
 const threeVendors=[...comparables,{...comparables[0],id:'ref-third',vendor_id:'other-third',price:50.8}];
 const corrected=normalizeCatalogQuote(wronglyApproved,threeVendors,{item,mapping,procurement:context});
 assert.equal(calculatedUnitCost(wronglyApproved,{procurement:context}).price,0.8375);
 assert.equal(corrected.pack_size,'5 lb');
 assert.equal(calculatedUnitCost(corrected,{procurement:context}).price,3.35);
 assert.equal(catalogMigrationAssessment({item,listing:corrected,mapping,procurement:context}).tier,2);
 const acceptedCorrection={...wronglyApproved,pack_size:'5 lb',selling_unit:'EACH',price_basis:'each',
  field_resolutions:{...wronglyApproved.field_resolutions,pack_size:{value:'5 lb',confirmedBy:'reviewer'},
   selling_unit:{value:'EACH',confirmedBy:'reviewer'}}};
 assert.equal(normalizeCatalogQuote(acceptedCorrection,threeVendors,{item,mapping,procurement:context}),acceptedCorrection);
 assert.equal(catalogMigrationAssessment({item,listing:acceptedCorrection,mapping,procurement:context}).tier,1);
 const unresolved=normalizeCatalogQuote({...wronglyApproved,price:1,import_row:{...wronglyApproved.import_row,
  row:{...wronglyApproved.import_row.row,price:1}}},threeVendors,{item,mapping,procurement:context});
 assert.equal(unresolved.quoteBasisInference.kind,'unresolved');
 assert.equal(catalogMigrationAssessment({item,listing:unresolved,mapping,procurement:context}).tier,4);
 assert.ok(orderGuideAssessment({item,vendorItem:unresolved,mapping,procurement:context}).blockers.includes('sellingUnit'));

 const statedCase={...singleUnit,import_row:{...singleUnit.import_row,row:{...singleUnit.import_row.row,packSize:'4/5 LB'}}};
 assert.equal(normalizeCatalogQuote(statedCase,comparables,{item,mapping,procurement:context}).pack_size,'4/5 LB');
 const stated={...saved,import_row:{...saved.import_row,row:{...saved.import_row.row,sellingUnit:'CASE'}}};
 assert.equal(normalizeCatalogQuote(stated,comparables,{procurement:context}),stated,'honor the stated quote unit');
 assert.equal(normalizeCatalogQuote(saved,comparables.slice(0,1),{procurement:context}),saved);
 const normal={...saved,price:55,import_row:{...saved.import_row,row:{...saved.import_row.row,price:55}}};
 assert.equal(normalizeCatalogQuote(normal,comparables,{procurement:context}),normal,'leave a comparable case quote alone');
 const volumePack='4/1 GAL';
 const volumePeers=peers.map((peer,i)=>({...peer,price:[75.74,89.59][i],pack_size:volumePack,
  import_row:{...peer.import_row,row:{...peer.import_row.row,packSize:volumePack}}}));
 for(const [price,expected] of [[76.92,19.23],[79.50,19.875]]){
  const held={...saved,price,pack_size:volumePack,selling_unit:'GAL',price_basis:'measure',price_unavailable:true,
   field_resolutions:{},import_row:{sourceDocumentId:'retained',reviewRequired:true,reviewFields:['selling_unit'],
    conflicts:['Quoted unit is inferred'],row:{description:row.description,price,packSize:volumePack,priceUnavailable:false}}};
  const duplicate={...volumePeers[0],id:'old-copy',price:1000,last_updated:'2000-01-01'};
  const independent=[{...volumePeers[0],last_updated:'2020-01-01'},volumePeers[1],duplicate];
  const after=normalizeCatalogQuote(held,independent,{item,mapping,procurement:context});
  assert.equal(after.selling_unit,'CASE');
  assert.equal(after.price_unavailable,true);
  assert.equal(after.quoteBasisInference.evidence.references.length,2);
  assert.equal(calculatedUnitCost(after,{procurement:context}).price,expected);
  assert.equal(catalogMigrationAssessment({item,listing:after,mapping,procurement:context}).tier,2);
  assert.ok(orderGuideAssessment({item,vendorItem:after,mapping,procurement:context}).blockers.includes('sellingUnit'));
  const withdrawn={...held,import_row:{...held.import_row,row:{...held.import_row.row,priceUnavailable:true}}};
  assert.equal(normalizeCatalogQuote(withdrawn,independent,{item,mapping,procurement:context}),withdrawn);
 }
 const heldAmount={...saved,price:2.41,selling_unit:'LB',price_basis:'measure',price_source:'price_list',
  field_resolutions:{selling_unit:{value:'LB',confirmedBy:'reviewer'}},
  import_row:{sourceDocumentId:'next-sheet',rowKey:'row-12',reviewRequired:true,
   conflicts:['Pricing basis "LB" suggested but not confirmed: $2.39/lb.'],
   baseline:{price:2.41},row:{code:row.code,description:row.description,packSize:row.packSize,price:2.39}}};
 const carried=normalizeCatalogQuote(heldAmount,[],{item,mapping,procurement:context});
 assert.equal(carried.price,2.39);
 assert.equal(carried.selling_unit,'LB');
 assert.equal(carried.quoteBasisInference.price,2.39);
 assert.equal(calculatedUnitCost(carried,{procurement:context}).price,2.39);
 assert.equal(catalogMigrationAssessment({item,listing:carried,mapping,procurement:context}).tier,2);
 assert.equal(heldAmount.price,2.41);
 for(const source of [{packSize:'2/5 LB'},{sellingUnit:'CASE'},{description:'COPPER PIPE'}]){
  const changed={...heldAmount,import_row:{...heldAmount.import_row,row:{...heldAmount.import_row.row,...source}}};
  assert.equal(normalizeCatalogQuote(changed,[],{item,mapping,procurement:context}),changed);
 }
 const reimport=preparePriceImport({...row,price:16.75},saved,mapping,[],[],scope,context,comparables);
 assert.equal(reimport.row.sellingUnit,'EACH');
 assert.equal(reimport.row.sellingUnitSource,'inferred');
 assert.equal(reimport.requiresReview,true);
}
console.log('PASS cross-vendor inference: scoped confirmed comparisons; case/each/weight suggestions; 70% review; source preservation; ambiguity, contradiction, unsupported data and tenant rejection.');
