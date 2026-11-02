import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
const dir=mkdtempSync(join(process.cwd(),'node_modules/.association-ui-'));
try{
 const outfile=join(dir,'ui.mjs');
 await build({stdin:{contents:String.raw`
 import React from 'react';import Renderer,{act} from 'react-test-renderer';import assert from 'node:assert/strict';
 import {ProductAssociationTrial} from './src/pages/ProductAssociationTrial.jsx';import {configureProcurement} from './src/procurement.js';
 configureProcurement({industry:'restaurant'});const text=n=>typeof n==='string'?n:(n?.children||[]).map(text).join('');
 const calls=[],history=[];let loseReply=true,refreshes=0;
 const provider={catalog:{productGroupHistory:async()=>history,associateProductGroup:async request=>{calls.push(request);if(loseReply){loseReply=false;throw new Error('Reply lost; retry this save');}history.push({request_id:request.requestId,created_at:new Date().toISOString(),payload:{name:request.name},result:{associated:2}});return {};},restoreProductGroup:async request=>calls.push({restore:request})}};
 const vendorItems=['DRESS HONEY MUSTARD','HONEY MUSTRD DRESSING'].map((description,i)=>({id:'v'+i,vendor_id:'vendor'+i,description,pack_size:i?'4/3 L':'4/1 GAL',brand:'Brand'+i,price:20,row_revision:i,field_resolutions:{}}));
 const catalogItems=vendorItems.map((v,i)=>({id:'c'+i,name:v.description,master_item_number:100+i,comparison_mode:'alternatives'}));
 const mappings=vendorItems.map((v,i)=>({id:'m'+i,vendor_item_id:v.id,catalog_item_id:'c'+i}));
 const props={industry:'restaurant',orgId:'org',vendorItems,catalogItems,mappings,vendors:vendorItems.map(v=>({id:v.vendor_id,name:v.vendor_id})),onUpdated:async()=>{refreshes++;},provider,canManage:true};
 let tree;await act(async()=>{tree=Renderer.create(React.createElement(ProductAssociationTrial,props));});
 const button=label=>tree.root.findAllByType('button').find(n=>text(n)===label);
 assert.ok(button('Hide product groups'));assert.equal(calls.length,0);
 assert.match(text(tree.toJSON()),/2 listings · 1 proposed groups/);assert.match(text(tree.toJSON()),/4\/3 L/);assert.equal(calls.length,0);
 await act(async()=>await button('Confirm this product identity').props.onClick());assert.match(text(tree.toJSON()),/Reply lost/);assert.ok(button('Retry same group save'));
 await act(async()=>await button('Retry same group save').props.onClick());assert.equal(calls.length,2);assert.deepEqual(calls[0],calls[1],'lost-reply retry uses exactly the same identity and source snapshot');assert.equal(refreshes,1);
 assert.equal(calls[0].members[1].revision,1);assert.equal(Object.hasOwn(calls[0],'price'),false);
 await act(async()=>await button('Restore previous associations').props.onClick());assert.equal(calls.at(-1).restore.organizationId,'org');assert.equal(refreshes,2);
 await act(async()=>tree.root.findByProps({'aria-label':'Search proposed groups'}).props.onChange({target:{value:'no matching product'}}));assert.equal(button('Confirm this product identity'),undefined);
 await act(async()=>tree.root.findByProps({'aria-label':'Search proposed groups'}).props.onChange({target:{value:''}}));await act(async()=>await button('Apply product groups to catalog').props.onClick());assert.equal(calls.at(-1).confirmed,false,'bulk grouping cannot pretend identity was client-confirmed');await act(async()=>tree.update(React.createElement(ProductAssociationTrial,{...props,canManage:false})));assert.equal(button('Apply product groups to catalog'),undefined);assert.equal(button('Confirm this product identity'),undefined);await act(async()=>tree.unmount());console.log('PASS rendered association trial: read-only opening, full group details, independent packs, exact lost-reply retry, saved history, restore and search.');
 `,resolveDir:process.cwd(),sourcefile:'association-ui-test.mjs',loader:'js'},outfile,bundle:true,platform:'node',format:'esm',jsx:'automatic',external:['react','react-test-renderer'],logLevel:'silent'});
 process.stdout.write(execFileSync(process.execPath,[outfile],{encoding:'utf8',env:process.env}));
}finally{rmSync(dir,{recursive:true,force:true});}
