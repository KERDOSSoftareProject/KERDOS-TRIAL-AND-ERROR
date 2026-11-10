import assert from 'node:assert/strict';
import {PGlite} from '@electric-sql/pglite';
import {vendorScheduleFixture} from './fixtures/vendor-schedule-db.mjs';
const db=new PGlite();
try{
 const f=await vendorScheduleFixture(db),id=f.requestId;
 await f.actor(db,f.owner);assert.equal(Number(await f.save(db,id,0)),1);
 assert.equal(Number(await f.save(db,id,1)),1,'unchanged saves retain the version');
 assert.equal(await f.claim(db,id),null,'newly enabled schedule cannot invent a past slot');
 await assert.rejects(f.save(db,id,0),/version_changed/);
 for(const patch of [{days:[1,1]},{days:[]},{days:[0]},{time:'24:00'},{zone:'not/a-zone'},{grace:0},{grace:61}])await assert.rejects(f.save(db,id,1,patch),/invalid_vendor_schedule/);
 await f.actor(db,f.manager);assert.equal(Number(await f.save(db,id,1,{days:[3],zone:'Europe/London'})),2);
 assert.equal(Number(await f.save(db,id,2,{days:[3],zone:'Europe/London',enabled:false})),3);
 assert.equal(await f.claim(db,id),null,'disabled schedules cannot claim');
 await db.query('reset role');const versions=(await db.query('select version,effective_from,effective_to from kerdos_scheduling.versions where request_id=$1 order by version',[id])).rows;
 assert.equal(versions.length,3);assert.equal(String(versions[0].effective_to),String(versions[1].effective_from));assert.equal(String(versions[1].effective_to),String(versions[2].effective_from));
 for(const user of [f.employee,f.outsider,null]){
  await f.actor(db,user);await assert.rejects(f.save(db,id,3),/access_denied/);await assert.rejects(f.claim(db,id),/access_denied/);
  await assert.rejects(db.query('select * from kerdos_scheduling.attempts'),/permission denied/);
  await assert.rejects(db.query('select kerdos_scheduling.claim_refresh($1)',[id]),/access_denied/);
 }
 await f.due(db,id,3);const first=await f.claim(db,id);assert.ok(first?.token);assert.equal(first.request_id,id);assert.equal(first.organization_id,f.org);assert.equal(first.vendor_id,f.vendor);
 assert.equal(await f.claim(db,id),null,'an open row never yields another token');
 await db.query('reset role');await db.query("update kerdos_scheduling.attempts set lease_until=started_at-interval '59 minutes',started_at=started_at-interval '1 hour' where token=$1",[first.token]);
 assert.equal((await db.query('select lease_until<clock_timestamp() as expired from kerdos_scheduling.attempts where token=$1',[first.token])).rows[0].expired,true);
 const before=(await db.query('select * from kerdos_scheduling.attempts where token=$1',[first.token])).rows[0];
 await f.actor(db,f.owner);assert.equal(await f.claim(db,id),null,'an expired unfinished row is Unknown, never reclaimable');
 await assert.rejects(db.query("update kerdos_scheduling.attempts set outcome='saved' where token=$1",[first.token]),/permission denied/);
 await assert.rejects(db.query('insert into kerdos_scheduling.versions(request_id) values($1)',[id]),/permission denied/);
 await db.query('update vendor_connection_requests set state=\'cancelled\' where id=$1',[id]);
 assert.equal(await f.claim(db,id),null);await db.query('reset role');
 assert.deepEqual((await db.query('select * from kerdos_scheduling.attempts where token=$1',[first.token])).rows[0],before,'cancel leaves uncertain work untouched');
 assert.ok((await db.query('select effective_to from kerdos_scheduling.versions where request_id=$1 and version=4',[id])).rows[0].effective_to);
 await f.actor(db,f.owner);await db.query("select kerdos_request_vendor_connection($1,$2,'us-foods-moxe')",[f.org,f.vendor]);assert.equal(await f.claim(db,id),null,'reconnect never revives the retired schedule');
 await f.due(db,id,4);assert.equal(await f.claim(db,id),null,'unknown earlier operation blocks later automatic work too');
 await f.due(db,f.otherRequest);
 await db.query('reset role');await db.query("update kerdos_scheduling.versions set effective_from=clock_timestamp()-interval '30 minutes',local_time=((clock_timestamp()-interval '20 minutes') at time zone 'UTC')::time,weekdays=array[extract(isodow from (clock_timestamp()-interval '20 minutes') at time zone 'UTC')::smallint] where request_id=$1",[f.otherRequest]);
 await f.actor(db,f.outsider);assert.equal(await f.claim(db,f.otherRequest),null,'past-grace slots cannot start late');
 await assert.rejects(db.query('select public.kerdos_claim_scheduled_refresh($1,$2::timestamptz)',[f.otherRequest,'2026-01-01Z']),/does not exist/,'no client-chosen slot parameter exists');
 await f.due(db,f.otherRequest,1);const other=await f.claim(db,f.otherRequest);assert.ok(other?.token);assert.equal(other.organization_id,f.other);
 await db.query('reset role');await db.query("update kerdos_scheduling.attempts set finished_at=clock_timestamp(),outcome='failed' where token=$1",[other.token]);
 await f.actor(db,f.outsider);assert.equal(await f.claim(db,f.otherRequest),null,'finished slots never yield a second token');
 await db.query('reset role');const args=(await db.query("select proargnames from pg_proc where oid='public.kerdos_claim_scheduled_refresh(uuid)'::regprocedure")).rows[0].proargnames;assert.deepEqual(args,['p_request_id']);
 for(const name of ['public.kerdos_claim_scheduled_refresh(uuid)','public.kerdos_set_vendor_refresh_schedule(uuid,bigint,smallint[],time,text,boolean,integer)'])assert.equal((await db.query('select prosecdef from pg_proc where oid=$1::regprocedure',[name])).rows[0].prosecdef,false);
 await db.query('set role anon');await assert.rejects(db.query('select public.kerdos_claim_scheduled_refresh($1)',[id]),/permission denied/);
 console.log('PASS schedule SQL: version windows, no retroactive slots, stale-edit refusal, input validation, owner/manager scope, cross-client/employee/anonymous/direct-write denial, due claim identity, open/expired/finished no-reclaim, cancellation/reconnect fencing, isolated clients. No runner enabled.');
}finally{await db.close();}
