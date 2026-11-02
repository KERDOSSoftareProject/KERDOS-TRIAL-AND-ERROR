// Real PostgreSQL sessions in an ephemeral loopback-only CI database. Never Supabase.
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {setTimeout as pause} from 'node:timers/promises';
import {Client,types} from 'pg';
import {estimatedReceiptFixture} from '../src/backend/fixtures/estimated-receipts-db.mjs';

const url=new URL(process.env.KERDOS_CONCURRENCY_DATABASE_URL||'postgresql://postgres:postgres@127.0.0.1:5432/postgres');
assert.ok(['127.0.0.1','localhost','[::1]'].includes(url.hostname),'Concurrency tests require an ephemeral loopback server');
assert.equal(url.pathname,'/postgres','Only an ephemeral PostgreSQL maintenance database is accepted');
assert.equal(url.search,'','Connection overrides are not accepted');
const database='kerdos_task2_'+randomUUID().replaceAll('-','');
// Match the embedded fixture driver; all fixture numbers are small exact integers.
types.setTypeParser(1700,Number);types.setTypeParser(20,Number);
const connections=[];
async function connect(databaseName=database){
 const target=new URL(url);target.pathname='/'+databaseName;
 const c=new Client({connectionString:target.href,connectionTimeoutMillis:10000,statement_timeout:20000,lock_timeout:15000});
 await c.connect();connections.push(c);return c;
}
const one=async(c,sql,args=[])=>(await c.query(sql,args)).rows[0]?.value;
const q=(name,args)=>({sql:`select ${name}(${args.map((_,i)=>'$'+(i+1)).join(',')}) as value`,args:args.map(value=>value!==null&&typeof value==='object'?JSON.stringify(value):value)});
const call=(c,command)=>one(c,command.sql,command.args);
let admin,created=false,passed=0;
try{
 admin=await connect('postgres');await admin.query(`create database ${database}`);created=true;
 const setup=await connect();const db={exec:sql=>setup.query(sql),query:(sql,args=[])=>setup.query(sql,args)};
 const f=await estimatedReceiptFixture({db});const {org,owner,manager,employee,actor,intent,vendor,invoice}=f;
 await setup.query('reset role');
 const left=await connect(),right=await connect(),monitor=await connect();
 const pids=await Promise.all([left,right,monitor].map(c=>one(c,'select pg_backend_pid() as value')));
 assert.equal(new Set(pids).size,3,'Three independent PostgreSQL sessions required');
 async function as(c,user){await c.query('reset role');await c.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await c.query('set role authenticated');}
 const payReview=(s,cents,ref)=>q('kerdos_review_invoice_payment',[org,s.iid,s.approval.id,cents,'2026-11-02','check',ref]);
 const payment=(review,request=randomUUID())=>q('kerdos_save_invoice_payment',[org,request,review,true]);
 const correctionReview=(s,p,cents=3500)=>q('kerdos_review_invoice_payment_correction',[org,s.iid,s.approval.id,p.id,cents,'2026-11-02','check','Correcting the recorded amount']);
 const correction=(review,request=randomUUID())=>q('kerdos_save_invoice_payment_correction',[org,request,review,true,true]);
 const reverse=p=>q('kerdos_reverse_invoice_payment',[org,p.id,'Correcting synthetic payment evidence',true]);
 const withdraw=s=>q('kerdos_withdraw_invoice_approval',[org,s.approval.id,'Withdraw synthetic accounting approval',true]);
 const reverseReceipt=s=>q('kerdos_reverse_estimated_receipt',[org,s.receipt.id,'Correcting synthetic receipt evidence',true]);
 async function scenario(){
  await actor(employee);
  const draft=await call(setup,q('kerdos_save_estimated_draft',[org,vendor,randomUUID(),intent.lines]));
  const review=await call(setup,q('kerdos_review_estimated_order',[org,draft.id]));
  const order=await call(setup,q('kerdos_submit_estimated_order',[org,draft.id,review,true,false]));
  const s=await invoice();
  const receiptReview=await call(setup,q('kerdos_review_estimated_receipt',[org,order.lines[0].id,s.lid,1]));
  s.receipt=await call(setup,q('kerdos_save_estimated_receipt',[org,order.lines[0].id,s.lid,1,receiptReview,true,true]));
  await actor(owner);
  const source=await call(setup,q('kerdos_review_invoice_reconciliation',[org,s.iid]));
  s.approval=await call(setup,q('kerdos_save_invoice_approval',[org,s.iid,randomUUID(),source,'Reviewed synthetic invoice evidence',true]));
  return s;
 }
 async function counts(s,{payments,reversals=0,activeCents,withdrawals=0}){
  await setup.query('reset role');
  const {rows:[r]}=await setup.query(`select (select count(*) from invoice_payments where invoice_id=$1) as payments,
   (select count(*) from invoice_payment_reversals where invoice_id=$1) as reversals,
   (select coalesce(sum(paid_cents),0) from invoice_payments p where invoice_id=$1 and not exists(select 1 from invoice_payment_reversals r where r.payment_id=p.id)) as active,
   (select count(*) from invoice_approval_withdrawals where invoice_id=$1) as withdrawals`,[s.iid]);
  assert.deepEqual(r,{payments,reversals,active:activeCents,withdrawals});
 }
 async function overlap(label,first,second,{error,rollbackFirst=false,same=false,rightActor=manager}={}){
  await as(left,owner);await as(right,rightActor);
  await left.query('begin');await right.query('begin');
  let pending;
  try{
   const a=await call(left,first);
   let settled=false;
   pending=call(right,second).then(value=>({value}),error=>({error})).finally(()=>{settled=true;});
   const deadline=Date.now()+10000;let blocked=false;
   while(Date.now()<deadline&&!settled){
    blocked=await one(monitor,'select $1::int=any(pg_blocking_pids($2::int)) as value',[pids[0],pids[1]]);
    if(blocked)break;await pause(20);
   }
   assert.ok(blocked,`${label}: second session must demonstrably wait on first`);
   await left.query(rollbackFirst?'rollback':'commit');
   const b=await pending;
   if(error){assert.ok(b.error,`${label}: stale/conflicting write unexpectedly succeeded`);assert.equal(b.error.code,'P0001');assert.match(b.error.message,error);await right.query('rollback');}
   else{if(b.error)throw b.error;await right.query('commit');if(same)assert.deepEqual(b.value,a);}
   passed++;console.log(`PASS ${label}: distinct sessions, observed lock wait, verified outcome`);
   return {first:a,second:b.value};
  }finally{
   // Release first before awaiting second even if an assertion/monitor query failed.
   await left.query('rollback');if(pending)await pending;await right.query('rollback');
  }
 }
 // Independent requests cannot overpay, and even harmless stale balances need re-review.
 for(const cents of [4000,1000]){
  const s=await scenario();const a=await call(setup,payReview(s,cents,'RACE-A')),b=await call(setup,payReview(s,cents,'RACE-B'));
  await overlap(`competing ${cents}-cent payments`,payment(a),payment(b),{error:/remaining approved|ledger history changed/});
  await counts(s,{payments:1,activeCents:cents});
 }
 for(const rollbackFirst of [false,true]){
  const s=await scenario(),r=await call(setup,payReview(s,2000,'EXACT-RETRY')),cmd=payment(r);
  await overlap(`same payment request ${rollbackFirst?'rollback':'commit'}`,cmd,cmd,{rightActor:owner,rollbackFirst,same:!rollbackFirst});
  await counts(s,{payments:1,activeCents:2000});
 }
 {
  const s=await scenario(),r=await call(setup,payReview(s,2000,'ACTOR-RETRY')),cmd=payment(r);
  await overlap('same request from different actor',cmd,cmd,{error:/different confirmed evidence/});
  await counts(s,{payments:1,activeCents:2000});
 }
 for(const mode of ['branch','replay','rollback']){
  const s=await scenario(),p=await call(setup,payment(await call(setup,payReview(s,3600,'CORRECTION-REF'))));await call(setup,reverse(p));
  const a=await call(setup,correctionReview(s,p)),b=await call(setup,correctionReview(s,p,3600)),cmd=correction(a);
  const exact=mode!=='branch';
  const result=await overlap(`correction ${mode}`,cmd,exact?cmd:correction(b),{error:exact?undefined:/already has a correction/,rightActor:exact?owner:manager,rollbackFirst:mode==='rollback',same:mode==='replay'});
  await counts(s,{payments:2,reversals:1,activeCents:3500});
  const saved=mode==='rollback'?result.second:result.first;
  assert.equal(saved.sourceReview.correction.paymentId,p.id);assert.equal(saved.reference,p.reference);
  await actor(owner);assert.deepEqual(await call(setup,cmd),saved);
 }
 for(const withdrawalFirst of [true,false]){
  const s=await scenario(),review=await call(setup,payReview(s,2000,'WITHDRAW-RACE')),save=payment(review),withdrawal=withdraw(s);
  await overlap(`approval withdrawal ${withdrawalFirst?'before':'after'} payment`,withdrawalFirst?withdrawal:save,withdrawalFirst?save:withdrawal,{error:withdrawalFirst?/non-withdrawn/:undefined});
  await counts(s,{payments:withdrawalFirst?0:1,activeCents:withdrawalFirst?0:2000,withdrawals:1});
 }
 for(const receiptFirst of [true,false]){
  const s=await scenario(),review=await call(setup,payReview(s,2000,'RECEIPT-RACE')),save=payment(review),reversal=reverseReceipt(s);
  await overlap(`receipt reversal ${receiptFirst?'before':'after'} payment`,receiptFirst?reversal:save,receiptFirst?save:reversal,{error:receiptFirst?/current clean accounting approval/:undefined});
  await counts(s,{payments:receiptFirst?0:1,activeCents:receiptFirst?0:2000});
  await actor(owner);const audit=await call(setup,q('kerdos_review_invoice_approval_audit',[org,s.iid]));
  assert.equal(audit.gate.eligible,false,'Reversed source cannot remain eligible');
 }
 {
  const s=await scenario(),p=await call(setup,payment(await call(setup,payReview(s,2000,'TO-REVERSE'))));
  const stale=await call(setup,payReview(s,1000,'STALE-AFTER-REVERSAL'));
  await overlap('payment reversal invalidates waiting save',reverse(p),payment(stale),{error:/ledger history changed/});
  await counts(s,{payments:1,reversals:1,activeCents:0});
 }
 console.log(`Task 2 PostgreSQL concurrency: ${passed} races passed; browser sign-in and hosted acceptance remain separate.`);
}finally{
 for(const c of connections.filter(c=>c!==admin))await c.end();
 if(admin){try{if(created){await admin.query(`drop database ${database}`);assert.equal(await one(admin,'select count(*)::int as value from pg_database where datname=$1',[database]),0);console.log('PASS ephemeral fixture database removed');}}finally{await admin.end();}}
}
