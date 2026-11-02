import {build} from 'esbuild';
import {mkdtempSync,rmSync} from 'node:fs';
import {execFileSync} from 'node:child_process';
import {join} from 'node:path';
const dir=mkdtempSync(join(process.cwd(),'node_modules/.restored-catalog-'));
try{
 const outfile=join(dir,'rows.mjs');
 await build({stdin:{contents:String.raw`
 import React from 'react';import Renderer,{act} from 'react-test-renderer';import assert from 'node:assert/strict';
 import {CatalogRows} from './src/pages/CatalogRows.jsx';import {CATALOG_COLUMNS} from './src/core/catalog-fields.js';import {configureProcurement} from './src/procurement.js';
 configureProcurement({industry:'restaurant'});
 const catalogItems=[{id:'h',name:'DRESS HONEY MUSTARD',master_item_number:50013,category_id:'cat'},{id:'a',name:'avocado',master_item_number:30001,category_id:'cat'}];
 const vendorItems=[{id:'h2',vendor_id:'b',vendor_item_code:'H2',description:'Z HONEY MUSTRD VENDOR WORDING',brand:'Brand B',pack_size:'4/3 L',selling_unit:'CASE',price:22,field_resolutions:{}},{id:'a1',vendor_id:'a',vendor_item_code:'A1',description:'AVOCADO HASS 48CT',brand:'Packer',pack_size:'48 CT',selling_unit:'CASE',price:25,field_resolutions:{}},{id:'h1',vendor_id:'a',vendor_item_code:'H1',description:'A HONEY MUSTARD VENDOR WORDING',brand:'Brand A',pack_size:'4/1 GAL',selling_unit:'CASE',price:20,field_resolutions:{}}];
 const mappings=vendorItems.map(v=>({id:'m'+v.id,vendor_item_id:v.id,catalog_item_id:v.id[0],comparison_track:'review',confidence_score:70}));
 const props={orgId:'org',industry:'restaurant',items:catalogItems.map(i=>({catalogItemId:i.id})),catalogItems,vendorItems,mappings,vendors:[{id:'a',name:'Alpha Supplier'},{id:'b',name:'Beta Supplier'}],categories:[{id:'cat',name:'Dry Goods',industry:'restaurant',keywords:[]}],vocabulary:[],canManage:true,onUpdated:async()=>{},onDetails:()=>{}};
 const original=JSON.stringify(props);let tree;await act(async()=>{tree=Renderer.create(React.createElement(CatalogRows,props));});
 const groups=()=>tree.root.findAll(n=>n.type==='details'&&n.props['data-catalog-group']);
 assert.deepEqual(groups().map(n=>n.props['data-catalog-group']),['a','h'],'KERDOS groups are alphabetical');
 assert.ok(groups().every(n=>n.props.open===false),'all groups start collapsed');
 const table=tree.root;
 await act(async()=>groups()[1].props.onToggle({currentTarget:{open:true}}));assert.equal(groups()[1].props.open,true);assert.equal(groups()[0].props.open,false,'groups open independently');
 const text=n=>typeof n==='string'?n:(n?.children||[]).map(text).join('');
 const headers=table.findAllByType('thead')[0].findAllByType('th').map(text);for(const [,label] of CATALOG_COLUMNS)assert.ok(headers.some(h=>h.startsWith(label)),label+' column retained');assert.ok(headers.includes('Actions'));assert.ok(headers.includes('Select'));
 const names=table.findAllByType('input').filter(n=>String(n.props['aria-label']||'').startsWith('Item name for '));assert.deepEqual(names.map(n=>n.props.value),['Avocados','Honey Mustard','Honey Mustard']);
 const numbers=table.findAll(n=>n.type==='span'&&String(n.props['aria-label']||'').startsWith('KERDOS item number for ')).map(text);assert.deepEqual(numbers,['#30001','#50013','#50013']);
 assert.equal(table.findAllByType('button').filter(n=>text(n)==='Apply').length,3,'each original row Apply action retained');
 for(const code of ['A1','H1','H2'])for(const field of ['Category','Pack','Quoted per','Unit cost metric'])assert.ok(table.findAll(n=>String(n.props['aria-label']||'').startsWith(field+' for '+code)).length,field+' control retained for '+code);
 const priceInput=()=>tree.root.findByProps({'aria-label':'price for H1'});
 await act(async()=>priceInput().props.onChange({target:{value:'19.50'}}));
 await act(async()=>groups()[1].props.onToggle({currentTarget:{open:false}}));
 await act(async()=>groups()[1].props.onToggle({currentTarget:{open:true}}));
 assert.equal(String(priceInput().props.value),'19.50','unsaved edits survive collapse and reopen');
 assert.equal(JSON.stringify(props),original,'grouping the view must not edit source fields, mappings or prices');
 const select=table.findByProps({'aria-label':'Select A HONEY MUSTARD VENDOR WORDING for alternatives'});await act(async()=>select.props.onChange());assert.ok(tree.root.findAllByType('button').some(n=>text(n)==='Associate selected (1)'),'existing selection action remains available');
 assert.equal(tree.root.findAll(n=>n.type==='h3'&&text(n)==='Product groups').length,0,'experimental group list cannot replace the main table');
 await act(async()=>tree.unmount());console.log('PASS grouped catalog: alphabetical collapsed KERDOS groups, independent expansion, original columns/source rows/controls, drafts preserved on collapse, selection and unchanged data.');
 `,resolveDir:process.cwd(),sourcefile:'restored-catalog-test.mjs',loader:'js'},outfile,bundle:true,platform:'node',format:'esm',jsx:'automatic',external:['react','react-dom','react-test-renderer'],logLevel:'silent'});
 process.stdout.write(execFileSync(process.execPath,[outfile],{encoding:'utf8',env:process.env}));
}finally{rmSync(dir,{recursive:true,force:true});}
