import assert from 'node:assert/strict';
import {parseDocument,mapColumnsFromHeader} from '../src/ingestion.js';
import * as XLSX from 'xlsx';
import {createDocumentReader} from '../src/core/document-reading.js';
import {parseStructuredDocument} from '../src/core/document-structuring.js';
const header=['Line Number','Group Name','Product Number','Product Description','Product Brand','Product Package Size','Customer Product Number','Product Price','Product UOM','Class Description','Storage Description'];
const csvRow=cells=>cells.map(s=>'"'+String(s).replace(/"/g,'""')+'"').join(',');
// Generated test values only. No client account, real supplier items or prices.
const input=Array.from({length:87},(_,i)=>[i+1,'Example Group',`TEST-${1000+i}`,`Sample cooked product ${i+1}`,i===84?'PRICE PRODUCT NAME':'Example brand',i%2?'2/6 LB':'4/250 ML','',`$${(20+i/100).toFixed(2)}`,i%2?'LB':'CS','Example class','REF 33 - 40 NOT RAW']);
const csv=[header,...input].map(csvRow).join('\n');
const reader=createDocumentReader({loadWorkbook:async()=>XLSX});
const reading=await reader({name:'synthetic-export.csv',text:async()=>csv});
assert.equal(new Set(reading.worksheets[0].cells.map(cell=>cell.row)).size,88);
const parsed=parseStructuredDocument(csv,reading);
assert.equal(parsed.parts.length,1,'a product brand containing PRICE/PRODUCT must not split the table');
assert.equal(parsed.parts[0].layout.unknown.length,5,'only the five real metadata headings require review');
assert.ok(parsed.parts[0].layout.unknown.every(h=>header.includes(h.label)));
assert.deepEqual(parsed.rows.map(row=>row.code),parseDocument(csv).rows.map(row=>row.code));
assert.equal(parsed.rows.length,87);assert.equal(parsed.skipped.length,0);
assert.deepEqual(mapColumnsFromHeader(header),{description:3,code:2,brand:4,sellingUnit:8,packSize:5,price:7});
for(const [i,source] of input.entries()){
 const row=parsed.rows[i];assert.equal(row.code,source[2]);assert.equal(row.description,source[3]);assert.equal(row.brand,source[4]);assert.equal(row.packSize,source[5]);assert.equal(row.price,Number(source[7].slice(1)));assert.equal(row.sellingUnit,source[8]);
 assert.ok(row.sourceMetadata.some(cell=>cell.header==='Storage Description'&&cell.value===source[10]));assert.ok(!row.description.includes('Example Group'));assert.equal(row.billingUnitEvidence?.header,'Product UOM');assert.ok(!row.cellConflicts?.some(conflict=>conflict.field==='preparation'));
}
const reversed=mapColumnsFromHeader(['Group Name','Item','Description','Product Price']);assert.equal(reversed.description,2);
const emptyUnit=parseDocument([header,[1,'Group','TEST-EMPTY','Sample item','Brand','10 LB','','0.00','','Class','Dry']].map(csvRow).join('\n')).rows[0];assert.equal(emptyUnit.price,0);assert.equal(emptyUnit.sellingUnit,null);assert.equal(emptyUnit.priceUnavailable,true);
console.log('PASS real CSV reader → table structuring → field identification retains 87 synthetic export rows with exact fields and only genuine metadata headings');
