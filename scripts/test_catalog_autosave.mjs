import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
const dir=mkdtempSync(join(process.cwd(),'node_modules/.catalog-autosave-'));
try{
 await build({stdin:{contents:String.raw`
import React from 'react';import Renderer,{act} from 'react-test-renderer';import assert from 'node:assert/strict';
import {CatalogRows} from './src/pages/CatalogRows.jsx';import {ItemCatalogPanel} from './src/pages/ItemCatalogPanel.jsx';import {configureProcurement} from './src/procurement.js';import {orderGuideAssessment} from './src/core/catalog-fields.js';
configureProcurement({industry:'restaurant'});
const cache=new Map();globalThis.window={localStorage:{getItem:k=>cache.get(k)||null,setItem:(k,v)=>cache.set(k,v)}};
const org='00000000-0000-0000-0000-000000000001',id='00000000-0000-0000-0000-000000000011';
const item={id,name:'Honey Mustard',master_item_number:50013,category_id:'general',category_reason:'confirmed'};
const row={id:'vi',organization_id:org,vendor_id:'vendor',vendor_item_code:'000012',description:'HONEY MUSTARD',brand:'Original',pack_size:null,selling_unit:null,price_basis:null,price:2.29,price_unavailable:true,price_source:'price_list',last_updated:'2026-11-04',row_revision:1,field_resolutions:{}};
const mapping={id:'mapping',organization_id:org,vendor_item_id:row.id,catalog_item_id:id,comparison_track:'exact',confidence_score:100,match_method:'manual'};
const category={id:'general',name:'General',range_start:50000,range_end:59999,keywords:[]};
let current=structuredClone(row),fail=false,calls=[],refreshes=0;
globalThis.__autosaveBackend={records:{query(){throw Error('Unexpected read');}},catalog:{saveRow:async request=>{
 if(fail)throw Error('Offline: edits not saved');assert.equal(request.expectedRevision,current.row_revision,'each edit uses the latest accepted revision');calls.push(request);
 for(const [key,value]of Object.entries(request.patch)){current[key]=value;current.field_resolutions[key]={value,confirmedBy:'owner'};}
 current.price_basis=request.priceBasis;current.price_unavailable=!request.priceAvailable;current.row_revision++;return structuredClone(current);
}}};
const props={autoSave:true,userId:'owner',baseFieldsOnly:true,orgId:org,industry:'restaurant',items:[{catalogItemId:id}],catalogItems:[item],vendorItems:[row],mappings:[mapping],vendors:[{id:'vendor',name:'Supplier'}],categories:[category,{id:'dairy',name:'Dairy',range_start:30000,range_end:39999}],vocabulary:[],canManage:true,onUpdated:async()=>{refreshes++;},onDetails:()=>{}};
let tree;const mount=async more=>{await act(async()=>{tree=Renderer.create(React.createElement(CatalogRows,{...props,...more}));});};
const input=label=>tree.root.findByProps({'aria-label':label});const change=async(label,value)=>{await act(async()=>input(label).props.onChange({target:{value}}));};
const settle=async()=>{await act(async()=>{await new Promise(r=>setTimeout(r,850));});};
const text=n=>typeof n==='string'?n:(n?.children||[]).map(text).join('');
await mount();assert.equal(calls.length,0);assert.equal(tree.root.findAllByType('button').filter(b=>/^(Apply|Save)$/.test(text(b))).length,0);assert.ok(!tree.root.findAllByType('th').some(n=>text(n)==='Actions'));
assert.equal(tree.root.findAll(n=>String(n.props['aria-label']||'').startsWith('Group for')).length,0);assert.ok(!JSON.stringify(tree.toJSON()).includes('Confirmed group'));assert.ok(!JSON.stringify(tree.toJSON()).includes('Provisional group'));
assert.equal(input('brand for 000012').props.value,'');assert.equal(input('brand for 000012').props.placeholder,'No brand');assert.equal(input('brand for 000012').props.disabled,false);assert.equal(input('Pack for 000012').props.value,'');assert.equal(text(input('Calculated unit cost for 000012')),'');assert.equal(tree.root.findAllByProps({'aria-label':'Unit cost for 000012'}).length,0);
assert.ok(input('Category for 000012').findAllByType('option').some(n=>text(n)==='Dairy'),'established client category is available without industry tagging');
await change('brand for 000012','New brand');await change('brand for 000012','Final brand');await settle();assert.equal(calls.length,1);assert.deepEqual(calls[0].patch,{brand:'Final brand'});assert.match(JSON.stringify(tree.toJSON()),/Saved/);
await change('price for 000012','3.50');await settle();assert.equal(calls.length,2);assert.deepEqual(calls.at(-1).patch,{price:3.5});assert.equal(current.selling_unit,null);assert.equal(current.pack_size,null);assert.equal(current.price_unavailable,true);
assert.equal(orderGuideAssessment({item,vendorItem:current,mapping,vendor:props.vendors[0],category,categories:props.categories}).ready,false);
await change('Pack for 000012','case');await change('Count for 000012','4');await change('Amount in each for 000012','1');await change('Each measurement for 000012','GAL');await settle();assert.ok(calls.at(-1).patch.pack_size);assert.ok(!Object.hasOwn(calls.at(-1).patch,'approve_row'));
assert.equal(tree.root.findAllByProps({'aria-label':'Quoted per for 000012'}).length,0);
current={...current,selling_unit:'CASE',price_basis:'case',price_unavailable:false,row_revision:current.row_revision+1,field_resolutions:{...current.field_resolutions,selling_unit:{value:'CASE',confirmedBy:'owner'}}};
await act(async()=>tree.update(React.createElement(CatalogRows,{...props,vendorItems:[current]})));
assert.equal(text(input('Calculated unit cost for 000012')),'$0.88','stored case basis still calculates unit cost');
assert.equal(orderGuideAssessment({item,vendorItem:current,mapping,vendor:props.vendors[0],category,categories:props.categories}).ready,true);
assert.ok(refreshes>=3);
fail=true;await change('price for 000012','4.25');await settle();assert.match(JSON.stringify(tree.toJSON()),/Offline: edits not saved/);assert.equal(Number(input('price for 000012').props.value),4.25);assert.equal(current.price,3.5);
await act(async()=>tree.unmount());assert.ok([...cache.values()].some(v=>JSON.parse(v).draft.price==='4.25'));
await mount({vendorItems:[structuredClone(current)]});assert.equal(Number(input('price for 000012').props.value),4.25,'failed edits survive remount for the same user/client/listing');fail=false;await change('price for 000012','4.50');await settle();assert.equal(current.price,4.5);await act(async()=>tree.unmount());
await mount({userId:'another-user',vendorItems:[structuredClone(current)],canManage:false});assert.equal(Number(input('price for 000012').props.value),4.5);assert.equal(input('brand for 000012').props.disabled,true);const before=calls.length;await settle();assert.equal(calls.length,before);await act(async()=>tree.unmount());
await mount({vendorItems:[structuredClone(current)]});await change('price for 000012','5.00');await act(async()=>tree.unmount());await settle();assert.equal(current.price,4.5,'unmount cancels a pending delayed write');
cache.clear();await mount({vendorItems:[structuredClone(current)]});await change('price for 000012','6.25');await settle();const external={...structuredClone(current),price:6.50,row_revision:current.row_revision+1};current=external;await act(async()=>tree.update(React.createElement(CatalogRows,{...props,vendorItems:[external]})));assert.equal(Number(input('price for 000012').props.value),6.5,'a newer incoming revision replaces a clean accepted snapshot');await act(async()=>tree.unmount());await mount({vendorItems:[{...external,price:6.75,row_revision:external.row_revision+1}]});assert.ok(!JSON.stringify(tree.toJSON()).includes('Review your recovered edits'),'a clean persisted visibility marker is not an unsaved conflict');await act(async()=>tree.unmount());
cache.clear();current={...structuredClone(row),pack_size:'4/1 GAL',selling_unit:'CASE',price_basis:'case',price_unavailable:false,field_resolutions:{unit_cost_override:{value:{price:123,unit:'GAL',packPrice:492}}}};await mount({vendorItems:[structuredClone(current)]});await change('price for 000012','7.00');await settle();assert.equal(calls.at(-1).patch.unit_cost_override,null,'a changed price invalidates an old unit-cost override so cost can recalculate');await act(async()=>tree.unmount());
const panel={...props,role:'owner',productList:[{catalogItemId:id,name:item.name,category:'General',options:[]}],vendorItems:[structuredClone(current)]};await act(async()=>{tree=Renderer.create(React.createElement(ItemCatalogPanel,panel));});const button=label=>tree.root.findAllByType('button').find(n=>text(n)===label);await act(async()=>button('Base fields trial').props.onClick());assert.equal(tree.root.findAllByProps({'aria-label':'Item catalog actions'}).length,0,'base trial has no Actions menu');assert.equal(tree.root.findAllByType('button').filter(b=>text(b)==='Apply').length,0);await act(async()=>tree.unmount());
cache.clear();current={...structuredClone(row),brand:null,pack_size:'4/5 LB',selling_unit:'LB',price:2.41,import_row:{baseFieldCompletion:{fields:{brand:{value:null,status:'not-stated'},pack_size:{value:'4/5 LB',status:'stated'},selling_unit:{value:null,status:'not-stated'}}}}};await mount({vendorItems:[structuredClone(current)]});assert.equal(input('brand for 000012').props.placeholder,'No brand');assert.equal(input('Pack for 000012').props.value,'case');assert.equal(text(input('Calculated unit cost for 000012')),'','source trial cannot calculate from an older inferred unit');await act(async()=>tree.unmount());
cache.clear();current={...structuredClone(row),brand:null,pack_size:null,selling_unit:null,price:60,import_row:{baseFieldCompletion:{fields:{brand:{value:'Example Brand',status:'shared'},pack_size:{value:'6/#10 CN',status:'stated',caseCountKnown:true},selling_unit:{value:'CASE',status:'stated'}}}}};const countBeforeSource=calls.length;await mount({vendorItems:[structuredClone(current)]});assert.equal(input('brand for 000012').props.value,'Example Brand');assert.equal(input('Pack for 000012').props.value,'case');assert.equal(text(input('Calculated unit cost for 000012')),'$10.00');assert.equal(calls.length,countBeforeSource,'source trial display performs no save on mount');await act(async()=>tree.unmount());
cache.clear();current={...structuredClone(row),pack_size:'5 LB',selling_unit:'CASE',import_row:{baseFieldCompletion:{fields:{pack_size:{value:'5 LB',status:'shared',caseCountKnown:false},selling_unit:{value:'CASE',status:'shared'}}}}};await mount({vendorItems:[structuredClone(current)]});assert.equal(text(input('Calculated unit cost for 000012')),'','a weight-only fallback does not supply a missing case count');await act(async()=>tree.unmount());
cache.clear();current={...structuredClone(row),vendor_item_code:'THYME',description:'1LB (COL)',price:99,import_row:{baseFieldCompletion:{trialIdentifier:{label:'NVIM-332'},fields:{description:{value:'THYME 1LB (COL)'},price:{value:11.5},pack_size:{value:'1 LB',caseCountKnown:false},selling_unit:{value:'EACH'}}}}};const sourceSnapshot=JSON.stringify(current),sourceCalls=calls.length;
await mount({vendorItems:[structuredClone(current)]});assert.match(JSON.stringify(tree.toJSON()),/NVIN-332/);assert.equal(input('product for THYME').props.value,'THYME 1LB (COL)');assert.equal(Number(input('price for THYME').props.value),11.5);assert.equal(text(input('Calculated unit cost for THYME')),'$11.50');await act(async()=>tree.unmount());
await mount({baseFieldsOnly:false,vendorItems:[structuredClone(current)]});assert.equal(input('product for THYME').props.value,'1LB (COL)');assert.equal(Number(input('price for THYME').props.value),99);assert.ok(!JSON.stringify(tree.toJSON()).includes('NVIN-332'),'trial identifier does not leak into full catalog');await act(async()=>tree.unmount());assert.equal(calls.length,sourceCalls);assert.equal(JSON.stringify(current),sourceSnapshot,'reading the trial never rewrites the full listing');
cache.clear();current={...structuredClone(row),description:'STEEL WASHERS',pack_size:'4/10 LB',selling_unit:'CASE',price_basis:'case',price:81,price_unavailable:false,
 import_row:{row:{sellingUnit:null},reviewRequired:true,evidence:{sellingUnitSource:'inferred',fieldInference:{sellingUnit:{source:'cross-vendor comparison',value:'CASE',accuracy:70,reason:'Compared with two confirmed vendor quotes'}}},baseFieldCompletion:{fields:{pack_size:{value:'4/10 LB',status:'stated',caseCountKnown:true},selling_unit:{value:null,status:'not-stated'}}}}};
await mount({vendorItems:[structuredClone(current)]});
assert.equal(orderGuideAssessment({item,vendorItem:current,mapping,vendor:props.vendors[0],category,categories:props.categories}).ready,false);
assert.equal(current.import_row.row.sellingUnit,null,'viewing the listing preserves the vendor original');
await act(async()=>tree.unmount());
current={...current,field_resolutions:{price:{value:81,confirmedBy:'owner'}}};
await mount({baseFieldsOnly:false,vendorItems:[structuredClone(current)],editors:{owner:{name:'Kai Morgan',email:'orders@example.com'}}});
const priceCell=tree.root.find(n=>n.type==='td'&&n.props['data-field-label']==='Quoted price');
assert.match(text(priceCell),/Kai Morgan/,'the catalog credits the person by name');
const costCell=tree.root.find(n=>n.type==='td'&&n.props['data-field-label']==='Unit cost');
assert.doesNotMatch(text(costCell),/per pounds/i,'the measurement selector provides the unit once');
await act(async()=>tree.unmount());
const tierBase={...row,pack_size:'4/1 GAL',price:20,price_unavailable:false,price_basis:'case',selling_unit:'CASE'};
const tierListings=[
 {...tierBase,id:'held',vendor_item_code:'A',price:null,import_row:{reviewRequired:true,changes:[{field:'description',before:'HONEY MUSTARD',after:'STEEL WASHERS'}]}},
 {...tierBase,id:'no-unit',vendor_item_code:'B',selling_unit:null,import_row:{rowKey:'B',sourceDocumentId:'doc',row:{price:20}}},
 {...tierBase,id:'inferred',vendor_item_code:'C',price_unavailable:true,import_row:{reviewRequired:true,reviewFields:['description','brand','pack_size','selling_unit','price'],conflicts:['Pricing basis "CASE" suggested but not confirmed'],evidence:{sellingUnitSource:'inferred'}}},
 {...tierBase,id:'full',vendor_item_code:'D',field_resolutions:{selling_unit:{value:'CASE',confirmedBy:'owner'}}},
];
await mount({baseFieldsOnly:false,vendorItems:tierListings,mappings:tierListings.map(v=>({...mapping,id:v.id,vendor_item_id:v.id}))});
const tierRows=tree.root.findAll(n=>n.type==='tr'&&n.props['data-migration-tier']!=null);
assert.deepEqual(tierRows.map(n=>n.props['data-migration-tier']),[1,2,3,4]);
assert.deepEqual(tierRows.map(n=>text(n.find(c=>c.type==='td'&&c.props['data-field-label']==='Item name'))),
  ['', 'Tier 2 · Inferred Migration','Tier 3 · No Unit Migration','Tier 4 · Client Required Migration']);
assert.ok(!tree.root.findAllByType('th').some(n=>text(n).includes('Quoted per')));

assert.deepEqual(tierRows.map(n=>n.props.style['--catalog-field-fill']),[undefined,'#EEF6FF','#DCEBFF','#C6DFFF']);
assert.deepEqual(tierRows.map(n=>n.findAllByType('td').filter(c=>c.props['data-catalog-review-field']).map(c=>c.props['data-field-label'])),[[],[],[],['Quoted price']]);
assert.match(tree.root.findByType('style').children.join(''),/\[data-catalog-review-field\] :is\(input, select\):enabled/,'only writable controls in the flagged field receive the fill');
for(const n of tierRows)assert.ok(n.findAllByType('td').every(cell=>!cell.props.style.backgroundColor),'surrounding cells stay neutral');
await act(async()=>tree.unmount());
console.log('PASS catalog autosave: unchanged columns, editable blank source fields, calculated unit cost, no group/status/action additions, established client categories, delayed partial writes, fresh revisions, no unit invention/blanket approval, readiness after field completion, persistent failed drafts, actor isolation, read-only roles and unmount cancellation.');
`,resolveDir:process.cwd(),sourcefile:'autosave-test.mjs',loader:'js'},outfile:join(dir,'test.mjs'),bundle:true,platform:'node',format:'esm',jsx:'automatic',external:['react','react-dom','react-test-renderer'],logLevel:'silent',plugins:[{name:'autosave-backend',setup(b){b.onResolve({filter:/backend\/index\.js$/},()=>({path:'backend',namespace:'autosave'}));b.onLoad({filter:/.*/,namespace:'autosave'},()=>({contents:'export const backend={records:{query:(...args)=>globalThis.__autosaveBackend.records.query(...args)},catalog:{saveRow:(...args)=>globalThis.__autosaveBackend.catalog.saveRow(...args)}};'}));}}]});
 process.stdout.write(execFileSync(process.execPath,[join(dir,'test.mjs')],{encoding:'utf8',timeout:60000}));
}finally{rmSync(dir,{recursive:true,force:true});}
