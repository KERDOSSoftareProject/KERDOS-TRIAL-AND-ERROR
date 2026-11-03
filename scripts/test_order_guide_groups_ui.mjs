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
vendorItems.push({...vendorItems[1],id:'honey-second',vendor_id:'second-vendor',description:'HONEY MUSTRD OTHER SUPPLIER',pack_size:'4/3 L',price:30});snapshot.vendors.push({id:'second-vendor',name:'Second Vendor'});snapshot.mappings.push({id:'honey-second-map',catalog_item_id:'ci1',vendor_item_id:'honey-second',comparison_track:'review',confidence_score:70,match_method:'rule_based'});
const noop=async()=>({});
const backend={session:{get:async()=>({user:{id:'user',email:'test@example.test'}}),subscribe:()=>()=>{},signIn:noop,signUp:noop,signOut:noop},workspace:{memberships:async()=>[{role:'employee',organizations:{id:'org',name:'Trial',industry:'restaurant',settings:{}}}],snapshot:async()=>snapshot},documents:{upload:noop,signedUrl:noop,remove:noop,deletePriceSheet:noop,deleteInvoiceRecord:noop},realtime:{subscribeToOrganization:()=>()=>{}},pricing:{applyQuote:noop},catalog:{saveRow:noop},invoices:{record:noop},team:{acceptInvite:noop},records:{query:()=>new Proxy({then:resolve=>Promise.resolve({data:[],error:null}).then(resolve)},{get:(target,key)=>key==='then'?target.then:()=>backend.records.query()})},inbox:{beginManualReview:noop,markAttachmentIngested:noop}};
globalThis.__KERDOS_CONFIG__={backendAdapter:backend};const {default:App}=await import('./app.mjs');
let tree;await act(async()=>{tree=Renderer.create(React.createElement(App));});
const text=node=>typeof node==='string'?node:(node?.children||[]).map(text).join('');
assert.equal(tree.root.findByProps({'aria-label':'Sort'}).props.value,'alphabetical');
const guideText=text(tree.toJSON());assert.ok(guideText.includes('KERDOS #501'));assert.ok(guideText.includes('Honey Mustard'));assert.ok(guideText.includes('KERDOS #502'));assert.ok(!guideText.includes('KERDOS #503'),'unresolved country row stays out');
assert.ok(guideText.indexOf('Avocados')<guideText.indexOf('Honey Mustard'));assert.ok(guideText.indexOf('Honey Mustard')<guideText.indexOf('Zucchini'));
const plus=tree.root.findAllByType('button').filter(b=>text(b)==='+');assert.equal(plus.length,3);assert.ok(plus.every(b=>b.props.disabled),'all candidate offers stay unorderable');
const alternatives=tree.root.findByProps({'aria-label':'Price choices for Honey Mustard'});assert.match(text(alternatives),/Sample Vendor/);assert.match(text(alternatives),/20.00/);assert.equal(alternatives.props['aria-expanded'],false);
assert.equal(tree.root.findAllByProps({'aria-label':'Group listings'}).length,0,'listings start collapsed');
assert.ok(!guideText.includes('Negotiated price'));assert.ok(!guideText.includes('Vendor price'));assert.ok(!guideText.includes('Power Ranked'));assert.ok(guideText.includes('PRICE'));
const basketBefore=text(tree.root.findByProps({className:'order-aside'}));
await act(async()=>alternatives.props.onClick());
const listingRegion=tree.root.findByProps({'aria-label':'Group listings'});assert.equal(listingRegion.findAllByType('input').length,2,'both source listings remain under one row');
assert.equal(listingRegion.findAllByType('input').every(input=>input.props.disabled),true,'employee has selection but no price write permission');
await act(async()=>listingRegion.findAllByType('button').find(button=>button.props['aria-label']?.startsWith('Select Second Vendor')).props.onClick());
assert.equal(tree.root.findAllByProps({'aria-label':'Group listings'}).length,0,'selection closes dropdown');assert.match(text(tree.root.findByProps({'aria-label':'Price choices for Honey Mustard'})),/Second Vendor/);
assert.equal(text(tree.root.findByProps({className:'order-aside'})),basketBefore,'selecting a held listing does not change baskets');
await act(async()=>tree.unmount());
// A second render exercises an actual owner edit through App's saved-data refresh,
// followed by selecting an alternative and putting that exact listing in a basket.
for(const key of [...store.keys()])if(key.includes('basket'))store.delete(key);
backend.workspace.memberships=async()=>[{role:'owner',organizations:{id:'org',name:'Trial',industry:'restaurant',settings:{}}}];
for(const ci of catalogItems){ci.category_reason='confirmed';ci.category_review=false;}
for(const row of vendorItems)row.field_resolutions={row_approval:true};
Object.assign(vendorItems.find(row=>row.id==='honey-second'),{pack_size:'4/1 GAL',description:'Honey Mustard Dressing'});
for(const m of snapshot.mappings){m.organization_id='org';m.comparison_track='exact';m.confidence_score=100;m.match_method='manual';}
backend.workspace.snapshot=async()=>structuredClone(snapshot);
let savedRequest;
backend.catalog.saveRow=async request=>{savedRequest=request;const row=vendorItems.find(v=>v.id===request.vendorItemId);row.price=request.patch.price;row.row_revision++;};
await act(async()=>{tree=Renderer.create(React.createElement(App));});
const priceButton=()=>tree.root.findByProps({'aria-label':'Price choices for Honey Mustard'});
assert.match(text(priceButton()),/Sample Vendor/);
await act(async()=>priceButton().props.onClick());
await act(async()=>tree.root.findByProps({'aria-label':'Price for listing honey-second'}).props.onChange({target:{value:'10.00'}}));
await act(async()=>tree.root.findByProps({'aria-label':'Apply price for listing honey-second'}).props.onClick());
assert.equal(savedRequest.vendorItemId,'honey-second');assert.deepEqual(savedRequest.patch,{price:10});assert.match(text(priceButton()),/Second Vendor/);assert.match(text(priceButton()),/10.00/,'saved cheaper listing becomes displayed choice');
await act(async()=>tree.root.findByProps({'aria-label':'Group listings'}).findAllByType('button').find(b=>b.props['aria-label']?.startsWith('Select Sample Vendor')).props.onClick());
assert.match(text(priceButton()),/Sample Vendor/);assert.equal(tree.root.findAllByProps({'aria-label':'Group listings'}).length,0);
const ownerPlus=tree.root.findAllByType('button').filter(b=>text(b)==='+');assert.equal(ownerPlus[1].props.disabled,false,priceButton().props.title);
await act(async()=>ownerPlus[1].props.onClick());
const populatedBasket=text(tree.root.findByProps({className:'order-aside'}));assert.match(populatedBasket,/Sample Vendor/);assert.match(populatedBasket,/Honey Mustard/);assert.match(populatedBasket,/20.00/,'basket uses the explicitly selected listing, not the other lowest quote');
await act(async()=>tree.unmount());
catalogItems.push({...catalogItems[1],id:'former-honey',master_item_number:400,merged_into_id:'ci1'});
store.set('kerdos.basket.org',JSON.stringify({quantities:{'former-honey_case':2},unitSelection:{},vendorOverride:{'former-honey_case':'vi1'},negotiatedPrices:{},splitOrders:{}}));
await act(async()=>{tree=Renderer.create(React.createElement(App));});
assert.equal(tree.root.findAllByProps({'aria-label':'Price choices for Honey Mustard'}).length,1,'merged old number adds no duplicate row');
const keptBasket=text(tree.root.findByProps({className:'order-aside'}));assert.match(keptBasket,/Sample Vendor/);assert.match(keptBasket,/40.00/,'existing basket quantity and chosen supplier survive grouping under a former number');
await act(async()=>tree.unmount());
// A confirmed product can offer different purchasing dimensions without one
// valid listing disabling another. Each still needs its own pack/unit/price.
store.delete('kerdos.basket.org');catalogItems.find(c=>c.id==='ci1').name='Honey Mustard';
for(const row of vendorItems.filter(v=>v.id==='vi1'||v.id==='honey-second'))row.field_resolutions={row_approval:true,product_group:{catalogItemId:'ci1',description:row.description,brand:row.brand??null,confirmedBy:'reviewer'}};
Object.assign(vendorItems.find(v=>v.id==='honey-second'),{pack_size:'1/10 LB',selling_unit:'CASE',price_basis:'case'});
await act(async()=>{tree=Renderer.create(React.createElement(App));});
await act(async()=>tree.root.findByProps({'aria-label':'Price choices for Honey Mustard'}).props.onClick());
await act(async()=>tree.root.findByProps({'aria-label':'Group listings'}).findAllByType('button').find(b=>b.props['aria-label']?.startsWith('Select Second Vendor')).props.onClick());
assert.equal(tree.root.findAllByType('button').filter(b=>text(b)==='+')[1].props.disabled,false,'a valid confirmed listing remains purchasable when another supplier quotes a different dimension');
await act(async()=>tree.unmount());
// F2.1: actual App assessment -> option flags -> controls -> basket. An
// incomplete peer cannot hold the valid approved offer or borrow its fields.
store.delete('kerdos.basket.org');const incompletePeer=vendorItems.find(v=>v.id==='honey-second');
Object.assign(incompletePeer,{pack_size:null,selling_unit:null,price_basis:null,price:null,price_unavailable:true});
await act(async()=>{tree=Renderer.create(React.createElement(App));});
const selectHoney=async name=>{await act(async()=>tree.root.findByProps({'aria-label':'Price choices for Honey Mustard'}).props.onClick());await act(async()=>tree.root.findByProps({'aria-label':'Group listings'}).findAllByType('button').find(b=>b.props['aria-label']?.startsWith('Select '+name)).props.onClick());};
const honeyPlus=()=>tree.root.findAllByType('button').filter(b=>text(b)==='+')[1];
await selectHoney('Sample Vendor');assert.equal(honeyPlus().props.disabled,false);
await act(async()=>honeyPlus().props.onClick());assert.match(text(tree.root.findByProps({className:'order-aside'})),/20.00/);assert.match(text(tree.root.findByProps({className:'order-aside'})),/Sample Vendor/);
await act(async()=>tree.unmount());store.delete('kerdos.basket.org');
await act(async()=>{tree=Renderer.create(React.createElement(App));});await selectHoney('Second Vendor');assert.equal(honeyPlus().props.disabled,true,'incomplete peer remains visible but cannot use the valid offer price or pack');
await act(async()=>tree.unmount());store.delete('kerdos.basket.org');
// F1.6: execute the actual one-minute App refresh callback at a controlled
// new date. The ordering core itself has no independent freshness clock.
Object.assign(incompletePeer,{pack_size:'4/1 GAL',selling_unit:'CASE',price_basis:'case',price:40,price_unavailable:false});
const expiring=vendorItems.find(v=>v.id==='vi1');expiring.price_quote_valid_until='2026-11-02';
const RealDate=globalThis.Date,realInterval=globalThis.setInterval,realClearInterval=globalThis.clearInterval;let epoch=RealDate.parse('2026-11-02T12:00:00Z'),refresh;const clockTimer={};
globalThis.Date=class extends RealDate{constructor(...args){super(...(args.length?args:[epoch]));}static now(){return epoch;}};
globalThis.setInterval=(fn,ms,...args)=>ms===60000?(refresh=fn,clockTimer):realInterval(fn,ms,...args);globalThis.clearInterval=id=>{if(id!==clockTimer)realClearInterval(id);};
try{
 await act(async()=>{tree=Renderer.create(React.createElement(App));});assert.equal(typeof refresh,'function');await selectHoney('Sample Vendor');assert.equal(honeyPlus().props.disabled,false);
 epoch=RealDate.parse('2026-11-03T12:00:00Z');await act(async()=>refresh());await selectHoney('Sample Vendor');assert.equal(honeyPlus().props.disabled,true,'expiry refresh maps the quote state through actual App flags into ordering controls');
 await selectHoney('Second Vendor');assert.equal(honeyPlus().props.disabled,false,'current peer remains orderable after cheaper quotation expires');await act(async()=>honeyPlus().props.onClick());const currentBasket=text(tree.root.findByProps({className:'order-aside'}));assert.match(currentBasket,/Second Vendor/);assert.match(currentBasket,/40.00/,'solver uses the current quotation, not the expired cheap offer');
 await act(async()=>tree.unmount());
}finally{globalThis.Date=RealDate;globalThis.setInterval=realInterval;globalThis.clearInterval=realClearInterval;}
console.log('PASS F actual App boundary: incomplete-peer isolation, held selection, independent basket pricing and timer-driven expiry with a current alternative');
console.log('PASS rendered complete Order Guide: existing item numbers, canonical A–Z names, held group rows, vendor choices and disabled ordering without manufactured approvals.');
`);
 process.stdout.write(execFileSync(process.execPath,[runner],{encoding:'utf8',env:process.env}));
}finally{rmSync(dir,{recursive:true,force:true});}
