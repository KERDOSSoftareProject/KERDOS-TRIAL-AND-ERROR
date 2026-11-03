// Independent sessions in an ephemeral loopback PostgreSQL database only.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {Client,types} from 'pg';
import {invoiceQuoteFixture} from './fixtures/invoice-quote-db.mjs';
import {prepareAutomaticInvoice} from '../src/core/automatic-invoice.js';

const url=new URL(process.env.KERDOS_CONCURRENCY_DATABASE_URL||'postgresql://postgres:postgres@127.0.0.1:5432/postgres');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Only an ephemeral loopback PostgreSQL server is allowed');
assert.equal(url.pathname,'/postgres');assert.equal(url.search,'');
const database='kerdos_quote_'+randomUUID().replaceAll('-','');
types.setTypeParser(1700,Number);types.setTypeParser(20,Number);
const connections=[];let admin,created=false,passed=0;
async function connect(name=database){
 const target=new URL(url);target.pathname='/'+name;
 const c=new Client({connectionString:target.href,connectionTimeoutMillis:10000,statement_timeout:20000,lock_timeout:15000});
 await c.connect();connections.push(c);return c;
}
try{
 admin=await connect('postgres');await admin.query(`create database ${database}`);created=true;
 const setup=await connect();const db={exec:s=>setup.query(s),query:(s,a)=>setup.query(s,a)};
 const f=await invoiceQuoteFixture(db);
 const prepared=await prepareAutomaticInvoice({...f.args,importService:{historicalQuote:f.lookup}});
 assert.equal(prepared.reason,null);
 const line=prepared.lines[0];
 const left=await connect(),right=await connect(),monitor=await connect();
 const pids=await Promise.all([left,right,monitor].map(c=>c.query('select pg_backend_pid() pid').then(r=>r.rows[0].pid)));
 assert.equal(new Set(pids).size,3,'Separate PostgreSQL backends are required');
 const call=(c,att,header,payload)=>c.query('select public.kerdos_auto_record_invoice($1::uuid,$2::uuid,$3,$4::jsonb,$5::jsonb) id',[att,f.token,'quote-race:'+header.invoice_number,JSON.stringify(header),JSON.stringify([payload])]).then(r=>r.rows[0].id);
 let sequence=0;
 async function race(label,{rollback=false,sameAttachment=false,newQuote=false}={}){
  const number='QUOTE-RACE-'+(++sequence),a1=randomUUID(),a2=sameAttachment?a1:randomUUID();
  for(const a of new Set([a1,a2]))await setup.query('insert into inbound_attachments(id,organization_id,message_id,filename,storage_path,processing_status,processing_lease_token) values($1,$2,$3,$4,$5,$6,$7)',[a,f.org,f.message,'invoice.csv','fixture/original','processing',f.token]);
  const header={...prepared.header,invoice_number:number,raw_text:f.text.replace('PROV-101',number),file_name:'invoice.csv',file_path:'fixture/original'};
  let pending;
  await left.query('set role service_role');await right.query('set role service_role');
  await left.query('begin');await right.query('begin');
  try{
   const first=await call(left,a1,header,line);
   let rightLine=line;
   if(newQuote){
    const history=randomUUID();
    await setup.query("insert into price_history select $1,organization_id,vendor_item_id,source_document_id,3,'2026-10-02',quote_valid_until,source,price_basis,selling_unit from price_history where id=$2",[history,f.history]);
    rightLine={...line,quoted_rate:3,quoted_source_rate:3,quoted_price_history_id:history,quoted_effective_date:'2026-10-02',price_variance:-0.94};
   }
   let settled=false;
   pending=call(right,a2,header,rightLine).then(id=>({id}),error=>({error})).finally(()=>{settled=true;});
   const deadline=Date.now()+10000;let blocked=false;
   while(Date.now()<deadline&&!settled){
    blocked=(await monitor.query('select $1::int=any(pg_blocking_pids($2::int)) blocked',[pids[0],pids[1]])).rows[0].blocked;
    if(blocked)break;await pause(20);
   }
   assert.ok(blocked,label+': second session must visibly wait for the first');
   await left.query(rollback?'rollback':'commit');
   const result=await pending;
   if(sameAttachment){assert.equal(result.error?.code,'P0001');assert.match(result.error.message,/LEASE_LOST/);await right.query('rollback');}
   else{if(result.error)throw result.error;await right.query('commit');if(rollback)assert.notEqual(result.id,first);else assert.equal(result.id,first);}
   const {rows:[saved]}=await setup.query(`select i.id,count(l.id)::int lines,min(l.quoted_rate) rate,min(l.quoted_source_rate) source_rate,min(l.price_variance) variance,array_agg(l.quoted_price_history_id::text) quote_ids,array_agg(l.quoted_source_document_id::text) document_ids from invoices i join invoice_lines l on l.invoice_id=i.id where i.invoice_number=$1 group by i.id`,[number]);
   assert.equal((await setup.query('select count(*)::int n from invoices where invoice_number=$1',[number])).rows[0].n,1);
   assert.equal(saved.lines,1);assert.equal(saved.rate,2);assert.equal(saved.source_rate,2);assert.equal(saved.variance,0.06);
   assert.deepEqual(saved.quote_ids,[f.history]);assert.deepEqual(saved.document_ids,[f.doc]);
   const statuses=(await setup.query('select processing_status,import_document_id from inbound_attachments where id=any($1::uuid[])',[[...new Set([a1,a2])]])).rows;
   // The rolled-back first worker leaves its attachment available; the second
   // worker alone owns the committed invoice/document in that scenario.
   if(rollback){assert.equal(statuses.filter(s=>s.processing_status==='auto_imported').length,1);assert.equal(statuses.filter(s=>s.processing_status==='processing').length,1);}
   else{assert.ok(statuses.every(s=>s.processing_status==='auto_imported'));assert.equal(new Set(statuses.map(s=>s.import_document_id)).size,1);}
   passed++;console.log('PASS '+label+': independent sessions, observed lock wait, one invoice/line and original quote evidence');
  }finally{
   await left.query('rollback');if(pending)await pending;await right.query('rollback');
   await left.query('reset role');await right.query('reset role');
  }
 }
 await race('separate attachment replay after commit');
 await race('separate attachment succeeds after first worker rollback',{rollback:true});
 await race('same attachment rejects the stale worker after commit',{sameAttachment:true});
 await race('waiting replay cannot overwrite evidence with a newer quote',{newQuote:true});
 assert.equal(passed,4);console.log('Invoice quote PostgreSQL concurrency: 4/4 races passed. Hosted acceptance remains separate.');
}finally{
 for(const c of connections.filter(c=>c!==admin))await c.end();
 if(admin){try{if(created){await admin.query(`drop database ${database}`);assert.equal((await admin.query('select count(*)::int n from pg_database where datname=$1',[database])).rows[0].n,0);console.log('PASS ephemeral quote database removed');}}finally{await admin.end();}}
}
