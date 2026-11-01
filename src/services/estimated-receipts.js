import {invoiceChargeSourceMatches} from '../core/invoice-receipt-evidence.js';
import {prepareVariableWeightReceipt,summarizeVariableWeightReceipts} from '../core/variable-weight-purchasing.js';
import {sameOrderData} from '../core/estimated-orders.js';
function calculation(review,actorId,now){
 const intent=prepareVariableWeightReceipt({orderLine:review.orderLine,invoiceLine:review.invoiceLine,link:{confirmed:true,orderLineId:review.orderLine.id,invoiceDocumentId:review.invoiceLine.sourceDocumentId,invoiceLineId:review.invoiceLine.id},receivedCaseQuantity:review.receivedCaseQuantity,actorId,now});
 for(const k of ['kind','version','requestedBy','reviewedAt','requiresAuthenticatedPersistence'])delete intent[k];return intent;
}
export function validateReceiptReview(review,{organizationId,orderLineId,invoiceLineId,cases,actorId='review'}={}){
 if(!invoiceChargeSourceMatches(review?.invoiceLine))throw new Error('Invoice rate and charge need retained printed source clarification');
 if(review?.kind!=='estimated_receipt_review'||review.version!==1||review.organizationId!==organizationId||review.orderLine?.id!==orderLineId||review.orderLine?.terms?.organizationId!==organizationId||review.invoiceLine?.id!==invoiceLineId||review.invoiceLine.organizationId!==organizationId||review.receivedCaseQuantity!==cases||!Number.isSafeInteger(cases)||cases<=0||!Number.isSafeInteger(review.remainingCases)||review.remainingCases<cases||!sameOrderData(review.calculation,calculation(review,actorId,new Date().toISOString())))throw new Error('Receipt review differs from the saved order or invoice evidence');
 return review;
}
export function validateEstimatedReceipt(receipt,organizationId,orderId){
 const r=receipt?.sourceReview;
 if(receipt?.kind!=='variable_weight_receipt'||receipt.version!==1||!receipt.id||!receipt.receivedBy||!Number.isFinite(Date.parse(receipt.receivedAt))||receipt.organizationId!==organizationId||receipt.orderId!==orderId||r?.orderLine?.orderId!==orderId)throw new Error('Saved receipt has invalid scope or audit');
 validateReceiptReview(r,{organizationId,orderLineId:receipt.orderLineId,invoiceLineId:receipt.invoiceLineId,cases:receipt.receivedCaseQuantity});
 const expected={...r.calculation,kind:'variable_weight_receipt',version:1,id:receipt.id,receivedBy:receipt.receivedBy,receivedAt:receipt.receivedAt,caseEvidence:{kind:'client_received_cases',quantity:receipt.receivedCaseQuantity,confirmedBy:receipt.receivedBy,confirmedAt:receipt.receivedAt},sourceReview:r};
 if(!sameOrderData(receipt,expected))throw new Error('Saved receipt differs from its confirmed source snapshot');return receipt;
}
export function validateReceiptReversal(reversal,organizationId,orderId){
 if(reversal?.kind!=='estimated_receipt_reversal'||reversal.version!==1||!reversal.id||reversal.organizationId!==organizationId||reversal.orderId!==orderId||!reversal.receiptId||!reversal.reversedBy||!Number.isFinite(Date.parse(reversal.reversedAt))||typeof reversal.reason!=='string'||reversal.reason!==reversal.reason.trim()||reversal.reason.length<10||reversal.reason.length>500)throw new Error('Receipt reversal has invalid scope or audit');
 return reversal;
}
export function validateReceiptHistory(history,organizationId,orderId){
 if(!Array.isArray(history?.receipts)||!Array.isArray(history?.reversals))throw new Error('Receipt and reversal history is unavailable');
 history.receipts.forEach(r=>validateEstimatedReceipt(r,organizationId,orderId));
 history.reversals.forEach(r=>{validateReceiptReversal(r,organizationId,orderId);if(!history.receipts.some(x=>x.id===r.receiptId))throw new Error('Reversal refers to an unknown receipt');});
 if(new Set(history.receipts.map(r=>r.id)).size!==history.receipts.length||new Set(history.reversals.map(r=>r.receiptId)).size!==history.reversals.length||new Set(history.reversals.map(r=>r.id)).size!==history.reversals.length)throw new Error('Receipt history contains duplicate records');
 return history;
}
export function summarizeEstimatedOrderReceipts(order,receipts,reversals=[]){
 validateReceiptHistory({receipts,reversals},order.organizationId,order.id);
 for(const r of receipts)validateEstimatedReceipt(r,order.organizationId,order.id);
 if(new Set(receipts.map(r=>r.invoiceLineId)).size!==receipts.length)throw new Error('An invoice line cannot be counted twice');
 const active=receipts.filter(r=>!reversals.some(v=>v.receiptId===r.id));
 const lines=order.lines.map(line=>({orderLineId:line.id,...summarizeVariableWeightReceipts(line,active.filter(r=>r.orderLineId===line.id))}));
 if(receipts.some(r=>!order.lines.some(l=>l.id===r.orderLineId)))throw new Error('Receipt belongs to another order line');
 const sum=values=>{let cents=0;for(const v of values){cents+=Math.round(v*100);if(!Number.isSafeInteger(cents))throw new Error('Receipt total exceeds supported precision');}return cents/100;};
 const complete=lines.length>0&&lines.every(l=>l.status==='complete');
 return {status:complete?'complete':active.length?'partial':'pending',recordedCharge:sum(lines.map(l=>l.recordedCharge)),actualCharge:complete?sum(lines.map(l=>l.actualCharge)):null,lines,estimate:order.estimate};
}
export function createEstimatedReceiptService(backend){
 const supported=!!backend.estimatedReceipts;
 const actor=async()=>{if(!supported)throw new Error('Invoice receipt review is unavailable');const id=(await backend.session.get())?.user?.id;if(!id)throw new Error('Sign in before reviewing receipts');return id;};
 return {supported,reversalsSupported:!!backend.estimatedReceiptReversals,
  async history(organizationId,orderId){await actor();if(!backend.estimatedReceiptReversals)throw new Error('Receipt reversal history is unavailable');return validateReceiptHistory(await backend.estimatedReceiptReversals.history(organizationId,orderId),organizationId,orderId);},
  async reverse(receipt,reason,{confirmed}={}){const user=await actor();if(!backend.estimatedReceiptReversals)throw new Error('Receipt reversal is unavailable');validateEstimatedReceipt(receipt,receipt.organizationId,receipt.orderId);if(confirmed!==true)throw new Error('Confirm receipt reversal');if(typeof reason!=='string'||reason!==reason.trim()||reason.length<10||reason.length>500)throw new Error('Enter a reversal reason of 10 to 500 characters');const saved=validateReceiptReversal(await backend.estimatedReceiptReversals.reverse(receipt.organizationId,receipt.id,reason),receipt.organizationId,receipt.orderId);if(saved.receiptId!==receipt.id||saved.reason!==reason||saved.reversedBy!==user)throw new Error('Saved reversal differs from the confirmed request');return saved;},
  async candidates(organizationId,orderLineId,offset=0){await actor();if(!Number.isSafeInteger(offset)||offset<0)throw new Error('Choose a valid invoice page');const rows=await backend.estimatedReceipts.candidates(organizationId,orderLineId,offset);if(!Array.isArray(rows)||rows.some(r=>r.organizationId!==organizationId||r.documentKind!=='invoice'||!r.id))throw new Error('Invoice candidates have invalid scope');return rows;},
  async review(organizationId,orderLineId,invoiceLineId,cases){const user=await actor();if(!Number.isSafeInteger(cases)||cases<=0)throw new Error('Enter confirmed whole received cases');return validateReceiptReview(await backend.estimatedReceipts.review(organizationId,orderLineId,invoiceLineId,cases),{organizationId,orderLineId,invoiceLineId,cases,actorId:user});},
  async save(review,{confirmed,casesConfirmed}={}){const user=await actor();if(confirmed!==true||casesConfirmed!==true)throw new Error('Confirm the invoice link and physically received cases');validateReceiptReview(review,{organizationId:review.organizationId,orderLineId:review.orderLine?.id,invoiceLineId:review.invoiceLine?.id,cases:review.receivedCaseQuantity,actorId:user});const saved=validateEstimatedReceipt(await backend.estimatedReceipts.save(review),review.organizationId,review.orderLine.orderId);if(saved.receivedBy!==user||!sameOrderData(saved.sourceReview,review))throw new Error('Saved receipt belongs to another confirmed request');return saved;},
  async list(organizationId,orderId){await actor();const rows=await backend.estimatedReceipts.list(organizationId,orderId);if(!Array.isArray(rows))throw new Error('Receipt history is invalid');return rows.map(r=>validateEstimatedReceipt(r,organizationId,orderId));},
 };
}
