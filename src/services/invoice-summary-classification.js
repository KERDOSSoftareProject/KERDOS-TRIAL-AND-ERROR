import {classifyInvoiceSummary,invoiceSummaryBasis,sameSummaryData,validateSummaryClassification} from '../core/invoice-summary-classification.js';
import {reconcileInvoice} from '../core/invoice-reconciliation.js';
const uuid=value=>/^[a-f0-9]{8}(-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value||'');
export function validateSummaryContext(context,organizationId,invoiceId){
 const {summaryClassification:latest,...base}=context?.source||{};
 reconcileInvoice(base,{organizationId,invoiceId});
 if(typeof context.canClassify!=='boolean'||!Array.isArray(context.history))throw Error('Invalid summary classification review');
 let previous=null;const ids=new Set(),requests=new Set();
 for(const [index,record]of context.history.entries()){
  validateSummaryClassification(record,organizationId,invoiceId);
  if(record.revision!==index+1||record.previousId!==previous||ids.has(record.id)||requests.has(record.requestId))throw Error('Invalid summary classification lineage');
  previous=record.id;ids.add(record.id);requests.add(record.requestId);
 }
 const closed=context.closedAttempts??[];if(!Array.isArray(closed))throw Error('Summary closure history is unavailable');
 for(const record of closed){validateSummaryClosedAttempt(record,organizationId,invoiceId);if(requests.has(record.requestId))throw Error('A summary request cannot be both saved and closed');}
 for(const key of ['id','requestId'])if(new Set(closed.map(r=>r[key])).size!==closed.length)throw Error('Duplicate closed summary attempt');
 if(!sameSummaryData(latest??null,context.history.at(-1)??null))throw Error('Summary classification source and history differ');return context;
}
export function validateSummaryRequest(plan){
 const r=plan?.review;
 if(plan?.kind!=='invoice_summary_classification_request'||plan.version!==1||!uuid(plan.requestId)||typeof plan.requestedBy!=='string'||!plan.requestedBy||r?.kind!=='invoice_summary_classification_review'||r.version!==1||!r.organizationId||!r.invoiceId||!(r.previousId===null||typeof r.previousId==='string')||typeof r.reason!=='string'||r.reason!==r.reason.trim()||[...r.reason].length<10||[...r.reason].length>500)throw Error('Review summary classification and a trimmed reason of 10 to 500 characters');
 classifyInvoiceSummary(r.basis,r.mappings);return plan;
}
export function createSummaryClassificationService(backend,{requestId=()=>crypto.randomUUID()}={}){
 const supported=!!backend.invoiceSummaryClassification;
 async function actor(){if(!supported)throw Error('Summary classification is unavailable');const id=(await backend.session.get())?.user?.id;if(!id)throw Error('Sign in before summary classification');return id;}
 return {supported,closureSupported:!!backend.invoiceSummaryClassification?.closeAttempt,
  async review(organizationId,invoiceId){const user=await actor();return {...validateSummaryContext(await backend.invoiceSummaryClassification.review(organizationId,invoiceId),organizationId,invoiceId),actorId:user};},
  prepare(context,mappings,reason,{confirmed}={}){
   const source=context?.source;validateSummaryContext(context,source?.organizationId,source?.invoiceId);
   if(!context.actorId||!context.canClassify||confirmed!==true)throw Error('Owner or manager confirmation of retained summary source is required');
   return validateSummaryRequest({kind:'invoice_summary_classification_request',version:1,requestId:requestId(),requestedBy:context.actorId,review:{kind:'invoice_summary_classification_review',version:1,organizationId:source.organizationId,invoiceId:source.invoiceId,basis:invoiceSummaryBasis(source),previousId:context.history.at(-1)?.id??null,mappings:structuredClone(mappings),reason}});
  },
  async closeAttempt(plan,{confirmed}={}){
   const user=await actor();validateSummaryRequest(plan);if(plan.requestedBy!==user)throw Error('This retained classification request belongs to another signed-in user');if(confirmed!==true)throw Error('Confirm closing the unconfirmed classification attempt');if(!backend.invoiceSummaryClassification.closeAttempt)throw Error('Summary attempt closure is unavailable');
   const result=await backend.invoiceSummaryClassification.closeAttempt(plan);
   if(result?.status==='saved'){const record=validateSummaryClassification(result.record,plan.review.organizationId,plan.review.invoiceId);assertSummaryResult(record,plan);return {status:'saved',record};}
   if(result?.status!=='closed')throw Error('Summary closure result is unknown');const record=validateSummaryClosedAttempt(result.attempt,plan.review.organizationId,plan.review.invoiceId);assertSummaryResult(record,plan);return {status:'closed',record};
  },
  async save(plan,{confirmed}={}){
   const user=await actor();validateSummaryRequest(plan);if(plan.requestedBy!==user)throw Error('This retained classification request belongs to another signed-in user');if(confirmed!==true)throw Error('Confirm summary classification');
   const saved=validateSummaryClassification(await backend.invoiceSummaryClassification.save(plan),plan.review.organizationId,plan.review.invoiceId),r=plan.review;
   if(saved.requestId!==plan.requestId||saved.recordedBy!==user||saved.previousId!==r.previousId||saved.reason!==r.reason||!sameSummaryData(saved.basis,r.basis)||!sameSummaryData(saved.mappings,r.mappings))throw Error('Saved summary classification differs from confirmed request');return saved;
  },
 };
}

// Immutable predecessor CAS makes a missing old request permanently unable to apply
// once another revision advances its predecessor. Source changes alone do not prove this.
export function resolveSummaryRequest(plan,context){
 validateSummaryRequest(plan);const r=plan.review;validateSummaryContext(context,r.organizationId,r.invoiceId);
 if(context.actorId!==plan.requestedBy)throw Error('Classification recovery belongs to another signed-in user');
 const closed=(context.closedAttempts??[]).find(record=>record.requestId===plan.requestId);if(closed){assertSummaryResult(closed,plan);return {status:'closed',recordId:closed.id};}
 const saved=context.history.find(record=>record.requestId===plan.requestId);
 if(saved){if(saved.recordedBy!==plan.requestedBy||saved.previousId!==r.previousId||saved.reason!==r.reason||!sameSummaryData(saved.basis,r.basis)||!sameSummaryData(saved.mappings,r.mappings))throw Error('Classification request belongs to different confirmed evidence');return {status:'saved',recordId:saved.id};}
 return (context.history.at(-1)?.id??null)!==r.previousId?{status:'superseded'}:{status:'pending'};
}

export function validateSummaryClosedAttempt(record,organizationId,invoiceId){
 if(record?.kind!=='invoice_summary_closed_attempt'||record.version!==1||!record.id||record.organizationId!==organizationId||record.invoiceId!==invoiceId||!record.closedBy||!Number.isFinite(Date.parse(record.closedAt)))throw Error('Invalid closed summary attempt audit');
 validateSummaryRequest({kind:'invoice_summary_classification_request',version:1,requestId:record.requestId,requestedBy:record.closedBy,review:record.review});
 if(record.review.organizationId!==organizationId||record.review.invoiceId!==invoiceId)throw Error('Closed summary attempt scope differs');return record;
}
function assertSummaryResult(record,plan){
 if(record.requestId!==plan.requestId||(record.closedBy??record.recordedBy)!==plan.requestedBy||(record.review?!sameSummaryData(record.review,plan.review):record.previousId!==plan.review.previousId||record.reason!==plan.review.reason||!sameSummaryData(record.basis,plan.review.basis)||!sameSummaryData(record.mappings,plan.review.mappings)))throw Error('Summary request belongs to different confirmed evidence');
}
