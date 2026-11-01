import {prepareEstimatedPurchaseDraft,estimatedDraftTotal} from '../core/estimated-purchase-drafts.js';
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(k=>[k,stable(value[k])])):value;
const same=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
export function estimatedDraftRecord(row,organizationId){
  if(!row?.id||row.organization_id!==organizationId||!['draft','cancelled'].includes(row.status)||row.final_charge!==null||!row.created_by||!Array.isArray(row.lines)||!row.lines.length||!Array.isArray(row.requested_lines)||row.lines.length!==row.requested_lines.length)throw new Error('Saved draft has invalid scope or status');
  if(row.status==='cancelled'&&(!row.cancelled_at||!row.cancelled_by))throw new Error('Draft cancellation lacks its audit record');
  if(!same(estimatedDraftTotal(row.lines),row.estimate))throw new Error('Saved draft total differs from its lines');
  const ids=new Set();
  for(const [index,line] of row.lines.entries()){
    const requested=row.requested_lines[index],expected={...requested,id:line.id,orderId:row.id,kind:'estimated_purchase_draft_line',rowRevision:requested.expectedRevision};
    delete expected.expectedRevision;delete expected.requiresAuthenticatedPersistence;
    if(!same(line,expected))throw new Error('Saved draft line differs from its request snapshot');
    if(line.kind!=='estimated_purchase_draft_line'||!line.id||ids.has(line.id)||line.orderId!==row.id||line.terms?.organizationId!==organizationId||line.terms?.vendorId!==row.vendor_id||line.actualCharge!==null)throw new Error('Saved draft line has invalid scope or charge');
    ids.add(line.id);
  }
  return {kind:'estimated_purchase_draft',version:1,id:row.id,organizationId,vendorId:row.vendor_id,requestId:row.request_id,
    createdBy:row.created_by,createdAt:row.created_at,status:row.status,lines:row.lines,estimate:row.estimate,finalCharge:null,requiresFreshValidation:true,cancelledAt:row.cancelled_at??null,cancelledBy:row.cancelled_by??null};
}
export function createEstimatedDraftService(backend){
  const supported=!!backend.estimatedDrafts;
  const requireCapability=()=>{if(!supported)throw new Error('Estimated drafts are unavailable with this connection');};
  return {supported,
    async save(input){
      requireCapability();const actorId=(await backend.session.get())?.user?.id;
      if(!actorId)throw new Error('Sign in before saving a draft');
      const intent=prepareEstimatedPurchaseDraft({...input,now:input.now||new Date().toISOString()});
      const row=await backend.estimatedDrafts.save(intent);
      const record=estimatedDraftRecord(row,input.organizationId);
      if(record.vendorId!==input.vendorId||record.requestId!==input.requestId||record.createdBy!==actorId||!same(row.requested_lines,intent.lines))throw new Error('Saved draft differs from this request');
      return record;
    },
    async recover(organizationId,requestId){
      requireCapability();const actorId=(await backend.session.get())?.user?.id;if(!actorId)throw new Error('Sign in before recovering a draft');
      const row=await backend.estimatedDrafts.getByRequest(organizationId,requestId);if(!row)return null;const record=estimatedDraftRecord(row,organizationId);
      if(record.requestId!==requestId||record.createdBy!==actorId)throw new Error('Draft request belongs to a different creator');return record;
    },
    async get(organizationId,draftId){requireCapability();const row=await backend.estimatedDrafts.get(organizationId,draftId);if(!row)return null;const record=estimatedDraftRecord(row,organizationId);if(record.id!==draftId)throw new Error('Saved draft ID differs');return record;},
    async cancel(organizationId,draftId){requireCapability();const row=await backend.estimatedDrafts.cancel(organizationId,draftId);const record=estimatedDraftRecord(row,organizationId);if(record.id!==draftId||record.status!=='cancelled')throw new Error('Draft cancellation was not confirmed');return record;},
  };
}
