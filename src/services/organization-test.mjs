import assert from "node:assert/strict";
import {readFile} from "node:fs/promises";
import {PGlite} from "@electric-sql/pglite";
import {createOrganizationService} from "./organization.js";

const calls=[];
function query(table){
  const state={table};
  const chain={select(value){state.select=value;return chain;},insert(value){state.insert=value;return chain;},update(value){state.update=value;return chain;},upsert(value){state.upsert=value;return chain;},delete(){state.delete=true;return chain;},eq(column,value){(state.eq??=[]).push([column,value]);return chain;},in(column,value){state.in=[column,value];return chain;},order(value,options){state.order=[value,options];return chain;},single(){state.single=true;return chain;},then(resolve){calls.push({...state});const data=state.single?{id:"org1",...state.insert}:["industry_templates","industry_vocabulary"].includes(table)?[{industry:"Construction"},{industry:"Restaurant"}]:[];resolve({data,error:null});}};
  return chain;
}
const service=createOrganizationService({records:{query},organization:{
create:async input=>{calls.push(input);return {id:"org1"};},
rememberVendorLayout:async(organizationId,vendorId,fingerprint,answers)=>{
  calls.push({organizationId,vendorId,fingerprint,answers});return {vendorLayouts:{v1:{fp:{5:'ignore'}}},other:'preserved'};
}}});
const organization=await service.create({name:" Universal Supply ",industry:"Construction",vendors:[{name:" Vendor A ",minDollar:"100",minUnits:"5"},{name:" "}]});
assert.equal(organization.id,"org1");
assert.deepEqual(calls.filter(call=>!call.table),[{name:"Universal Supply",industry:"Construction",vendors:[{name:"Vendor A",delivery_minimum_dollar:100,delivery_minimum_units:5}]}]);
await assert.rejects(service.create({name:"Bad",vendors:[{name:"Vendor A",minUnits:"1.5"}]}),/whole number/);
const creations=calls.filter(call=>!call.table).length;
await assert.rejects(service.create({name:"Missing",industry:"  "}),/Choose an industry/);
await assert.rejects(service.create({name:"Unknown",industry:"Free text"}),/from the list/);
assert.equal(calls.filter(call=>!call.table).length,creations);
await assert.rejects(service.update("org1",{industry:""}),/Choose an industry/);
await service.changeRole({organizationId:"org1",userId:"u2",role:"manager"});
assert.deepEqual(calls.at(-1).eq,[["organization_id","org1"],["user_id","u2"]]);
await service.update("org1",{name:"Renamed"});
assert.deepEqual(calls.at(-1).update,{name:"Renamed"});
const settings=await service.rememberVendorLayout('org1','v1','fp',{5:'ignore'});
assert.deepEqual(calls.at(-1),{organizationId:'org1',vendorId:'v1',fingerprint:'fp',answers:{5:'ignore'}});
assert.equal(settings.vendorLayouts.v1.fp[5],'ignore');
console.log("KERDOS provider-neutral organization-service tests passed");

const db=new PGlite();
try{
  await db.exec(`
    create role authenticated; create role anon; create schema auth; create schema kerdos_private;
    create function auth.uid() returns uuid language sql stable as $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    create function auth.jwt() returns jsonb language sql stable as $$ select nullif(current_setting('request.jwt.claims',true),'')::jsonb $$;
    create table public.organizations(id uuid primary key default gen_random_uuid(), name text not null, slug text unique, industry text, created_at timestamptz default now());
    create table public.organization_members(organization_id uuid references public.organizations, user_id uuid not null, role text not null);
    create table public.industry_templates(industry text not null);
    create table public.industry_vocabulary(industry text not null,kind text,term text,canonical text);
    create table public.org_vocabulary(organization_id uuid references public.organizations on delete cascade,kind text,term text,canonical text,unique(organization_id,kind,term));
    insert into public.industry_templates values ('restaurant'),('construction');
    insert into public.industry_vocabulary values ('restaurant','synonym','chix','chicken'),('construction','synonym','plywd','plywood');
    grant select on public.industry_templates,public.industry_vocabulary to authenticated;
    grant select,insert,update on public.org_vocabulary to authenticated;
    alter table public.org_vocabulary enable row level security;
    create policy own_vocabulary on public.org_vocabulary for all to authenticated using (
      exists(select 1 from public.organization_members m where m.organization_id=org_vocabulary.organization_id and m.user_id=auth.uid())
    ) with check (
      exists(select 1 from public.organization_members m where m.organization_id=org_vocabulary.organization_id and m.user_id=auth.uid() and m.role in ('owner','manager'))
    );
    create table public.vendors(organization_id uuid references public.organizations, name text not null, delivery_minimum_dollar numeric, delivery_minimum_units integer);
    alter table public.organizations enable row level security;
    alter table public.organization_members enable row level security;
    alter table public.vendors enable row level security;
    create policy member_read on public.organization_members for select to authenticated using (user_id=auth.uid());
    grant update on public.organizations to authenticated;
    create policy owner_update on public.organizations for update to authenticated using (
      exists(select 1 from public.organization_members m where m.organization_id=organizations.id and m.user_id=auth.uid() and m.role='owner')
    );
    create policy company_read on public.organizations for select to authenticated using (exists(select 1 from public.organization_members where organization_id=organizations.id and user_id=auth.uid()));
    create policy vendor_read on public.vendors for select to authenticated using (exists(select 1 from public.organization_members m where m.organization_id=vendors.organization_id and m.user_id=auth.uid()));
    grant usage on schema public, auth to authenticated, anon;
    grant select, insert on public.organizations, public.organization_members, public.vendors to authenticated;
  `);
  await db.exec(await readFile(new URL("../../supabase/migrations/20261110132849_first_organization_onboarding.sql",import.meta.url),"utf8"));
  const migration=await readFile(new URL("../../supabase/migrations/20261110223026_required_industry_selection.sql",import.meta.url),"utf8");
  await db.exec(migration);
  await db.exec(migration);
  const setUser=async n=>db.exec(`set role authenticated; set request.jwt.claim.sub='00000000-0000-4000-8000-00000000000${n}';`);
  const create=async (name,vendors=[],industry="restaurant")=>{
    const result=await db.query("select public.kerdos_create_first_organization($1,$2,$3::jsonb) as company",[name,industry,JSON.stringify(vendors)]);
    return result.rows[0].company;
  };
  await db.exec("set role anon");
  await assert.rejects(create("Blocked"),/permission denied/);
  await setUser(1);
  await db.exec("set request.jwt.claims='{\"is_anonymous\":true}'");
  await assert.rejects(create("Blocked"),/Sign in before/);
  await db.exec("set request.jwt.claims='{}'");
  await assert.rejects(db.exec("insert into public.organizations(name) values ('Blocked')"),/row-level security/);
  await assert.rejects(create("Missing",[],""),/Choose an industry/);
  await assert.rejects(create("Unknown",[],"unprepared"),/from the list/);
  await assert.rejects(create("Example",[{name:"Valid"},{name:"Invalid",delivery_minimum_units:-1}]),/nonnegative order minimums/);
  await db.exec("reset role");
  for(const table of ["organizations","organization_members","vendors","org_vocabulary"]){
    assert.equal((await db.query(`select count(*)::int as count from public.${table}`)).rows[0].count,0);
  }
  await setUser(1);
  const first=await create("Example",[{name:"Supplier",delivery_minimum_units:5}]);
  assert.equal((await create("Example")).id,first.id);
  assert.deepEqual((await db.query("select term,canonical from public.org_vocabulary")).rows,[{term:"chix",canonical:"chicken"}]);
  assert.deepEqual((await db.query("select role from public.organization_members")).rows,[{role:"owner"}]);
  assert.deepEqual((await db.query("select name,delivery_minimum_units from public.vendors")).rows,[{name:"Supplier",delivery_minimum_units:5}]);
  await assert.rejects(create("Second Company"),/already belongs/);
  await setUser(2);
  assert.deepEqual((await db.query("select id from public.organizations")).rows,[]);
  const second=await create("Example",[{name:"Supplier",delivery_minimum_units:12}],"construction");
  assert.notEqual(second.id,first.id);
  assert.deepEqual((await db.query("select term,canonical from public.org_vocabulary")).rows,[{term:"plywd",canonical:"plywood"}]);
  assert.notEqual(second.slug,first.slug);
  assert.deepEqual((await db.query("select id,industry from public.organizations")).rows,[{id:second.id,industry:"construction"}]);
  assert.deepEqual((await db.query("select name,delivery_minimum_units from public.vendors")).rows,[{name:"Supplier",delivery_minimum_units:12}]);
  await setUser(1);
  assert.deepEqual((await db.query("select term,canonical from public.org_vocabulary")).rows,[{term:"chix",canonical:"chicken"}]);
  assert.deepEqual((await db.query("select id,industry from public.organizations")).rows,[{id:first.id,industry:"restaurant"}]);
  assert.deepEqual((await db.query("select name,delivery_minimum_units from public.vendors")).rows,[{name:"Supplier",delivery_minimum_units:5}]);
  await assert.rejects(db.query("update public.organizations set industry='' where id=$1",[first.id]),/Choose an industry/);
  await assert.rejects(db.query("update public.organizations set industry='unprepared' where id=$1",[first.id]),/from the list/);
  assert.deepEqual((await db.query("update public.organizations set industry='restaurant' where id=$1 returning id",[second.id])).rows,[],"a company cannot change another company's industry");
  await db.query("update public.org_vocabulary set canonical='client wording' where organization_id=$1 and term='chix'",[first.id]);
  await db.query("update public.organizations set industry='construction' where id=$1",[first.id]);
  assert.deepEqual((await db.query("select term from public.org_vocabulary order by term")).rows,[{term:"chix"},{term:"plywd"}]);
  await db.query("update public.organizations set industry='restaurant' where id=$1",[first.id]);
  assert.equal((await db.query("select count(*)::int as count from public.org_vocabulary")).rows[0].count,2,"reselecting an industry does not duplicate terms");
  assert.equal((await db.query("select canonical from public.org_vocabulary where term='chix'")).rows[0].canonical,"client wording","industry defaults do not overwrite taught vocabulary");
}finally{
  await db.close();
}
console.log("Company setup SQL passed authenticated creation, rollback, retry, and tenant isolation checks.");
