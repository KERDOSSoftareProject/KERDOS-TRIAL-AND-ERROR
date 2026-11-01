import {invoiceMoneyCents} from '../core/invoice-reconciliation.js';
import {sameOrderData} from '../core/estimated-orders.js';
import {validateInvoiceApproval,validateInvoiceApprovalReview} from './invoice-approvals.js';
const uuid=value=>typeof value==='string'&&/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const safe=value=>Number.isSafeInteger(value)&&value>=0;
const validDate=value=>typeof value==='string'&&/^\d{4}-\d{2}-\d{2}$/.test(value)&&Number(value.slice(0,4))>=1&&Number.isFinite(Date.parse(value+'T00:00:00Z'))&&new Date(value+'T00:00:00Z').toISOString().slice(0,10)===value;
const methods=['check','bank_transfer','card','cash','other'];
function validFields(amountCents,paidOn,method,reference){return safe(amountCents)&&amountCents>0&&validDate(paidOn)&&methods.includes(method)&&typeof reference==='string'&&reference===reference.trim()&&[...reference].length>=1&&[...reference].length<=200;}
export function parseInvoicePaymentInput({amount,paidOn,method,reference}={}){
 if(typeof amount!=='string'||!/^\d+(?:\.\d{1,2})?$/.test(amount))throw new Error('Enter an exact payment amount with at most two decimal places');
 const amountCents=invoiceMoneyCents(amount),ref=typeof reference==='string'?reference.trim():reference;
 if(!validFields(amountCents,paidOn,method,ref))throw new Error('Enter a positive payment, actual date, method and reference');return {amountCents,paidOn,method,reference:ref};
}
export function validateInvoicePaymentReview(review,organizationId,invoiceId){
 if(review?.kind!=='invoice_payment_review'||review.version!==1||review.organizationId!==organizationId||review.invoiceId!==invoiceId||review.approvalId!==review.approval?.id||!validFields(review.amountCents,review.paidOn,review.method,review.reference)||!safe(review.invoiceTotalCents)||!safe(review.recordedPaidCents)||!safe(review.remainingCents)||review.remainingCents!==review.invoiceTotalCents-review.recordedPaidCents||review.amountCents>review.remainingCents||!safe(review.ledgerRevision?.payments)||!safe(review.ledgerRevision?.reversals)||review.ledgerRevision.reversals>review.ledgerRevision.payments)throw new Error('Payment review has invalid scope, balance or history');
 validateInvoiceApproval(review.approval,organizationId,invoiceId);if(review.invoiceTotalCents!==invoiceMoneyCents(review.approval.source.header.recordedTotal))throw new Error('Payment total differs from approved evidence');return review;
}
export function validateInvoicePayment(payment,organizationId,invoiceId){
 const r=validateInvoicePaymentReview(payment?.sourceReview,organizationId,invoiceId);
 if(!payment.id||!uuid(payment.requestId)||!payment.recordedBy||!Number.isFinite(Date.parse(payment.recordedAt)))throw new Error('Payment audit has invalid identity or time');
 const expected={kind:'invoice_payment_record',version:1,id:payment.id,organizationId,invoiceId,approvalId:r.approvalId,requestId:payment.requestId,amountCents:r.amountCents,paidOn:r.paidOn,method:r.method,reference:r.reference,invoiceTotalCents:r.invoiceTotalCents,recordedBy:payment.recordedBy,recordedAt:payment.recordedAt,sourceReview:r};if(!sameOrderData(payment,expected))throw new Error('Saved payment differs from reviewed evidence');return payment;
}
export function validateInvoicePaymentReversal(reversal,organizationId,invoiceId){
 if(reversal?.kind!=='invoice_payment_reversal'||reversal.version!==1||!reversal.id||reversal.organizationId!==organizationId||reversal.invoiceId!==invoiceId||!reversal.paymentId||!safe(reversal.amountCents)||reversal.amountCents<=0||!reversal.reversedBy||!Number.isFinite(Date.parse(reversal.reversedAt))||typeof reversal.reason!=='string'||reversal.reason!==reversal.reason.trim()||[...reversal.reason].length<10||[...reversal.reason].length>500)throw new Error('Payment reversal has invalid scope or audit');return reversal;
}
export function validateInvoicePaymentLedger(ledger,organizationId,invoiceId){
 const approvalReview=validateInvoiceApprovalReview(ledger?.approvalReview,organizationId,invoiceId);
 if(!Array.isArray(ledger.payments)||!Array.isArray(ledger.reversals))throw new Error('Payment ledger is unavailable');
 ledger.payments.forEach(p=>{validateInvoicePayment(p,organizationId,invoiceId);if(!approvalReview.approvals.some(a=>a.id===p.approvalId&&sameOrderData(a,p.sourceReview.approval)))throw new Error('Payment approval evidence is missing from history');});
 ledger.reversals.forEach(r=>{validateInvoicePaymentReversal(r,organizationId,invoiceId);const p=ledger.payments.find(p=>p.id===r.paymentId);if(!p||r.amountCents!==p.amountCents||Date.parse(r.reversedAt)<Date.parse(p.recordedAt))throw new Error('Reversal differs from its original payment');});
 for(const [rows,key] of [[ledger.payments,'id'],[ledger.payments,'requestId'],[ledger.reversals,'id'],[ledger.reversals,'paymentId']])if(new Set(rows.map(r=>r[key])).size!==rows.length)throw new Error('Duplicate payment ledger history');
 const active=ledger.payments.filter(p=>!ledger.reversals.some(r=>r.paymentId===p.id));let recordedPaidCents=0;for(const p of active){recordedPaidCents+=p.amountCents;if(!safe(recordedPaidCents))throw new Error('Payment sum exceeds supported precision');}
 const current=approvalReview.current[0],historical=ledger.payments[0]?.invoiceTotalCents;
 const invoiceTotalCents=current?invoiceMoneyCents(current.source.header.recordedTotal):ledger.payments.every(p=>p.invoiceTotalCents===historical)?historical??null:null;
 const remainingCents=invoiceTotalCents==null?null:invoiceTotalCents-recordedPaidCents;
 const status=!current||remainingCents<0?'needs_review':invoiceTotalCents===0?'no_payment_due':recordedPaidCents===0?'not_recorded':remainingCents===0?'fully_recorded':'partial';
 return {...ledger,approvalReview,summary:{status,invoiceTotalCents,recordedPaidCents,remainingCents,currentApproval:!!current,historicalBasis:!current&&invoiceTotalCents!=null}};
}
export function createInvoicePaymentService(backend,{requestId=()=>globalThis.crypto.randomUUID()}={}){
 const supported=!!backend.invoicePayments;
 const actor=async()=>{if(!supported)throw new Error('Invoice payment recording is unavailable');const id=(await backend.session.get())?.user?.id;if(!id)throw new Error('Sign in before reviewing payment records');return id;};
 return {supported,
  async ledger(org,invoice){await actor();return validateInvoicePaymentLedger(await backend.invoicePayments.ledger(org,invoice),org,invoice);},
  async review(org,invoice,approvalId,fields){await actor();const inputs=parseInvoicePaymentInput(fields),review=validateInvoicePaymentReview(await backend.invoicePayments.review(org,invoice,approvalId,inputs),org,invoice);if(review.approvalId!==approvalId||Object.keys(inputs).some(k=>review[k]!==inputs[k]))throw new Error('Payment review differs from entered payment details');return review;},
  prepare(review,{confirmed}={}){if(confirmed!==true)throw new Error('Confirm this payment was made elsewhere for this invoice');validateInvoicePaymentReview(review,review.organizationId,review.invoiceId);const id=requestId();if(!uuid(id))throw new Error('Payment request identity is invalid');return {kind:'invoice_payment_request',version:1,requestId:id,review:structuredClone(review)};},
  async save(request,{confirmed}={}){const user=await actor();if(confirmed!==true)throw new Error('Confirm this payment was made elsewhere for this invoice');if(request?.kind!=='invoice_payment_request'||request.version!==1||!uuid(request.requestId))throw new Error('Payment request identity is invalid');const r=validateInvoicePaymentReview(request.review,request.review?.organizationId,request.review?.invoiceId);const saved=validateInvoicePayment(await backend.invoicePayments.save(request),r.organizationId,r.invoiceId);if(saved.requestId!==request.requestId||saved.recordedBy!==user||!sameOrderData(saved.sourceReview,r))throw new Error('Saved payment belongs to different confirmed evidence');return saved;},
  async reverse(payment,reason,{confirmed}={}){const user=await actor();validateInvoicePayment(payment,payment.organizationId,payment.invoiceId);if(confirmed!==true||typeof reason!=='string'||reason!==reason.trim()||[...reason].length<10||[...reason].length>500)throw new Error('Confirm payment reversal with a reason of 10 to 500 characters');const saved=validateInvoicePaymentReversal(await backend.invoicePayments.reverse(payment.organizationId,payment.id,reason),payment.organizationId,payment.invoiceId);if(saved.paymentId!==payment.id||saved.amountCents!==payment.amountCents||saved.reason!==reason||saved.reversedBy!==user)throw new Error('Saved reversal differs from the confirmed request');return saved;},
 };
}
