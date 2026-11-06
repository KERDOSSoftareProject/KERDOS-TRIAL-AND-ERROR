import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {Client} from 'pg';
import {vendorScheduleFixture} from './fixtures/vendor-schedule-db.mjs';
const server=process.env.KERDOS_CONCURRENCY_DATABASE_URL;
let db,admin,client,database;
try{
 if(server){
  const url=new URL(server);assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/postgres');assert.equal(url.search,'');
  admin=new Client({connectionString:url.href,connectionTimeoutMillis:10000});await admin.connect();
  database='kerdos_schedule_pause_'+randomUUID().replaceAll('-','');await admin.query(`create database ${database}`);
  url.pathname='/'+database;client=new Client({connectionString:url.href,connectionTimeoutMillis:10000,statement_timeout:10000});await client.connect();
  db={exec:sql=>client.query(sql),query:(...args)=>client.query(...args)};
 }else db=new PGlite();
 const f=await vendorScheduleFixture(db),id=f.requestId;
 await db.exec(`create table import_documents(id uuid primary key default gen_random_uuid(),organization_id uuid not null,vendor_id uuid not null,document_kind text not null,status text not null default 'processing',created_at timestamptz not null default clock_timestamp(),file_path text,fingerprint text);
 grant select,insert,update,delete on import_documents to authenticated;
 alter table import_documents enable row level security;`);
 for(const name of ['20261101135500_companion_retrieval_evidence.sql','20261106221206_vendor_schedule_receipts.sql','20261106224757_vendor_schedule_verification_pause.sql']){
  const sql=readFileSync('supabase/migrations/'+name,'utf8');await db.exec(sql);if(name.includes('verification_pause'))await db.exec(sql);
 }
 await f.actor(db,f.owner);const version=await f.due(db,id),claim=await f.claim(db,id);assert.ok(claim?.token);
 assert.equal((await db.query("select public.kerdos_stop_scheduled_refresh($1,'verification_needed') as result",[claim.token])).rows[0].result,'verification_needed');
 await db.query('reset role');const versions=(await db.query('select version,enabled,effective_from,effective_to from kerdos_scheduling.versions where request_id=$1 order by version',[id])).rows;
 assert.equal(versions.length,2);assert.equal(versions[0].version,version);assert.equal(versions[1].enabled,false);assert.equal(String(versions[0].effective_to),String(versions[1].effective_from));
 await f.actor(db,f.owner);assert.equal(await f.claim(db,id),null);
 assert.equal((await db.query("select public.kerdos_stop_scheduled_refresh($1,'verification_needed') as result",[claim.token])).rows[0].result,'verification_needed');
 await db.query('reset role');assert.equal((await db.query('select count(*)::int n from kerdos_scheduling.versions where request_id=$1',[id])).rows[0].n,2,'idempotent stop does not fork a schedule');
 await f.actor(db,f.owner);assert.equal(Number(await f.save(db,id,version+1)),version+2,'only an explicit owner save can enable a future version');
 console.log('PASS verification pause ('+(server?'isolated PostgreSQL':'PGlite')+'): one stopped slot retires the enabled version atomically; replay is stable; re-enable requires a new owner version.');
}finally{
 if(client)await client.end();if(!server&&db)await db.close();
 if(admin){try{if(database)await admin.query(`drop database if exists ${database}`);}finally{await admin.end();}}
}
