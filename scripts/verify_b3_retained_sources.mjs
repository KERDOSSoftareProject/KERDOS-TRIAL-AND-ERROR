// Read-only acceptance against an operator-provided private manifest.
// The manifest and customer documents must not be committed to the repository.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {basename,resolve,dirname} from 'node:path';
import {createHash} from 'node:crypto';
import * as XLSX from 'xlsx';
import {getDocument} from 'pdfjs-dist/legacy/build/pdf.mjs';
import {createDocumentReader} from '../src/core/document-reading.js';
import {parseStructuredDocument} from '../src/core/document-structuring.js';
const manifestPath=process.argv[2];if(!manifestPath)throw Error('Provide a private acceptance manifest path.');
const manifest=JSON.parse(readFileSync(manifestPath,'utf8'));
const reader=createDocumentReader({loadPdf:data=>getDocument({data,useSystemFonts:true}).promise,loadWorkbook:async()=>XLSX});
for(const source of manifest.sources){
 const path=resolve(dirname(manifestPath),source.path),bytes=readFileSync(path);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),source.sha256,'Source bytes changed');
 const reading=await reader({name:basename(path),arrayBuffer:async()=>Uint8Array.from(bytes).buffer,text:async()=>bytes.toString()});
 const before=JSON.stringify(reading),result=parseStructuredDocument(reading.text,reading);
 assert.equal(result.rows.length,source.count,'Product row count');
 if(source.duplicatePages!==undefined)assert.equal(result.duplicatePages.length,source.duplicatePages);
 if(source.pageCounts){const actual={};for(const row of result.rows){const page=row.sourceProvenance.page;actual[page]=(actual[page]||0)+1;}assert.deepEqual(actual,source.pageCounts);}
 for(const expected of source.rows||[]){
  const row=result.rows.find(row=>Object.entries(expected.match).every(([key,value])=>row[key]===value));assert.ok(row,'Expected product missing');
  for(const [key,value] of Object.entries(expected.values))assert.deepEqual(row[key],value,'Incorrect retained product field: '+key);
 }
 for(const pattern of source.forbiddenDescriptions||[])assert.ok(!result.rows.some(row=>new RegExp(pattern,'i').test(row.description)),'Non-product text became a product');
 if(source.unconfirmedBilling)assert.ok(result.rows.every(row=>!row.billingUnitEvidence),'A missing billing unit was invented');
 assert.deepEqual(parseStructuredDocument(reading.text,reading),result,'Replay differs');assert.equal(JSON.stringify(reading),before,'Source reading mutated');
 console.log(JSON.stringify({source:source.label,rows:result.rows.length,duplicatePages:result.duplicatePages?.length||0,expectedProductsChecked:source.rows?.length||0,status:'PASS',evidence:'local real-source parser acceptance; no hosted/database writes'}));
}
