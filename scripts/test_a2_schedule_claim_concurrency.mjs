// Distinct PostgreSQL sessions and observed lock waits, only an ephemeral local DB.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {Client} from 'pg';
import {vendorScheduleFixture} from './fixtures/vendor-schedule-db.mjs';
const url=new URL(process.env.KERDOS_CONCURRENCY_DATABASE_URL||'postgresql://postgres:postgres@127.0.0.1:5432/postgres');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/postgres');assert.equal(url.search,'');
const database='kerdos_schedule_race_'+randomUUID().replaceAll('-','');
const clients=[];let admin,created=false;
async function connect(name=database){const target=new URL(url);target.pathname='/'+name;const c=new Client({connectionString:target.href,connectionTimeoutMillis:10000,statement_timeout:20000,lock_timeout:15000});await c.connect();clients.push(c);return c;}
try{
 admin=await connect('postgres');await admin.query(`create database ${database}`);created=true;
 const setup=await connect();await setup.query("set timezone='UTC'");
 const f=await vendorScheduleFixture({exec:sql=>setup.query(sql),query:(...args)=>setup.query(...args)});
 await f.due(setup,f.requestId);
 const left=await connect(),right=await connect(),monitor=await connect();
 const pids=await Promise.all([left,right,monitor].map(async c=>(await c.query('select pg_backend_pid() as id')).rows[0].id));assert.equal(new Set(pids).size,3);
 for(const mode of ['commit','rollback']){
  await setup.query('reset role');await setup.query('delete from kerdos_scheduling.attempts');
  await f.actor(left,f.owner);await f.actor(right,f.manager);await left.query('begin');await right.query('begin');let pending;
  try{
   const first=await f.claim(left,f.requestId);assert.ok(first?.token);let settled=false;
   pending=f.claim(right,f.requestId).then(value=>({value}),error=>({error})).finally(()=>{settled=true;});
   let blocked=false;const deadline=Date.now()+10000;
   while(!settled&&Date.now()<deadline){blocked=(await monitor.query('select $1::int=any(pg_blocking_pids($2::int)) as blocked',[pids[0],pids[1]])).rows[0].blocked;if(blocked)break;await pause(20);}
   assert.ok(blocked,'must observe competing claim blocked on the request row');
   await left.query(mode==='commit'?'commit':'rollback');const second=await pending;if(second.error)throw second.error;
   if(mode==='commit')assert.equal(second.value,null);else{assert.ok(second.value?.token);assert.notEqual(second.value.token,first.token);}
   await right.query('commit');assert.equal((await setup.query('select count(*)::int as n from kerdos_scheduling.attempts')).rows[0].n,1);
   await setup.query("update kerdos_scheduling.attempts set started_at=started_at-interval '1 hour',lease_until=lease_until-interval '1 hour'");
   assert.equal(await f.claim(right,f.requestId),null,'expired unfinished row cannot be re-leased');
   console.log(`PASS scheduled claim ${mode}: independent sessions, observed lock wait, exactly one committed token/row; expired Unknown never re-claimed.`);
  }finally{await left.query('rollback');if(pending)await pending;await right.query('rollback');}
 }
}finally{
 for(const c of clients.filter(c=>c!==admin))await c.end();
 if(admin){try{if(created){await admin.query(`drop database ${database}`);assert.equal((await admin.query('select count(*)::int as n from pg_database where datname=$1',[database])).rows[0].n,0);console.log('PASS schedule race database removed');}}finally{await admin.end();}}
}
