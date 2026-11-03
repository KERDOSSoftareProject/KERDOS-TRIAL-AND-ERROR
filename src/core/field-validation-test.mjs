import assert from 'node:assert/strict';
import {identifyRowFields} from './field-identification.js';
import {validateAssignedFields} from './field-validation.js';
import {parseDocument} from '../ingestion.js';

const cells=['','Supplier Brand','12/1 QT',''];
const fields=identifyRowFields({cells,columnMap:{description:0,brand:1,packSize:2,price:3},confirmedColumns:new Set([0,1,2,3]),rowIndex:2});
const before=JSON.stringify(fields);
const result=validateAssignedFields(fields,{price:null,amount:null});
assert.deepEqual([result.anchorStatus,result.priceStatus,result.retain,result.requiresReview],['missing','missing-or-unreadable',true,true]);
assert.equal(JSON.stringify(fields),before,'validation never changes the source assignment');
assert.equal(fields.values.brand,'Supplier Brand');
assert.equal(result.issues.filter(issue=>issue.kind==='missing-price').length,1);

const header=identifyRowFields({cells:['Milk','Price'],columnMap:{description:0,price:1}});
assert.equal(validateAssignedFields(header,{price:null,amount:null}).retain,false,'a leaked header does not become a product');
const row=parseDocument('Description,Brand,Price\nMilk,Brand A,20.00\n,Brand B,');
assert.equal(row.rows[0].fieldValidation.priceStatus,'parsed');
assert.equal(row.rows[1].fieldValidation.priceStatus,'missing-or-unreadable');
assert.equal(row.rows[1].fieldValidation.anchorStatus,'missing');
assert.equal(row.rows[1].fieldIdentification.bindings.brand.rawValue,'Brand B');
assert.equal(row.rows[1].requiresReview,true);
console.log('PASS B5: validation reports quality without changing assigned cells or dropping reviewable rows.');
