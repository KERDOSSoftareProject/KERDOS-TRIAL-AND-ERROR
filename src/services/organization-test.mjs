import assert from "node:assert/strict";
import {createOrganizationService} from "./organization.js";

const calls=[];
function query(table){
  const state={table};
  const chain={select(value){state.select=value;return chain;},insert(value){state.insert=value;return chain;},update(value){state.update=value;return chain;},upsert(value){state.upsert=value;return chain;},delete(){state.delete=true;return chain;},eq(column,value){(state.eq??=[]).push([column,value]);return chain;},in(column,value){state.in=[column,value];return chain;},order(value,options){state.order=[value,options];return chain;},single(){state.single=true;return chain;},then(resolve){calls.push({...state});const data=state.single?{id:"org1",...state.insert}:[];resolve({data,error:null});}};
  return chain;
}
const service=createOrganizationService({records:{query}});
const organization=await service.create({name:"Universal Supply",industry:"Construction",userId:"u1",vendors:[{name:" Vendor A ",minDollar:"100",minUnits:"5"}]});
assert.equal(organization.id,"org1");
assert.equal(calls.find(call=>call.table==="vendors").insert[0].delivery_minimum_units,5);
await service.changeRole({organizationId:"org1",userId:"u2",role:"manager"});
assert.deepEqual(calls.at(-1).eq,[["organization_id","org1"],["user_id","u2"]]);
await service.update("org1",{name:"Renamed"});
assert.deepEqual(calls.at(-1).update,{name:"Renamed"});
console.log("KERDOS provider-neutral organization-service tests passed");
