import assert from 'node:assert/strict';
import {prepareVariableWeightApproval,prepareEstimatedPurchaseLine,prepareVariableWeightReceipt,summarizeVariableWeightReceipts} from './variable-weight-purchasing.js';

// Synthetic inputs only. Saved receipts simulate a future authenticated adapter;
// these are data-contract checks, not hosted authorization or UI acceptance.
const now='2026-11-01T16:00:00Z';
const source={code:'SYN-1',packSize:'2/6-8 LBA',price:4,sellingUnit:'LB',
  billingUnitEvidence:{kind:'pricing-unit-header',header:'Product UOM',unit:'LB'}};
const listing={id:'listing-a',organization_id:'client-a',vendor_id:'vendor-a',vendor_item_code:'SYN-1',description:'Example variable product',brand:'Example',
  pack_size:source.packSize,price:4,selling_unit:'LB',price_basis:'measure',price_unavailable:true,
  import_row:{reviewRequired:true,reviewFields:['pack_size'],sourceDocumentId:'sheet-a',rowKey:'row:0',row:source}};
const mapping={id:'mapping-a',organization_id:'client-a',vendor_item_id:'listing-a',catalog_item_id:'catalog-a',comparison_track:'exact',confidence_score:100};
const input={organizationId:'client-a',vendorId:'vendor-a',catalogItemId:'catalog-a',listing,mapping,confirmed:true,actorId:'manager-a',now};
const original=structuredClone(input);
const approvalIntent=prepareVariableWeightApproval(input);
assert.equal(approvalIntent.requiresAuthenticatedPersistence,true);
assert.equal(approvalIntent.finalChargeKnown,false);
assert.throws(()=>prepareEstimatedPurchaseLine({...input,approval:approvalIntent,quantity:2,orderUnit:'case'}),/persisted approval/);
const approval={kind:'variable_weight_approval',version:1,id:'approval-a',approvedBy:'manager-a',approvedAt:now,terms:approvalIntent.terms};
const line=prepareEstimatedPurchaseLine({...input,approval,quantity:2,orderUnit:'case'});
assert.deepEqual(line.estimate,{amount:null,minimum:96,maximum:128,estimated:true,guaranteed:false});
assert.equal(line.actualCharge,null,'a range never becomes an actual charge or invented midpoint');
const averageSource={...source,packSize:'3/7 LB AVG'};
const averageInput={...input,listing:{...listing,pack_size:averageSource.packSize,import_row:{...listing.import_row,row:averageSource}}};
const averageTerms=prepareVariableWeightApproval(averageInput).terms;
const average=prepareEstimatedPurchaseLine({...averageInput,approval:{...approval,terms:averageTerms},quantity:2,orderUnit:'case'});
assert.equal(average.estimate.amount,168);assert.equal(average.estimate.minimum,null);assert.equal(average.estimate.maximum,null);

for(const patch of [{organizationId:'client-b'},{vendorId:'vendor-b'},{catalogItemId:'catalog-b'},{confirmed:false},{actorId:''},{now:null}])
  assert.throws(()=>prepareVariableWeightApproval({...input,...patch}));
for(const patch of [{price:5},{selling_unit:'KG'},{pack_size:'2/7-9 LBA'},{description:'A different product'},
  {price_expired_at:now},{price_quote_valid_until:'2026-10-31'},{price_source:'invoice'},
  {import_row:{...listing.import_row,rowKey:'row:1'}},{import_row:{...listing.import_row,sourceDocumentId:'sheet-b'}}])
  assert.throws(()=>prepareEstimatedPurchaseLine({...input,listing:{...listing,...patch},approval,quantity:2,orderUnit:'case'}),'changed terms/expired evidence need another review');
assert.throws(()=>prepareVariableWeightApproval({...input,listing:{...listing,import_row:{...listing.import_row,reviewFields:['brand','pack_size']}}}),/other source fields/);
assert.throws(()=>prepareVariableWeightApproval({...input,mapping:{...mapping,confidence_score:70}}),/catalog association/);
assert.throws(()=>prepareVariableWeightApproval({...input,listing:{...listing,import_row:{...listing.import_row,row:{...source,billingUnitEvidence:null}}}}),/stated source/);
assert.throws(()=>prepareEstimatedPurchaseLine({...input,approval:{...approval,revokedAt:now},quantity:2,orderUnit:'case'}),/persisted approval/);
assert.throws(()=>prepareEstimatedPurchaseLine({...input,approval:{...approval,approvedAt:'2026-11-02T16:00:00Z'},quantity:2,orderUnit:'case'}),/dated after/);
for(const quantity of [0,-1,1.5,Infinity,Number.MAX_SAFE_INTEGER+1,true,[],{},'0x10'])assert.throws(()=>prepareEstimatedPurchaseLine({...input,approval,quantity,orderUnit:'case'}));
assert.throws(()=>prepareEstimatedPurchaseLine({...input,approval,quantity:1,orderUnit:'each'}),/whole number of cases/);

const savedLine={...line,kind:'estimated_purchase_line',id:'order-line-a',orderId:'order-a'};
const printed='SYN-1 14 LB 4.00 56.00';
const invoice={id:'invoice-line-a',documentKind:'invoice',sourceDocumentId:'invoice-a',organizationId:'client-a',vendorId:'vendor-a',vendorItemId:'listing-a',
  row:{code:'SYN-1',qty:14,price:4,amount:56,sellingUnit:'LB',sourceLine:printed,
    billingUnitEvidence:{kind:'pricing-unit-header',header:'Price Unit',unit:'LB'}},
  billedQuantityEvidence:{kind:'invoice_billed_quantity',header:'Billed weight',quantity:14,unit:'LB',sourceLine:printed}};
const link={confirmed:true,orderLineId:savedLine.id,invoiceDocumentId:invoice.sourceDocumentId,invoiceLineId:invoice.id};
const receive={orderLine:savedLine,invoiceLine:invoice,link,receivedCaseQuantity:1,actorId:'receiver-a',now};
const receipt=prepareVariableWeightReceipt(receive);
assert.equal(receipt.actualCharge,56);assert.equal(receipt.expectedChargeAtQuotedRate,56);assert.equal(receipt.rateVariance,0);
assert.equal(receipt.weightOutsideStatedRange,false);
const receivedInvoice=structuredClone(invoice);
for(const patch of [{organizationId:'client-b'},{vendorId:'vendor-b'},{vendorItemId:'listing-b'},
  {documentKind:'pricelist'},
  {row:{...invoice.row,sellingUnit:'CASE'}},{row:{...invoice.row,billingUnitEvidence:null}},
  {row:{...invoice.row,amount:60}},{row:{...invoice.row,code:'SYN-OTHER'}},
  {billedQuantityEvidence:{...invoice.billedQuantityEvidence,quantity:1}},
  {billedQuantityEvidence:{...invoice.billedQuantityEvidence,sourceLine:'different printed line'}}])
  assert.throws(()=>prepareVariableWeightReceipt({...receive,invoiceLine:{...invoice,...patch}}));
assert.throws(()=>prepareVariableWeightReceipt({...receive,link:{...link,confirmed:false}}),/Explicitly link/);
assert.throws(()=>prepareVariableWeightReceipt({...receive,link:{...link,invoiceLineId:'other'}}),/Explicitly link/);
assert.throws(()=>prepareVariableWeightReceipt({...receive,receivedCaseQuantity:3}),/exceed/);
const outsidePrinted='SYN-1 20 LB 5.00 100.00';
const outside={...invoice,row:{...invoice.row,qty:20,price:5,amount:100,sourceLine:outsidePrinted},billedQuantityEvidence:{...invoice.billedQuantityEvidence,quantity:20,sourceLine:outsidePrinted}};
const outsideReceipt=prepareVariableWeightReceipt({...receive,invoiceLine:outside});
assert.equal(outsideReceipt.actualCharge,100,'the printed charge survives a weight/rate variance');
assert.equal(outsideReceipt.expectedChargeAtQuotedRate,80);
assert.equal(outsideReceipt.rateVariance,20);assert.equal(outsideReceipt.weightOutsideStatedRange,true);
const ouncePrinted='SYN-1 224 OZ 0.25 56.00';
const ounceInvoice={...invoice,row:{...invoice.row,qty:224,price:0.25,sellingUnit:'OZ',sourceLine:ouncePrinted,billingUnitEvidence:{...invoice.row.billingUnitEvidence,unit:'OZ'}},
  billedQuantityEvidence:{...invoice.billedQuantityEvidence,quantity:224,unit:'OZ',sourceLine:ouncePrinted}};
assert.equal(prepareVariableWeightReceipt({...receive,invoiceLine:ounceInvoice}).expectedChargeAtQuotedRate,56);
assert.equal(prepareVariableWeightReceipt({...receive,invoiceLine:ounceInvoice}).weightOutsideStatedRange,false);
const freePrinted='SYN-1 14 LB 0.00 0.00';
const freeInvoice={...invoice,row:{...invoice.row,price:0,amount:0,sourceLine:freePrinted},billedQuantityEvidence:{...invoice.billedQuantityEvidence,sourceLine:freePrinted}};
assert.equal(prepareVariableWeightReceipt({...receive,invoiceLine:freeInvoice}).actualCharge,0,'a stated zero invoice charge remains zero, not missing');

const savedReceipt={...receipt,kind:'variable_weight_receipt',id:'receipt-a'};
assert.equal(summarizeVariableWeightReceipts(savedLine,[]).status,'pending');
const partial=summarizeVariableWeightReceipts(savedLine,[savedReceipt]);
assert.equal(partial.status,'partial');assert.equal(partial.recordedCharge,56);assert.equal(partial.actualCharge,null);
const second={...savedReceipt,id:'receipt-b',invoiceDocumentId:'invoice-b',invoiceLineId:'invoice-line-b'};
const complete=summarizeVariableWeightReceipts(savedLine,[savedReceipt,second]);
assert.equal(complete.status,'complete');assert.equal(complete.actualCharge,112);
assert.deepEqual(complete.estimate,line.estimate,'reconciliation does not rewrite the estimate');
assert.equal(summarizeVariableWeightReceipts(savedLine,[{...savedReceipt,receivedCaseQuantity:null}]).actualCharge,null,'billed pounds do not establish how many cases were received');
assert.throws(()=>summarizeVariableWeightReceipts(savedLine,[savedReceipt,{...savedReceipt,id:'receipt-duplicate'}]),/counted twice/);
assert.throws(()=>summarizeVariableWeightReceipts(savedLine,[savedReceipt,{...second,id:savedReceipt.id}]),/counted twice/);
assert.throws(()=>summarizeVariableWeightReceipts(savedLine,[{...savedReceipt,organizationId:'client-b'}]),/belonging/);
assert.throws(()=>summarizeVariableWeightReceipts(savedLine,[{...savedReceipt,receivedCaseQuantity:3}]),/exceed/);
assert.throws(()=>summarizeVariableWeightReceipts(savedLine,[receipt]),/saved receipts/);
assert.deepEqual(input,original,'preparation does not change the listing, source, approval or review flags');
assert.deepEqual(invoice,receivedInvoice,'reconciliation does not change the printed invoice');
const metricSource={...source,packSize:'3/4 KG AVG',price:12.5,sellingUnit:'KG',billingUnitEvidence:{...source.billingUnitEvidence,unit:'KG'}};
const metricInput={...input,listing:{...listing,description:'Synthetic metal coils',pack_size:metricSource.packSize,price:12.5,selling_unit:'KG',import_row:{...listing.import_row,row:metricSource}}};
const metricTerms=prepareVariableWeightApproval(metricInput).terms;
assert.equal(prepareEstimatedPurchaseLine({...metricInput,approval:{...approval,terms:metricTerms},quantity:2,orderUnit:'case'}).estimate.amount,300,'industry-neutral rules do not branch on the product or supplier');
console.log('PASS variable-weight purchasing contracts: explicit scoped intents, stale approval rejection, average/range estimates, source-backed charges, partial delivery, duplicate protection and immutable quote evidence. Authenticated storage/UI integration remains pending.');
