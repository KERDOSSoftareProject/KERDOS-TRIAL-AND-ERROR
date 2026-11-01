import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
const dir=mkdtempSync(join(process.cwd(),'node_modules/.a2-connect-'));
try{
 const outfile=join(dir,'ui.mjs');
 await build({stdin:{contents:`
 import React from 'react';
 import Renderer,{act} from 'react-test-renderer';
 import assert from 'node:assert/strict';
 import VendorConnectPage from './src/pages/VendorConnectPage.jsx';
 import {createRecords} from './src/backend/records.js';
 import {createSupabaseBackend} from './src/backend/supabase.js';
 const text=n=>typeof n==='string'?n:(n?.children||[]).map(text).join('');
 const adapters=[{adapter_key:'provider',display_name:'Test provider',setup_available:true}];
 const rows=[];const writes=[];
 const backend={records:createRecords(async spec=>{
  if(spec.table==='vendor_connection_adapters')return {data:adapters};
  const org=spec.filters.find(f=>f.column==='organization_id')?.value;
  if(spec.action==='update'){const r=rows.find(r=>r.organization_id===org&&r.id===spec.filters.find(f=>f.column==='id').value);if(!r)return {data:[]};r.state='cancelled';return {data:[{id:r.id}]};}
  return {data:rows.filter(r=>r.organization_id===org).map(r=>({...r}))};
 }),vendorConnect:{request:async args=>{writes.push(args);const r=rows.find(r=>r.organization_id===args.organizationId);if(r)r.state='setup_requested';else rows.push({id:'request',organization_id:args.organizationId,vendor_id:args.vendorId,adapter_key:args.adapterKey,state:'setup_requested'});return 'request';}}};
 const props={backend,organizationId:'org-a',vendors:[{id:'vendor-a',name:'Client vendor'}],role:'owner'};
 let tree;
 await act(async()=>{tree=Renderer.create(React.createElement(VendorConnectPage,props));});
 assert.match(text(tree.toJSON()),/does not sign in or retrieve pricing/);
 assert.equal(tree.root.findAll(n=>n.type==='input'&&n.props.type==='password').length,0);
 await act(async()=>{tree.root.findByProps({'aria-label':'Vendor account vendor'}).props.onChange({target:{value:'vendor-a'}});tree.root.findByProps({'aria-label':'Connection provider'}).props.onChange({target:{value:'provider'}});});
 const button=label=>tree.root.findAllByType('button').find(n=>text(n)===label);
 await act(async()=>{await button('Prepare connection').props.onClick();});
 assert.deepEqual(writes,[{organizationId:'org-a',vendorId:'vendor-a',adapterKey:'provider'}]);
 assert.match(text(tree.toJSON()),/Account access is not active/);
 assert.equal(button('Prepare connection').props.disabled,true);
 await act(async()=>{await button('Cancel setup').props.onClick();});
 assert.match(text(tree.toJSON()),/Setup cancelled/);assert.equal(button('Prepare connection').props.disabled,false);
 await act(async()=>{await button('Prepare connection').props.onClick();});assert.equal(rows.length,1);
 await act(async()=>{tree.update(React.createElement(VendorConnectPage,{...props,organizationId:'org-b',vendors:[{id:'vendor-b',name:'Second client vendor'}]}));});
 assert.ok(!text(tree.toJSON()).includes('Client vendor'));assert.equal(tree.root.findByProps({'aria-label':'Vendor account vendor'}).props.value,'');
 await act(async()=>{tree.update(React.createElement(VendorConnectPage,{...props,role:'employee'}));});
 assert.equal(tree.root.findAllByType('button').length,0);assert.match(text(tree.toJSON()),/Owner or manager access/);tree.unmount();
 // Render the pilot pairing action and prove selection changes revoke its nonce.
 const events=new Set(),replies=[];
 const appWindow={location:{origin:'https://kerdossoftareproject.github.io'},addEventListener:(_,fn)=>events.add(fn),removeEventListener:(_,fn)=>events.delete(fn),postMessage:msg=>replies.push(msg)};
 globalThis.window=appWindow;
 const pilotAdapter={adapter_key:'us-foods-moxe',display_name:'MOXe',setup_available:true,execution_model:'local_browser',portal_origin:'https://order.usfoods.com'};
 const pilotBackend={records:createRecords(async spec=>({data:spec.table==='vendor_connection_adapters'?[pilotAdapter]:[{id:'pilot',organization_id:'org-a',vendor_id:'vendor-a',adapter_key:'us-foods-moxe',state:'setup_requested'}]}))};
 const accepted=[];let blocked=0;
 await act(async()=>{tree=Renderer.create(React.createElement(VendorConnectPage,{...props,backend:pilotBackend,onCompanionImport:payload=>accepted.push(payload)}));});
 await act(async()=>{tree.root.findByProps({'aria-label':'Vendor account vendor'}).props.onChange({target:{value:'vendor-a'}});tree.root.findByProps({'aria-label':'Connection provider'}).props.onChange({target:{value:'us-foods-moxe'}});});
 await act(async()=>{tree.root.findByProps({'aria-label':'Portal account name'}).props.onChange({target:{value:'Sample Client'}});tree.root.findByProps({'aria-label':'Portal list name'}).props.onChange({target:{value:'Example List'}});});
 await act(async()=>{button('Prepare browser transfer').props.onClick();});assert.equal(events.size,1);
 const send=async msg=>{for(const fn of [...events])await fn({source:appWindow,origin:appWindow.location.origin,data:{channel:'kerdos-companion-v1',requestId:'ui-test',...msg}});};
 await act(async()=>{await send({type:'pair'});});const nonce=replies.at(-1).ticket.nonce;
 await act(async()=>{tree.root.findByProps({'aria-label':'Portal list name'}).props.onChange({target:{value:'Changed List'}});});assert.equal(events.size,0);
 await act(async()=>{await send({type:'deliver',nonce,artifact:{origin:'https://order.usfoods.com',base64:btoa('Code,Price\\nA,1\\n')}});});assert.equal(accepted.length,0);
 await act(async()=>{button('Prepare browser transfer').props.onClick();});
 // A rerender must use the latest app callback, not stale modal/tenant state.
 await act(async()=>{tree.update(React.createElement(VendorConnectPage,{...props,backend:pilotBackend,onCompanionImport:()=>{blocked++;throw new Error('another import is open');}}));});
 await act(async()=>{await send({type:'pair'});});const currentNonce=replies.at(-1).ticket.nonce;
 await act(async()=>{await send({type:'deliver',nonce:currentNonce,artifact:{origin:'https://order.usfoods.com',base64:btoa('Code,Price\\nA,1\\n')}});});assert.equal(replies.at(-1).ok,false);assert.equal(accepted.length,0);assert.equal(blocked,1);
 await act(async()=>{tree.unmount();});assert.equal(events.size,0);delete globalThis.window;
 console.log('PASS rendered pilot arming, selected-list invalidation, latest callback guard and unmount cleanup');
 const missing={records:createRecords(async()=>({error:{code:'42P01',message:'internal secret backend diagnostics'}}))};
 await act(async()=>{tree=Renderer.create(React.createElement(VendorConnectPage,{...props,backend:missing}));});
 assert.match(text(tree.toJSON()),/not available in this environment/);assert.ok(!text(tree.toJSON()).includes('secret'));assert.equal(tree.root.findAllByType('select').length,0);tree.unmount();
 // Verify the real provider forwards only safe identifiers to the new RPC.
 globalThis.window={localStorage:{removeItem(){}},sessionStorage:{}};
 let rpcCall;
 const sdk={rpc:async(name,args)=>{rpcCall={name,args};return {data:'request-id'};}};
 const provider=createSupabaseBackend({url:'https://example.supabase.co',anonKey:'public-test'},()=>sdk);
 await provider.vendorConnect.request({organizationId:'org',vendorId:'vendor',adapterKey:'provider'});
 assert.deepEqual(rpcCall,{name:'kerdos_request_vendor_connection',args:{p_organization_id:'org',p_vendor_id:'vendor',p_adapter_key:'provider'}});
 console.log('PASS rendered Vendor Connect setup, cancel/restart, client switch, role guard and unavailable-schema behavior');
 console.log('PASS provider forwards enrollment identifiers without credentials or client-supplied connection status');
 `,resolveDir:process.cwd(),loader:'jsx'},bundle:true,platform:'node',format:'esm',packages:'external',jsx:'automatic',outfile});
 execFileSync(process.execPath,[outfile],{stdio:'inherit'});
}finally{rmSync(dir,{recursive:true,force:true});}
