import assert from 'node:assert/strict';
import {build} from 'vite';
import {mkdtempSync,rmSync,writeFileSync} from 'node:fs';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {join} from 'node:path';
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import {reconciliationFixture} from '../core/fixtures/invoice-reconciliation.mjs';
import {reconcileInvoice} from '../core/invoice-reconciliation.js';
import {createInvoiceReconciliationService} from '../services/invoice-reconciliation.js';
const dir=mkdtempSync(fileURLToPath(new URL('../../node_modules/.kerdos-invoice-reconciliation-',import.meta.url))),scope={organizationId:'org',invoiceId:'i'};
const text=n=>typeof n==='string'?n:Array.isArray(n)?n.map(text).join(''):(n?.children||[]).map(text).join('');
try{
 const entry=join(dir,'entry.jsx');writeFileSync(entry,`export {InvoiceReconciliation} from ${JSON.stringify(fileURLToPath(new URL('./InvoiceReconciliation.jsx',import.meta.url)))};export {InvoicesPage} from ${JSON.stringify(fileURLToPath(new URL('./DocumentPages.jsx',import.meta.url)))};`);
 await build({configFile:false,logLevel:'error',esbuild:{jsx:'automatic'},build:{ssr:entry,outDir:join(dir,'out'),rollupOptions:{output:{entryFileNames:'review.mjs'}}}});
 const {InvoiceReconciliation,InvoicesPage}=await import(pathToFileURL(join(dir,'out/review.mjs')));
 let source=reconciliationFixture(),calls=0,offline=false,closed=0;
 const service=createInvoiceReconciliationService({session:{get:async()=>({user:{id:'owner'}})},invoiceReconciliation:{review:async()=>{calls++;if(offline)throw Error('Offline');return structuredClone(source);}}});
 let tree;const button=label=>tree.root.findAllByType('button').find(n=>text(n)===label);
 await act(async()=>{tree=Renderer.create(React.createElement(InvoiceReconciliation,{...scope,service,approvalService:{supported:false},onClose:()=>closed++}));});
 assert.equal(calls,1);assert.match(text(tree.toJSON()),/Reconciled amounts and receipt links/);assert.match(text(tree.toJSON()),/\$63.00/);assert.match(text(tree.toJSON()),/Credits 3.00/);assert.match(text(tree.toJSON()),/Payment status is not recorded/);
 source.receipts=[];source.header.recordedTotal=56;await act(async()=>{await button('Refresh reconciliation').props.onClick();});assert.match(text(tree.toJSON()),/Needs review/);assert.match(text(tree.toJSON()),/Unlinked — needs review/);assert.match(text(tree.toJSON()),/Recorded invoice total differs/);
 offline=true;await act(async()=>{await button('Refresh reconciliation').props.onClick();});assert.match(text(tree.toJSON()),/Offline/);assert.doesNotMatch(text(tree.toJSON()),/Reconciled amounts and receipt links/);offline=false;await act(async()=>{await button('Refresh reconciliation').props.onClick();});assert.doesNotMatch(text(tree.toJSON()),/Offline/);await act(async()=>{button('Close reconciliation').props.onClick();});assert.equal(closed,1);tree.unmount();
 // Late data for a previous invoice cannot replace a newer result.
 const pending=[];const delayed={supported:true,review:()=>new Promise(resolve=>pending.push(resolve))};
 await act(async()=>{tree=Renderer.create(React.createElement(InvoiceReconciliation,{...scope,service:delayed,approvalService:{supported:false}}));});
 await act(async()=>{tree.update(React.createElement(InvoiceReconciliation,{...scope,invoiceId:'j',service:delayed}));});
 const current=reconcileInvoice(reconciliationFixture(),scope);await act(async()=>{pending[1]({...current,issues:['Current invoice evidence']});});await act(async()=>{pending[0]({...current,issues:['Stale invoice evidence']});});assert.match(text(tree.toJSON()),/Current invoice evidence/);assert.doesNotMatch(text(tree.toJSON()),/Stale invoice evidence/);tree.unmount();
 // Invoices with retained files expose reconciliation without changing original-file behavior.
 source=reconciliationFixture();let originals=0;const before=calls;
 const props={orgId:'org',vendors:[{id:'v',name:'Synthetic vendor'}],invoices:[{id:'i',vendor_id:'v',invoice_number:'I-1',file_name:'original.pdf',file_path:'source.pdf',invoice_date:'2026-11-01',invoice_lines:[]}],vendorFilter:'v',setVendorFilter:()=>{},vendorColors:new Map(),formatDate:x=>x,formatMoney:String,role:'employee',onViewOriginal:()=>originals++,reconciliationService:service,approvalService:{supported:false}};
 await act(async()=>{tree=Renderer.create(React.createElement(InvoicesPage,props));});assert.equal(calls,before);await act(async()=>{tree.root.findByProps({'aria-label':'Reconcile invoice I-1'}).props.onClick({stopPropagation(){}});});assert.equal(calls,before+1);assert.match(text(tree.toJSON()),/Reconciled amounts and receipt links/);await act(async()=>{tree.root.findByProps({title:'Open original invoice'}).props.onClick({stopPropagation(){}});});assert.equal(originals,1);assert.equal(tree.root.findAllByProps({title:'Delete invoice'}).length,0);tree.unmount();
 console.log('PASS invoice reconciliation UI: full summary/line/evidence review, mismatch and unlinked states, read-only employee access, refresh errors/recovery, stale response isolation, explicit route opening and original-file preservation.');
}finally{rmSync(dir,{recursive:true,force:true});}
