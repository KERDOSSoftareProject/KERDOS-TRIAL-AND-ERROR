import assert from 'node:assert/strict';
import fs from 'node:fs';
import {parseDocument} from '../ingestion.js';
import {configureProcurement} from '../procurement.js';
import {preparePriceImport} from './price-import-review.js';
import {invoiceEvidence} from './invoice-evidence.js';
import {explainImportRow} from './import-evidence.js';
import {resolveFromInvoiceArithmetic} from './quote-basis.js';

configureProcurement({industry:'restaurant'});
const scope={organizationId:'client-a',vendorId:'vendor-a'};
const sheet={code:'49200',description:'CHIC BRST RAW BNLS RNDM CVP',packSize:'4/10 LB',price:2.06};
const invoice=header=>parseDocument(`Item,Description,Pack,${header},Qty,Unit Price,Extended Price\n49200,CHIC BRST RAW BNLS RNDM CVP,4/10 LB,LB,40,2.06,82.40`).rows[0];
const entry=row=>({row,...scope,id:'invoice-a',number:'INV-A'});
const billed=invoice('Price Unit');
assert.ok(billed,'Real CSV must produce an invoice line');
assert.equal(billed.billingUnitEvidence.header,'Price Unit');
assert.equal(billed.qty,40);
assert.equal(billed.amount,82.40);
const prepared=preparePriceImport(sheet,null,null,[],[entry(billed)],scope);
assert.equal(prepared.resolved.sellingUnit,'LB');
assert.equal(prepared.row.sellingUnit,'LB','the interpreted row and quote decision agree');
const preview=explainImportRow(sheet,{vendor:{id:scope.vendorId},invoices:[entry(billed)]});
assert.equal(preview.sellingUnit.value,'LB');
assert.equal(preview.sellingUnit.source,'invoice');
assert.match(preview.sellingUnit.reason,/invoice’s billed unit/);
assert.equal(prepared.requiresReview,false);
assert.equal(prepared.row.quoteBasisEvidence.references[0].documentId,'invoice-a');
assert.equal(prepared.row.quoteBasisEvidence.references[0].billingUnitEvidence.header,'Price Unit');
assert.deepEqual(invoiceEvidence(sheet,[entry(billed)]).conflicts,[],'Identical vendor abbreviations must not fabricate a product conflict');

const goods=parseDocument('INVOICE INV-A\nItem/Xref ORD DLV UOM Description Pack Size Weight Unit Price Extended\n49200 4.00 4.00 LB CHIC BRST RAW BNLS RNDM CVP 4/10 LB 40.00 $2.06 $82.40\nTOTAL 82.40').rows[0];
assert.equal(goods.billingUnitEvidence.kind,'goods-invoice-billed-unit');
assert.equal(resolveFromInvoiceArithmetic(sheet,[entry(goods)],scope).sellingUnit,'LB');

const ordering=invoice('Order Unit');
assert.equal(ordering.orderingUnit,'LB');
assert.equal(ordering.sellingUnit,null,'Ordering unit is not a quoted-price unit');
assert.equal(resolveFromInvoiceArithmetic(sheet,[entry(ordering)],scope).conflict,true);

for(const changed of [{sellingUnit:null},{qty:null},{amount:null},{packSize:null},{priceNeedsReview:true},{billingUnitEvidence:null}]){
  assert.equal(resolveFromInvoiceArithmetic(sheet,[entry(billed),entry({...billed,...changed})],scope).conflict,true,
    `A matching incomplete/conflicting invoice must prevent resolution: ${JSON.stringify(changed)}`);
}
for(const changed of [{organizationId:'other-client'},{vendorId:'other-vendor'}]){
  assert.equal(resolveFromInvoiceArithmetic(sheet,[{...entry(billed),...changed}],scope),null,'Evidence cannot cross client or vendor');
}
assert.equal(resolveFromInvoiceArithmetic(sheet,[entry({...billed,billingUnitEvidence:null,priceBasis:'measure'})],scope).conflict,true,'priceBasis alone is not provenance');
assert.equal(preparePriceImport(sheet,null,null,[],[],scope).requiresReview,true,'Fresh sheets without evidence stay reviewable');

const savedCase={id:'listing-a',vendor_item_code:sheet.code,description:sheet.description,pack_size:sheet.packSize,selling_unit:'CS',price_basis:'case',price:80,import_row:{sourceDocumentId:"confirmed-source-document",row:{sellingUnit:'CS'},evidence:{sellingUnit:'CS',sellingUnitSource:'price header'}}};
const savedMeasure={...savedCase,selling_unit:'LB',price_basis:'measure',import_row:{sourceDocumentId:"confirmed-source-document",row:{sellingUnit:'LB'},evidence:{sellingUnit:'LB',sellingUnitSource:'price header'}}};
const knownMapping={vendor_item_id:savedCase.id,comparison_track:'exact',confidence_score:100};
const disagreement=preparePriceImport(sheet,savedCase,knownMapping,[],[entry(billed)],scope);
assert.equal(disagreement.resolved,null,'an unstated quote cannot choose between remembered case and verified invoice weight');
assert.equal(disagreement.row.sellingUnit,'');
assert.ok(disagreement.reviewFields.includes('selling_unit'));
assert.match(disagreement.reasons.join(' '),/Pricing basis.*CS.*LB/);
assert.equal(preparePriceImport(sheet,savedMeasure,knownMapping,[],[entry(billed)],scope).requiresReview,false);
assert.equal(preparePriceImport({...sheet,sellingUnit:'CASE'},savedCase,knownMapping,[],[entry(billed)],scope).requiresReview,false,
  'a current stated case quote can coexist with an invoice billed by weight');
assert.equal(preparePriceImport(sheet,savedCase,knownMapping,[],[{...entry(billed),vendorId:'another-vendor'}],scope).resolved.sellingUnit,'CS');
assert.equal(preparePriceImport(sheet,null,null,[],[entry(ordering)],scope).resolved,null,'conflicting invoice evidence cannot become an inferred quote');

// Keep the actual import orchestrator connected; isolated resolver tests cannot catch this omission.
// The call now lives in the shared import-price-row.js, not directly in ImportModal.jsx.
const importPriceRowSrc=fs.readFileSync(new URL('./import-price-row.js',import.meta.url),'utf8');
assert.match(importPriceRowSrc,/preparePriceImport\(row,\s*ex,\s*priorMapping,\s*rowNeedsReview\s*\?\s*rowIssues\s*:\s*\[\],\s*invoiceSources,\s*\{organizationId:\s*orgId,\s*vendorId\},\s*procurement,\s*workingVendorItems,\s*sourceRow,\s*\{linkedPeerIds\}\)/);
console.log('Invoice billing integration passed: real CSV and goods invoices, original header, source reference, ordering-unit rejection, incomplete evidence and client/vendor isolation.');
