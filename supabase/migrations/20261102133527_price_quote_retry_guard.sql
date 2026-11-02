-- Retry accepted source rows without mutating their listing again.
-- Security invoker, existing membership checks and deployed pricing rules retained.
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
  v_saved price_history%rowtype;
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

  -- Serialize retries before either the listing or its history can change.
  -- Document locking also covers the first request when no listing exists yet.
  if p_source_document_id is not null and p_import_row->>'rowKey' is not null then
    perform 1 from import_documents d
      where d.id=p_source_document_id and d.organization_id=p_organization_id
        and d.vendor_id=p_vendor_id for update;
    if not found then raise exception 'Source document is outside the requested organization/vendor'; end if;
    select h.* into v_saved from price_history h
      where h.source_document_id=p_source_document_id
        and h.source_row_key=p_import_row->>'rowKey'
        and h.organization_id=p_organization_id;
    if found then
      if (p_vendor_item_id is not null and p_vendor_item_id<>v_saved.vendor_item_id)
        or p_price_unavailable is distinct from false
        or p_price is distinct from v_saved.price
        or p_source_line is distinct from v_saved.source_line
        or p_description is distinct from v_saved.source_description
        or p_selling_unit is distinct from v_saved.selling_unit
        or p_price_basis is distinct from v_saved.price_basis then
        raise exception 'Saved source row differs from this retry. Existing quotation was kept';
      end if;
      if not exists(select 1 from vendor_items v where v.id=v_saved.vendor_item_id
        and v.organization_id=p_organization_id and v.vendor_id=p_vendor_id) then
        raise exception 'Saved quotation listing is outside the requested organization/vendor';
      end if;
      -- A newer document or catalog correction may now own this listing.
      -- Return the committed identity so mapping/progress recovery can finish,
      -- without changing price, revision, timestamp or retained incoming evidence.
      return v_saved.vendor_item_id;
    end if;
  end if;

  if p_vendor_item_id is null then
    insert into vendor_items(
      organization_id,vendor_id,vendor_item_code,description,pack_size,price,
      last_updated,price_source,price_unavailable,price_expired_at,price_quote_valid_until,
      selling_unit,price_basis,gtin,manufacturer_code,import_row,field_resolutions,brand
    ) values (
      p_organization_id,p_vendor_id,p_vendor_item_code,p_description,p_pack_size,p_price,
      p_effective_date,'price_list',coalesce(p_price_unavailable,true) or (p_pack_size is null and not coalesce(p_price_basis in ('case','each') and nullif(btrim(p_selling_unit),'') is not null,false)),null,p_quote_valid_until,
      p_selling_unit,p_price_basis,p_gtin,p_manufacturer_code,coalesce(p_import_row,'{}'::jsonb),coalesce(p_field_resolutions,'{}'::jsonb),p_brand
    ) returning id into v_item_id;
  else
    update vendor_items set
      price=case when p_price_unavailable then price else p_price end,
      pack_size=coalesce(p_pack_size,pack_size),
      last_updated=p_effective_date,
      price_source='price_list',
      price_unavailable=coalesce(p_price_unavailable,true) or (coalesce(p_pack_size,pack_size) is null and not coalesce(p_price_basis in ('case','each') and nullif(btrim(p_selling_unit),'') is not null,false)),
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
