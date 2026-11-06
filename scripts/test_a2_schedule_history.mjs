import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {vendorScheduleFixture} from './fixtures/vendor-schedule-db.mjs';
const db=new PGlite();
try{
 const f=await vendorScheduleFixture(db),id=f.requestId;
 await db.exec("alter table kerdos_scheduling.attempts add column import_document_id uuid, add column receipt_sha256 text, add column received_at timestamptz");
 const migration=readFileSync('supabase/migrations/20261106223111_vendor_schedule_history.sql','utf8');
 await db.exec(migration);await db.exec(migration);
 const history=async(request=id)=>(await db.query('select public.kerdos_vendor_refresh_history($1) as result',[request])).rows[0].result;
 await f.actor(db,f.owner);let h=await history();assert.equal(h.schedule,null);assert.deepEqual(h.slots,[]);
 await assert.rejects(history(f.otherRequest),/access_denied/);
 await f.actor(db,f.employee);await assert.rejects(history(),/access_denied/);
 await db.query('set role anon');await assert.rejects(history(),/permission denied/);
 await f.actor(db,f.owner);
 const version=await f.due(db,id);h=await history();assert.equal(h.schedule.version,version);assert.equal(h.schedule.enabled,true);
 assert.equal(h.slots.length,1);assert.equal(h.slots[0].state,'pending');
 const token=(await f.claim(db,id)).token;h=await history();assert.equal(h.slots[0].token,token);assert.equal(h.slots[0].state,'in_progress');
 await db.query('reset role');await db.query("update kerdos_scheduling.attempts set started_at=started_at-interval '1 hour',lease_until=lease_until-interval '1 hour' where token=$1",[token]);
 await f.actor(db,f.owner);h=await history();assert.equal(h.slots[0].state,'outcome_unknown');
 await db.query('reset role');await db.query("update kerdos_scheduling.attempts set finished_at=clock_timestamp(),outcome='received' where token=$1",[token]);
 await f.actor(db,f.owner);h=await history();assert.equal(h.slots[0].state,'received');
 await f.actor(db,f.outsider);await f.due(db,f.otherRequest);
 await db.query('reset role');await db.query("update kerdos_scheduling.versions set local_time=((clock_timestamp()-interval '20 minutes') at time zone 'UTC')::time,weekdays=array[extract(isodow from (clock_timestamp()-interval '20 minutes') at time zone 'UTC')::smallint],effective_from=clock_timestamp()-interval '30 minutes' where request_id=$1",[f.otherRequest]);
 await f.actor(db,f.outsider);h=await history(f.otherRequest);assert.equal(h.slots[0].state,'missed');
 await f.actor(db,f.owner);await f.save(db,id,version,{enabled:false});h=await history();assert.equal(h.schedule.enabled,false);assert.equal(h.slots.length,1,'disabled versions retain only historical slots');
 console.log('PASS schedule history: ownership, server clock, pending, claimed, unknown, received, missed and version retirement. No runner enabled.');
}finally{await db.close();}
