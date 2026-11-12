import assert from 'node:assert/strict';
import {quoteGroup,quoteMetrics,chooseQuoteGroup,comparisonUnits,calculatedUnitCost,catalogPackEachCost} from './quote-controls.js';
import {prepareCatalogCorrection} from '../services/catalog-rows.js';
import {casePriceFromQuote,estimateCaseCost,quotePriceOnBasis,measuredQuoteRate,configureVocabulary} from '../procurement.js';
assert.equal(quoteGroup('CSE'),'case');assert.equal(quoteGroup('lbs'),'weight');assert.equal(quoteGroup('FL OZ'),'volume');
assert.equal(chooseQuoteGroup('weight','CASE'),'WEIGHT');assert.equal(chooseQuoteGroup('volume','LB'),'VOLUME');
assert.equal(chooseQuoteGroup('weight','OZ'),'OZ');
assert.deepEqual(quoteMetrics('weight'),['LB','OZ','KG','G']);
assert.deepEqual(quoteMetrics('volume'),['GAL','QT','PT','FLOZ','L','ML']);
const row={id:'vi',organization_id:'o',pack_size:'4/5 LB',selling_unit:'CASE',price:40};
assert.equal(calculatedUnitCost(row,{industry:'Restaurant'}).price,2);
assert.equal(calculatedUnitCost({...row,unit_cost_unit:'OZ'}).price,0.125);
assert.equal(calculatedUnitCost({...row,unit_cost_unit:'EA'}).price,10);
assert.equal(calculatedUnitCost({...row,selling_unit:'LB',price:2}).price,2);
assert.equal(calculatedUnitCost({...row,selling_unit:'EACH',price:10}).price,2);
assert.equal(calculatedUnitCost({...row,selling_unit:'WEIGHT'}),null);
assert.equal(calculatedUnitCost({...row,unit_cost_unit:'GAL'}),null,'never convert weight to volume');
assert.equal(calculatedUnitCost({...row,pack_size:'20'}),null,'missing pack unit is not invented');
assert.deepEqual(comparisonUnits('4/5 LB'),['LB','OZ','KG','G','EA']);
assert.equal(calculatedUnitCost({...row,pack_size:'4/32 FL OZ'},{industry:'Restaurant'}).price,40);
assert.equal(calculatedUnitCost({...row,pack_size:'24 CT'},{industry:'Restaurant'}).unit,'EA');
assert.equal(calculatedUnitCost({...row,pack_size:'6/2 EA',unit_cost_unit:'DOZ'}).price,40);
const retainedPackQuote={...row,pack_size:'6/5 LB',price:51.64,selling_unit:null,
  import_row:{sourceDocumentId:'sheet',rowKey:'row:0',row:{packSize:'6/5 LB',price:'$51.64',priceHeader:'Case Price'}}};
assert.equal(catalogPackEachCost(retainedPackQuote).price,51.64/6);
assert.equal(catalogPackEachCost({...retainedPackQuote,price_unavailable:true,
  import_row:{...retainedPackQuote.import_row,conflicts:['Quoted unit is unresolved.']}}).price,51.64/6);
assert.equal(calculatedUnitCost({...retainedPackQuote,unit_cost_unit:'LB'}).price,1.7213);
assert.equal(catalogPackEachCost({...retainedPackQuote,price:60}),null,'an edited price cannot borrow the old amount evidence');
assert.equal(catalogPackEachCost({...retainedPackQuote,pack_size:'12/5 LB'}),null,'an unmatched pack cannot borrow the source case price');
for(const sourceRow of [{priceHeader:'Price'},{priceHeader:'Each Price'},{sellingUnit:'LB'}]){
  assert.equal(catalogPackEachCost({...retainedPackQuote,import_row:{...retainedPackQuote.import_row,
    row:{...retainedPackQuote.import_row.row,...sourceRow}}}),null);
}
const confirmedPack={...row,field_resolutions:{selling_unit:{value:'CASE',confirmedBy:'owner'}}};
assert.equal(catalogPackEachCost({...confirmedPack,pack_size:'24 CT',price:48}).price,2);
assert.equal(catalogPackEachCost({...confirmedPack,pack_size:'6/2 EA',price:48}).price,8);
assert.equal(catalogPackEachCost({...confirmedPack,price_unavailable:true}),null);
const mapping={id:'m',organization_id:'o',vendor_item_id:'vi'};
assert.equal(prepareCatalogCorrection({organizationId:'o',vendorItem:row,mapping,patch:{selling_unit:'WEIGHT',brand:'A'}}).priceAvailable,false);
assert.throws(()=>prepareCatalogCorrection({organizationId:'o',vendorItem:row,mapping,patch:{unit_cost_unit:'GAL'}}),/compatible/);
console.log('Grouped quote controls and conversion checks passed.');

for(const pack_size of ['3/7 LBA','3/7 LB AVG','2/6-8 LBA']){
  assert.equal(calculatedUnitCost({...row,pack_size,selling_unit:'LB',price:4,unit_cost_unit:'OZ'}).price,0.25);
  assert.equal(calculatedUnitCost({...row,pack_size,selling_unit:'LB',price:4,unit_cost_unit:'EA'}),null);
  assert.equal(casePriceFromQuote(4,'measure','LB',pack_size),null,'no exact case charge from average/range weight');
  assert.equal(quotePriceOnBasis({price:4,basis:'measure',unit:'LB',packSize:pack_size},{basis:'measure',unit:'OZ'}),0.25,'invoice comparison uses stated rate directly');
  assert.equal(quotePriceOnBasis({price:4,basis:'measure',unit:'LB',packSize:pack_size},{basis:'case'}),null,'estimated case must not become invoice variance evidence');
  assert.equal(prepareCatalogCorrection({organizationId:'o',vendorItem:{...row,pack_size,selling_unit:'LB'},mapping,patch:{approve_row:true}}).priceAvailable,false);
}
assert.deepEqual(estimateCaseCost(4,'measure','LB','3/7 LBA'),{amount:84,minimum:null,maximum:null,estimated:true});
assert.deepEqual(estimateCaseCost(4,'measure','LB','2/6-8 LBA'),{amount:null,minimum:48,maximum:64,estimated:true});
assert.equal(estimateCaseCost(4,'measure','GAL','2/6-8 LBA'),null);
assert.equal(casePriceFromQuote(30,'case',null,'3/7 LBA'),30,'a genuinely stated case quote remains exact');
assert.equal(calculatedUnitCost({...row,pack_size:'3/7 LBA',selling_unit:'CS',price:30}).estimated,true,'unit cost derived from a fixed case price and average weight is labeled estimated');
assert.equal(measuredQuoteRate(0.000013,'LB','LB').price,0.000013,'unchanged units preserve the full stated rate');
configureVocabulary([{kind:'unit',term:'sheet',canonical:'SHEET'}]);
assert.equal(quotePriceOnBasis({price:0.012345,basis:'measure',unit:'sheet',packSize:'100 sheet'},{basis:'measure',unit:'sheet'}),0.012345);
assert.equal(measuredQuoteRate(3,'CN','CN'),null,'an unconfirmed packaging code is not a measured unit');
configureVocabulary([]);
