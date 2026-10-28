// Executes the inspector with simulated provider replies; no network or real credentials.
import assert from 'node:assert/strict';
import {build} from 'esbuild';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';

const directory=await mkdtemp(join(tmpdir(),'a1-inspector-'));
const bundle=join(directory,'inspector.mjs');
const url='https://gwtnaudjfoxjermhvhpx.supabase.co';
const base='testreceiver';
const env={...process.env,SUPABASE_URL:url,SUPABASE_SERVICE_ROLE_KEY:'fake-service-key',
  A1_ORGANIZATION_ID:'test-org',A1_VENDOR_ID:'test-vendor',A1_RECEIVER_MODE:'test',
  A1_PRICE_ADDRESS:`${base}+prices@inbound.postmarkapp.com`,
  A1_INVOICE_ADDRESS:`${base}+invoices@inbound.postmarkapp.com`,POSTMARK_SERVER_TOKEN:'fake-server-token',DATABASE_URL:''};
const mock=`export function createClient(){return {from(){
  const rows=['pricelist','invoice'].map((document_type,i)=>({document_type,is_active:true,vendor_id:'test-vendor',organization_id:'test-org',routing_address:i?process.env.A1_INVOICE_ADDRESS:process.env.A1_PRICE_ADDRESS}));
  if(process.env.CASE==='missing-invoice')rows.pop();
  const q={select(){return q},eq(){return q},in(){return q},order(){return q},then(resolve,reject){return Promise.resolve({data:rows,error:null}).then(resolve,reject)}};return q;
}}}`;
try{
  const result=await build({entryPoints:['scripts/verify_a1_real_email.mjs'],bundle:true,platform:'node',format:'esm',write:false,
    external:['pg','postgres'],plugins:[{name:'provider-stub',setup(b){
      b.onResolve({filter:/^@supabase\/supabase-js$/},()=>({path:'supabase',namespace:'stub'}));
      b.onLoad({filter:/.*/,namespace:'stub'},()=>({contents:mock,loader:'js'}));
    }}],banner:{js:`globalThis.fetch=async(url,options)=>{
      if(url!=='https://api.postmarkapp.com/server'||options.headers['X-Postmark-Server-Token']!=='fake-server-token')throw new Error('wrong API');
      if(process.env.CASE==='provider-error')throw new Error('https://user:super-secret@provider.invalid');
      return {ok:process.env.CASE!=='unauthorized',status:process.env.CASE==='unauthorized'?401:200,json:async()=>({InboundAddress:'${base}@inbound.postmarkapp.com',InboundDomain:'',InboundHookUrl:process.env.CASE==='wrong-hook'?'https://other.supabase.co/functions/v1/inbound-email':'https://user:super-secret@gwtnaudjfoxjermhvhpx.supabase.co/functions/v1/inbound-email'})};
    };`}});
  await writeFile(bundle,result.outputFiles[0].text);
  let passed=0;
  for(const [name,settings,expected,pattern] of [
    ['no purchased domain is needed',{},2,/remain unverified/],
    ['missing credential stays unverified',{POSTMARK_SERVER_TOKEN:''},2,/UNVERIFIED.*Postmark configuration/],
    ['missing invoice registration fails',{CASE:'missing-invoice'},1,/expected document type/],
    ['wrong webhook project fails',{CASE:'wrong-hook'},1,/does not look like/],
    ['provider rejection fails',{CASE:'unauthorized'},1,/Postmark returned 401/],
    ['provider errors do not expose credentials',{CASE:'provider-error'},1,/error details withheld/],
    ['another Supabase project is rejected',{SUPABASE_URL:'https://other.supabase.co'},1,/restricted to kerdos-test/],
  ]){
    const child=spawnSync(process.execPath,[bundle],{env:{...env,CASE:'',...settings},encoding:'utf8'});
    assert.equal(child.status,expected,child.stdout+child.stderr);assert.match(child.stdout,pattern);
    for(const secret of ['super-secret','fake-service-key','fake-server-token'])assert.ok(!child.stdout.includes(secret));
    console.log('PASS '+name);passed++;
  }
  console.log(`${passed}/${passed} executed real-email inspector checks passed`);
}finally{await rm(directory,{recursive:true,force:true});}
