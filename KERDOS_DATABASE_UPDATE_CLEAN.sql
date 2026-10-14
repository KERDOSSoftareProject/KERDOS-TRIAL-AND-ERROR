-- KERDOS DATABASE UPDATE
-- Generated from knowledge/migration_003 through migration_023 (008 is unused and intentionally excluded).
-- Do not hand-edit this combined file; update the individual migration and regenerate.

begin;

-- ============================================================
-- migration_003_vocabulary.sql
-- ============================================================

-- KERDOS migration 003: industry and organization vocabulary.
--
-- The matching engine ships with a small base vocabulary and learns the
-- rest from data. industry_vocabulary holds each industry's starter pack
-- (global, read-only to orgs); org_vocabulary is the organization's own
-- editable copy, seeded from its industry when one is chosen and grown by
-- its own corrections in Admin. Four kinds of row:
--   unit       term -> canonical unit code   ("sheets" -> SHEET, "bdft" -> BF)
--   packaging  term is a container word      ("bundle")
--   stopword   term carries no meaning       ("premium")
--   synonym    term -> canonical word         ("chix" -> chicken)

-- Fail during migration, rather than on the first live RPC call, when an
-- older base schema is missing a table column required by migrations 003-007.
do $$
declare
  v_missing text;
begin
  select string_agg(format('%I.%I', required.table_name, required.column_name), ', ')
    into v_missing
  from (values
    ('organizations','id'),
    ('organization_members','organization_id'),('organization_members','user_id'),('organization_members','role'),
    ('catalog_categories','name'),
    ('vendors','id'),('vendors','organization_id'),
    ('vendor_items','id'),('vendor_items','organization_id'),('vendor_items','vendor_id'),
    ('vendor_items','vendor_item_code'),('vendor_items','description'),('vendor_items','pack_size'),
    ('vendor_items','price'),('vendor_items','last_updated'),('vendor_items','price_source'),
    ('price_history','vendor_item_id'),('price_history','organization_id'),('price_history','price'),
    ('price_history','source'),('price_history','effective_date'),
    ('invite_codes','code'),('invite_codes','organization_id'),('invite_codes','role'),
    ('invite_codes','used_by'),('invite_codes','used_at'),
    ('invoices','id'),('invoices','organization_id'),('invoices','vendor_id'),
    ('invoices','total_amount'),('invoices','raw_text'),('invoices','invoice_date'),
    ('invoices','invoice_number'),('invoices','status'),('invoices','file_path'),('invoices','file_name'),
    ('invoice_lines','invoice_id'),('invoice_lines','vendor_item_id'),('invoice_lines','vendor_item_code'),
    ('invoice_lines','description'),('invoice_lines','unit_price'),('invoice_lines','line_total'),
    ('invoice_lines','price_variance'),('invoice_lines','match_confidence'),('invoice_lines','match_method'),
    ('catalog_items','id'),('catalog_items','organization_id'),
    ('item_mappings','organization_id'),('item_mappings','catalog_item_id'),('item_mappings','vendor_item_id'),
    ('item_mappings','confidence_score'),('item_mappings','match_method'),('item_mappings','comparison_track')
  ) as required(table_name,column_name)
  where not exists (
    select 1 from pg_catalog.pg_attribute a
    where a.attrelid=pg_catalog.to_regclass(format('public.%I',required.table_name))
      and a.attname=required.column_name and a.attnum>0 and not a.attisdropped
  );
  if v_missing is not null then
    raise exception 'KERDOS base schema is missing required columns: %',v_missing;
  end if;
end;
$$;

create table if not exists industry_vocabulary (
  id          uuid primary key default gen_random_uuid(),
  industry    text not null,
  kind        text not null check (kind in ('unit','packaging','stopword','synonym')),
  term        text not null,
  canonical   text,
  created_at  timestamptz not null default now(),
  unique (industry, kind, term)
);

create table if not exists org_vocabulary (
  id               uuid primary key default gen_random_uuid(),
  organization_id  uuid not null references organizations(id) on delete cascade,
  kind             text not null check (kind in ('unit','packaging','stopword','synonym')),
  term             text not null,
  canonical        text,
  created_at       timestamptz not null default now(),
  unique (organization_id, kind, term)
);

alter table industry_vocabulary enable row level security;
alter table org_vocabulary      enable row level security;

-- Industry packs: readable by any signed-in user, like industry_templates.
drop policy if exists "industry_vocabulary: read" on industry_vocabulary;
create policy "industry_vocabulary: read" on industry_vocabulary
  for select to authenticated using (true);

-- Org vocabulary: every member reads; owners and managers write.
drop policy if exists "org_vocabulary: members read" on org_vocabulary;
create policy "org_vocabulary: members read" on org_vocabulary
  for select to authenticated using (
    exists (select 1 from organization_members m
            where m.organization_id = org_vocabulary.organization_id
              and m.user_id = auth.uid())
  );

drop policy if exists "org_vocabulary: managers write" on org_vocabulary;
create policy "org_vocabulary: managers write" on org_vocabulary
  for all to authenticated
  using (
    exists (select 1 from organization_members m
            where m.organization_id = org_vocabulary.organization_id
              and m.user_id = auth.uid()
              and m.role in ('owner','manager'))
  )
  with check (
    exists (select 1 from organization_members m
            where m.organization_id = org_vocabulary.organization_id
              and m.user_id = auth.uid()
              and m.role in ('owner','manager'))
  );

-- The holding category (where unmatched items wait for a person) is
-- identified by a flag, not by its name, so an org may rename it.
alter table catalog_categories add column if not exists is_holding_pen boolean not null default false;
update catalog_categories set is_holding_pen = true where name = 'Uncategorized' and not is_holding_pen;

-- ============================================================
-- migration_004_context_and_price_lifecycle.sql
-- ============================================================

-- KERDOS 004: run AFTER migration_003_vocabulary.sql.
-- Never delete historical quoted prices. Current vendor_items fields are a
-- materialized view of the latest eligible quote; price_history is append only.

alter table vendor_items add column if not exists price_expired_at timestamptz;
alter table vendor_items add column if not exists price_quote_valid_until date;

alter table price_history add column if not exists quote_valid_until date;
alter table price_history add column if not exists source_file_path text;
alter table price_history add column if not exists source_file_name text;
alter table price_history add column if not exists source_description text;
alter table price_history add column if not exists source_line text;
alter table price_history add column if not exists source_document_id uuid;

-- The untouched source text and file address belong to the organisation;
-- metadata and extracted rows are never substituted for the actual source.
create table if not exists import_documents (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  vendor_id uuid not null references vendors(id) on delete cascade,
  document_kind text not null check (document_kind in ('pricelist','invoice')),
  fingerprint text not null,
  original_text text not null,
  file_name text,
  file_path text,
  status text not null default 'processing' check (status in ('processing','complete','partial')),
  created_at timestamptz not null default now(),
  unique(organization_id,vendor_id,document_kind,fingerprint)
);

do $$ begin
  if not exists(select 1 from pg_constraint
                where conname='price_history_source_document_fk'
                  and conrelid='public.price_history'::regclass) then
    alter table price_history add constraint price_history_source_document_fk
      foreign key (source_document_id) references import_documents(id) on delete set null;
  end if;
end $$;

alter table import_documents enable row level security;
drop policy if exists "import_documents: members read" on import_documents;
create policy "import_documents: members read" on import_documents
  for select to authenticated using (
    exists(select 1 from organization_members m where m.organization_id=import_documents.organization_id and m.user_id=auth.uid())
  );
drop policy if exists "import_documents: managers insert" on import_documents;
create policy "import_documents: managers insert" on import_documents
  for insert to authenticated with check (
    exists(select 1 from organization_members m where m.organization_id=import_documents.organization_id and m.user_id=auth.uid() and m.role in ('owner','manager'))
  );
drop policy if exists "import_documents: managers update" on import_documents;
create policy "import_documents: managers update" on import_documents
  for update to authenticated using (
    exists(select 1 from organization_members m where m.organization_id=import_documents.organization_id and m.user_id=auth.uid() and m.role in ('owner','manager'))
  ) with check (
    exists(select 1 from organization_members m where m.organization_id=import_documents.organization_id and m.user_id=auth.uid() and m.role in ('owner','manager'))
  );
create index if not exists import_documents_by_vendor on import_documents(organization_id,vendor_id,created_at desc);
create index if not exists price_history_for_invoice on price_history(organization_id,vendor_item_id,effective_date desc);

-- ============================================================
-- migration_005_atomic_price_import.sql
-- ============================================================

-- KERDOS 005: atomic current-price + history write.
-- Run after migration_004_context_and_price_lifecycle.sql.
-- Identity and pack verification remain deterministic KERDOS-core decisions;
-- this function only guarantees that accepted persistence is all-or-nothing.

create or replace function kerdos_apply_price_quote(
  p_vendor_item_id uuid,
  p_organization_id uuid,
  p_vendor_id uuid,
  p_vendor_item_code text,
  p_description text,
  p_pack_size text,
  p_price numeric,
  p_price_unavailable boolean,
  p_effective_date timestamptz,
  p_quote_valid_until date,
  p_source_file_path text,
  p_source_file_name text,
  p_source_line text,
  p_source_document_id uuid
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_item_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if not exists (
    select 1 from organization_members m
    where m.organization_id=p_organization_id and m.user_id=auth.uid()
      and m.role in ('owner','manager')
  ) then raise exception 'Owner or manager access is required for this organization'; end if;
  if not exists (
    select 1 from vendors v where v.id=p_vendor_id and v.organization_id=p_organization_id
  ) then raise exception 'Vendor is outside the requested organization'; end if;
  if p_source_document_id is not null and not exists (
    select 1 from import_documents d
    where d.id=p_source_document_id and d.organization_id=p_organization_id and d.vendor_id=p_vendor_id
  ) then raise exception 'Source document is outside the requested organization/vendor'; end if;
  if p_effective_date is null then raise exception 'A price quotation requires an effective date'; end if;
  if p_price_unavailable is not true and (p_price is null or p_price <= 0) then
    raise exception 'A current quotation requires a positive price';
  end if;

  if p_vendor_item_id is null then
    insert into vendor_items(
      organization_id,vendor_id,vendor_item_code,description,pack_size,price,
      last_updated,price_source,price_unavailable,price_expired_at,price_quote_valid_until
    ) values (
      p_organization_id,p_vendor_id,p_vendor_item_code,p_description,p_pack_size,p_price,
      p_effective_date,'price_list',p_price_unavailable or p_pack_size is null,null,p_quote_valid_until
    ) returning id into v_item_id;
  else
    update vendor_items set
      price=case when p_price_unavailable then price else p_price end,
      pack_size=coalesce(p_pack_size,pack_size),
      last_updated=p_effective_date,
      price_source='price_list',
      price_unavailable=p_price_unavailable or coalesce(p_pack_size,pack_size) is null,
      price_expired_at=null,
      price_quote_valid_until=p_quote_valid_until
    where id=p_vendor_item_id
      and organization_id=p_organization_id
      and vendor_id=p_vendor_id
    returning id into v_item_id;
    if v_item_id is null then raise exception 'Vendor item is outside the requested organization/vendor'; end if;
  end if;

  if not p_price_unavailable then
    insert into price_history(
      vendor_item_id,organization_id,price,source,effective_date,quote_valid_until,
      source_file_path,source_file_name,source_description,source_line,source_document_id
    ) values (
      v_item_id,p_organization_id,p_price,'price_list',p_effective_date,p_quote_valid_until,
      p_source_file_path,p_source_file_name,p_description,p_source_line,p_source_document_id
    );
  end if;
  return v_item_id;
end;
$$;

revoke all on function kerdos_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid) from public;
grant execute on function kerdos_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid) to authenticated;

-- ============================================================
-- migration_006_atomic_invites.sql
-- ============================================================

-- KERDOS 006: consume an invitation and join its organization atomically.
-- The conditional update is the lock: only one caller can consume a code.

create or replace function kerdos_accept_invite(p_code text, p_user_id uuid)
returns table(organization_id uuid, role text)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_org uuid;
  v_role text;
begin
  if auth.uid() is null or p_user_id is distinct from auth.uid() then
    raise exception 'Invitation user does not match the signed-in user';
  end if;

  update public.invite_codes
  set used_by=p_user_id, used_at=now()
  where upper(code)=upper(trim(p_code)) and used_by is null
  returning invite_codes.organization_id, invite_codes.role into v_org,v_role;

  if v_org is null then raise exception 'Invitation code was not found or has already been used'; end if;

  insert into public.organization_members(organization_id,user_id,role)
  values(v_org,p_user_id,v_role)
  on conflict do nothing;

  return query select v_org,v_role;
end;
$$;

revoke all on function kerdos_accept_invite(text,uuid) from public;
grant execute on function kerdos_accept_invite(text,uuid) to authenticated;

-- ============================================================
-- migration_007_atomic_invoices.sql
-- ============================================================

-- KERDOS 007: invoice header and all invoice lines are one transaction.
-- Run after migration_006_atomic_invites.sql.

create or replace function kerdos_record_invoice(p_header jsonb,p_lines jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_invoice_id uuid;
  v_line jsonb;
  v_vendor_item_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if nullif(p_header->>'organization_id','') is null or nullif(p_header->>'vendor_id','') is null then
    raise exception 'Invoice organization and vendor are required';
  end if;
  if not exists (
    select 1 from organization_members m
    where m.organization_id=(p_header->>'organization_id')::uuid
      and m.user_id=auth.uid() and m.role in ('owner','manager')
  ) then raise exception 'Owner or manager access is required for this organization'; end if;
  if not exists (
    select 1 from vendors v
    where v.id=(p_header->>'vendor_id')::uuid
      and v.organization_id=(p_header->>'organization_id')::uuid
  ) then raise exception 'Vendor is outside the requested organization'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines)=0 then
    raise exception 'An invoice requires at least one line';
  end if;

  insert into invoices(
    organization_id,vendor_id,total_amount,raw_text,invoice_date,
    invoice_number,status,file_path,file_name
  ) values (
    (p_header->>'organization_id')::uuid,(p_header->>'vendor_id')::uuid,
    (p_header->>'total_amount')::numeric,p_header->>'raw_text',
    (p_header->>'invoice_date')::date,nullif(p_header->>'invoice_number',''),
    'recorded',nullif(p_header->>'file_path',''),nullif(p_header->>'file_name','')
  ) returning id into v_invoice_id;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_vendor_item_id=nullif(v_line->>'vendor_item_id','')::uuid;
    if v_vendor_item_id is not null and not exists (
      select 1 from vendor_items vi
      where vi.id=v_vendor_item_id
        and vi.organization_id=(p_header->>'organization_id')::uuid
        and vi.vendor_id=(p_header->>'vendor_id')::uuid
    ) then raise exception 'Invoice vendor item is outside the requested organization/vendor'; end if;
    if nullif(v_line->>'catalog_item_id','') is not null and not exists (
      select 1 from catalog_items ci
      where ci.id=(v_line->>'catalog_item_id')::uuid
        and ci.organization_id=(p_header->>'organization_id')::uuid
    ) then raise exception 'Catalog item is outside the requested organization'; end if;
    if v_vendor_item_id is null and coalesce((v_line->>'create_vendor_item')::boolean,false) then
      select id into v_vendor_item_id from vendor_items
      where organization_id=(p_header->>'organization_id')::uuid
        and vendor_id=(p_header->>'vendor_id')::uuid
        and ((nullif(v_line->>'vendor_item_code','') is not null and vendor_item_code=v_line->>'vendor_item_code')
          or (nullif(v_line->>'vendor_item_code','') is null and description=v_line->>'description'))
      limit 1;
      if v_vendor_item_id is null then
        insert into vendor_items(
        organization_id,vendor_id,vendor_item_code,description,pack_size,price,last_updated,price_source
        ) values (
          (p_header->>'organization_id')::uuid,(p_header->>'vendor_id')::uuid,
          nullif(v_line->>'vendor_item_code',''),v_line->>'description',nullif(v_line->>'pack_size',''),
          (v_line->>'unit_price')::numeric,(p_header->>'invoice_date')::date,'invoice'
        ) returning id into v_vendor_item_id;
      end if;

      if nullif(v_line->>'catalog_item_id','') is not null then
        insert into item_mappings(
          organization_id,catalog_item_id,vendor_item_id,confidence_score,match_method,comparison_track
        ) values (
          (p_header->>'organization_id')::uuid,(v_line->>'catalog_item_id')::uuid,v_vendor_item_id,
          coalesce((v_line->>'catalog_confidence')::integer,0),'rule_based',
          coalesce(nullif(v_line->>'catalog_track',''),'similar')
        ) on conflict do nothing;
      end if;
    end if;

    insert into invoice_lines(
      invoice_id,vendor_item_id,vendor_item_code,description,unit_price,
      line_total,price_variance,match_confidence,match_method
    ) values (
      v_invoice_id,v_vendor_item_id,nullif(v_line->>'vendor_item_code',''),v_line->>'description',
      (v_line->>'unit_price')::numeric,(v_line->>'line_total')::numeric,
      nullif(v_line->>'price_variance','')::numeric,nullif(v_line->>'match_confidence','')::integer,
      nullif(v_line->>'match_method','')
    );
  end loop;

  return v_invoice_id;
end;
$$;

revoke all on function kerdos_record_invoice(jsonb,jsonb) from public;
grant execute on function kerdos_record_invoice(jsonb,jsonb) to authenticated;

-- ============================================================
-- migration_009_price_basis.sql
-- ============================================================

-- Migration 009: price basis and product identifiers.
-- A vendor's price is for one full pack ("case"), one inner unit ("each"),
-- or one unit of measure such as a pound ("measure"). KERDOS ranks vendors
-- on the price of one full pack, so the basis must travel with every quote
-- and every history row; without it a per-pound price looks like a case
-- price and produces a false cheapest vendor and false invoice variances.
-- Rows with a null basis predate this migration and were always pack prices.

alter table vendor_items add column if not exists selling_unit text;
alter table vendor_items add column if not exists price_basis text;
alter table vendor_items drop constraint if exists vendor_items_price_basis_check;
alter table vendor_items add constraint vendor_items_price_basis_check
  check (price_basis is null or price_basis in ('case','each','measure'));

-- Identifiers a vendor prints on its listing. A GTIN (UPC/EAN) names one
-- trade item across vendors; a manufacturer code does the same within a
-- brand. Both let the engine prove identity without comparing wording.
alter table vendor_items add column if not exists gtin text;
alter table vendor_items add column if not exists manufacturer_code text;
create index if not exists vendor_items_gtin_idx on vendor_items(organization_id,gtin) where gtin is not null;

-- A new product is placed in its most likely category rather than the
-- holding pen. When that placement is a best guess, the item carries a
-- review flag and the reason, cleared when the client confirms or moves it.
alter table catalog_items add column if not exists category_review boolean not null default false;
alter table catalog_items add column if not exists category_reason text;

alter table price_history add column if not exists selling_unit text;
alter table price_history add column if not exists price_basis text;
alter table price_history drop constraint if exists price_history_price_basis_check;
alter table price_history add constraint price_history_price_basis_check
  check (price_basis is null or price_basis in ('case','each','measure'));

-- The quote function gains two parameters. The old signature is removed so
-- there is exactly one function; both new parameters default to null, so a
-- caller that has not been updated keeps working and records legacy rows.
drop function if exists kerdos_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid);

create or replace function kerdos_apply_price_quote(
  p_vendor_item_id uuid,
  p_organization_id uuid,
  p_vendor_id uuid,
  p_vendor_item_code text,
  p_description text,
  p_pack_size text,
  p_price numeric,
  p_price_unavailable boolean,
  p_effective_date timestamptz,
  p_quote_valid_until date,
  p_source_file_path text,
  p_source_file_name text,
  p_source_line text,
  p_source_document_id uuid,
  p_selling_unit text default null,
  p_price_basis text default null,
  p_gtin text default null,
  p_manufacturer_code text default null
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_item_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if not exists (
    select 1 from organization_members m
    where m.organization_id=p_organization_id and m.user_id=auth.uid()
      and m.role in ('owner','manager')
  ) then raise exception 'Owner or manager access is required for this organization'; end if;
  if not exists (
    select 1 from vendors v where v.id=p_vendor_id and v.organization_id=p_organization_id
  ) then raise exception 'Vendor is outside the requested organization'; end if;
  if p_source_document_id is not null and not exists (
    select 1 from import_documents d
    where d.id=p_source_document_id and d.organization_id=p_organization_id and d.vendor_id=p_vendor_id
  ) then raise exception 'Source document is outside the requested organization/vendor'; end if;
  if p_effective_date is null then raise exception 'A price quotation requires an effective date'; end if;
  if p_price_unavailable is not true and (p_price is null or p_price <= 0) then
    raise exception 'A current quotation requires a positive price';
  end if;
  if p_price_basis is not null and p_price_basis not in ('case','each','measure') then
    raise exception 'Price basis must be case, each or measure';
  end if;

  if p_vendor_item_id is null then
    insert into vendor_items(
      organization_id,vendor_id,vendor_item_code,description,pack_size,price,
      last_updated,price_source,price_unavailable,price_expired_at,price_quote_valid_until,
      selling_unit,price_basis,gtin,manufacturer_code
    ) values (
      p_organization_id,p_vendor_id,p_vendor_item_code,p_description,p_pack_size,p_price,
      p_effective_date,'price_list',p_price_unavailable or p_pack_size is null,null,p_quote_valid_until,
      p_selling_unit,p_price_basis,p_gtin,p_manufacturer_code
    ) returning id into v_item_id;
  else
    update vendor_items set
      price=case when p_price_unavailable then price else p_price end,
      pack_size=coalesce(p_pack_size,pack_size),
      last_updated=p_effective_date,
      price_source='price_list',
      price_unavailable=p_price_unavailable or coalesce(p_pack_size,pack_size) is null,
      price_expired_at=null,
      price_quote_valid_until=p_quote_valid_until,
      selling_unit=case when p_price_unavailable then selling_unit else p_selling_unit end,
      price_basis=case when p_price_unavailable then price_basis else p_price_basis end,
      gtin=coalesce(p_gtin,gtin),
      manufacturer_code=coalesce(p_manufacturer_code,manufacturer_code)
    where id=p_vendor_item_id
      and organization_id=p_organization_id
      and vendor_id=p_vendor_id
    returning id into v_item_id;
    if v_item_id is null then raise exception 'Vendor item is outside the requested organization/vendor'; end if;
  end if;

  if not p_price_unavailable then
    insert into price_history(
      vendor_item_id,organization_id,price,source,effective_date,quote_valid_until,
      source_file_path,source_file_name,source_description,source_line,source_document_id,
      selling_unit,price_basis
    ) values (
      v_item_id,p_organization_id,p_price,'price_list',p_effective_date,p_quote_valid_until,
      p_source_file_path,p_source_file_name,p_description,p_source_line,p_source_document_id,
      p_selling_unit,p_price_basis
    );
  end if;
  return v_item_id;
end;
$$;

revoke all on function kerdos_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid,text,text,text,text) from public;
grant execute on function kerdos_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid,text,text,text,text) to authenticated;

-- ============================================================
-- migration_010_catalog_rows.sql
-- ============================================================

-- Migration 010: editable catalog rows and durable field corrections.
-- Existing catalog numbers, vendor links and quote history are retained.
alter table public.vendor_items add column if not exists field_resolutions jsonb not null default '{}'::jsonb;
alter table public.vendor_items add column if not exists import_row jsonb not null default '{}'::jsonb;
alter table public.vendor_items add column if not exists row_revision bigint not null default 0;

-- Replace the old quote overload; new arguments default for older clients.
drop function if exists public.kerdos_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid,text,text,text,text);
create or replace function kerdos_apply_price_quote(
  p_vendor_item_id uuid,
  p_organization_id uuid,
  p_vendor_id uuid,
  p_vendor_item_code text,
  p_description text,
  p_pack_size text,
  p_price numeric,
  p_price_unavailable boolean,
  p_effective_date timestamptz,
  p_quote_valid_until date,
  p_source_file_path text,
  p_source_file_name text,
  p_source_line text,
  p_source_document_id uuid,
  p_selling_unit text default null,
  p_price_basis text default null,
  p_gtin text default null,
  p_manufacturer_code text default null,
  p_import_row jsonb default null,
  p_field_resolutions jsonb default null
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_item_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if not exists (
    select 1 from organization_members m
    where m.organization_id=p_organization_id and m.user_id=auth.uid()
      and m.role in ('owner','manager')
  ) then raise exception 'Owner or manager access is required for this organization'; end if;
  if not exists (
    select 1 from vendors v where v.id=p_vendor_id and v.organization_id=p_organization_id
  ) then raise exception 'Vendor is outside the requested organization'; end if;
  if p_source_document_id is not null and not exists (
    select 1 from import_documents d
    where d.id=p_source_document_id and d.organization_id=p_organization_id and d.vendor_id=p_vendor_id
  ) then raise exception 'Source document is outside the requested organization/vendor'; end if;
  if p_effective_date is null then raise exception 'A price quotation requires an effective date'; end if;
  if p_price_unavailable is not true and (p_price is null or p_price <= 0) then
    raise exception 'A current quotation requires a positive price';
  end if;
  if p_price_basis is not null and p_price_basis not in ('case','each','measure') then
    raise exception 'Price basis must be case, each or measure';
  end if;

  if p_vendor_item_id is null then
    insert into vendor_items(
      organization_id,vendor_id,vendor_item_code,description,pack_size,price,
      last_updated,price_source,price_unavailable,price_expired_at,price_quote_valid_until,
      selling_unit,price_basis,gtin,manufacturer_code,import_row,field_resolutions
    ) values (
      p_organization_id,p_vendor_id,p_vendor_item_code,p_description,p_pack_size,p_price,
      p_effective_date,'price_list',p_price_unavailable or p_pack_size is null,null,p_quote_valid_until,
      p_selling_unit,p_price_basis,p_gtin,p_manufacturer_code,coalesce(p_import_row,'{}'::jsonb),coalesce(p_field_resolutions,'{}'::jsonb)
    ) returning id into v_item_id;
  else
    update vendor_items set
      price=case when p_price_unavailable then price else p_price end,
      pack_size=coalesce(p_pack_size,pack_size),
      last_updated=p_effective_date,
      price_source='price_list',
      price_unavailable=p_price_unavailable or coalesce(p_pack_size,pack_size) is null,
      price_expired_at=null,
      price_quote_valid_until=p_quote_valid_until,
      selling_unit=case when p_price_unavailable then selling_unit else p_selling_unit end,
      price_basis=case when p_price_unavailable then price_basis else p_price_basis end,
      gtin=coalesce(p_gtin,gtin),
      manufacturer_code=coalesce(p_manufacturer_code,manufacturer_code),
      import_row=coalesce(p_import_row,import_row),
      field_resolutions=coalesce(p_field_resolutions,field_resolutions),
      row_revision=row_revision+1
    where id=p_vendor_item_id
      and organization_id=p_organization_id
      and vendor_id=p_vendor_id
    returning id into v_item_id;
    if v_item_id is null then raise exception 'Vendor item is outside the requested organization/vendor'; end if;
  end if;

  if not p_price_unavailable then
    insert into price_history(
      vendor_item_id,organization_id,price,source,effective_date,quote_valid_until,
      source_file_path,source_file_name,source_description,source_line,source_document_id,
      selling_unit,price_basis
    ) values (
      v_item_id,p_organization_id,p_price,'price_list',p_effective_date,p_quote_valid_until,
      p_source_file_path,p_source_file_name,p_description,p_source_line,p_source_document_id,
      p_selling_unit,p_price_basis
    );
  end if;
  return v_item_id;
end;
$$;

revoke all on function kerdos_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid,text,text,text,text,jsonb,jsonb) from public;
grant execute on function kerdos_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid,text,text,text,text,jsonb,jsonb) to authenticated;

-- Save one row, its category, and any changed price together. A rejected
-- write rolls back all of them. Optimistic revision prevents lost updates.
create or replace function public.kerdos_save_catalog_row(
  p_organization_id uuid, p_vendor_item_id uuid, p_mapping_id uuid,
  p_expected_revision bigint, p_patch jsonb, p_price_basis text,
  p_price_available boolean
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_old vendor_items%rowtype;
  v_new vendor_items%rowtype;
  v_mapping item_mappings%rowtype;
  v_category uuid;
  v_key text;
  v_source_key text;
  v_price_changed boolean;
  v_identity_changed boolean;
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if not exists (select 1 from organization_members where organization_id=p_organization_id and user_id=auth.uid() and role in ('owner','manager')) then
    raise exception 'Owner or manager access is required for this organization';
  end if;
  if p_patch is null or jsonb_typeof(p_patch)<>'object' then raise exception 'A field patch is required'; end if;
  if exists (select 1 from jsonb_object_keys(p_patch) k where k not in ('description','brand','pack_size','price','selling_unit','category_id')) then
    raise exception 'Unsupported catalog field';
  end if;
  select * into v_old from vendor_items where id=p_vendor_item_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Vendor item is outside the requested organization'; end if;
  if p_expected_revision is null or v_old.row_revision<>p_expected_revision then
    raise exception 'This item changed since you opened it. Reload its saved values before saving your changes.';
  end if;
  select * into v_mapping from item_mappings where id=p_mapping_id and vendor_item_id=v_old.id and organization_id=p_organization_id for update;
  if not found then raise exception 'Catalog association changed; reload this row'; end if;
  perform 1 from catalog_items where id=v_mapping.catalog_item_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Catalog item is outside the requested organization'; end if;
  v_new := v_old;
  if p_patch ? 'description' then v_new.description:=btrim(p_patch->>'description'); end if;
  if nullif(v_new.description,'') is null then raise exception 'Enter a product description'; end if;
  if p_patch ? 'brand' then v_new.brand:=nullif(btrim(p_patch->>'brand'),''); end if;
  if p_patch ? 'pack_size' then v_new.pack_size:=nullif(btrim(p_patch->>'pack_size'),''); end if;
  if p_patch ? 'selling_unit' then v_new.selling_unit:=nullif(btrim(p_patch->>'selling_unit'),''); end if;
  if p_patch ? 'price' then v_new.price:=(p_patch->>'price')::numeric; end if;
  if v_new.price is not null and v_new.price<=0 then raise exception 'Enter a positive quoted amount'; end if;
  if p_price_basis is not null and p_price_basis not in ('case','each','measure') then raise exception 'Unknown price basis'; end if;
  v_price_changed:=p_patch ?| array['price','selling_unit','pack_size'];
  v_identity_changed:=v_new.description is distinct from v_old.description or v_new.brand is distinct from v_old.brand or v_new.pack_size is distinct from v_old.pack_size;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key in ('description','brand','pack_size','selling_unit') then
      v_source_key:=case v_key when 'pack_size' then 'packSize' when 'selling_unit' then 'sellingUnit' else v_key end;
      v_new.field_resolutions:=jsonb_set(v_new.field_resolutions,array[v_key],jsonb_build_object(
        'value',p_patch->v_key,'confirmedAt',now(),'confirmedBy',auth.uid(),
        'sourceValue',coalesce(v_old.field_resolutions->v_key->'sourceValue',v_old.import_row->'row'->v_source_key,to_jsonb(v_old)->v_key)));
    end if;
  end loop;
  if p_patch ? 'category_id' then
    v_category:=(p_patch->>'category_id')::uuid;
    if not exists (select 1 from catalog_categories where id=v_category and organization_id=p_organization_id) then raise exception 'Choose a category from this organization'; end if;
    update catalog_items set category_id=v_category,
      category_review=(select is_holding_pen from catalog_categories where id=v_category),category_reason=null
      where id=v_mapping.catalog_item_id and organization_id=p_organization_id;
  end if;
  if v_identity_changed then
    update item_mappings set comparison_track='review',confidence_score=null,match_method='manual' where id=v_mapping.id;
    -- A sole listing supplies its catalog label. Multi-vendor identities
    -- keep the shared label and await the existing mapping review controls.
    if v_new.description is distinct from v_old.description and not exists (
      select 1 from item_mappings where catalog_item_id=v_mapping.catalog_item_id and id<>v_mapping.id
    ) then update catalog_items set name=left(v_new.description,120) where id=v_mapping.catalog_item_id; end if;
  end if;
  update vendor_items set description=v_new.description,brand=v_new.brand,pack_size=v_new.pack_size,
    price=v_new.price,selling_unit=v_new.selling_unit,
    price_basis=case when v_price_changed then p_price_basis else price_basis end,
    price_unavailable=case when v_price_changed then not (coalesce(p_price_available,false) and coalesce(v_new.price>0,false) and v_new.selling_unit is not null and v_new.pack_size is not null and p_price_basis is not null) else price_unavailable end,
    field_resolutions=v_new.field_resolutions,import_row=case when p_patch ? 'price' then jsonb_set(jsonb_set(import_row,'{reviewRequired}','false'::jsonb),'{baseline}',coalesce(import_row->'row','{}'::jsonb)) else import_row end,row_revision=row_revision+1,
    last_updated=case when p_patch ? 'price' then now() else last_updated end
    where id=v_old.id returning * into v_new;
  if v_price_changed and not v_new.price_unavailable then
    insert into price_history(vendor_item_id,organization_id,price,source,effective_date,quote_valid_until,
      source_file_name,source_line,source_description,selling_unit,price_basis)
    values (v_new.id,p_organization_id,v_new.price,'price_list',now(),v_new.price_quote_valid_until,
      'Catalog field correction',v_old.import_row->'row'->>'sourceLine',v_new.description,v_new.selling_unit,v_new.price_basis);
  end if;
  return to_jsonb(v_new);
end;
$$;
revoke all on function public.kerdos_save_catalog_row(uuid,uuid,uuid,bigint,jsonb,text,boolean) from public;
grant execute on function public.kerdos_save_catalog_row(uuid,uuid,uuid,bigint,jsonb,text,boolean) to authenticated;

-- ============================================================
-- migration_011_document_deletion.sql
-- ============================================================

-- Delete one organization's source document and its dependent history together.
-- Current quotes from a deleted price sheet become unavailable. Associations,
-- accepted descriptions, pack sizes and prices from other sheets are retained.
create or replace function public.kerdos_delete_price_sheet(p_organization_id uuid,p_document_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_doc public.import_documents%rowtype;
  v_quotes integer;
begin
  if auth.uid() is null or not exists (
    select 1 from public.organization_members m
    where m.organization_id=p_organization_id and m.user_id=auth.uid()
      and m.role in ('owner','manager')
  ) then raise exception 'Owner or manager access is required for this organization'; end if;
  select * into v_doc from public.import_documents
  where id=p_document_id and organization_id=p_organization_id and document_kind='pricelist'
  for update;
  if not found then raise exception 'Price sheet not found for this organization'; end if;

  update public.vendor_items set price=null,price_unavailable=true,
    price_quote_valid_until=null,price_expired_at=null
  where organization_id=p_organization_id and price_source='price_list'
    and (import_row->>'sourceDocumentId')=p_document_id::text;

  delete from public.price_history
  where organization_id=p_organization_id and source_document_id=p_document_id;
  get diagnostics v_quotes=row_count;
  delete from public.import_documents
  where id=p_document_id and organization_id=p_organization_id;

  return jsonb_build_object('file_path',v_doc.file_path,'removed_quotes',v_quotes);
end;
$$;
revoke all on function public.kerdos_delete_price_sheet(uuid,uuid) from public;
grant execute on function public.kerdos_delete_price_sheet(uuid,uuid) to authenticated;

create or replace function public.kerdos_delete_invoice_record(p_organization_id uuid,p_invoice_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_invoice public.invoices%rowtype;
begin
  if auth.uid() is null or not exists (
    select 1 from public.organization_members m
    where m.organization_id=p_organization_id and m.user_id=auth.uid()
      and m.role in ('owner','manager')
  ) then raise exception 'Owner or manager access is required for this organization'; end if;
  select * into v_invoice from public.invoices
  where id=p_invoice_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Invoice not found for this organization'; end if;
  delete from public.invoice_lines where invoice_id=p_invoice_id;
  delete from public.invoices where id=p_invoice_id and organization_id=p_organization_id;
  return jsonb_build_object('file_path',v_invoice.file_path);
end;
$$;
revoke all on function public.kerdos_delete_invoice_record(uuid,uuid) from public;
grant execute on function public.kerdos_delete_invoice_record(uuid,uuid) to authenticated;

-- ============================================================
-- migration_012_vendor_nvim.sql
-- ============================================================

-- A stable, organization/vendor-scoped number only when the vendor supplied
-- no item code. The shared KERDOS catalog number remains separate.
create table if not exists public.vendor_nvim_counters (
  organization_id uuid not null,
  vendor_id uuid not null,
  last_number bigint not null check (last_number > 0),
  primary key (organization_id, vendor_id)
);
alter table public.vendor_nvim_counters enable row level security;
revoke all on public.vendor_nvim_counters from anon, authenticated;

alter table public.vendor_items add column if not exists nvim_number bigint;

-- Assign existing listings once. Their order here is deterministic; future
-- numbers are allocated by a locked, transactional counter at insertion.
with numbered as (
  select vi.id,
    row_number() over (partition by vi.organization_id, vi.vendor_id
      order by nullif(to_jsonb(vi)->>'created_at','')::timestamptz nulls last,vi.id)
      + coalesce((select max(saved.nvim_number) from public.vendor_items saved
        where saved.organization_id=vi.organization_id and saved.vendor_id=vi.vendor_id),0) as number
  from public.vendor_items vi
  where vi.nvim_number is null and nullif(btrim(vi.vendor_item_code),'') is null
)
update public.vendor_items vi set nvim_number=numbered.number
from numbered where vi.id=numbered.id;

create unique index if not exists vendor_items_nvim_unique
  on public.vendor_items(organization_id,vendor_id,nvim_number);

insert into public.vendor_nvim_counters (organization_id,vendor_id,last_number)
select organization_id,vendor_id,max(nvim_number)
from public.vendor_items group by organization_id,vendor_id
having max(nvim_number) is not null
on conflict (organization_id,vendor_id) do update
  set last_number=greatest(public.vendor_nvim_counters.last_number,excluded.last_number);

create or replace function public.kerdos_assign_vendor_nvim()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if tg_op='UPDATE' then
    if new.organization_id is distinct from old.organization_id
       or new.vendor_id is distinct from old.vendor_id then
      raise exception 'A vendor listing cannot change its organization or vendor';
    end if;
    if old.nvim_number is not null then
      if new.nvim_number is distinct from old.nvim_number then
        raise exception 'A vendor listing NVIM cannot change';
      end if;
      return new;
    end if;
  end if;
  if new.nvim_number is not null then
    raise exception 'A vendor listing NVIM is assigned by KERDOS';
  end if;
  if nullif(btrim(new.vendor_item_code),'') is not null then
    return new;
  end if;
  insert into public.vendor_nvim_counters (organization_id,vendor_id,last_number)
  values (new.organization_id,new.vendor_id,1)
  on conflict (organization_id,vendor_id) do update
    set last_number=public.vendor_nvim_counters.last_number+1
  returning last_number into new.nvim_number;
  return new;
end;
$$;

drop trigger if exists vendor_items_assign_nvim on public.vendor_items;
create trigger vendor_items_assign_nvim
before insert or update on public.vendor_items
for each row execute function public.kerdos_assign_vendor_nvim();

-- ============================================================
-- migration_013_invoice_mapping.sql
-- ============================================================

-- KERDOS 013: link both new and existing invoice vendor listings.
-- KERDOS 007: invoice header and all invoice lines are one transaction.
-- Run after migration_006_atomic_invites.sql.

create or replace function kerdos_record_invoice(p_header jsonb,p_lines jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_invoice_id uuid;
  v_line jsonb;
  v_vendor_item_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if nullif(p_header->>'organization_id','') is null or nullif(p_header->>'vendor_id','') is null then
    raise exception 'Invoice organization and vendor are required';
  end if;
  if not exists (
    select 1 from organization_members m
    where m.organization_id=(p_header->>'organization_id')::uuid
      and m.user_id=auth.uid() and m.role in ('owner','manager')
  ) then raise exception 'Owner or manager access is required for this organization'; end if;
  if not exists (
    select 1 from vendors v
    where v.id=(p_header->>'vendor_id')::uuid
      and v.organization_id=(p_header->>'organization_id')::uuid
  ) then raise exception 'Vendor is outside the requested organization'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines)=0 then
    raise exception 'An invoice requires at least one line';
  end if;

  insert into invoices(
    organization_id,vendor_id,total_amount,raw_text,invoice_date,
    invoice_number,status,file_path,file_name
  ) values (
    (p_header->>'organization_id')::uuid,(p_header->>'vendor_id')::uuid,
    (p_header->>'total_amount')::numeric,p_header->>'raw_text',
    (p_header->>'invoice_date')::date,nullif(p_header->>'invoice_number',''),
    'recorded',nullif(p_header->>'file_path',''),nullif(p_header->>'file_name','')
  ) returning id into v_invoice_id;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_vendor_item_id=nullif(v_line->>'vendor_item_id','')::uuid;
    if v_vendor_item_id is not null and not exists (
      select 1 from vendor_items vi
      where vi.id=v_vendor_item_id
        and vi.organization_id=(p_header->>'organization_id')::uuid
        and vi.vendor_id=(p_header->>'vendor_id')::uuid
    ) then raise exception 'Invoice vendor item is outside the requested organization/vendor'; end if;
    if nullif(v_line->>'catalog_item_id','') is not null and not exists (
      select 1 from catalog_items ci
      where ci.id=(v_line->>'catalog_item_id')::uuid
        and ci.organization_id=(p_header->>'organization_id')::uuid
    ) then raise exception 'Catalog item is outside the requested organization'; end if;
    if v_vendor_item_id is null and coalesce((v_line->>'create_vendor_item')::boolean,false) then
      select id into v_vendor_item_id from vendor_items
      where organization_id=(p_header->>'organization_id')::uuid
        and vendor_id=(p_header->>'vendor_id')::uuid
        and ((nullif(v_line->>'vendor_item_code','') is not null and vendor_item_code=v_line->>'vendor_item_code')
          or (nullif(v_line->>'vendor_item_code','') is null and vendor_item_code is null
            and description=v_line->>'description'
            and pack_size is not distinct from nullif(v_line->>'pack_size','')))
      limit 1;
      if v_vendor_item_id is null then
        insert into vendor_items(
        organization_id,vendor_id,vendor_item_code,description,pack_size,price,last_updated,price_source
        ) values (
          (p_header->>'organization_id')::uuid,(p_header->>'vendor_id')::uuid,
          nullif(v_line->>'vendor_item_code',''),v_line->>'description',nullif(v_line->>'pack_size',''),
          (v_line->>'unit_price')::numeric,(p_header->>'invoice_date')::date,'invoice'
        ) returning id into v_vendor_item_id;
      end if;

    end if;
    -- This also repairs an existing vendor listing that has no catalog link.
    -- Never replace a previously approved association with a new guess.
    if v_vendor_item_id is not null and nullif(v_line->>'catalog_item_id','') is not null then
      insert into item_mappings(
        organization_id,catalog_item_id,vendor_item_id,confidence_score,match_method,comparison_track
      ) values (
        (p_header->>'organization_id')::uuid,(v_line->>'catalog_item_id')::uuid,v_vendor_item_id,
        coalesce((v_line->>'catalog_confidence')::integer,0),'rule_based',
        coalesce(nullif(v_line->>'catalog_track',''),'new')
      ) on conflict do nothing;
    end if;

    insert into invoice_lines(
      invoice_id,vendor_item_id,vendor_item_code,description,unit_price,
      line_total,price_variance,match_confidence,match_method
    ) values (
      v_invoice_id,v_vendor_item_id,nullif(v_line->>'vendor_item_code',''),v_line->>'description',
      (v_line->>'unit_price')::numeric,(v_line->>'line_total')::numeric,
      nullif(v_line->>'price_variance','')::numeric,nullif(v_line->>'match_confidence','')::integer,
      nullif(v_line->>'match_method','')
    );
  end loop;

  return v_invoice_id;
end;
$$;

revoke all on function kerdos_record_invoice(jsonb,jsonb) from public;
grant execute on function kerdos_record_invoice(jsonb,jsonb) to authenticated;

-- ============================================================
-- migration_014_item_name.sql
-- ============================================================

-- Migration 014: the client's item name is theirs.
-- Item name (catalog_items.name) is the client's own word for a product;
-- vendor description is what one vendor calls it. Saving a corrected
-- vendor description may still label a brand-new sole-vendor item, but it
-- never overwrites a name the client typed. Replaces kerdos_save_catalog_row.

-- Save one row, its category, and any changed price together. A rejected
-- write rolls back all of them. Optimistic revision prevents lost updates.
create or replace function public.kerdos_save_catalog_row(
  p_organization_id uuid, p_vendor_item_id uuid, p_mapping_id uuid,
  p_expected_revision bigint, p_patch jsonb, p_price_basis text,
  p_price_available boolean
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_old vendor_items%rowtype;
  v_new vendor_items%rowtype;
  v_mapping item_mappings%rowtype;
  v_category uuid;
  v_key text;
  v_source_key text;
  v_price_changed boolean;
  v_identity_changed boolean;
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if not exists (select 1 from organization_members where organization_id=p_organization_id and user_id=auth.uid() and role in ('owner','manager')) then
    raise exception 'Owner or manager access is required for this organization';
  end if;
  if p_patch is null or jsonb_typeof(p_patch)<>'object' then raise exception 'A field patch is required'; end if;
  if exists (select 1 from jsonb_object_keys(p_patch) k where k not in ('description','brand','pack_size','price','selling_unit','category_id')) then
    raise exception 'Unsupported catalog field';
  end if;
  select * into v_old from vendor_items where id=p_vendor_item_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Vendor item is outside the requested organization'; end if;
  if p_expected_revision is null or v_old.row_revision<>p_expected_revision then
    raise exception 'This item changed since you opened it. Reload its saved values before saving your changes.';
  end if;
  select * into v_mapping from item_mappings where id=p_mapping_id and vendor_item_id=v_old.id and organization_id=p_organization_id for update;
  if not found then raise exception 'Catalog association changed; reload this row'; end if;
  perform 1 from catalog_items where id=v_mapping.catalog_item_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Catalog item is outside the requested organization'; end if;
  v_new := v_old;
  if p_patch ? 'description' then v_new.description:=btrim(p_patch->>'description'); end if;
  if nullif(v_new.description,'') is null then raise exception 'Enter a product description'; end if;
  if p_patch ? 'brand' then v_new.brand:=nullif(btrim(p_patch->>'brand'),''); end if;
  if p_patch ? 'pack_size' then v_new.pack_size:=nullif(btrim(p_patch->>'pack_size'),''); end if;
  if p_patch ? 'selling_unit' then v_new.selling_unit:=nullif(btrim(p_patch->>'selling_unit'),''); end if;
  if p_patch ? 'price' then v_new.price:=(p_patch->>'price')::numeric; end if;
  if v_new.price is not null and v_new.price<=0 then raise exception 'Enter a positive quoted amount'; end if;
  if p_price_basis is not null and p_price_basis not in ('case','each','measure') then raise exception 'Unknown price basis'; end if;
  v_price_changed:=p_patch ?| array['price','selling_unit','pack_size'];
  v_identity_changed:=v_new.description is distinct from v_old.description or v_new.brand is distinct from v_old.brand or v_new.pack_size is distinct from v_old.pack_size;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key in ('description','brand','pack_size','selling_unit') then
      v_source_key:=case v_key when 'pack_size' then 'packSize' when 'selling_unit' then 'sellingUnit' else v_key end;
      v_new.field_resolutions:=jsonb_set(v_new.field_resolutions,array[v_key],jsonb_build_object(
        'value',p_patch->v_key,'confirmedAt',now(),'confirmedBy',auth.uid(),
        'sourceValue',coalesce(v_old.field_resolutions->v_key->'sourceValue',v_old.import_row->'row'->v_source_key,to_jsonb(v_old)->v_key)));
    end if;
  end loop;
  if p_patch ? 'category_id' then
    v_category:=(p_patch->>'category_id')::uuid;
    if not exists (select 1 from catalog_categories where id=v_category and organization_id=p_organization_id) then raise exception 'Choose a category from this organization'; end if;
    update catalog_items set category_id=v_category,
      category_review=(select is_holding_pen from catalog_categories where id=v_category),category_reason=null
      where id=v_mapping.catalog_item_id and organization_id=p_organization_id;
  end if;
  if v_identity_changed then
    update item_mappings set comparison_track='review',confidence_score=null,match_method='manual' where id=v_mapping.id;
    -- A sole listing supplies its catalog label ONLY while that label is
    -- still the vendor's wording. A name the client set stays theirs.
    if v_new.description is distinct from v_old.description and not exists (
      select 1 from item_mappings where catalog_item_id=v_mapping.catalog_item_id and id<>v_mapping.id
    ) then update catalog_items set name=left(v_new.description,120)
         where id=v_mapping.catalog_item_id and (name is null or name=left(v_old.description,120)); end if;
  end if;
  update vendor_items set description=v_new.description,brand=v_new.brand,pack_size=v_new.pack_size,
    price=v_new.price,selling_unit=v_new.selling_unit,
    price_basis=case when v_price_changed then p_price_basis else price_basis end,
    price_unavailable=case when v_price_changed then not (coalesce(p_price_available,false) and coalesce(v_new.price>0,false) and v_new.selling_unit is not null and v_new.pack_size is not null and p_price_basis is not null) else price_unavailable end,
    field_resolutions=v_new.field_resolutions,import_row=case when p_patch ? 'price' then jsonb_set(jsonb_set(import_row,'{reviewRequired}','false'::jsonb),'{baseline}',coalesce(import_row->'row','{}'::jsonb)) else import_row end,row_revision=row_revision+1,
    last_updated=case when p_patch ? 'price' then now() else last_updated end
    where id=v_old.id returning * into v_new;
  if v_price_changed and not v_new.price_unavailable then
    insert into price_history(vendor_item_id,organization_id,price,source,effective_date,quote_valid_until,
      source_file_name,source_line,source_description,selling_unit,price_basis)
    values (v_new.id,p_organization_id,v_new.price,'price_list',now(),v_new.price_quote_valid_until,
      'Catalog field correction',v_old.import_row->'row'->>'sourceLine',v_new.description,v_new.selling_unit,v_new.price_basis);
  end if;
  return to_jsonb(v_new);
end;
$$;
revoke all on function public.kerdos_save_catalog_row(uuid,uuid,uuid,bigint,jsonb,text,boolean) from public;
grant execute on function public.kerdos_save_catalog_row(uuid,uuid,uuid,bigint,jsonb,text,boolean) to authenticated;

-- ============================================================
-- migration_015_recoverable_imports.sql
-- ============================================================

-- Migration 015: recoverable imports and one-write corrections.
-- 1. kerdos_apply_price_quote takes the brand (no separate write) and
--    records a quote once per source document, so a resumed or repeated
--    import never duplicates price history.
-- 2. kerdos_save_catalog_row accepts item_name, so a row correction and
--    the client's item name land in the same transaction.
-- 3. import_documents.completed_keys records which rows finished, so a
--    partial import can resume from where it stopped.

alter table import_documents add column if not exists completed_keys jsonb not null default '[]'::jsonb;
alter table price_history add column if not exists source_row_key text;
create unique index if not exists price_history_document_row_once
  on price_history(source_document_id,source_row_key) where source_row_key is not null;

-- Replace the old quote overload; new arguments default for older clients.
drop function if exists public.kerdos_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid,text,text,text,text,jsonb,jsonb);
create or replace function kerdos_apply_price_quote(
  p_vendor_item_id uuid,
  p_organization_id uuid,
  p_vendor_id uuid,
  p_vendor_item_code text,
  p_description text,
  p_pack_size text,
  p_price numeric,
  p_price_unavailable boolean,
  p_effective_date timestamptz,
  p_quote_valid_until date,
  p_source_file_path text,
  p_source_file_name text,
  p_source_line text,
  p_source_document_id uuid,
  p_selling_unit text default null,
  p_price_basis text default null,
  p_gtin text default null,
  p_manufacturer_code text default null,
  p_import_row jsonb default null,
  p_field_resolutions jsonb default null,
  p_brand text default null
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_item_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if not exists (
    select 1 from organization_members m
    where m.organization_id=p_organization_id and m.user_id=auth.uid()
      and m.role in ('owner','manager')
  ) then raise exception 'Owner or manager access is required for this organization'; end if;
  if not exists (
    select 1 from vendors v where v.id=p_vendor_id and v.organization_id=p_organization_id
  ) then raise exception 'Vendor is outside the requested organization'; end if;
  if p_source_document_id is not null and not exists (
    select 1 from import_documents d
    where d.id=p_source_document_id and d.organization_id=p_organization_id and d.vendor_id=p_vendor_id
  ) then raise exception 'Source document is outside the requested organization/vendor'; end if;
  if p_effective_date is null then raise exception 'A price quotation requires an effective date'; end if;
  if p_price_unavailable is not true and (p_price is null or p_price <= 0) then
    raise exception 'A current quotation requires a positive price';
  end if;
  if p_price_basis is not null and p_price_basis not in ('case','each','measure') then
    raise exception 'Price basis must be case, each or measure';
  end if;

  if p_vendor_item_id is null then
    insert into vendor_items(
      organization_id,vendor_id,vendor_item_code,description,pack_size,price,
      last_updated,price_source,price_unavailable,price_expired_at,price_quote_valid_until,
      selling_unit,price_basis,gtin,manufacturer_code,import_row,field_resolutions,brand
    ) values (
      p_organization_id,p_vendor_id,p_vendor_item_code,p_description,p_pack_size,p_price,
      p_effective_date,'price_list',p_price_unavailable or p_pack_size is null,null,p_quote_valid_until,
      p_selling_unit,p_price_basis,p_gtin,p_manufacturer_code,coalesce(p_import_row,'{}'::jsonb),coalesce(p_field_resolutions,'{}'::jsonb),p_brand
    ) returning id into v_item_id;
  else
    update vendor_items set
      price=case when p_price_unavailable then price else p_price end,
      pack_size=coalesce(p_pack_size,pack_size),
      last_updated=p_effective_date,
      price_source='price_list',
      price_unavailable=p_price_unavailable or coalesce(p_pack_size,pack_size) is null,
      price_expired_at=null,
      price_quote_valid_until=p_quote_valid_until,
      selling_unit=case when p_price_unavailable then selling_unit else p_selling_unit end,
      price_basis=case when p_price_unavailable then price_basis else p_price_basis end,
      gtin=coalesce(p_gtin,gtin),
      manufacturer_code=coalesce(p_manufacturer_code,manufacturer_code),
      import_row=coalesce(p_import_row,import_row),
      field_resolutions=coalesce(p_field_resolutions,field_resolutions),
      brand=coalesce(p_brand,brand),
      row_revision=row_revision+1
    where id=p_vendor_item_id
      and organization_id=p_organization_id
      and vendor_id=p_vendor_id
    returning id into v_item_id;
    if v_item_id is null then raise exception 'Vendor item is outside the requested organization/vendor'; end if;
  end if;

  -- The fingerprinted document and its original row ordinal uniquely
  -- identify this quote. A retry cannot append another history entry.
  if not p_price_unavailable and not exists (
    select 1 from price_history h where h.source_row_key is null
      and h.vendor_item_id=v_item_id and h.source_document_id=p_source_document_id
      and (p_import_row->>'rowKey' is null or
           (p_source_line is not null and h.source_line=p_source_line)) and h.price=p_price
  ) then
    insert into price_history(
      vendor_item_id,organization_id,price,source,effective_date,quote_valid_until,
      source_file_path,source_file_name,source_description,source_line,source_document_id,
      selling_unit,price_basis,source_row_key
    ) values (
      v_item_id,p_organization_id,p_price,'price_list',p_effective_date,p_quote_valid_until,
      p_source_file_path,p_source_file_name,p_description,p_source_line,p_source_document_id,
      p_selling_unit,p_price_basis,p_import_row->>'rowKey'
    ) on conflict (source_document_id,source_row_key) where source_row_key is not null do nothing;
  end if;
  return v_item_id;
end;
$$;

revoke all on function kerdos_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid,text,text,text,text,jsonb,jsonb,text) from public;
grant execute on function kerdos_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid,text,text,text,text,jsonb,jsonb,text) to authenticated;


-- Save one row, its category, and any changed price together. A rejected
-- write rolls back all of them. Optimistic revision prevents lost updates.
create or replace function public.kerdos_save_catalog_row(
  p_organization_id uuid, p_vendor_item_id uuid, p_mapping_id uuid,
  p_expected_revision bigint, p_patch jsonb, p_price_basis text,
  p_price_available boolean
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_old vendor_items%rowtype;
  v_new vendor_items%rowtype;
  v_mapping item_mappings%rowtype;
  v_category uuid;
  v_key text;
  v_source_key text;
  v_price_changed boolean;
  v_identity_changed boolean;
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if not exists (select 1 from organization_members where organization_id=p_organization_id and user_id=auth.uid() and role in ('owner','manager')) then
    raise exception 'Owner or manager access is required for this organization';
  end if;
  if p_patch is null or jsonb_typeof(p_patch)<>'object' then raise exception 'A field patch is required'; end if;
  if exists (select 1 from jsonb_object_keys(p_patch) k where k not in ('description','brand','pack_size','price','selling_unit','category_id','item_name')) then
    raise exception 'Unsupported catalog field';
  end if;
  select * into v_old from vendor_items where id=p_vendor_item_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Vendor item is outside the requested organization'; end if;
  if p_expected_revision is null or v_old.row_revision<>p_expected_revision then
    raise exception 'This item changed since you opened it. Reload its saved values before saving your changes.';
  end if;
  select * into v_mapping from item_mappings where id=p_mapping_id and vendor_item_id=v_old.id and organization_id=p_organization_id for update;
  if not found then raise exception 'Catalog association changed; reload this row'; end if;
  perform 1 from catalog_items where id=v_mapping.catalog_item_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Catalog item is outside the requested organization'; end if;
  v_new := v_old;
  if p_patch ? 'description' then v_new.description:=btrim(p_patch->>'description'); end if;
  if nullif(v_new.description,'') is null then raise exception 'Enter a product description'; end if;
  if p_patch ? 'brand' then v_new.brand:=nullif(btrim(p_patch->>'brand'),''); end if;
  if p_patch ? 'pack_size' then v_new.pack_size:=nullif(btrim(p_patch->>'pack_size'),''); end if;
  if p_patch ? 'selling_unit' then v_new.selling_unit:=nullif(btrim(p_patch->>'selling_unit'),''); end if;
  if p_patch ? 'price' then v_new.price:=(p_patch->>'price')::numeric; end if;
  if v_new.price is not null and v_new.price<=0 then raise exception 'Enter a positive quoted amount'; end if;
  if p_price_basis is not null and p_price_basis not in ('case','each','measure') then raise exception 'Unknown price basis'; end if;
  v_price_changed:=p_patch ?| array['price','selling_unit','pack_size'];
  v_identity_changed:=v_new.description is distinct from v_old.description or v_new.brand is distinct from v_old.brand or v_new.pack_size is distinct from v_old.pack_size;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key in ('description','brand','pack_size','selling_unit') then
      v_source_key:=case v_key when 'pack_size' then 'packSize' when 'selling_unit' then 'sellingUnit' else v_key end;
      v_new.field_resolutions:=jsonb_set(v_new.field_resolutions,array[v_key],jsonb_build_object(
        'value',p_patch->v_key,'confirmedAt',now(),'confirmedBy',auth.uid(),
        'sourceValue',coalesce(v_old.field_resolutions->v_key->'sourceValue',v_old.import_row->'row'->v_source_key,to_jsonb(v_old)->v_key)));
    end if;
  end loop;
  -- The client's item name, saved in the same write as the row.
  if p_patch ? 'item_name' then
    if nullif(btrim(p_patch->>'item_name'),'') is null then raise exception 'Enter an item name'; end if;
    update catalog_items set name=left(btrim(p_patch->>'item_name'),120) where id=v_mapping.catalog_item_id and organization_id=p_organization_id;
  end if;
  if p_patch ? 'category_id' then
    v_category:=(p_patch->>'category_id')::uuid;
    if not exists (select 1 from catalog_categories where id=v_category and organization_id=p_organization_id) then raise exception 'Choose a category from this organization'; end if;
    update catalog_items set category_id=v_category,
      category_review=(select is_holding_pen from catalog_categories where id=v_category),category_reason=null
      where id=v_mapping.catalog_item_id and organization_id=p_organization_id;
  end if;
  if v_identity_changed then
    update item_mappings set comparison_track='review',confidence_score=null,match_method='manual' where id=v_mapping.id;
    -- A sole listing supplies its catalog label ONLY while that label is
    -- still the vendor's wording. A name the client set stays theirs.
    if v_new.description is distinct from v_old.description and not exists (
      select 1 from item_mappings where catalog_item_id=v_mapping.catalog_item_id and id<>v_mapping.id
    ) and not (p_patch ? 'item_name') then update catalog_items set name=left(v_new.description,120)
         where id=v_mapping.catalog_item_id and (name is null or name=left(v_old.description,120)); end if;
  end if;
  update vendor_items set description=v_new.description,brand=v_new.brand,pack_size=v_new.pack_size,
    price=v_new.price,selling_unit=v_new.selling_unit,
    price_basis=case when v_price_changed then p_price_basis else price_basis end,
    price_unavailable=case when v_price_changed then not (coalesce(p_price_available,false) and coalesce(v_new.price>0,false) and v_new.selling_unit is not null and v_new.pack_size is not null and p_price_basis is not null) else price_unavailable end,
    field_resolutions=v_new.field_resolutions,import_row=case when p_patch ? 'price' then jsonb_set(jsonb_set(import_row,'{reviewRequired}','false'::jsonb),'{baseline}',coalesce(import_row->'row','{}'::jsonb)) else import_row end,row_revision=row_revision+1,
    last_updated=case when p_patch ? 'price' then now() else last_updated end
    where id=v_old.id returning * into v_new;
  if v_price_changed and not v_new.price_unavailable then
    insert into price_history(vendor_item_id,organization_id,price,source,effective_date,quote_valid_until,
      source_file_name,source_line,source_description,selling_unit,price_basis)
    values (v_new.id,p_organization_id,v_new.price,'price_list',now(),v_new.price_quote_valid_until,
      'Catalog field correction',v_old.import_row->'row'->>'sourceLine',v_new.description,v_new.selling_unit,v_new.price_basis);
  end if;
  return to_jsonb(v_new);
end;
$$;
revoke all on function public.kerdos_save_catalog_row(uuid,uuid,uuid,bigint,jsonb,text,boolean) from public;
grant execute on function public.kerdos_save_catalog_row(uuid,uuid,uuid,bigint,jsonb,text,boolean) to authenticated;

-- ============================================================
-- migration_016_manual_catalog_association.sql
-- ============================================================

-- Save a manual association and row corrections atomically.
-- Manual links are reviewable; entry alone does not prove accuracy.
create or replace function public.kerdos_save_catalog_row(
  p_organization_id uuid, p_vendor_item_id uuid, p_mapping_id uuid,
  p_expected_revision bigint, p_patch jsonb, p_price_basis text,
  p_price_available boolean
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_old vendor_items%rowtype;
  v_new vendor_items%rowtype;
  v_mapping item_mappings%rowtype;
  v_category uuid;
  v_target uuid;
  v_relinked boolean := false;
  v_key text;
  v_source_key text;
  v_price_changed boolean;
  v_identity_changed boolean;
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if not exists (select 1 from organization_members where organization_id=p_organization_id and user_id=auth.uid() and role in ('owner','manager')) then
    raise exception 'Owner or manager access is required for this organization';
  end if;
  if p_patch is null or jsonb_typeof(p_patch)<>'object' then raise exception 'A field patch is required'; end if;
  if exists (select 1 from jsonb_object_keys(p_patch) k where k not in ('description','brand','pack_size','price','selling_unit','category_id','item_name','catalog_item_id')) then
    raise exception 'Unsupported catalog field';
  end if;
  select * into v_old from vendor_items where id=p_vendor_item_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Vendor item is outside the requested organization'; end if;
  if p_expected_revision is null or v_old.row_revision<>p_expected_revision then
    raise exception 'This item changed since you opened it. Reload its saved values before saving your changes.';
  end if;
  select * into v_mapping from item_mappings where id=p_mapping_id and vendor_item_id=v_old.id and organization_id=p_organization_id for update;
  if not found then raise exception 'Catalog association changed; reload this row'; end if;
  perform 1 from catalog_items where id=v_mapping.catalog_item_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Catalog item is outside the requested organization'; end if;
  if p_patch ? 'catalog_item_id' then
    if p_patch ?| array['category_id','item_name'] then
      raise exception 'Save item name/category changes separately from an association change';
    end if;
    v_target := (p_patch->>'catalog_item_id')::uuid;
    perform 1 from catalog_items where id=v_target and organization_id=p_organization_id for update;
    if not found then raise exception 'Destination catalog item is outside the requested organization'; end if;
    v_relinked := v_target is distinct from v_mapping.catalog_item_id;
    if v_relinked then
      update item_mappings set catalog_item_id=v_target,comparison_track='review',confidence_score=null,match_method='manual'
        where id=v_mapping.id and organization_id=p_organization_id;
      v_mapping.catalog_item_id := v_target;
    end if;
  end if;
  v_new := v_old;
  if p_patch ? 'description' then v_new.description:=btrim(p_patch->>'description'); end if;
  if nullif(v_new.description,'') is null then raise exception 'Enter a product description'; end if;
  if p_patch ? 'brand' then v_new.brand:=nullif(btrim(p_patch->>'brand'),''); end if;
  if p_patch ? 'pack_size' then v_new.pack_size:=nullif(btrim(p_patch->>'pack_size'),''); end if;
  if p_patch ? 'selling_unit' then v_new.selling_unit:=nullif(btrim(p_patch->>'selling_unit'),''); end if;
  if p_patch ? 'price' then v_new.price:=(p_patch->>'price')::numeric; end if;
  if v_new.price is not null and v_new.price<=0 then raise exception 'Enter a positive quoted amount'; end if;
  if p_price_basis is not null and p_price_basis not in ('case','each','measure') then raise exception 'Unknown price basis'; end if;
  v_price_changed:=p_patch ?| array['price','selling_unit','pack_size'];
  v_identity_changed:=v_new.description is distinct from v_old.description or v_new.brand is distinct from v_old.brand or v_new.pack_size is distinct from v_old.pack_size;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key in ('description','brand','pack_size','selling_unit') then
      v_source_key:=case v_key when 'pack_size' then 'packSize' when 'selling_unit' then 'sellingUnit' else v_key end;
      v_new.field_resolutions:=jsonb_set(v_new.field_resolutions,array[v_key],jsonb_build_object(
        'value',p_patch->v_key,'confirmedAt',now(),'confirmedBy',auth.uid(),
        'sourceValue',coalesce(v_old.field_resolutions->v_key->'sourceValue',v_old.import_row->'row'->v_source_key,to_jsonb(v_old)->v_key)));
    end if;
  end loop;
  -- The client's item name, saved in the same write as the row.
  if p_patch ? 'item_name' then
    if nullif(btrim(p_patch->>'item_name'),'') is null then raise exception 'Enter an item name'; end if;
    update catalog_items set name=left(btrim(p_patch->>'item_name'),120) where id=v_mapping.catalog_item_id and organization_id=p_organization_id;
  end if;
  if p_patch ? 'category_id' then
    v_category:=(p_patch->>'category_id')::uuid;
    if not exists (select 1 from catalog_categories where id=v_category and organization_id=p_organization_id) then raise exception 'Choose a category from this organization'; end if;
    update catalog_items set category_id=v_category,
      category_review=(select is_holding_pen from catalog_categories where id=v_category),category_reason=null
      where id=v_mapping.catalog_item_id and organization_id=p_organization_id;
  end if;
  if v_identity_changed or v_relinked then
    update item_mappings set comparison_track='review',confidence_score=null,match_method='manual' where id=v_mapping.id;
    -- A sole listing supplies its catalog label ONLY while that label is
    -- still the vendor's wording. A name the client set stays theirs.
    if not v_relinked and v_new.description is distinct from v_old.description and not exists (
      select 1 from item_mappings where catalog_item_id=v_mapping.catalog_item_id and id<>v_mapping.id
    ) and not (p_patch ? 'item_name') then update catalog_items set name=left(v_new.description,120)
         where id=v_mapping.catalog_item_id and (name is null or name=left(v_old.description,120)); end if;
  end if;
  update vendor_items set description=v_new.description,brand=v_new.brand,pack_size=v_new.pack_size,
    price=v_new.price,selling_unit=v_new.selling_unit,
    price_basis=case when v_price_changed then p_price_basis else price_basis end,
    price_unavailable=case when v_price_changed then not (coalesce(p_price_available,false) and coalesce(v_new.price>0,false) and v_new.selling_unit is not null and v_new.pack_size is not null and p_price_basis is not null) else price_unavailable end,
    field_resolutions=v_new.field_resolutions,import_row=case when p_patch ? 'price' then jsonb_set(jsonb_set(import_row,'{reviewRequired}','false'::jsonb),'{baseline}',coalesce(import_row->'row','{}'::jsonb)) else import_row end,row_revision=row_revision+1,
    last_updated=case when p_patch ? 'price' then now() else last_updated end
    where id=v_old.id returning * into v_new;
  if v_price_changed and not v_new.price_unavailable then
    insert into price_history(vendor_item_id,organization_id,price,source,effective_date,quote_valid_until,
      source_file_name,source_line,source_description,selling_unit,price_basis)
    values (v_new.id,p_organization_id,v_new.price,'price_list',now(),v_new.price_quote_valid_until,
      'Catalog field correction',v_old.import_row->'row'->>'sourceLine',v_new.description,v_new.selling_unit,v_new.price_basis);
  end if;
  return to_jsonb(v_new);
end;
$$;
revoke all on function public.kerdos_save_catalog_row(uuid,uuid,uuid,bigint,jsonb,text,boolean) from public;
grant execute on function public.kerdos_save_catalog_row(uuid,uuid,uuid,bigint,jsonb,text,boolean) to authenticated;

-- ============================================================
-- migration_017_unit_cost_display.sql
-- ============================================================

-- Persist display-unit preference without changing the vendor quotation.
alter table public.vendor_items add column if not exists unit_cost_unit text;
create or replace function public.kerdos_save_catalog_row(
  p_organization_id uuid, p_vendor_item_id uuid, p_mapping_id uuid,
  p_expected_revision bigint, p_patch jsonb, p_price_basis text,
  p_price_available boolean
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_old vendor_items%rowtype;
  v_new vendor_items%rowtype;
  v_mapping item_mappings%rowtype;
  v_category uuid;
  v_target uuid;
  v_relinked boolean := false;
  v_key text;
  v_source_key text;
  v_price_changed boolean;
  v_identity_changed boolean;
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if not exists (select 1 from organization_members where organization_id=p_organization_id and user_id=auth.uid() and role in ('owner','manager')) then
    raise exception 'Owner or manager access is required for this organization';
  end if;
  if p_patch is null or jsonb_typeof(p_patch)<>'object' then raise exception 'A field patch is required'; end if;
  if exists (select 1 from jsonb_object_keys(p_patch) k where k not in ('description','brand','pack_size','price','selling_unit','category_id','item_name','catalog_item_id','unit_cost_unit')) then
    raise exception 'Unsupported catalog field';
  end if;
  select * into v_old from vendor_items where id=p_vendor_item_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Vendor item is outside the requested organization'; end if;
  if p_expected_revision is null or v_old.row_revision<>p_expected_revision then
    raise exception 'This item changed since you opened it. Reload its saved values before saving your changes.';
  end if;
  select * into v_mapping from item_mappings where id=p_mapping_id and vendor_item_id=v_old.id and organization_id=p_organization_id for update;
  if not found then raise exception 'Catalog association changed; reload this row'; end if;
  perform 1 from catalog_items where id=v_mapping.catalog_item_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Catalog item is outside the requested organization'; end if;
  if p_patch ? 'catalog_item_id' then
    if p_patch ?| array['category_id','item_name'] then
      raise exception 'Save item name/category changes separately from an association change';
    end if;
    v_target := (p_patch->>'catalog_item_id')::uuid;
    perform 1 from catalog_items where id=v_target and organization_id=p_organization_id for update;
    if not found then raise exception 'Destination catalog item is outside the requested organization'; end if;
    v_relinked := v_target is distinct from v_mapping.catalog_item_id;
    if v_relinked then
      update item_mappings set catalog_item_id=v_target,comparison_track='review',confidence_score=null,match_method='manual'
        where id=v_mapping.id and organization_id=p_organization_id;
      v_mapping.catalog_item_id := v_target;
    end if;
  end if;
  v_new := v_old;
  if p_patch ? 'description' then v_new.description:=btrim(p_patch->>'description'); end if;
  if nullif(v_new.description,'') is null then raise exception 'Enter a product description'; end if;
  if p_patch ? 'brand' then v_new.brand:=nullif(btrim(p_patch->>'brand'),''); end if;
  if p_patch ? 'pack_size' then v_new.pack_size:=nullif(btrim(p_patch->>'pack_size'),''); end if;
  if p_patch ? 'selling_unit' then v_new.selling_unit:=nullif(btrim(p_patch->>'selling_unit'),''); end if;
  if p_patch ? 'unit_cost_unit' then v_new.unit_cost_unit:=nullif(btrim(p_patch->>'unit_cost_unit'),''); end if;
  if p_patch ? 'price' then v_new.price:=(p_patch->>'price')::numeric; end if;
  if v_new.price is not null and v_new.price<=0 then raise exception 'Enter a positive quoted amount'; end if;
  if p_price_basis is not null and p_price_basis not in ('case','each','measure') then raise exception 'Unknown price basis'; end if;
  v_price_changed:=p_patch ?| array['price','selling_unit','pack_size'];
  v_identity_changed:=v_new.description is distinct from v_old.description or v_new.brand is distinct from v_old.brand or v_new.pack_size is distinct from v_old.pack_size;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key in ('description','brand','pack_size','selling_unit') then
      v_source_key:=case v_key when 'pack_size' then 'packSize' when 'selling_unit' then 'sellingUnit' else v_key end;
      v_new.field_resolutions:=jsonb_set(v_new.field_resolutions,array[v_key],jsonb_build_object(
        'value',p_patch->v_key,'confirmedAt',now(),'confirmedBy',auth.uid(),
        'sourceValue',coalesce(v_old.field_resolutions->v_key->'sourceValue',v_old.import_row->'row'->v_source_key,to_jsonb(v_old)->v_key)));
    end if;
  end loop;
  -- The client's item name, saved in the same write as the row.
  if p_patch ? 'item_name' then
    if nullif(btrim(p_patch->>'item_name'),'') is null then raise exception 'Enter an item name'; end if;
    update catalog_items set name=left(btrim(p_patch->>'item_name'),120) where id=v_mapping.catalog_item_id and organization_id=p_organization_id;
  end if;
  if p_patch ? 'category_id' then
    v_category:=(p_patch->>'category_id')::uuid;
    if not exists (select 1 from catalog_categories where id=v_category and organization_id=p_organization_id) then raise exception 'Choose a category from this organization'; end if;
    update catalog_items set category_id=v_category,
      category_review=(select is_holding_pen from catalog_categories where id=v_category),category_reason=null
      where id=v_mapping.catalog_item_id and organization_id=p_organization_id;
  end if;
  if v_identity_changed or v_relinked then
    update item_mappings set comparison_track='review',confidence_score=null,match_method='manual' where id=v_mapping.id;
    -- A sole listing supplies its catalog label ONLY while that label is
    -- still the vendor's wording. A name the client set stays theirs.
    if not v_relinked and v_new.description is distinct from v_old.description and not exists (
      select 1 from item_mappings where catalog_item_id=v_mapping.catalog_item_id and id<>v_mapping.id
    ) and not (p_patch ? 'item_name') then update catalog_items set name=left(v_new.description,120)
         where id=v_mapping.catalog_item_id and (name is null or name=left(v_old.description,120)); end if;
  end if;
  update vendor_items set description=v_new.description,brand=v_new.brand,pack_size=v_new.pack_size,
    price=v_new.price,selling_unit=v_new.selling_unit,unit_cost_unit=v_new.unit_cost_unit,
    price_basis=case when v_price_changed then p_price_basis else price_basis end,
    price_unavailable=case when v_price_changed then not (coalesce(p_price_available,false) and coalesce(v_new.price>0,false) and v_new.selling_unit is not null and v_new.pack_size is not null and p_price_basis is not null) else price_unavailable end,
    field_resolutions=v_new.field_resolutions,import_row=case when p_patch ? 'price' then jsonb_set(jsonb_set(import_row,'{reviewRequired}','false'::jsonb),'{baseline}',coalesce(import_row->'row','{}'::jsonb)) else import_row end,row_revision=row_revision+1,
    last_updated=case when p_patch ? 'price' then now() else last_updated end
    where id=v_old.id returning * into v_new;
  if v_price_changed and not v_new.price_unavailable then
    insert into price_history(vendor_item_id,organization_id,price,source,effective_date,quote_valid_until,
      source_file_name,source_line,source_description,selling_unit,price_basis)
    values (v_new.id,p_organization_id,v_new.price,'price_list',now(),v_new.price_quote_valid_until,
      'Catalog field correction',v_old.import_row->'row'->>'sourceLine',v_new.description,v_new.selling_unit,v_new.price_basis);
  end if;
  return to_jsonb(v_new);
end;
$$;
revoke all on function public.kerdos_save_catalog_row(uuid,uuid,uuid,bigint,jsonb,text,boolean) from public;
grant execute on function public.kerdos_save_catalog_row(uuid,uuid,uuid,bigint,jsonb,text,boolean) to authenticated;

-- ============================================================
-- migration_018_field_review.sql
-- ============================================================

-- Persist each field confirmation and resolve source reviews field by field.
-- No data is deleted; original rows and conflict notes remain available.
alter table public.vendor_items add column if not exists unit_cost_unit text;
create or replace function public.kerdos_save_catalog_row(
  p_organization_id uuid, p_vendor_item_id uuid, p_mapping_id uuid,
  p_expected_revision bigint, p_patch jsonb, p_price_basis text,
  p_price_available boolean
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_old vendor_items%rowtype;
  v_new vendor_items%rowtype;
  v_mapping item_mappings%rowtype;
  v_category uuid;
  v_target uuid;
  v_relinked boolean := false;
  v_key text;
  v_source_key text;
  v_price_changed boolean;
  v_identity_changed boolean;
  v_review_fields text[] := array[]::text[];
  v_reason text;
  v_field text;
  v_review jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if not exists (select 1 from organization_members where organization_id=p_organization_id and user_id=auth.uid() and role in ('owner','manager')) then
    raise exception 'Owner or manager access is required for this organization';
  end if;
  if p_patch is null or jsonb_typeof(p_patch)<>'object' then raise exception 'A field patch is required'; end if;
  if exists (select 1 from jsonb_object_keys(p_patch) k where k not in ('description','brand','pack_size','price','selling_unit','category_id','item_name','catalog_item_id','unit_cost_unit')) then
    raise exception 'Unsupported catalog field';
  end if;
  select * into v_old from vendor_items where id=p_vendor_item_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Vendor item is outside the requested organization'; end if;
  if p_expected_revision is null or v_old.row_revision<>p_expected_revision then
    raise exception 'This item changed since you opened it. Reload its saved values before saving your changes.';
  end if;
  select * into v_mapping from item_mappings where id=p_mapping_id and vendor_item_id=v_old.id and organization_id=p_organization_id for update;
  if not found then raise exception 'Catalog association changed; reload this row'; end if;
  perform 1 from catalog_items where id=v_mapping.catalog_item_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Catalog item is outside the requested organization'; end if;
  if p_patch ? 'catalog_item_id' then
    if p_patch ?| array['category_id','item_name'] then
      raise exception 'Save item name/category changes separately from an association change';
    end if;
    v_target := (p_patch->>'catalog_item_id')::uuid;
    perform 1 from catalog_items where id=v_target and organization_id=p_organization_id for update;
    if not found then raise exception 'Destination catalog item is outside the requested organization'; end if;
    v_relinked := v_target is distinct from v_mapping.catalog_item_id;
    if v_relinked then
      update item_mappings set catalog_item_id=v_target,comparison_track='review',confidence_score=null,match_method='manual'
        where id=v_mapping.id and organization_id=p_organization_id;
      v_mapping.catalog_item_id := v_target;
    end if;
  end if;
  v_new := v_old;
  if p_patch ? 'description' then v_new.description:=btrim(p_patch->>'description'); end if;
  if nullif(v_new.description,'') is null then raise exception 'Enter a product description'; end if;
  if p_patch ? 'brand' then v_new.brand:=nullif(btrim(p_patch->>'brand'),''); end if;
  if p_patch ? 'pack_size' then v_new.pack_size:=nullif(btrim(p_patch->>'pack_size'),''); end if;
  if p_patch ? 'selling_unit' then v_new.selling_unit:=nullif(btrim(p_patch->>'selling_unit'),''); end if;
  if p_patch ? 'unit_cost_unit' then v_new.unit_cost_unit:=nullif(btrim(p_patch->>'unit_cost_unit'),''); end if;
  if p_patch ? 'price' then v_new.price:=(p_patch->>'price')::numeric; end if;
  if v_new.price is not null and v_new.price<=0 then raise exception 'Enter a positive quoted amount'; end if;
  if p_price_basis is not null and p_price_basis not in ('case','each','measure') then raise exception 'Unknown price basis'; end if;
  v_price_changed:=p_patch ?| array['price','selling_unit','pack_size'];
  v_identity_changed:=v_new.description is distinct from v_old.description or v_new.brand is distinct from v_old.brand or v_new.pack_size is distinct from v_old.pack_size;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key in ('description','brand','pack_size','selling_unit','price','category_id','item_name','catalog_item_id') then
      v_source_key:=case v_key when 'pack_size' then 'packSize' when 'selling_unit' then 'sellingUnit' else v_key end;
      v_new.field_resolutions:=jsonb_set(v_new.field_resolutions,array[v_key],jsonb_build_object(
        'value',p_patch->v_key,'confirmedAt',now(),'confirmedBy',auth.uid(),
        'sourceValue',coalesce(v_old.field_resolutions->v_key->'sourceValue',v_old.import_row->'row'->v_source_key,to_jsonb(v_old)->v_key)));
    end if;
  end loop;
  -- The client's item name, saved in the same write as the row.
  if p_patch ? 'item_name' then
    if nullif(btrim(p_patch->>'item_name'),'') is null then raise exception 'Enter an item name'; end if;
    update catalog_items set name=left(btrim(p_patch->>'item_name'),120) where id=v_mapping.catalog_item_id and organization_id=p_organization_id;
  end if;
  if p_patch ? 'category_id' then
    v_category:=(p_patch->>'category_id')::uuid;
    if not exists (select 1 from catalog_categories where id=v_category and organization_id=p_organization_id) then raise exception 'Choose a category from this organization'; end if;
    update catalog_items set category_id=v_category,
      category_review=(select is_holding_pen from catalog_categories where id=v_category),category_reason=null
      where id=v_mapping.catalog_item_id and organization_id=p_organization_id;
  end if;
  if v_identity_changed or v_relinked then
    update item_mappings set comparison_track='review',confidence_score=null,match_method='manual' where id=v_mapping.id;
    -- A sole listing supplies its catalog label ONLY while that label is
    -- still the vendor's wording. A name the client set stays theirs.
    if not v_relinked and v_new.description is distinct from v_old.description and not exists (
      select 1 from item_mappings where catalog_item_id=v_mapping.catalog_item_id and id<>v_mapping.id
    ) and not (p_patch ? 'item_name') then update catalog_items set name=left(v_new.description,120)
         where id=v_mapping.catalog_item_id and (name is null or name=left(v_old.description,120)); end if;
  end if;
  v_review := coalesce(v_old.import_row,'{}'::jsonb);
  if coalesce((v_review->>'reviewRequired')::boolean,false) then
    if jsonb_typeof(v_review->'reviewFields')='array' then
      select coalesce(array_agg(value),array[]::text[]) into v_review_fields
        from jsonb_array_elements_text(v_review->'reviewFields');
    else
      -- Existing imports predate field-scoped reviews. Recover the fields
      -- from their preserved changes and reasons without accepting them.
      for v_field in select value->>'field' from jsonb_array_elements(coalesce(v_review->'changes','[]'::jsonb)) loop
        v_review_fields := array_append(v_review_fields,case v_field when 'packSize' then 'pack_size' when 'sellingUnit' then 'selling_unit' when 'gtin' then 'identifiers' when 'manufacturerCode' then 'identifiers' else v_field end);
      end loop;
      for v_reason in select value from jsonb_array_elements_text(coalesce(v_review->'conflicts','[]'::jsonb)) loop
        v_field := case
          when v_reason ~* 'barcode|manufacturer code|gtin' then 'identifiers'
          when v_reason ~* 'pack' then 'pack_size'
          when v_reason ~* 'sellingUnit|quoted unit|price basis|selling unit|quoted units' then 'selling_unit'
          when v_reason ~* 'brand' then 'brand'
          when v_reason ~* 'product|description|wording' then 'description'
          when v_reason ~* 'price|amount' then 'price'
          else null end;
        if v_field is null then v_review_fields := v_review_fields || array['description','brand','pack_size','selling_unit','price'];
        else v_review_fields := array_append(v_review_fields,v_field); end if;
      end loop;
      if v_review->'row'->>'price' is not null and v_old.price is not null
         and (v_review->'row'->>'price')::numeric is distinct from v_old.price then
        v_review_fields := array_append(v_review_fields,'price');
      end if;
      if cardinality(v_review_fields)=0 then
        v_review_fields := array['description','brand','pack_size','selling_unit','price'];
      end if;
    end if;
    -- Only fields in this patch were explicitly confirmed in this save.
    for v_key in select jsonb_object_keys(p_patch) loop
      v_review_fields := array_remove(v_review_fields,v_key);
    end loop;
    select coalesce(array_agg(distinct value),array[]::text[]) into v_review_fields
      from unnest(v_review_fields) value where value is not null;
    v_review := jsonb_set(v_review,'{reviewFields}',to_jsonb(v_review_fields));
    v_review := jsonb_set(v_review,'{reviewRequired}',to_jsonb(cardinality(v_review_fields)>0));
    if cardinality(v_review_fields)=0 then
      -- The accepted baseline uses saved cells; history retains the source.
      v_review := jsonb_set(v_review,'{baseline}',jsonb_build_object(
        'description',v_new.description,'brand',v_new.brand,'packSize',v_new.pack_size,
        'sellingUnit',v_new.selling_unit,'price',v_new.price,
        'gtin',v_new.gtin,'manufacturerCode',v_new.manufacturer_code));
    end if;
  end if;
  update vendor_items set description=v_new.description,brand=v_new.brand,pack_size=v_new.pack_size,
    price=v_new.price,selling_unit=v_new.selling_unit,unit_cost_unit=v_new.unit_cost_unit,
    price_basis=case when v_price_changed then p_price_basis else price_basis end,
    price_unavailable=case when v_price_changed then not (coalesce(p_price_available,false) and coalesce(v_new.price>0,false) and v_new.selling_unit is not null and v_new.pack_size is not null and p_price_basis is not null) else price_unavailable end,
    field_resolutions=v_new.field_resolutions,import_row=v_review,row_revision=row_revision+1,
    last_updated=case when p_patch ? 'price' then now() else last_updated end
    where id=v_old.id returning * into v_new;
  if v_price_changed and not v_new.price_unavailable then
    insert into price_history(vendor_item_id,organization_id,price,source,effective_date,quote_valid_until,
      source_file_name,source_line,source_description,selling_unit,price_basis)
    values (v_new.id,p_organization_id,v_new.price,'price_list',now(),v_new.price_quote_valid_until,
      'Catalog field correction',v_old.import_row->'row'->>'sourceLine',v_new.description,v_new.selling_unit,v_new.price_basis);
  end if;
  return to_jsonb(v_new);
end;
$$;
revoke all on function public.kerdos_save_catalog_row(uuid,uuid,uuid,bigint,jsonb,text,boolean) from public;
grant execute on function public.kerdos_save_catalog_row(uuid,uuid,uuid,bigint,jsonb,text,boolean) to authenticated;

-- ============================================================
-- migration_019_client_approval.sql
-- ============================================================

-- Persist each field confirmation and resolve source reviews field by field.
-- No data is deleted; original rows and conflict notes remain available.
alter table public.vendor_items add column if not exists unit_cost_unit text;
create or replace function public.kerdos_save_catalog_row(
  p_organization_id uuid, p_vendor_item_id uuid, p_mapping_id uuid,
  p_expected_revision bigint, p_patch jsonb, p_price_basis text,
  p_price_available boolean
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_old vendor_items%rowtype;
  v_new vendor_items%rowtype;
  v_mapping item_mappings%rowtype;
  v_category uuid;
  v_target uuid;
  v_relinked boolean := false;
  v_key text;
  v_source_key text;
  v_price_changed boolean;
  v_identity_changed boolean;
  v_review_fields text[] := array[]::text[];
  v_reason text;
  v_field text;
  v_review jsonb;
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if not exists (select 1 from organization_members where organization_id=p_organization_id and user_id=auth.uid() and role in ('owner','manager')) then
    raise exception 'Owner or manager access is required for this organization';
  end if;
  if p_patch is null or jsonb_typeof(p_patch)<>'object' then raise exception 'A field patch is required'; end if;
  if exists (select 1 from jsonb_object_keys(p_patch) k where k not in ('description','brand','pack_size','price','selling_unit','category_id','item_name','catalog_item_id','unit_cost_unit','approve_row','unit_cost_override')) then
    raise exception 'Unsupported catalog field';
  end if;
  select * into v_old from vendor_items where id=p_vendor_item_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Vendor item is outside the requested organization'; end if;
  if p_expected_revision is null or v_old.row_revision<>p_expected_revision then
    raise exception 'This item changed since you opened it. Reload its saved values before saving your changes.';
  end if;
  select * into v_mapping from item_mappings where id=p_mapping_id and vendor_item_id=v_old.id and organization_id=p_organization_id for update;
  if not found then raise exception 'Catalog association changed; reload this row'; end if;
  perform 1 from catalog_items where id=v_mapping.catalog_item_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Catalog item is outside the requested organization'; end if;
  if p_patch ? 'catalog_item_id' then
    if p_patch ?| array['category_id','item_name'] then
      raise exception 'Save item name/category changes separately from an association change';
    end if;
    v_target := (p_patch->>'catalog_item_id')::uuid;
    perform 1 from catalog_items where id=v_target and organization_id=p_organization_id for update;
    if not found then raise exception 'Destination catalog item is outside the requested organization'; end if;
    v_relinked := v_target is distinct from v_mapping.catalog_item_id;
    if v_relinked then
      update item_mappings set catalog_item_id=v_target,comparison_track='review',confidence_score=null,match_method='manual'
        where id=v_mapping.id and organization_id=p_organization_id;
      v_mapping.catalog_item_id := v_target;
    end if;
  end if;
  v_new := v_old;
  if p_patch ? 'description' then v_new.description:=btrim(p_patch->>'description'); end if;
  if nullif(v_new.description,'') is null then raise exception 'Enter a product description'; end if;
  if p_patch ? 'brand' then v_new.brand:=nullif(btrim(p_patch->>'brand'),''); end if;
  if p_patch ? 'pack_size' then v_new.pack_size:=nullif(btrim(p_patch->>'pack_size'),''); end if;
  if p_patch ? 'selling_unit' then v_new.selling_unit:=nullif(btrim(p_patch->>'selling_unit'),''); end if;
  if p_patch ? 'unit_cost_unit' then v_new.unit_cost_unit:=nullif(btrim(p_patch->>'unit_cost_unit'),''); end if;
  if p_patch ? 'price' then v_new.price:=(p_patch->>'price')::numeric; end if;
  if v_new.price is not null and v_new.price<=0 then raise exception 'Enter a positive quoted amount'; end if;
  if p_price_basis is not null and p_price_basis not in ('case','each','measure') then raise exception 'Unknown price basis'; end if;
  v_price_changed:=p_patch ?| array['price','selling_unit','pack_size'];
  v_identity_changed:=v_new.description is distinct from v_old.description or v_new.brand is distinct from v_old.brand or v_new.pack_size is distinct from v_old.pack_size;
  for v_key in select jsonb_object_keys(p_patch) loop
    if v_key in ('description','brand','pack_size','selling_unit','price','category_id','item_name','catalog_item_id') then
      v_source_key:=case v_key when 'pack_size' then 'packSize' when 'selling_unit' then 'sellingUnit' else v_key end;
      v_new.field_resolutions:=jsonb_set(v_new.field_resolutions,array[v_key],jsonb_build_object(
        'value',p_patch->v_key,'confirmedAt',now(),'confirmedBy',auth.uid(),
        'sourceValue',coalesce(v_old.field_resolutions->v_key->'sourceValue',v_old.import_row->'row'->v_source_key,to_jsonb(v_old)->v_key)));
    end if;
  end loop;
  -- The client's item name, saved in the same write as the row.
  if p_patch ? 'item_name' then
    if nullif(btrim(p_patch->>'item_name'),'') is null then raise exception 'Enter an item name'; end if;
    update catalog_items set name=left(btrim(p_patch->>'item_name'),120) where id=v_mapping.catalog_item_id and organization_id=p_organization_id;
  end if;
  if p_patch ? 'category_id' then
    v_category:=(p_patch->>'category_id')::uuid;
    if not exists (select 1 from catalog_categories where id=v_category and organization_id=p_organization_id) then raise exception 'Choose a category from this organization'; end if;
    update catalog_items set category_id=v_category,
      category_review=(select is_holding_pen from catalog_categories where id=v_category),category_reason=null
      where id=v_mapping.catalog_item_id and organization_id=p_organization_id;
  end if;
  if v_identity_changed or v_relinked then
    update item_mappings set comparison_track='review',confidence_score=null,match_method='manual' where id=v_mapping.id;
    -- A sole listing supplies its catalog label ONLY while that label is
    -- still the vendor's wording. A name the client set stays theirs.
    if not v_relinked and v_new.description is distinct from v_old.description and not exists (
      select 1 from item_mappings where catalog_item_id=v_mapping.catalog_item_id and id<>v_mapping.id
    ) and not (p_patch ? 'item_name') then update catalog_items set name=left(v_new.description,120)
         where id=v_mapping.catalog_item_id and (name is null or name=left(v_old.description,120)); end if;
  end if;
  v_review := coalesce(v_old.import_row,'{}'::jsonb);
  if coalesce((v_review->>'reviewRequired')::boolean,false) then
    if jsonb_typeof(v_review->'reviewFields')='array' then
      select coalesce(array_agg(value),array[]::text[]) into v_review_fields
        from jsonb_array_elements_text(v_review->'reviewFields');
    else
      -- Existing imports predate field-scoped reviews. Recover the fields
      -- from their preserved changes and reasons without accepting them.
      for v_field in select value->>'field' from jsonb_array_elements(coalesce(v_review->'changes','[]'::jsonb)) loop
        v_review_fields := array_append(v_review_fields,case v_field when 'packSize' then 'pack_size' when 'sellingUnit' then 'selling_unit' when 'gtin' then 'identifiers' when 'manufacturerCode' then 'identifiers' else v_field end);
      end loop;
      for v_reason in select value from jsonb_array_elements_text(coalesce(v_review->'conflicts','[]'::jsonb)) loop
        v_field := case
          when v_reason ~* 'barcode|manufacturer code|gtin' then 'identifiers'
          when v_reason ~* 'pack' then 'pack_size'
          when v_reason ~* 'sellingUnit|quoted unit|price basis|selling unit|quoted units' then 'selling_unit'
          when v_reason ~* 'brand' then 'brand'
          when v_reason ~* 'product|description|wording' then 'description'
          when v_reason ~* 'price|amount' then 'price'
          else null end;
        if v_field is null then v_review_fields := v_review_fields || array['description','brand','pack_size','selling_unit','price'];
        else v_review_fields := array_append(v_review_fields,v_field); end if;
      end loop;
      if v_review->'row'->>'price' is not null and v_old.price is not null
         and (v_review->'row'->>'price')::numeric is distinct from v_old.price then
        v_review_fields := array_append(v_review_fields,'price');
      end if;
      if cardinality(v_review_fields)=0 then
        v_review_fields := array['description','brand','pack_size','selling_unit','price'];
      end if;
    end if;
    -- Only fields in this patch were explicitly confirmed in this save.
    for v_key in select jsonb_object_keys(p_patch) loop
      v_review_fields := array_remove(v_review_fields,v_key);
    end loop;
    select coalesce(array_agg(distinct value),array[]::text[]) into v_review_fields
      from unnest(v_review_fields) value where value is not null;
    v_review := jsonb_set(v_review,'{reviewFields}',to_jsonb(v_review_fields));
    v_review := jsonb_set(v_review,'{reviewRequired}',to_jsonb(cardinality(v_review_fields)>0));
    if cardinality(v_review_fields)=0 then
      -- The accepted baseline uses saved cells; history retains the source.
      v_review := jsonb_set(v_review,'{baseline}',jsonb_build_object(
        'description',v_new.description,'brand',v_new.brand,'packSize',v_new.pack_size,
        'sellingUnit',v_new.selling_unit,'price',v_new.price,
        'gtin',v_new.gtin,'manufacturerCode',v_new.manufacturer_code));
    end if;
  end if;
  if p_patch ? 'unit_cost_override' then
    if p_patch->'unit_cost_override'='null'::jsonb then
      v_new.field_resolutions:=v_new.field_resolutions-'unit_cost_override';
    else
      if coalesce((p_patch->'unit_cost_override'->>'price')::numeric,0)<=0 or coalesce((p_patch->'unit_cost_override'->>'packPrice')::numeric,0)<=0 or nullif(p_patch->'unit_cost_override'->>'unit','') is null then raise exception 'Enter positive unit cost and purchasing pack price, and a measurement'; end if;
      v_new.field_resolutions:=jsonb_set(v_new.field_resolutions,'{unit_cost_override}',jsonb_build_object('value',p_patch->'unit_cost_override','confirmedAt',now(),'confirmedBy',auth.uid()));
    end if;
  end if;
  if coalesce((p_patch->>'approve_row')::boolean,false) then
    v_new.field_resolutions:=jsonb_set(v_new.field_resolutions,'{row_approval}',jsonb_build_object('confirmedAt',now(),'confirmedBy',auth.uid(),'catalogItemId',v_mapping.catalog_item_id));
    update item_mappings set comparison_track='exact',confidence_score=100,match_method='manual' where id=v_mapping.id;
    v_review:=jsonb_set(jsonb_set(v_review,'{reviewRequired}','false'::jsonb),'{reviewFields}','[]'::jsonb);
    v_review:=jsonb_set(v_review,'{baseline}',jsonb_build_object('description',v_new.description,'brand',v_new.brand,'packSize',v_new.pack_size,'sellingUnit',v_new.selling_unit,'price',v_new.price,'gtin',v_new.gtin,'manufacturerCode',v_new.manufacturer_code));
  end if;
  update vendor_items set description=v_new.description,brand=v_new.brand,pack_size=v_new.pack_size,
    price=v_new.price,selling_unit=v_new.selling_unit,unit_cost_unit=v_new.unit_cost_unit,
    price_source=case when coalesce((p_patch->>'approve_row')::boolean,false) then 'price_list' else price_source end,
    price_expired_at=case when coalesce((p_patch->>'approve_row')::boolean,false) then null else price_expired_at end,
    price_quote_valid_until=case when coalesce((p_patch->>'approve_row')::boolean,false) then null else price_quote_valid_until end,
    price_basis=case when v_price_changed then p_price_basis else price_basis end,
    price_unavailable=case when coalesce((p_patch->>'approve_row')::boolean,false) and v_new.field_resolutions ? 'unit_cost_override' and v_new.price>0 then false when v_price_changed then not (coalesce(p_price_available,false) and coalesce(v_new.price>0,false) and v_new.selling_unit is not null and v_new.pack_size is not null and p_price_basis is not null) else price_unavailable end,
    field_resolutions=v_new.field_resolutions,import_row=v_review,row_revision=row_revision+1,
    last_updated=case when p_patch ? 'price' or coalesce((p_patch->>'approve_row')::boolean,false) then now() else last_updated end
    where id=v_old.id returning * into v_new;
  if v_price_changed and not v_new.price_unavailable then
    insert into price_history(vendor_item_id,organization_id,price,source,effective_date,quote_valid_until,
      source_file_name,source_line,source_description,selling_unit,price_basis)
    values (v_new.id,p_organization_id,v_new.price,'price_list',now(),v_new.price_quote_valid_until,
      'Catalog field correction',v_old.import_row->'row'->>'sourceLine',v_new.description,v_new.selling_unit,v_new.price_basis);
  end if;
  return to_jsonb(v_new);
end;
$$;
revoke all on function public.kerdos_save_catalog_row(uuid,uuid,uuid,bigint,jsonb,text,boolean) from public;
grant execute on function public.kerdos_save_catalog_row(uuid,uuid,uuid,bigint,jsonb,text,boolean) to authenticated;

-- ============================================================
-- migration_020_category_numbers.sql
-- ============================================================

-- Category-scoped display numbers. UUIDs and vendor links never change.
create table if not exists public.catalog_number_history (
  organization_id uuid not null,
  master_item_number bigint not null,
  catalog_item_id uuid not null,
  category_id uuid,
  assigned_at timestamptz not null default now(),
  primary key (organization_id,master_item_number)
);
alter table public.catalog_number_history enable row level security;
drop policy if exists catalog_number_history_members on public.catalog_number_history;
create policy catalog_number_history_members on public.catalog_number_history for select to authenticated
  using (exists(select 1 from public.organization_members m where m.organization_id=catalog_number_history.organization_id and m.user_id=auth.uid()));
grant select on public.catalog_number_history to authenticated;
insert into public.catalog_number_history(organization_id,master_item_number,catalog_item_id,category_id)
 select organization_id,master_item_number,id,category_id from public.catalog_items where master_item_number is not null
 on conflict do nothing;

create or replace function public.kerdos_assign_category_number() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_start bigint; v_end bigint; v_number bigint;
begin
  if tg_op='UPDATE' then
    if new.organization_id is distinct from old.organization_id then raise exception 'An item cannot move between organizations'; end if;
    if new.category_id is not distinct from old.category_id and exists (
      select 1 from public.catalog_categories c where c.id=new.category_id and c.organization_id=new.organization_id
       and old.master_item_number between c.range_start and c.range_end
    ) then
      new.master_item_number:=old.master_item_number;
      return new;
    end if;
  end if;
  if new.category_id is null then raise exception 'Choose a category before assigning a KERDOS item number'; end if;
  -- Serialize numbering within the organization, including overlapping ranges.
  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text,20));
  select range_start,range_end into v_start,v_end from public.catalog_categories
   where id=new.category_id and organization_id=new.organization_id;
  if not found or v_start is null or v_start<=0 or v_end is null or v_end<v_start then raise exception 'This category needs a valid item-number range'; end if;
  if tg_op='UPDATE' and old.master_item_number is not null then
    insert into public.catalog_number_history(organization_id,master_item_number,catalog_item_id,category_id)
      values(old.organization_id,old.master_item_number,old.id,old.category_id) on conflict do nothing;
  end if;
  select coalesce(max(n)+1,v_start) into v_number from (
    select master_item_number n from public.catalog_number_history where organization_id=new.organization_id and master_item_number between v_start and v_end
    union all
    select master_item_number from public.catalog_items where organization_id=new.organization_id and master_item_number between v_start and v_end
  ) used;
  if v_number>v_end then raise exception 'This category item-number range is full; extend its range before moving or creating the item'; end if;
  new.master_item_number:=v_number;
  insert into public.catalog_number_history(organization_id,master_item_number,catalog_item_id,category_id)
    values(new.organization_id,v_number,new.id,new.category_id);
  return new;
end;
$$;
revoke all on function public.kerdos_assign_category_number() from public;
drop trigger if exists kerdos_category_number on public.catalog_items;
create trigger kerdos_category_number before insert or update on public.catalog_items
 for each row execute function public.kerdos_assign_category_number();

-- Repair old out-of-range numbers, including the legacy single-digit fallback.
-- Categories lacking ranges are left intact until their range is configured.
update public.catalog_items i set category_id=i.category_id
 from public.catalog_categories c
 where c.id=i.category_id and c.organization_id=i.organization_id
   and c.range_start is not null and c.range_end>=c.range_start
   and (i.master_item_number is null or i.master_item_number<c.range_start or i.master_item_number>c.range_end);

-- ============================================================
-- migration_021_comparison_preferences.sql
-- ============================================================

-- Industry-neutral client comparison preferences; existing brand locks remain.
alter table public.catalog_items add column if not exists preferred_brand text;
alter table public.catalog_items add column if not exists comparison_mode text not null default 'alternatives';
do $$ begin
 if not exists(select 1 from pg_constraint where conname='catalog_items_comparison_mode_check' and conrelid='public.catalog_items'::regclass) then
  alter table public.catalog_items add constraint catalog_items_comparison_mode_check check(comparison_mode in ('exact','alternatives'));
 end if;
end $$;

-- ============================================================
-- migration_022_associate_alternatives.sql
-- ============================================================

-- One atomic approval of specifically selected vendor alternatives.
create or replace function public.kerdos_associate_alternatives(p_organization_id uuid,p_vendor_item_ids uuid[],p_target_catalog_item_id uuid,p_name text,p_preferred_brand text,p_revisions jsonb)
returns jsonb language plpgsql set search_path=public as $$
declare v_item catalog_items%rowtype; v_vendor vendor_items%rowtype; v_key text; v_value jsonb; v_count integer; v_resolutions jsonb;
begin
 if auth.uid() is null or not exists(select 1 from organization_members where organization_id=p_organization_id and user_id=auth.uid() and role in ('owner','manager')) then raise exception 'Owner or manager access is required'; end if;
 select count(distinct id) into v_count from unnest(p_vendor_item_ids) id;
 if v_count<2 or v_count>100 then raise exception 'Select between 2 and 100 vendor products'; end if;
 if nullif(btrim(p_name),'') is null then raise exception 'Enter the shared item type'; end if;
 perform 1 from vendor_items where id=any(p_vendor_item_ids) and organization_id=p_organization_id order by id for update;
 if (select count(*) from vendor_items where id=any(p_vendor_item_ids) and organization_id=p_organization_id)<>v_count then raise exception 'A selected product is outside this organization'; end if;
 select * into v_item from catalog_items where id=p_target_catalog_item_id and organization_id=p_organization_id for update;
 if not found then raise exception 'Choose an existing item in this organization'; end if;
 if not exists(select 1 from item_mappings where catalog_item_id=v_item.id and vendor_item_id=any(p_vendor_item_ids) and organization_id=p_organization_id) then raise exception 'Choose a target from the selected items'; end if;
 if (select count(distinct vendor_item_id) from item_mappings where vendor_item_id=any(p_vendor_item_ids) and organization_id=p_organization_id)<>v_count then raise exception 'A selected association changed; refresh and select again'; end if;
 for v_vendor in select * from vendor_items where id=any(p_vendor_item_ids) and organization_id=p_organization_id order by id loop
  if (p_revisions->>v_vendor.id::text)::bigint is null or (p_revisions->>v_vendor.id::text)::bigint<>v_vendor.row_revision then raise exception 'A selected product changed; refresh and select again'; end if;
  v_resolutions:=coalesce(v_vendor.field_resolutions,'{}'::jsonb)-'automatic_group';
  for v_key,v_value in select key,value from jsonb_each(jsonb_build_object('description',v_vendor.description,'brand',v_vendor.brand,'pack_size',v_vendor.pack_size,'selling_unit',v_vendor.selling_unit,'price',v_vendor.price,'catalog_item_id',v_item.id,'category_id',v_item.category_id)) loop
   v_resolutions:=jsonb_set(v_resolutions,array[v_key],jsonb_build_object('value',v_value,'confirmedAt',now(),'confirmedBy',auth.uid(),'sourceValue',coalesce(v_resolutions->v_key->'sourceValue',v_value)));
  end loop;
  v_resolutions:=jsonb_set(v_resolutions,'{row_approval}',jsonb_build_object('confirmedAt',now(),'confirmedBy',auth.uid(),'catalogItemId',v_item.id));
  update vendor_items set field_resolutions=v_resolutions,row_revision=row_revision+1 where id=v_vendor.id;
 end loop;
 update item_mappings set catalog_item_id=v_item.id,comparison_track='exact',confidence_score=100,match_method='manual' where organization_id=p_organization_id and vendor_item_id=any(p_vendor_item_ids);
 update catalog_items set name=left(btrim(p_name),120),comparison_mode='alternatives',preferred_brand=nullif(btrim(p_preferred_brand),''),brand_locked=false,locked_brand=null where id=v_item.id;
 return jsonb_build_object('catalogItemId',v_item.id,'masterItemNumber',v_item.master_item_number,'associated',v_count);
end;
$$;
revoke all on function public.kerdos_associate_alternatives(uuid,uuid[],uuid,text,text,jsonb) from public;
grant execute on function public.kerdos_associate_alternatives(uuid,uuid[],uuid,text,text,jsonb) to authenticated;

-- ============================================================
-- migration_023_automatic_alternatives.sql
-- ============================================================

-- Automatic alternatives do not fabricate client approvals or field evidence.
create or replace function public.kerdos_alternative_key(p_description text,p_brand text,p_pack text)
returns text language sql immutable set search_path=public as $$
 with normalized as (
  select btrim(regexp_replace(lower(coalesce(p_description,'')),'[^a-z0-9%]+',' ','g')) description,
   btrim(regexp_replace(lower(coalesce(p_brand,'')),'[^a-z0-9%]+',' ','g')) brand,
   btrim(regexp_replace(lower(coalesce(p_pack,'')),'[^a-z0-9%]+',' ','g')) pack
 ), tokens as (
  select token,brand from normalized,
   lateral regexp_split_to_table(case when pack='' then description else replace(' '||description||' ',' '||pack||' ',' ') end,'\s+') token
 ) select coalesce(string_agg(token,' ' order by token collate "C"),'') from tokens
 where token<>'' and token not in ('and','the','of') and not(token=any(regexp_split_to_array(brand,'\s+')));
$$;

create or replace function public.kerdos_group_automatic_alternatives(p_organization_id uuid,p_vendor_item_ids uuid[],p_target_catalog_item_id uuid,p_key text,p_dimension text,p_revisions jsonb)
returns integer language plpgsql set search_path=public as $$
declare v_item catalog_items%rowtype; v_row vendor_items%rowtype; v_mapping item_mappings%rowtype; v_count integer;
begin
 if auth.uid() is null or not exists(select 1 from organization_members where organization_id=p_organization_id and user_id=auth.uid() and role in ('owner','manager')) then raise exception 'Owner or manager access is required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,23));
 select count(distinct id) into v_count from unnest(p_vendor_item_ids) id;
 if v_count<2 or v_count>100 or length(p_key)<4 or p_key is null or p_dimension is null or p_dimension='unknown' then raise exception 'Automatic grouping needs clear product details'; end if;
 perform 1 from vendor_items where organization_id=p_organization_id and id=any(p_vendor_item_ids) order by id for update;
 if (select count(*) from vendor_items where organization_id=p_organization_id and id=any(p_vendor_item_ids))<>v_count then raise exception 'Product is outside this organization'; end if;
 perform 1 from item_mappings where organization_id=p_organization_id and vendor_item_id=any(p_vendor_item_ids) order by id for update;
 select * into v_item from catalog_items where id=p_target_catalog_item_id and organization_id=p_organization_id for update;
 if not found or v_item.category_id is null or v_item.brand_locked or v_item.preferred_brand is not null or v_item.comparison_mode='exact' then raise exception 'This item does not allow automatic alternatives'; end if;
 if not exists(select 1 from item_mappings where organization_id=p_organization_id and catalog_item_id=v_item.id and vendor_item_id=any(p_vendor_item_ids)) then raise exception 'Target is outside the selected products'; end if;
 for v_row in select * from vendor_items where organization_id=p_organization_id and id=any(p_vendor_item_ids) order by id loop
  if (p_revisions->>v_row.id::text)::bigint is null or (p_revisions->>v_row.id::text)::bigint<>v_row.row_revision then raise exception 'Product changed; refresh and retry'; end if;
  if v_row.field_resolutions ? 'automatic_group_excluded' or v_row.field_resolutions ? 'unit_cost_override' or nullif(btrim(v_row.pack_size),'') is null or kerdos_alternative_key(v_row.description,v_row.brand,v_row.pack_size)<>p_key then raise exception 'Product details do not support automatic grouping'; end if;
  select * into v_mapping from item_mappings where organization_id=p_organization_id and vendor_item_id=v_row.id;
  if not found then raise exception 'Product association is missing'; end if;
  if not exists(select 1 from catalog_items where id=v_mapping.catalog_item_id and organization_id=p_organization_id and category_id=v_item.category_id and not coalesce(brand_locked,false) and comparison_mode='alternatives' and preferred_brand is null) then raise exception 'Category or comparison preference differs'; end if;
  if exists(select 1 from item_mappings m join vendor_items v on v.id=m.vendor_item_id where m.organization_id=p_organization_id and m.catalog_item_id=v_mapping.catalog_item_id and (kerdos_alternative_key(v.description,v.brand,v.pack_size)<>p_key or v.field_resolutions ? 'automatic_group_excluded' or v.field_resolutions ? 'unit_cost_override')) then raise exception 'Existing group contains different products'; end if;
 end loop;
 for v_row in select * from vendor_items where organization_id=p_organization_id and id=any(p_vendor_item_ids) order by id loop
  select * into v_mapping from item_mappings where organization_id=p_organization_id and vendor_item_id=v_row.id;
  update vendor_items set field_resolutions=jsonb_set(coalesce(field_resolutions,'{}'),'{automatic_group}',jsonb_build_object(
   'originalCatalogItemId',coalesce(field_resolutions->'automatic_group'->>'originalCatalogItemId',v_mapping.catalog_item_id::text),
   'catalogItemId',v_item.id,'key',p_key,'dimension',p_dimension,'groupedAt',now(),'groupedBy',auth.uid())),row_revision=row_revision+1 where id=v_row.id;
  update item_mappings set catalog_item_id=v_item.id,comparison_track='exact',confidence_score=100,match_method='rule_based' where id=v_mapping.id;
 end loop;
 return v_count;
end;
$$;

create or replace function public.kerdos_separate_automatic_alternatives(p_organization_id uuid,p_target_catalog_item_id uuid)
returns integer language plpgsql set search_path=public as $$
declare v_row vendor_items%rowtype; v_original uuid; v_count integer:=0;
begin
 if auth.uid() is null or not exists(select 1 from organization_members where organization_id=p_organization_id and user_id=auth.uid() and role in ('owner','manager')) then raise exception 'Owner or manager access is required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,23));
 for v_row in select v.* from vendor_items v join item_mappings m on m.vendor_item_id=v.id and m.organization_id=v.organization_id
  where v.organization_id=p_organization_id and m.catalog_item_id=p_target_catalog_item_id and m.match_method='rule_based' and v.field_resolutions->'automatic_group'->>'catalogItemId'=p_target_catalog_item_id::text order by v.id for update of v,m loop
  v_original:=(v_row.field_resolutions->'automatic_group'->>'originalCatalogItemId')::uuid;
  if not exists(select 1 from catalog_items where id=v_original and organization_id=p_organization_id) then raise exception 'Original item is unavailable; use the catalog link editor'; end if;
  update item_mappings set catalog_item_id=v_original,comparison_track='review',confidence_score=null,match_method='manual' where organization_id=p_organization_id and vendor_item_id=v_row.id;
  update vendor_items set field_resolutions=jsonb_set(field_resolutions-'automatic_group','{automatic_group_excluded}','true'),row_revision=row_revision+1 where id=v_row.id;
  v_count:=v_count+1;
 end loop;
 return v_count;
end;
$$;
revoke all on function public.kerdos_group_automatic_alternatives(uuid,uuid[],uuid,text,text,jsonb) from public;
revoke all on function public.kerdos_separate_automatic_alternatives(uuid,uuid) from public;
grant execute on function public.kerdos_group_automatic_alternatives(uuid,uuid[],uuid,text,text,jsonb) to authenticated;
grant execute on function public.kerdos_separate_automatic_alternatives(uuid,uuid) to authenticated;

-- ============================================================
-- migration_024_atomic_orders.sql
-- ============================================================

-- Record an order and all lines in a single transaction.
alter table public.purchase_order_lines add column if not exists order_unit text;
alter table public.purchase_order_lines add column if not exists pack_size text;
create or replace function public.kerdos_submit_order(
 p_organization_id uuid,p_vendor_id uuid,p_created_by uuid,p_total_amount numeric,
 p_notes text default null,p_lines jsonb default '[]'::jsonb
) returns jsonb language plpgsql set search_path=public as $$
declare v_order public.purchase_orders%rowtype; v_line jsonb; v_total numeric:=0;
begin
 if auth.uid() is null or p_created_by is distinct from auth.uid() then raise exception 'Authentication must match the order creator'; end if;
 if not exists(select 1 from organization_members where organization_id=p_organization_id and user_id=auth.uid() and role in ('owner','manager','employee')) then raise exception 'Organization membership is required'; end if;
 if not exists(select 1 from vendors where id=p_vendor_id and organization_id=p_organization_id) then raise exception 'Vendor is outside the organization'; end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'An order needs line items'; end if;
 for v_line in select value from jsonb_array_elements(p_lines) loop
  if coalesce((v_line->>'quantity')::numeric,0)<=0 or coalesce((v_line->>'unit_price')::numeric,0)<=0 or coalesce(v_line->>'order_unit','') not in ('case','each') then raise exception 'Each line needs a positive quantity, price and purchasing unit'; end if;
  if not exists(select 1 from vendor_items vi join item_mappings m on m.vendor_item_id=vi.id join catalog_items ci on ci.id=m.catalog_item_id where vi.id=(v_line->>'vendor_item_id')::uuid and vi.vendor_id=p_vendor_id and vi.organization_id=p_organization_id and m.organization_id=p_organization_id and ci.id=(v_line->>'catalog_item_id')::uuid and ci.organization_id=p_organization_id) then raise exception 'Order line is outside the vendor or catalog'; end if;
  if (v_line->>'line_total')::numeric is distinct from round((v_line->>'quantity')::numeric*(v_line->>'unit_price')::numeric,2) then raise exception 'Order line total does not match its quantity and price'; end if;
  v_total:=v_total+(v_line->>'line_total')::numeric;
 end loop;
 if p_total_amount is distinct from round(v_total,2) then raise exception 'Order total does not match its lines'; end if;
 insert into purchase_orders(organization_id,vendor_id,created_by,status,total_amount,notes)
 values(p_organization_id,p_vendor_id,auth.uid(),'submitted',v_total,p_notes) returning * into v_order;
 insert into purchase_order_lines(purchase_order_id,catalog_item_id,vendor_item_id,quantity,unit_price,line_total,order_unit,pack_size)
 select v_order.id,(line->>'catalog_item_id')::uuid,(line->>'vendor_item_id')::uuid,
 (line->>'quantity')::numeric,(line->>'unit_price')::numeric,(line->>'line_total')::numeric,line->>'order_unit',line->>'pack_size'
 from jsonb_array_elements(p_lines) line;
 return to_jsonb(v_order);
end;
$$;
revoke all on function public.kerdos_submit_order(uuid,uuid,uuid,numeric,text,jsonb) from public;
grant execute on function public.kerdos_submit_order(uuid,uuid,uuid,numeric,text,jsonb) to authenticated;

commit;
