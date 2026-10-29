// Verifier quality checks only. Mock HTTP is not hosted ingestion evidence.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {verifyMixedReceipt} from './verify_a1_mixed_receipt.mjs';
const payload=JSON.parse(readFileSync('scripts/fixtures/mixed/postmark-payload.json'));
const org='ab0f7ada-83ad-43eb-a513-6a8c5bd43a09',vendor='110e43fc-5788-47c2-ad9d-21b18a28be80',doc='11111111-1111-1111-1111-111111111111',message='22222222-2222-2222-2222-222222222222';
const env={SUPABASE_URL:'https://gwtnaudjfoxjermhvhpx.supabase.co',SUPABASE_SERVICE_ROLE_KEY:'fake-test-service-key',POSTMARK_WEBHOOK_USERNAME:'fake-user',POSTMARK_WEBHOOK_PASSWORD:'fake-password'};
function setup(fault){
  let sends=0;const sent=[];
  const fetchImpl=async(url,options={})=>{
    const u=new URL(url),table=u.pathname.split('/').at(-1),json=data=>Response.json(data);
    if(u.pathname==='/functions/v1/inbound-email'){
      sends++;sent.push(options.body);assert.equal(options.method,'POST');
      assert.equal(JSON.parse(options.body).Attachments.length,2);
      assert.equal(JSON.parse(options.body).Attachments[0].ContentType,'image/png');
      assert.equal(JSON.parse(options.body).Attachments[1].ContentType,'text/csv');
      return new Response('OK',{status:fault==='http'?500:200});
    }
    assert.ok(!u.pathname.includes('/functions/'),'No direct worker calls permitted');
    if(u.pathname.startsWith('/storage/v1/')){
      const source=payload.Attachments.find(a=>u.pathname.endsWith(a.ContentType==='image/png'?'/0':'/1'));
      let bytes=Uint8Array.from(atob(source.Content),c=>c.charCodeAt(0));if(fault==='original')bytes=bytes.slice(1);
      return new Response(bytes);
    }
    assert.ok(['inbound_messages','inbound_attachments','vendor_items','import_documents','price_history'].includes(table));
    if(fault==='query'&&table==='inbound_messages')return Response.json({error:'column does not exist'},{status:400});
    if(table==='inbound_messages')return json(sends?[{id:message,organization_id:org,receipt_vendor_id:vendor,receipt_document_type:fault==='ownership'?'invoice':'pricelist'}]:[]);
    if(table==='vendor_items')return json([{id:'vi-1',vendor_item_code:'12345',selling_unit:'CASE',price_basis:'case'},{id:'vi-2',vendor_item_code:'12346',selling_unit:'CASE',price_basis:'case'}]);
    if(table==='inbound_attachments')return json([{id:'att-png',filename:'incidental.png',storage_path:`${org}/inbound/${message}/0`,processing_status:fault==='pending'?'processing':'needs_review',processing_error:'No price rows',import_document_id:null},{id:'att-csv',filename:'mixed-prices.csv',storage_path:`${org}/inbound/${message}/1`,processing_status:'auto_imported',processing_error:null,import_document_id:doc}]);
    if(table==='import_documents')return json([{id:doc,status:'complete',file_name:'mixed-prices.csv',file_path:`${org}/inbound/${message}/1`,completed_keys:['row:0','row:1']}]);
    const rows=[{id:'quote1',vendor_item_id:'vi-1',source_document_id:doc,source_file_name:'mixed-prices.csv',price:fault==='price'?99:41.25},{id:'quote2',vendor_item_id:'vi-2',source_document_id:doc,source_file_name:'mixed-prices.csv',price:51.75}];
    if(fault==='duplicate'&&sends>1)rows.push({...rows[1],id:'quote3'});
    if(fault==='false-price')rows.push({...rows[1],id:'logo-price',source_file_name:'incidental.png'});
    return json(rows);
  };
  return {fetchImpl,sent,get sends(){return sends;}};
}
let count=0;
const mock=setup();const response=await verifyMixedReceipt({env,fetchImpl:mock.fetchImpl}),result=await response.json();
assert.equal(response.status,200);assert.equal(result.passed,true);assert.equal(mock.sends,2);assert.equal(mock.sent[0],mock.sent[1]);assert.equal(result.checks.length,10);
assert.ok(!JSON.stringify(result).includes(env.SUPABASE_SERVICE_ROLE_KEY));assert.ok(!JSON.stringify(result).includes(env.POSTMARK_WEBHOOK_PASSWORD));
console.log('PASS one mixed message and exact replay, all terminal/value/original assertions, no credential output');count++;
for(const fault of ['http','query','ownership','pending','price','original','duplicate','false-price']){
  const mock=setup(fault),response=await verifyMixedReceipt({env,fetchImpl:mock.fetchImpl}),result=await response.json();
  assert.equal(response.status,502,fault);assert.equal(result.passed,false,fault);
  console.log('PASS verifier rejects '+fault);count++;
}
await assert.rejects(()=>verifyMixedReceipt({env:{...env,SUPABASE_URL:'https://production.invalid'}}),/kerdos-test/);
await assert.rejects(()=>verifyMixedReceipt({env:{...env,SUPABASE_SERVICE_ROLE_KEY:''}}),/Missing/);
console.log('PASS wrong environment and missing credentials stop before network access');count++;
console.log(`${count}/${count} local verifier-quality checks passed; hosted mixed receipt remains unrun.`);
