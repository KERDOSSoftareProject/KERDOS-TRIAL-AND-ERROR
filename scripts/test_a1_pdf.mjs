// Executed PDFium + existing OCR/parser/importer checks, with retained PDF
// fixtures. This is local evidence; it does not claim hosted or email delivery.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {gunzipSync} from 'node:zlib';
import {PDFiumModule} from '@hyzyla/pdfium';
import UPNG from 'upng-js';
import {createPdfPageReader,PdfInputError,validatePdf} from '../supabase/functions/pdf-text/pdf-reader.mjs';
import {createImageRecognizer} from '../supabase/functions/image-text/image-ocr.mjs';
import {extractImageText} from '../supabase/functions/process-attachment/image-text-client.mjs';
import {extractPdfText} from '../supabase/functions/process-attachment/pdf-text-client.mjs';
import {readAttachment,FileReadError} from '../supabase/functions/process-attachment/portable-file-reader.mjs';
import {parseDocument} from '../src/ingestion.js';
import {prepareAutomaticInvoice} from '../src/core/automatic-invoice.js';
import {processAttachmentInBackground} from '../supabase/functions/process-attachment/background-import.mjs';
import {createRecords} from '../src/backend/records.js';
const require=createRequire(import.meta.url),fixture=name=>new Uint8Array(readFileSync(`scripts/fixtures/pdf/${name}.pdf`));
const encode=async(p,w,h)=>new Uint8Array(UPNG.encode([p.buffer.slice(p.byteOffset,p.byteOffset+p.byteLength)],w,h,0));
const readPage=createPdfPageReader(()=>PDFiumModule({wasmBinary:readFileSync(require.resolve('@hyzyla/pdfium/pdfium.wasm'))}),encode);
const recognize=createImageRecognizer(()=>require('tesseract.js-core/tesseract-core-simd-lstm.wasm.js')({}),async()=>gunzipSync(readFileSync('public/ocr/eng.traineddata.gz')),async bytes=>new Uint8Array(UPNG.toRGBA8(UPNG.decode(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength)))[0]),encode);
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
function reader(bytes,{renewLease=async()=>{},invoke}={}){
  return extractPdfText(bytes,{renewLease,invoke:invoke||(async({page})=>({ok:true,data:await readPage(bytes,page)})),imageTextReader:image=>extractImageText(image,{renewLease,invoke:async({part})=>({ok:true,data:await recognize(image,part)})})});
}
const text=fixture('text-prices');
await check('two text pages preserve columns, repeated headers, every code/unit/price',async()=>{
  let renewals=0;
  const result=await readAttachment(text,'application/octet-stream','prices.pdf',{pdfTextReader:b=>reader(b,{renewLease:async()=>{renewals++;}})});
  assert.equal(result.pdf.pages,2);assert.equal(renewals,3);
  assert.deepEqual(parseDocument(result.lines.join('\n')).rows.map(r=>[r.code,r.description,r.sellingUnit,r.price]),[['12345','Chicken Breast','CASE',40],['12346','Turkey Breast','CASE',50]]);
  assert.ok(result.ocr.lines.every(line=>line.confidence===100&&line.source==='embedded-text'));
});
await check('side-by-side PDF tables keep each product paired with its own price',async()=>{
  const result=await reader(fixture('side-by-side'));
  assert.deepEqual(parseDocument(result.lines.join('\n')).rows.map(r=>[r.description,r.price]),[['Chicken Breast',40],['Turkey Breast',50]]);
});
await check('scanned price sheet renders through real OCR with explicit CASE and both prices',async()=>{
  const result=await reader(fixture('scanned-prices'));
  assert.deepEqual(parseDocument(result.lines.join('\n')).rows.map(r=>[r.code,r.sellingUnit,r.price]),[['12345','CASE',40],['12346','CASE',50]]);
  assert.ok(result.ocr.lines.every(line=>line.confidence>=90&&line.source==='scanned-page'));
});
await check('mixed text/scanned PDF reads each page; text presence never suppresses the scan',async()=>{
  const result=await reader(fixture('mixed-pages'));
  assert.equal(result.pdf.pages,2);
  assert.deepEqual(parseDocument(result.lines.join('\n')).rows.map(r=>r.code),['12345','12345','12346']);
  assert.ok(result.ocr.lines.some(line=>line.source==='embedded-text'));assert.ok(result.ocr.lines.some(line=>line.source==='scanned-page'));
});
const vendorItems=[{id:'vi-1',organization_id:'org',vendor_id:'vendor',vendor_item_code:'12345',description:'Chicken Breast',pack_size:'20 LB'}];
for(const [name,number] of [['text-invoice','PDF-123456789'],['scanned-invoice','123456789']])await check(`${name} retains invoice number/date, billed CASE evidence and 2×40=80`,async()=>{
  const result=await reader(fixture(name)),text=result.lines.join('\n');
  const prepared=prepareAutomaticInvoice({text,rows:parseDocument(text).rows,organizationId:'org',vendorId:'vendor',vendorItems});
  assert.equal(prepared.reason,null);assert.equal(prepared.header.invoice_number,number);assert.equal(prepared.header.invoice_date,'2026-10-28');assert.equal(prepared.header.total_amount,80);
  assert.deepEqual(prepared.lines.map(l=>[l.quantity,l.unit_price,l.line_total,l.selling_unit]),[[2,40,80,'CASE']]);
  assert.equal(prepared.lines[0].billing_unit_evidence.unit,'CASE');assert.ok(result.ocr.lines.every(l=>l.confidence>=90));
});
await check('actual PDF bytes reach existing background atomic invoice save with original filename',async()=>{
  let saved;const statuses=[];const bytes=fixture('text-invoice');
  const backend={records:createRecords(async spec=>({data:spec.table==='vendor_items'?vendorItems:[],error:null})),attachments:{download:async()=>bytes,extractPdfText:reader,setStatus:async(...args)=>statuses.push(args)},invoices:{recordAutomatic:async record=>{saved=record;}}};
  const result=await processAttachmentInBackground(backend,{id:'att',filename:'source.pdf',content_type:'application/pdf',storage_path:'org/retained/source',file_size_bytes:bytes.length},{organizationId:'org',vendorId:'vendor',documentType:'invoice'});
  assert.equal(result.outcome,'auto_imported');assert.equal(statuses.length,0);assert.equal(saved.header.file_name,'source.pdf');assert.equal(saved.header.file_path,'org/retained/source');assert.equal(saved.header.total_amount,80);assert.equal(saved.lines.length,1);
});
await check('unreadable scan region remains flagged; readable later price still parses',async()=>{
  const result=await reader(fixture('uncertain-prices'));
  assert.ok(result.ocr.lines.some(line=>line.confidence===0&&line.text.includes('Unrecognized image content')));
  assert.deepEqual(parseDocument(result.lines.join('\n')).rows.map(r=>[r.code,r.price]),[['12346',50]]);
});
await check('nonpricing image PDF produces no invented products or prices',async()=>{
  const result=await reader(fixture('non-pricing'));assert.equal(parseDocument(result.lines.join('\n')).rows.length,0);
});
await check('encrypted, corrupt and excessive-page PDFs fail safely, then engine remains usable',async()=>{
  await assert.rejects(()=>readPage(fixture('encrypted')),error=>error instanceof PdfInputError&&/password/.test(error.message));
  await assert.rejects(()=>readPage(new TextEncoder().encode('%PDF-1.7\ninvalid')),PdfInputError);
  await assert.rejects(()=>readPage(fixture('too-many-pages')),PdfInputError);
  assert.throws(()=>validatePdf(new Uint8Array(5*1024*1024+1)),PdfInputError);
  assert.equal((await readPage(text,1)).page,1);
});
await check('lost attachment lease stops PDF handoff before reading',async()=>{
  let calls=0;await assert.rejects(()=>reader(text,{renewLease:async()=>{throw Error('LEASE_LOST');},invoke:async()=>{calls++;}}),/LEASE_LOST/);assert.equal(calls,0);
});
await check('temporary PDF outage retries; corrupt source becomes a visible exception',async()=>{
  await assert.rejects(()=>reader(text,{invoke:async()=>({ok:false,status:503})}),e=>!(e instanceof FileReadError)&&/retry/.test(e.message));
  await assert.rejects(()=>reader(text,{invoke:async()=>({ok:false,status:422,error:'Corrupt PDF'})}),FileReadError);
});
await check('incomplete page responses cannot silently drop pages or claim completion',async()=>{
  await assert.rejects(()=>reader(text,{invoke:async({page})=>({ok:true,data:{page,pages:page===0?2:1,kind:'text',lines:[]}})}),/Incomplete/);
  await assert.rejects(()=>reader(text,{invoke:async()=>({ok:true,data:{page:1,pages:1,kind:'text',lines:[]}})}),/Incomplete/);
  await assert.rejects(()=>reader(text,{invoke:async()=>({ok:true,data:{page:0,pages:1,kind:'image',width:100,height:100,content:'bad'}})}),/Invalid PDF page image/);
});
await check('failed later-page extraction prevents every document/invoice/price write',async()=>{
  let writes=0;
  const backend={records:{query:()=>{writes++;throw Error('No database access allowed');}},attachments:{download:async()=>text,extractPdfText:bytes=>reader(bytes,{invoke:async({page})=>page===0?{ok:true,data:await readPage(bytes,page)}:{ok:false,status:503}}),setStatus:async()=>{writes++;}}};
  await assert.rejects(()=>processAttachmentInBackground(backend,{id:'att',filename:'prices.pdf',content_type:'application/pdf',storage_path:'org/retained/pdf'},{organizationId:'org',vendorId:'vendor',documentType:'pricelist'}),/retry/);
  assert.equal(writes,0);
});
await check('parallel page requests serialize safely and retain their own document contents',async()=>{
  const results=await Promise.all([readPage(text,0),readPage(fixture('text-invoice'),0),readPage(text,1)]);
  assert.ok(results[0].lines.some(l=>l.includes('12345')));assert.ok(results[1].lines.some(l=>l.includes('PDF-123456789')));assert.ok(results[2].lines.some(l=>l.includes('12346')));
});
await check('failed raster engine attempt releases queue and permits a clean automatic retry',async()=>{
  let fail=true,loads=0;
  const recover=createPdfPageReader(async()=>{loads++;return PDFiumModule({wasmBinary:readFileSync(require.resolve('@hyzyla/pdfium/pdfium.wasm'))});},async(...args)=>{if(fail)throw Error('Raster encoder unavailable');return encode(...args);});
  await assert.rejects(()=>recover(fixture('scanned-prices')),/Raster encoder unavailable/);
  fail=false;assert.equal((await recover(fixture('scanned-prices'))).kind,'image');assert.equal(loads,2);
});
console.log(`${passed}/${passed} executed automatic PDF checks passed (local evidence).`);
