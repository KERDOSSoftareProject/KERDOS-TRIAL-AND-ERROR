// Render the actual Inbox import modal against stateful provider adapters.
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const directory=mkdtempSync(join(tmpdir(),'a1-resolution-'));
const source=String.raw`
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import assert from 'node:assert/strict';
import {createRecords} from './src/backend/records.js';
import {parseDocument} from './src/ingestion.js';
import {PasteModal} from './src/pages/ImportModal.jsx';
const csv='Code,Description,Pack,Price Unit,Price\nA1-R-001,Chicken Breast Boneless Skinless,1/10 LB,CASE,10\nA1-R-002,Beef Tenderloin Choice Cut,1/10 LB,,20\n';
const rows=parseDocument(csv).rows;
const org='org',vendor='vendor',doc='partial-document';
const items=rows.map((row,i)=>({id:'vi'+i,organization_id:org,vendor_id:vendor,vendor_item_code:row.code,
  description:row.description,pack_size:row.packSize,price:row.price,price_source:'price_list',selling_unit:'CASE',price_basis:'case',
  price_unavailable:i===1,import_row:{row,rowKey:'row:'+i,sourceDocumentId:doc,reviewRequired:i===1,
    evidence:{...row,sellingUnitSource:i===1?'inferred':'document'},conflicts:i===1?['Quoted unit is unresolved']:[]}}));
const catalogs=items.map((item,i)=>({id:'ci'+i,organization_id:org,name:item.description,category_id:'category',master_item_number:200000+i}));
const mappings=items.map((item,i)=>({id:'m'+i,organization_id:org,vendor_item_id:item.id,catalog_item_id:'ci'+i,comparison_track:'exact',confidence_score:100}));
const categories=[{id:'category',organization_id:org,name:'Meat',is_holding_pen:false,range_start:200000,range_end:299999}];
const document={id:doc,organization_id:org,vendor_id:vendor,document_kind:'pricelist',status:'partial',completed_keys:['row:0'],file_name:'mixed.csv',file_path:'original/mixed.csv'};
const quotes=[{id:'q0',organization_id:org,vendor_item_id:'vi0',source_document_id:doc,source_row_key:'row:0',source_line:rows[0].sourceLine}];
const calls=[];let finishes=0,reservations=0,uploads=0;
const tables={vendor_items:items,catalog_items:catalogs,item_mappings:mappings,catalog_categories:categories,import_documents:[document],price_history:quotes,invoices:[]};
const records=createRecords(async spec=>{
  const filters=spec.filters??[];const found=(tables[spec.table]??[]).filter(row=>filters.every(f=>f.operator!=='eq'||row[f.column]===f.value));
  if(spec.action==='update'){found.forEach(row=>Object.assign(row,spec.value));return {data:[],error:null};}
  if(spec.action==='insert')throw new Error('Review must not create a duplicate document or mapping');
  return {data:spec.cardinality==='maybeSingle'||spec.cardinality==='single'?found[0]??null:found,error:null};
});
globalThis.__resolutionBackend={records,documents:{upload:async()=>{uploads++;throw new Error('Original already retained');}},
 pricing:{applyQuote:async q=>{calls.push(q);assert.equal(q.vendorItemId,'vi1');
  Object.assign(items[1],{price:q.price,selling_unit:q.sellingUnit,price_basis:q.priceBasis,import_row:q.importRow,field_resolutions:q.fieldResolutions,price_unavailable:q.priceUnavailable});
  if(!quotes.some(row=>row.source_row_key===q.importRow.rowKey))quotes.push({organization_id:org,source_document_id:doc,source_row_key:q.importRow.rowKey,source_line:q.sourceLine});
  return 'vi1';}},catalog:{saveRow:async()=>{throw new Error('Unexpected catalog write');}}};
const text=node=>node.children.map(value=>typeof value==='string'?value:text(value)).join('');
async function open(){
 let tree;
 await act(async()=>{tree=Renderer.create(React.createElement(PasteModal,{vendors:[{id:vendor,name:'Test vendor'}],orgId:org,orgSettings:{},
  catalogItems:catalogs,categories,vendorItems:items,mappings,initialVendorId:vendor,initialMode:'pricelist',
  initialFiles:[new File([csv],'mixed.csv',{type:'text/csv'})],inboxImportDocumentId:doc,onClose:()=>{},onDone:()=>{},
  onBeforeSave:async()=>{reservations++;return true;},onFinished:()=>{finishes++;}}));});
 for(let i=0;i<60&&!tree.root.findAllByType('button').some(button=>text(button)==='Apply corrections');i++){
  await act(async()=>{await new Promise(resolve=>setTimeout(resolve,10));});
 }
 const next=tree.root.findAllByType('button').find(button=>text(button)==='Save Import →');
 assert.equal(next,undefined,'Inbox review must not require the upload-preview continuation');
 const save=()=>tree.root.findAllByType('button').find(button=>text(button)==='Apply corrections');
 assert.ok(save(),'Stored initial attachment must parse without upload/paste; controls: '+tree.root.findAllByType('button').map(text).join(' | '));
 return {tree,save};
}
let p=await open();
assert.equal(reservations,0);assert.equal(calls.length,0);assert.equal(uploads,0);
assert.ok(text(p.tree.root).includes('Previously saved progress is preserved'));
assert.ok(!text(p.tree.root).includes('saving automatically'));
assert.equal(p.tree.root.findAllByType('input').filter(input=>input.props.type==='file').length,0,'Inbox review must not show upload controls');
console.log('PASS retained attachment opens parsed with no reservation or upload');
await act(async()=>{await p.save().props.onClick();});
assert.equal(document.status,'partial');assert.deepEqual(document.completed_keys,['row:0']);
assert.equal(finishes,0);assert.equal(calls.length,0);assert.ok(items[1].import_row.reviewRequired);
console.log('PASS unresolved Save leaves row incomplete and cannot report attachment imported');
await act(async()=>p.tree.unmount());
p=await open();
const unit=p.tree.root.findAllByType('select').find(select=>select.props['aria-label']==='Quoted price per unit for Beef Tenderloin Choice Cut');
assert.ok(unit);assert.ok(!unit.props.disabled,'The uncertain quoted unit must remain editable even with an exact product mapping');
await act(async()=>unit.props.onChange({target:{value:'CASE'}}));
await act(async()=>{await p.save().props.onClick();});
assert.equal(document.id,doc);assert.equal(document.status,'complete');assert.deepEqual(document.completed_keys,['row:0','row:1']);
assert.equal(calls.length,1);assert.equal(calls[0].importRow.rowKey,'row:1');assert.equal(calls[0].sellingUnit,'CASE');
assert.equal(calls[0].importRow.row.sellingUnit,null);assert.equal(calls[0].importRow.evidence.sellingUnitSource,'manual');
assert.equal(items[1].import_row.reviewRequired,false);assert.equal(finishes,1);assert.equal(uploads,0);assert.equal(quotes.length,2);
assert.equal(document.file_name,'mixed.csv');assert.equal(document.file_path,'original/mixed.csv');
console.log('PASS reviewer unit resolution completes the same document and writes only the unresolved row');
await act(async()=>p.tree.unmount());
console.log('3/3 rendered Inbox resolution checks passed (local component evidence).');
process.exit(0);
`;
try{
 const outfile=join(directory,'test.mjs');
 await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'jsx'},outfile,bundle:true,platform:'node',format:'esm',jsx:'automatic',define:{'import.meta.env':'{}'},external:['xlsx','pdfjs-dist','tesseract.js'],plugins:[{name:'resolution-adapter',setup(b){
  b.onResolve({filter:/document-reader\.js$/},()=>({path:'reader',namespace:'stub'}));
  b.onLoad({filter:/reader/,namespace:'stub'},()=>({contents:'export async function fileToText(file){return file.text();}'}));
  b.onResolve({filter:/backend\/index\.js$/},()=>({path:'backend',namespace:'stub'}));
  b.onLoad({filter:/backend/,namespace:'stub'},()=>({contents:'export const backend={records:{query:(...a)=>globalThis.__resolutionBackend.records.query(...a)},pricing:{applyQuote:(...a)=>globalThis.__resolutionBackend.pricing.applyQuote(...a)},documents:{upload:(...a)=>globalThis.__resolutionBackend.documents.upload(...a)},catalog:{saveRow:(...a)=>globalThis.__resolutionBackend.catalog.saveRow(...a)}};'}));
 }}]});
 process.stdout.write(execFileSync(process.execPath,[outfile],{encoding:'utf8',timeout:20000}));
}finally{rmSync(directory,{recursive:true,force:true});}
