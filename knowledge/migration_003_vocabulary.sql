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
