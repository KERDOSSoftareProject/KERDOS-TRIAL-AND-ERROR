import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {setTimeout as pause} from 'node:timers/promises';
import {randomUUID} from 'node:crypto';
import {PGlite} from '@electric-sql/pglite';
import {Client} from 'pg';

const id = value => `00000000-0000-0000-0000-${String(value).padStart(12, '0')}`;
const [org, other, owner, foreign, category, otherCategory, older, split, merged, retired, review, legacy,
  backfill, stale, unlabeled, rejected, existingItem, vendorItem, mapping] =
  Array.from({length: 19}, (_, i) => id(i + 1));
const migration = await readFile(new URL('../supabase/migrations/20261113163000_catalog_product_labels.sql', import.meta.url), 'utf8');
const numbering = await readFile(new URL('../knowledge/migration_020_category_numbers.sql', import.meta.url), 'utf8');

async function prepare(db) {
  await db.exec(`
    do $$begin
      if not exists (select 1 from pg_roles where rolname = 'anon') then create role anon; end if;
      if not exists (select 1 from pg_roles where rolname = 'authenticated') then create role authenticated; end if;
      if not exists (select 1 from pg_roles where rolname = 'service_role') then create role service_role bypassrls; end if;
    end$$;
    create schema auth;
    create function auth.uid() returns uuid language sql stable as $$
      select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
    $$;
    grant usage on schema auth to anon, authenticated, service_role;
    create table public.organizations(id uuid primary key);
    create table public.organization_members(organization_id uuid, user_id uuid, role text);
    create table public.catalog_categories(
      id uuid primary key, organization_id uuid references public.organizations(id), range_start integer, range_end integer
    );
    create table public.catalog_items(
      id uuid primary key default gen_random_uuid(), organization_id uuid references public.organizations(id),
      category_id uuid references public.catalog_categories(id), name text not null, master_item_number integer,
      created_at timestamptz not null default now(), merged_into_id uuid references public.catalog_items(id),
      lifecycle_state text not null default 'active', matching_behavior text, canonical_unit text,
      comparison_mode text, brand_locked boolean default false, category_review boolean default false, category_reason text
    );
    create table public.vendor_items(
      id uuid primary key, organization_id uuid, description text, field_resolutions jsonb default '{}', row_revision bigint default 0
    );
    create table public.item_mappings(
      id uuid primary key default gen_random_uuid(), organization_id uuid, vendor_item_id uuid,
      catalog_item_id uuid references public.catalog_items(id), match_method text, comparison_track text, confidence_score integer
    );
    grant select on organizations, organization_members, catalog_categories to authenticated, service_role;
    grant select, insert, update on catalog_items, vendor_items, item_mappings to authenticated, service_role;
    alter table catalog_items enable row level security;
    create policy member_items on catalog_items for all to authenticated using (
      exists (select 1 from organization_members where organization_id = catalog_items.organization_id and user_id = (select auth.uid()))
    ) with check (
      exists (select 1 from organization_members where organization_id = catalog_items.organization_id and user_id = (select auth.uid()))
    );
    insert into organizations values ('${org}'), ('${other}');
    insert into organization_members values ('${org}', '${owner}', 'owner'), ('${other}', '${foreign}', 'owner');
    insert into catalog_categories values ('${category}', '${org}', 100, 200), ('${otherCategory}', '${other}', 100, 200);
  `);
  await db.exec(numbering);
  await db.exec(migration);
  await db.exec(migration);
}

async function actor(db, role, user = '') {
  await db.exec('reset role');
  await db.query("select set_config('request.jwt.claim.sub', $1, false)", [user]);
  await db.exec(`set role ${role}`);
}

async function call(db, {organization = org, key = 'product:bacon', name = 'Bacon', categoryId = null} = {}) {
  const {rows} = await db.query('select public.kerdos_find_or_create_product_item($1,$2,$3,$4,$5,$6) result',
    [organization, key, name, categoryId, false, null]);
  return rows[0].result;
}

async function seed(db, itemId, {name, key = null, parent = null, date = '2026-11-12', state = 'active', needsReview = false,
  mergedInto = null, organization = org, categoryId = category}) {
  await db.query(`insert into catalog_items(id,organization_id,category_id,name,concept_key,concept_key_set_at,
    concept_split_from_id,created_at,lifecycle_state,concept_review_required,merged_into_id)
    values ($1,$2,$3,$4,$5,case when $5::text is null then null else now() end,$6,$7,$8,$9,$10)`,
  [itemId, organization, categoryId, name, key, parent, date, state, needsReview, mergedInto]);
}

async function checkLocal() {
  const db = new PGlite();
  try {
    await prepare(db);
    await seed(db, older, {name: 'Original Bacon', key: 'product:bacon', date: '2026-11-10'});
    await seed(db, split, {name: 'Client split', key: 'product:bacon', parent: older, date: '2026-11-09'});
    await seed(db, retired, {name: 'Retired bacon', key: 'product:bacon', date: '2026-11-08', state: 'retired'});
    await seed(db, merged, {name: 'Merged bacon', key: 'product:bacon', date: '2026-11-07', mergedInto: older});
    await seed(db, review, {name: 'Bacon', needsReview: true, date: '2026-11-06'});
    await seed(db, legacy, {name: '  WHOLE   CHICKEN  '});
    await seed(db, backfill, {name: 'Heavy Cream'});
    await seed(db, stale, {name: 'New client name'});
    await seed(db, unlabeled, {name: 'Provisional', state: 'provisional'});
    await seed(db, rejected, {name: 'Eggs'});
    await db.query("insert into item_mappings(organization_id,catalog_item_id,match_method) values ($1,$2,'rejected')", [org,rejected]);
    await seed(db, existingItem, {name: 'Pork'});
    await db.query('insert into vendor_items(id,organization_id,description) values ($1,$2,$3)', [vendorItem,org,'Beef']);
    await db.query('insert into item_mappings(id,organization_id,vendor_item_id,catalog_item_id) values ($1,$2,$3,$4)',
      [mapping,org,vendorItem,existingItem]);
    await actor(db, 'authenticated', owner);
    const found = await call(db);
    assert.equal(found.item.id, older);
    assert.equal(found.sameLabelCount, 2);
    assert.equal(found.created, false);
    const legacyLookup = await call(db, {key: 'product:chicken|whole', name: 'whole chicken'});
    assert.equal(legacyLookup.item.id, legacy);
    assert.equal(legacyLookup.item.concept_key, null);
    const adopted = await call(db, {key: 'product:chicken|whole', name: 'whole chicken', categoryId: category});
    assert.equal(adopted.item.id, legacy);
    assert.equal(adopted.item.concept_key, 'product:chicken|whole');
    assert.equal(adopted.item.master_item_number, legacyLookup.item.master_item_number);
    assert.ok(adopted.item.concept_key_set_at);
    assert.deepEqual(await call(db, {key: 'product:unknown', name: 'Bacon'}),
      {item: null, created: false, sameLabelCount: 0}, 'unresolved review items are ineligible');
    assert.deepEqual(await call(db, {key: 'product:eggs', name: 'Eggs'}),
      {item: null, created: false, sameLabelCount: 0}, 'historical rejection cannot be an automatic target');
    const first = await call(db, {key: 'product:milk', name: 'Milk', categoryId: category});
    const again = await call(db, {key: 'product:milk', name: 'Milk', categoryId: category});
    assert.equal(first.created, true);
    assert.equal(again.created, false);
    assert.equal(first.item.id, again.item.id);
    assert.equal(first.item.master_item_number, again.item.master_item_number);
    const reject = await db.query('select public.kerdos_reject_mapping($1,$2,$3,$4) result', [org,mapping,0,existingItem]);
    const rejectItem = (await db.query('select * from catalog_items where id=$1', [reject.rows[0].result.catalogItemId])).rows[0];
    assert.equal(rejectItem.concept_split_from_id, existingItem);
    assert.equal(rejectItem.concept_key, null, 'rejected listing must not inherit a possibly incorrect key');
    assert.equal((await call(db, {key: 'product:beef', name: 'Beef'})).item, null);
    await assert.rejects(call(db, {organization: other}), /membership/);
    await assert.rejects(call(db, {key: 'product:invalid', name: 'Invalid', categoryId: otherCategory}), /category.*organization/);
    const request = JSON.stringify([
      {id: backfill, name: 'Heavy Cream', key: 'product:cream'},
      {id: stale, name: 'Old client name', key: 'product:outdated'},
      {id: older, name: 'Original Bacon', key: 'product:outdated'},
      {id: unlabeled, name: 'Provisional', key: 'product:outdated'},
      {id: review, name: 'Bacon', key: 'product:outdated'},
      {id: rejected, name: 'Eggs', key: 'product:outdated'},
    ]);
    const fill = () => db.query('select public.kerdos_backfill_product_labels($1,$2::jsonb) result', [org, request]);
    await assert.rejects(fill(), /permission denied/);
    await actor(db, 'anon');
    await assert.rejects(call(db), /permission denied/);
    await actor(db, 'service_role');
    assert.equal((await fill()).rows[0].result, 1);
    assert.equal((await fill()).rows[0].result, 0);
    assert.equal((await call(db, {key: 'product:cream', name: 'Cream'})).item.id, backfill);
    const after = (await db.query('select concept_key, concept_split_from_id from catalog_items where id=$1',[split])).rows[0];
    assert.deepEqual(after, {concept_key:'product:bacon', concept_split_from_id:older});
    const otherTenant = await call(db, {organization: other, categoryId: otherCategory});
    assert.equal(otherTenant.created, true);
    assert.notEqual(otherTenant.item.id, older);
    console.log('PASS Task B SQL lookup, numbering, tenant access, active and review filtering, split retention, rejection, and retryable backfill.');
  } finally {
    await db.close();
  }
}

async function checkConcurrent() {
  const url = new URL(process.env.KERDOS_CONCURRENCY_DATABASE_URL || 'postgresql://postgres:postgres@127.0.0.1:5432/postgres');
  assert.ok(['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname));
  assert.equal(url.pathname, '/postgres');
  assert.equal(url.search, '');
  const database = 'kerdos_labels_' + randomUUID().replaceAll('-', '');
  const clients = [];
  async function connect(name) {
    const target = new URL(url);
    target.pathname = '/' + name;
    const client = new Client({connectionString:target.href,connectionTimeoutMillis:5000,statement_timeout:15000});
    await client.connect();
    clients.push(client);
    return {exec: sql => client.query(sql), query: (...args) => client.query(...args)};
  }
  const admin = await connect('postgres');
  let created = false;
  try {
    await admin.query(`create database ${database}`);
    created = true;
    const setup = await connect(database);
    await prepare(setup);
    const manual = await connect(database);
    const worker = await connect(database);
    const monitor = await connect(database);
    const pid = async session => (await session.query('select pg_backend_pid() pid')).rows[0].pid;
    const [manualPid, workerPid] = await Promise.all([pid(manual), pid(worker)]);
    assert.notEqual(manualPid, workerPid);
    await actor(manual, 'authenticated', owner);
    await actor(worker, 'service_role');
    await manual.query('begin');
    await worker.query('begin');
    let pending;
    try {
      const first = await call(manual, {categoryId: category});
      assert.equal(first.created, true);
      pending = call(worker, {categoryId: category});
      pending.catch(() => {});
      let blocked = false;
      for (let tries = 0; tries < 250 && !blocked; tries++) {
        blocked = (await monitor.query('select $1::int = any(pg_blocking_pids($2::int)) blocked', [manualPid,workerPid])).rows[0].blocked;
        if (!blocked) await pause(20);
      }
      assert.ok(blocked, 'worker waits while the manual transaction holds the same label lock');
      await manual.query('commit');
      const second = await pending;
      await worker.query('commit');
      assert.equal(second.item.id, first.item.id);
      assert.equal(second.created, false);
      assert.equal((await setup.query('select count(*)::int n from catalog_items')).rows[0].n, 1);
      assert.equal((await setup.query('select count(*)::int n from catalog_number_history')).rows[0].n, 1);
      console.log('PASS Task B SQL race with separate manual and worker PostgreSQL sessions and one catalog number.');
    } finally {
      await manual.query('rollback');
      if (pending) await pending.catch(() => {});
      await worker.query('rollback');
    }
  } finally {
    for (const client of clients.slice(1)) await client.end();
    try { if (created) await admin.query(`drop database ${database}`); }
    finally { await clients[0].end(); }
  }
}

if (process.argv.includes('--concurrent')) await checkConcurrent();
else await checkLocal();
