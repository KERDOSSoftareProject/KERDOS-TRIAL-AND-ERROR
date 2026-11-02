import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
const dir=mkdtempSync(join(process.cwd(),'node_modules/.catalog-header-'));
try{
 const outfile=join(dir,'panel.mjs');
 await build({entryPoints:['src/pages/ItemCatalogPanel.jsx'],outfile,bundle:true,platform:'node',format:'esm',jsx:'automatic',external:['react','react-dom','react-test-renderer'],plugins:[{name:'dialog-shell',setup(b){b.onResolve({filter:/ui\/MovableDialog\.jsx$/},()=>({path:'dialog',namespace:'dialog-shell'}));b.onLoad({filter:/.*/,namespace:'dialog-shell'},()=>({contents:"import React from 'react';export function MovableDialog({children,label}){return React.createElement('section',{role:'dialog','aria-label':label},children);}",loader:'js'}));}}],logLevel:'silent'});
 const runner=join(dir,'run.mjs');
 writeFileSync(runner,String.raw`
import React from 'react';import Renderer,{act} from 'react-test-renderer';import assert from 'node:assert/strict';
const writes=[];const noop=async()=>({});
const backend={session:{get:async()=>null,subscribe:()=>()=>{},signIn:noop,signUp:noop,signOut:noop},workspace:{memberships:noop,snapshot:noop},documents:{upload:noop,signedUrl:noop,remove:noop,deletePriceSheet:noop,deleteInvoiceRecord:noop},realtime:{subscribeToOrganization:()=>()=>{}},pricing:{applyQuote:noop},catalog:{saveRow:noop},invoices:{record:noop},team:{acceptInvite:noop},records:{query:table=>new Proxy({then:resolve=>Promise.resolve({data:[],error:null}).then(resolve)},{get:(target,key)=>key==='then'?target.then:()=>{if(['insert','update','delete','upsert'].includes(key))writes.push([table,key]);return backend.records.query(table);}})},inbox:{beginManualReview:noop,markAttachmentIngested:noop}};
backend.estimatedDrafts={list:async()=>[],save:noop,get:noop,getByRequest:noop,cancel:noop,closeAttempt:noop};backend.variableWeight={listApprovals:async()=>[],approve:noop,revoke:noop};
globalThis.__KERDOS_CONFIG__={backendAdapter:backend};const {ItemCatalogPanel}=await import('./panel.mjs');
const categories=[{id:'cat',name:'General',industry:'restaurant',keywords:['ketchup'],is_holding_pen:false}];
const catalogItems=[{id:'item',name:'Ketchup',category_id:'cat',master_item_number:50021,created_at:'2026-01-01'}];
const vendorItems=[{id:'listing',organization_id:'org',vendor_id:'vendor',vendor_item_code:'K-1',description:'KETCHUP TOMATO',brand:'Brand',pack_size:'6/1 LB',selling_unit:null,price_basis:null,price:20,price_source:'price_list',field_resolutions:{}}];
const mappings=[{id:'mapping',organization_id:'org',vendor_item_id:'listing',catalog_item_id:'item',confidence_score:70,comparison_track:'review',match_method:'rule_based'}];
const productList=[{catalogItemId:'item',name:'Ketchup',category:'General',masterItemNumber:50021,createdAt:'2026-01-01',options:[{vendorId:'vendor',vendorName:'Vendor',vendorItemCode:'K-1',description:'KETCHUP TOMATO',unverified:true}]}];
const props={industry:'restaurant',orgId:'org',role:'owner',userId:'reviewer',productList,vendors:[{id:'vendor',name:'Vendor'}],catalogItems,mappings,vendorItems,categories,vocabulary:[],settings:{},onUpdated:noop};
const before=JSON.stringify(props),text=n=>typeof n==='string'?n:(n?.children||[]).map(text).join('');let tree;
await act(async()=>{tree=Renderer.create(React.createElement(ItemCatalogPanel,props));});
const actions=()=>tree.root.findByProps({'aria-label':'Item catalog actions'});
assert.equal(actions().props.open,false);assert.equal(tree.root.findAllByType('h3').filter(n=>text(n)==='Item Catalog').length,0,'the page title is not repeated inside its content');
assert.deepEqual(tree.root.findByProps({'aria-label':'Sort'}).findAllByType('option').map(text),['Item A–Z','Date Added','Item #','Vendor Code']);
assert.ok(tree.root.findByProps({placeholder:'Search by item, vendor description, or vendor code...'}));
assert.ok(tree.root.findAllByType('button').some(b=>text(b)==='Full List'));
for(const forbidden of ['All products (','Not mapped (','Mapped (','Quoted per case:','Correct any cell','vendor rows meet Order Guide requirements'])assert.ok(!text(tree.toJSON()).includes(forbidden),forbidden);
const button=label=>tree.root.findAllByType('button').find(b=>text(b)===label);
for(const label of ['+ Add Item','Export (CSV)','Estimated drafts','Product details','Review listings','Grouping review','Review suggested associations']){
 const b=button(label);assert.ok(b,label+' remains accessible');let parent=b.parent;while(parent&&parent!==actions())parent=parent.parent;assert.equal(parent,actions(),label+' belongs in Actions');
}
await act(async()=>actions().props.onToggle({currentTarget:{open:true}}));await act(async()=>button('+ Add Item').props.onClick());assert.equal(actions().props.open,false);assert.ok(tree.root.findByProps({role:'dialog','aria-label':'Add a catalog item'}));
await act(async()=>button('Cancel').props.onClick());
await act(async()=>actions().props.onToggle({currentTarget:{open:true}}));await act(async()=>button('Estimated drafts').props.onClick());await act(async()=>actions().props.onToggle({currentTarget:{open:false}}));assert.ok(tree.root.findByProps({role:'dialog','aria-label':'Estimated purchase drafts'}),'the draft dialog stays available after Actions closes');
await act(async()=>tree.root.findByProps({role:'dialog','aria-label':'Estimated purchase drafts'}).findAllByType('button').find(b=>text(b)==='Close').props.onClick());
await act(async()=>actions().props.onToggle({currentTarget:{open:true}}));await act(async()=>actions().props.onKeyDown({key:'Escape'}));assert.equal(actions().props.open,false);
assert.equal(JSON.stringify(props),before);assert.deepEqual(writes,[],'browsing and opening dialogs performs no catalog writes');
await act(async()=>tree.unmount());await act(async()=>{tree=Renderer.create(React.createElement(ItemCatalogPanel,{...props,role:'employee'}));});assert.equal(button('+ Add Item'),undefined);assert.equal(button('Grouping review'),undefined);assert.ok(button('Export (CSV)'));assert.ok(button('Estimated drafts'));
await act(async()=>tree.unmount());console.log('PASS catalog header: clean default, retained search/sort/category controls, closed Actions, accessible add/export/drafts/review, dialog continuity, roles and read-only browsing.');
`);
 process.stdout.write(execFileSync(process.execPath,[runner],{encoding:'utf8',env:process.env,timeout:30000}));
}finally{rmSync(dir,{recursive:true,force:true});}
