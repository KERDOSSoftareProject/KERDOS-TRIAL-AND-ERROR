import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtempSync,rmSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import {prepareVariableWeightApproval} from '../core/variable-weight-purchasing.js';
import {createEstimatedDraftService} from '../services/estimated-purchase-drafts.js';
import {createDraftRecoveryStore} from '../services/draft-recovery-store.js';
const dir=mkdtempSync(fileURLToPath(new URL('../../node_modules/.kerdos-draft-ui-',import.meta.url)));
function memory(){const values=new Map();return {get length(){return values.size;},key:i=>[...values.keys()][i],getItem:k=>values.get(k)??null,setItem:(k,v)=>values.set(k,v)};}
const text=n=>typeof n==='string'?n:Array.isArray(n)?n.map(text).join(''):(n?.children||[]).map(text).join('');
try{
 await build({configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},build:{ssr:fileURLToPath(new URL('./EstimatedPurchaseDrafts.jsx',import.meta.url)),outDir:dir,rollupOptions:{output:{entryFileNames:'drafts.mjs'}}}});
 const {EstimatedPurchaseDrafts}=await import(pathToFileURL(join(dir,'drafts.mjs')));
 const now=new Date(Date.now()-1000).toISOString(),source={code:'SYN',packSize:'2/6-8 LBA',price:4,sellingUnit:'LB',priceUnavailable:false,billingUnitEvidence:{kind:'pricing-unit-header',header:'Price Unit',unit:'LB'}};
 const listing={id:'vi',organization_id:'org',vendor_id:'v',description:'Synthetic material',vendor_item_code:'SYN',price:4,selling_unit:'LB',pack_size:source.packSize,row_revision:1,price_unavailable:true,import_row:{reviewRequired:false,sourceDocumentId:'doc',rowKey:'row:0',row:source}};
 const mapping={id:'map',organization_id:'org',vendor_item_id:'vi',catalog_item_id:'ci',comparison_track:'exact',confidence_score:100};
 const terms=prepareVariableWeightApproval({organizationId:'org',vendorId:'v',catalogItemId:'ci',listing,mapping,confirmed:true,actorId:'manager',now}).terms;
 const approval={kind:'variable_weight_approval',version:1,id:'approval',terms,approvedBy:'manager',approvedAt:now};
 function fixture(){
  const records=[],journal=memory();let writes=0,cancellations=0,release,mode='ok',readFailure=false,approvalRows=[approval];
  const backend={session:{get:async()=>({user:{id:'employee'}})},estimatedDrafts:{
   save:async i=>{writes++;if(mode==='sql'){const e=Error('Source terms changed');e.cause={code:'P0001'};throw e;}if(mode==='network-before')throw Error('Connection lost');let r=records.find(d=>d.request_id===i.requestId);if(!r){r={id:'draft-'+records.length,organization_id:'org',vendor_id:'v',request_id:i.requestId,created_by:'employee',created_at:now,status:'draft',final_charge:null,requested_lines:i.lines,estimate:i.estimate,lines:i.lines.map((l,index)=>{const n={...l,id:'line-'+index,orderId:'draft-'+records.length,kind:'estimated_purchase_draft_line',rowRevision:l.expectedRevision};delete n.expectedRevision;delete n.requiresAuthenticatedPersistence;return n;})};records.unshift(r);}if(mode==='network-after')throw Error('Response lost');if(mode==='deferred')return new Promise(resolve=>{release=()=>resolve(structuredClone(r));});return structuredClone(r);},
   get:async(org,id)=>structuredClone(records.find(r=>r.organization_id===org&&r.id===id)||null),
   getByRequest:async(org,id)=>structuredClone(records.find(r=>r.organization_id===org&&r.request_id===id)||null),
   list:async(org,offset)=>{if(readFailure)throw Error('Offline');return structuredClone(records.filter(r=>r.organization_id===org).slice(offset,offset+50));},
   cancel:async(org,id)=>{cancellations++;const r=records.find(r=>r.id===id&&r.organization_id===org);r.status='cancelled';r.cancelled_at=now;r.cancelled_by='employee';return structuredClone(r);}
  }};
  const service=createEstimatedDraftService(backend),store=createDraftRecoveryStore(journal,'org','employee');
  const props={orgId:'org',userId:'employee',role:'employee',vendors:[{id:'v',name:'Supplier',organization_id:'org'}],vendorItems:[listing],mappings:[mapping],catalogItems:[{id:'ci',name:'Synthetic material'}],service,store,approvalService:{supported:true,list:async()=>{if(readFailure)throw Error('Offline');return approvalRows;}},onClose(){},makeRequestId:()=>`request-${records.length}-${writes}`};
  return {props,records,store,journal,get release(){return release;},get writes(){return writes;},get cancellations(){return cancellations;},set mode(v){mode=v;},set readFailure(v){readFailure=v;},set approvals(v){approvalRows=v;}};
 }
 let tree;async function mount(props){await act(async()=>{tree=Renderer.create(React.createElement(EstimatedPurchaseDrafts,props));});}
 const button=label=>tree.root.findAllByType('button').find(b=>text(b)===label);
 async function click(label){const b=button(label);assert.ok(b&&!b.props.disabled,label);await act(async()=>{await b.props.onClick();});}
 async function change(label,value){await act(async()=>{tree.root.findAllByType('input').concat(tree.root.findAllByType('select')).find(n=>n.props['aria-label']===label).props.onChange({target:{value,checked:!!value}});});}
 async function choose(){await change('Estimated draft vendor','v');await change('Cases for Synthetic material (SYN)','2');}
 let f=fixture();await mount(f.props);assert.equal(f.writes,0);await choose();assert.match(text(tree.toJSON()),/\$96.00–\$128.00/);assert.match(text(tree.toJSON()),/Final charge: unknown/);assert.equal(button('Save estimated draft').props.disabled,true);
 await change('Confirm saving estimated draft',true);await change('Cases for Synthetic material (SYN)','3');assert.equal(button('Save estimated draft').props.disabled,true,'quantity edit invalidates consent');await change('Cases for Synthetic material (SYN)','2');assert.equal(button('Save estimated draft').props.disabled,true);await change('Confirm saving estimated draft',true);
 await click('Save estimated draft');assert.equal(f.records.length,1);assert.equal(f.store.pending().length,0);assert.match(text(tree.toJSON()),/Draft saved/);assert.equal(f.records[0].final_charge,null);const template=structuredClone(f.records[0]);
 await click('Cancel saved draft');await click('Keep draft');assert.equal(f.cancellations,0);await click('Cancel saved draft');await click('Confirm cancellation');assert.equal(f.cancellations,1);assert.match(text(tree.toJSON()),/Cancelled draft/);tree.unmount();
 // Lost response after commit: closing/reopening retains the request and recovers the same draft.
 f=fixture();f.mode='network-after';await mount(f.props);await choose();await change('Confirm saving estimated draft',true);await click('Save estimated draft');assert.equal(f.records.length,1);assert.equal(f.store.pending().length,1);assert.match(text(tree.toJSON()),/save result is unknown/);tree.unmount();await mount(f.props);assert.ok(button('Check saved result'));assert.equal(button('Save estimated draft').props.disabled,true);await click('Check saved result');assert.equal(f.records.length,1);assert.equal(f.writes,1);assert.equal(f.store.pending().length,0);tree.unmount();
 // Lost request before commit: explicit retry retains exactly the original request ID.
 f=fixture();f.mode='network-before';await mount(f.props);await choose();await change('Confirm saving estimated draft',true);await click('Save estimated draft');const originalId=f.store.pending()[0].intent.requestId;await click('Check saved result');assert.equal(button('Retry same save').props.disabled,true);f.mode='ok';await change('Confirm retry of estimated draft',true);await click('Retry same save');assert.equal(f.records[0].request_id,originalId);assert.equal(f.records.length,1);tree.unmount();
 // Definitive transaction errors clear the pending journal without claiming a save.
 f=fixture();f.mode='sql';await mount(f.props);await choose();await change('Confirm saving estimated draft',true);await click('Save estimated draft');assert.equal(f.records.length,0);assert.equal(f.store.pending().length,0);assert.match(text(tree.toJSON()),/Source terms changed/);assert.equal(button('Save estimated draft').props.disabled,true);tree.unmount();
 // A new source rate invalidates the saved approval and consent.
 f=fixture();await mount(f.props);await choose();await change('Confirm saving estimated draft',true);await act(async()=>tree.update(React.createElement(EstimatedPurchaseDrafts,{...f.props,vendorItems:[{...listing,price:5}]})));assert.equal(button('Save estimated draft').props.disabled,true);assert.equal(f.writes,0);tree.unmount();
 // Local storage failure blocks sending an unrecoverable request.
 f=fixture();const broken=createDraftRecoveryStore({getItem(){return null;},setItem(){throw Error('quota');}},'org','employee');await mount({...f.props,store:broken});await choose();await change('Confirm saving estimated draft',true);await click('Save estimated draft');assert.equal(f.writes,0);assert.match(text(tree.toJSON()),/Cannot retain/);tree.unmount();
 // Offline reopening retains editable quantities and cached confirmations, but cannot save.
 f=fixture();await mount(f.props);await choose();tree.unmount();f.readFailure=true;await mount(f.props);assert.equal(tree.root.findByProps({'aria-label':'Cases for Synthetic material (SYN)'}).props.value,'2');assert.equal(button('Save estimated draft').props.disabled,true);assert.match(text(tree.toJSON()),/Local selections are retained/);tree.unmount();
 // A pending request created in another tab blocks this window before sending.
 f=fixture();await mount(f.props);await choose();await change('Confirm saving estimated draft',true);f.store.retain({kind:'estimated_purchase_draft_intent',version:1,organizationId:'org',vendorId:'v',requestId:'other-tab',lines:template.requested_lines,estimate:template.estimate,finalCharge:null});await click('Save estimated draft');assert.equal(f.writes,0);assert.ok(button('Check saved result'));tree.unmount();
 // A response from a closed organization window cannot populate another one.
 f=fixture();f.mode='deferred';await mount(f.props);await choose();await change('Confirm saving estimated draft',true);let inflight;await act(async()=>{inflight=button('Save estimated draft').props.onClick();await Promise.resolve();});assert.equal(f.store.pending().length,1);tree.unmount();const otherStore=createDraftRecoveryStore(f.journal,'other-org','employee');await mount({...f.props,orgId:'other-org',vendorItems:[],vendors:[],store:otherStore});await act(async()=>{f.release();await inflight;});assert.equal(otherStore.pending().length,0);assert.equal(f.store.pending().length,0);assert.ok(!text(tree.toJSON()).includes('Synthetic material'));assert.ok(!text(tree.toJSON()).includes('Draft saved.'));tree.unmount();
 // Saved browse pagination and employee cancellation boundaries.
 f=fixture();for(let i=0;i<51;i++)f.records.push({...structuredClone(template),id:'history-'+i,request_id:'history-request-'+i,created_by:'peer',lines:template.lines.map(l=>({...l,orderId:'history-'+i}))});await mount(f.props);await click('Saved drafts');assert.equal(tree.root.findAllByType('button').filter(b=>text(b)==='Open draft').length,50);await click('Load older drafts');assert.equal(tree.root.findAllByType('button').filter(b=>text(b)==='Open draft').length,51);await click('Open draft');assert.equal(button('Cancel saved draft'),undefined);assert.equal(f.cancellations,0);tree.unmount();
 // Source-ineligible items cannot be selected.
 f=fixture();f.approvals=[];await mount(f.props);await change('Estimated draft vendor','v');assert.equal(tree.root.findByProps({'aria-label':'Cases for Synthetic material (SYN)'}).props.disabled,true);tree.unmount();
 f=fixture();await mount({...f.props,role:'viewer'});assert.equal(tree.toJSON(),null);assert.equal(f.writes,0);tree.unmount();
 console.log('PASS rendered draft controls: range totals, consent/stale holds, save/reopen/cancel, scoped durable recovery, identical retry, definitive failure, offline edits and storage/role guards.');
}finally{rmSync(dir,{recursive:true,force:true});}
