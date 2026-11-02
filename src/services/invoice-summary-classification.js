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
 return {supported,
  async review(organizationId,invoiceId){const user=await actor();return {...validateSummaryContext(await backend.invoiceSummaryClassification.review(organizationId,invoiceId),organizationId,invoiceId),actorId:user};},
  prepare(context,mappings,reason,{confirmed}={}){
   const source=context?.source;validateSummaryContext(context,source?.organizationId,source?.invoiceId);
   if(!context.actorId||!context.canClassify||confirmed!==true)throw Error('Owner or manager confirmation of retained summary source is required');
   return validateSummaryRequest({kind:'invoice_summary_classification_request',version:1,requestId:requestId(),requestedBy:context.actorId,review:{kind:'invoice_summary_classification_review',version:1,organizationId:source.organizationId,invoiceId:source.invoiceId,basis:invoiceSummaryBasis(source),previousId:context.history.at(-1)?.id??null,mappings:structuredClone(mappings),reason}});
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
 const saved=context.history.find(record=>record.requestId===plan.requestId);
 if(saved){if(saved.recordedBy!==plan.requestedBy||saved.previousId!==r.previousId||saved.reason!==r.reason||!sameSummaryData(saved.basis,r.basis)||!sameSummaryData(saved.mappings,r.mappings))throw Error('Classification request belongs to different confirmed evidence');return {status:'saved',recordId:saved.id};}
 return (context.history.at(-1)?.id??null)!==r.previousId?{status:'superseded'}:{status:'pending'};
}
