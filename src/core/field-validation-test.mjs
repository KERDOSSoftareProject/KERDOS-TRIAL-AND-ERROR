import assert from 'node:assert/strict';
import {identifyRowFields} from './field-identification.js';
import {assessBoundFields,validateAssignedFields,withRowValidation} from './field-validation.js';
import {parseDocument} from '../ingestion.js';
import {prepareAutomaticInvoice} from './automatic-invoice.js';
import {preparePriceImport} from './price-import-review.js';

const bind = options => identifyRowFields({sourceHeaders: [], fieldOrigins: {}, rowIndex: 0, ...options});

const cells=['','Supplier Brand','12/1 QT',''];
const fields=bind({cells,columnMap:{description:0,brand:1,packSize:2,price:3},fieldOrigins:{description:'stated',brand:'stated',packSize:'stated',price:'stated'},rowIndex:2});
const before=JSON.stringify(fields);
const result=validateAssignedFields(fields,{price:null,amount:null});
assert.deepEqual([result.anchorStatus,result.priceStatus,result.retain,result.requiresReview],['missing','missing-or-unreadable',true,true]);
assert.equal(JSON.stringify(fields),before,'validation never changes the source assignment');
assert.equal(fields.values.brand,'Supplier Brand');
assert.equal(result.issues.filter(issue=>issue.kind==='missing-price').length,1);
const quality=assessBoundFields(fields);
assert.equal(quality.fields.brand.status,'present');
assert.equal(quality.fields.description.status,'missing');
assert.equal(quality.fields.price.status,'missing');
assert.equal(quality.fields.price.accuracy,0);
assert.equal(JSON.stringify(fields),before,'quality assessment leaves all bindings unchanged');
const noDescriptionColumn=bind({cells:['Vendor Brand','20.00'],columnMap:{brand:0,price:1}});
assert.deepEqual(assessBoundFields(noDescriptionColumn).fields.description,{status:'missing',columnIndex:null,evidence:'missing',accuracy:0});
assert.equal(noDescriptionColumn.values.brand,'Vendor Brand','validation never reassigns the brand as a description');

const conflicting=bind({cells:['Milk','20.00'],columnMap:{description:0,price:1,packSize:1}});
assert.equal(assessBoundFields(conflicting).fields.price.status,'conflict','two roles on one source cell stay unresolved');
assert.equal(assessBoundFields(conflicting).fields.price.accuracy,null);
assert.deepEqual(assessBoundFields(conflicting).fields.price.conflictsWith,['packSize']);
const malformed=bind({cells:['Milk','20.00','BAD PACK'],columnMap:{description:0,price:1,packSize:2}});
assert.equal(assessBoundFields(malformed).fields.packSize.status,'invalid');
assert.match(assessBoundFields(malformed).cellIssues.packSize,/complete pack/);
const malformedNumbers=bind({cells:['Milk','two','$20.00','not a total'],columnMap:{description:0,qty:1,price:2,amount:3},fieldOrigins:{description:'stated',qty:'stated',price:'stated',amount:'stated'}});
const numberQuality=assessBoundFields(malformedNumbers);
assert.equal(numberQuality.fields.qty.status,'invalid');
assert.equal(numberQuality.fields.qty.accuracy,null);
assert.match(numberQuality.cellIssues.qty,/not a quantity/);
assert.equal(numberQuality.fields.amount.status,'invalid');
assert.match(numberQuality.cellIssues.amount,/not an amount/);
assert.equal(numberQuality.fields.price.accuracy,100,'a separately readable quoted price keeps its own evidence');

const header=bind({cells:['Milk','Price'],columnMap:{description:0,price:1}});
assert.equal(validateAssignedFields(header,{price:null,amount:null}).retain,false,'a leaked header does not become a product');
const unreadableText=parseDocument('Description,Price\nMilk,bad');
assert.equal(unreadableText.rows.length,1,'an unreadable textual price does not erase a product source row');
assert.equal(unreadableText.rows[0].description,'Milk');
assert.equal(unreadableText.rows[0].fieldValidation.fields.price.status,'invalid');
assert.equal(unreadableText.rows[0].fieldValidation.priceStatus,'missing-or-unreadable');
assert.equal(unreadableText.rows[0].priceUnavailable,true);
assert.equal(unreadableText.rows[0].requiresReview,true);
const amountOnly=parseDocument('Description,Amount\nMilk,bad');
assert.equal(amountOnly.rows.length,1,'an unreadable amount-only row remains source evidence');
assert.equal(amountOnly.rows[0].fieldValidation.fields.amount.status,'invalid');
assert.equal(amountOnly.rows[0].fieldValidation.priceStatus,'missing-or-unreadable');
assert.equal(amountOnly.rows[0].priceUnavailable,true);
assert.equal(amountOnly.rows[0].requiresReview,true);
assert.equal(amountOnly.rows[0].issues.find(issue=>issue.kind==='missing-price')?.field,'amount');
const blankAmount=parseDocument('Description,Amount\nMilk,');
assert.equal(blankAmount.rows.length,1,'a blank assigned amount remains reviewable');
assert.equal(blankAmount.rows[0].fieldValidation.fields.amount.status,'missing');
const extendedSheet=parseDocument('Description,Qty,Amount\nMilk,2,40.00').rows[0];
assert.equal(extendedSheet.amount,40,'the sheet retains its stated total');
assert.equal(extendedSheet.qty,2,'the sheet retains its stated quantity');
assert.equal(extendedSheet.price,null,'a line total is not copied to unit price');
assert.equal(extendedSheet.priceUnavailable,true,'the unverified amount cannot become an ordering quote');
assert.equal(extendedSheet.fieldValidation.priceStatus,'missing-unit-price');
assert.equal(extendedSheet.requiresReview,true);
assert.ok(extendedSheet.issues.some(issue=>String(issue).includes('not a stated unit price')));
assert.equal(parseDocument('Price Sheet\nDescription,Qty,Amount\nMilk,2,40.00').rows[0].price,null,'an explicit price sheet has the same safe treatment');
assert.equal(parseDocument('Description,Qty,Price,Amount\nMilk,2,20.00,40.00').rows[0].price,20,'a stated unit price remains authoritative');
assert.equal(parseDocument('Description,Amount\nMilk,40.00').rows[0].price,40,'a sole amount column retains its existing quote interpretation');
for(const source of ['Description,Line Total\nMilk,40.00','Description,Extended Price\nMilk,40.00','Description,Qty,Amount\nMilk,,40.00']){
 const held=parseDocument(source).rows[0];
 assert.equal(held.amount,40,'the source total remains available with no quantity value');
 assert.equal(held.price,null,'an explicit total or a total beside an assigned quantity cannot become the quote');
 assert.equal(held.requiresReview,true);
}
const invalidPrice=parseDocument('Description,Qty,Price,Amount\nMilk,2,bad,40.00').rows[0];
assert.equal(invalidPrice.price,null,'a malformed unit price is held even with a readable total');
assert.equal(invalidPrice.fieldIdentification.bindings.price.rawValue,'bad');
assert.deepEqual([invalidPrice.fieldValidation.fields.price.status,invalidPrice.fieldValidation.fields.price.columnIndex],['invalid',2]);
const heldExtended=preparePriceImport({...extendedSheet,packSize:'12/1 QT',sellingUnit:'CASE'},null,null,extendedSheet.issues);
assert.equal(heldExtended.requiresReview,true,'the import boundary retains the source as a review item');
assert.equal(heldExtended.row.price,null,'the import boundary does not recreate a quote from the total');
assert.equal(validateAssignedFields(bind({cells:['Milk','Amount'],columnMap:{description:0,amount:1}}),{}).retain,false,'an amount header is not an item');
const mixedCells=bind({cells:['Milk','bad','Amount'],columnMap:{description:0,price:1,amount:2}});
const mixedResult=validateAssignedFields(mixedCells,{price:null,amount:null});
assert.equal(mixedResult.retain,true,'one leaked column label does not erase another unreadable assigned cell');
assert.equal(mixedResult.issues.find(issue=>issue.kind==='missing-price')?.field,'price');
const priceCases=[
 ['plain decimal','20.00',20,'present'],
 ['currency symbol','$20.00',20,'present'],
 ['decimal comma','"12,50"',12.5,'present'],
 ['accounting credit','(24.00)',-24,'present'],
 ['each qualifier','$12.50 ea',12.5,'present'],
 ['case qualifier','45.00/cs',45,'present'],
 ['weight qualifier','3.99/LB',3.99,'present'],
 ['worded qualifier','50.00 per case',50,'present'],
 ['empty price','',null,'missing'],
 ['unreadable price','bad',null,'invalid'],
];
for(const [name,cell,value,status] of priceCases){
 const parsed=parseDocument(`Description,Price\nMilk,${cell}`);
 assert.equal(parsed.rows.length,1,`${name}: preserve the source row`);
 assert.equal(parsed.rows[0].price,value,`${name}: extract assigned value`);
 assert.equal(parsed.rows[0].fieldValidation.fields.price.status,status,`${name}: validate the same cell`);
}
const row=parseDocument('Description,Brand,Price\nMilk,Brand A,20.00\n,Brand B,');
assert.equal(row.rows[0].fieldValidation.priceStatus,'parsed');
assert.equal(row.rows[1].fieldValidation.priceStatus,'missing-or-unreadable');
assert.equal(row.rows[1].fieldValidation.anchorStatus,'missing');
assert.equal(row.rows[1].fieldValidation.fields.brand.status,'present');
assert.equal(row.rows[1].fieldValidation.fields.price.status,'missing');
assert.equal(row.rows[1].fieldIdentification.bindings.brand.rawValue,'Brand B');
assert.equal(row.rows[1].fieldIdentification.bindings.brand.evidence,'stated');
assert.equal(row.rows[1].fieldValidation.fields.brand.accuracy,100);
const remembered=parseDocument('Description,Price\nMilk,20.00',{layoutAnswers:{0:'description'}}).rows[0];
assert.equal(remembered.fieldIdentification.bindings.description.evidence,'remembered');
assert.equal(remembered.fieldValidation.fields.description.accuracy,100);
const inferred=bind({cells:['Milk'],columnMap:{description:0},fieldOrigins:{description:'inferred'}});
assert.equal(assessBoundFields(inferred).fields.description.accuracy,70);
const noteBeforeDescription=parseDocument('Notes,Description,Price\nAB-100,VITAMIN B12,12.50').rows[0];
assert.equal(noteBeforeDescription.code,null);
assert.deepEqual(noteBeforeDescription.details,['AB-100']);
assert.deepEqual(noteBeforeDescription.fieldValidation.fields.code,{status:'missing',columnIndex:null,evidence:'missing',accuracy:0});
const blankAssignedCode=parseDocument('Material,Vendor Code,Description,Price\nAB-100,,VITAMIN B12,12.50').rows[0];
assert.equal(blankAssignedCode.code,null,'an explicitly blank code remains blank');
assert.equal(blankAssignedCode.fieldValidation.fields.code.columnIndex,1);
const inferredCode=parseDocument('Material,Description,Price\nX2700,TERRY TOWEL WHITE,12.90').rows[0];
assert.equal(inferredCode.code,'X2700');
assert.deepEqual(inferredCode.fieldValidation.fields.code,{status:'inferred',columnIndex:0,evidence:'inferred',accuracy:70});
const statedCode=parseDocument('Vendor Code,Description,Price\nCIDER,APPLE,26.15').rows[0];
assert.equal(statedCode.code,'CIDER','explicit alphabetic vendor codes remain valid');
assert.equal(statedCode.fieldValidation.fields.code.accuracy,100);
assert.equal(row.rows[1].requiresReview,true);
const arithmetic=parseDocument('Description,Qty,Price,Amount\nMilk,2,85.60,100.00').rows[0];
assert.equal(arithmetic.price,85.60,'a disagreement never replaces the stated price');
assert.equal(arithmetic.fieldValidation.fields.price.status,'conflict');
assert.equal(arithmetic.fieldValidation.fields.price.accuracy,null);
assert.match(arithmetic.fieldValidation.conflicts[0].note,/qty\(2\)/);
const invalidRow=parseDocument('Description,Qty,Price,Amount\nMilk,two,20.00,not a total').rows[0];
assert.equal(invalidRow.description,'Milk');
assert.equal(invalidRow.fieldValidation.fields.qty.status,'invalid');
assert.equal(invalidRow.fieldValidation.fields.amount.status,'invalid');
assert.equal(invalidRow.price,20,'the stated price is retained even when neighboring numeric fields are unreadable');
assert.ok(invalidRow.issues.some(issue=>issue.field==='qty'),'an invalid assigned quantity is visible in review');
assert.ok(invalidRow.issues.some(issue=>issue.field==='amount'),'an invalid assigned total is visible in review');
for(const [heading,priceColumn] of [['Description,Qty,Amount\nMilk,2,40.00',null],['Description,Qty,Unit Price,Amount\nMilk,2,,40.00',2]]){
 const invoice=parseDocument(`Invoice Date: 2026-11-03\nInvoice # 123\n${heading}`).rows[0];
 assert.equal(invoice.amount,40,'the invoice keeps its stated extended amount');
 assert.equal(invoice.price,null,'the extended amount is never copied to the unit-price field');
 assert.equal(invoice.fieldValidation.priceStatus,'missing-unit-price');
 assert.equal(invoice.fieldValidation.fields.price.columnIndex,priceColumn,'retain the original price column when assigned');
 assert.equal(invoice.requiresReview,true);
 assert.ok(invoice.issues.some(issue=>String(issue).includes('unit price is missing')));
 const prepared=await prepareAutomaticInvoice({text:'Invoice Date: 2026-11-03',rows:[invoice],organizationId:'org',vendorId:'vendor'});
 assert.match(prepared.reason,/unit price is missing/,'automatic import holds the uncertain invoice');
}
const heldInvoice=await prepareAutomaticInvoice({text:'Invoice Date: 2026-11-03',rows:[invalidRow],organizationId:'org',vendorId:'vendor'});
assert.match(heldInvoice.reason,/not a quantity/);
assert.doesNotMatch(heldInvoice.reason,/\[object Object\]/,'automatic review explains the source issue');
const units=parseDocument('Description,Price/LB,Price Unit\nMilk,20.00,CASE').rows[0];
assert.equal(units.fieldValidation.quotedUnit,'conflict');
assert.equal(units.fieldValidation.fields.sellingUnit.status,'conflict');
assert.equal(units.sellingUnit,'CASE','the assigned unit remains available for review');
assert.equal(units.priceNeedsReview,true);
const repeated=parseDocument('Description,Price\nMilk,20.00\nPrice,Description\n21.00,Eggs');
assert.equal(repeated.rows[1].fieldIdentification.bindings.description.evidence,'stated');
assert.equal(repeated.rows[1].fieldValidation.fields.description.accuracy,100);
assert.equal(repeated.rows[1].fieldIdentification.bindings.description.columnIndex,1);
const boundaryInput={description:'Milk',price:20,packSize:'12/1 QT',fieldValidation:{fields:{price:{status:'present',accuracy:100}}},
  cellConflicts:[{field:'price',note:'Source amounts disagree'}]};
const boundaryBefore=JSON.stringify(boundaryInput);
const boundaryResult=withRowValidation(boundaryInput);
assert.equal(JSON.stringify(boundaryInput),boundaryBefore,'validation leaves its input and source evidence unchanged');
assert.deepEqual([boundaryResult.description,boundaryResult.price,boundaryResult.packSize],['Milk',20,'12/1 QT']);
assert.equal(boundaryResult.fieldValidation.fields.price.accuracy,null);
assert.equal(boundaryResult.catalogItemId,undefined,'validation does not decide a product group');
console.log('PASS B5: validation reports quality without changing assigned cells or dropping reviewable rows.');
