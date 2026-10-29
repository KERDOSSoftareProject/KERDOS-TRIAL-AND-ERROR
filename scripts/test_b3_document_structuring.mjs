// Real PDF.js/SheetJS reading and production structuring/parser. OCR geometry
// is a controlled fixture; this is local evidence, not browser OCR accuracy.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import * as XLSX from 'xlsx';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createDocumentReader} from '../src/core/document-reading.js';
import {parseStructuredDocument,structureDocument} from '../src/core/document-structuring.js';
import {parseDocument} from '../src/ingestion.js';
const reader=createDocumentReader({loadPdf:data=>getDocument({data,useSystemFonts:true}).promise,loadWorkbook:async()=>XLSX});
const file=(name,bytes)=>({name,arrayBuffer:async()=>Uint8Array.from(bytes).buffer,text:async()=>new TextDecoder().decode(bytes)});
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
async function pdf(name){return reader(file(`${name}.pdf`,readFileSync(`scripts/fixtures/pdf/${name}.pdf`)));}
const item=(text,x,y,width=60)=>({text,transform:[1,0,0,12,x,y],width,height:12});
const positioned=(items,text='')=>({kind:'pdf',filename:'positioned.pdf',pages:[{number:1,width:900,height:600,source:'embedded-text',items,text}],worksheets:[],text});
const headings=[item('Code',20,550),item('Description',150,550),item('Pack',450,550),item('Price Unit',600,550),item('Price',750,550)];
const product=(code,description,price,y)=>[item(code,20,y),item(description,150,y,150),item('20 LB',450,y),item('CASE',600,y),item(price,750,y)];
await check('actual two-page PDF prices are 40/50, never the 20-LB pack weight',async()=>{
  const r=await pdf('text-prices'),p=parseStructuredDocument(r.text,r);
  assert.deepEqual(p.rows.map(row=>[row.code,row.packSize,row.sellingUnit,row.price]),[['12345','20 LB','CASE',40],['12346','20 LB','CASE',50]]);
  assert.deepEqual(p.rows.map(row=>row.sourceProvenance.page),[1,2]);
  assert.ok(p.rows.every(row=>row.sourceProvenance.cells.some(cell=>cell.words.some(word=>word.transform?.length===6))));
  assert.equal(p.rows[0].sourceProvenance.filename,'text-prices.pdf');
});
await check('actual side-by-side tables pair each description with its own 40/50 price',async()=>{
  const r=await pdf('side-by-side'),p=parseStructuredDocument(r.text,r);
  assert.deepEqual(p.rows.map(row=>[row.description,row.packSize,row.price]),[['Chicken Breast','20 LB',40],['Turkey Breast','20 LB',50]]);
  assert.equal(p.rows[0].sellingUnit,null); // A pack is not a quoted-per declaration.
});
await check('actual invoice PDF retains explicit CASE, quantity 2, unit price 40 and total 80',async()=>{
  const r=await pdf('text-invoice'),p=parseStructuredDocument(r.text,r);
  assert.equal(p.documentKind,'invoice');assert.deepEqual(p.rows.map(row=>[row.qty,row.sellingUnit,row.price,row.amount]),[[2,'CASE',40,80]]);
});
await check('real XLSX independent worksheets retain all rows despite different offsets and column order',async()=>{
  const book=XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Code','Description','Pack','Price Unit','Price'],['00123','Chicken Breast','2/10 LB','CASE',41.25]]),'Chicken');
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([]),'Empty');
  XLSX.utils.book_append_sheet(book,XLSX.utils.aoa_to_sheet([['Price','Description','Code','Price Unit','Pack'],[51.75,'Turkey Breast','00124','CASE','2/10 LB']],{origin:'C4'}),'Turkey');
  const r=await reader(file('all-sheets.xlsx',XLSX.write(book,{type:'buffer',bookType:'xlsx'}))),p=parseStructuredDocument(r.text,r);
  assert.deepEqual(p.rows.map(row=>[row.code,row.price]),[['00123',41.25],['00124',51.75]]);
  assert.deepEqual(p.rows.map(row=>row.sourceProvenance.worksheet),['Chicken','Turkey']);
  assert.ok(p.rows[1].sourceProvenance.cells.flatMap(cell=>cell.cells).some(cell=>cell.address==='C5'&&cell.value===51.75));
});
await check('native CSV preserves quoted commas/newlines and source cells instead of splitting product rows',async()=>{
  const text='Code,Description,Pack,Price Unit,Price\r\n00123,"Chicken, boneless\nbreast",2/10 LB,CASE,41.25\r\n';
  const r=await reader(file('quoted.csv',new TextEncoder().encode(text))),p=parseStructuredDocument(r.text,r);
  assert.equal(p.rows.length,1);assert.equal(p.rows[0].code,'00123');assert.equal(p.rows[0].price,41.25);
  assert.equal(p.rows[0].description,'Chicken, boneless breast');
  assert.equal(p.rows[0].sourceProvenance.cells[1].cells[0].value,'Chicken, boneless\nbreast');
  assert.equal(r.text,text);
});
await check('wrapped description merges by column/nearby geometry and retains both source lines',()=>{
  const r=positioned([...headings,...product('12345','Chicken Breast',40,510),item('Boneless Skinless',150,496,120),...product('12346','Turkey Breast',50,450)]);
  const p=parseStructuredDocument('',r);
  assert.deepEqual(p.rows.map(row=>[row.description,row.price]),[['Chicken Breast Boneless Skinless',40],['Turkey Breast',50]]);
  assert.deepEqual(p.rows[0].sourceProvenance.lines,[1,2]);
});
await check('separate tables and total/tax/page furniture never become extra products',()=>{
  const r=positioned([...headings,...product('12345','Chicken Breast',40,510),item('Total',150,470),item('40.00',750,470),item('Tax: 5.00',150,450),item('Page 1 of 1',150,430),...headings.map(word=>({...word,transform:[1,0,0,12,word.transform[4],390]})),...product('12346','Turkey Breast',50,350)]);
  const p=parseStructuredDocument('',r);assert.deepEqual(p.rows.map(row=>[row.code,row.price]),[['12345',40],['12346',50]]);
  assert.ok(p.skipped.some(line=>line.text==='Total 40.00'));
});
await check('headerless aligned geometry yields rows without inventing an explicit price unit',()=>{
  const r=positioned([...product('12345','Chicken Breast','40.00',510),...product('12346','Turkey Breast','50.00',470),...product('12347','Beef Tenderloin','60.00',430)].filter(word=>word.text!=='CASE'));
  const structure=structureDocument(r);assert.equal(structure.segments[0].kind,'positioned-unlabelled');
  const p=parseStructuredDocument('',r);assert.deepEqual(p.rows.map(row=>row.price),[40,50,60]);
  assert.ok(p.rows.every(row=>!row.billingUnitEvidence&&row.priceNeedsReview));
});
await check('ragged geometry keeps freeform parsing rather than forcing invented columns',()=>{
  const text='Chicken Breast 20 LB $40.00\nTurkey Breast 20 LB $50.00';
  const r=positioned([item('Chicken Breast 20 LB $40.00',20,510,300),item('Turkey Breast 20 LB $50.00',250,450,300)],text);
  const p=parseStructuredDocument(text,r);assert.equal(p.structure.segments[0].kind,'freeform');
  assert.deepEqual(p.rows.map(row=>[row.description,row.price]),parseDocument(text).rows.map(row=>[row.description,row.price]));
  assert.ok(p.rows.every(row=>row.sourceProvenance.fallback));
});
await check('OCR boxes convert scale/direction correctly and retain their original coordinates',()=>{
  const words=[...headings,...product('12345','Chicken Breast',40,510)].map(word=>({text:word.text,bbox:{x0:word.transform[4]*2,y0:(600-word.transform[5]-12)*2,x1:(word.transform[4]+word.width)*2,y1:(600-word.transform[5])*2},confidence:95}));
  const r={filename:'scan.pdf',pages:[{number:1,width:900,height:600,source:'local-ocr',ocr:{coordinateScale:2,blocks:[{paragraphs:[{lines:[{words}]}]}]},text:'scan'}],worksheets:[]};
  const p=parseStructuredDocument('scan',r);assert.equal(p.rows[0].price,40);assert.equal(p.rows[0].sellingUnit,'CASE');
  assert.deepEqual(p.rows[0].sourceProvenance.cells[4].words[0].box,words.at(-1).bbox);
  words.at(-1).confidence=60;const uncertain=parseStructuredDocument('scan',r);
  assert.equal(uncertain.rows[0].priceNeedsReview,true);assert.ok(uncertain.rows[0].issues.some(issue=>issue.kind==='low-confidence-ocr'));
  assert.equal(uncertain.rows[0].price,40);
});
await check('each native layout receives its own remembered header answers',()=>{
  const reading={filename:'layouts.xlsx',pages:[],worksheets:[
    {name:'A',cells:[['Description','Mystery','Price'],['Chicken Breast','20 LB',40]].flatMap((row,r)=>row.map((value,c)=>({row:r+1,column:c+1,address:`${c}:${r}`,value})))},
    {name:'B',cells:[['Price','Description','Other'],[50,'Turkey Breast','10 LB']].flatMap((row,r)=>row.map((value,c)=>({row:r+1,column:c+1,address:`${c}:${r}`,value})))},
  ]};
  const seen=[];
  const p=parseStructuredDocument('',reading,(text,options)=>{const first=parseDocument(text,options);seen.push(first.layout.fingerprint);return parseDocument(text,{...options,layoutAnswers:first.layout.fingerprint.startsWith('description')?{1:'packSize'}:{2:'packSize'}});});
  assert.equal(new Set(seen).size,2);assert.deepEqual(p.rows.map(row=>row.packSize),['20 LB','10 LB']);assert.equal(p.parts.length,2);
});
await check('source document note survives structuring and replay is deterministic without mutating reading',async()=>{
  const r=await pdf('side-by-side');r.text='All prices per CASE\n'+r.text;const before=JSON.stringify(r);
  const first=parseStructuredDocument(r.text,r),again=parseStructuredDocument(r.text,r);
  assert.deepEqual(first,again);assert.equal(JSON.stringify(r),before);assert.ok(first.rows.every(row=>row.sellingUnit==='CASE'));
});
await check('ambiguous unlabeled integer columns fall back instead of treating item codes as prices',()=>{
  const r=positioned([...product('12345','Chicken Breast',40,510),...product('12346','Turkey Breast',50,470),...product('12347','Beef Tenderloin',60,430)].filter(word=>word.text!=='CASE'));
  const p=parseStructuredDocument('',r);
  assert.ok(p.rows.every(row=>row.sourceProvenance.fallback));
  assert.ok(!p.rows.some(row=>[12345,12346,12347].includes(row.price)));
});
await check('rotated words and missing OCR geometry keep their original freeform fallback',()=>{
  const text='Chicken Breast 20 LB $40.00';
  const rotated=positioned([{...item(text,20,510,300),transform:[0,12,-12,0,20,510]}],text);
  const p=parseStructuredDocument(text,rotated);assert.equal(p.structure.segments[0].kind,'freeform');
  assert.deepEqual(p.rows.map(row=>row.price),parseDocument(text).rows.map(row=>row.price));
  const scan={filename:'scan.pdf',pages:[{number:1,width:900,height:600,source:'local-ocr',ocr:{blocks:[]},text}],worksheets:[]};
  assert.equal(parseStructuredDocument(text,scan).structure.segments[0].kind,'freeform');
});
console.log(`${passed}/${passed} B3 structuring checks passed (local; no hosted/browser acceptance claimed).`);
