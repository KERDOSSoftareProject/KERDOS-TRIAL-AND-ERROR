// Render production Manual Upload and run its actual handlers/parser/services.
// Persistence and browser file reading are simulated: local evidence only.
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'kerdos-b1-'));
const inputMode=process.argv[2]==='--product-label-parity';
const suppliedInput=inputMode?readFileSync(0,'utf8'):null;
const source=String.raw`
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {readFileSync} from 'node:fs';
import {PasteModal} from './src/pages/ImportModal.jsx';
import {createProcurementContext} from './src/procurement.js';
import {createPriceImportFixture} from './scripts/fixtures/price-import-backend.mjs';
import * as XLSX from 'xlsx';
import {createDocumentReader} from './src/core/document-reading.js';
import ocrCapture from './scripts/fixtures/b2/mixed-ocr-reading.json';
const csv='Code,Description,Pack,Price Unit,Price\nB1-001,Chicken Breast Boneless Skinless,2/10 LB,CASE,41.25\n';
const invoice='INVOICE B1-INV-001\nDate: 10/27/2026\nItem,Description,Pack,Price Unit,Qty,Unit Price,Extended Price\nB1-001,Chicken Breast Boneless Skinless,2/10 LB,CASE,2,41.25,82.50';
const org='10000000-0000-0000-0000-000000000001';
const vendor='20000000-0000-0000-0000-000000000001';
const text=node=>typeof node==='string'?node:(node.children||[]).map(text).join('');
let passed=0;
function fixture(){
 const f=createPriceImportFixture({text:csv});f.uploads=[];f.invoices=[];f.backend.invoices={record:async(header,lines)=>{f.invoices.push({header,lines});return {id:"b1-invoice"};}};
 f.downloads=[];f.backend.documents={upload:async(path,file)=>{f.uploads.push({path,name:file.name,bytes:await file.text()});},download:async(path)=>{f.downloads.push(path);const stored=f.uploads.find(u=>u.path===path);if(!stored)throw Error('stored original unavailable');return new TextEncoder().encode(stored.bytes);},remove:async()=>{}};
 globalThis.__b1Backend=f.backend;return f;
}
function file(name='B1_Prices.csv',content=csv){return {name,size:Buffer.byteLength(content),text:async()=>content,arrayBuffer:async()=>new TextEncoder().encode(content).buffer};}
function writes(f){return f.invoices.length+f.uploads.length+f.calls.applyQuote.length+f.calls.insertImportDoc.length+f.calls.createMapping.length;}
async function open(initialVendorId=vendor,initialMode='pricelist',overrides={}){
 let tree;const finished=[],issues=[];
 await act(async()=>{tree=Renderer.create(React.createElement(PasteModal,{industry:'restaurant',vendors:[{id:vendor,name:'B1 Test Vendor'}],orgId:org,orgSettings:{},catalogItems:[],categories:[],vendorItems:[],mappings:[],onClose:()=>{},onDone:async()=>{},onFinished:v=>finished.push(v),onIssue:v=>issues.push(v),initialVendorId,initialMode,...overrides}));});
 return {tree,finished,issues};
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
async function productLabelParity(input){
 const {industry,vocabulary,descriptions}=input;
 const cell=value=>'"'+String(value??'').replaceAll('"','""')+'"';
 const sourceRows=descriptions.map((entry,index)=>{
  const row=typeof entry==='string'?{description:entry,brand:'Fixture Foods',packSize:'4/10 LB'}:entry;
  return {code:'LABEL-'+(index+1),description:row.description,brand:row.brand??null,packSize:row.packSize??null};
 });
 const csvText=['Code,Description,Brand,Pack,Price Unit,Price',...sourceRows.map(row=>[row.code,row.description,row.brand,row.packSize,'CASE','41.25'].map(cell).join(','))].join('\n');
 const f=fixture(),p=await open(vendor,'pricelist',{industry,vocabulary});
 try{
  await upload(p,'picker',file('Product_Label_Parity_Prices.csv',csvText));await save(p);
  assert.equal(p.finished.length,1,JSON.stringify(p.tree.toJSON()));
  const procurement=createProcurementContext({industry,vocabulary});
  const browser=f.calls.applyQuote.map(quote=>{
   const {code,description,brand=null,packSize=null}=quote.importRow.row;
   return {code,description,brand,packSize,label:procurement.readProductLabel({description,brand,packSize})};
  });
  assert.deepEqual(browser.map(({code})=>code),sourceRows.map(({code})=>code),'manual upload should produce each fixture row in source order');
  // Task A reads candidate labels for assertions. Existing import writes and
  // catalog grouping continue through their normal production path.
  const worker=JSON.parse(execFileSync(process.execPath,['supabase/functions/process-attachment/process-attachment-test.mjs','--product-label-parity'],{
   input:JSON.stringify({industry,vocabulary,text:csvText}),encoding:'utf8',
  }));
  assert.deepEqual(browser,worker,'manual-upload and email-worker rows should produce identical labels');
  return browser.map(row=>row.label);
 }finally{p.tree.unmount();}
}
if(process.argv[2]==='--product-label-parity'){
 const input=JSON.parse(readFileSync(0,'utf8'));
 const labels=await productLabelParity(input);
 console.log(JSON.stringify({tested:labels.length,labels}));
 process.exit(0);
}
await check('Task A candidate labels agree for rendered manual upload and the email worker',async()=>{
 const labels=await productLabelParity({industry:'restaurant',vocabulary:[{kind:'synonym',term:'label proof rasher',canonical:'bacon'}],descriptions:[
  'BCON LAYOUT 15LB','BACON','SAUSAGE LINKS 2OZ','SAUSAGE PATTIES 2OZ','DELI TRIM CRN BEEF','LABEL PROOF RASHER',
 ]});
 assert.equal(labels[0].key,labels[1].key);
 assert.ok(labels[1].key);
 assert.ok(labels[2].key&&labels[3].key);
 assert.notEqual(labels[2].key,labels[3].key);
 assert.equal(labels[4].key,null);
 assert.equal(labels[4].status,'review');
 assert.equal(labels[5].key,labels[1].key);
});
await check('positioned invoice non-product sections render safely before saving',async()=>{
 const f=fixture(),p=await open(vendor,'invoice');
 const line=(values,y)=>values.map((value,index)=>({text:value,transform:[1,0,0,12,[30,140,390,490,590,690,790][index],y],width:60,height:12}));
 const raw='INVOICE SKIPPED-REGRESSION\nItem,Description,Pack,Price Unit,Qty,Unit Price,Extended Price\nB1-001,Chicken Breast Boneless Skinless,2/10 LB,CASE,2,41.25,82.50\nSubtotal 82.50';
 const reading={filename:'invoice-sections.pdf',text:raw,worksheets:[],pages:[{number:1,width:950,height:650,source:'embedded-text',text:raw,items:[...line(['Item','Description','Pack','Price Unit','Qty','Unit Price','Extended Price'],550),...line(['B1-001','Chicken Breast Boneless Skinless','2/10 LB','CASE','2','41.25','82.50'],510),...line(['Subtotal','82.50'],450),...line(['Following items were out of stock'],420)]}]};
 await upload(p,'drop',{...file('invoice-sections.pdf',raw),reading});
 assert.match(text(p.tree.toJSON()),/1 product row read/);assert.equal(writes(f),0);
 await save(p);
 assert.match(text(p.tree.toJSON()),/Subtotal/);
 assert.doesNotMatch(text(p.tree.toJSON()),/undefined|\[object Object\]/);
 assert.match(text(p.tree.toJSON()),/Following items were out of stock/);
 assert.equal(writes(f),0,'preview must not write any records');
 p.tree.unmount();
});
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
await check('a blank description retains the source row and saves only the described product',async()=>{
 const f=fixture(),p=await open();
 const content='Code,Description,Brand,Pack,Price Unit,Price\nB4-BLANK,,Brand Only Text,20 LB,CASE,42.50\nB4-VALID,Chicken Breast Boneless Skinless,Other Brand,20 LB,CASE,53.20\n';
 await upload(p,'picker',file('B4_Blank_Description.csv',content));await save(p);
 const doc=Object.values(f.importDocs)[0],held=doc.source_rows.rows[0];
 assert.equal(doc.status,'partial');
 assert.deepEqual(doc.completed_keys,['row:1']);
 assert.deepEqual(held.values.slice(0,3),['B4-BLANK','','Brand Only Text']);
 assert.equal(held.values[5],42.5);
 assert.equal(held.sourceLine,'B4-BLANK\t\tBrand Only Text\t20 LB\tCASE\t42.50');
 assert.deepEqual(f.calls.applyQuote.map(row=>row.vendorItemCode),['B4-VALID']);
 assert.equal(f.calls.createMapping.length,1);
 assert.match(text(p.tree.toJSON()),/Product description is missing/);
 p.tree.unmount();
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
await check('manual invoice retains explicit billed quantity source separately from ordered counts',async()=>{
 const f=fixture(),p=await open(vendor,'invoice');await upload(p,'picker',file('Billed.csv',invoice.replace(',Qty,',',Billed Quantity,')));await save(p);
 assert.equal(f.invoices.length,1);const line=f.invoices[0].lines[0];assert.equal(line.quantity_source.header,'Billed Quantity');assert.equal(line.billed_quantity_evidence.quantity,2);assert.equal(line.billed_quantity_evidence.unit,'CASE');p.tree.unmount();
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
await check('B3 review displays a text-only skipped PDF heading with its page and line',async()=>{
 const f=fixture(),p=await open();
 const line=(values,y)=>values.map((value,index)=>({text:value,transform:[1,0,0,12,[30,150,500,650,800][index],y],width:60,height:12}));
 const raw='INVOICE\nCode Description Pack Price Unit Price\nB1-001 Chicken Breast 20 LB CASE 40.00\n* F R O Z E N *';
 const items=[...line(['Code','Description','Pack','Price Unit','Price'],550),...line(['B1-001','Chicken Breast','20 LB','CASE','40.00'],510),{text:'* F R O Z E N *',transform:[1,0,0,12,150,470],width:130,height:12}];
 await upload(p,'picker',{...file('B3_Review.pdf',raw),reading:{filename:'B3_Review.pdf',text:raw,worksheets:[],pages:[{number:1,width:900,height:600,source:'embedded-text',items,text:raw}]}});
 assert.equal(writes(f),0);
 await act(async()=>{button(p,'Save Import →').props.onClick();});
 const preview=text(p.tree.toJSON());
 assert.match(preview,/F R O Z E N/);assert.match(preview,/page 1/);assert.match(preview,/source line 3/);
 assert.equal(writes(f),0);p.tree.unmount();
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
await check('B2 actual OCR capture saves correct numeric fields while retaining uncertainty flags',async()=>{
 const f=fixture(),p=await open();
 const applyQuote=f.backend.pricing.applyQuote;
 let resume,attempts=0;const pending=new Promise(resolve=>{resume=resolve;});
 f.backend.pricing.applyQuote=async(...args)=>{if(++attempts===2)await pending;return applyQuote(...args);};
 await upload(p,'picker',{...file('B2_Mixed_Scanned_Prices_Test.pdf',ocrCapture.text),reading:ocrCapture});
 assert.equal(writes(f),0);await save(p);
 assert.ok(text(p.tree.toJSON()).includes('Source recognition is below 90%; retained values need confirmation.'));
 assert.ok(!text(p.tree.toJSON()).includes('[object Object]'));
 assert.ok(text(p.tree.toJSON()).includes('Saved 1 of 2 rows'));
 await act(async()=>{resume();});
 for(let i=0;i<60&&!p.finished.length;i++)await act(async()=>{await new Promise(r=>setTimeout(r,10));});
 assert.deepEqual(f.calls.applyQuote.map(call=>[call.vendorItemCode,call.price]),[['730001',46.75],['730002',57.85]]);
 assert.equal(f.calls.applyQuote[1].priceUnavailable,false);
 assert.equal(f.calls.applyQuote[1].importRow.reviewRequired,true);
 assert.equal(f.calls.applyQuote[1].importRow.row.sourceProvenance.page,2);
 assert.equal(f.calls.applyQuote[1].importRow.row.billingUnitEvidence.unit,'CASE');
 assert.equal(f.uploads.length,1);assert.equal(f.calls.insertImportDoc.length,1);p.tree.unmount();
});
await check('interrupted import resumes with independent proof even when the current listing only retains a later row',async()=>{
 const f=fixture(),first=await open(),input={...file('B2_Mixed_Scanned_Prices_Test.pdf',ocrCapture.text),reading:ocrCapture};
 await upload(first,'picker',input);await save(first);first.tree.unmount();
 const doc=Object.values(f.importDocs)[0];assert.equal(doc.source_rows.rows.length,2);
 doc.status='processing';doc.completed_keys=['row:0'];
 assert.equal(f.vendorItems[0].import_row.rowKey,'row:1');
 const resumed=await open();await upload(resumed,'picker',input);await save(resumed);
 assert.equal(doc.status,'complete',JSON.stringify(resumed.tree.toJSON()));assert.deepEqual(doc.completed_keys,['row:0','row:1']);
 assert.equal(f.uploads.length,1);assert.equal(f.calls.insertImportDoc.length,1);assert.equal(f.calls.applyQuote.length,2,'replayed staged listing must not create another quote');
 assert.equal(f.vendorItems[0].import_row.reviewRequired,true);assert.equal(f.vendorItems[0].import_row.sourceDocumentId,doc.id);resumed.tree.unmount();
});
await check('manual alternate pack is saved as a separate offering without overwriting the saved pack',async()=>{
 const f=fixture();const old={id:'existing-mint',organization_id:org,vendor_id:vendor,vendor_item_code:null,description:'Split Mint',brand:null,pack_size:'1LB',price:7};f.vendorItems.push(old);
 const p=await open();await upload(p,'picker',file('alternate.csv','Description,Pack,Price Unit,Price\nSplit Mint,3CT,CASE,8.25\n'));await save(p);
 assert.equal(f.calls.applyQuote.length,1,JSON.stringify(p.tree.toJSON()));assert.equal(f.calls.applyQuote[0].vendorItemId,null);assert.equal(f.calls.applyQuote[0].packSize,'3CT');assert.equal(old.pack_size,'1LB');assert.equal(old.price,7);
 assert.equal(Object.values(f.importDocs)[0].status,'complete');p.tree.unmount();
});
await check('large ordinary import builds no editable evidence grid or per-row listing dropdowns',async()=>{
 const f=fixture();const entries=Array.from({length:322},(_,i)=>({id:'old-'+i,vendor_id:vendor,description:'Stored product '+i,vendor_item_code:null,pack_size:'1LB'}));
 const p=await open(vendor,'pricelist',{vendorItems:entries});globalThis.__evidenceCalls=0;
 const many='Code,Description,Pack,Price Unit,Price\n'+Array.from({length:347},(_,i)=>'PERF-'+i+',Chicken Breast Boneless Skinless,20 LB,CASE,40').join('\n');
 await upload(p,'picker',file('large.csv',many));assert.equal(globalThis.__evidenceCalls,0,'preview does not calculate editable evidence');
 let release;const gate=new Promise(resolve=>{release=resolve;});const quote=f.backend.pricing.applyQuote;let entered=false;
 f.backend.pricing.applyQuote=async args=>{if(!entered){entered=true;await gate;}return quote(args);};
 await save(p);assert.equal(entered,true);assert.equal(globalThis.__evidenceCalls,0,'ordinary save does not compute the review grid');
 assert.equal(p.tree.root.findAll(n=>n.type==='select'&&String(n.props['aria-label']||'').startsWith('Use saved vendor listing')).length,0);
 release();for(let i=0;i<150&&!p.finished.length;i++)await act(async()=>{await new Promise(r=>setTimeout(r,10));});
 assert.equal(p.finished.length,1);assert.equal(globalThis.__evidenceCalls,0,'result screen does not recalculate source evidence');assert.equal(Object.values(f.importDocs)[0].completed_keys.length,347);p.tree.unmount();
});
await check('saved result and Done appear before a delayed catalog refresh completes',async()=>{
 const f=fixture();let release;const gate=new Promise(resolve=>{release=resolve;});const p=await open(vendor,'pricelist',{onDone:()=>gate});
 await upload(p,'picker');await save(p);assert.equal(Object.values(f.importDocs)[0].status,'complete');assert.equal(p.finished.length,0);
 assert.ok(text(p.tree.toJSON()).includes('Upload successful'));assert.ok(button(p,'Done'));assert.equal(button(p,'Import another').props.disabled,true);assert.ok(text(p.tree.toJSON()).includes('Refreshing catalog'));
 release();await act(async()=>{await new Promise(r=>setTimeout(r,10));});assert.equal(p.finished.length,1);assert.equal(button(p,'Import another').props.disabled,false);p.tree.unmount();
});
await check('partial result appears before refresh and a refresh error stays separate from saved data',async()=>{
 const f=fixture();f.backend.pricing.applyQuote=async()=>{throw Error('Controlled row write failure');};let reject;const gate=new Promise((_,r)=>{reject=r;});
 const p=await open(vendor,'pricelist',{onDone:()=>gate});await upload(p,'picker');await save(p);
 assert.equal(Object.values(f.importDocs)[0].status,'partial');assert.ok(button(p,'Done'));assert.ok(text(p.tree.toJSON()).includes('Controlled row write failure'));
 await act(async()=>{reject(Error('Controlled refresh failure'));await new Promise(r=>setTimeout(r,10));});
 assert.ok(text(p.tree.toJSON()).includes('Controlled refresh failure'));assert.ok(text(p.tree.toJSON()).includes('Controlled row write failure'));assert.equal(f.uploads.length,1);p.tree.unmount();
});
await check('quoted-per review explains possibilities without choosing or writing a basis',async()=>{
 const f=fixture(),p=await open(vendor,'pricelist',{onBeforeSave:async()=>true});
 await upload(p,'picker',file('uncertain.csv','Code,Description,Pack,Price\nX-1,STEEL WASHERS,4/10 LB,2.06\n'));
 const selector=()=>p.tree.root.find(n=>n.type==='select'&&n.props['aria-label']==='Quoted price per unit for STEEL WASHERS');
 assert.ok(!text(p.tree.toJSON()).includes('Quoted per ↑'));
 await act(async()=>{button(p,'Details').props.onClick();});
 assert.equal(selector().props.value,'');
 assert.match(text(p.tree.toJSON()),/What does this price cover/);
 assert.match(text(p.tree.toJSON()),/full pack.*one package.*by pounds/);
 assert.equal(writes(f),0,'interpretation examples must not write records');
 await act(async()=>{selector().props.onChange({target:{value:'CASE'}});});
 assert.equal(selector().props.value,'CASE');
 assert.doesNotMatch(text(p.tree.toJSON()),/What does this price cover/);
 assert.equal(writes(f),0,'confirmation remains in preview until the existing save action');
 p.tree.unmount();
});
await check('cross-vendor inference fills amber unit and client confirmation turns it green without source writes',async()=>{
 const f=fixture();const refs=[34,36].map((price,i)=>({id:'ref-'+i,organization_id:org,vendor_id:'other-'+i,description:'STEEL WASHERS',pack_size:'4/5 LB',price,selling_unit:'CASE',price_basis:'case',price_source:'pricelist',import_row:{reviewRequired:false,row:{sellingUnit:'CASE'},evidence:{sellingUnitSource:'price header'}}}));
 const p=await open(vendor,'pricelist',{vendorItems:refs,onBeforeSave:async()=>true});
 await upload(p,'picker',file('inferred.csv','Code,Description,Pack,Price\nX-1,STEEL WASHERS,4/5 LB,35\n'));
 const selector=()=>p.tree.root.find(n=>n.type==='select'&&n.props['aria-label']==='Quoted price per unit for STEEL WASHERS');
 await act(async()=>{button(p,'Details').props.onClick();});
 assert.equal(selector().props.value,'CASE');
 assert.equal(writes(f),0);
 await act(async()=>{button(p,'Confirm inferred unit').props.onClick();});
 assert.equal(selector().props.value,'CASE');assert.equal(writes(f),0);
 p.tree.unmount();
});
await check('review listing choices open for one row only and unrelated UI changes reuse evidence',async()=>{
 fixture();const entries=Array.from({length:322},(_,i)=>({id:'old-'+i,vendor_id:vendor,description:'Stored product '+i,vendor_item_code:null,pack_size:'1LB'}));
 const p=await open(vendor,'pricelist',{vendorItems:entries,onBeforeSave:async()=>true});globalThis.__evidenceCalls=0;
 await upload(p,'picker',file('two.csv',csv+'B1-002,Turkey Breast Smoked,20 LB,CASE,50\n'));
 assert.equal(globalThis.__evidenceCalls,2);
 const selectors=()=>p.tree.root.findAll(n=>n.type==='select'&&String(n.props['aria-label']||'').startsWith('Use saved vendor listing'));
 assert.equal(selectors().length,0);const choices=()=>p.tree.root.findAll(n=>n.type==='button'&&String(n.props['aria-label']||'').startsWith('Choose saved vendor listing'));
 await act(async()=>{choices()[0].props.onClick();});assert.equal(selectors().length,1);assert.equal(selectors()[0].findAllByType('option').length,323);assert.equal(globalThis.__evidenceCalls,2);
 await act(async()=>{choices()[0].props.onClick();});assert.equal(selectors().length,1);assert.equal(globalThis.__evidenceCalls,2);p.tree.unmount();
});
await check('clean save with refresh failure retains warning and never emits success completion',async()=>{
 const f=fixture();let reject;const gate=new Promise((_,r)=>{reject=r;});
 const p=await open(vendor,'pricelist',{onDone:()=>gate});await upload(p,'picker');await save(p);
 const doc=Object.values(f.importDocs)[0];assert.equal(doc.status,'complete');assert.deepEqual(doc.completed_keys,['row:0']);assert.equal(f.calls.applyQuote.length,1);assert.equal(p.finished.length,0);
 await act(async()=>{reject(Error('Clean-save refresh failed'));await new Promise(r=>setTimeout(r,10));});
 assert.ok(text(p.tree.toJSON()).includes('Saved, but the catalog could not refresh: Clean-save refresh failed'));assert.ok(button(p,'Done'));assert.equal(p.finished.length,0,'refresh failure must not emit success completion');
 assert.equal(f.calls.applyQuote.length,1);assert.equal(f.uploads.length,1);assert.equal(f.calls.insertImportDoc.length,1);assert.equal(doc.status,'complete');p.tree.unmount();
});
await check('companion delivery enters the real importer with locked vendor, original bytes and retained evidence before quotes',async()=>{
 const f=fixture();const proof={kind:'browser_companion',adapter_key:'us-foods-moxe',origin:'https://order.usfoods.com',account_label:'Synthetic Client',list_label:'Synthetic List',sha256:'a'.repeat(64),byte_length:csv.length,received_at:'2026-11-01T12:00:00.000Z',assurance:'user_approved_browser_session'};
 const apply=f.backend.pricing.applyQuote;
 f.backend.pricing.applyQuote=async(...args)=>{assert.equal(f.uploads.length,1);assert.deepEqual(f.calls.insertImportDoc[0].retrieval_evidence,proof);return apply(...args);};
 const p=await open(vendor,'pricelist',{initialFiles:[file()],companionEvidence:proof});
 for(let i=0;i<20&&!button(p,'Save Import →');i++)await act(async()=>{await new Promise(r=>setTimeout(r,10));});
 assert.equal(p.tree.root.findAll(n=>n.type==='input'&&n.props.type==='file').length,0);assert.equal(p.tree.root.findAllByType('textarea').length,0);
 assert.equal(p.tree.root.findAllByType('select').filter(n=>n.props.value===vendor&&!n.props.disabled).length,0);
 await save(p);assert.equal(f.uploads[0].bytes,csv);assert.equal(f.calls.insertImportDoc[0].vendor_id,vendor);assert.equal(f.calls.insertImportDoc[0].organization_id,org);assert.equal(f.calls.applyQuote.length,1);p.tree.unmount();
});
await check('missing companion evidence schema blocks quote writes instead of falling back to manual provenance',async()=>{
 const f=fixture(),query=f.backend.records.query;
 f.backend.records.query=name=>name==='import_documents'?{select:(...args)=>query(name).select(...args),insert:()=>({select:()=>({single:async()=>({data:null,error:{message:'retrieval_evidence column not installed'}})})})}:query(name);
 const p=await open(vendor,'pricelist',{initialFiles:[file()],companionEvidence:{kind:'browser_companion',account_label:'Synthetic Client',list_label:'Synthetic List'}});
 for(let i=0;i<20&&!button(p,'Save Import →');i++)await act(async()=>{await new Promise(r=>setTimeout(r,10));});
 await save(p);assert.equal(f.calls.applyQuote.length,0);assert.equal(f.calls.insertImportDoc.length,0);assert.match(text(p.tree.toJSON()),/retrieval_evidence column not installed/);p.tree.unmount();
});
await check('native 87-row companion CSV asks only about genuine metadata headings then previews all products without writes',async()=>{
 const header=['Line Number','Group Name','Product Number','Product Description','Product Brand','Product Package Size','Customer Product Number','Product Price','Product UOM','Class Description','Storage Description'];
 const content=[header,...Array.from({length:87},(_,i)=>[i+1,'Example Group','TEST-'+i,'Sample cooked product '+i,i===84?'PRICE PRODUCT NAME':'Example brand','2/10 LB','','41.25','CS','Example class','Dry'])].map(row=>row.join(',')).join('\n');
 const input=file('vendor-prices.csv',content),reader=createDocumentReader({loadWorkbook:async()=>XLSX});input.reading=await reader(input);
 const f=fixture(),p=await open(vendor,'pricelist',{initialFiles:[input],companionEvidence:{kind:'browser_companion',account_label:'Synthetic Client',list_label:'Synthetic List'}});
 for(let i=0;i<20&&!button(p,'Continue →');i++)await act(async()=>{await new Promise(r=>setTimeout(r,10));});
 assert.match(text(p.tree.toJSON()),/Check unrecognized columns/);
 const columnRoles=p.tree.root.findAllByType('select').filter(node=>node.props['aria-label']?.startsWith('Role for '));
 assert.deepEqual(columnRoles.map(node=>node.props['aria-label'].slice('Role for '.length)),['Line Number','Group Name','Customer Product Number','Class Description','Storage Description']);
 assert.equal(writes(f),0);
 await act(async()=>{await button(p,'Continue →').props.onClick();});
 assert.ok(button(p,'Save Import →'));assert.match(text(p.tree.toJSON()),/87 product rows read/);assert.equal(writes(f),0);p.tree.unmount();
});
// Automatic companion delivery uses the real importer without any UI action.
const autoProof={kind:'browser_companion',adapter_key:'synthetic-provider',origin:'https://supplier.example',account_label:'Synthetic Client',list_label:'Synthetic List',sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(csv))),n=>n.toString(16).padStart(2,'0')).join(''),byte_length:new TextEncoder().encode(csv).length,received_at:'2026-11-02T12:00:00Z',assurance:'user_approved_browser_session'};
async function autoOpen(content=csv,overrides={}){const input=file('vendor-prices.csv',content),reader=createDocumentReader({loadWorkbook:async()=>XLSX});input.reading=await reader(input);return open(vendor,'pricelist',{initialFiles:[input],companionEvidence:{...autoProof,sha256:Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(content))),n=>n.toString(16).padStart(2,'0')).join(''),byte_length:new TextEncoder().encode(content).length},automaticCompanion:true,...overrides});}
async function automaticResult(p){for(let i=0;i<300&&!p.finished.length&&!text(p.tree.toJSON()).includes('Dismiss notice');i++)await act(async()=>{await new Promise(r=>setTimeout(r,10));});}
await check('automatic companion intake saves original/evidence and prices with zero column/Continue/Save actions',async()=>{
 const f=fixture();const p=await autoOpen();await automaticResult(p);assert.equal(p.finished.length,1,text(p.tree.toJSON()));assert.equal(button(p,'Save Import →'),undefined);assert.equal(button(p,'Continue →'),undefined);assert.equal(f.uploads.length,1);assert.equal(f.uploads[0].bytes,csv);assert.deepEqual(f.calls.insertImportDoc[0].retrieval_evidence,autoProof);assert.equal(f.calls.insertImportDoc[0].staged_receipts_version,1);assert.equal(f.calls.applyQuote.length,1);assert.equal(f.calls.applyQuote[0].price,41.25);assert.equal(f.calls.applyQuote[0].priceUnavailable,false);assert.match(p.finished[0].message,/Pricing received automatically/);assert.match(p.finished[0].message,/Stored original verified/);assert.equal(f.downloads.length,1);assert.ok(p.finished[0].importDocumentId);p.tree.unmount();
 const before=writes(f),again=await autoOpen();await automaticResult(again);assert.equal(writes(f),before);assert.equal(again.finished.length,1);assert.match(again.finished[0].message,/already up to date/);again.tree.unmount();
 const changed=await autoOpen(csv.replace('41.25','43.25'));await automaticResult(changed);assert.equal(changed.finished.length,1,text(changed.tree.toJSON()));assert.equal(f.calls.applyQuote.length,2);assert.deepEqual(f.calls.applyQuote.map(q=>q.price),[41.25,43.25]);assert.equal(Object.values(f.importDocs).length,2);assert.equal(f.uploads[0].bytes,csv);changed.tree.unmount();
});
await check('Windows-1252 companion source imports its stated quote and verifies the retained original bytes',async()=>{
 const bytes=Buffer.from('Code,Description,Pack,Price Unit,Price\nB1-125,Crème brûlée® \x96 jalapeño,2/10 LB,CASE,12.50\n','latin1');
 const input=new File([bytes],'vendor-prices.csv',{type:'text/csv'});
 input.reading=await createDocumentReader({loadWorkbook:async()=>XLSX})(input);
 const proof={...autoProof,sha256:Buffer.from(await crypto.subtle.digest('SHA-256',bytes)).toString('hex'),byte_length:bytes.length};
 const f=fixture();
 f.backend.documents.upload=async(path,file)=>{f.uploads.push({path,bytes:Buffer.from(await file.arrayBuffer())});};
 f.backend.documents.download=async path=>{f.downloads.push(path);return f.uploads.find(upload=>upload.path===path).bytes;};
 const p=await autoOpen(csv,{initialFiles:[input],companionEvidence:proof});await automaticResult(p);
 assert.equal(p.finished.length,1,text(p.tree.toJSON()));
 assert.match(p.finished[0].message,/Stored original verified/);
 assert.deepEqual(f.uploads[0].bytes,bytes);
 assert.equal(f.calls.applyQuote.length,1);assert.equal(f.calls.applyQuote[0].price,12.5);
 const saved=Object.values(f.importDocs)[0];assert.match(saved.original_text,/Crème brûlée® – jalapeño/);
 assert.equal(saved.retrieval_evidence.sha256,proof.sha256);p.tree.unmount();
});
await check('automatic matches require the same source account, list, adapter, origin and original bytes',async()=>{
 const f=fixture(),first=await autoOpen();await automaticResult(first);assert.equal(first.finished.length,1);first.tree.unmount();
 const saved=Object.values(f.importDocs)[0],before=writes(f),reads=f.downloads.length;
 for(const [change,message] of [
  [{account_label:'Other account'},/same verified vendor account and list/],
  [{list_label:'Other list'},/same verified vendor account and list/],
  [{adapter_key:'other-adapter'},/same verified vendor account and list/],
  [{origin:'https://other.example'},/same verified vendor account and list/],
  [{sha256:'a'.repeat(64)},/original file bytes differ/],
 ]){
  const next=await autoOpen(csv,{companionEvidence:{...autoProof,...change}});
  await automaticResult(next);assert.equal(next.finished.length,0);assert.match(text(next.tree.toJSON()),message);
  assert.equal(writes(f),before);assert.equal(f.downloads.length,reads);
  assert.deepEqual(saved.retrieval_evidence,autoProof);next.tree.unmount();
 }
 saved.status='partial';
 const partial=await autoOpen(csv,{companionEvidence:{...autoProof,list_label:'Other list'}});
 await automaticResult(partial);assert.equal(partial.finished.length,0);assert.equal(saved.status,'partial');
 assert.equal(writes(f),before);partial.tree.unmount();
});
await check('automatic native metadata export retains all 87 rows and source metadata without confirming a layout',async()=>{
 const header=['Line Number','Group Name','Product Number','Product Description','Product Brand','Product Package Size','Customer Product Number','Product Price','Product UOM','USF Class Description','Storage Description'];
 const content=[header,...Array.from({length:87},(_,i)=>[i+1,'Example Group','AUTO-'+i,'Sample cooked product '+i,i===84?'PRICE PRODUCT NAME':'Example brand','2/10 LB','','41.25','CS','Example class','Dry'])].map(row=>row.join(',')).join('\n');
 const f=fixture(),p=await autoOpen(content);await automaticResult(p);assert.equal(p.finished.length,1,text(p.tree.toJSON()));const d=Object.values(f.importDocs)[0];assert.equal(d.status,'complete');assert.equal(d.source_rows.rows.length,87);assert.equal(d.completed_keys.length,87);assert.equal(f.calls.applyQuote.length,87);assert.ok(f.calls.applyQuote.every(q=>q.organizationId===org&&q.vendorId===vendor));assert.deepEqual(f.calls.applyQuote.map(q=>q.vendorItemCode),Array.from({length:87},(_,i)=>'AUTO-'+i));assert.ok(f.calls.applyQuote.every(q=>q.importRow.row.sourceMetadata.some(m=>m.header==='Storage Description'&&m.value==='Dry')));assert.equal(f.uploads[0].bytes,content);assert.equal(button(p,'Continue →'),undefined);p.tree.unmount();
});
await check('automatic unresolved headers are retained for review without creating usable quotes or invented layout confirmations',async()=>{
 const content=csv.replace('Price Unit,Price','Price Unit,Price,Unfamiliar Fee').replace('CASE,41.25','CASE,41.25,6.00');const f=fixture(),p=await autoOpen(content);await automaticResult(p);assert.equal(p.finished.length,1,text(p.tree.toJSON()));assert.equal(f.calls.applyQuote.length,1);assert.equal(f.calls.applyQuote[0].priceUnavailable,false);assert.equal(f.calls.applyQuote[0].importRow.reviewRequired,true);assert.ok(f.calls.applyQuote[0].importRow.conflicts.some(reason=>/Unconfirmed source columns/.test(reason)));assert.equal(f.calls.applyQuote[0].importRow.row.columnReview[0].label,'Unfamiliar Fee');assert.equal(f.uploads[0].bytes,content);assert.equal(button(p,'Continue →'),undefined);p.tree.unmount();
});
await check('automatic nonpricing source is retained as an exception without any price or invoice write',async()=>{
 const f=fixture(),p=await autoOpen('Hello,there\nNo pricing,here\n');await automaticResult(p);assert.equal(f.calls.applyQuote.length,0);assert.equal(f.invoices.length,0);assert.equal(f.uploads.length,1);const d=Object.values(f.importDocs)[0];assert.equal(d.status,'partial');assert.equal(d.retrieval_evidence.kind,'browser_companion');assert.equal(p.finished.length,0);assert.match(text(p.tree.toJSON()),/No product rows could be read|Source type needs review/);p.tree.unmount();
});
await check('automatic original/evidence failure blocks price writes and does not emit success',async()=>{
 const f=fixture();f.backend.documents.upload=async()=>{throw Error('original unavailable');};const p=await autoOpen();await automaticResult(p);assert.equal(f.calls.applyQuote.length,0);assert.equal(f.calls.insertImportDoc.length,0);assert.equal(p.finished.length,0);assert.match(text(p.tree.toJSON()),/original unavailable/);p.tree.unmount();
});
await check('automatic unmount during original preservation prevents later document/price writes',async()=>{
 const f=fixture();let release,started=false;f.backend.documents.upload=async()=>{started=true;await new Promise(resolve=>{release=resolve;});};const p=await autoOpen();for(let i=0;i<100&&!started;i++)await act(async()=>{await new Promise(r=>setTimeout(r,10));});assert.equal(started,true);await act(async()=>p.tree.unmount());await act(async()=>{release();await new Promise(r=>setTimeout(r,20));});assert.equal(f.calls.insertImportDoc.length,0);assert.equal(f.calls.applyQuote.length,0);assert.equal(p.finished.length,0);
});
await check('automatic unknown incoming fields preserve an existing accepted quote',async()=>{
 const f=fixture(),first=await autoOpen();await automaticResult(first);assert.equal(f.calls.applyQuote.length,1);first.tree.unmount();const content=csv.replace('Price Unit,Price','Price Unit,Price,Unfamiliar Fee').replace('CASE,41.25','CASE,43.25,6.00');const next=await autoOpen(content);await automaticResult(next);assert.equal(next.finished.length,1,text(next.tree.toJSON()));assert.equal(f.calls.applyQuote.length,1);assert.equal(f.vendorItems[0].price,41.25);assert.equal(f.vendorItems[0].import_row.reviewRequired,true);assert.equal(f.vendorItems[0].import_row.row.price,43.25);next.tree.unmount();
});
await check('automatic evidence-schema failure and refresh failure do not claim success or repeat saving',async()=>{
 const f=fixture(),query=f.backend.records.query;f.backend.records.query=name=>name==='import_documents'?{select:(...args)=>query(name).select(...args),insert:()=>({select:()=>({single:async()=>({data:null,error:{message:'retrieval_evidence column not installed'}})})})}:query(name);const missing=await autoOpen();await automaticResult(missing);assert.equal(f.calls.applyQuote.length,0);assert.equal(missing.finished.length,0);assert.match(text(missing.tree.toJSON()),/retrieval_evidence column not installed/);missing.tree.unmount();
 const g=fixture(),refresh=await autoOpen(csv,{onDone:async()=>{throw Error('refresh unavailable');}});await automaticResult(refresh);assert.equal(g.calls.applyQuote.length,1);assert.equal(refresh.finished.length,0);assert.match(text(refresh.tree.toJSON()),/Saved, but the catalog could not refresh/);await act(async()=>{await new Promise(r=>setTimeout(r,30));});assert.equal(g.calls.applyQuote.length,1);refresh.tree.unmount();
});
await check('automatic reader failure retains original and provenance as a partial exception',async()=>{
 const f=fixture(),p=await autoOpen(csv,{initialFiles:[{...file(),readingError:'reader unavailable'}]});await automaticResult(p);assert.equal(f.calls.applyQuote.length,0);assert.equal(f.uploads.length,1);assert.equal(f.uploads[0].bytes,csv);assert.equal(Object.values(f.importDocs)[0].status,'partial');assert.match(text(p.tree.toJSON()),/Could not read source/);p.tree.unmount();
});
await check('automatic held-row recovery reuses retained identity after newer code/pack/review evidence replaces the listing',async()=>{
 const content=csv.replace('Price Unit,Price','Price Unit,Price,Unfamiliar Fee').replace('CASE,41.25','CASE,41.25,6.00');
 const f=fixture(),first=await autoOpen(content);await automaticResult(first);assert.equal(first.finished.length,1);first.tree.unmount();
 const doc=Object.values(f.importDocs)[0],item=f.vendorItems[0];doc.status='partial';doc.completed_keys=[];
 doc.staged_row_receipts={'row:0':{vendorItemId:item.id,sourceSha256:'a'.repeat(64)}};
 Object.assign(item,{vendor_item_code:'CORRECTED-CODE',description:'Corrected product name',pack_size:'4/5 LB',price:44.25,price_unavailable:false,import_row:{sourceDocumentId:'newer-source',rowKey:'row:0',reviewRequired:false,row:{price:44.25}}});
 const baseline=structuredClone(item),calls=f.calls.applyQuote.length,uploads=f.uploads.length;
 const resumed=await autoOpen(content);await automaticResult(resumed);assert.equal(resumed.finished.length,1,text(resumed.tree.toJSON()));assert.equal(doc.status,'complete');assert.deepEqual(doc.completed_keys,['row:0']);assert.deepEqual(item,baseline,'resume must preserve the newer price, identity fields and review evidence');assert.equal(f.calls.applyQuote.length,calls);assert.equal(f.uploads.length,uploads);assert.equal(f.calls.insertImportDoc.length,1);resumed.tree.unmount();
 doc.status='partial';doc.completed_keys=[];doc.source_rows.rows[0].values[1]='Mismatched retained source';
 const shifted=await autoOpen(content);await automaticResult(shifted);assert.equal(shifted.finished.length,0);assert.match(text(shifted.tree.toJSON()),/saved row positions or values differ/);assert.deepEqual(item,baseline);shifted.tree.unmount();
 doc.source_rows.rows[0].values[1]='Chicken Breast Boneless Skinless';f.vendorItems.length=0;
 const missing=await autoOpen(content);await automaticResult(missing);assert.equal(missing.finished.length,0);assert.match(text(missing.tree.toJSON()),/retained source-row listing is no longer available/);assert.equal(f.calls.applyQuote.length,calls);missing.tree.unmount();
});
await check('automatic stored-original read failure retains a partial source and retries without duplicate storage or pricing',async()=>{
 const f=fixture(),download=f.backend.documents.download;f.backend.documents.download=async()=>{throw Error('Original download denied');};
 const failed=await autoOpen();await automaticResult(failed);assert.equal(failed.finished.length,0);assert.equal(f.calls.applyQuote.length,0);assert.equal(f.uploads.length,1);assert.equal(f.calls.insertImportDoc.length,1);assert.equal(Object.values(f.importDocs)[0].status,'partial');assert.match(text(failed.tree.toJSON()),/Original download denied/);failed.tree.unmount();
 f.backend.documents.download=download;const retry=await autoOpen();await automaticResult(retry);assert.equal(retry.finished.length,1,text(retry.tree.toJSON()));assert.match(retry.finished[0].message,/Stored original verified/);assert.equal(f.calls.applyQuote.length,1);assert.equal(f.uploads.length,1);assert.equal(f.calls.insertImportDoc.length,1);retry.tree.unmount();
});
await check('scheduled partial intake reports its actual retained document for receipt completion',async()=>{
 const f=fixture();f.backend.documents.download=async()=>{throw Error('Synthetic original download denied');};
 const p=await autoOpen(csv,{companionEvidence:{...autoProof,attempt_token:'synthetic-claim'}});await automaticResult(p);
 const retained=Object.values(f.importDocs)[0];assert.equal(retained.status,'partial');
 assert.equal(p.finished.length,0);assert.equal(p.issues.at(-1).importDocumentId,retained.id);
 assert.equal(f.calls.applyQuote.length,0);p.tree.unmount();
});
await check('automatic corruption checks block new quotes and preserve completed pricing on same-size or truncated stored files',async()=>{
 const f=fixture(),upload=f.backend.documents.upload;f.backend.documents.upload=async(...args)=>{await upload(...args);f.uploads[0].bytes=csv.replace('41.25','99.25');};
 const first=await autoOpen();await automaticResult(first);assert.equal(first.finished.length,0);assert.equal(f.calls.applyQuote.length,0);assert.equal(Object.values(f.importDocs)[0].status,'partial');assert.match(text(first.tree.toJSON()),/SHA-256 differs/);first.tree.unmount();
 f.uploads[0].bytes=csv;const recovered=await autoOpen();await automaticResult(recovered);assert.equal(recovered.finished.length,1);recovered.tree.unmount();
 const doc=Object.values(f.importDocs)[0],baseline=structuredClone(doc),item=structuredClone(f.vendorItems[0]),before=writes(f);
 for(const changed of [csv.replace('41.25','99.25'),csv.slice(0,-1)]){f.uploads[0].bytes=changed;const again=await autoOpen();await automaticResult(again);assert.equal(again.finished.length,0);assert.match(text(again.tree.toJSON()),/stored original (SHA-256|byte length) differs/);assert.equal(writes(f),before);assert.deepEqual(doc,baseline,'a failed read-back must not reopen or rewrite a completed import');assert.deepEqual(f.vendorItems[0],item);again.tree.unmount();}
 f.uploads[0].bytes=csv;const valid=await autoOpen();await automaticResult(valid);assert.match(valid.finished[0].message,/already up to date.*Stored original verified/);assert.equal(writes(f),before);valid.tree.unmount();
});
await check('automatic original verification never claims legacy proof and rejects malformed new transfer evidence',async()=>{
 const f=fixture(),manual=await open();await upload(manual,'picker');await save(manual);manual.tree.unmount();const before=writes(f);
 const legacy=await autoOpen();await automaticResult(legacy);assert.equal(legacy.finished.length,0);assert.match(text(legacy.tree.toJSON()),/same verified vendor account and list/);assert.equal(f.downloads.length,0);assert.equal(writes(f),before);legacy.tree.unmount();
 const g=fixture(),bad=await autoOpen(csv,{companionEvidence:{...autoProof,sha256:'invalid'}});await automaticResult(bad);assert.equal(bad.finished.length,0);assert.equal(g.calls.applyQuote.length,0);assert.equal(g.downloads.length,0);assert.equal(Object.values(g.importDocs)[0].status,'partial');assert.match(text(bad.tree.toJSON()),/no valid transfer-byte evidence/);assert.equal(bad.issues.length,1);assert.equal(bad.issues[0].status,'needs_attention');assert.match(bad.issues[0].message,/no valid transfer-byte evidence/);bad.tree.unmount();
});
await check('automatic unmount while downloading the retained original prevents quotes, progress and success',async()=>{
 const f=fixture();let release,started=false;f.backend.documents.download=async()=>{started=true;await new Promise(resolve=>{release=resolve;});return new TextEncoder().encode(csv);};
 const p=await autoOpen();for(let i=0;i<100&&!started;i++)await act(async()=>{await new Promise(r=>setTimeout(r,10));});assert.equal(started,true);const updates=f.calls.updateImportDoc.length;
 await act(async()=>p.tree.unmount());await act(async()=>{release();await new Promise(r=>setTimeout(r,30));});assert.equal(p.finished.length,0);assert.equal(f.calls.applyQuote.length,0);assert.equal(f.calls.updateImportDoc.length,updates);assert.equal(Object.values(f.importDocs)[0].status,'processing');
});
console.log(passed+'/47 B1/B2/B3/B4/B5 rendered upload checks passed (local mocked persistence; not live browser/database evidence).');
process.exit(0);
`;
try{
 const outfile=join(dir,'test.mjs');
 await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'jsx'},outfile,bundle:true,platform:'node',format:'esm',jsx:'automatic',define:{'import.meta.env':'{}'},plugins:[{name:'b1-boundaries',setup(b){
  b.onResolve({filter:/import-evidence\.js$/},args=>args.namespace==='evidence-spy'?({path:args.path,namespace:'file'}):({path:'spy',namespace:'evidence-spy'}));
  b.onLoad({filter:/spy/,namespace:'evidence-spy'},()=>({contents:`import {explainImportRow as real} from ${JSON.stringify(process.cwd()+'/src/core/import-evidence.js')};export function explainImportRow(...args){globalThis.__evidenceCalls=(globalThis.__evidenceCalls||0)+1;return real(...args);}`}));
  b.onResolve({filter:/document-reader\.js$/},()=>({path:'reader',namespace:'b1'}));
  b.onLoad({filter:/reader/,namespace:'b1'},()=>({contents:'export async function fileToText(file,{onRead}={}){if(file.readingError)throw new Error(file.readingError);if(file.reading)onRead?.(file.reading);return file.reading?.text??file.text();}'}));
  b.onResolve({filter:/backend\/index\.js$/},()=>({path:'backend',namespace:'b1'}));
  b.onLoad({filter:/backend/,namespace:'b1'},()=>({contents:'export const backend={records:{query:(...args)=>globalThis.__b1Backend.records.query(...args)},documents:{upload:(...args)=>globalThis.__b1Backend.documents.upload(...args),download:(...args)=>globalThis.__b1Backend.documents.download(...args),remove:(...args)=>globalThis.__b1Backend.documents.remove(...args)},pricing:{applyQuote:(...args)=>globalThis.__b1Backend.pricing.applyQuote(...args)},invoices:{record:(...args)=>globalThis.__b1Backend.invoices.record(...args)}};'}));
 }}]});
 const args=inputMode?[outfile,'--product-label-parity']:[outfile];
 process.stdout.write(execFileSync(process.execPath,args,{input:suppliedInput??undefined,encoding:'utf8',timeout:60000,maxBuffer:16*1024*1024}));
}finally{rmSync(dir,{recursive:true,force:true});}
