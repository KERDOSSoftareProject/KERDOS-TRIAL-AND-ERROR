import {reconcileInvoice} from '../core/invoice-reconciliation.js';
import {sameOrderData} from '../core/estimated-orders.js';
export function validateInvoiceApproval(approval,organizationId,invoiceId){
 if(approval?.kind!=='invoice_accounting_approval'||approval.version!==1||!approval.id||approval.organizationId!==organizationId||approval.invoiceId!==invoiceId||!approval.requestId||!approval.approvedBy||!Number.isFinite(Date.parse(approval.approvedAt))||typeof approval.note!=='string'||approval.note!==approval.note.trim()||approval.note.length>500||approval.gate?.eligible!==true||!Array.isArray(approval.gate.reasons)||approval.gate.reasons.length||reconcileInvoice(approval.source,{organizationId,invoiceId}).status!=='reconciled')throw new Error('Accounting approval has invalid scope or evidence');
 return approval;
}
export function validateInvoiceApprovalReview(review,organizationId,invoiceId){
 const local=reconcileInvoice(review?.source,{organizationId,invoiceId});
 if(typeof review?.canApprove!=='boolean'||typeof review?.gate?.eligible!=='boolean'||!Array.isArray(review.gate.reasons)||review.gate.reasons.some(r=>typeof r!=='string')||!Array.isArray(review.approvals)||(review.gate.eligible&&(review.gate.reasons.length||local.status!=='reconciled')))throw new Error('Server accounting checks differ from retained invoice evidence');
 review.approvals.forEach(a=>validateInvoiceApproval(a,organizationId,invoiceId));if(new Set(review.approvals.map(a=>a.id)).size!==review.approvals.length||new Set(review.approvals.map(a=>a.requestId)).size!==review.approvals.length)throw new Error('Accounting approval history contains duplicates');
 return {...review,current:review.gate.eligible?review.approvals.filter(a=>sameOrderData(a.source,review.source)):[]};
}
function validateRequest(request){
 if(request?.kind!=='invoice_accounting_approval_request'||request.version!==1||!request.organizationId||!request.invoiceId||!/^([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/i.test(request.requestId)||typeof request.note!=='string'||request.note!==request.note.trim()||request.note.length>500||reconcileInvoice(request.source,{organizationId:request.organizationId,invoiceId:request.invoiceId}).status!=='reconciled')throw new Error('Accounting approval request needs a clean reviewed invoice');return request;
}
export function createInvoiceApprovalService(backend,{requestId=()=>globalThis.crypto.randomUUID()}={}){
 const supported=!!backend.invoiceApprovals;
 const actor=async()=>{if(!supported)throw new Error('Accounting approval is unavailable');const id=(await backend.session.get())?.user?.id;if(!id)throw new Error('Sign in before accounting approval');return id;};
 return {supported,
  async review(organizationId,invoiceId){await actor();return validateInvoiceApprovalReview(await backend.invoiceApprovals.review(organizationId,invoiceId),organizationId,invoiceId);},
  prepare(review,{note='',confirmed}={}){const checked=validateInvoiceApprovalReview(review,review.source?.organizationId,review.source?.invoiceId);if(confirmed!==true||!checked.canApprove||!checked.gate.eligible)throw new Error('Explicit owner or manager approval of a clean invoice is required');return validateRequest({kind:'invoice_accounting_approval_request',version:1,organizationId:review.source.organizationId,invoiceId:review.source.invoiceId,requestId:requestId(),source:structuredClone(review.source),note:note.trim()});},
  async save(request,{confirmed}={}){const user=await actor();if(confirmed!==true)throw new Error('Confirm accounting approval');validateRequest(request);const saved=validateInvoiceApproval(await backend.invoiceApprovals.save(request),request.organizationId,request.invoiceId);if(saved.requestId!==request.requestId||saved.approvedBy!==user||saved.note!==request.note||!sameOrderData(saved.source,request.source))throw new Error('Saved accounting approval differs from the confirmed request');return saved;},
 };
}
