import assert from "node:assert/strict";
import { loadSnapshot, saveSnapshot } from "./offline-store.js";

assert.equal(await loadSnapshot("missing"),null,"A runtime without IndexedDB returns no cached snapshot");
assert.equal(await saveSnapshot("test",{ok:true}),false,"A runtime without IndexedDB fails closed without throwing");

console.log("KERDOS offline-store fallback tests passed");
