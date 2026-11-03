import assert from 'node:assert/strict';
import {evaluateWeeklyPull} from '../companion/chrome/core/weekly-schedule.mjs';

const monday={weekday:1,hour:6,minute:0,timeZone:'America/New_York'};
const at=(stamp,extra)=>evaluateWeeklyPull(monday,stamp,extra);
assert.deepEqual(at('2026-11-02T10:59:00Z'),{state:'waiting',localDate:'2026-11-02'});
assert.deepEqual(at('2026-11-02T11:00:00Z'),{state:'due',localDate:'2026-11-02'});
assert.deepEqual(at('2026-11-02T11:30:00Z'),{state:'due',localDate:'2026-11-02'});
assert.deepEqual(at('2026-11-02T11:31:00Z'),{state:'missed',localDate:'2026-11-02'});
assert.deepEqual(at('2026-11-02T11:05:00Z',{lastAttemptDate:'2026-11-02'}),{state:'already_attempted',localDate:'2026-11-02'});
assert.deepEqual(at('2026-11-03T11:00:00Z'),{state:'waiting',localDate:'2026-11-03'});
assert.deepEqual(at('2026-07-06T10:00:00Z'),{state:'due',localDate:'2026-07-06'},'Eastern summer time moves to UTC 10:00');
assert.deepEqual(at('2026-07-06T11:00:00Z'),{state:'missed',localDate:'2026-07-06'});
const repeated={weekday:0,hour:1,minute:30,timeZone:'America/New_York'};
assert.deepEqual(evaluateWeeklyPull(repeated,'2026-11-01T05:30:00Z'),{state:'due',localDate:'2026-11-01'});
assert.deepEqual(evaluateWeeklyPull(repeated,'2026-11-01T06:30:00Z',{lastAttemptDate:'2026-11-01'}),{state:'already_attempted',localDate:'2026-11-01'},'repeated fall-back hour cannot cause a second attempt');
for(const bad of [{...monday,timeZone:'Not/A_Zone'},{...monday,weekday:7},{...monday,hour:24},{...monday,minute:-1}])assert.throws(()=>evaluateWeeklyPull(bad,Date.now()));
assert.throws(()=>at('not a date'));
console.log('PASS portable weekly schedule: Eastern winter/summer, due window, missed run, duplicate fence and repeated DST hour');
