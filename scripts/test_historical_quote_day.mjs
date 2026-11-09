import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {createRecords} from '../src/backend/records.js';
import {createImportService} from '../src/services/imports.js';

// Execute the real service's records query against PostgreSQL timestamp precision.
// A JavaScript Date comparison would lose the microseconds being tested here.
const db=new PGlite();
const records=createRecords(async spec=>{
  const identifier=value=>{assert.match(value,/^[a-z_]+$/);return `"${value}"`;};
  const values=[];
  const where=spec.filters.map(({operator,column,value})=>{
    const sqlOperator={eq:'=',lte:'<=',lt:'<'}[operator];
    assert.ok(sqlOperator,`Unsupported test filter ${operator}`);
    values.push(value);return `${identifier(column)} ${sqlOperator} $${values.length}`;
  }).join(' AND ');
  const order=spec.orders.map(({column,options})=>`${identifier(column)} ${options?.ascending===false?'DESC':'ASC'}`).join(',');
  try {
    const result=await db.query(`SELECT ${spec.columns.split(',').map(identifier).join(',')} FROM ${identifier(spec.table)} WHERE ${where} ORDER BY ${order} LIMIT ${Number(spec.limit)}`,values);
    return {data:result.rows,error:null};
  }catch(error){return {data:null,error};}
});
const service=createImportService({records});
let passed=0;
try {
  await db.exec(`CREATE TABLE price_history(id text,organization_id text,vendor_item_id text,source_document_id text,price numeric,effective_date timestamptz,quote_valid_until date,source text,price_basis text,selling_unit text)`);
  for(const [day,nextDay] of [['2026-11-03','2026-11-04'],['2026-12-31','2027-01-01'],['2028-02-29','2028-03-01']]){
    await db.exec('TRUNCATE price_history');
    for(const [id,org,item,timestamp] of [
      ['earlier','org','item',`${day}T12:00:00Z`],
      ['last-microsecond','org','item',`${day}T23:59:59.999999Z`],
      ['next-day','org','item',`${nextDay}T00:00:00Z`],
      ['other-org','elsewhere','item',`${day}T23:59:59.999999Z`],
      ['other-item','org','elsewhere',`${day}T23:59:59.999999Z`],
    ])await db.query("INSERT INTO price_history VALUES($1,$2,$3,'source',41.25,$4,null,'price_list','case','CASE')",[id,org,item,timestamp]);
    const quote=await service.historicalQuote({organizationId:'org',vendorItemId:'item',invoiceDate:day});
    assert.equal(quote?.id,'last-microsecond',`${day}: retain the latest same-day quote, exclude next midnight and unrelated rows`);
    assert.equal(quote.source_document_id,'source');assert.equal(Number(quote.price),41.25);
    passed++;console.log(`PASS complete UTC invoice day ${day}`);
  }
  assert.equal(await service.historicalQuote({organizationId:'org',vendorItemId:'missing',invoiceDate:'2028-02-29'}),null);
  passed++;console.log('PASS absent quote remains null');
  await db.exec('DROP TABLE price_history');
  await assert.rejects(()=>service.historicalQuote({organizationId:'org',vendorItemId:'item',invoiceDate:'2028-02-29'}),/Unable to verify historic quote/);
  passed++;console.log('PASS database lookup error remains an error');
  console.log(`${passed} historical quote day checks passed`);
}finally{await db.close();}
