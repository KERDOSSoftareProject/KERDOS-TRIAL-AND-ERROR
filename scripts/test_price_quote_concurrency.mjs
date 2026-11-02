// Independent transactions in an ephemeral loopback-only CI database; never a supplier account.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {Client} from 'pg';
import {priceQuoteFixture} from './fixtures/price-quote-db.mjs';
const url=new URL(process.env.KERDOS_CONCURRENCY_DATABASE_URL||'postgresql://postgres:postgres@127.0.0.1:5432/postgres');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname));assert.equal(url.pathname,'/postgres');assert.equal(url.search,'');
const database='kerdos_quote_retry_'+randomUUID().replaceAll('-','');
const clients=[];let admin,created=false;
async function connect(name=database){const target=new URL(url);target.pathname='/'+name;const c=new Client({connectionString:target.href,connectionTimeoutMillis:10000,statement_timeout:20000,lock_timeout:15000});await c.connect();clients.push(c);return c;}
try{
 admin=await connect('postgres');await admin.query(`create database ${database}`);created=true;
 const setup=await connect(),db={exec:sql=>setup.query(sql),query:(...args)=>setup.query(...args)};
 const f=await priceQuoteFixture(db);const left=await connect(),right=await connect(),monitor=await connect();
 const pids=await Promise.all([left,right,monitor].map(async c=>(await c.query('select pg_backend_pid() as id')).rows[0].id));assert.equal(new Set(pids).size,3);
 for(const mode of ['commit','rollback','conflict']){
  const doc=await f.document(),cmd=f.quote(doc),competing=mode==='conflict'?f.quote(doc,{price:99}):cmd;
  await f.actor(left,f.owner);await f.actor(right,f.manager);await left.query('begin');await right.query('begin');let pending;
  try{
   const first=await f.call(left,cmd);let settled=false;
   pending=f.call(right,competing).then(value=>({value}),error=>({error})).finally(()=>{settled=true;});
   let blocked=false;const deadline=Date.now()+10000;
   while(!settled&&Date.now()<deadline){blocked=(await monitor.query('select $1::int=any(pg_blocking_pids($2::int)) as blocked',[pids[0],pids[1]])).rows[0].blocked;if(blocked)break;await pause(20);}
   assert.ok(blocked,mode+': observe a real lock wait before releasing the first transaction');
   await left.query(mode==='rollback'?'rollback':'commit');const second=await pending;
   if(mode==='conflict'){assert.ok(second.error);assert.match(second.error.message,/Saved source row differs/);await right.query('rollback');}
   else{if(second.error)throw second.error;await right.query('commit');if(mode==='commit')assert.equal(second.value,first);}
   const rows=(await setup.query('select * from price_history where source_document_id=$1',[doc])).rows;assert.equal(rows.length,1);assert.equal(Number(rows[0].price),41.25);
   assert.equal((await setup.query('select count(*)::int as n from vendor_items v where v.import_row->>\'sourceDocumentId\'=$1',[doc])).rows[0].n,1);
   console.log('PASS accepted quote '+mode+': distinct sessions, observed lock wait, one listing/history entry');
  }finally{await left.query('rollback');if(pending)await pending;await right.query('rollback');}
 }
 console.log('Accepted quote recovery: 3 separate-session races passed.');
}finally{
 for(const c of clients.filter(c=>c!==admin))await c.end();
 if(admin){try{if(created){await admin.query(`drop database ${database}`);assert.equal((await admin.query('select count(*)::int as n from pg_database where datname=$1',[database])).rows[0].n,0);console.log('PASS quote fixture database removed');}}finally{await admin.end();}}
}
