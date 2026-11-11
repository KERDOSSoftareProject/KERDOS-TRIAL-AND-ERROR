import assert from 'node:assert/strict';
import {configureProcurement,createProcurementContext} from '../procurement.js';
import {explainImportRow} from './import-evidence.js';
import {preparePriceImport} from './price-import-review.js';
import {quoteBasisAlternatives} from './quote-basis.js';

// Neither a plausible amount nor nearby rows establish a quoted unit.
// Exercise industry and literal contexts, as well as generic non-food wording.
const cases=[
  {description:'BACON LAYOUT FROZEN',packSize:'1/15 LB'},
  {description:'FASTENERS STEEL',packSize:'4/10 LB'},
  {description:'CLEANING LIQUID',packSize:'4/1 GAL'},
];
for(const industry of ['restaurant','construction']){
  configureProcurement({industry});
  const context=createProcurementContext({industry,vocabulary:[]});
  for(const product of cases)for(const price of [0.01,2.06,16.75,80,10000]){
    const row={...product,price,sellingUnit:null};
    const original=structuredClone(row);
    const prepared=preparePriceImport(row,null,null,[],[],null,context);
    assert.equal(prepared.resolved,null);
    assert.equal(prepared.row.sellingUnit,null);
    assert.ok(prepared.requiresReview);
    assert.ok(prepared.reviewFields.includes('selling_unit'));
    const preview=explainImportRow(row,{documentRows:[{...row,sellingUnit:'LB'}]});
    assert.equal(preview.sellingUnit.value,null);
    assert.equal(preview.priceBasis.value,null);
    assert.equal(preview.unitCost.value,null);
    assert.equal(preview.unitSuggestion,undefined);
    assert.deepEqual(preview.quoteBasisReview,prepared.row.quoteBasisReview);
    assert.deepEqual(prepared.row.quoteBasisReview.alternatives,quoteBasisAlternatives({...row,price:123456},context));
    assert.equal(prepared.row.quoteBasisReview.status,'unresolved');
    assert.deepEqual(prepared.row.statedPriceQuotes||[],[],'possibilities do not become vendor offers');
    assert.deepEqual(row,original,'interpretation must preserve the source');
    const stated=preparePriceImport({...row,sellingUnit:'CASE'},null,null,[],[],null,context);
    assert.equal(stated.resolved.sellingUnit,'CASE','source evidence wins regardless of amount');
    assert.equal(stated.row.quoteBasisReview,null,'resolved evidence clears obsolete clarification');
  }
}

const context=createProcurementContext({industry:'restaurant'});
assert.deepEqual(quoteBasisAlternatives({packSize:'4/10 LB'},context).map(option=>option.sellingUnit),['CASE','EACH','LB']);
assert.deepEqual(quoteBasisAlternatives({packSize:'4/1 GAL'},context).map(option=>option.sellingUnit),['CASE','EACH','GAL']);
for(const packSize of [null,'unreadable','6/10 CN'])assert.deepEqual(quoteBasisAlternatives({packSize},context),[],'unresolved packs do not produce misleading examples');
const changed=preparePriceImport({description:'STEEL WASHERS',price:20,packSize:'4/1 GAL',quoteBasisReview:{alternatives:[{sellingUnit:'LB'}]}});
assert.deepEqual(changed.row.quoteBasisReview.alternatives.map(option=>option.sellingUnit),['CASE','EACH','GAL'],'pack change replaces old examples');

console.log('KERDOS quoted-per evidence: 30 context/product/amount cases, pack changes, source preservation and unranked alternatives passed');
