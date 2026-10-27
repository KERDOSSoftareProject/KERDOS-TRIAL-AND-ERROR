import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {PGlite} from "@electric-sql/pglite";
import {routingAddressError} from "../src/services/email-routing.js";
const sql=readFileSync(new URL("../deployment/kerdos-test/20261027161402_kerdos_test_postmark_receiving_address.sql",import.meta.url),"utf8");
const address="aa55b9cf38e8fab147fc4c8b7e914e7d@inbound.postmarkapp.com";
const db=new PGlite();
try {
  await db.exec("create table public.email_routing_addresses (routing_address text not null check(routing_address=lower(routing_address)), constraint email_routing_addresses_inbound_domain check(routing_address like '%@inbound.kerdos.com'))");
  await db.query("insert into public.email_routing_addresses values ($1)",["existing@inbound.kerdos.com"]);
  await db.exec(sql);
  await db.exec(sql);
  await db.query("insert into public.email_routing_addresses values ($1)",[address]);
  await db.query("insert into public.email_routing_addresses values ($1)",["future@inbound.kerdos.com"]);
  for(const rejected of ["another@inbound.postmarkapp.com",address+".example.com","vendor@example.com",address.toUpperCase()]) {
    await assert.rejects(db.query("insert into public.email_routing_addresses values ($1)",[rejected]),/check constraint/);
  }
  assert.equal((await db.query("select count(*)::int as n from public.email_routing_addresses")).rows[0].n,3);
  assert.equal(routingAddressError(address,address),null);
  assert.ok(routingAddressError("another@inbound.postmarkapp.com",address));
  assert.equal(routingAddressError(address,null),null,"universal registration accepts a syntactically valid configured domain when no exact test override is set");
  console.log("PASS exact assigned Postmark receiver allowed; other receivers rejected; branded addresses and lowercase rule preserved; migration repeat safe");
}finally{await db.close();}
