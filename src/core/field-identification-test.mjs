import assert from 'node:assert/strict';
import {identifyRowFields} from './field-identification.js';
import {requireItemDescription} from './field-validation.js';
import {parseDocument} from '../ingestion.js';
import {createSourceRowSnapshot} from './import-resume.js';
import {retainedUnlinkedRows} from './retained-import-rows.js';
import {importPriceRow} from './import-price-row.js';

const base={description:'Milk',brand:'A much longer supplier brand name',code:'A-101',packSize:'12/1 QT',sellingUnit:'CASE',price:'$25.10'};
for(const order of [Object.keys(base),Object.keys(base).reverse(),['price','brand','description','sellingUnit','code','packSize']]){
 const cells=order.map(field=>base[field]),columnMap=Object.fromEntries(order.map((field,index)=>[field,index]));
 const input={cells,columnMap,sourceHeaders:order,confirmedColumns:new Set(order.map((_,i)=>i)),rowIndex:7};
 const before=JSON.stringify({cells,columnMap});const result=identifyRowFields(input);
 assert.equal(result.values.description,'Milk');assert.equal(result.values.brand,base.brand);assert.equal(result.values.price,'$25.10','field placement does not parse/validate currency');
 assert.equal(result.anchor.status,'identified');assert.equal(result.bindings.price.rowIndex,7);assert.equal(result.bindings.price.columnIndex,columnMap.price);assert.equal(JSON.stringify({cells,columnMap}),before,'source and studied layout remain unchanged');
}
const missing=identifyRowFields({cells:['','Longest Brand','25.10'],columnMap:{description:0,brand:1,price:2},confirmedColumns:new Set([0,1,2])});
assert.equal(missing.anchor.status,'missing');assert.equal(missing.values.description,'');assert.equal(missing.values.brand,'Longest Brand');assert.equal(missing.values.price,'25.10');
assert.equal(identifyRowFields({cells:['Brand only','25.10'],columnMap:{brand:0,price:1}}).anchor.status,'missing','no description column never licenses a brand substitution');
const ambiguous=identifyRowFields({cells:['One text','25.10'],columnMap:{description:0,brand:0,price:1}});assert.equal(ambiguous.anchor.status,'ambiguous');assert.equal(ambiguous.values.description,'');
assert.equal(identifyRowFields({cells:['Milk'],columnMap:{description:0}}).anchor.status,'inferred','inferred layout is not promoted to stated evidence');
assert.equal(identifyRowFields({cells:['Milk'],columnMap:{description:0,price:9}}).values.price,undefined,'absent cells are not filled');

const csv='Code,Description,Brand,Pack,Price Unit,Price\nA-101,,Longest Supplier Brand,12/1 QT,CASE,25.10\nA-102,Milk,Separate Brand,12/1 QT,CASE,26.20';
const parsed=parseDocument(csv);
assert.equal(parsed.rows.length,2,'missing description is retained as a source observation, not silently dropped');
assert.equal(parsed.rows[0].description,'');assert.equal(parsed.rows[0].brand,'Longest Supplier Brand');assert.equal(parsed.rows[1].description,'Milk');assert.equal(parsed.rows[0].fieldIdentification.anchor.status,'missing');assert.ok(parsed.rows[0].issues.some(issue=>issue.kind==='description-anchor'));
assert.equal(parsed.rows[1].fieldIdentification.anchor.rawValue,'Milk');assert.equal(parsed.rows[0].fieldIdentification.bindings.brand.rawValue,'Longest Supplier Brand');
assert.throws(()=>requireItemDescription(parsed.rows[0]),/retained for review/);
let touched=false;const backend=new Proxy({}, {get(){touched=true;throw Error('No write permitted');}});
await assert.rejects(importPriceRow({backend,row:parsed.rows[0],sourceRow:parsed.rows[0]}),/description/);assert.equal(touched,false,'identity missing blocks all quote/catalog/mapping calls');
const pending=retainedUnlinkedRows([{id:'source',vendor_id:'supplier',document_kind:'pricelist',status:'partial',source_rows:createSourceRowSnapshot(parsed.rows),completed_keys:['row:1']}]);
assert.equal(pending.length,1);assert.equal(pending[0].key,'row:0');assert.equal(pending[0].brand,'Longest Supplier Brand');assert.equal(pending[0].price,25.1);assert.equal(pending[0].description,'');

const repeated=parseDocument('Description,Brand,Pack,Price Unit,Price\nMilk,Brand A,12/1 QT,CASE,25.10\nPrice,Pack,Brand,Description,Price Unit\n26.20,12/1 QT,Brand B,Eggs,CASE');
assert.deepEqual(repeated.rows.map(row=>row.description),['Milk','Eggs']);assert.equal(repeated.rows[1].fieldIdentification.anchor.columnIndex,3);assert.equal(repeated.rows[1].fieldIdentification.anchor.status,'identified','a repeated header has its own studied evidence');
const wrapped=identifyRowFields({cells:['American Cheese\nWhite Sliced','4/5 LB','52.00'],columnMap:{description:0,packSize:1,price:2},confirmedColumns:new Set([0,1,2])});
assert.equal(wrapped.anchor.rawValue,'American Cheese\nWhite Sliced','field placement preserves a wrapped description cell already supplied by the reader');
assert.equal(wrapped.values.packSize,'4/5 LB');
console.log('PASS B4: description anchor, reordered columns, raw bindings/provenance, no brand substitution, missing/ambiguous retention, no premature writes, changed headers and wrapped descriptions.');
