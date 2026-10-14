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
