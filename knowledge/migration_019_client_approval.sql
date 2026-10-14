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
