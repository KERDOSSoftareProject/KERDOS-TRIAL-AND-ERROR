import {prepareEstimatedPurchaseLine} from './variable-weight-purchasing.js';

// Drafts cannot be submitted or used as receipt-bearing purchase order lines.
export function estimatedDraftTotal(lines){
  let minimum=0,maximum=0,ranges=false;
  for(const {estimate:e} of lines){
    if(!e||e.estimated!==true||e.guaranteed!==false)throw new Error('Every draft line needs a labeled estimate');
    const lo=e.amount??e.minimum,hi=e.amount??e.maximum;
    if(!Number.isFinite(lo)||!Number.isFinite(hi)||lo<=0||hi<lo)throw new Error('A complete estimate or range is required');
    minimum+=Math.round(lo*100);maximum+=Math.round(hi*100);ranges||=e.amount==null;
    if(!Number.isSafeInteger(minimum)||!Number.isSafeInteger(maximum))throw new Error('Draft estimate exceeds supported monetary precision');
  }
  if(!lines.length)throw new Error('A draft needs line items');
  return {amount:ranges?null:minimum/100,minimum:ranges?minimum/100:null,maximum:ranges?maximum/100:null,estimated:true,guaranteed:false};
}
export function prepareEstimatedPurchaseDraft({organizationId,vendorId,requestId,lines,confirmed,now}){
  if(confirmed!==true)throw new Error('Explicitly confirm saving this estimated draft');
  if(typeof requestId!=='string'||!requestId.trim())throw new Error('Retain one request ID for retries');
  if(!Array.isArray(lines)||!lines.length||lines.length>100)throw new Error('A draft needs one to one hundred lines');
  const seen=new Set();
  const prepared=lines.map(input=>{
    if(seen.has(input.listing?.id))throw new Error('Duplicate vendor items are not allowed');seen.add(input.listing?.id);
    const revision=input.listing?.row_revision??0;
    if(!Number.isSafeInteger(revision)||revision<0)throw new Error('A valid listing revision is required');
    if(input.quantity>2147483647)throw new Error('Case quantity exceeds the supported storage limit');
    return {...prepareEstimatedPurchaseLine({...input,organizationId,vendorId,now}),expectedRevision:revision};
  });
  return {kind:'estimated_purchase_draft_intent',version:1,organizationId,vendorId,requestId,lines:prepared,estimate:estimatedDraftTotal(prepared),finalCharge:null};
}
