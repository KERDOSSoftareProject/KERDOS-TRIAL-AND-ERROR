import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {parseDocument} from '../ingestion.js';
import {invoiceBilledQuantityEvidence} from './invoice-quantity-evidence.js';
import {billingUnitEvidence} from './billing-unit-evidence.js';
const csv=header=>`INVOICE SYN-1\nDate: 11/01/2026\nItem,Description,Pack,Price Unit,Ordered,${header},Unit Price,Extended Price\nSYN,Example material,2/6-8 LBA,LB,2,14,4,56`;
const good=parseDocument(csv('Billed Weight')).rows[0];
assert.equal(good.qty,14,'billed weight wins over earlier ordered cases');
assert.equal(good.quantitySource.header,'Billed Weight');assert.equal(good.quantitySource.rawValue,'14');
assert.equal(invoiceBilledQuantityEvidence(good).quantity,14);
const cases=[];
for(const header of ['Billed Weight','Billed Quantity','Billed Qty','Quantity Billed','Weight Billed','Invoice Quantity','Invoice Qty']){const row=parseDocument(csv(header)).rows[0];assert.equal(row.qty,14);assert.ok(invoiceBilledQuantityEvidence(row),header);cases.push(row);}
for(const header of ['Qty','Quantity','Ordered','Delivered','Count','Weight']){const row=parseDocument(csv(header)).rows[0];assert.equal(invoiceBilledQuantityEvidence(row),null,header);cases.push(row);}
const goods=parseDocument('INVOICE SYN-G\nItem/Xref ORD DLV UOM Description Pack Size Weight Unit Price Extended\n49200 4.00 4.00 LB CHIC BRST RAW BNLS RNDM CVP 4/10 LB 40.00 $2.06 $82.40\nTOTAL 82.40').rows[0];
assert.equal(goods.qty,40);assert.equal(goods.deliveredQty,4);assert.equal(invoiceBilledQuantityEvidence(goods).quantity,40);cases.push(goods);
for(const patch of [{qty:2},{sellingUnit:'CASE'},{sourceLine:'different source line'},{quantitySource:null},{quantitySource:{...good.quantitySource,header:'Ordered'}},{quantitySource:{...good.quantitySource,columnIndex:'5'}},{quantitySource:{...good.quantitySource,rawValue:14}},{quantitySource:{...good.quantitySource,rawValue:'14xyz'}},{billingUnitEvidence:{unit:'LB'}},{quantitySource:{...good.quantitySource,headerLine:'fake'}}]){const row={...good,...patch};assert.equal(invoiceBilledQuantityEvidence(row),null);cases.push(row);}
const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create table invoice_lines(quantity numeric,selling_unit text,source_line text,billing_unit_evidence jsonb);`);
const migration=fs.readFileSync(new URL('../../supabase/migrations/20261101213251_invoice_billed_quantity_evidence.sql',import.meta.url),'utf8');
const prefix=migration.slice(0,migration.indexOf('create or replace function public.kerdos_record_invoice'));
await db.exec(prefix);await db.exec(prefix);
for(const row of cases){const actual=(await db.query('select kerdos_invoice_quantity_proof($1,$2,$3,$4,$5) as p',[row.quantitySource?JSON.stringify(row.quantitySource):null,row.qty,row.sellingUnit,row.sourceLine,JSON.stringify(billingUnitEvidence(row))])).rows[0].p;assert.deepEqual(actual,invoiceBilledQuantityEvidence(row),row.quantitySource?.header);}
const proof=invoiceBilledQuantityEvidence(good);
await db.query('insert into invoice_lines(quantity,selling_unit,source_line,billing_unit_evidence,quantity_source,billed_quantity_evidence) values($1,$2,$3,$4,$5,$6)',[good.qty,good.sellingUnit,good.sourceLine,JSON.stringify(billingUnitEvidence(good)),JSON.stringify(good.quantitySource),JSON.stringify(proof)]);
assert.deepEqual((await db.query('select billed_quantity_evidence from invoice_lines')).rows[0].billed_quantity_evidence,proof);
await assert.rejects(db.query('update invoice_lines set quantity=2'),/differs/);
await assert.rejects(db.query('update invoice_lines set billed_quantity_evidence=$1',[JSON.stringify({...proof,quantity:2})]),/differs/);
await db.exec('insert into invoice_lines(quantity) values(14)');assert.equal((await db.query('select billed_quantity_evidence from invoice_lines where selling_unit is null')).rows[0].billed_quantity_evidence,null,'legacy missing evidence stays absent');
assert.equal((await db.query("select has_function_privilege('anon','kerdos_invoice_quantity_proof(jsonb,numeric,text,text,jsonb)','execute') as allowed")).rows[0].allowed,false);
await db.close();console.log('PASS billed quantity evidence: exact source headers/cells/lines, ordered-versus-billed distinction, goods measured weight, JS/SQL parity, malformed/ambiguous rejection, null legacy evidence and trigger guards.');
