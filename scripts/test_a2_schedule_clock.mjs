// Same SQL/assertions on embedded PostgreSQL locally and isolated PostgreSQL CI.
// This script neither connects to Supabase nor starts any supplier operation.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {Client} from 'pg';

const migration=readFileSync('supabase/migrations/20261106212606_vendor_schedule_clock.sql','utf8');
const server=process.env.KERDOS_CONCURRENCY_DATABASE_URL;
let db,admin,client,database;
try{
 if(server){
  const url=new URL(server);
  assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Only an ephemeral loopback PostgreSQL server is accepted');
  assert.equal(url.pathname,'/postgres');assert.equal(url.search,'');
  admin=new Client({connectionString:url.href,connectionTimeoutMillis:10000});await admin.connect();
  database='kerdos_schedule_clock_'+randomUUID().replaceAll('-','');
  await admin.query(`create database ${database}`);
  url.pathname='/'+database;client=new Client({connectionString:url.href,connectionTimeoutMillis:10000,statement_timeout:10000});await client.connect();
  db={exec:sql=>client.query(sql),query:(sql,args=[])=>client.query(sql,args)};
 }else db=new PGlite();
 await db.exec(`do $$begin
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role;end if;
 end$$;`);
 await db.exec(migration);await db.exec(migration);
 const next=async(days,time,zone,after)=>(await db.query(`select to_char(
  kerdos_private.next_scheduled_at($1::smallint[],$2::time,$3::text,$4::timestamptz) at time zone 'UTC',
  'YYYY-MM-DD"T"HH24:MI:SS"Z"') as value`,[days,time,zone,after])).rows[0].value;
 const cases=[
  // Six o'clock moves by the correct UTC offset, not by run completion time.
  [[7],'06:00','America/New_York','2026-03-01T00:00:00Z','2026-03-01T11:00:00Z'],
  [[7],'06:00','America/New_York','2026-03-08T00:00:00Z','2026-03-08T10:00:00Z'],
  [[7],'06:00','America/New_York','2026-10-25T00:00:00Z','2026-10-25T10:00:00Z'],
  [[7],'06:00','America/New_York','2026-11-01T00:00:00Z','2026-11-01T11:00:00Z'],
  // A nonexistent 02:30 becomes 03:30; repeated 01:30 uses the later occurrence.
  [[7],'02:30','America/New_York','2026-03-08T00:00:00Z','2026-03-08T07:30:00Z'],
  [[7],'01:30','America/New_York','2026-11-01T00:00:00Z','2026-11-01T06:30:00Z'],
  [[7],'01:30','America/New_York','2026-11-01T05:45:00Z','2026-11-01T06:30:00Z'],
  [[7],'01:30','America/New_York','2026-11-01T06:30:00Z','2026-11-08T06:30:00Z'],
  [[1,3,5],'06:00','America/New_York','2026-11-02T11:00:00Z','2026-11-04T11:00:00Z'],
  [[1],'06:00','America/New_York','2026-11-02T10:59:59Z','2026-11-02T11:00:00Z'],
  [[1],'00:00','Asia/Kathmandu','2026-11-01T00:00:00Z','2026-11-01T18:15:00Z'],
  [[7],'06:00','Europe/London','2026-03-29T00:00:00Z','2026-03-29T05:00:00Z'],
  [[7],'02:15','Australia/Lord_Howe','2026-10-03T00:00:00Z','2026-10-03T15:45:00Z'],
  [[4],'06:00','UTC','2024-02-28T23:00:00Z','2024-02-29T06:00:00Z'],
  // Samoa skipped Friday Dec 30 entirely; a Friday schedule waits until Jan 6.
  [[5],'06:00','Pacific/Apia','2011-12-29T00:00:00Z','2012-01-05T16:00:00Z'],
 ];
 for(const [days,time,zone,after,expected] of cases){
  let actual;try{actual=await next(days,time,zone,after);}catch(error){throw Error(`Clock case ${zone} ${time} after ${after}: ${error.message}`);}
  assert.equal(actual,expected,`${zone} ${time} after ${after}`);
 }
 await db.exec("set timezone='Asia/Tokyo'");
 assert.equal(await next([1],'06:00','America/New_York','2026-11-01T00:00:00Z'),'2026-11-02T11:00:00Z','session timezone cannot change the chosen local schedule');
 // Vary completion duration; the next local Monday remains six o'clock.
 let after='2026-10-25T00:00:00Z';
 for(const [index,expected] of ['2026-10-26T10:00:00Z','2026-11-02T11:00:00Z','2026-11-09T11:00:00Z'].entries()){
  const slot=await next([1],'06:00','America/New_York',after);assert.equal(slot,expected);
  after=new Date(Date.parse(slot)+(index+1)*97000).toISOString();
 }
 for(const patch of [
  [null,'06:00','UTC','2026-01-01Z'],[[],'06:00','UTC','2026-01-01Z'],
  [[1,1],'06:00','UTC','2026-01-01Z'],[[0],'06:00','UTC','2026-01-01Z'],
  [[8],'06:00','UTC','2026-01-01Z'],[[1,null],'06:00','UTC','2026-01-01Z'],
  [[[1,2]],'06:00','UTC','2026-01-01Z'],[[1],null,'UTC','2026-01-01Z'],
  [[1],'24:00','UTC','2026-01-01Z'],[[1],'06:00','Not/AZone','2026-01-01Z'],
  [[1],'06:00',null,'2026-01-01Z'],[[1],'06:00','UTC',null],
  [[1],'06:00','UTC','infinity'],[[1],'06:00','UTC','-infinity'],
 ])await assert.rejects(next(...patch),/invalid_vendor_schedule/);
 await assert.rejects(next([1],'25:00','UTC','2026-01-01Z'),/out of range/);
 const fn="kerdos_private.next_scheduled_at(smallint[],time without time zone,text,timestamp with time zone)";
 assert.equal((await db.query('select prosecdef from pg_proc where oid=$1::regprocedure',[fn])).rows[0].prosecdef,false);
 for(const role of ['anon','authenticated','service_role'])assert.equal((await db.query("select has_function_privilege($1,$2,'EXECUTE') as allowed",[role,fn])).rows[0].allowed,false);
 console.log(`PASS A2 schedule clock (${server?'isolated PostgreSQL':'PGlite'}): exact DST offsets/gap/overlap, one occurrence, fractional zones, skipped civil date, strict boundaries, session-zone independence, no completion drift, invalid inputs and private invoker-only helper. No schedules or pulls enabled.`);
}finally{
 if(client)await client.end();
 if(!server&&db)await db.close();
 if(admin){try{if(database)await admin.query(`drop database if exists ${database}`);}finally{await admin.end();}}
}
