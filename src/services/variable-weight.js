import {prepareVariableWeightApproval,variableWeightTerms} from '../core/variable-weight-purchasing.js';

export function variableWeightApprovalRecord(row){
  if(!row?.id||row.terms?.organizationId!==row.organization_id||row.terms?.vendorItemId!==row.vendor_item_id||row.terms?.vendorId!==row.vendor_id||row.terms?.catalogItemId!==row.catalog_item_id||!row.approved_by||!row.approved_at)throw new Error('Saved confirmation has incomplete or inconsistent scope');
  return {kind:'variable_weight_approval',version:1,id:row.id,terms:row.terms,
    approvedBy:row.approved_by,approvedAt:row.approved_at,revokedAt:row.revoked_at??null};
}
const stable=value=>value&&typeof value==='object'&&!Array.isArray(value)?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):Array.isArray(value)?value.map(stable):value;
export function variableWeightConfirmationState(input,approval){
  try{
    const terms=variableWeightTerms(input);
    const confirmed=approval&&!approval.revokedAt&&JSON.stringify(stable(approval.terms))===JSON.stringify(stable(terms));
    return {eligible:true,confirmed:!!confirmed,stale:!!approval&&!confirmed,reason:null};
  }catch(error){return {eligible:false,confirmed:false,stale:!!approval,reason:error.message};}
}
export function createVariableWeightService(backend){
  const supported=!!backend.variableWeight;
  const requireCapability=()=>{if(!supported)throw new Error('Variable-weight confirmation is unavailable with this connection');};
  return {supported,
    async list(organizationId,vendorItemIds){
      requireCapability();if(!organizationId)throw new Error('Choose an organization');
      const ids=[...new Set(vendorItemIds)],rows=[];
      for(let offset=0;offset<ids.length;offset+=100)rows.push(...await backend.variableWeight.listApprovals(organizationId,ids.slice(offset,offset+100)));
      // A malformed adapter result must not leak a different client's record.
      if(rows.some(row=>row.organization_id!==organizationId||!ids.includes(row.vendor_item_id)))throw new Error('Confirmation scope does not match this catalog');
      return rows.map(variableWeightApprovalRecord);
    },
    async approve(input){
      requireCapability();
      const session=await backend.session.get(),actorId=session?.user?.id;
      if(!actorId)throw new Error('Sign in before confirming terms');
      const intent=prepareVariableWeightApproval({...input,actorId,now:input.now||new Date().toISOString()});
      const row=await backend.variableWeight.approve({organizationId:input.organizationId,vendorItemId:input.listing.id,mappingId:input.mapping.id,
        expectedRevision:input.listing.row_revision||0,intent});
      if(row.organization_id!==input.organizationId||row.vendor_item_id!==input.listing.id||row.mapping_id!==input.mapping.id)throw new Error('Saved confirmation belongs to a different row');
      const saved=variableWeightApprovalRecord(row);
      if(JSON.stringify(stable(saved.terms))!==JSON.stringify(stable(intent.terms))||saved.revokedAt)throw new Error('Saved confirmation differs from the reviewed terms');
      return saved;
    },
    async revoke(organizationId,approval){
      requireCapability();
      if(approval?.terms?.organizationId!==organizationId)throw new Error('Choose a confirmation from this organization');
      const row=await backend.variableWeight.revoke({organizationId,approvalId:approval.id});
      if(row.organization_id!==organizationId||row.id!==approval.id)throw new Error('Revoked confirmation does not match this row');
      return variableWeightApprovalRecord(row);
    },
  };
}
