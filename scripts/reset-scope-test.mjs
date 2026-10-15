import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite();
const org='cf97d202-3bc1-445f-ae4d-582ec1d1aa99',other='00000000-0000-0000-0000-000000000099';
await db.exec(`create table organizations(id uuid,slug text);insert into organizations values('${org}','hornet-s-nest-deli-llc'),('${other}','other-client');`);
for(const t of ['invoices','purchase_orders','price_history','item_mappings','vendor_items','catalog_items','import_documents','catalog_number_history','vendor_nvim_counters','vendors','catalog_categories','organization_members'])await db.exec(`create table ${t}(id uuid,organization_id uuid);insert into ${t} values('${org}','${org}'),('${other}','${other}');`);
await db.exec(`create table invoice_lines(invoice_id uuid);insert into invoice_lines values('${org}'),('${other}');create table purchase_order_lines(purchase_order_id uuid);insert into purchase_order_lines values('${org}'),('${other}');`);
await db.exec(fs.readFileSync('/workspace/scratch/7b76ce635e77/reset-only-test.sql','utf8'));
for(const t of ['invoices','purchase_orders','price_history','item_mappings','vendor_items','catalog_items','import_documents','catalog_number_history','vendor_nvim_counters']){
 assert.equal((await db.query(`select * from ${t} where organization_id='${org}'`)).rows.length,0);
 assert.equal((await db.query(`select * from ${t} where organization_id='${other}'`)).rows.length,1);
}
for(const t of ['vendors','catalog_categories','organization_members'])assert.equal((await db.query(`select * from ${t}`)).rows.length,2);
assert.equal((await db.query('select * from organizations')).rows.length,2);
for(const t of ['invoice_lines','purchase_order_lines'])assert.equal((await db.query(`select * from ${t}`)).rows.length,1);
console.log('Reset scope passed: target records cleared; client, configuration, users and other tenant retained.');
await db.close();
