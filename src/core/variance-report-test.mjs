import assert from 'node:assert/strict';
import {buildVarianceReport,buildComparisonReportCSV,quoteEvidenceLabel} from './variance-report.js';
import {createVarianceReportService} from '../services/variance-report.js';
import {createRecords} from '../backend/records.js';
let passed=0;const check=async(name,fn)=>{await fn();passed++;console.log('PASS '+name);};
const vendors=[{id:'a',name:'Alpha'},{id:'b',name:'Beta'}];
const line={id:'l',description:'Chicken',quantity:5,unit_price:12,line_total:999,price_variance:2,quoted_rate:10,quoted_source_rate:40,quoted_basis:'case',selling_unit:'LB',quoted_effective_date:'2026-10-01',quoted_source:'price_list',quoted_price_history_id:'q',quoted_source_document_id:'d',vendor_item_id:'vi',quoted_document:{file_name:'Original sheet.csv'}};
const invoice={id:'i',organization_id:'org',vendor_id:'a',invoice_number:'I-1',file_name:'invoice.pdf',invoice_date:'2026-10-15',invoice_lines:[line]};
await check('every client vendor appears; no comparison is distinct from zero variance',()=>{
 const r=buildVarianceReport([{...invoice,invoice_lines:[{...line,price_variance:0},{...line,id:'missing',price_variance:null,quoted_rate:null,quoted_comparison_note:'lookup_error'}]}],vendors);
 assert.equal(r.vendors.length,2);assert.equal(r.vendors[0].comparedLineCount,1);assert.equal(r.vendors[0].items.length,0);assert.equal(r.vendors[0].uncomparedLineCount,1);assert.equal(r.vendors[1].comparedLineCount,0);
 assert.equal(r.lines[0].status,'Compared: zero variance');assert.equal(r.lines[1].reason,'Quote lookup failed');
});
await check('retained quote wins; billed quantity multiplies rate difference exactly once',()=>{
 const r=buildVarianceReport([invoice],vendors),item=r.lines[0];assert.equal(item.quotedPrice,10);assert.equal(item.quotedSourceRate,40);assert.equal(item.impact,10);assert.equal(item.sourceDocumentId,'d');assert.equal(quoteEvidenceLabel(item),'Original sheet.csv');
 const noQty=buildVarianceReport([{...invoice,invoice_lines:[{...line,quantity:null}]}],vendors).lines[0];assert.equal(noQty.impact,null,'do not infer billed quantity from a potentially adjusted line total');
});
await check('legacy differences retain missing quote evidence without reconstruction',()=>{
 const l=buildVarianceReport([{...invoice,invoice_lines:[{...line,quoted_rate:null}]}],vendors).lines[0];assert.equal(l.quotedPrice,null);assert.equal(l.difference,2);assert.equal(quoteEvidenceLabel(l),'Quote evidence unavailable');
});
await check('undercharges, expired quotes and incompatible units stay distinct',()=>{
 const r=buildVarianceReport([{...invoice,invoice_lines:[{...line,price_variance:-2},{...line,id:'x',price_variance:null,quoted_comparison_note:'quote_expired'},{...line,id:'y',price_variance:null,quoted_comparison_note:'basis_incompatible'}]}],vendors);
 assert.equal(r.lines[0].status,'Undercharge');assert.equal(r.lines[0].impact,-10);assert.match(r.lines[1].reason,/expired/);assert.match(r.lines[2].reason,/cannot be compared/);
});
await check('period filters keep vendors and export exactly the displayed scope',()=>{
 const r=buildVarianceReport([invoice,{...invoice,id:'old',invoice_date:'2026-09-30'},{...invoice,id:'undated',invoice_date:null}],vendors,{from:'2026-10-01',to:'2026-10-31'});
 assert.deepEqual(r.invoices.map(i=>i.id),['i']);const csv=buildComparisonReportCSV(r);assert.ok(csv.includes('2026-10-01,2026-10-31,Alpha'));assert.ok(csv.includes('Beta'));assert.ok(csv.includes('No completed comparisons'));assert.ok(!csv.includes('2026-09-30'));assert.ok(csv.includes('Original sheet.csv'));assert.equal(csv.split('\r\n')[0].split(',').length,csv.split('\r\n').at(-1).split(',').length,'empty-vendor CSV row has the complete schema');
});
await check('CSV includes every outcome, source identifiers, and zero; cells escape source text',()=>{
 const r=buildVarianceReport([{...invoice,invoice_lines:[{...line,description:'Salt, "Kosher"\nsource'},{...line,id:'zero',price_variance:0},{...line,id:'missing',price_variance:null,quoted_rate:null,quoted_comparison_note:'lookup_error'}]}],vendors);
 const csv=buildComparisonReportCSV(r);assert.ok(csv.includes('"Salt, ""Kosher""\nsource"'));assert.ok(csv.includes('Compared: zero variance'));assert.ok(csv.includes('Quote lookup failed'));assert.ok(csv.includes('Quote Row ID'));assert.ok(csv.includes(',q,d,'));
});
const serviceFor=(execute)=>createVarianceReportService({records:createRecords(execute)});
await check('full invoice history and linked source metadata use read-only scoped queries',async()=>{
 const reads=[],stored=Array.from({length:205},(_,i)=>({...invoice,id:'i'+i,invoice_lines:[line]}));
 const svc=serviceFor(async spec=>{reads.push(spec);assert.equal(spec.action,'select');assert.ok(spec.filters.some(f=>f.column==='organization_id'&&f.value==='org'));
  if(spec.table==='invoices')return {data:stored.slice(spec.range.from,spec.range.to+1)};
  if(spec.table==='import_documents')return {data:[{id:'d',organization_id:'org',vendor_id:'a',file_name:'Original sheet.csv'}]};
  if(spec.table==='price_history')return {data:[{id:'q',organization_id:'org',vendor_item_id:'vi',source_document_id:'d',source_line:'Source row 18'}]};
  throw Error('Unexpected table');});
 const rows=await svc.invoices('org');assert.equal(rows.length,205);assert.equal(reads.length,4);assert.equal(rows[0].invoice_lines[0].quoted_history.source_line,'Source row 18');
 assert.ok(!reads.find(s=>s.table==='price_history').columns.split(',').includes('price'),'report must not fetch a current price to reconstruct comparison');
});
await check('client isolation rejects cross-client invoice and cross-vendor source metadata',async()=>{
 await assert.rejects(()=>serviceFor(async()=>({data:[{...invoice,organization_id:'other'}]})).invoices('org'),/another client/);
 await assert.rejects(()=>serviceFor(async s=>({data:s.table==='invoices'?[invoice]:s.table==='import_documents'?[{id:'d',organization_id:'org',vendor_id:'other'}]:[]})).invoices('org'),/does not belong/);
 await assert.rejects(()=>serviceFor(async s=>({data:s.table==='invoices'?[invoice]:s.table==='price_history'?[{id:'q',organization_id:'org',vendor_item_id:'different',source_document_id:'d'}]:[]})).invoices('org'),/does not belong/);
});
await check('query failures and repeated full pages do not masquerade as clean reports',async()=>{
 await assert.rejects(()=>serviceFor(async()=>({error:{message:'offline'}})).invoices('org'),/offline/);
 await assert.rejects(()=>serviceFor(async()=>({data:Array.from({length:200},()=>invoice)})).invoices('org'),/Earlier invoice/);
 await assert.rejects(()=>serviceFor(async()=>({data:[]})).invoices(''),/client is required/);
});
console.log(`${passed}/${passed} report model and source-access checks passed.`);
