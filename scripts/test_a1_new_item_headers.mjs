import assert from 'node:assert/strict';
import {parseDocument} from '../src/ingestion.js';
let passed=0;
for(const header of ['Price Unit','Price UOM','Pricing Unit','Pricing Basis','Price Basis','Quoted Per','Selling Unit']){
  for(const basisFirst of [true,false]){
    const headers=basisFirst?`${header},Price`:`Price,${header}`;
    const cells=basisFirst?'CASE,80.00':'80.00,CASE';
    const parsed=parseDocument(`Code,Description,Pack,${headers}\nA1-NEW-20261027-001,Chicken Breast Boneless Skinless,4/10 LB,${cells}\n`);
    assert.equal(parsed.rows.length,1,JSON.stringify(parsed));
    const row=parsed.rows[0];assert.equal(row.price,80);assert.equal(row.sellingUnit,'CASE');
    assert.equal(row.code,'A1-NEW-20261027-001');assert.equal(row.packSize,'4/10 LB');
    assert.notEqual(parsed.columnMap.price,parsed.columnMap.sellingUnit);
    assert.equal(row.priceHeader,'Price');assert.equal(row.billingUnitEvidence.header,header);
    console.log(`PASS ${header} ${basisFirst?'before':'after'} price`);passed++;
  }
}
const invoice=parseDocument('INVOICE INV-123\nDate: 10/27/2026\nCode,Description,Pack,Price Unit,Qty,Unit Price,Extended Price\nA1-NEW-20261027-001,Chicken Breast Boneless Skinless,4/10 LB,CASE,2,80.00,160.00');
assert.equal(invoice.rows[0]?.price,80);assert.equal(invoice.rows[0]?.qty,2);assert.equal(invoice.rows[0]?.amount,160);
console.log('PASS invoice unit price and extended amount remain separate');passed++;
console.log(`${passed}/${passed} new-item pricing-header checks passed`);
