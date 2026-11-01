import assert from 'node:assert/strict';
import {prepareEstimatedPurchaseDraft,estimatedDraftTotal} from '../core/estimated-purchase-drafts.js';
import {prepareVariableWeightApproval} from '../core/variable-weight-purchasing.js';
import {createEstimatedDraftService} from './estimated-purchase-drafts.js';
const now='2026-11-01T20:00:00Z';
function line(id,packSize='2/6-8 LBA'){
 const source={code:id,packSize,price:4,sellingUnit:'LB',priceUnavailable:false,billingUnitEvidence:{kind:'pricing-unit-header',header:'Price Unit',unit:'LB'}};
 const listing={id,organization_id:'org',vendor_id:'vendor',vendor_item_code:id,pack_size:packSize,price:4,selling_unit:'LB',row_revision:2,price_unavailable:true,import_row:{reviewRequired:true,reviewFields:['pack_size'],sourceDocumentId:'doc',rowKey:'row:0',row:source}};
 const mapping={id:'mapping-'+id,organization_id:'org',vendor_item_id:id,catalog_item_id:'ci-'+id,comparison_track:'exact',confidence_score:100};
 const input={organizationId:'org',vendorId:'vendor',catalogItemId:mapping.catalog_item_id,listing,mapping,confirmed:true,now,actorId:'manager'};
 const terms=prepareVariableWeightApproval(input).terms;
 return {...input,quantity:2,orderUnit:'case',approval:{kind:'variable_weight_approval',version:1,id:'a-'+id,terms,approvedBy:'manager',approvedAt:now}};
}
const input={organizationId:'org',vendorId:'vendor',requestId:'stable-request',lines:[line('a'),line('b','3/7 LBA')],confirmed:true,now};
const original=structuredClone(input),intent=prepareEstimatedPurchaseDraft(input);
assert.deepEqual(intent.estimate,{amount:null,minimum:264,maximum:296,estimated:true,guaranteed:false});assert.equal(intent.finalCharge,null);
assert.equal(prepareEstimatedPurchaseDraft({...input,lines:[line('b','3/7 LBA')]}).estimate.amount,168);
for(const patch of [{confirmed:false},{requestId:''},{lines:[]},{lines:[line('a'),line('a')]},{lines:[{...line('a'),quantity:1.5}]},{lines:[{...line('a'),quantity:2147483648}]},{lines:[{...line('a'),listing:{...line('a').listing,row_revision:-1}}]},{lines:[{...line('a'),approval:{...line('a').approval,revokedAt:now}}]},{vendorId:'other'},{organizationId:'other'}])assert.throws(()=>prepareEstimatedPurchaseDraft({...input,...patch}));
assert.throws(()=>estimatedDraftTotal([{estimate:{amount:1e15,estimated:true,guaranteed:false}}]),/precision/);
let signedIn=true,writes=0,record,fail=false,tamper=false;
const backend={session:{get:async()=>signedIn?{user:{id:'employee'}}:null},estimatedDrafts:{
 save:async i=>{writes++;if(fail)throw new Error('Quote changed');if(!record)record={id:'draft',organization_id:'org',vendor_id:'vendor',request_id:i.requestId,created_by:'employee',created_at:now,status:'draft',final_charge:null,requested_lines:i.lines,estimate:i.estimate,lines:i.lines.map((l,index)=>{const saved={...l,id:'line-'+index,orderId:'draft',kind:'estimated_purchase_draft_line',rowRevision:l.expectedRevision};delete saved.expectedRevision;delete saved.requiresAuthenticatedPersistence;return saved;})};const result=structuredClone(record);if(tamper)result.lines[0].terms.vendorItemId='different';return result;},
 get:async()=>record?structuredClone(record):null,
 list:async(org,offset)=>{assert.equal(offset,0);return record?[structuredClone(record)]:[];},
 getByRequest:async()=>record?structuredClone(record):null,
 cancel:async()=>{record={...record,status:'cancelled',cancelled_at:now,cancelled_by:'employee'};return structuredClone(record);}}};
const service=createEstimatedDraftService(backend);
signedIn=false;await assert.rejects(service.save(input),/Sign in/);signedIn=true;
await assert.rejects(service.save({...input,confirmed:false}),/Explicitly/);assert.equal(writes,0);
const saved=await service.save(input);assert.equal(saved.kind,'estimated_purchase_draft');assert.equal(saved.requiresFreshValidation,true);assert.equal(saved.finalCharge,null);
assert.equal((await service.save(input)).lines[0].id,saved.lines[0].id);assert.equal((await service.get('org','draft')).id,'draft');
await assert.rejects(service.get('other','draft'),/scope/);await assert.rejects(service.get('org','different'),/ID/);
tamper=true;await assert.rejects(service.save(input),/snapshot|differs from this request/);tamper=false;
fail=true;await assert.rejects(service.save(input),/Quote changed/);fail=false;
assert.equal((await service.recover('org',input.requestId)).id,saved.id);
await assert.rejects(service.recover('org','other'),/different creator/);
assert.equal((await service.list('org')).length,1);await assert.rejects(service.list('other'),/scope/);await assert.rejects(service.list('org',-1),/page/);
const cancelled=await service.cancel('org','draft');assert.equal(cancelled.status,'cancelled');assert.equal(cancelled.finalCharge,null);assert.deepEqual(cancelled.lines,saved.lines);
const missing=createEstimatedDraftService({});assert.equal(missing.supported,false);await assert.rejects(missing.get('org','draft'),/unavailable/);
assert.deepEqual(input,original,'draft preparation and storage adapters preserve source, mapping and approval inputs');
console.log('PASS estimated-draft core and independent adapter: mixed average/range totals, consent, identity, auth, retries, cancellation, precision, source immutability and failures.');
