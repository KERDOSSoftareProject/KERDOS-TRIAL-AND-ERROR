import assert from 'node:assert/strict';
import {createScheduledRunner} from '../companion/chrome/core/scheduled-runner.mjs';

const connection={id:'org/vendor/account/list',schedule:{weekday:1,hour:6,minute:0,timeZone:'America/New_York'},firstDueDate:'2026-11-02'};
const records=new Map();let starts=0;
const host={
 async claimOccurrence(id,date,state){const key=`${id}:${date}`;if(records.has(key))return false;records.set(key,{state:'started',kind:state});return true;},
 async finishOccurrence(id,date,result){records.get(`${id}:${date}`).state=result;},
 async validateConnection(){return true;},
 async startRefresh(){starts++;return 'saved';},
};
const due=createScheduledRunner(host,{clock:()=>new Date('2026-11-02T11:01:00Z')});
const pair=await Promise.all([due.tick(connection),due.tick(connection)]);
assert.equal(pair.filter(r=>r.state==='saved').length,1);
assert.equal(pair.filter(r=>r.state==='already_claimed').length,1);
assert.equal(starts,1);
assert.equal(records.get(`${connection.id}:2026-11-02`).state,'saved');
assert.equal((await due.tick(connection)).state,'already_claimed');
assert.equal((await due.tick({...connection,portalAccountLabel:'Different account',transferRevision:2})).state,'already_claimed','changed selection cannot initiate a second same-day export');

const missed=createScheduledRunner(host,{clock:()=>new Date('2026-11-10T11:01:00Z')});
assert.deepEqual(await missed.tick({...connection,firstDueDate:'2026-11-09'}),{state:'missed',localDate:'2026-11-09'});
assert.equal(starts,1,'missed occurrences do not export');
assert.equal(records.get(`${connection.id}:2026-11-09`).state,'missed');

const failedConnection={...connection,id:'other'};
const failing=createScheduledRunner({...host,startRefresh:async()=>{throw Error('private supplier error');}},{clock:()=>new Date('2026-11-02T11:01:00Z')});
assert.deepEqual(await failing.tick(failedConnection),{state:'failed',localDate:'2026-11-02'});
assert.equal(records.get('other:2026-11-02').state,'failed');
assert.equal((await failing.tick(failedConnection)).state,'already_claimed','failure is not automatically replayed');

const verification=createScheduledRunner({...host,startRefresh:async()=> 'verification_needed'},{clock:()=>new Date('2026-11-02T11:01:00Z')});
assert.equal((await verification.tick({...connection,id:'verification'})).state,'verification_needed');
assert.equal(records.get('verification:2026-11-02').state,'verification_needed');

const unsupported=createScheduledRunner({...host,startRefresh:async()=> 'received_for_review'},{clock:()=>new Date('2026-11-02T11:01:00Z')});
assert.equal((await unsupported.tick({...connection,id:'receipt-only'})).state,'failed','receipt does not mean saved prices');
const stale=createScheduledRunner({...host,validateConnection:async()=>false,startRefresh:async()=>{throw Error('supplier must not be touched');}},{clock:()=>new Date('2026-11-02T11:01:00Z')});
assert.equal((await stale.tick({...connection,id:'stale-selection'})).state,'failed');
assert.equal(records.get('stale-selection:2026-11-02').state,'failed');
console.log('PASS scheduled runner: atomic claim, single export, missed run, failure, verification and receipt-only guard');
