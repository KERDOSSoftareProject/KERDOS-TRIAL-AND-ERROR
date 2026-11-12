import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
const dir=mkdtempSync(join(process.cwd(),'node_modules/.catalog-base-'));
try{
 const outfile=join(dir,'test.mjs');
 await build({stdin:{contents:String.raw`
 import React from 'react';import Renderer,{act} from 'react-test-renderer';import assert from 'node:assert/strict';
 import {CatalogRows} from './src/pages/CatalogRows.jsx';import {ItemCatalogPanel} from './src/pages/ItemCatalogPanel.jsx';import {configureProcurement} from './src/procurement.js';
 configureProcurement({industry:'restaurant'});
 const org='00000000-0000-0000-0000-000000000001',one='00000000-0000-0000-0000-000000000011',two='00000000-0000-0000-0000-000000000012';
 const catalogItems=[{id:one,name:'Honey Mustard',master_item_number:50013,category_id:'general'},{id:two,name:'Cheddar',master_item_number:100001,category_id:'dairy'}];
 const vendorItems=[{id:'coded',organization_id:org,vendor_id:'vendor',vendor_item_code:'HM1',description:'DRESS HONEY MUSTARD',brand:'Original brand',pack_size:'4/1 GAL',selling_unit:'CASE',price_basis:'case',price:74.89,row_revision:3,field_resolutions:{}},{id:'uncoded',organization_id:org,vendor_id:'vendor2',vendor_item_code:null,nvim_number:69,description:'HONEY MUSTARD',brand:null,pack_size:null,selling_unit:null,price_basis:null,price:77.32,row_revision:5,field_resolutions:{}}];
 const mappings=vendorItems.map(v=>({id:'map-'+v.id,organization_id:org,vendor_item_id:v.id,catalog_item_id:one,comparison_track:'review',confidence_score:70,match_method:'product_group'}));
 const vendors=[{id:'vendor',name:'First vendor'},{id:'vendor2',name:'Second vendor'}],categories=[{id:'general',name:'General',industry:'restaurant',keywords:[]},{id:'dairy',name:'Dairy',industry:'restaurant',keywords:[]}];
 const items=[{catalogItemId:one,name:'Honey Mustard',masterItemNumber:50013,category:'General',options:[]}];
 const props={orgId:org,industry:'restaurant',items,catalogItems,vendorItems,mappings,vendors,categories,vocabulary:[],canManage:true,onUpdated:async()=>{},onDetails:()=>{}};
 const before=JSON.stringify({vendorItems,mappings,catalogItems});const calls=[];let fail=false;
 globalThis.__catalogBaseBackend={records:{query(){throw Error('Unexpected data query');}},catalog:{saveRow:async request=>{if(fail)throw Error('Listing changed; refresh');calls.push(request);}}};
 let tree;await act(async()=>{tree=Renderer.create(React.createElement(CatalogRows,props));});
 await act(async()=>tree.root.findByProps({'aria-label':'Brand for HM1'}).props.onChange({target:{value:'Unapplied brand draft'}}));
 await act(async()=>tree.update(React.createElement(CatalogRows,{...props,baseFieldsOnly:true})));
 assert.equal(tree.root.findAllByProps({'data-blank-trial-field':'brand'}).length,2);assert.equal(tree.root.findAllByProps({'data-blank-trial-field':'pack'}).length,2);assert.equal(tree.root.findAllByProps({'data-blank-trial-field':'sellingUnit'}).length,0);assert.equal(tree.root.findAllByProps({'data-blank-trial-field':'unitCost'}).length,2);
 assert.equal(tree.root.findAllByProps({'aria-label':'Brand for HM1'}).length,0);assert.ok(!JSON.stringify(tree.toJSON()).includes('70%'));assert.ok(!JSON.stringify(tree.toJSON()).includes('90%'));
 assert.match(JSON.stringify(tree.toJSON()),/NVIN-69/);assert.doesNotMatch(JSON.stringify(tree.toJSON()),/Confirmed group|Provisional group/);assert.equal(calls.length,0);
 const text=n=>typeof n==='string'?n:(n?.children||[]).map(text).join('');
 const rowFor=label=>{let n=tree.root.findByProps({'aria-label':label});while(n&&n.type!=='tr')n=n.parent;return n;};
 const apply=async label=>{const row=rowFor(label);await act(async()=>row.findAllByType('button').find(b=>text(b)==='Apply').props.onClick());};
 await act(async()=>tree.root.findByProps({'aria-label':'price for null'}).props.onChange({target:{value:'2.29'}}));await apply('price for null');
 assert.deepEqual(calls.at(-1).patch,{price:2.29});assert.equal(calls.at(-1).priceBasis,null);assert.equal(calls.at(-1).priceAvailable,false);assert.equal(tree.root.findAllByProps({'aria-label':'Override unit cost'}).length,0);
 await act(async()=>tree.root.findByProps({'aria-label':'price for HM1'}).props.onChange({target:{value:'70.00'}}));await apply('price for HM1');assert.deepEqual(calls.at(-1).patch,{price:70});assert.equal(calls.at(-1).expectedRevision,3);
 await act(async()=>rowFor('price for null').findByProps({'aria-label':'Item name for 50013'}).props.onChange({target:{value:'Cheddar'}}));
 assert.equal(text(tree.root.findByProps({'aria-label':'KERDOS item number for null'})),'#100001');assert.equal(tree.root.findByProps({'aria-label':'Category for null'}).props.value,'dairy');await apply('price for null');assert.deepEqual(calls.at(-1).patch,{catalog_item_id:two});
 await act(async()=>tree.update(React.createElement(CatalogRows,props)));assert.equal(tree.root.findByProps({'aria-label':'Brand for HM1'}).props.value,'Unapplied brand draft');assert.equal(tree.root.findByProps({'aria-label':'Pack for HM1'}).props.value,'case');
 await act(async()=>tree.update(React.createElement(CatalogRows,{...props,baseFieldsOnly:true})));fail=true;await act(async()=>tree.root.findByProps({'aria-label':'price for HM1'}).props.onChange({target:{value:'69'}}));const count=calls.length;await apply('price for HM1');assert.equal(calls.length,count);assert.match(JSON.stringify(tree.toJSON()),/Listing changed; refresh/);
 await act(async()=>tree.update(React.createElement(CatalogRows,{...props,baseFieldsOnly:true,canManage:false})));assert.equal(tree.root.findByProps({'aria-label':'product for HM1'}).props.disabled,true);assert.equal(tree.root.findAllByType('button').filter(b=>text(b)==='Apply').length,0);await act(async()=>tree.unmount());
 assert.equal(JSON.stringify({vendorItems,mappings,catalogItems}),before);
 const panelProps={...props,productList:items,role:'owner',userId:'owner',onUpdated:async()=>{}};await act(async()=>{tree=Renderer.create(React.createElement(ItemCatalogPanel,panelProps));});
 const button=label=>tree.root.findAllByType('button').find(b=>text(b)===label);
 assert.ok(button('Base fields trial'));await act(async()=>button('Base fields trial').props.onClick());assert.ok(tree.root.findByProps({'data-catalog-base-trial':true}));assert.ok(button('Full catalog'));await act(async()=>button('Full catalog').props.onClick());assert.ok(tree.root.findByProps({'data-catalog-base-trial':false}));await act(async()=>tree.unmount());
 const cheese={id:'cheese',name:'American Cheese',master_item_number:30079,category_id:'dairy'};
 const cheeseListings=[16.75,54.90,65.64].map((price,index)=>({
   id:'cheese-'+index,organization_id:org,vendor_id:'cheese-vendor-'+index,vendor_item_code:'AC'+index,
   description:'AMERICAN CHEESE',price,pack_size:'4/5 LB',selling_unit:'CASE',price_basis:'case',
   import_row:{sourceDocumentId:'cheese-source-'+index,row:index?{price,packSize:'4/5 LB',sellingUnit:'CASE'}:{price,description:'AMERICAN CHEESE 5 lb.'}}
 }));
 const cheeseProps={...props,catalogItems:[cheese],items:[{catalogItemId:cheese.id,name:cheese.name,options:[]}],
   vendorItems:cheeseListings,vendors:cheeseListings.map(row=>({id:row.vendor_id,name:row.vendor_id})),
   mappings:cheeseListings.map(row=>({id:'map-'+row.id,vendor_item_id:row.id,catalog_item_id:cheese.id,comparison_track:'exact',confidence_score:100})),
   autoSave:true,baseFieldsOnly:true};
 await act(async()=>{tree=Renderer.create(React.createElement(CatalogRows,cheeseProps));});
 assert.equal(tree.root.findByProps({'aria-label':'Pack for AC0'}).props.value,'each');
 assert.equal(tree.root.findByProps({'aria-label':'Amount in each for AC0'}).props.value,5);
 assert.equal(text(tree.root.findByProps({'aria-label':'Calculated unit cost for AC0'})),'$3.35');
 assert.equal(rowFor('Pack for AC0').findByProps({'data-field-label':'Pack'}).props['data-catalog-review-field'],true);
 assert.doesNotMatch(text(rowFor('Pack for AC0')),/Inferred (?:pack|price per)/);
 const confirmButton=rowFor('Pack for AC0').findByProps({'aria-label':'Confirm pack and quoted unit'});
 assert.equal(text(confirmButton),'Confirm');
 assert.equal(confirmButton.props.style.border,'1px solid #1565C0');
 assert.equal(confirmButton.props.style.padding,'4px 8px');
 assert.equal(confirmButton.parent.props['data-field-label'],'Item name');
 await act(async()=>tree.update(React.createElement(CatalogRows,{...cheeseProps,vendorItems:cheeseListings.map((row,index)=>index===1?{...row,price:100}:row)})));
 assert.equal(tree.root.findByProps({'aria-label':'Pack for AC0'}).props.value,'','a changed group price removes the unsupported inference');
 await act(async()=>tree.unmount());
 const blankUnit={...cheeseListings[0],id:'blank-unit',vendor_id:'blank',vendor_item_code:'AC3',selling_unit:null,price_basis:null,
  import_row:{sourceDocumentId:'blank-source',rowKey:'row-1',row:{price:16.75,packSize:'4/5 LB'}}};
 const noPrice={...cheeseListings[1],id:'no-price',vendor_id:'held',vendor_item_code:'AC4',price:null};
 const confirmListings=[cheeseListings[0],blankUnit,noPrice];
 blankUnit.import_row.baseFieldCompletion={fields:{pack_size:{value:'4/5 LB'}}};
 noPrice.import_row={...noPrice.import_row,baseFieldCompletion:{fields:{pack_size:{value:'4/5 LB'}}}};
 fail=false;
 const confirmProps={...cheeseProps,vendorItems:confirmListings,
  vendors:confirmListings.map(row=>({id:row.vendor_id,name:row.vendor_id})),
  mappings:confirmListings.map(row=>({id:'map-'+row.id,organization_id:org,vendor_item_id:row.id,catalog_item_id:cheese.id,comparison_track:'exact',confidence_score:100})),
  onDetails:()=>assert.fail('Confirm must stay in the editor')};
 await act(async()=>{tree=Renderer.create(React.createElement(CatalogRows,confirmProps));});
 const confirmFor=code=>rowFor('Pack for '+code).findByProps({'aria-label':'Confirm listing '+code});
 assert.equal(rowFor('Pack for AC3').props['data-migration-tier'],3);
 const beforeChoice=calls.length;
 await act(async()=>confirmFor('AC3').props.onClick());
 await act(async()=>rowFor('Pack for AC3').findByProps({'aria-label':'Quoted unit'}).props.onChange({target:{value:'CASE'}}));
 assert.equal(calls.length,beforeChoice,'choosing a value stages the edit');
 await act(async()=>confirmFor('AC3').props.onClick());
 assert.deepEqual(calls.at(-1).patch,{description:'AMERICAN CHEESE',brand:'',pack_size:'4/5 LB',selling_unit:'CASE',price:16.75,approve_row:true});
 const accepted={...blankUnit,selling_unit:'CASE',price_basis:'case',row_revision:1,
  field_resolutions:{selling_unit:{value:'CASE',confirmedBy:'owner'}}};
 await act(async()=>tree.update(React.createElement(CatalogRows,{...confirmProps,vendorItems:[cheeseListings[0],accepted,noPrice]})));
 assert.equal(rowFor('Pack for AC3').props['data-migration-tier'],1);
 await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:true}}));
 await act(async()=>rowFor('Pack for AC3').findByProps({'aria-label':'Edit pricing basis for AC3'}).props.onClick());
 assert.equal(rowFor('Pack for AC3').findByProps({'aria-label':'Quoted unit'}).props.value,'CASE');
 await act(async()=>rowFor('Pack for AC3').findByProps({'aria-label':'Quoted unit'}).props.onChange({target:{value:'EACH'}}));
 assert.equal(calls.length,beforeChoice+1);
 await act(async()=>tree.root.findByType('details').props.onToggle({currentTarget:{open:false}}));
 assert.deepEqual(calls.at(-1).patch,{selling_unit:'EACH'});

 assert.equal(rowFor('Pack for AC4').props['data-migration-tier'],4);
 await act(async()=>confirmFor('AC4').props.onClick());
 assert.match(text(rowFor('Pack for AC4')),/Enter the product description and quoted price/);
 assert.equal(calls.length,beforeChoice+2,'incomplete rows stay in review without a write');
 await act(async()=>tree.unmount());
 console.log('PASS base catalog trial: visible switch; blank later columns; vendor code/NVIN; editable source fields; dollar-only save without units or blanket approval; reassignment follows group number/category; hidden drafts/full view retained; errors/roles; unchanged source snapshots.');
 `,resolveDir:process.cwd(),sourcefile:'catalog-base-test.mjs',loader:'js'},outfile,bundle:true,platform:'node',format:'esm',jsx:'automatic',external:['react','react-dom','react-test-renderer'],logLevel:'silent',plugins:[{name:'base-backend',setup(b){b.onResolve({filter:/backend\/index\.js$/},()=>({path:'backend',namespace:'base'}));b.onLoad({filter:/.*/,namespace:'base'},()=>({contents:'export const backend={records:{query:(...args)=>globalThis.__catalogBaseBackend.records.query(...args)},catalog:{saveRow:(...args)=>globalThis.__catalogBaseBackend.catalog.saveRow(...args)}};'}));}}]});
 process.stdout.write(execFileSync(process.execPath,[outfile],{encoding:'utf8',timeout:60000}));
}finally{rmSync(dir,{recursive:true,force:true});}
