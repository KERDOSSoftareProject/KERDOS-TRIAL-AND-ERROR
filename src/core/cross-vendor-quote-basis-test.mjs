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
 const statedCase={...singleUnit,import_row:{...singleUnit.import_row,row:{...singleUnit.import_row.row,packSize:'4/5 LB'}}};
 assert.equal(normalizeCatalogQuote(statedCase,comparables,{item,mapping,procurement:context}).pack_size,'4/5 LB');
 const stated={...saved,import_row:{...saved.import_row,row:{...saved.import_row.row,sellingUnit:'CASE'}}};
 assert.equal(normalizeCatalogQuote(stated,comparables,{procurement:context}),stated,'honor the stated quote unit');
 assert.equal(normalizeCatalogQuote(saved,comparables.slice(0,1),{procurement:context}),saved);
 const normal={...saved,price:55,import_row:{...saved.import_row,row:{...saved.import_row.row,price:55}}};
 assert.equal(normalizeCatalogQuote(normal,comparables,{procurement:context}),normal,'leave a comparable case quote alone');
 const reimport=preparePriceImport({...row,price:16.75},saved,mapping,[],[],scope,context,comparables);
 assert.equal(reimport.row.sellingUnit,'EACH');
 assert.equal(reimport.row.sellingUnitSource,'inferred');
 assert.equal(reimport.requiresReview,true);
}
console.log('PASS cross-vendor inference: scoped confirmed comparisons; case/each/weight suggestions; 70% review; source preservation; ambiguity, contradiction, unsupported data and tenant rejection.');
