// Render production Manual Upload and run its actual handlers/parser/services.
// Persistence and browser file reading are simulated: local evidence only.
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'kerdos-b1-'));
const source=String.raw`
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import assert from 'node:assert/strict';
import {PasteModal} from './src/pages/ImportModal.jsx';
import {createPriceImportFixture} from './scripts/fixtures/price-import-backend.mjs';
const csv='Code,Description,Pack,Price Unit,Price\nB1-001,Chicken Breast Boneless Skinless,2/10 LB,CASE,41.25\n';
const invoice='INVOICE B1-INV-001\nDate: 10/27/2026\nItem,Description,Pack,Price Unit,Qty,Unit Price,Extended Price\nB1-001,Chicken Breast Boneless Skinless,2/10 LB,CASE,2,41.25,82.50';
const org='10000000-0000-0000-0000-000000000001';
const vendor='20000000-0000-0000-0000-000000000001';
const text=node=>typeof node==='string'?node:(node.children||[]).map(text).join('');
let passed=0;
function fixture(){
 const f=createPriceImportFixture({text:csv});f.uploads=[];f.invoices=[];f.backend.invoices={record:async(header,lines)=>{f.invoices.push({header,lines});return {id:"b1-invoice"};}};
 f.backend.documents={upload:async(path,file)=>{f.uploads.push({path,name:file.name,bytes:await file.text()});},remove:async()=>{}};
 globalThis.__b1Backend=f.backend;return f;
}
function file(name='B1_Prices.csv',content=csv){return {name,size:Buffer.byteLength(content),text:async()=>content};}
function writes(f){return f.invoices.length+f.uploads.length+f.calls.applyQuote.length+f.calls.insertImportDoc.length+f.calls.createMapping.length;}
async function open(initialVendorId=vendor,initialMode='pricelist'){
 let tree;const finished=[];
 await act(async()=>{tree=Renderer.create(React.createElement(PasteModal,{industry:'restaurant',vendors:[{id:vendor,name:'B1 Test Vendor'}],orgId:org,orgSettings:{},catalogItems:[],categories:[],vendorItems:[],mappings:[],onClose:()=>{},onDone:async()=>{},onFinished:v=>finished.push(v),initialVendorId,initialMode}));});
 return {tree,finished};
}
function button(p,label){return p.tree.root.findAllByType('button').find(b=>text(b)===label);}
async function upload(p,method,input=file()){
 if(method==='drop'){
  const surface=p.tree.root.find(n=>typeof n.props.onDrop==='function');
  await act(async()=>{await surface.props.onDrop({preventDefault(){},dataTransfer:{files:[input]}});await new Promise(r=>setTimeout(r,950));});
 }else{
  const picker=p.tree.root.find(n=>n.type==='input'&&n.props.type==='file');
  await act(async()=>{picker.props.onChange({target:{files:[input],value:'selected'}});await new Promise(r=>setTimeout(r,950));});
 }
}
async function save(p){
 await act(async()=>{button(p,'Save Import →').props.onClick();});
 for(let i=0;i<60&&!p.finished.length&&!JSON.stringify(p.tree.toJSON()).includes('already imported in full');i++){
  await act(async()=>{await new Promise(r=>setTimeout(r,10));});
 }
}
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
await check('drop previews exact filename and row count without any writes; cancel remains read-only',async()=>{
 const f=fixture(),p=await open();await upload(p,'drop');
 assert.ok(text(p.tree.toJSON()).includes('B1_Prices.csv'));
 assert.ok(text(p.tree.toJSON()).includes('1 product row read'));
 assert.equal(writes(f),0);assert.equal(button(p,'Save Import →').props.disabled,false);
 await act(async()=>{button(p,'Cancel').props.onClick();});assert.equal(writes(f),0);
 assert.ok(p.tree.root.find(n=>n.type==='input'&&n.props.type==='file'));p.tree.unmount();
});
await check('missing or invalid initial vendor cannot enable Save',async()=>{
 for(const initialVendor of ['', 'not-in-this-organization']){
  const f=fixture(),p=await open(initialVendor);await upload(p,'drop');
  assert.equal(button(p,'Save Import →').props.disabled,true);assert.equal(writes(f),0);
  const selector=p.tree.root.findByType('select');
  await act(async()=>{selector.props.onChange({target:{value:vendor}});});
  assert.equal(button(p,'Save Import →').props.disabled,false);assert.equal(writes(f),0);p.tree.unmount();
 }
});
await check('drop Save retains original and writes exact vendor/organization/document/catalog/price linkage',async()=>{
 const f=fixture(),p=await open();await upload(p,'drop');await save(p);
 assert.equal(p.finished.length,1,JSON.stringify(p.tree.toJSON()));
 assert.equal(f.uploads.length,1);assert.equal(f.uploads[0].bytes,csv);
 assert.ok(f.uploads[0].path.startsWith(org+'/'+vendor+'/'));
 assert.equal(f.calls.insertImportDoc.length,1);const doc=Object.values(f.importDocs)[0];
 assert.equal(doc.organization_id,org);assert.equal(doc.vendor_id,vendor);
 assert.equal(doc.document_kind,'pricelist');assert.equal(doc.file_name,'B1_Prices.csv');
 assert.equal(doc.file_path,f.uploads[0].path);assert.equal(doc.status,'complete');
 assert.deepEqual(doc.completed_keys,['row:0']);
 assert.equal(f.calls.applyQuote.length,1);assert.equal(f.calls.applyQuote[0].price,41.25);
 assert.equal(f.calls.applyQuote[0].organizationId,org);assert.equal(f.calls.applyQuote[0].vendorId,vendor);
 assert.equal(f.calls.applyQuote[0].sourceDocumentId,doc.id);assert.equal(f.calls.createMapping.length,1);
 p.tree.unmount();
 const replay=await open();await upload(replay,'picker');await save(replay);
 assert.ok(text(replay.tree.toJSON()).includes('already imported in full'));
 assert.equal(f.uploads.length,1);assert.equal(f.calls.insertImportDoc.length,1);
 assert.equal(f.calls.applyQuote.length,1);assert.equal(f.calls.createMapping.length,1);replay.tree.unmount();
});
await check('file picker follows the same preview and retained-original save path',async()=>{
 const f=fixture(),p=await open();await upload(p,'picker',file('B1_Picker.csv'));
 assert.equal(writes(f),0);assert.ok(text(p.tree.toJSON()).includes('B1_Picker.csv'));
 await save(p);assert.equal(p.finished.length,1);assert.equal(f.calls.applyQuote.length,1);
 assert.equal(Object.values(f.importDocs)[0].file_name,'B1_Picker.csv');assert.equal(f.uploads[0].bytes,csv);p.tree.unmount();
});
await check('reader failure is visible and cannot persist a document or quote',async()=>{
 const f=fixture(),p=await open();await upload(p,'picker',{name:'broken.csv',size:1,text:async()=>{throw Error('controlled read failure');}});
 assert.ok(text(p.tree.toJSON()).includes('controlled read failure'));assert.equal(writes(f),0);p.tree.unmount();
});
await check('invoice uploads record invoice charges and preserve their original without writing vendor quotes',async()=>{
 const f=fixture(),p=await open(vendor,'invoice');await upload(p,'picker',file('B1_Invoice.csv',invoice));
 assert.equal(writes(f),0);await save(p);
 assert.equal(f.invoices.length,1,JSON.stringify(p.tree.toJSON()));assert.equal(f.calls.applyQuote.length,0);
 assert.equal(f.invoices[0].header.organization_id,org);assert.equal(f.invoices[0].header.vendor_id,vendor);
 assert.equal(f.invoices[0].header.invoice_number,'B1-INV-001');assert.equal(f.invoices[0].header.file_name,'B1_Invoice.csv');
 assert.equal(f.invoices[0].header.file_path,f.uploads[0].path);assert.equal(f.invoices[0].lines[0].unit_price,41.25);
 assert.equal(f.invoices[0].lines[0].line_total,82.5);
 assert.equal(f.invoices[0].lines[0].quantity,2);assert.equal(f.invoices[0].lines[0].selling_unit,'CASE');
 assert.equal(f.invoices[0].lines[0].pack_size,'2/10 LB');assert.ok(f.invoices[0].lines[0].source_line.includes('B1-001'));
 assert.equal(f.invoices[0].lines[0].billing_unit_evidence.unit,'CASE');
 assert.equal(f.invoices[0].lines[0].billing_unit_evidence.kind,'pricing-unit-header');p.tree.unmount();
});
await check('failed original retention prevents invoice persistence and catalog side effects',async()=>{
 const f=fixture();f.backend.documents.upload=async()=>{throw Error('controlled storage failure');};
 const p=await open(vendor,'invoice');await upload(p,'picker',file('B1_Invoice.csv',invoice));await save(p);
 assert.ok(text(p.tree.toJSON()).includes('controlled storage failure'));
 assert.equal(f.invoices.length,0,'an invoice cannot be recorded after losing its source original');
 assert.equal(f.calls.createCatalog.length,0);assert.equal(f.calls.applyQuote.length,0);p.tree.unmount();
});
await check('an invoice in price-sheet mode is blocked rather than saved as vendor quotes',async()=>{
 const f=fixture(),p=await open();await upload(p,'drop',file('B1_Invoice.csv',invoice));await save(p);
 assert.ok(text(p.tree.toJSON()).includes('Document type mismatch'));assert.equal(writes(f),0);p.tree.unmount();
});
await check('failed price-sheet original retention also prevents quotes and document writes',async()=>{
 const f=fixture();f.backend.documents.upload=async()=>{throw Error('controlled storage failure');};
 const p=await open();await upload(p,'picker');await save(p);
 assert.ok(text(p.tree.toJSON()).includes('controlled storage failure'));
 assert.equal(writes(f),0);assert.equal(f.calls.createCatalog.length,0);p.tree.unmount();
});
await check('B3 positioned PDF saves the 40 price, not its 20-LB pack, with source geometry',async()=>{
 const f=fixture(),p=await open();
 const line=(values,y)=>values.map((value,index)=>({text:value,transform:[1,0,0,12,[30,150,500,650,800][index],y],width:60,height:12}));
 const raw='Code Description Pack Price Unit Price\nB1-001 Chicken Breast Boneless Skinless 20 LB CASE 40.00';
 const input={...file('B3_Prices.pdf',raw),reading:{filename:'B3_Prices.pdf',text:raw,worksheets:[],pages:[{number:1,width:900,height:600,source:'embedded-text',items:[...line(['Code','Description','Pack','Price Unit','Price'],550),...line(['B1-001','Chicken Breast Boneless Skinless','20 LB','CASE','40.00'],510)],text:raw}]}};
 await upload(p,'picker',input);assert.equal(writes(f),0);await save(p);
 assert.deepEqual(f.calls.applyQuote.map(call=>call.price),[40]);
 assert.equal(f.calls.applyQuote[0].packSize,'20 LB');
 assert.equal(f.calls.applyQuote[0].importRow.row.sourceProvenance.page,1);
 assert.ok(f.calls.applyQuote[0].importRow.row.sourceProvenance.cells[4].words[0].transform);
 assert.equal(f.uploads.length,1);assert.equal(f.uploads[0].bytes,raw);assert.equal(f.calls.insertImportDoc.length,1);p.tree.unmount();
});
await check('B3 offset worksheets save both prices under one original document',async()=>{
 const f=fixture(),p=await open();
 const sheet=(name,rows,offset)=>({name,cells:rows.flatMap((row,r)=>row.map((value,c)=>({row:r+1,column:c+offset,address:(c+offset)+':'+(r+1),value})))});
 const reading={filename:'B3_Sheets.xlsx',pages:[],worksheets:[sheet('A',[['Code','Description','Pack','Price Unit','Price'],['B1-001','Chicken Breast Boneless Skinless','2/10 LB','CASE',41.25]],1),sheet('B',[['Price','Description','Code','Price Unit','Pack'],[51.75,'Turkey Breast Smoked Deli Style','B1-002','CASE','2/10 LB']],3)]};
 await upload(p,'picker',{...file('B3_Sheets.xlsx','retained workbook bytes'),reading});
 assert.ok(text(p.tree.toJSON()).includes('2 product rows read'));await save(p);
 assert.deepEqual(f.calls.applyQuote.map(call=>call.price),[41.25,51.75]);assert.equal(f.uploads.length,1);assert.equal(f.calls.insertImportDoc.length,1);
 assert.equal(f.calls.applyQuote[0].sourceDocumentId,f.calls.applyQuote[1].sourceDocumentId);
 assert.deepEqual(f.calls.applyQuote.map(call=>call.importRow.row.sourceProvenance.worksheet),['A','B']);p.tree.unmount();
 const replay=await open();await upload(replay,'picker',{...file('B3_Sheets.xlsx','retained workbook bytes'),reading});await save(replay);
 assert.equal(f.calls.applyQuote.length,2);assert.equal(f.calls.insertImportDoc.length,1);assert.equal(f.uploads.length,1);replay.tree.unmount();
});
await check('B3 remembers and applies unknown headers independently for both worksheet layouts',async()=>{
 const f=fixture(),p=await open();
 const sheet=(name,rows)=>({name,cells:rows.flatMap((row,r)=>row.map((value,c)=>({row:r+1,column:c+1,address:c+':'+r,value})))});
 const reading={filename:'B3_Unknown.xlsx',pages:[],worksheets:[sheet('A',[['Description','Mystery','Price'],['Chicken Breast Boneless Skinless','20 LB',41.25]]),sheet('B',[['Price','Description','Other'],[51.75,'Turkey Breast Smoked Deli Style','10 LB']])]};
 await upload(p,'picker',{...file('B3_Unknown.xlsx','retained original'),reading});
 assert.ok(text(p.tree.toJSON()).includes('Mystery'));assert.ok(text(p.tree.toJSON()).includes('Other'));assert.equal(writes(f),0);
 for(const select of p.tree.root.findAllByType('select'))if(select.findAllByType('option').some(option=>option.props.value==='packSize'))await act(async()=>{select.props.onChange({target:{value:'packSize'}});});
 await act(async()=>{await button(p,'Continue →').props.onClick();});
 assert.ok(text(p.tree.toJSON()).includes('2 product rows read'));await save(p);
 assert.deepEqual(f.calls.applyQuote.map(call=>call.packSize),['20 LB','10 LB']);p.tree.unmount();
});
console.log(passed+'/12 B1/B3 rendered upload checks passed (local mocked persistence; not live browser/database evidence).');
process.exit(0);
`;
try{
 const outfile=join(dir,'test.mjs');
 await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'jsx'},outfile,bundle:true,platform:'node',format:'esm',jsx:'automatic',define:{'import.meta.env':'{}'},plugins:[{name:'b1-boundaries',setup(b){
  b.onResolve({filter:/document-reader\.js$/},()=>({path:'reader',namespace:'b1'}));
  b.onLoad({filter:/reader/,namespace:'b1'},()=>({contents:'export async function fileToText(file,{onRead}={}){if(file.reading)onRead?.(file.reading);return file.text();}'}));
  b.onResolve({filter:/backend\/index\.js$/},()=>({path:'backend',namespace:'b1'}));
  b.onLoad({filter:/backend/,namespace:'b1'},()=>({contents:'export const backend={records:{query:(...args)=>globalThis.__b1Backend.records.query(...args)},documents:{upload:(...args)=>globalThis.__b1Backend.documents.upload(...args),remove:(...args)=>globalThis.__b1Backend.documents.remove(...args)},pricing:{applyQuote:(...args)=>globalThis.__b1Backend.pricing.applyQuote(...args)},invoices:{record:(...args)=>globalThis.__b1Backend.invoices.record(...args)}};'}));
 }}]});
 process.stdout.write(execFileSync(process.execPath,[outfile],{encoding:'utf8',timeout:30000}));
}finally{rmSync(dir,{recursive:true,force:true});}
