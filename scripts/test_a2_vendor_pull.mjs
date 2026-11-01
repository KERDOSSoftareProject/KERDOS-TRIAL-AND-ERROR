import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {build} from 'esbuild';
import {createHash} from 'node:crypto';
import {createPriceImportFixture} from './fixtures/price-import-backend.mjs';
import {processAttachmentInBackground} from '../supabase/functions/process-attachment/background-import.mjs';
import {orderGuideAssessment} from '../src/core/catalog-fields.js';
import {downloadExport,isPublicAddress,pullVendorSources,sourceUrl,retainExport} from '../supabase/functions/vendor-price-pull/pull.mjs';
const db=new PGlite();let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
const org='10000000-0000-0000-0000-000000000001',other='10000000-0000-0000-0000-000000000002',vendor='20000000-0000-0000-0000-000000000001';
const source={id:'source',organization_id:org,vendor_id:vendor,approved_origin:'https://exports.vendor.example.com',export_path:'/prices.csv',file_name:'prices.csv',lease_token:'token',credential:{kind:'bearer',token:'synthetic-secret'}};
const text='Code,Description,Pack,Price Unit,Price\nA2-001,Chicken Breast Boneless Skinless,2/10 LB,CASE,41.25\n';
const fresh=()=>new Response(text,{headers:{'content-type':'text/csv'}});
const opts={fetchImpl:async()=>fresh(),resolveHost:async()=>['93.184.216.34']};
try{
 await check('actual Edge entrypoint enforces authentication before reading payload or calling the backend',async()=>{
  let handler;const calls=[];
  globalThis.Deno={env:{get:key=>({SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key',RECOVERY_SWEEP_SECRET:'synthetic-operations-key',SUPABASE_URL:'https://example.supabase.co'})[key]},serve:fn=>{handler=fn;}};
  globalThis.__a2Client={rpc:async(name,args)=>{calls.push({name,args});return {data:[],error:null};}};
  const bundle=await build({entryPoints:['supabase/functions/vendor-price-pull/index.ts'],bundle:true,platform:'node',format:'esm',write:false,plugins:[{name:'transport-only',setup(b){b.onResolve({filter:/^https:\/\/esm.sh\/@supabase\/supabase-js/},()=>({path:'sdk',namespace:'test-sdk'}));b.onLoad({filter:/.*/,namespace:'test-sdk'},()=>({contents:'export const createClient=()=>globalThis.__a2Client;'}));}}]});
  await import('data:text/javascript;base64,'+Buffer.from(bundle.outputFiles[0].text).toString('base64'));
  for(const authorization of ['', 'Bearer wrong','Bearer public-anon-key']){
   const response=await handler(new Request('https://example.test',{method:'POST',headers:{Authorization:authorization},body:'not json'}));assert.equal(response.status,401);
  }
  assert.equal(calls.length,0);
  const headers={Authorization:'Bearer synthetic-service-key','Content-Type':'application/json'};
  for(const body of ['null','[]','{"sourceId":12}','{"sourceId":"------------------------------------"}'])assert.equal((await handler(new Request('https://example.test',{method:'POST',headers,body}))).status,400);
  assert.equal((await handler(new Request('https://example.test',{method:'GET',headers}))).status,405);
  for(const key of ['synthetic-service-key','synthetic-operations-key']){
   const response=await handler(new Request('https://example.test',{method:'POST',headers:{Authorization:'Bearer '+key},body:JSON.stringify({sourceId:org})}));
   assert.equal(response.status,200);assert.deepEqual(await response.json(),{checked:0,results:[]});assert.equal(calls.at(-1).args.p_source_id,org);
  }
  delete globalThis.Deno;delete globalThis.__a2Client;
 });
 await check('original replay verifies existing bytes; a conflicting uploaded object is never trusted',async()=>{
  const bytes=new TextEncoder().encode(text);
  for(const previous of [text,'tampered original']){
   const storage={upload:async()=>({error:{statusCode:409}}),download:async()=>({data:new Blob([previous])})};
   if(previous===text)await retainExport(storage,'path',bytes,'text/csv');
   else await assert.rejects(retainExport(storage,'path',bytes,'text/csv'),/retained_original_mismatch/);
  }
 });
 await check('approved HTTPS export uses server-side credential and refuses redirects',async()=>{
  const result=await downloadExport(source,{...opts,fetchImpl:async(url,options)=>{assert.equal(url,'https://exports.vendor.example.com/prices.csv');assert.equal(options.redirect,'error');assert.equal(options.headers.Authorization,'Bearer synthetic-secret');return fresh();}});
  assert.equal(new TextDecoder().decode(result.bytes),text);
 });
 await check('malicious source paths, local hosts, credentials and query strings are refused',()=>{
  for(const value of [ {...source,export_path:'//evil.com/prices.csv'},{...source,export_path:'/prices.csv?token=secret'},{...source,approved_origin:'http://exports.vendor.example.com'}, {...source,approved_origin:'https://127.0.0.1'}, {...source,approved_origin:'https://user:pass@exports.vendor.example.com'}])assert.throws(()=>sourceUrl(value));
 });
 await check('private IPv4/IPv6 DNS answers are denied before any credential-bearing fetch',async()=>{
  for(const address of ['127.0.0.1','10.1.1.1','169.254.169.254','172.16.0.1','192.168.0.1','100.64.0.1','::1','::ffff:127.0.0.1','fd00::1','fe80::1','2001:db8::1']){
   assert.equal(isPublicAddress(address),false,address);
   await assert.rejects(downloadExport(source,{fetchImpl:()=>assert.fail('private network fetch'),resolveHost:async()=>['93.184.216.34',address]}),/source_network_denied/);
  }
 });
 await check('HTML login pages, wrong types and bad credentials do not enter ingestion',async()=>{
  for(const [response,code] of [[new Response('<html><form>login</form></html>',{headers:{'content-type':'text/csv'}}),'portal_login_page'],[new Response('html',{headers:{'content-type':'text/html'}}),'unsupported_export'],[new Response('',{status:401}),'vendor_auth_rejected'],[new Response('',{headers:{'content-type':'text/csv'}}),'empty_export']])await assert.rejects(downloadExport(source,{...opts,fetchImpl:async()=>response}),new RegExp(code));
 });
 await check('streaming size limit enforced even without Content-Length',async()=>{
  const stream=new ReadableStream({start(c){c.enqueue(new Uint8Array(5*1024*1024+1));c.close();}});
  await assert.rejects(downloadExport(source,{...opts,fetchImpl:async()=>new Response(stream,{headers:{'content-type':'text/csv'}})}),/export_too_large/);
 });
 await check('retained original precedes durable stage and existing automatic-worker dispatch',async()=>{
  const order=[];let finished;
  const backend={claim:async()=>[source],retain:async(s,path,bytes)=>{order.push('retain');assert.equal(new TextDecoder().decode(bytes),text);assert.equal(path,org+'/vendor-pulls/source/1/'+'a'.repeat(64));},stage:async()=>{order.push('stage');return {attachment_id:'attachment'};},dispatch:async(o,a)=>{order.push('dispatch');assert.equal(o,org);assert.equal(a,'attachment');return {outcome:'auto_imported'};},finish:async(...args)=>{finished=args;return true;}};
  const result=await pullVendorSources(backend,{...opts,digest:async()=>'a'.repeat(64)});
  assert.deepEqual(order,['retain','stage','dispatch']);assert.equal(result.results[0].status,'received');assert.equal(finished[1],'received');
 });
 await check('dispatch error preserves queued attachment for A1 recovery; errors cannot leak secrets',async()=>{
  let staged=false,finished;
  const backend={claim:async()=>[source],retain:async()=>{},stage:async()=>{staged=true;return {attachment_id:'queued'};},dispatch:async()=>{throw new Error('synthetic-secret upstream URL secret');},finish:async(...args)=>{finished=args;return true;}};
  const result=await pullVendorSources(backend,{...opts,digest:async()=>'b'.repeat(64)});
  assert.ok(staged);assert.equal(result.results[0].attachmentId,'queued');assert.equal(finished[1],'failed');assert.ok(!JSON.stringify(result).includes('synthetic-secret'));
 });
 await check('lost lease cannot be reported as a successful pull',async()=>{
  const result=await pullVendorSources({claim:async()=>[source],retain:async()=>{},stage:async()=>({attachment_id:'a'}),dispatch:async()=>({outcome:'auto_imported'}),finish:async()=>false},{...opts,digest:async()=>'c'.repeat(64)});
  assert.equal(result.results[0].status,'lease_lost');
 });
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
  CREATE SCHEMA vault;CREATE TABLE vault.secrets(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),secret text,name text);
  CREATE SCHEMA net;CREATE TABLE net.requests(id bigint GENERATED ALWAYS AS IDENTITY,url text,headers jsonb,body jsonb);
  CREATE FUNCTION net.http_post(url text,headers jsonb,body jsonb,timeout_milliseconds integer) RETURNS bigint LANGUAGE plpgsql AS $$DECLARE request_id bigint;BEGIN INSERT INTO net.requests(url,headers,body) VALUES(url,headers,body) RETURNING id INTO request_id;RETURN request_id;END$$;
  CREATE VIEW vault.decrypted_secrets AS SELECT id,secret AS decrypted_secret FROM vault.secrets;
  CREATE FUNCTION vault.create_secret(new_secret text,new_name text DEFAULT NULL,new_description text DEFAULT '',new_key_id uuid DEFAULT NULL) RETURNS uuid LANGUAGE plpgsql AS $$DECLARE result uuid;BEGIN INSERT INTO vault.secrets(secret,name) VALUES(new_secret,new_name) RETURNING id INTO result;RETURN result;END$$;
  CREATE FUNCTION vault.update_secret(secret_id uuid,new_secret text DEFAULT NULL,new_name text DEFAULT NULL,new_description text DEFAULT NULL,new_key_id uuid DEFAULT NULL) RETURNS void LANGUAGE sql AS $$UPDATE vault.secrets SET secret=new_secret WHERE id=secret_id$$;
  CREATE TABLE public.organizations(id uuid PRIMARY KEY);
  CREATE TABLE public.vendors(id uuid PRIMARY KEY,organization_id uuid REFERENCES organizations(id),is_active boolean DEFAULT true,UNIQUE(organization_id,id));
  CREATE TABLE public.inbound_messages(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,routing_address_id uuid NOT NULL,postmark_message_id text,sender_email text,sender_name text,subject text,body_text text,received_at timestamptz DEFAULT now(),receipt_vendor_id uuid,receipt_document_type text,vendor_snapshot_at timestamptz,UNIQUE(postmark_message_id,organization_id));
  CREATE TABLE public.inbound_attachments(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,message_id uuid REFERENCES inbound_messages(id),attachment_index integer,filename text,content_type text,file_size_bytes integer,storage_path text,processing_status text,UNIQUE(message_id,attachment_index));
  INSERT INTO organizations VALUES('${org}'),('${other}');INSERT INTO vendors VALUES('${vendor}','${org}',true);
 `);
 const sql=readFileSync(new URL('../knowledge/a2_vendor_integration_draft.sql',import.meta.url),'utf8');
 await db.exec(sql);
 let id,claim;
 await check('SQL rejects enrollment of cross-organization vendors and unapproved origins',async()=>{
  await assert.rejects(db.query("SELECT kerdos_private.configure_vendor_price_source($1,$2,'https://exports.vendor.example.com','/prices.csv','prices.csv',$3)",[other,vendor,{kind:'bearer',token:'x'}]),/vendor_not_active/);
  await assert.rejects(db.query("SELECT kerdos_private.configure_vendor_price_source($1,$2,'https://exports.vendor.example.com','/prices.csv','prices.csv',$3)",[org,vendor,{kind:'bearer',token:'x'}]),/foreign key/);
  assert.equal((await db.query('SELECT count(*) FROM vault.secrets')).rows[0].count,0);
 });
 await check('operator enrolls isolated credential; source disabled by default and live lease excludes competing claims',async()=>{
  await db.exec("INSERT INTO kerdos_private.vendor_export_origins(origin) VALUES('https://exports.vendor.example.com')");
  id=(await db.query("SELECT kerdos_private.configure_vendor_price_source($1,$2,'https://exports.vendor.example.com','/prices.csv','prices.csv',$3) id",[org,vendor,{kind:'bearer',token:'synthetic-secret'}])).rows[0].id;
  assert.deepEqual((await db.query('SELECT public.kerdos_claim_vendor_pulls() jobs')).rows[0].jobs,[]);
  await db.query('UPDATE kerdos_private.vendor_price_sources SET is_active=true WHERE id=$1',[id]);
  claim=(await db.query('SELECT public.kerdos_claim_vendor_pulls() jobs')).rows[0].jobs[0];
  assert.equal(claim.credential.token,'synthetic-secret');assert.equal(claim.vendor_id,vendor);
  assert.deepEqual((await db.query('SELECT public.kerdos_claim_vendor_pulls() jobs')).rows[0].jobs,[]);
 });
 await check('SQL stage is atomic, source-labelled and exact replay preserves attachment identity',async()=>{
  const args=[id,claim.lease_token,'a'.repeat(64),org+'/vendor-pulls/'+id+'/1/'+'a'.repeat(64),'text/csv',text.length];
  const first=(await db.query('SELECT public.kerdos_stage_vendor_pull($1,$2,$3,$4,$5,$6) receipt',args)).rows[0].receipt;
  const again=(await db.query('SELECT public.kerdos_stage_vendor_pull($1,$2,$3,$4,$5,$6) receipt',args)).rows[0].receipt;
  assert.deepEqual(again,first);
  const receipt=(await db.query('SELECT * FROM inbound_messages')).rows[0];
  assert.equal(receipt.source_kind,'vendor_pull');assert.equal(receipt.receipt_vendor_id,vendor);assert.equal(receipt.routing_address_id,null);assert.equal(receipt.receipt_document_type,'pricelist');
  assert.equal((await db.query('SELECT count(*) FROM inbound_attachments')).rows[0].count,1);
 });
 await check('SQL rejects stale lease and wrong artifact path before creating any receipt',async()=>{
  await assert.rejects(db.query('SELECT public.kerdos_stage_vendor_pull($1,gen_random_uuid(),$2,$3,$4,$5)',[id,'b'.repeat(64),'wrong','text/csv',100]),/lease_lost/);
  await assert.rejects(db.query('SELECT public.kerdos_stage_vendor_pull($1,$2,$3,$4,$5,$6)',[id,claim.lease_token,'b'.repeat(64),'wrong','text/csv',100]),/artifact_invalid/);
  assert.equal((await db.query('SELECT count(*) FROM inbound_messages')).rows[0].count,1);
 });
 await check('SQL rejects null credentials and credential rotation fences the old lease',async()=>{
  await assert.rejects(db.query("SELECT kerdos_private.configure_vendor_price_source($1,$2,'https://exports.vendor.example.com','/prices.csv','prices.csv','{}'::jsonb)",[org,vendor]),/credential_invalid/);
  const before=(await db.query('SELECT count(*) FROM vault.secrets')).rows[0].count;
  const rotated=(await db.query("SELECT kerdos_private.configure_vendor_price_source($1,$2,'https://exports.vendor.example.com','/prices.csv','prices.csv',$3,1440,true) id",[org,vendor,{kind:'bearer',token:'rotated-synthetic-secret'}])).rows[0].id;
  assert.equal(rotated,id);assert.equal((await db.query('SELECT count(*) FROM vault.secrets')).rows[0].count,before);
  await assert.rejects(db.query('SELECT public.kerdos_check_vendor_pull_lease($1,$2)',[id,claim.lease_token]),/lease_lost/);
  claim=(await db.query('SELECT public.kerdos_claim_vendor_pulls() jobs')).rows[0].jobs[0];
  assert.equal(claim.credential.token,'rotated-synthetic-secret');
 });
 await check('SQL schedules next pull, permits on-demand claim, expires stale workers and honors vendor deactivation',async()=>{
  assert.equal((await db.query("SELECT public.kerdos_finish_vendor_pull($1,$2,'received','auto_imported') ok",[id,claim.lease_token])).rows[0].ok,true);
  assert.deepEqual((await db.query('SELECT public.kerdos_claim_vendor_pulls() jobs')).rows[0].jobs,[]);
  const next=(await db.query('SELECT public.kerdos_claim_vendor_pulls($1) jobs',[id])).rows[0].jobs[0];assert.ok(next);
  await db.query("UPDATE kerdos_private.vendor_price_sources SET lease_until=now()-interval '1 second' WHERE id=$1",[id]);
  await assert.rejects(db.query('SELECT public.kerdos_check_vendor_pull_lease($1,$2)',[id,next.lease_token]),/lease_lost/);
  await db.query('UPDATE public.vendors SET is_active=false WHERE id=$1',[vendor]);
  assert.deepEqual((await db.query('SELECT public.kerdos_claim_vendor_pulls($1) jobs',[id])).rows[0].jobs,[]);
 });
 await check('SQL scheduler skips inactive sources; configured due source dispatches using a Vault reference',async()=>{
  assert.equal((await db.query('SELECT kerdos_private.dispatch_due_vendor_pulls() request')).rows[0].request,null);
  await db.query('UPDATE public.vendors SET is_active=true WHERE id=$1',[vendor]);
  await db.query('UPDATE kerdos_private.vendor_price_sources SET next_pull_at=now(),lease_until=NULL WHERE id=$1',[id]);
  await assert.rejects(db.query('SELECT kerdos_private.dispatch_due_vendor_pulls()'),/not_configured/);
  const secret=(await db.query("SELECT vault.create_secret('synthetic-dispatch-secret','dispatch') id")).rows[0].id;
  await db.query("INSERT INTO kerdos_private.vendor_pull_dispatch VALUES(true,'https://gwtnaudjfoxjermhvhpx.supabase.co/functions/v1/vendor-price-pull',$1)",[secret]);
  assert.equal((await db.query('SELECT kerdos_private.dispatch_due_vendor_pulls() request')).rows[0].request,1);
  const request=(await db.query('SELECT * FROM net.requests')).rows[0];assert.equal(request.headers.Authorization,'Bearer synthetic-dispatch-secret');assert.deepEqual(request.body,{});
 });
 await check('anonymous and client roles cannot read credentials, enroll sources, claim jobs or stage imports',async()=>{
  for(const role of ['anon','authenticated']){
   await db.exec('SET ROLE '+role);
   for(const query of ['SELECT * FROM kerdos_private.vendor_price_sources','SELECT public.kerdos_claim_vendor_pulls()',`SELECT public.kerdos_stage_vendor_pull('${id}',gen_random_uuid(),'hash','path','text/csv',100)`])await assert.rejects(db.query(query),/permission denied/);
   await db.exec('RESET ROLE');
  }
 });
 await check('schema draft is repeatable without resetting saved receipts',async()=>{await db.exec(sql);assert.equal((await db.query('SELECT count(*) FROM inbound_messages')).rows[0].count,1);});
 await check('A → B → A creates a new price observation while immediate identical replay reuses its receipt',async()=>{
  const current=(await db.query('SELECT public.kerdos_claim_vendor_pulls($1) jobs',[id])).rows[0].jobs[0];
  const receipts=[];
  for(const [revision,hash] of [[2,'b'.repeat(64)],[3,'a'.repeat(64)],[3,'a'.repeat(64)]]){
   const args=[id,current.lease_token,hash,org+'/vendor-pulls/'+id+'/'+revision+'/'+hash,'text/csv',text.length];
   receipts.push((await db.query('SELECT public.kerdos_stage_vendor_pull($1,$2,$3,$4,$5,$6) receipt',args)).rows[0].receipt);
  }
  assert.notEqual(receipts[0].attachment_id,receipts[1].attachment_id);assert.deepEqual(receipts[1],receipts[2]);
  const attachments=(await db.query('SELECT storage_path FROM inbound_attachments ORDER BY storage_path')).rows;
  assert.equal(attachments.length,3);assert.equal(new Set(attachments.map(row=>row.storage_path)).size,3);
  assert.equal((await db.query('SELECT content_revision FROM kerdos_private.vendor_price_sources WHERE id=$1',[id])).rows[0].content_revision,3);
 });
 await check('adapter retains unchanged revision and advances it when an earlier content version returns',async()=>{
  for(const [previousHash,hash,previousRevision,expectedRevision] of [['a','a',3,3],['b','a',2,3]]){
   let path;
   await pullVendorSources({claim:async()=>[{...source,content_hash:previousHash.repeat(64),content_revision:previousRevision}],retain:async(s,value)=>{path=value;},stage:async()=>({attachment_id:'a'}),dispatch:async()=>({outcome:'auto_imported'}),finish:async()=>true},{...opts,digest:async()=>hash.repeat(64)});
   assert.equal(path,org+'/vendor-pulls/source/'+expectedRevision+'/'+hash.repeat(64));
  }
 });
 await check('removing a source deletes its credential but retains historical receipt evidence',async()=>{
  const secret=(await db.query('SELECT credential_secret_id id FROM kerdos_private.vendor_price_sources WHERE id=$1',[id])).rows[0].id;
  await db.query('DELETE FROM kerdos_private.vendor_price_sources WHERE id=$1',[id]);
  assert.equal((await db.query('SELECT count(*) FROM vault.secrets WHERE id=$1',[secret])).rows[0].count,0);
  assert.equal((await db.query('SELECT count(*) FROM inbound_messages')).rows[0].count,3);
 });
 // Composed interaction: real source SQL + export adapter + parser/importer.
 // HTTP, object storage and price/catalog persistence are local test doubles.
 const chainedSource=(await db.query("SELECT kerdos_private.configure_vendor_price_source($1,$2,'https://exports.vendor.example.com','/prices.csv','prices.csv',$3,1440,true) id",[org,vendor,{kind:'bearer',token:'chain-synthetic'}])).rows[0].id;
 const state=createPriceImportFixture({text:''});
 const originals=new Map();let price=80;
 const csv=()=>`Code,Description,Pack,Price Unit,Price\nA2-CHAIN-001,Chicken Breast Boneless Skinless,4/10 LB,CASE,${price}\n`;
 state.backend.attachments.download=async path=>{assert.ok(originals.has(path));return originals.get(path);};
 const recordStatus=state.backend.attachments.setStatus;
 state.backend.attachments.setStatus=async(...args)=>{await recordStatus(...args);await db.query('UPDATE inbound_attachments SET processing_status=$1 WHERE id=$2',[args[1],args[0]]);};
 const scalar=async(sql,args)=>(await db.query(sql,args)).rows[0].result;
 const chain={
  claim:id=>scalar('SELECT public.kerdos_claim_vendor_pulls($1) result',[id]),
  async retain(s,path,bytes){assert.equal(s.organization_id,org);if(originals.has(path))assert.deepEqual(originals.get(path),bytes);else originals.set(path,bytes.slice());},
  stage:(s,a)=>scalar('SELECT public.kerdos_stage_vendor_pull($1,$2,$3,$4,$5,$6) result',[s.id,s.lease_token,a.hash,a.path,a.contentType,a.size]),
  async dispatch(organizationId,attachmentId){
   const att=(await db.query('SELECT a.*,m.receipt_vendor_id,m.receipt_document_type FROM inbound_attachments a JOIN inbound_messages m ON m.id=a.message_id WHERE a.id=$1 AND a.organization_id=$2',[attachmentId,organizationId])).rows[0];
   assert.equal(att.receipt_vendor_id,vendor);assert.equal(att.receipt_document_type,'pricelist');
   return processAttachmentInBackground(state.backend,att,{organizationId,vendorId:att.receipt_vendor_id,documentType:att.receipt_document_type});
  },
  finish:(s,status,reason,attachment)=>scalar('SELECT public.kerdos_finish_vendor_pull($1,$2,$3,$4,$5) result',[s.id,s.lease_token,status,reason,attachment]),
 };
 const pull=()=>pullVendorSources(chain,{sourceId:chainedSource,resolveHost:opts.resolveHost,digest:async bytes=>createHash('sha256').update(bytes).digest('hex'),fetchImpl:async(url,options)=>{assert.equal(options.headers.Authorization,'Bearer chain-synthetic');return new Response(csv(),{headers:{'content-type':'text/csv'}});}});
 await check('composed export → real importer creates item, catalog link and exact automatic price with retained original',async()=>{
  assert.equal(state.vendorItems.length,0);assert.equal(state.catalogItems.length,0);
  const result=await pull();assert.equal(result.results[0].status,'received');assert.equal(result.results[0].reason,'auto_imported');
  assert.equal(state.vendorItems.length,1);assert.equal(state.catalogItems.length,1);assert.equal(Object.keys(state.mappings).length,1);
  const quote=state.calls.applyQuote[0];assert.equal(quote.price,80);assert.equal(quote.priceBasis,'case');assert.equal(quote.packSize,'4/10 LB');
  const doc=Object.values(state.importDocs)[0];assert.equal(doc.status,'complete');assert.equal(doc.file_name,'prices.csv');
  assert.equal(quote.sourceDocumentId,doc.id);assert.equal(quote.sourceFilePath,doc.file_path);
  assert.equal(new TextDecoder().decode(originals.get(doc.file_path)),csv());
  const att=(await db.query('SELECT processing_status FROM inbound_attachments WHERE id=$1',[result.results[0].attachmentId])).rows[0];assert.equal(att.processing_status,'auto_imported');
 });
 await check('composed identical export replay creates no second quote, document, item or catalog link',async()=>{
  await pull();assert.equal(state.calls.applyQuote.length,1);assert.equal(Object.keys(state.importDocs).length,1);
  assert.equal(state.vendorItems.length,1);assert.equal(state.catalogItems.length,1);assert.equal(state.calls.createMapping.length,1);assert.equal(originals.size,1);
 });
 await check('composed A → B → A saves all three prices on the same item and keeps every source observation',async()=>{
  price=90;assert.equal((await pull()).results[0].reason,'auto_imported');
  price=80;assert.equal((await pull()).results[0].reason,'auto_imported');
  assert.deepEqual(state.calls.applyQuote.map(q=>q.price),[80,90,80]);
  assert.equal(state.vendorItems.length,1);assert.equal(state.vendorItems[0].price,80);assert.equal(state.catalogItems.length,1);assert.equal(state.calls.createMapping.length,1);
  const docs=Object.values(state.importDocs);assert.equal(docs.length,3);assert.ok(docs.every(d=>d.status==='complete'));
  assert.equal(new Set(docs.map(d=>d.id)).size,3);assert.equal(new Set(docs.map(d=>d.fingerprint)).size,3);assert.equal(originals.size,3);
  for(const q of state.calls.applyQuote)assert.ok(originals.has(q.sourceFilePath));
 });
 await check('composed import retains honest Order Guide qualification and final replay stays duplicate-safe',async()=>{
  const item=state.catalogItems[0],vendorItem=state.vendorItems[0],mapping=Object.values(state.mappings)[0];
  const category=state.categories.find(c=>c.id===item.category_id);
  const assessment=orderGuideAssessment({item,vendorItem,mapping,vendor:{id:vendor,name:'Controlled vendor'},category,categories:state.categories,peers:[]});
  assert.equal(assessment.evidence.unitCost.value,2);assert.equal(assessment.ready,false);assert.deepEqual(assessment.blockers,['category']);
  await pull();assert.equal(state.calls.applyQuote.length,3);assert.equal(Object.keys(state.importDocs).length,3);assert.equal(state.calls.createMapping.length,1);
 });
 await check('new adapter result contract pauses sources without changing stored price observations',async()=>{
  await db.exec(readFileSync('knowledge/a2_vendor_adapter_results_draft.sql','utf8'));
  for(const reason of ['unsupported_adapter','verification_needed','execution_unavailable']){
   await db.query('UPDATE kerdos_private.vendor_price_sources SET is_active=true WHERE id=$1',[chainedSource]);
   const claimed=(await db.query('SELECT public.kerdos_claim_vendor_pulls($1) jobs',[chainedSource])).rows[0].jobs[0];
   assert.ok(claimed);
   assert.equal(await scalar("SELECT public.kerdos_finish_vendor_pull($1,$2,'failed',$3,NULL) result",[chainedSource,claimed.lease_token,reason]),true);
   const row=(await db.query('SELECT is_active,last_reason,content_revision FROM kerdos_private.vendor_price_sources WHERE id=$1',[chainedSource])).rows[0];
   assert.equal(row.is_active,false);assert.equal(row.last_reason,reason);assert.equal(row.content_revision,3);
   assert.deepEqual(await chain.claim(chainedSource),[]);
  }
  assert.equal(state.calls.applyQuote.length,3);
 });
 console.log(`${passed}/${passed} A2 executed adapter/SQL/importer checks passed. HTTP/storage/catalog writes and Vault are simulated locally; no hosted or live vendor acceptance is implied.`);
}finally{await db.close();}
