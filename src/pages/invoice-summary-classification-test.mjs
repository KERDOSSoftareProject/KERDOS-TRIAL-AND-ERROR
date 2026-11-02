import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import {reconciliationFixture} from '../core/fixtures/invoice-reconciliation.mjs';
import {classifyInvoiceSummary} from '../core/invoice-summary-classification.js';
import {createSummaryClassificationService} from '../services/invoice-summary-classification.js';
const dir=mkdtempSync(fileURLToPath(new URL('../../node_modules/.kerdos-summary-',import.meta.url))),scope={organizationId:'org',invoiceId:'i'};
const text=n=>typeof n==='string'?n:Array.isArray(n)?n.map(text).join(''):(n?.children||[]).map(text).join('');
try{
 const entry=join(dir,'entry.jsx');writeFileSync(entry,`export {InvoiceSummaryClassification} from ${JSON.stringify(fileURLToPath(new URL('./InvoiceSummaryClassification.jsx',import.meta.url)))};`);
 await build({configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},build:{ssr:entry,outDir:join(dir,'out'),rollupOptions:{output:{entryFileNames:'summary.mjs'}}}});
 const {InvoiceSummaryClassification}=await import(pathToFileURL(join(dir,'out/summary.mjs')));
 let source=reconciliationFixture(),history=[],canClassify=true,writes=0,updated=0,mode='',readsFail=false;
 source.header.rawText='Subtotal 56.00\nTax 2.00\nTransportation 8.00\nCredits 3.00\nInvoice Total 63.00';
 const requests=new Map(),inputs=[];
 const backend={session:{get:async()=>({user:{id:'owner'}})},invoiceSummaryClassification:{
  review:async()=>{if(readsFail)throw Error('History unavailable');return structuredClone({source,history,canClassify});},
  save:async p=>{writes++;inputs.push(structuredClone(p));if(mode==='lost-request'){mode='';throw Error('Response unknown');}if(mode==='sql-rejection'){mode='';throw Object.assign(Error('Source changed'),{cause:{code:'P0001'}});}
   const r=p.review;let saved=requests.get(p.requestId);
   if(!saved){saved={kind:'invoice_summary_classification',version:1,id:'classification-'+(history.length+1),organizationId:r.organizationId,invoiceId:r.invoiceId,requestId:p.requestId,revision:history.length+1,previousId:history.at(-1)?.id??null,basis:r.basis,mappings:r.mappings,classifiedText:classifyInvoiceSummary(r.basis,r.mappings),reason:r.reason,recordedBy:'owner',recordedAt:new Date().toISOString()};requests.set(p.requestId,saved);history.push(saved);source={...source,summaryClassification:saved};}
   if(mode==='lost-response'){mode='';throw Error('Response unknown');}if(mode==='history-after-write'){mode='';readsFail=true;}return structuredClone(saved);
  }
 }};
 const service=createSummaryClassificationService(backend);let tree;
 const button=label=>tree.root.findAllByType('button').find(n=>text(n)===label);
 const input=label=>tree.root.findByProps({'aria-label':label});
 async function change(label,value){await act(async()=>{input(label).props.onChange({target:typeof value==='boolean'?{checked:value}:{value}});});}
 async function click(label){await act(async()=>{await button(label).props.onClick();});}
 async function mount(){await act(async()=>{tree=Renderer.create(React.createElement(InvoiceSummaryClassification,{...scope,service,onUpdated:()=>updated++}));});}
 async function plan(){await change('Summary source line number','3');await change('Summary source category','freight');await click('Classify selected source line');await change('Summary classification reason','Transportation is the stated delivery charge');await click('Review summary classification');}
 await mount();assert.equal(writes,0);await plan();assert.match(text(tree.toJSON()),/Freight 8.00/);assert.equal(button('Save confirmed summary classification').props.disabled,true);await change('Confirm retained summary classification',true);await change('Summary classification reason','Changed classification reason');assert.equal(button('Save confirmed summary classification'),undefined);await click('Review summary classification');await change('Confirm retained summary classification',true);await click('Save confirmed summary classification');assert.equal(writes,1);assert.equal(updated,1);assert.match(text(tree.toJSON()),/Summary classification history/);assert.match(text(tree.toJSON()),/Revision 1/);assert.match(source.header.rawText,/Transportation 8.00/);tree.unmount();
 // Remount retains saved audit, not a newly invented source or automatic write.
 await mount();assert.equal(writes,1);assert.match(text(tree.toJSON()),/Revision 1/);await change('Summary source line number','1');await change('Summary source category','tax');await click('Classify selected source line');assert.equal(writes,1);tree.unmount();
 for(const failure of ['lost-request','lost-response','history-after-write']){
  await mount();await plan();mode=failure;await change('Confirm retained summary classification',true);await click('Save confirmed summary classification');assert.match(text(tree.toJSON()),/Retry same summary classification/);assert.equal(input('Summary classification reason').props.disabled,true);const original=inputs.at(-1);readsFail=false;
  await change('Confirm retained summary classification',true);await click('Retry same summary classification');assert.deepEqual(inputs.at(-1),original);assert.doesNotMatch(text(tree.toJSON()),/Retry same summary classification/);tree.unmount();
 }
 await mount();await plan();mode='sql-rejection';await change('Confirm retained summary classification',true);await click('Save confirmed summary classification');assert.equal(button('Retry same summary classification'),undefined);assert.equal(input('Summary classification reason').props.disabled,false);tree.unmount();
 canClassify=false;await mount();assert.match(text(tree.toJSON()),/owner or manager must/);assert.equal(tree.root.findAllByProps({'aria-label':'Summary classification reason'}).length,0);tree.unmount();
 const delayed=[];const waiting={supported:true,review:()=>new Promise(resolve=>delayed.push(resolve))};await act(async()=>{tree=Renderer.create(React.createElement(InvoiceSummaryClassification,{...scope,service:waiting}));});await act(async()=>{tree.update(React.createElement(InvoiceSummaryClassification,{...scope,invoiceId:'new',service:waiting}));});await act(async()=>delayed[1]({source:{...source,header:{rawText:'Current invoice'}},history:[],canClassify:false}));await act(async()=>delayed[0]({source:{...source,header:{rawText:'Stale invoice'}},history:[],canClassify:false}));assert.match(text(tree.toJSON()),/Current invoice/);assert.doesNotMatch(text(tree.toJSON()),/Stale invoice/);tree.unmount();
 console.log('PASS summary classification rendered UI: source/category preview, reason invalidation, consent, no read writes, immutable source/history/remount, lost request/response, exact retry, history failure, known SQL rollback, role gating and stale-response isolation.');
}finally{rmSync(dir,{recursive:true,force:true});}
