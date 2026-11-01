import {parseDocument} from '../../ingestion.js';
import {invoiceBilledQuantityEvidence} from '../invoice-quantity-evidence.js';
import {prepareVariableWeightReceipt} from '../variable-weight-purchasing.js';
export function reconciliationFixture(){
 const row=parseDocument('INVOICE I-1\nDate: 11/01/2026\nItem,Description,Pack,Price Unit,Billed Weight,Unit Price,Extended Price\nSYN,Example material,2/6-8 LBA,LB,14,4,56').rows[0];
 const terms={organizationId:'org',vendorId:'v',catalogItemId:'ci',vendorItemId:'vi',sourceDocumentId:'quote',sourceRowKey:'row:0',vendorItemCode:'SYN',description:'Example material',packSize:'2/6-8 LBA',quotedRate:4,quotedUnit:'LB'};
 const line={kind:'estimated_purchase_line',version:1,id:'ol',orderId:'order',terms,approvalId:'approval',quantity:1,orderUnit:'case',rowRevision:0,estimate:{amount:null,minimum:48,maximum:64,estimated:true,guaranteed:false},actualCharge:null};
 const invoice={id:'il',sourceDocumentId:'i',documentKind:'invoice',organizationId:'org',vendorId:'v',vendorItemId:'vi',invoiceNumber:'I-1',invoiceDate:'2026-11-01',row,billedQuantityEvidence:invoiceBilledQuantityEvidence(row),quantitySource:row.quantitySource};
 const now='2026-11-01T22:00:00Z';const calc=prepareVariableWeightReceipt({orderLine:line,invoiceLine:invoice,link:{confirmed:true,orderLineId:'ol',invoiceDocumentId:'i',invoiceLineId:'il'},receivedCaseQuantity:1,actorId:'owner',now});for(const k of ['kind','version','requestedBy','reviewedAt','requiresAuthenticatedPersistence'])delete calc[k];
 const review={kind:'estimated_receipt_review',version:1,organizationId:'org',orderLine:line,invoiceLine:invoice,receivedCaseQuantity:1,remainingCases:1,calculation:calc};
 const receipt={...calc,kind:'variable_weight_receipt',version:1,id:'r',receivedBy:'owner',receivedAt:now,caseEvidence:{kind:'client_received_cases',quantity:1,confirmedBy:'owner',confirmedAt:now},sourceReview:review};
 return {kind:'invoice_reconciliation_source',version:1,organizationId:'org',invoiceId:'i',header:{id:'i',organizationId:'org',vendorId:'v',invoiceNumber:'I-1',recordedTotal:63,rawText:row.sourceLine+'\nSubtotal 56.00\nTax 2.00\nFreight 8.00\nCredits 3.00\nInvoice Total 63.00'},lines:[{id:'il',invoiceId:'i',vendorItemId:'vi',description:row.description,quantity:14,unitPrice:4,amount:56,sellingUnit:'LB',sourceLine:row.sourceLine}],receipts:[receipt],reversals:[]};
}
