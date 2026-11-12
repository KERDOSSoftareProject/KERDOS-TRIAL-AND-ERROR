import {PGlite} from '@electric-sql/pglite';
import {readFileSync} from 'node:fs';
import assert from 'node:assert/strict';

const db=new PGlite();
const id=value=>`00000000-0000-0000-0000-${String(value).padStart(12,'0')}`;
const [org,other,empty,buyer,outsider,regular,single,stale,alias,foreign,windowed]=Array.from({length:11},(_,index)=>id(index+1));
const migration=readFileSync(new URL('../supabase/migrations/20261112040000_regular_order_items.sql',import.meta.url),'utf8');

try{
  await db.exec(`
    create schema auth;
    create role authenticated;
    create role anon;
    create function auth.uid() returns uuid language sql stable as
      $$ select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid $$;
    grant usage on schema auth to authenticated, anon;
    create table organization_members(organization_id uuid,user_id uuid);
    create table purchase_orders(id uuid primary key,organization_id uuid,status text,submitted_at timestamptz,created_at timestamptz);
    create table purchase_order_lines(purchase_order_id uuid references purchase_orders(id),catalog_item_id uuid,quantity integer);
    create table catalog_items(id uuid primary key,organization_id uuid,merged_into_id uuid references catalog_items(id));
    grant select on organization_members,purchase_orders,purchase_order_lines,catalog_items to authenticated;
    alter table organization_members enable row level security;
    alter table purchase_orders enable row level security;
    alter table purchase_order_lines enable row level security;
    alter table catalog_items enable row level security;
    create policy own_memberships on organization_members for select to authenticated using (user_id=(select auth.uid()));
    create policy member_orders on purchase_orders for select to authenticated using (
      exists(select 1 from organization_members m where m.organization_id=purchase_orders.organization_id));
    create policy member_lines on purchase_order_lines for select to authenticated using (
      exists(select 1 from purchase_orders po where po.id=purchase_order_lines.purchase_order_id));
    create policy member_catalog on catalog_items for select to authenticated using (
      exists(select 1 from organization_members m where m.organization_id=catalog_items.organization_id));
    insert into organization_members values ('${org}','${buyer}'),('${empty}','${buyer}'),('${other}','${outsider}');
    insert into catalog_items values
      ('${regular}','${org}',null),('${single}','${org}',null),('${stale}','${org}',null),
      ('${alias}','${org}','${regular}'),('${foreign}','${other}',null),('${windowed}','${org}',null);
    insert into purchase_orders
    select o.id::uuid,o.organization_id::uuid,o.status,
      case when o.has_submission then now()-make_interval(days=>o.age) end,
      now()-make_interval(days=>o.created_age)
    from (values
      ('${id(20)}','${org}','submitted',1,1,false),
      ('${id(21)}','${org}','submitted',4,80,true),
      ('${id(22)}','${org}','submitted',20,20,true),
      ('${id(23)}','${org}','submitted',61,61,true),
      ('${id(24)}','${org}','submitted',62,62,true),
      ('${id(25)}','${org}','submitted',63,63,true),
      ('${id(26)}','${org}','draft',0,0,true),
      ('${id(27)}','${org}','cancelled',0,0,true),
      ('${id(28)}','${other}','submitted',0,0,true)
    ) o(id,organization_id,status,age,created_age,has_submission);
    insert into purchase_order_lines values
      ('${id(20)}','${regular}',1),('${id(20)}','${regular}',2),('${id(21)}','${alias}',1),
      ('${id(20)}','${single}',1),('${id(20)}','${single}',1),('${id(21)}','${single}',0),
      ('${id(23)}','${stale}',1),('${id(24)}','${stale}',1),
      ('${id(22)}','${windowed}',1),('${id(25)}','${windowed}',1),
      ('${id(26)}','${single}',1),('${id(27)}','${single}',1),('${id(28)}','${foreign}',1),
      ('${id(20)}','${foreign}',1),('${id(21)}','${foreign}',1);
  `);
  await db.exec(migration);
  await db.exec(migration);
  const actor=async(user,role='authenticated')=>{
    await db.exec('reset role');
    await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);
    await db.exec(`set role ${role}`);
  };
  const list=async(organizationId,...thresholds)=>{
    const parameters=[organizationId,...thresholds].map((_,index)=>`$${index+1}`).join(',');
    return (await db.query(`select catalog_item_id from public.kerdos_regular_item_ids(${parameters})`,
      [organizationId,...thresholds])).rows.map(row=>row.catalog_item_id);
  };
  await actor(buyer);
  assert.deepEqual(await list(org),[regular],'counts submitted orders once, resolves aliases and accepts standard orders without submitted_at');
  assert.deepEqual(await list(org,1,5,60),[regular,single,windowed].sort(),'the minimum is configurable');
  assert.deepEqual(await list(org,2,6,60),[regular,windowed].sort(),'the window is configurable');
  assert.deepEqual(await list(org,2,5,62),[regular,stale].sort(),'recency includes the boundary');
  assert.deepEqual(await list(org,2,5,3),[regular],'last purchase controls recency even when the prior purchase is older');
  assert.deepEqual(await list(org,3,5,60),[],'duplicates, drafts, cancelled orders and zero quantities cannot inflate counts');
  assert.deepEqual(await list(empty),[]);
  await assert.rejects(list(org,6,5,60),{code:'22023'});
  await assert.rejects(list(other),{code:'42501'});
  await actor(outsider);
  await assert.rejects(list(org),{code:'42501'});
  await actor(buyer,'anon');
  await assert.rejects(list(org),{code:'42501'});
  await db.exec('reset role');
  const {rows:[permissions]}=await db.query(`
    select prosecdef,has_function_privilege('anon',oid,'EXECUTE') as anon,
           has_function_privilege('authenticated',oid,'EXECUTE') as authenticated
    from pg_proc where proname='kerdos_regular_item_ids'
  `);
  assert.deepEqual(permissions,{prosecdef:false,anon:false,authenticated:true});
  console.log('PASS Regulars PostgreSQL: submitted history, recency, order window, existing timestamps, aliases, workspace RLS and role grants.');
}finally{
  await db.close();
}
