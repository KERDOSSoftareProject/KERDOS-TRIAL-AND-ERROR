import assert from 'node:assert/strict';
import {createVariableWeightService,variableWeightConfirmationState} from './variable-weight.js';
const source={code:'SYN',packSize:'2/6-8 LBA',price:4,sellingUnit:'LB',priceUnavailable:false,billingUnitEvidence:{kind:'pricing-unit-header',header:'Product UOM',unit:'LB'}};
const listing={id:'vi',organization_id:'org',vendor_id:'v',vendor_item_code:'SYN',pack_size:source.packSize,price:4,selling_unit:'LB',price_basis:'measure',price_unavailable:true,row_revision:7,import_row:{reviewRequired:false,sourceDocumentId:'doc',rowKey:'row:0',row:source}};
const mapping={id:'m',organization_id:'org',vendor_item_id:'vi',catalog_item_id:'ci',comparison_track:'exact',confidence_score:100};
const input={organizationId:'org',vendorId:'v',catalogItemId:'ci',listing,mapping,confirmed:true,now:'2026-11-01T20:00:00Z'};
let signedIn=true,writes=0,record;const batches=[];
const backend={session:{get:async()=>signedIn?{user:{id:'owner'}}:null},variableWeight:{
 listApprovals:async(org,ids)=>{batches.push(ids);return ids.includes('vi')&&record?[record]:[];},
 approve:async request=>{writes++;assert.equal(request.expectedRevision,7);record={id:'approval',organization_id:'org',vendor_id:'v',vendor_item_id:'vi',mapping_id:'m',catalog_item_id:'ci',terms:request.intent.terms,approved_by:request.intent.requestedBy,approved_at:input.now};return structuredClone(record);},
 revoke:async()=>({...record,revoked_at:input.now,revoked_by:'owner'})}};
const original=structuredClone(input),service=createVariableWeightService(backend);
await assert.rejects(service.approve({...input,confirmed:false}),/Explicit acceptance/);assert.equal(writes,0);
signedIn=false;await assert.rejects(service.approve(input),/Sign in/);assert.equal(writes,0);signedIn=true;
const saved=await service.approve(input);assert.equal(saved.approvedBy,'owner');assert.equal(writes,1);
assert.equal(variableWeightConfirmationState(input,saved).confirmed,true);
assert.equal(variableWeightConfirmationState({...input,listing:{...listing,description:'Changed'}},saved).stale,true);
assert.equal(variableWeightConfirmationState({...input,mapping:{...mapping,confidence_score:0}},saved).eligible,false);
const rows=await service.list('org',['vi',...Array.from({length:205},(_,i)=>'other'+i),'vi']);
assert.equal(rows.length,1);assert.deepEqual(batches.map(b=>b.length),[100,100,6]);
const revoked=await service.revoke('org',saved);assert.ok(revoked.revokedAt);assert.equal(variableWeightConfirmationState(input,revoked).confirmed,false);
await assert.rejects(service.revoke('other',saved),/this organization/);
record={...record,organization_id:'other'};await assert.rejects(service.list('org',['vi']),/scope/);
record={...record,organization_id:'org',terms:{...record.terms,organizationId:'other'}};await assert.rejects(service.list('org',['vi']),/scope/);
const unsupported=createVariableWeightService({});assert.equal(unsupported.supported,false);await assert.rejects(unsupported.list('org',[]),/unavailable/);
assert.deepEqual(input,original,'confirmation service does not change quotation, mapping or source evidence');
console.log('PASS independent approval adapter: explicit consent, authenticated actor, revisions, batching, scope, staleness, revocation and unchanged quotation.');
