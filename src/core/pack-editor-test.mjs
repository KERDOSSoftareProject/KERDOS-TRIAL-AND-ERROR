import assert from 'node:assert/strict';
import {editablePack,serializePack} from './pack-editor.js';
import {parsePackSize} from '../procurement.js';
import {unitLabel} from './unit-labels.js';
assert.deepEqual(editablePack('4/5 LB'),{type:'case',count:4,size:5,unit:'LB',catchWeight:false});
assert.deepEqual(editablePack('5 LB'),{type:'each',count:1,size:5,unit:'LB',catchWeight:false});
assert.equal(editablePack('6/24 CT').count,6);assert.equal(editablePack('6/24 CT').size,24);
const partial={type:'case',count:4,size:'',unit:'',catchWeight:false};
const text=serializePack(partial);
assert.deepEqual(editablePack(text),partial,'partial improvements survive reload');
assert.ok(!parsePackSize(text)?.parsed,'partial edits cannot be ordered as fully understood');
assert.equal(serializePack({...partial,size:5,unit:'LB'}),'4/5 LB');
assert.equal(serializePack({...partial,type:'each',size:5,unit:'LB'}),'5 LB');
assert.equal(unitLabel('FT'),'Feet');assert.equal(unitLabel('LB'),'Pounds');assert.equal(unitLabel('OZ'),'Ounces');
console.log('Pack editor checks passed: two levels retained, partial edits durable, complete each/case and full unit names.');

const can=serializePack({...editablePack('6/#10 CN'),count:12});
assert.equal(can,'12/#10 CN');
assert.equal(parsePackSize(can).parsed,true);
assert.equal(parsePackSize(can).caseQty,12);

const nested={type:'case',count:3,innerCounts:[4],size:200,unit:'ML',catchWeight:false};
assert.deepEqual(editablePack('3/4/200 ML'),nested);
assert.equal(serializePack(nested),'3/4/200 ML');
assert.equal(serializePack({...nested,count:6}),'6/4/200 ML');
const unfinished={...nested,innerCounts:[''],catchWeight:true};
assert.deepEqual(editablePack(serializePack(unfinished)),unfinished,'incomplete nested edits retain every level and average marker');
assert.ok(!parsePackSize(serializePack(unfinished))?.parsed);

const rangedParts=editablePack('2/6-8 LBA');
assert.equal(rangedParts.rangeMinimum,6);assert.equal(rangedParts.rangeMaximum,8);
assert.equal(rangedParts.size,'');
assert.equal(serializePack(rangedParts),'2/6-8 LB AVG');
assert.deepEqual(editablePack(serializePack(rangedParts)),rangedParts);
const rangeDraft={...rangedParts,rangeMaximum:''};
assert.deepEqual(editablePack(serializePack(rangeDraft)),rangeDraft);
assert.ok(!parsePackSize(serializePack(rangeDraft))?.parsed);
const averageDraft={type:'case',count:3,size:'',unit:'LB',catchWeight:true};
assert.deepEqual(editablePack(serializePack(averageDraft)),averageDraft,'partial ordinary packs retain the average marker too');
