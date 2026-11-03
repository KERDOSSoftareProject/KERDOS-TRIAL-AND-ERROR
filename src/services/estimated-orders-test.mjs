import assert from 'node:assert/strict';
import {createEstimatedOrderService} from './estimated-orders.js';
import {estimatedOrderExport,orderAmountText,orderLineAmountText} from '../core/estimated-orders.js';
const terms={organizationId:'org',vendorId:'v',catalogItemId:'ci',vendorItemId:'vi',description:'Example',vendorItemCode:'CODE',packSize:'2/6-8 LBA',quotedRate:4,quotedUnit:'LB',sourceDocumentId:'doc',sourceRowKey:'row:0'};
const estimate={amount:null,minimum:96,maximum:128,estimated:true,guaranteed:false};
const requested={kind:'estimated_purchase_line_intent',version:1,terms,approvalId:'a',quantity:2,orderUnit:'case',estimate,actualCharge:null,expectedRevision:0,requiresAuthenticatedPersistence:true};
const draft={id:'draft',organizationId:'org',vendorId:'v',estimate,lines:[{kind:'estimated_purchase_draft_line',version:1,id:'dl',orderId:'draft',terms,approvalId:'a',quantity:2,orderUnit:'case',estimate,actualCharge:null,rowRevision:0}]};
const review={kind:'estimated_order_review',version:1,organizationId:'org',vendorId:'v',draftId:'draft',requestedLines:[requested],estimate,finalCharge:null,deliveryMinimum:{dollar:200,units:1,caseQuantity:2,status:'unknown'}};
const order={kind:'estimated_purchase_order',version:1,id:'order',organizationId:'org',vendorId:'v',sourceDraftId:'draft',submittedBy:'employee',submittedAt:'2026-11-01T21:00:00Z',lines:[{...draft.lines[0],id:'ol',orderId:'order',kind:'estimated_purchase_line'}],estimate,deliveryMinimum:review.deliveryMinimum,finalCharge:null,deliveryStatus:'not_sent'};
let signedIn=true,response=structuredClone(order),reviewResponse=structuredClone(review),calls=0;
const service=createEstimatedOrderService({session:{get:async()=>signedIn?{user:{id:'employee'}}:null},estimatedOrders:{review:async()=>structuredClone(reviewResponse),submit:async()=>{calls++;return structuredClone(response);},getByDraft:async()=>structuredClone(response)}});
assert.deepEqual(await service.review('org',draft),review);
await assert.rejects(service.submit(review),/Explicitly/);await assert.rejects(service.submit(review,{confirmed:true}),/Acknowledge/);assert.equal(calls,0);
assert.deepEqual(await service.submit(review,{confirmed:true,minimumAcknowledged:true}),order);
for(const patch of [{organizationId:'other'},{sourceDraftId:'other'},{submittedBy:'other'},{finalCharge:96},{estimate:{...estimate,minimum:1}},{deliveryStatus:'sent'}]){response={...order,...patch};await assert.rejects(service.submit(review,{confirmed:true,minimumAcknowledged:true}));}
response={...order,lines:[{...order.lines[0],quantity:3}]};await assert.rejects(service.submit(review,{confirmed:true,minimumAcknowledged:true}),/differs|invalid/);
response=order;assert.equal((await service.recover('org','draft')).id,'order');await assert.rejects(service.recover('other','draft'),/scope/);
reviewResponse={...review,vendorId:'other'};await assert.rejects(service.review('org',draft),/differs/);
signedIn=false;await assert.rejects(service.review('org',draft),/Sign in/);await assert.rejects(service.submit(review,{confirmed:true,minimumAcknowledged:true}),/Sign in/);signedIn=true;
const text=estimatedOrderExport(order,{organizationId:'org',draftId:'draft',vendorName:'Vendor'});assert.match(text,/Estimated total: \$96.00–\$128.00/);assert.match(text,/Final charge: unknown/);assert.match(text,/Monetary delivery minimum: unconfirmed/);assert.match(text,/not sent by KERDOS/);
assert.equal(orderAmountText({total_amount:12}),'$12.00');assert.equal(orderLineAmountText({line_total:3}),'$3.00');assert.match(orderAmountText({total_amount:null,estimated_snapshot:order}),/^Estimated \$96.00–\$128.00$/);assert.match(orderLineAmountText({line_total:null,estimated_snapshot:order.lines[0]}),/^Estimated/);
console.log('PASS estimated order service/export/history: auth, exact review and recorded snapshots, consent, unknown minimum, recovery, tamper rejection and labeled estimates.');

// Version-1 compatibility fixtures use literal historical amounts. A future
// calculator change must preserve accepted v1 results or supply versioned
// validation before these records can be reinterpreted; never weaken tamper checks.
const historyCases=[
 {packSize:'2/6-8 LBA',quotedRate:4,quotedUnit:'LB',quantity:2,expected:{amount:null,minimum:96,maximum:128,estimated:true,guaranteed:false}},
 {packSize:'2/7 LBA',quotedRate:4,quotedUnit:'LB',quantity:2,expected:{amount:112,minimum:null,maximum:null,estimated:true,guaranteed:false}},
 {packSize:'2/6-8 LBA',quotedRate:.3125,quotedUnit:'OZ',quantity:3,expected:{amount:null,minimum:180,maximum:240,estimated:true,guaranteed:false}},
];
for(const c of historyCases){
 const historical=structuredClone(order);historical.lines[0].terms={...terms,packSize:c.packSize,quotedRate:c.quotedRate,quotedUnit:c.quotedUnit};historical.lines[0].quantity=c.quantity;historical.lines[0].estimate=c.expected;historical.estimate=c.expected;historical.deliveryMinimum.caseQuantity=c.quantity;
 response=historical;
 assert.deepEqual(await service.recover('org','draft'),historical,'historical snapshots recover without reading a current listing or price sheet');
 assert.match(estimatedOrderExport(historical,{organizationId:'org',draftId:'draft'}),/Final charge: unknown/);
 const corrupt=structuredClone(historical),key=c.expected.amount==null?'minimum':'amount';
 corrupt.lines[0].estimate[key]++;corrupt.estimate={...corrupt.lines[0].estimate};response=corrupt;
 await assert.rejects(service.recover('org','draft'),/source terms/,'self-consistent total/line tampering still fails source-term validation');
}
response={...order,version:2};await assert.rejects(service.recover('org','draft'),/invalid scope/,'unknown calculation versions are not silently treated as v1');
response=order;
console.log('PASS G v1 historical estimate fixtures: range, nominal weight, converted rate, recovery/export and self-consistent tamper rejection.');
