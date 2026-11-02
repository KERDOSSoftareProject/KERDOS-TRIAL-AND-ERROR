import {build} from 'esbuild';
import {mkdtempSync,writeFileSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
const dir=mkdtempSync(join(process.cwd(),'node_modules/.order-groups-'));
try{
 const outfile=join(dir,'app.mjs');
 await build({entryPoints:['src/App.jsx'],outfile,bundle:true,platform:'node',format:'esm',jsx:'automatic',external:['react','react-dom','react-test-renderer'],plugins:[{name:'asset-url',setup(builder){builder.onResolve({filter:/\?url$/},args=>({path:args.path,namespace:'test-asset'}));builder.onLoad({filter:/.*/,namespace:'test-asset'},()=>({contents:'export default "test-asset-url"',loader:'js'}));}}],logLevel:'silent'});
 const runner=join(dir,'run.mjs');
 writeFileSync(runner,String.raw`
import React from 'react';import Renderer,{act} from 'react-test-renderer';import assert from 'node:assert/strict';
const store=new Map([['kerdos.activeTab.v2','order']]);const storage={getItem:k=>store.get(k)||null,setItem:(k,v)=>store.set(k,v),removeItem:k=>store.delete(k)};globalThis.sessionStorage=storage;globalThis.localStorage=storage;
globalThis.window={addEventListener:()=>{},removeEventListener:()=>{},history:{scrollRestoration:'auto'},scrollTo:()=>{},location:{origin:'https://test.example'}};globalThis.document={addEventListener:()=>{},removeEventListener:()=>{}};globalThis.alert=message=>{throw new Error(message);};
const categories=[{id:'cat',name:'Dry Goods',is_holding_pen:false}];
const vendorItems=['Zucchini','Honey Mustard Dressing','Avocado','USA'].map((description,i)=>({id:'vi'+i,organization_id:'org',vendor_id:'vendor',description,brand:'',pack_size:'4/1 GAL',selling_unit:'CASE',price_basis:'case',price:20,price_source:'price_list',last_updated:new Date().toISOString(),field_resolutions:{},row_revision:0}));
const catalogItems=vendorItems.map((v,i)=>({id:'ci'+i,name:v.description,master_item_number:500+i,category_id:'cat',catalog_categories:categories[0],comparison_mode:'alternatives'}));
const snapshot={vendors:[{id:'vendor',name:'Sample Vendor'}],catalogItems,vendorItems,mappings:vendorItems.map((v,i)=>({id:'m'+i,catalog_item_id:'ci'+i,vendor_item_id:v.id,comparison_track:'review',confidence_score:70,match_method:'rule_based'})),categories,vocabulary:[],invoices:[],purchaseOrders:[],priceHistory:[],importDocuments:[]};
const noop=async()=>({});
const backend={session:{get:async()=>({user:{id:'user',email:'test@example.test'}}),subscribe:()=>()=>{},signIn:noop,signUp:noop,signOut:noop},workspace:{memberships:async()=>[{role:'employee',organizations:{id:'org',name:'Trial',industry:'restaurant',settings:{}}}],snapshot:async()=>snapshot},documents:{upload:noop,signedUrl:noop,remove:noop,deletePriceSheet:noop,deleteInvoiceRecord:noop},realtime:{subscribeToOrganization:()=>()=>{}},pricing:{applyQuote:noop},catalog:{saveRow:noop},invoices:{record:noop},team:{acceptInvite:noop},records:{query:()=>new Proxy({then:resolve=>Promise.resolve({data:[],error:null}).then(resolve)},{get:(target,key)=>key==='then'?target.then:()=>backend.records.query()})},inbox:{beginManualReview:noop,markAttachmentIngested:noop}};
globalThis.__KERDOS_CONFIG__={backendAdapter:backend};const {default:App}=await import('./app.mjs');
let tree;await act(async()=>{tree=Renderer.create(React.createElement(App));});
const text=node=>typeof node==='string'?node:(node?.children||[]).map(text).join('');
assert.equal(tree.root.findByProps({'aria-label':'Sort'}).props.value,'alphabetical');
const guideText=text(tree.toJSON());assert.ok(guideText.includes('KERDOS #501'));assert.ok(guideText.includes('Honey Mustard'));assert.ok(guideText.includes('KERDOS #502'));assert.ok(!guideText.includes('KERDOS #503'),'unresolved country row stays out');
assert.ok(guideText.indexOf('Avocados')<guideText.indexOf('Honey Mustard'));assert.ok(guideText.indexOf('Honey Mustard')<guideText.indexOf('Zucchini'));
const plus=tree.root.findAllByType('button').filter(b=>text(b)==='+');assert.equal(plus.length,3);assert.ok(plus.every(b=>b.props.disabled),'all candidate offers stay unorderable');
const alternatives=tree.root.findByProps({'aria-label':'Power Ranked alternatives for Honey Mustard'});await act(async()=>alternatives.props.onClick());
assert.ok(tree.root.findByProps({role:'listbox','aria-label':'Alternatives for Honey Mustard'}));assert.match(text(tree.toJSON()),/Selected for review only/);
await act(async()=>tree.unmount());console.log('PASS rendered complete Order Guide: existing item numbers, canonical A–Z names, held group rows, vendor choices and disabled ordering without manufactured approvals.');
`);
 process.stdout.write(execFileSync(process.execPath,[runner],{encoding:'utf8',env:process.env}));
}finally{rmSync(dir,{recursive:true,force:true});}
