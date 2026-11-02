import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
const dir=mkdtempSync(join(process.cwd(),'node_modules/.a2-selection-'));
try{
 const outfile=join(dir,'ui.mjs');
 await build({stdin:{contents:String.raw`
 import React from 'react';import Renderer,{act} from 'react-test-renderer';import assert from 'node:assert/strict';
 import VendorConnectPage from './src/pages/VendorConnectPage.jsx';import {createRecords} from './src/backend/records.js';
 const text=n=>typeof n==='string'?n:(n?.children||[]).map(text).join('');
 const events=new Set(),replies=[];const w={location:{origin:'https://kerdossoftareproject.github.io'},addEventListener:(_,fn)=>events.add(fn),removeEventListener:(_,fn)=>events.delete(fn),postMessage:msg=>replies.push(msg)};globalThis.window=w;
 const adapters=['one','two'].map(id=>({adapter_key:id,display_name:id,setup_available:true,execution_model:'local_browser',portal_origin:'https://supplier.example'}));
 const rows=[['a','v1','one'],['a','v2','one'],['a','v1','two'],['b','v3','one']].map(([organization_id,vendor_id,adapter_key],i)=>({id:'r'+i,organization_id,vendor_id,adapter_key,state:'setup_requested',transfer_revision:0,portal_account_label:null,portal_list_label:null}));
 const writes=[];let pauseSave=null,deny=false,shareRows=false;
 const backend={vendorConnect:{verifySelection:async input=>rows.some(r=>r.id===input.requestId&&r.organization_id===input.organizationId&&r.vendor_id===input.vendorId&&r.adapter_key===input.adapterKey&&r.transfer_revision===input.revision&&r.state==='setup_requested'&&r.portal_account_label===input.account&&r.portal_list_label===input.list&&input.portalOrigin==='https://supplier.example')},records:createRecords(async spec=>{if(spec.table==='vendor_connection_adapters')return {data:adapters};let matches=rows.filter(row=>spec.filters.every(f=>row[f.column]===f.value));if(spec.action==='update'){writes.push(spec);if(pauseSave)await pauseSave;if(deny)return {data:[]};matches.forEach(r=>{if(Object.entries(spec.value).some(([k,v])=>r[k]!==v))r.transfer_revision++;Object.assign(r,spec.value);});}return {data:matches.map(r=>shareRows?r:({...r}))};})};
 const props={backend,organizationId:'a',vendors:[{id:'v1',name:'First vendor'},{id:'v2',name:'Second vendor'}],role:'owner',onCompanionImport:()=>{}};let tree;
 const control=label=>tree.root.findByProps({'aria-label':label});const button=label=>tree.root.findAllByType('button').find(n=>text(n)===label);
 async function mount(p=props){await act(async()=>{tree=Renderer.create(React.createElement(VendorConnectPage,p));});}
 async function choose(v='v1',a='one'){await act(async()=>{control('Vendor account vendor').props.onChange({target:{value:v}});control('Connection provider').props.onChange({target:{value:a}});});}
 async function fill(account,list){await act(async()=>{control('Portal account name').props.onChange({target:{value:account}});control('Portal list name').props.onChange({target:{value:list}});});}
 await mount();await choose();await fill('First account','First list');await choose('v2');
 assert.equal(control('Portal account name').props.value,'','vendor switch must not carry another account');assert.equal(control('Portal list name').props.value,'');
 await choose();await fill('  First account  ',' First list ');await act(async()=>{await button('Prepare browser transfer').props.onClick();});
 assert.equal(events.size,1);assert.deepEqual(writes.at(-1).value,{portal_account_label:'First account',portal_list_label:'First list'});
 assert.equal(rows[0].portal_account_label,'First account');assert.deepEqual(writes.at(-1).filters.map(f=>[f.column,f.value]),[['organization_id','a'],['vendor_id','v1'],['adapter_key','one'],['id','r0'],['state','setup_requested']]);
 await act(async()=>tree.unmount());assert.equal(events.size,0);await mount();await choose();assert.equal(control('Portal account name').props.value,'First account');assert.equal(control('Portal list name').props.value,'First list');
 await choose('v1','two');assert.equal(control('Portal account name').props.value,'');assert.equal(control('Portal list name').props.value,'');
 const b={...props,organizationId:'b',vendors:[{id:'v3',name:'Other client vendor'}]};await act(async()=>tree.update(React.createElement(VendorConnectPage,b)));await choose('v3');assert.equal(control('Portal account name').props.value,'');await fill('Other account','Other list');await act(async()=>{await button('Prepare browser transfer').props.onClick();});assert.equal(rows[3].portal_account_label,'Other account');assert.equal(rows[0].portal_account_label,'First account');
 await act(async()=>tree.update(React.createElement(VendorConnectPage,props)));await choose();assert.equal(control('Portal account name').props.value,'First account');assert.doesNotMatch(text(tree.toJSON()),/Other account/);
 // A context change during the save may remember the old explicit selection,
 // but cannot create a ticket or expose the old result in the next workspace.
 let release;pauseSave=new Promise(resolve=>{release=resolve;});let pending;
 await fill('Pending old account','Pending old list');await act(async()=>{pending=button('Prepare browser transfer').props.onClick();await Promise.resolve();});assert.equal(events.size,0);
 await act(async()=>tree.update(React.createElement(VendorConnectPage,b)));await choose('v3');await act(async()=>{release();await pending;});pauseSave=null;assert.equal(events.size,0);assert.equal(control('Portal account name').props.value,'Other account');assert.doesNotMatch(text(tree.toJSON()),/Transfer ready|Pending old/);

 // Editing while persistence is pending invalidates the captured transfer.
 pauseSave=new Promise(resolve=>{release=resolve;});await act(async()=>{pending=button('Prepare browser transfer').props.onClick();await Promise.resolve();});await fill('Edited account','Edited list');await act(async()=>{release();await pending;});pauseSave=null;assert.equal(events.size,0);assert.equal(control('Portal account name').props.value,'Edited account');assert.equal(button('Prepare browser transfer').props.disabled,false);
 shareRows=true; // Some local providers return live row objects; old ticket bindings must still be immutable.
 await act(async()=>{await button('Prepare browser transfer').props.onClick();});assert.equal(events.size,1);
 for(const fn of [...events])await act(async()=>fn({source:w,origin:w.location.origin,data:{channel:'kerdos-companion-v1',requestId:'selection-pair',type:'pair'}}));assert.equal(replies.at(-1).ticket.account,'Edited account');assert.equal(replies.at(-1).ticket.list,'Edited list');
 // Another tab cancels and reopens the same setup without changing our page's cached labels.
 const staleTicket=replies.at(-1).ticket;rows[3].state='cancelled';rows[3].transfer_revision++;rows[3].state='setup_requested';rows[3].transfer_revision++;
 for(const fn of [...events])await act(async()=>fn({source:w,origin:w.location.origin,data:{channel:'kerdos-companion-v1',requestId:'stale-export',type:'claim',nonce:staleTicket.nonce,claimId:crypto.randomUUID()}}));
 assert.equal(replies.at(-1).ok,false);assert.match(text(tree.toJSON()),/Browser transfer was not accepted/);assert.equal(button('Cancel browser transfer'),undefined);
 await act(async()=>{await button('Prepare browser transfer').props.onClick();});assert.equal(events.size,1);
 await act(async()=>button('Cancel browser transfer').props.onClick());deny=true;await act(async()=>{await button('Prepare browser transfer').props.onClick();});assert.equal(events.size,0);assert.equal(button('Cancel browser transfer'),undefined);deny=false;
 pauseSave=new Promise(resolve=>{release=resolve;});await act(async()=>{pending=button('Prepare browser transfer').props.onClick();await Promise.resolve();});await act(async()=>tree.unmount());await act(async()=>{release();await pending;});assert.equal(events.size,0);delete globalThis.window;
 console.log('PASS connection selections: vendor/provider/client isolation, remount persistence, strict save scope, pending context/edit cancellation, saved ticket labels, rejection and unmount fencing; controlled persistence only');
 `,resolveDir:process.cwd(),loader:'jsx'},outfile,bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic'});
 process.stdout.write(execFileSync(process.execPath,[outfile],{encoding:'utf8',timeout:30000}));
}finally{rmSync(dir,{recursive:true,force:true});}
