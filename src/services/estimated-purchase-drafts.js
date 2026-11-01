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
  async function savePrepared(intent,{confirmed}={}){
      requireCapability();
      if(confirmed!==true||intent?.kind!=='estimated_purchase_draft_intent'||intent.version!==1||intent.finalCharge!==null||!intent.requestId||!Array.isArray(intent.lines)||!intent.lines.length||intent.lines.length>100||!same(estimatedDraftTotal(intent.lines),intent.estimate))throw new Error('Explicitly review this estimated draft before saving');
      const actorId=(await backend.session.get())?.user?.id;
      if(!actorId)throw new Error('Sign in before saving a draft');
      const row=await backend.estimatedDrafts.save(intent);
      const record=estimatedDraftRecord(row,intent.organizationId);
      if(record.vendorId!==intent.vendorId||record.requestId!==intent.requestId||record.createdBy!==actorId||!same(row.requested_lines,intent.lines))throw new Error('Saved draft differs from this request');
      return record;
    }
  return {supported,
    async save(input){
      requireCapability();if(!(await backend.session.get())?.user?.id)throw new Error('Sign in before saving a draft');return savePrepared(prepareEstimatedPurchaseDraft({...input,now:input.now||new Date().toISOString()}),{confirmed:input.confirmed});
    },
    savePrepared,
    async list(organizationId,offset=0){
      requireCapability();if(!organizationId||!Number.isSafeInteger(offset)||offset<0)throw new Error('Choose an organization and valid draft page');
      return (await backend.estimatedDrafts.list(organizationId,offset)).map(row=>estimatedDraftRecord(row,organizationId));
    },
    async recover(organizationId,requestId,expectedIntent){
      requireCapability();const actorId=(await backend.session.get())?.user?.id;if(!actorId)throw new Error('Sign in before recovering a draft');
      const row=await backend.estimatedDrafts.getByRequest(organizationId,requestId);if(!row)return null;const record=estimatedDraftRecord(row,organizationId);
      if(record.requestId!==requestId||record.createdBy!==actorId)throw new Error('Draft request belongs to a different creator');
      if(expectedIntent&&(expectedIntent.organizationId!==organizationId||expectedIntent.vendorId!==record.vendorId||!same(expectedIntent.lines,row.requested_lines)))throw new Error('Recovered draft differs from the retained request');return record;
    },
    async closeAttempt(intent,{confirmed}={}){
      requireCapability();
      if(confirmed!==true||intent?.kind!=='estimated_purchase_draft_intent'||intent.version!==1||!intent.organizationId||!intent.vendorId||!intent.requestId||!Array.isArray(intent.lines)||!intent.lines.length||intent.lines.length>100)throw new Error('Confirm closing the retained save attempt');
      const actorId=(await backend.session.get())?.user?.id;if(!actorId)throw new Error('Sign in before closing a save attempt');
      if(typeof backend.estimatedDrafts.closeAttempt!=='function')throw new Error('Closing save attempts is unavailable with this connection');
      const result=await backend.estimatedDrafts.closeAttempt(intent);
      if(result?.status==='saved'){
        const record=estimatedDraftRecord(result.draft,intent.organizationId);
        if(record.requestId!==intent.requestId||record.vendorId!==intent.vendorId||record.createdBy!==actorId||!same(result.draft.requested_lines,intent.lines))throw new Error('Recovered draft differs from the retained request');
        return {status:'saved',draft:record};
      }
      if(result?.status!=='closed'||result.organizationId!==intent.organizationId||result.vendorId!==intent.vendorId||result.requestId!==intent.requestId||result.createdBy!==actorId||!Number.isFinite(Date.parse(result.closedAt))||!same(result.requestedLines,intent.lines))throw new Error('Server did not confirm closure of this save attempt');
      return result;
    },
    async get(organizationId,draftId){requireCapability();const row=await backend.estimatedDrafts.get(organizationId,draftId);if(!row)return null;const record=estimatedDraftRecord(row,organizationId);if(record.id!==draftId)throw new Error('Saved draft ID differs');return record;},
    async cancel(organizationId,draftId){requireCapability();const row=await backend.estimatedDrafts.cancel(organizationId,draftId);const record=estimatedDraftRecord(row,organizationId);if(record.id!==draftId||record.status!=='cancelled')throw new Error('Draft cancellation was not confirmed');return record;},
  };
}
