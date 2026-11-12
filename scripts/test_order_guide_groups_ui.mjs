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
const listeners={};let scrollRows=[];
globalThis.window={addEventListener:(name,listener)=>{listeners[name]=listener;},removeEventListener:()=>{},innerHeight:1000,requestAnimationFrame:cb=>setTimeout(cb,0),cancelAnimationFrame:clearTimeout,history:{scrollRestoration:'auto'},scrollTo:()=>{},location:{origin:'https://test.example'}};
globalThis.document={addEventListener:()=>{},removeEventListener:()=>{},querySelectorAll:()=>scrollRows};globalThis.alert=message=>{throw new Error(message);};
const categories=[{id:'cat',name:'Dry Goods',is_holding_pen:false}];
const vendorItems=['Zucchini','Honey Mustard Dressing','Avocado','USA'].map((description,i)=>({id:'vi'+i,organization_id:'org',vendor_id:'vendor',description,brand:'',pack_size:'4/1 GAL',selling_unit:'CASE',price_basis:'case',price:20,price_source:'price_list',last_updated:new Date().toISOString(),field_resolutions:{},row_revision:0}));
const catalogItems=vendorItems.map((v,i)=>({id:'ci'+i,name:v.description,master_item_number:500+i,category_id:'cat',catalog_categories:categories[0],comparison_mode:'alternatives'}));
const snapshot={vendors:[{id:'vendor',name:'Sample Vendor'}],catalogItems,vendorItems,mappings:vendorItems.map((v,i)=>({id:'m'+i,catalog_item_id:'ci'+i,vendor_item_id:v.id,comparison_track:'review',confidence_score:70,match_method:'rule_based'})),categories,vocabulary:[],invoices:[],purchaseOrders:[],priceHistory:[],importDocuments:[]};
vendorItems.push({...vendorItems[1],id:'honey-second',vendor_id:'second-vendor',description:'HONEY MUSTRD OTHER SUPPLIER',pack_size:'4/3 L',price:30});snapshot.vendors.push({id:'second-vendor',name:'Second Vendor'});snapshot.mappings.push({id:'honey-second-map',catalog_item_id:'ci1',vendor_item_id:'honey-second',comparison_track:'review',confidence_score:70,match_method:'rule_based'});
vendorItems[1].field_resolutions={selling_unit:{value:'CASE',confirmedBy:'owner'}};
const noop=async()=>({});
const emptyQuery=()=>new Proxy({then:resolve=>Promise.resolve({data:[],error:null}).then(resolve)},{get:(target,key)=>key==='then'?target.then:emptyQuery});
let queryRecords=emptyQuery;
const backend={session:{get:async()=>({user:{id:'user',email:'test@example.test'}}),subscribe:()=>()=>{},signIn:noop,signUp:noop,signOut:noop},workspace:{memberships:async()=>[{role:'employee',organizations:{id:'org',name:'Trial',industry:'restaurant',settings:{}}}],snapshot:async()=>snapshot},documents:{upload:noop,signedUrl:noop,remove:noop,deletePriceSheet:noop,deleteInvoiceRecord:noop},realtime:{subscribeToOrganization:()=>()=>{}},pricing:{applyQuote:noop},catalog:{saveRow:noop},invoices:{record:noop},team:{acceptInvite:noop},records:{query:(...args)=>queryRecords(...args)},inbox:{beginManualReview:noop,markAttachmentIngested:noop}};
globalThis.__KERDOS_CONFIG__={backendAdapter:backend};const {default:App}=await import('./app.mjs');
let tree;await act(async()=>{tree=Renderer.create(React.createElement(App));});
const text=node=>typeof node==='string'?node:(node?.children||[]).map(text).join('');
assert.equal(tree.root.findByProps({'aria-label':'Sort'}).props.value,'alphabetical');
const guideText=text(tree.toJSON());assert.ok(guideText.includes('KERDOS #501'));assert.ok(guideText.includes('Honey Mustard'));assert.ok(guideText.includes('KERDOS #502'));assert.ok(!guideText.includes('KERDOS #503'),'unresolved country row stays out');
assert.ok(guideText.indexOf('Avocados')<guideText.indexOf('Honey Mustard'));assert.ok(guideText.indexOf('Honey Mustard')<guideText.indexOf('Zucchini'));
const plus=tree.root.findAllByType('button').filter(b=>text(b)==='+');assert.equal(plus.length,3);assert.ok(plus.every(b=>b.props.disabled),'all candidate offers stay unorderable');
const alternatives=tree.root.findByProps({'aria-label':'Price choices for Honey Mustard'});assert.match(text(alternatives),/Sample Vendor/);assert.match(text(alternatives),/20.00/);assert.equal(alternatives.props['aria-expanded'],false);
const orderRow=name=>tree.root.findAllByProps({className:'order-item'}).find(row=>text(row).includes(name));
scrollRows=[{dataset:{orderItemName:'ci0'},getBoundingClientRect:()=>({top:200,bottom:250})},
 {dataset:{orderItemName:'ci1'},getBoundingClientRect:()=>({top:620,bottom:670})}];
await act(async()=>{listeners.scroll();await new Promise(resolve=>setTimeout(resolve,5));});
assert.equal(orderRow('Honey Mustard').props['data-active'],true,'the row highlight follows the visible part of the scrolled guide');
await act(async()=>orderRow('Honey Mustard').props.onClickCapture());
assert.equal(orderRow('Honey Mustard').props['data-active'],true,'the row being edited stays highlighted');
await act(async()=>orderRow('Avocados').props.onFocusCapture());
assert.equal(orderRow('Honey Mustard').props['data-active'],false);
assert.equal(orderRow('Avocados').props['data-active'],true,'keyboard focus moves the row highlight');
assert.equal(alternatives.props['aria-description'],'2 vendors quote this item','blue marks multiple quoted vendor choices even when ordering is held');
assert.equal(alternatives.props.style.background,'#E3F2FD');
assert.equal(tree.root.findAllByProps({'aria-label':'Group listings'}).length,0,'listings start collapsed');
assert.ok(!guideText.includes('Negotiated price'));assert.ok(!guideText.includes('Vendor price'));assert.ok(!guideText.includes('Power Ranked'));assert.ok(guideText.includes('PRICE'));assert.ok(!guideText.includes('Unit Price'));
const basketBefore=text(tree.root.findByProps({className:'order-aside'}));
await act(async()=>alternatives.props.onClick());
assert.equal(orderRow('Avocados').props['data-active'],true,'menu reflow does not clear the active row highlight');
const listingRegion=tree.root.findByProps({'aria-label':'Group listings'});assert.equal(listingRegion.findAllByType('input').filter(input=>input.props.type==='number').length,2,'both source listings remain under one row');
await act(async()=>orderRow('Honey Mustard').props.onClickCapture());
const unitPrices=region=>region.findAllByProps({'data-field-label':'Unit Price'}).map(text);
assert.ok(listingRegion.findAllByType('th').some(cell=>text(cell)==='Unit Price'));
assert.deepEqual(unitPrices(listingRegion),['$5.00 / gal','—']);
assert.ok(listingRegion.findAllByProps({'data-field-label':'Unit Price'})[0].props.title,'a held rate retains its review reason');
assert.equal(listingRegion.findAllByType('summary').length,0,'held listings do not show a Review control in the price dropdown');
assert.equal([...listingRegion.findAllByType('input'),...listingRegion.findAllByType('select')].every(input=>input.props.disabled),true,'employee has selection but no listing write permission');
await act(async()=>listingRegion.findAllByType('button').find(button=>button.props['aria-label']?.startsWith('Select Second Vendor')).props.onClick());
assert.equal(tree.root.findAllByProps({'aria-label':'Group listings'}).length,0,'selection closes dropdown');assert.match(text(tree.root.findByProps({'aria-label':'Price choices for Honey Mustard'})),/Second Vendor/);
assert.equal(orderRow('Honey Mustard').props['data-active'],true,'the edited row remains marked after vendor selection closes the menu');
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
backend.catalog.saveRow=async request=>{savedRequest=request;const row=vendorItems.find(v=>v.id===request.vendorItemId);Object.assign(row,request.patch);
if(['price','pack_size','selling_unit'].some(field=>Object.hasOwn(request.patch,field))){
 row.price_basis=request.priceBasis;row.price_unavailable=!request.priceAvailable;
}
row.row_revision++;
};
await act(async()=>{tree=Renderer.create(React.createElement(App));});
const priceButton=()=>tree.root.findByProps({'aria-label':'Price choices for Honey Mustard'});
assert.match(text(priceButton()),/Sample Vendor/);
assert.equal(priceButton().props['aria-description'],'2 vendors quote this item');
assert.equal(priceButton().props.style.border,'2px solid #1565C0');
assert.equal(priceButton().props.style.background,'#E3F2FD');
const orderUnitOption=(value)=>tree.root.findByProps({'aria-label':'Order unit for Honey Mustard'}).findAllByType('option').find(option=>option.props.value===value);
assert.equal(orderUnitOption('each').props.disabled,true,'a quoted case does not authorize ordering an inner unit');

await act(async()=>priceButton().props.onClick());
await act(async()=>tree.root.findByProps({'aria-label':'Price for listing honey-second'}).props.onChange({target:{value:'10.00'}}));
const settlePrice=()=>act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});
await act(async()=>{await new Promise(resolve=>setTimeout(resolve,800));});
assert.equal(savedRequest,undefined,'typing pauses do not save the open dropdown');
await act(async()=>priceButton().props.onClick());
await settlePrice();
assert.equal(savedRequest.vendorItemId,'honey-second');assert.deepEqual(savedRequest.patch,{price:10});assert.match(text(priceButton()),/Second Vendor/);assert.match(text(priceButton()),/10.00/,'saved cheaper listing becomes displayed choice');
await act(async()=>priceButton().props.onClick());
await act(async()=>tree.root.findByProps({'aria-label':'Group listings'}).findAllByType('button').find(b=>b.props['aria-label']?.startsWith('Select Sample Vendor')).props.onClick());
assert.match(text(priceButton()),/Sample Vendor/);assert.equal(tree.root.findAllByProps({'aria-label':'Group listings'}).length,0);
assert.equal(tree.root.findAllByType('button').filter(b=>text(b)==='Clear selection').length,0,
 'choosing a vendor adds no detail row below the price choice');
assert.equal(priceButton().props.style.background,'#E3F2FD','multiple vendor choices stay blue');
assert.doesNotMatch(text(tree.toJSON()),/Use lowest price/);
await act(async()=>priceButton().props.onClick());
await act(async()=>tree.root.findByProps({'aria-label':'Price for listing honey-second'}).props.onChange({target:{value:'9.00'}}));
await act(async()=>priceButton().props.onClick());
await settlePrice();
assert.equal(savedRequest.patch.price,9,'closing the menu does not discard a price edit');
assert.match(text(priceButton()),/Sample Vendor.*20\.00/,'saving another listing preserves the explicit vendor selection');
await act(async()=>priceButton().props.onClick());
const selectedPrice=()=>tree.root.findByProps({'aria-label':'Price for listing vi1'});
await act(async()=>selectedPrice().props.onChange({target:{value:'21.00'}}));
await act(async()=>priceButton().props.onClick());
await act(async()=>{await new Promise(resolve=>setTimeout(resolve,25));});
assert.match(text(priceButton()),/Sample Vendor.*21\.00/,'saving the selected listing keeps the vendor and updates the price');
await act(async()=>priceButton().props.onClick());
const ownerPlus=tree.root.findAllByType('button').filter(b=>text(b)==='+');assert.equal(ownerPlus[1].props.disabled,false,priceButton().props.title);
await act(async()=>ownerPlus[1].props.onClick());
const populatedBasket=text(tree.root.findByProps({className:'order-aside'}));assert.match(populatedBasket,/Sample Vendor/);assert.match(populatedBasket,/Honey Mustard/);assert.match(populatedBasket,/21\.00/,'basket uses the explicitly selected listing and its saved price');
await act(async()=>tree.unmount());
vendorItems.find(row=>row.id==='vi1').price=20;
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
const eachListing=vendorItems.find(v=>v.id==='vi1');
Object.assign(eachListing,{selling_unit:'EACH',price_basis:'each',price:5});
await act(async()=>{tree=Renderer.create(React.createElement(App));});
const honeyUnit=()=>tree.root.findByProps({'aria-label':'Order unit for Honey Mustard'});
await act(async()=>honeyUnit().props.onChange({target:{value:'each'}}));assert.equal(honeyUnit().props.value,'each');
assert.equal(priceButton().props['aria-description'],undefined,'the case-only listing does not count toward the each-price outline');
assert.match(text(priceButton()),/Sample Vendor.*5\.00/,'the Each price is the listing’s accepted quote');
await act(async()=>tree.root.findByProps({'aria-label':'Price choices for Honey Mustard'}).props.onClick());
assert.deepEqual(unitPrices(tree.root.findByProps({'aria-label':'Group listings'})),['$5.00 / gal','$0.90 / lb']);
await act(async()=>tree.root.findByProps({'aria-label':'Group listings'}).findAllByType('button').find(b=>b.props['aria-label']?.startsWith('Select Second Vendor')).props.onClick());
assert.equal(honeyUnit().props.value,'case');assert.match(text(priceButton()),/Second Vendor.*9\.00/);
assert.equal(tree.root.findAllByType('button').filter(b=>text(b)==='Clear selection').length,0,
 'switching order units does not add a detail row under the vendor choice');
assert.equal(tree.root.findAllByType('button').filter(b=>text(b)==='+')[1].props.disabled,false,'a valid confirmed listing remains purchasable when another supplier quotes a different dimension');
await act(async()=>tree.unmount());
// F2.1: actual App assessment -> option flags -> controls -> basket. An
// incomplete peer cannot hold the valid approved offer or borrow its fields.
Object.assign(eachListing,{selling_unit:'CASE',price_basis:'case',price:20});
store.delete('kerdos.basket.org');const incompletePeer=vendorItems.find(v=>v.id==='honey-second');
Object.assign(incompletePeer,{pack_size:null,selling_unit:'CASE',price_basis:'case',price:null,price_unavailable:true});
await act(async()=>{tree=Renderer.create(React.createElement(App));});
const selectHoney=async name=>{await act(async()=>tree.root.findByProps({'aria-label':'Price choices for Honey Mustard'}).props.onClick());await act(async()=>tree.root.findByProps({'aria-label':'Group listings'}).findAllByType('button').find(b=>b.props['aria-label']?.startsWith('Select '+name)).props.onClick());};
const honeyPlus=()=>tree.root.findAllByType('button').filter(b=>text(b)==='+')[1];
await selectHoney('Sample Vendor');assert.equal(honeyPlus().props.disabled,false);
await act(async()=>honeyPlus().props.onClick());assert.match(text(tree.root.findByProps({className:'order-aside'})),/20.00/);assert.match(text(tree.root.findByProps({className:'order-aside'})),/Sample Vendor/);
await act(async()=>tree.unmount());store.delete('kerdos.basket.org');
const incompleteMapping=snapshot.mappings.find(m=>m.vendor_item_id===incompletePeer.id);
const saveCatalogRow=backend.catalog.saveRow;
backend.catalog.saveRow=async request=>{
 await saveCatalogRow(request);
 incompletePeer.field_resolutions.pack_size={value:request.patch.pack_size,confirmedBy:'user'};
 Object.assign(incompleteMapping,{comparison_track:'review',confidence_score:null,match_method:'manual'});
};
queryRecords=table=>table==='item_mappings'?{
 update:patch=>({eq:(idField,id)=>({eq:(itemField,itemId)=>({select:async()=>{
  assert.equal(idField,'id');assert.equal(itemField,'catalog_item_id');
  assert.equal(id,incompleteMapping.id);assert.equal(itemId,incompleteMapping.catalog_item_id);
  Object.assign(incompleteMapping,patch);return {data:[{id}],error:null};
 }})})})
}:emptyQuery();
delete incompletePeer.field_resolutions.row_approval;
incompletePeer.field_resolutions.selling_unit={value:'CASE',confirmedBy:'user'};
await act(async()=>{tree=Renderer.create(React.createElement(App));});await selectHoney('Second Vendor');assert.equal(honeyPlus().props.disabled,true,'incomplete peer remains visible but cannot use the valid offer price or pack');
await act(async()=>priceButton().props.onClick());
for(const [label,value] of [['Pack','6/1 GAL'],['Price','16.25']]){
 await act(async()=>tree.root.findByProps({'aria-label':label+' for listing honey-second'}).props.onChange({target:{value}}));
}
await act(async()=>priceButton().props.onClick());
await settlePrice();
assert.deepEqual(savedRequest.patch,{pack_size:'6/1 GAL',price:16.25});
assert.equal(incompleteMapping.comparison_track,'exact','the save and placement refresh restore the existing product-group approval');
assert.equal(incompleteMapping.match_method,'manual');
assert.equal(honeyPlus().props.disabled,false,'the edited listing becomes orderable despite the peer having a different pack');
assert.match(text(priceButton()),/Second Vendor.*16\.25/);
await act(async()=>honeyPlus().props.onClick());
assert.match(text(tree.root.findByProps({className:'order-aside'})),/Second Vendor.*16\.25/);
await act(async()=>tree.root.findByProps({'aria-label':'Workspace tabs'}).findAllByType('button').find(b=>text(b)==='Item Catalog').props.onClick());
const catalogPrices=tree.root.findAllByType('input').filter(input=>input.props['aria-label']?.startsWith('price for '));
assert.equal(catalogPrices.find(input=>input.props.value===16.25)?.props.value,16.25,'Item Catalog shows the same saved quote');
await act(async()=>tree.unmount());store.delete('kerdos.basket.org');
backend.catalog.saveRow=saveCatalogRow;queryRecords=emptyQuery;
delete incompletePeer.field_resolutions.selling_unit;
store.set('kerdos.activeTab.v2','order');
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
// G: three actual source rows. Two comparable packs compete per pound;
// the cheaper third row has no pack and must never become the default/basket.
store.delete('kerdos.basket.org');delete expiring.price_quote_valid_until;
Object.assign(expiring,{pack_size:'1/10 LB',price:20});Object.assign(incompletePeer,{pack_size:'1/4 LB',price:12});
const third={...incompletePeer,id:'honey-third',vendor_id:'third-vendor',pack_size:null,price:1,field_resolutions:{row_approval:true}};
vendorItems.push(third);snapshot.vendors.push({id:'third-vendor',name:'Third Vendor'});snapshot.mappings.push({...snapshot.mappings.find(m=>m.vendor_item_id==='honey-second'),id:'honey-third-map',vendor_item_id:third.id});
// Product-group approvals remain listing-local; description/brand still match.
await act(async()=>{tree=Renderer.create(React.createElement(App));});
assert.match(text(priceButton()),/Sample Vendor/,'two valid packs retain their unit-cost winner beside an incomplete cheap third offer');
await act(async()=>honeyPlus().props.onClick());const threeBasket=text(tree.root.findByProps({className:'order-aside'}));assert.match(threeBasket,/Sample Vendor/);assert.match(threeBasket,/20.00/,'basket charges the winning whole pack, not its per-pound comparison rate');
await selectHoney('Third Vendor');assert.equal(honeyPlus().props.disabled,true,'actual App marks the incomplete third listing held');assert.equal(JSON.parse(store.get('kerdos.basket.org')).quantities.ci1_case,1,'selecting a held listing retains the requested quantity');assert.ok(!text(tree.root.findByProps({className:'order-aside'})).includes('Record 1 Order'),'held selection cannot silently order a different vendor');await selectHoney('Sample Vendor');assert.equal(text(tree.root.findByProps({className:'order-aside'})),threeBasket,'returning to the ready selection restores its own basket without losing quantity');
await act(async()=>tree.unmount());store.delete('kerdos.basket.org');
// Minimum shortfalls are derived from actual basket totals, including an
// explicit locked supplier selection; purchasing readiness is a separate gate.
snapshot.vendors.find(v=>v.id==='vendor').delivery_minimum_dollar=100;
await act(async()=>{tree=Renderer.create(React.createElement(App));});await selectHoney('Sample Vendor');await act(async()=>honeyPlus().props.onClick());
const shortBasket=text(tree.root.findByProps({className:'order-aside'}));assert.match(shortBasket,/80.00 to go/,'a locked $20 basket does not claim to meet a $100 minimum');assert.match(shortBasket,/Sample Vendor/);
await act(async()=>tree.unmount());delete snapshot.vendors.find(v=>v.id==='vendor').delivery_minimum_dollar;

// G: splitting between suppliers must preserve the exact primary listing,
// even when the selected supplier has another listing for this product.
Object.assign(expiring,{pack_size:'4/1 GAL',price:20});Object.assign(incompletePeer,{pack_size:'4/1 GAL',price:28});
const alternate={...expiring,id:'honey-same-vendor-alternate',vendor_item_code:'ALT-32',price:32};
vendorItems.push(alternate);snapshot.mappings.push({...snapshot.mappings.find(m=>m.vendor_item_id===expiring.id),id:'honey-alt-map',vendor_item_id:alternate.id});
for(const [unit,primary,secondary] of [['case','64.00','28.00'],['each','16.00','7.00']]){
 if(unit==='each'){
  for(const [listing,price] of [[expiring,5],[alternate,8],[incompletePeer,7]]){
   Object.assign(listing,{selling_unit:'EACH',price_basis:'each',price});
  }
 }

 const key='ci1_'+unit;
 store.set('kerdos.basket.org',JSON.stringify({quantities:{[key]:3},unitSelection:{ci1:unit},vendorOverride:{[key]:alternate.id},negotiatedPrices:{},splitOrders:{[key]:{vendorId:'second-vendor',quantity:1}}}));
 await act(async()=>{tree=Renderer.create(React.createElement(App));});
 const basket=text(tree.root.findByProps({className:'order-aside'}));
 assert.ok(basket.includes(primary),'split '+unit+' basket must charge the exact selected primary listing: '+basket);
 assert.ok(basket.includes(secondary),'split '+unit+' basket must retain the second vendor allocation');
 await act(async()=>tree.unmount());
}
for(const [listing,price] of [[expiring,20],[alternate,32],[incompletePeer,28]]){
 Object.assign(listing,{selling_unit:'CASE',price_basis:'case',price});
}
alternate.price_unavailable=true;
store.set('kerdos.basket.org',JSON.stringify({quantities:{ci1_case:3},vendorOverride:{ci1_case:alternate.id},splitOrders:{ci1_case:{vendorId:'second-vendor',quantity:1}}}));
await act(async()=>{tree=Renderer.create(React.createElement(App));});
assert.equal(honeyPlus().props.disabled,true);
assert.doesNotMatch(text(tree.root.findByProps({className:'order-aside'})),/Record \d+ Order/,'a held selection must never silently order another listing through a split');
assert.equal(JSON.parse(store.get('kerdos.basket.org')).quantities.ci1_case,3);
await act(async()=>tree.unmount());
console.log('PASS G split baskets preserve the selected source listing for Case and Each.');
// Previously saved derived quantities stay visible and can be removed.
store.set('kerdos.basket.org',JSON.stringify({quantities:{ci1_case:1,ci1_each:1},unitSelection:{ci1:'each'}}));
await act(async()=>{tree=Renderer.create(React.createElement(App));});
assert.equal(honeyUnit().props.value,'each');
assert.equal(honeyPlus().props.disabled,true);
const aside=()=>tree.root.findByProps({className:'order-aside'});
const record=()=>aside().findAllByType('button').find(button=>/^Record 1 Order/.test(text(button)));
assert.equal(record().props.disabled,true,'a saved Each quantity without a quoted each rate blocks submission');
await act(async()=>tree.root.findByProps({'aria-label':'Remove one each of Honey Mustard'}).props.onClick());
assert.equal(honeyUnit().props.value,'case');
assert.equal(record().props.disabled,false,'removing the unsupported quantity restores the quoted case order');
await act(async()=>tree.unmount());

store.delete('kerdos.basket.org');
Object.assign(expiring,{pack_size:'5 LB',selling_unit:'EACH',price_basis:'each',price:16.75});
incompletePeer.price_unavailable=true;
third.price_unavailable=true;
// Remove the other listings to isolate the each-only purchasing rule.
for(const id of [incompletePeer.id,third.id,alternate.id]){
 snapshot.mappings.splice(snapshot.mappings.findIndex(mapping=>mapping.vendor_item_id===id),1);
}
await act(async()=>{tree=Renderer.create(React.createElement(App));});
assert.equal(honeyUnit().props.value,'each','one five-pound package quoted each defaults to Each');
assert.equal(honeyUnit().props.style.border,'2px solid #1565C0');
assert.equal(orderUnitOption('case').props.disabled,true,'the comparison equivalent cannot become a case offer');
assert.match(text(priceButton()),/Sample Vendor.*16\.75/);
await act(async()=>honeyPlus().props.onClick());
assert.match(text(aside()),/1 each.*16\.75/);
await act(async()=>tree.unmount());
console.log('PASS C1.5 only the active quoted order unit can enter a basket, including a one-package Each quote.');

store.delete('kerdos.basket.org');
Object.assign(expiring,{pack_size:'4/5 LB'});
Object.assign(incompletePeer,{pack_size:'12/1 LB',selling_unit:'EACH',price_basis:'each',price:4,price_unavailable:false});
snapshot.mappings.push({...snapshot.mappings.find(mapping=>mapping.vendor_item_id===expiring.id),id:'each-comparison-peer',vendor_item_id:incompletePeer.id});
await act(async()=>{tree=Renderer.create(React.createElement(App));});
assert.equal(honeyUnit().props.value,'each');
assert.match(text(priceButton()),/Sample Vendor.*16\.75/,'$3.35/lb beats $4/lb despite the larger package price');
await act(async()=>honeyPlus().props.onClick());
await act(async()=>honeyPlus().props.onClick());
assert.match(text(aside()),/Sample Vendor.*2 eachs? × \$16\.75.*33\.50/,'basket keeps the two-package quantity and quoted charge');
assert.match(text(aside()),/Best unit-price total\$33\.50/,'basket baseline follows the same price comparison as the guide');
await selectHoney('Second Vendor');
assert.match(text(aside()),/Second Vendor.*2 eachs? × \$4\.00.*8\.00/,'explicit selection uses its own package and price');
await act(async()=>tree.unmount());
console.log('PASS C1.5 Each offers compare at a shared measurement and order at their own quoted amount.');

store.delete('kerdos.basket.org');
Object.assign(third,{pack_size:'1 GAL',selling_unit:'EACH',price_basis:'each',price:1,price_unavailable:false});
third.field_resolutions=structuredClone(expiring.field_resolutions);
snapshot.mappings.push({...snapshot.mappings.find(mapping=>mapping.vendor_item_id===expiring.id),id:'each-incompatible-peer',vendor_item_id:third.id});
await act(async()=>{tree=Renderer.create(React.createElement(App));});
assert.match(text(priceButton()),/Sample Vendor.*16\.75/,'an approved but incomparable $1 volume pack cannot enter the weight ranking');
assert.equal(priceButton().props['aria-description'],'3 vendors quote this item');
await selectHoney('Third Vendor');
assert.equal(honeyPlus().props.disabled,true,'the incompatible offer remains visible with a comparison hold');
assert.match(priceButton().props.title,/comparison measurement/);
await selectHoney('Sample Vendor');
await act(async()=>honeyPlus().props.onClick());
assert.match(text(aside()),/Sample Vendor.*1 each × \$16\.75/,'the comparable weight offer remains orderable');
await act(async()=>tree.unmount());
console.log('PASS C2.5 approved product links keep incomparable purchasing packs visible without affecting ranking.');

store.delete('kerdos.basket.org');
snapshot.mappings.splice(snapshot.mappings.findIndex(mapping=>mapping.vendor_item_id===incompletePeer.id),1);
queryRecords=table=>table==='catalog_items'?{
 update:patch=>({eq:async(field,id)=>{
  assert.equal(field,'id');
  assert.equal(id,'ci1');
  Object.assign(catalogItems.find(item=>item.id===id),patch);
  return {data:[],error:null};
 }})
}:emptyQuery();
await act(async()=>{tree=Renderer.create(React.createElement(App));});
assert.equal(honeyPlus().props.disabled,true,'equal competing dimensions hold automatic purchasing');
const goTo=async label=>await act(async()=>tree.root.findByProps({'aria-label':'Workspace tabs'}).findAllByType('button').find(button=>text(button)===label).props.onClick());
await goTo('Item Catalog');
const productDetails=tree.root.findAllByType('button').find(button=>text(button)==='Product details');
await act(async()=>productDetails.props.onClick());
const details=tree.root.findAllByProps({className:'catalog-product-summary'}).find(row=>text(row).includes('Honey Mustard'));
await act(async()=>details.props.onClick());
const comparisonUnit=tree.root.findByProps({'aria-label':'Compare per for Honey Mustard'});
const units=comparisonUnit.findAllByType('option').map(option=>option.props.value);
assert.ok(units.includes('LB')&&units.includes('GAL'),'both quoted pack dimensions can be chosen');
await act(async()=>comparisonUnit.props.onChange({target:{value:'LB'}}));
assert.equal(catalogItems.find(item=>item.id==='ci1').canonical_unit,'LB');
await goTo('Order Guide');
assert.equal(honeyPlus().props.disabled,false,'the saved comparison preference resolves the tie');
assert.match(text(priceButton()),/Sample Vendor.*16\.75/);
await act(async()=>tree.unmount());
console.log('PASS C2.5 a comparison tie can be resolved through the existing Item Catalog preference.');

store.delete('kerdos.basket.org');
delete catalogItems.find(item=>item.id==='ci1').canonical_unit;
Object.assign(expiring,{pack_size:'10000 CT',selling_unit:'CASE',price_basis:'case',price:10});
Object.assign(third,{pack_size:'20000 CT',selling_unit:'CASE',price_basis:'case',price:19.99});
await act(async()=>{tree=Renderer.create(React.createElement(App));});
assert.match(text(priceButton()),/Third Vendor.*19\.99/,'a difference below display precision still determines the winner');
await act(async()=>honeyPlus().props.onClick());
await act(async()=>honeyPlus().props.onClick());
assert.match(text(aside()),/Third Vendor.*2 cases × \$19\.99.*39\.98/,'the basket retains the winning vendor’s stated case price');
await act(async()=>tree.unmount());
console.log('PASS C2.5 unit-cost comparison retains precision through the Order Guide and basket.');

snapshot.vendors.find(vendor=>vendor.id===third.vendor_id).delivery_minimum_dollar=50;
await act(async()=>{tree=Renderer.create(React.createElement(App));});
assert.match(text(aside()),/Third Vendor.*2 cases × \$19\.99.*39\.98/,'automatic minimum handling retains both 20,000-piece cases');
assert.match(text(aside()),/10\.02 to go/,'the remaining minimum is visible when only a smaller pack could be substituted');
await selectHoney('Sample Vendor');
assert.match(text(aside()),/Sample Vendor.*2 cases × \$10\.00.*20\.00/,'an explicit supplier selection may still change the pack');
await act(async()=>tree.unmount());
console.log('PASS G minimum handling retains the ordered pack unless the client changes the supplier.');






console.log('PASS G actual App: three-offer normalized winner, incomplete cheap peer held, whole-pack basket charge and locked supplier minimum shortfall');
console.log('PASS rendered complete Order Guide: existing item numbers, canonical A–Z names, held group rows, vendor choices and disabled ordering without manufactured approvals.');
`);
 process.stdout.write(execFileSync(process.execPath,[runner],{encoding:'utf8',env:process.env}));
}finally{rmSync(dir,{recursive:true,force:true});}
