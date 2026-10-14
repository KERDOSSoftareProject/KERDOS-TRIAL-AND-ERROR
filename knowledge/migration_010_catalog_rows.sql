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
