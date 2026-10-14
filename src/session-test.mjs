import { createSessionController } from "./session.js";
import assert from "node:assert/strict";

function fakeSessionPort(initial=null) {
  let callback=null, unsubscribed=false;
  return {
    async get(){ return initial; },
    subscribe(cb){ callback=cb; return ()=>{unsubscribed=true;}; },
    emit(event,session){ callback?.({event,session}); },
    get unsubscribed(){return unsubscribed;},
  };
}

const restored={user:{id:"u1"}};
let auth=fakeSessionPort(restored), events=[];
let controller=createSessionController(auth);
await controller.start(e=>events.push(e));
assert.equal(events[0].reason,"startup");
assert.equal(events[0].entered,false,"restored session must not masquerade as a fresh login");
auth.emit("TOKEN_REFRESHED",restored);
assert.equal(events.at(-1).entered,false,"token refresh must never navigate as a fresh login");
controller.stop();
assert.equal(auth.unsubscribed,true);

auth=fakeSessionPort(null); events=[]; controller=createSessionController(auth);
await controller.start(e=>events.push(e));
auth.emit("SIGNED_IN",restored);
assert.equal(events.at(-1).entered,true,"real transition from signed-out to signed-in is a fresh login");
auth.emit("TOKEN_REFRESHED",restored);
assert.equal(events.at(-1).entered,false);
auth.emit("SIGNED_OUT",null);
assert.equal(events.at(-1).session,null,"explicit sign-out clears session");
console.log("KERDOS session policy tests passed");
