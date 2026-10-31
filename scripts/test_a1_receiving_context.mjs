import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFileSync} from 'node:child_process';
import {build} from 'esbuild';
const dir=mkdtempSync(join(tmpdir(),'a1-receiving-context-'));
try{
 const backend=join(dir,'backend.mjs');
 writeFileSync(backend,`import {createRecords} from '${fileURLToPath(new URL('../src/backend/records.js',import.meta.url))}';
 export const backend={records:createRecords(async spec=>{globalThis.__calls.push(spec);let rows=globalThis.__rows;for(const f of spec.filters)rows=rows.filter(row=>row[f.column]===f.value);return {data:rows,error:null};})};`);
 const source=`
 import assert from 'node:assert/strict';import React from 'react';import Renderer,{act} from 'react-test-renderer';
 import {ReceivingAddressesPanel} from './src/pages/ReceivingAddresses.jsx';
 import {InvoicesPage,PriceSheetsPage} from './src/pages/DocumentPages.jsx';
 globalThis.__calls=[];globalThis.__rows=[
 {id:'p',organization_id:'org',vendor_id:'v',document_type:'pricelist',routing_address:'client.vendor@prices.example.us',is_automatic:true,is_active:true},
 {id:'i',organization_id:'org',vendor_id:'v',document_type:'invoice',routing_address:'client.vendor@invoices.example.com',is_automatic:true,is_active:true},
 {id:'foreign',organization_id:'other',vendor_id:'v',document_type:'invoice',routing_address:'foreign.vendor@invoices.example.com',is_automatic:true,is_active:true}];
 const vendors=[{id:'v',name:'Vendor'}];let root;let passed=0;
 async function test(name,fn){await fn();passed++;console.log('PASS '+name);}
 async function mount(Component,props){await act(async()=>{root=Renderer.create(React.createElement(Component,props));});}
 await test('Invoice tab opens without configuration panels or address requests',async()=>{
  const before=globalThis.__calls.length;
  await mount(InvoicesPage,{orgId:'org',vendors,invoices:[],vendorColors:new Map(),formatDate:x=>x,formatMoney:x=>x});
  assert.equal(root.root.findAllByType(ReceivingAddressesPanel).length,0);
  assert.ok(!JSON.stringify(root.toJSON()).includes('Automatic email receiving'));
  assert.ok(!JSON.stringify(root.toJSON()).includes('Invoice History'));
  assert.equal(root.root.findAllByProps({'aria-label':'Invoice browse controls'}).length,1);
  assert.equal(globalThis.__calls.length,before);
  await act(async()=>root.unmount());
 });
 await test('Price Sheets opens directly to browsing without configuration panels or address requests',async()=>{
  const before=globalThis.__calls.length;
  await mount(PriceSheetsPage,{orgId:'org',vendors,importDocuments:[],vendorColors:new Map(),formatDate:x=>x});
  assert.equal(root.root.findAllByType(ReceivingAddressesPanel).length,0);
  assert.ok(!JSON.stringify(root.toJSON()).includes('Automatic email receiving'));
  assert.ok(!JSON.stringify(root.toJSON()).includes('Price Sheet History'));
  assert.equal(root.root.findAllByProps({'aria-label':'Price sheet browse controls'}).length,1);
  assert.equal(globalThis.__calls.length,before);
  await act(async()=>root.unmount());
 });
 await test('receiving-address component still isolates document types when used elsewhere',async()=>{
  await mount(ReceivingAddressesPanel,{orgId:'org',vendors,documentType:'invoice'});
  assert.ok(JSON.stringify(root.toJSON()).includes('client.vendor@invoices.example.com'));
  assert.ok(!JSON.stringify(root.toJSON()).includes('client.vendor@prices.example.us'));
  assert.ok(!JSON.stringify(root.toJSON()).includes('foreign.vendor'));
  await act(async()=>root.unmount());
  await mount(ReceivingAddressesPanel,{orgId:'org',vendors,documentType:'pricelist'});
  assert.ok(JSON.stringify(root.toJSON()).includes('client.vendor@prices.example.us'));
  assert.ok(!JSON.stringify(root.toJSON()).includes('client.vendor@invoices.example.com'));
  await act(async()=>root.unmount());
 });
 await test('receiving-address component has no add-address, vendor assignment, type selection or save controls',async()=>{
  await mount(ReceivingAddressesPanel,{orgId:'org',vendors});
  assert.equal(root.root.findAllByType('select').length,0);assert.equal(root.root.findAllByType('input').length,0);
  const labels=root.root.findAllByType('button').map(x=>x.props['aria-label']);assert.ok(labels.every(x=>x.startsWith('Copy ')));
  assert.ok(!JSON.stringify(root.toJSON()).includes('foreign.vendor'));
  await act(async()=>root.unmount());
 });
 await test('missing operator domains are visible without inventing a receiving address or requesting client setup',async()=>{
  globalThis.__rows=[];await mount(ReceivingAddressesPanel,{orgId:'org',vendors});
  assert.ok(JSON.stringify(root.toJSON()).includes('No client setup is required'));
  assert.equal(root.root.findAllByType('button').length,0);await act(async()=>root.unmount());
 });
 assert.ok(globalThis.__calls.length>0&&globalThis.__calls.every(x=>x.action==='select'));
 console.log(passed+'/'+passed+' rendered receiving-context checks passed; zero registration writes from client.');process.exit(0);
 `;
 const out=join(dir,'test.mjs');
 await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'jsx'},outfile:out,bundle:true,platform:'node',format:'esm',jsx:'automatic',plugins:[{name:'fake-backend',setup(b){b.onResolve({filter:/backend\/index\.js$/},()=>({path:backend}));}}],logLevel:'silent'});
 process.stdout.write(execFileSync(process.execPath,[out],{timeout:20000,encoding:'utf8'}));
}finally{rmSync(dir,{recursive:true,force:true});}
