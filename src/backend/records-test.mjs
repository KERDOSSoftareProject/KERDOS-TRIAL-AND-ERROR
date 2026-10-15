import assert from "node:assert/strict";
import {createRecords} from "./records.js";
import {executeSupabaseRecordQuery} from "./supabase.js";

const calls=[];
const makeChain=()=>new Proxy({}, {get(_target,key){
  if(key==="then") return resolve=>resolve({data:[{id:"ok"}],error:null});
  return (...args)=>{calls.push([key,...args]);return makeChain();};
}});
const client={from:name=>{calls.push(["from",name]);return makeChain();}};
const records=createRecords(spec=>executeSupabaseRecordQuery(client,spec));
const result=await records.query("price_history").select("id,price").eq("organization_id","org")
  .lte("effective_date","2026-09-23").order("effective_date",{ascending:false}).limit(1);
assert.deepEqual(result.data,[{id:"ok"}]);
assert.deepEqual(calls,[
  ["from","price_history"],["select","id,price"],["eq","organization_id","org"],
  ["lte","effective_date","2026-09-23"],["order","effective_date",{ascending:false}],["limit",1],
]);
calls.length=0;
await records.query("catalog_items").insert({name:"Item"}).select().single();
assert.deepEqual(calls,[
  ["from","catalog_items"],["insert",{name:"Item"}],["select","*"],["single"],
]);
calls.length=0;
await records.query("item_mappings").update({confidence_score:100}).eq("id","m1");
assert.deepEqual(calls,[
  ["from","item_mappings"],["update",{confidence_score:100}],["eq","id","m1"],
]);
await assert.rejects(Promise.resolve(records.query("catalog_items")),/needs an action/);
console.log("KERDOS records adapter translation tests passed");
