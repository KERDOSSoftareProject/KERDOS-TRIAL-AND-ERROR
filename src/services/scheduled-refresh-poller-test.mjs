import assert from 'node:assert/strict';
import {createScheduledRefreshPoller} from './scheduled-refresh-poller.js';
let scheduled,claims=[],received=[],ready=false,slots=[null,{token:'one'}];
const poller=createScheduledRefreshPoller({
 load:async()=>[{id:'a'},{id:'b'}],claim:async id=>{claims.push(id);return slots.shift()||null;},
 canRun:()=>ready,onClaim:async(request,slot)=>received.push([request.id,slot.token]),
 schedule:fn=>{scheduled=fn;return 1;},unschedule:()=>{scheduled=null;},intervalMs:1000,
});
poller.start();await new Promise(resolve=>setImmediate(resolve));assert.deepEqual(claims,[]);
ready=true;await scheduled();assert.deepEqual(claims,['a','b']);assert.deepEqual(received,[['b','one']]);
ready=false;await scheduled();assert.deepEqual(claims,['a','b']);
poller.stop();assert.equal(scheduled,null);
console.log('PASS bounded open-tab due poller: no claim without readiness, server-only claim, one winner, one in-flight cycle and stop.');
