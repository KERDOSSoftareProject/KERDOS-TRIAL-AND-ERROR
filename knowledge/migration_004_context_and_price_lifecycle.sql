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
