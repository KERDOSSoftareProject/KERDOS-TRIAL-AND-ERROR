// Executes the production reading engine with real PDF.js and SheetJS.
// OCR is injected: these tests prove per-page dispatch/geometry retention,
// not browser OCR accuracy or a live customer upload.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as XLSX from 'xlsx';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createDocumentReader} from '../src/core/document-reading.js';
let passed=0;
async function check(name,run){await run();console.log('PASS '+name);passed++;}
const file=(name,bytes)=>({name,arrayBuffer:async()=>Uint8Array.from(bytes).buffer,text:async()=>new TextDecoder().decode(bytes)});
const fixture=name=>file(`${name}.pdf`,readFileSync(`scripts/fixtures/pdf/${name}.pdf`));
const makeReader=(overrides={})=>createDocumentReader({
  loadPdf:data=>getDocument({data,disableFontFace:true,useSystemFonts:true}).promise,
  loadWorkbook:async()=>XLSX,recognizePage:async()=>{throw Error('unexpected OCR');},readOther:source=>source.text(),...overrides,
});
await check('PDF pages retain actual positioned text, codes and prices',async()=>{
  const result=await makeReader()(fixture('text-prices'));
  assert.equal(result.pages.length,2);
  assert.deepEqual(result.pages.map(page=>page.number),[1,2]);
  for(const page of result.pages){
    assert.equal(page.source,'embedded-text');assert.ok(page.width>0&&page.height>0);
    const item=page.items.find(item=>item.text.includes('Chicken')||item.text.includes('Turkey'));
    assert.ok(item);assert.equal(item.transform.length,6);assert.ok(item.width>0);assert.ok(item.transform.every(Number.isFinite));
  }
  assert.match(result.text,/12345 Chicken Breast 20 LB CASE 40\.00/);
  assert.match(result.text,/12346 Turkey Breast 20 LB CASE 50\.00/);
});
await check('invoice PDF preserves invoice text and billed quantity/price',async()=>{
  const result=await makeReader()(fixture('text-invoice'));
  assert.match(result.text,/PDF-123456789/);
  assert.match(result.text,/CASE 2 40\.00 80\.00/);
});
await check('mixed PDF reads scanned page even after a text page and retains OCR boxes',async()=>{
  let calls=0;const blocks=[{bbox:{x0:20,y0:30,x1:400,y1:90},text:'Scanned turkey'}];
  const result=await makeReader({recognizePage:async()=>{calls++;return {text:'Scanned turkey',confidence:93,coordinateScale:2,blocks};}})(fixture('mixed-pages'));
  assert.equal(calls,1);assert.equal(result.pages.length,2);assert.equal(result.pages[1].source,'local-ocr');
  assert.match(result.text,/Scanned turkey/);assert.equal(result.pages[1].ocr.coordinateScale,2);assert.deepEqual(result.pages[1].ocr.blocks,blocks);
});
await check('side-by-side PDF keeps both prices and unmodified positioned items',async()=>{
  const result=await makeReader()(fixture('side-by-side'));
  assert.match(result.text,/Chicken Breast.*40\.00/);assert.match(result.text,/Turkey Breast.*50\.00/);
  assert.equal(result.pages[0].items.filter(item=>item.text==='Product').length,2);
});
await check('CSV retains exact source text, quoted commas/newlines, codes and prices',async()=>{
  const text='Code,Description,Price\r\n00123,"Chicken, boneless",41.25\r\n00124,"Turkey\nsmoked",51.75\r\n';
  const result=await makeReader()(file('source.csv',new TextEncoder().encode(text)));
  assert.equal(result.text,text);assert.equal(result.kind,'csv');
  const cells=result.worksheets[0].cells;
  assert.equal(cells.find(cell=>cell.address==='A2').value,'00123');
  assert.equal(cells.find(cell=>cell.address==='B2').value,'Chicken, boneless');
  assert.equal(cells.find(cell=>cell.address==='B3').value,'Turkey\nsmoked');
});
await check('XLSX reads all worksheets, blank tabs, offsets, typed values and formulas',async()=>{
  const book=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Code','Description','Pack','Price Unit','Price'],['00123','Chicken Breast','2/10 LB','CASE',41.25]]),'Chicken');
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([]),'Blank');
  const second=XLSX.utils.aoa_to_sheet([['Code','Description','Pack','Price Unit','Price'],['00124','Turkey Breast','2/10 LB','CASE',51.75]],{origin:'C4'});
  second.G5.f='100-48.25';
  XLSX.utils.book_append_sheet(book,second,'Turkey');
  const result=await makeReader()(file('prices.xlsx',XLSX.write(book,{type:'buffer',bookType:'xlsx'})));
  assert.deepEqual(result.worksheets.map(sheet=>sheet.name),['Chicken','Blank','Turkey']);
  assert.deepEqual(result.worksheets[1].cells,[]);
  const price=result.worksheets[2].cells.find(cell=>cell.address==='G5');
  assert.deepEqual([price.row,price.column,price.value,price.formula],[5,7,51.75,'100-48.25']);
  assert.equal(result.worksheets[2].cells.find(cell=>cell.address==='C5').value,'00124');
  assert.match(result.worksheets[0].text,/00123,Chicken Breast,2\/10 LB,CASE,41\.25/);
  assert.match(result.worksheets[2].text,/00124,Turkey Breast,2\/10 LB,CASE,51\.75/);
  assert.ok(result.text.includes(result.worksheets[0].text)&&result.text.includes(result.worksheets[2].text));
});
await check('PDF cleanup runs on success and OCR failure without returning partial success',async()=>{
  let cleaned=0,destroyed=0;
  const page={getTextContent:async()=>({items:[]}),getViewport:()=>({width:10,height:20}),cleanup:()=>cleaned++};
  const loadPdf=async()=>({numPages:1,getPage:async()=>page,loadingTask:{destroy:async()=>destroyed++}});
  await assert.rejects(()=>makeReader({loadPdf,recognizePage:async()=>{throw Error('OCR unavailable');}})(file('fail.pdf',[])),/OCR unavailable/);
  assert.equal(cleaned,1);assert.equal(destroyed,1);
  await makeReader({loadPdf,recognizePage:async()=>({text:'Readable'})})(file('ok.pdf',[]));
  assert.equal(cleaned,2);assert.equal(destroyed,2);
});
await check('corrupt PDF rejects and a subsequent valid file remains readable',async()=>{
  await assert.rejects(()=>makeReader()(file('corrupt.pdf',new TextEncoder().encode('%PDF-1.7 invalid'))));
  assert.equal((await makeReader()(fixture('text-prices'))).pages.length,2);
});
console.log(`${passed}/${passed} B2 document-reading checks passed`);
