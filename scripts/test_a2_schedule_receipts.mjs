import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {Client} from 'pg';
import {vendorScheduleFixture} from './fixtures/vendor-schedule-db.mjs';
const hash='a'.repeat(64),otherHash='b'.repeat(64),server=process.env.KERDOS_CONCURRENCY_DATABASE_URL;
let db,admin,client,database;
try{
 if(server){
  const url=new URL(server);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/postgres');assert.equal(url.search,'');
  admin=new Client({connectionString:url.href,connectionTimeoutMillis:10000});await admin.connect();
  database='kerdos_schedule_receipts_'+randomUUID().replaceAll('-','');await admin.query(`create database ${database}`);
  url.pathname='/'+database;client=new Client({connectionString:url.href,connectionTimeoutMillis:10000,statement_timeout:10000});await client.connect();
  db={exec:sql=>client.query(sql),query:(...args)=>client.query(...args)};
 }else db=new PGlite();
 const f=await vendorScheduleFixture(db),id=f.requestId;
 await db.exec(`create table import_documents(id uuid primary key default gen_random_uuid(),organization_id uuid not null,vendor_id uuid not null,document_kind text not null,status text not null default 'processing',created_at timestamptz not null default clock_timestamp(),file_path text,fingerprint text);
 grant select,insert,update,delete on import_documents to authenticated;
 alter table import_documents enable row level security;
 create policy owned_documents on import_documents for all to authenticated
 using(exists(select 1 from organization_members m where m.organization_id=import_documents.organization_id and m.user_id=auth.uid() and m.role in ('owner','manager')))
 with check(exists(select 1 from organization_members m where m.organization_id=import_documents.organization_id and m.user_id=auth.uid() and m.role in ('owner','manager')));`);
 await db.exec(readFileSync('supabase/migrations/20261101135500_companion_retrieval_evidence.sql','utf8'));
 const migration=readFileSync('supabase/migrations/20261106221206_vendor_schedule_receipts.sql','utf8');await db.exec(migration);await db.exec(migration);
 const recovery=readFileSync('supabase/migrations/20261109162256_vendor_schedule_reconcile_receipt.sql','utf8');await db.exec(recovery);await db.exec(recovery);
 const review=readFileSync('supabase/migrations/20261109163536_vendor_schedule_review_unknown.sql','utf8');await db.exec(review);await db.exec(review);
 const evidence=(token,patch={})=>({kind:'browser_companion',assurance:'user_approved_browser_session',adapter_key:'us-foods-moxe',origin:'https://order.usfoods.com',account_label:'Synthetic account',list_label:'Synthetic list',sha256:hash,byte_length:20,...(token?{attempt_token:token}:{}),...patch});
 const document=async({token=null,ev=evidence(token),org=f.org,vendor=f.vendor,status='processing',path='synthetic/original.csv',kind='pricelist'}={})=>(await db.query('insert into import_documents(organization_id,vendor_id,document_kind,status,file_path,retrieval_evidence,fingerprint) values($1,$2,$3,$4,$5,$6,$7) returning id',[org,vendor,kind,status,path,ev,randomUUID()])).rows[0].id;
 const finish=async(token,doc,sha=hash)=>(await db.query('select kerdos_complete_scheduled_refresh($1,$2,$3) as outcome',[token,doc,sha])).rows[0].outcome;
 const stop=async(token,result)=>(await db.query('select kerdos_stop_scheduled_refresh($1,$2) as outcome',[token,result])).rows[0].outcome;
 const verify=async token=>(await db.query('select kerdos_verify_scheduled_refresh($1) as current',[token])).rows[0].current;
 const reconcile=async requestId=>(await db.query('select kerdos_reconcile_scheduled_refresh($1) as resolved',[requestId])).rows[0].resolved;
 const closeUnknown=async(requestId,token,confirmed)=>(await db.query('select kerdos_close_unknown_scheduled_refresh($1,$2,$3) as outcome',[requestId,token,confirmed])).rows[0].outcome;
 const row=async token=>{await db.exec('reset role');const r=(await db.query('select * from kerdos_scheduling.attempts where token=$1',[token])).rows[0];await f.actor(db,f.owner);return r;};
 let version=0;
 async function mint(){await db.exec('reset role');await db.query('delete from kerdos_scheduling.attempts');version=Number(await f.due(db,id,version));return (await f.claim(db,id)).token;}
 await f.actor(db,f.owner);await document({ev:null});assert.equal((await db.query('select count(*)::int n from import_documents')).rows[0].n,1,'manual import passes without a schedule citation');
 let token=await mint();assert.equal(await verify(token),true);
 const count=(await db.query('select count(*)::int n from import_documents')).rows[0].n;
 for(const patch of [{ev:evidence('not-a-uuid')},{ev:evidence(randomUUID())},{ev:evidence(token,{account_label:'Wrong'})},{ev:evidence(token,{list_label:'Wrong'})},{ev:evidence(token,{origin:'https://wrong.example'})},{vendor:f.otherVendor},{kind:'invoice'},{path:null}])await assert.rejects(document({token,...patch}),/invalid_vendor_schedule_receipt|attempt_unavailable/);
 assert.equal((await db.query('select count(*)::int n from import_documents')).rows[0].n,count,'failed citation rolls back the document');
 assert.equal((await row(token)).import_document_id,null,'failed citation leaves no stamp');
 await f.actor(db,f.outsider);await assert.rejects(document({token,org:f.other,vendor:f.otherVendor}),/access_denied/);await assert.rejects(finish(token,randomUUID()),/access_denied/);
 await f.actor(db,f.owner);const doc=await document({token});assert.equal((await row(token)).import_document_id,doc);
 await assert.rejects(db.query('update import_documents set retrieval_evidence=$1 where id=$2',[evidence(randomUUID()),doc]),/retrieval_evidence_immutable/);
 await assert.rejects(document({token}),/invalid_vendor_schedule_receipt/,'one attempt cannot label a second document');
 await assert.rejects(finish(token,doc),/import_pending/);await assert.rejects(finish(token,doc,otherHash),/invalid_vendor_schedule_receipt/);
 await assert.rejects(stop(token,'failed'),/evidence_required/);
 await db.query("update import_documents set status='partial' where id=$1",[doc]);assert.equal(await finish(token,doc),'received');const terminal=await row(token);
 assert.equal(await finish(token,doc),'received');assert.deepEqual(await row(token),terminal,'identical finish leaves terminal row unchanged');
 await assert.rejects(stop(token,'failed'),/attempt_finished/);await assert.rejects(finish(token,doc,otherHash),/attempt_finished/);await db.exec('reset role');await assert.rejects(db.query("update kerdos_scheduling.attempts set outcome='saved' where token=$1",[token]),/immutable/);
 token=await mint();const completed=await document({token});await db.query("update import_documents set status='complete' where id=$1",[completed]);assert.equal(await finish(token,completed),'saved');
 // Completion of already admitted evidence remains valid after cancellation.
 token=await mint();const admitted=await document({token,status:'complete'});
 await db.query("update vendor_connection_requests set state='cancelled' where id=$1",[id]);
 assert.equal(await finish(token,admitted),'saved');
 await db.query("select kerdos_request_vendor_connection($1,$2,'us-foods-moxe')",[f.org,f.vendor]);
 // Actual retained evidence can resolve a late/unknown operation without retry.
 token=await mint();await db.exec('reset role');await db.query("update kerdos_scheduling.attempts set started_at=started_at-interval '1 hour',lease_until=lease_until-interval '1 hour' where token=$1",[token]);await f.actor(db,f.owner);
 assert.equal(await verify(token),false);await assert.rejects(stop(token,'failed'),/evidence_required/);assert.equal(await f.claim(db,id),null);
 const late=await document({token,status:'complete'});assert.equal(await finish(token,late),'saved');assert.equal(await f.claim(db,id),null,'resolved old slot still cannot run again');
 token=await mint();await db.exec('reset role');await db.query("update kerdos_scheduling.attempts set started_at=started_at-interval '1 hour',lease_until=lease_until-interval '1 hour' where token=$1",[token]);await f.actor(db,f.owner);
 assert.equal(await reconcile(id),0,'an unknown attempt without retained receipt cannot be cleared');assert.equal(await f.claim(db,id),null);
 await assert.rejects(closeUnknown(id,token,false),/review_required/);
 await f.actor(db,f.outsider);await assert.rejects(closeUnknown(id,token,true),/access_denied/);
 await f.actor(db,f.employee);await assert.rejects(closeUnknown(id,token,true),/access_denied/);
 await f.actor(db,f.owner);
 const recovered=await document({token,status:'complete'});
 await assert.rejects(closeUnknown(id,token,true),/evidence_required/,'a bound source file must be resolved from evidence');
 await f.actor(db,f.outsider);await assert.rejects(reconcile(id),/access_denied/);
 await f.actor(db,f.employee);await assert.rejects(reconcile(id),/access_denied/);
 await f.actor(db,f.owner);assert.equal(await f.claim(db,id),null,'a due check reconciles the old receipt without exporting that slot again');
 assert.equal((await row(token)).outcome,'saved');assert.equal(await reconcile(id),0,'reconciliation is idempotent');
 await db.exec('reset role');await assert.rejects(db.query("update kerdos_scheduling.attempts set outcome='failed' where token=$1",[token]),/immutable/);
 await f.actor(db,f.owner);assert.ok(recovered);
 token=await mint();await db.exec('reset role');await db.query("update kerdos_scheduling.attempts set started_at=started_at-interval '1 hour',lease_until=lease_until-interval '1 hour' where token=$1",[token]);await f.actor(db,f.owner);
 assert.equal(await closeUnknown(id,token,true),'closed_unverified');
 const closed=await row(token);assert.equal(closed.outcome,'closed_unverified');assert.equal(closed.closed_by,f.owner);
 assert.equal(await closeUnknown(id,token,true),'closed_unverified');assert.deepEqual(await row(token),closed);
 await assert.rejects(document({token,status:'complete'}),/invalid_vendor_schedule_receipt/,'reviewed closure cannot admit a late file');
 assert.equal(await f.claim(db,id),null,'the old scheduled slot cannot be re-claimed after review');
 token=await mint();const deletedReceipt=await document({token,status:'partial'});await db.query('delete from import_documents where id=$1',[deletedReceipt]);
 await db.exec('reset role');await db.query("update kerdos_scheduling.attempts set started_at=started_at-interval '1 hour',lease_until=lease_until-interval '1 hour' where token=$1",[token]);await f.actor(db,f.owner);
 assert.equal(await closeUnknown(id,token,true),'closed_unverified','a deleted original still requires an explicit reviewed closure');
 assert.equal((await row(token)).import_document_id,deletedReceipt,'historical receipt identity is retained');
 // A genuinely earlier completed document is an unchanged receipt, not a new save.
 await f.actor(db,f.owner);const prior=await document({status:'complete'});const priorEvidence=(await db.query('select retrieval_evidence from import_documents where id=$1',[prior])).rows[0].retrieval_evidence;
 token=await mint();assert.equal(await finish(token,prior),'unchanged');assert.deepEqual((await db.query('select retrieval_evidence from import_documents where id=$1',[prior])).rows[0].retrieval_evidence,priorEvidence);
 await db.query('delete from import_documents where id=$1',[prior]);assert.equal((await row(token)).import_document_id,prior,'deleting a price sheet does not rewrite historical receipt identity');
 await f.actor(db,f.outsider);const foreign=await document({org:f.other,vendor:f.otherVendor,status:'complete'});
 token=await mint();await assert.rejects(finish(token,foreign),/invalid_vendor_schedule_receipt/);
 await f.actor(db,f.employee);await assert.rejects(verify(token),/access_denied/);await assert.rejects(stop(token,'failed'),/access_denied/);await f.actor(db,f.owner);
 const freshUncited=await document({status:'complete'});await assert.rejects(finish(token,freshUncited),/invalid_vendor_schedule_receipt/,'new uncited document cannot masquerade as this attempt');
 assert.equal(await stop(token,'verification_needed'),'verification_needed');assert.equal(await verify(token),false);await assert.rejects(stop(token,'saved'),/invalid_vendor_schedule_outcome/);
 token=await mint();await db.query("update vendor_connection_requests set state='cancelled' where id=$1",[id]);await assert.rejects(document({token}),/invalid_vendor_schedule_receipt/);assert.equal((await row(token)).import_document_id,null);
 await db.query("select kerdos_request_vendor_connection($1,$2,'us-foods-moxe')",[f.org,f.vendor]);await assert.rejects(document({token}),/invalid_vendor_schedule_receipt/,'reconnect cannot revive an old claim');
 console.log('PASS scheduled receipts ('+(server?'isolated PostgreSQL':'PGlite')+'): transactional token/document binding, no stamp on rejected insert, manual pass-through, client/vendor/account/list/origin/revision gates, pending versus partial/saved, immutable/idempotent finish, exact replay hash, expired Unknown resolved by evidence only, historical identity after delete, failure/verification stop. No supplier contact or schedules enabled.');
}finally{
 if(client)await client.end();if(!server&&db)await db.close();
 if(admin){try{if(database)await admin.query(`drop database if exists ${database}`);}finally{await admin.end();}}
}
