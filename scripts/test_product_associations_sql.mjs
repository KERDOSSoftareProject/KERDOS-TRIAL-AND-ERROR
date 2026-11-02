import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';
const db=new PGlite(),id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const [org,other,user,employee,outsider,cat1,cat2,v1,v2,m1,m2,request]=Array.from({length:12},(_,i)=>id(i+1));
const migration=readFileSync(new URL('../supabase/migrations/20261102171453_product_group_associations.sql',import.meta.url),'utf8');
try{
 await db.exec(`create schema auth;create role authenticated;create role anon;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated,anon;
 create table organizations(id uuid primary key);
 create table organization_members(organization_id uuid,user_id uuid,role text);
 create table catalog_items(id uuid primary key default gen_random_uuid(),organization_id uuid references organizations(id),master_item_number integer default 999,category_id uuid,name text,brand_locked boolean default false,preferred_brand text,comparison_mode text default 'alternatives');
 create table vendor_items(id uuid primary key,organization_id uuid,description text,brand text,pack_size text,price numeric,selling_unit text,field_resolutions jsonb default '{}',row_revision bigint default 0);
 create table item_mappings(id uuid primary key,organization_id uuid,catalog_item_id uuid references catalog_items(id),vendor_item_id uuid references vendor_items(id),comparison_track text,confidence_score integer,match_method text,reviewed_by uuid,reviewed_at timestamptz);
 create table price_history(id uuid primary key,vendor_item_id uuid,price numeric);
 grant select on organization_members,price_history to authenticated;
 grant select,update on catalog_items,vendor_items,item_mappings to authenticated;grant insert on catalog_items to authenticated;
 insert into organizations values('${org}'),('${other}');
 insert into organization_members values('${org}','${user}','owner'),('${org}','${employee}','employee');
 insert into catalog_items(id,organization_id,master_item_number,name) values('${cat1}','${org}',100,'Original A'),('${cat2}','${org}',101,'Original B');
 insert into vendor_items(id,organization_id,description,brand,pack_size,price,selling_unit,field_resolutions) values
 ('${v1}','${org}','Pomace Oil','A','4/1 GAL',20,'CASE','{"pack_size":{"value":"4/1 GAL","confirmedBy":"old"},"unit_cost_override":{"value":{"price":1}}}'),
 ('${v2}','${org}','Pomace Oil','B','4/3 L',30,'CASE','{}');
 insert into item_mappings values('${m1}','${org}','${cat1}','${v1}','review',70,'rule_based',null,null),('${m2}','${org}','${cat2}','${v2}','review',70,'rule_based',null,null);
 insert into price_history values('${id(50)}','${v1}',20);`);
 for(const table of ['catalog_items','vendor_items','item_mappings'])await db.exec(`alter table ${table} enable row level security;create policy member_scope on ${table} for all to authenticated using(exists(select 1 from organization_members where organization_id=${table}.organization_id and user_id=(select auth.uid()))) with check(exists(select 1 from organization_members where organization_id=${table}.organization_id and user_id=(select auth.uid())));`);
 await db.exec(migration);await db.exec(migration);const processMigration=readFileSync(new URL('../supabase/migrations/20261102172927_product_group_catalog_process.sql',import.meta.url),'utf8');await db.exec(processMigration);await db.exec(processMigration);
 const actor=async who=>{await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[who]);await db.exec('set role authenticated');};
 let members=[{id:v1,revision:0,catalogItemId:cat1},{id:v2,revision:0,catalogItemId:cat2}];
 const save=(patch={})=>db.query('select kerdos_associate_product_group($1,$2,$3,$4,$5::jsonb,$6,$7) result',[patch.org||org,patch.request||request,patch.target||cat1,patch.name||'Pomace Oil',JSON.stringify(patch.members||members),'product-associations-1',patch.confirmed??true]);
 await actor(employee);await assert.rejects(save(),/access/);await actor(outsider);await assert.rejects(save(),/access/);assert.equal((await db.query('select * from product_association_events')).rows.length,0);
 await actor(user);await assert.rejects(save({org:other}),/access/);
 await assert.rejects(save({members:[members[0],members[0]]}),/Duplicate/);
 await assert.rejects(save({members:[members[0],{...members[1],revision:99}]}),/changed/);
 await db.query('update catalog_items set brand_locked=true where id=$1',[cat2]);await assert.rejects(save(),/restriction/);await db.query('update catalog_items set brand_locked=false where id=$1',[cat2]);
 await db.query('update vendor_items set field_resolutions=$1 where id=$2',[JSON.stringify({rejected_vendor_item_ids:[v1]}),v2]);await assert.rejects(save(),/rejected/);await db.query("update vendor_items set field_resolutions='{}' where id=$1",[v2]);
 const beforeRows=(await db.query('select * from vendor_items order by id')).rows,beforeMappings=(await db.query('select * from item_mappings order by id')).rows;
 const saved=(await save()).rows[0].result;assert.equal(saved.associated,2);assert.equal(saved.catalogItemId,cat1);
 const afterRows=(await db.query('select * from vendor_items order by id')).rows;
 for(let i=0;i<2;i++){
  const before={...beforeRows[i]},after={...afterRows[i]};delete before.field_resolutions;delete before.row_revision;delete after.field_resolutions;delete after.row_revision;assert.deepEqual(after,before,'vendor source fields remain byte-for-byte equivalent');
  assert.equal(afterRows[i].field_resolutions.pack_size?.confirmedBy,beforeRows[i].field_resolutions.pack_size?.confirmedBy);assert.equal(Object.hasOwn(afterRows[i].field_resolutions,'row_approval'),false);
 }
 assert.equal((await db.query('select merged_into_id from catalog_items where id=$1',[cat2])).rows[0].merged_into_id,cat1);
 assert.equal((await db.query('select count(*) n from price_history')).rows[0].n,1);
 assert.deepEqual((await save()).rows[0].result,saved,'same request returns saved proof');assert.equal((await db.query('select row_revision from vendor_items where id=$1',[v1])).rows[0].row_revision,1);
 await assert.rejects(save({name:'Different review'}),/different review/);
 await assert.rejects(db.query("update product_association_events set before_state='{}' where request_id=$1",[request]),/permission denied/);
 const restore=()=>db.query('select kerdos_restore_product_group($1,$2) result',[org,request]);
 await db.query('update vendor_items set row_revision=row_revision+1 where id=$1',[v1]);await assert.rejects(restore(),/Later listing/);await db.query('update vendor_items set row_revision=row_revision-1 where id=$1',[v1]);
 await db.query("update item_mappings set confidence_score=90 where id=$1",[m1]);await assert.rejects(restore(),/Later mapping/);await db.query('update item_mappings set confidence_score=100 where id=$1',[m1]);
 await restore();assert.deepEqual((await db.query('select * from item_mappings order by id')).rows,beforeMappings);
 assert.equal((await db.query('select merged_into_id from catalog_items where id=$1',[cat2])).rows[0].merged_into_id,null);assert.equal((await db.query('select name from catalog_items where id=$1',[cat1])).rows[0].name,'Original A');
 assert.deepEqual((await db.query('select field_resolutions from vendor_items order by id')).rows.map(x=>x.field_resolutions),beforeRows.map(x=>x.field_resolutions));
 await restore();await assert.rejects(save(),/restored/);

 // The new catalog process applies candidate groups without blanket approval.
 members=[{id:v1,revision:2,catalogItemId:cat1},{id:v2,revision:2,catalogItemId:cat2}];
 const candidateRequest=id(80);await save({confirmed:false,request:candidateRequest});
 assert.deepEqual((await db.query('select distinct comparison_track,confidence_score,match_method from item_mappings')).rows,[{comparison_track:'review',confidence_score:70,match_method:'rule_based'}]);
 assert.equal((await db.query('select field_resolutions from vendor_items where id=$1',[v1])).rows[0].field_resolutions.product_group.confirmed,false);
 await db.query('select kerdos_restore_product_group($1,$2)',[org,candidateRequest]);
 // A product split can allocate a fresh identity while keeping old numbers.
 members=[{id:v1,revision:4,catalogItemId:cat1},{id:v2,revision:4,catalogItemId:cat2}];
 const createdRequest=id(81);const created=(await db.query('select kerdos_associate_product_group($1,$2,null,$3,$4::jsonb,$5,false) result',[org,createdRequest,'New product identity',JSON.stringify(members),'product-associations-1'])).rows[0].result;
 assert.ok(![cat1,cat2].includes(created.catalogItemId));
 await db.query('select kerdos_restore_product_group($1,$2)',[org,createdRequest]);
 assert.equal((await db.query('select merged_into_id from catalog_items where id=$1',[created.catalogItemId])).rows[0].merged_into_id,cat1);
 await db.exec('reset role;set role anon');await assert.rejects(db.query('select * from product_association_events'),/permission denied/);await assert.rejects(restore(),/permission denied/);await db.exec('reset role');
 assert.equal((await db.query("select bool_or(prosecdef) elevated from pg_proc where proname in('kerdos_associate_product_group','kerdos_restore_product_group')")).rows[0].elevated,false);
 console.log('PASS product association PostgreSQL: real role/RLS, owner versus employee/outsider/anon, repeated migration, stale and duplicate/restriction/rejection guards, source and price history preservation, identity-only confirmation, alias retention, idempotence, immutable audit payload and restore fencing.');
}finally{await db.close();}
