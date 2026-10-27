// Executes the real importer for exceptions; successful persistence and replay
// are exercised against PostgreSQL in test_a1_atomic_invoice.mjs.
import assert from 'node:assert/strict';
import {classifyDocument,processAttachmentInBackground} from '../supabase/functions/process-attachment/background-import.mjs';
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
for(const [type,content,expected] of [
  ['invoice','invoice',true],['pricelist','pricelist',false],['invoice','unknown',true],
  [null,'pricelist',false],
])await check(`classification ${type}/${content}`,()=>{
  const result=classifyDocument(type,content);assert.equal(result.isInvoice,expected);assert.equal(result.earlyExit,null);
});
for(const [type,content] of [[null,'invoice'],[null,'unknown'],[null,null],['invoice','pricelist'],['pricelist','invoice']])
  await check(`review ${type}/${content}`,()=>assert.equal(classifyDocument(type,content).earlyExit.status,'needs_review'));
const attachment={id:'a',filename:'data.csv',content_type:'text/csv',storage_path:'org/path',file_size_bytes:128};
async function run(text,documentType){
  const statuses=[];let records=0;
  const backend={attachments:{download:async()=>new TextEncoder().encode(text),setStatus:async(...args)=>statuses.push(args)},
    records:{query:()=>{records++;throw new Error('No data query expected');}}};
  const result=await processAttachmentInBackground(backend,attachment,{organizationId:'org',vendorId:'vendor',documentType});
  assert.equal(result.outcome,'needs_review');assert.equal(records,0);assert.equal(statuses.length,1);return result;
}
await check('conflicting invoice on price-sheet address makes no database writes',()=>run('INVOICE INV-A\nDate: 10/27/2026','pricelist'));
await check('missing type on invoice makes no database writes',()=>run('INVOICE INV-A\nDate: 10/27/2026',null));
await check('empty registered price sheet makes no document',()=>run('','pricelist'));
await check('missing vendor rejected before file download',async()=>{
  await assert.rejects(()=>processAttachmentInBackground({},attachment,{organizationId:'org',vendorId:null,documentType:'invoice'}),/vendorId/);
});
console.log(`${passed}/${passed} executed classification/importer exception checks passed`);
