-- A supplied price can be recorded on a listing held for review. Keep it
-- out of accepted quotation history until the source row is resolved.
-- Keep the existing role grants and lease fence.

create or replace function public.kerdos_apply_price_quote(
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
  v_receipt jsonb;
  v_legacy_doc boolean;
  v_candidates jsonb;
  v_legacy jsonb;
  v_row_key text:=p_import_row->>'rowKey';
  v_staged boolean:=p_price_unavailable is true
    or coalesce(p_import_row->>'reviewRequired'='true',false);
  -- The previous importer sent unavailable=true for every staged row.
  -- Preserve its receipt hash so in-flight observations can still replay.
  v_source_hash text:=encode(sha256(convert_to(jsonb_build_object(
    'code',p_vendor_item_code,'description',p_description,'packSize',p_pack_size,
    'price',p_price,'unavailable',v_staged,'sellingUnit',p_selling_unit,
    'priceBasis',p_price_basis,'brand',p_brand,'gtin',p_gtin,
    'manufacturerCode',p_manufacturer_code,'sourceLine',p_source_line,
    'sourceRow',p_import_row->'row')::text,'UTF8')),'hex');
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
    select d.staged_row_receipts->v_row_key,d.staged_receipts_version is null into v_receipt,v_legacy_doc from import_documents d
      where d.id=p_source_document_id and d.organization_id=p_organization_id
        and d.vendor_id=p_vendor_id for update;
    if not found then raise exception 'Source document is outside the requested organization/vendor'; end if;
    if v_receipt is null and v_legacy_doc and v_staged then
      select coalesce(jsonb_agg(to_jsonb(v)),'[]'::jsonb) into v_candidates from vendor_items v
        where v.organization_id=p_organization_id and v.vendor_id=p_vendor_id
          and v.import_row->>'sourceDocumentId'=p_source_document_id::text
          and v.import_row->>'rowKey'=v_row_key;
      if jsonb_array_length(v_candidates)<>1 then
        raise exception 'This older staged source has no unique saved listing. Its retained row needs review';
      end if;
      v_legacy:=v_candidates->0;
      v_item_id:=(v_legacy->>'id')::uuid;
      if (p_vendor_item_id is not null and p_vendor_item_id<>v_item_id)
        or (v_legacy->>'price_unavailable')::boolean is distinct from true
        or v_legacy->>'description' is distinct from p_description
        or v_legacy->>'pack_size' is distinct from p_pack_size
        or v_legacy->>'brand' is distinct from p_brand
        or v_legacy->>'vendor_item_code' is distinct from p_vendor_item_code
        or v_legacy->>'selling_unit' is distinct from p_selling_unit
        or v_legacy->>'price_basis' is distinct from p_price_basis
        or (v_legacy->>'price')::numeric is distinct from p_price
        or v_legacy->>'gtin' is distinct from p_gtin
        or v_legacy->>'manufacturer_code' is distinct from p_manufacturer_code
        or v_legacy->'import_row'->'row' is distinct from p_import_row->'row'
        or coalesce(v_legacy->'import_row'->'evidence'->>'sourceLine',v_legacy->'import_row'->'row'->>'sourceLine') is distinct from p_source_line then
        raise exception 'This older staged source no longer matches its saved listing. Its retained row needs review';
      end if;
      update import_documents d set staged_row_receipts=jsonb_set(d.staged_row_receipts,array[v_row_key],
        jsonb_build_object('vendorItemId',v_item_id,'sourceSha256',v_source_hash),true)
        where d.id=p_source_document_id and d.organization_id=p_organization_id and d.vendor_id=p_vendor_id;
      return v_item_id;
    end if;
    if v_receipt is not null then
      v_item_id:=(v_receipt->>'vendorItemId')::uuid;
      if (p_vendor_item_id is not null and p_vendor_item_id<>v_item_id)
        or not exists(select 1 from vendor_items v where v.id=v_item_id
          and v.organization_id=p_organization_id and v.vendor_id=p_vendor_id) then
        raise exception 'Saved source row differs from this retry. Existing listing was kept';
      end if;
      if v_receipt->>'sourceSha256'=v_source_hash then
        -- This original held observation may have since been corrected or
        -- superseded. Recover its identity without restoring its old state.
        return v_item_id;
      end if;
      if v_staged or p_price_unavailable is distinct from false or p_vendor_item_id is distinct from v_item_id then
        raise exception 'Saved source row differs from this retry. Existing listing was kept';
      end if;
      -- Deliberate resolution of the current held row is still allowed using
      -- its known listing ID. An older source cannot displace a newer source.
      if not exists(select 1 from price_history h where h.source_document_id=p_source_document_id
        and h.source_row_key=v_row_key and h.organization_id=p_organization_id)
        and not exists(select 1 from vendor_items v where v.id=v_item_id
          and v.import_row->>'sourceDocumentId'=p_source_document_id::text
          and v.import_row->>'rowKey'=v_row_key
          and (v.price_unavailable or v.import_row->>'reviewRequired'='true')) then
        raise exception 'This staged source is no longer current. Existing quotation was kept';
      end if;
    end if;
    select h.* into v_saved from price_history h
      where h.source_document_id=p_source_document_id
        and h.source_row_key=p_import_row->>'rowKey'
        and h.organization_id=p_organization_id;
    if found then
      if (p_vendor_item_id is not null and p_vendor_item_id<>v_saved.vendor_item_id)
        or v_staged
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
      p_effective_date,'price_list',coalesce(p_price_unavailable,true),null,p_quote_valid_until,
      p_selling_unit,p_price_basis,p_gtin,p_manufacturer_code,coalesce(p_import_row,'{}'::jsonb),coalesce(p_field_resolutions,'{}'::jsonb),p_brand
    ) returning id into v_item_id;
  else
    update vendor_items set
      price=case when p_price_unavailable then price else p_price end,
      pack_size=coalesce(p_pack_size,pack_size),
      last_updated=p_effective_date,
      price_source='price_list',
      price_unavailable=coalesce(p_price_unavailable,true),
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
  if not v_staged and not p_price_unavailable and not exists (
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
  if v_staged and p_source_document_id is not null and v_row_key is not null then
    update import_documents d set staged_row_receipts=jsonb_set(d.staged_row_receipts,array[v_row_key],
      jsonb_build_object('vendorItemId',v_item_id,'sourceSha256',v_source_hash),true)
      where d.id=p_source_document_id and d.organization_id=p_organization_id and d.vendor_id=p_vendor_id;
    if not found then raise exception 'Could not preserve the staged source-row receipt';end if;
  end if;
  return v_item_id;
end;
$$;

revoke all on function public.kerdos_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid,text,text,text,text,jsonb,jsonb,text) from public;
grant execute on function public.kerdos_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid,text,text,text,text,jsonb,jsonb,text) to authenticated;

CREATE OR REPLACE FUNCTION public.kerdos_auto_apply_price_quote(p_vendor_item_id uuid, p_organization_id uuid, p_vendor_id uuid, p_vendor_item_code text, p_description text, p_pack_size text, p_price numeric, p_price_unavailable boolean, p_effective_date timestamp with time zone, p_quote_valid_until date, p_source_file_path text, p_source_file_name text, p_source_line text, p_source_document_id uuid, p_selling_unit text DEFAULT NULL::text, p_price_basis text DEFAULT NULL::text, p_gtin text DEFAULT NULL::text, p_manufacturer_code text DEFAULT NULL::text, p_import_row jsonb DEFAULT NULL::jsonb, p_field_resolutions jsonb DEFAULT NULL::jsonb, p_brand text DEFAULT NULL::text, p_lease_token uuid DEFAULT NULL::uuid, p_attachment_id uuid DEFAULT NULL::uuid)
 RETURNS uuid
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
DECLARE
  v_item_id  uuid;
  v_lease_ok boolean;
BEGIN
  -- §LEASE mandatory guard: both parameters are required.  A call without a
  -- valid lease context is rejected before any writes.
  IF p_lease_token IS NULL OR p_attachment_id IS NULL THEN
    RAISE EXCEPTION
      'kerdos_auto_apply_price_quote_with_lease requires p_lease_token and p_attachment_id — '
      'call without lease context rejected before any writes. [migration_036]';
  END IF;

  SELECT (processing_lease_token = p_lease_token)
    INTO v_lease_ok
    FROM public.inbound_attachments
   WHERE id = p_attachment_id
     FOR UPDATE;

  IF NOT FOUND OR NOT COALESCE(v_lease_ok, false) THEN
    RETURN NULL;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM public.vendors v
     WHERE v.id = p_vendor_id
       AND v.organization_id = p_organization_id
  ) THEN
    RAISE EXCEPTION 'Vendor is outside the requested organization';
  END IF;

  IF p_source_document_id IS NOT NULL AND NOT EXISTS (
    SELECT 1 FROM public.import_documents d
     WHERE d.id              = p_source_document_id
       AND d.organization_id = p_organization_id
       AND d.vendor_id       = p_vendor_id
  ) THEN
    RAISE EXCEPTION 'Source document is outside the requested organization/vendor';
  END IF;

  IF p_effective_date IS NULL THEN
    RAISE EXCEPTION 'A price quotation requires an effective date';
  END IF;

  IF p_price_unavailable IS NOT TRUE AND (p_price IS NULL OR p_price <= 0) THEN
    RAISE EXCEPTION 'A current quotation requires a positive price';
  END IF;

  IF p_price_basis IS NOT NULL AND p_price_basis NOT IN ('case','each','measure') THEN
    RAISE EXCEPTION 'Price basis must be case, each or measure';
  END IF;

  IF p_vendor_item_id IS NULL THEN
    INSERT INTO public.vendor_items(
      organization_id, vendor_id, vendor_item_code, description, pack_size, price,
      last_updated, price_source, price_unavailable, price_expired_at,
      price_quote_valid_until, selling_unit, price_basis, gtin, manufacturer_code,
      import_row, field_resolutions, brand
    ) VALUES (
      p_organization_id, p_vendor_id, p_vendor_item_code, p_description, p_pack_size, p_price,
      p_effective_date, 'price_list', COALESCE(p_price_unavailable, true), NULL,
      p_quote_valid_until, p_selling_unit, p_price_basis, p_gtin, p_manufacturer_code,
      COALESCE(p_import_row, '{}'::jsonb), COALESCE(p_field_resolutions, '{}'::jsonb), p_brand
    ) RETURNING id INTO v_item_id;
  ELSE
    UPDATE public.vendor_items SET
      price               = CASE WHEN p_price_unavailable THEN price     ELSE p_price     END,
      pack_size           = COALESCE(p_pack_size, pack_size),
      last_updated        = p_effective_date,
      price_source        = 'price_list',
      price_unavailable   = COALESCE(p_price_unavailable, true),
      price_expired_at    = NULL,
      price_quote_valid_until = p_quote_valid_until,
      selling_unit        = CASE WHEN p_price_unavailable THEN selling_unit  ELSE p_selling_unit  END,
      price_basis         = CASE WHEN p_price_unavailable THEN price_basis   ELSE p_price_basis   END,
      gtin                = COALESCE(p_gtin,             gtin),
      manufacturer_code   = COALESCE(p_manufacturer_code, manufacturer_code),
      import_row          = COALESCE(p_import_row,        import_row),
      field_resolutions   = COALESCE(p_field_resolutions, field_resolutions),
      brand               = COALESCE(p_brand,             brand),
      row_revision        = row_revision + 1
    WHERE id              = p_vendor_item_id
      AND organization_id = p_organization_id
      AND vendor_id       = p_vendor_id
    RETURNING id INTO v_item_id;

    IF v_item_id IS NULL THEN
      RAISE EXCEPTION 'Vendor item is outside the requested organization/vendor';
    END IF;
  END IF;

  IF NOT p_price_unavailable
     AND NOT COALESCE(p_import_row->>'reviewRequired'='true',false)
     AND NOT EXISTS (
    SELECT 1 FROM public.price_history h
     WHERE h.source_row_key IS NULL
       AND h.vendor_item_id      = v_item_id
       AND h.source_document_id  = p_source_document_id
       AND (p_import_row->>'rowKey' IS NULL OR
            (p_source_line IS NOT NULL AND h.source_line = p_source_line))
       AND h.price = p_price
  ) THEN
    INSERT INTO public.price_history(
      vendor_item_id, organization_id, price, source, effective_date, quote_valid_until,
      source_file_path, source_file_name, source_description, source_line,
      source_document_id, selling_unit, price_basis, source_row_key
    ) VALUES (
      v_item_id, p_organization_id, p_price, 'price_list',
      p_effective_date, p_quote_valid_until,
      p_source_file_path, p_source_file_name, p_description, p_source_line,
      p_source_document_id, p_selling_unit, p_price_basis,
      p_import_row->>'rowKey'
    )
    ON CONFLICT (source_document_id, source_row_key)
      WHERE source_row_key IS NOT NULL
    DO NOTHING;
  END IF;

  RETURN v_item_id;
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.kerdos_auto_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid,text,text,text,text,jsonb,jsonb,text,uuid,uuid) FROM PUBLIC, anon, authenticated;
GRANT EXECUTE ON FUNCTION public.kerdos_auto_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid,text,text,text,text,jsonb,jsonb,text,uuid,uuid) TO service_role;

-- Catalog edits keep the amount independent from pack conversion and review.
CREATE OR REPLACE FUNCTION public.kerdos_save_catalog_row(p_organization_id uuid, p_vendor_item_id uuid, p_mapping_id uuid, p_expected_revision bigint, p_patch jsonb, p_price_basis text, p_price_available boolean)
 RETURNS jsonb
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_old vendor_items%rowtype;
  v_new vendor_items%rowtype;
  v_mapping item_mappings%rowtype;
  v_category uuid;
  v_target uuid;
  v_relinked boolean := false;
  v_vendor_price_edit boolean := coalesce(p_patch->'vendor_price_edit'='true'::jsonb,false);
  v_key text;
  v_source_key text;
  v_price_changed boolean;
  v_identity_changed boolean;
  v_review_fields text[] := array[]::text[];
  v_reason text;
  v_field text;
  v_review jsonb;
  v_price_unit_conflict constant text := 'The price column and row state different pricing bases.';
  v_unconfirmed_price_unit_conflict boolean;
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if not exists (select 1 from organization_members where organization_id=p_organization_id and user_id=auth.uid() and role in ('owner','manager')) then
    raise exception 'Owner or manager access is required for this organization';
  end if;
  if p_patch is null or jsonb_typeof(p_patch)<>'object' then raise exception 'A field patch is required'; end if;
  if exists (select 1 from jsonb_object_keys(p_patch) k where k not in ('description','brand','pack_size','price','selling_unit','category_id','item_name','catalog_item_id','unit_cost_unit','approve_row','unit_cost_override','vendor_price_edit')) then
    raise exception 'Unsupported catalog field';
  end if;
  if p_patch ? 'vendor_price_edit' and (not v_vendor_price_edit or not (p_patch ? 'price') or p_patch-'vendor_price_edit'-'price'<>'{}'::jsonb or jsonb_typeof(p_patch->'price') is distinct from 'number') then
    raise exception 'Vendor price edits accept only a positive quoted amount';
  end if;
  select * into v_old from vendor_items where id=p_vendor_item_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Vendor item is outside the requested organization'; end if;
  if p_expected_revision is null or v_old.row_revision<>p_expected_revision then
    raise exception 'This item changed since you opened it. Reload its saved values before saving your changes.';
  end if;
  if p_mapping_id is null and v_vendor_price_edit then
    if exists (select 1 from item_mappings where vendor_item_id=v_old.id and organization_id=p_organization_id) then
      raise exception 'Catalog association changed; reload this row';
    end if;
  else
    select * into v_mapping from item_mappings where id=p_mapping_id and vendor_item_id=v_old.id and organization_id=p_organization_id for update;
    if not found then raise exception 'Catalog association changed; reload this row'; end if;
    perform 1 from catalog_items where id=v_mapping.catalog_item_id and organization_id=p_organization_id for update;
    if not found then raise exception 'Catalog item is outside the requested organization'; end if;
  end if;
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
  if v_new.price is not null and (v_new.price<=0 or v_new.price::text in ('NaN','Infinity','-Infinity')) then
    raise exception 'Enter a positive quoted amount';
  end if;
  if p_price_basis is not null and p_price_basis not in ('case','each','measure') then raise exception 'Unknown price basis'; end if;
  v_price_changed:=p_patch ?| array['price','selling_unit','pack_size'];
  v_identity_changed:=v_new.description is distinct from v_old.description or v_new.pack_size is distinct from v_old.pack_size;
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
  v_unconfirmed_price_unit_conflict := v_review->'reviewRequired'='true'::jsonb
    and (coalesce(v_review->'conflicts','[]'::jsonb) ? v_price_unit_conflict
      or coalesce(v_review#>'{row,issues}','[]'::jsonb) ? v_price_unit_conflict)
    and (coalesce(v_review->'reviewFields','[]'::jsonb) ? 'selling_unit'
      or (v_review ? 'retainedSource' and (jsonb_typeof(v_review->'reviewFields') is distinct from 'array'
        or v_review->'reviewFields' ? 'price'))
      or v_old.field_resolutions#>>'{selling_unit,value}' is distinct from v_old.selling_unit
      or coalesce(v_old.field_resolutions#>>'{selling_unit,confirmedBy}',v_old.field_resolutions#>>'{selling_unit,confirmedAt}') is null);
  if not v_vendor_price_edit and coalesce((v_review->>'reviewRequired')::boolean,false) then
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
    -- Older imports marked a declaration conflict as a price issue. A price
    -- edit alone must leave the contradictory unit pending.
    if v_unconfirmed_price_unit_conflict then
      v_review_fields := array_append(v_review_fields,'selling_unit');
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
    if v_unconfirmed_price_unit_conflict and (not (p_patch ? 'selling_unit') or v_new.selling_unit is null) then
      raise exception 'Choose the price unit before approving this conflicting quote';
    end if;
    v_new.field_resolutions:=jsonb_set(v_new.field_resolutions,'{row_approval}',jsonb_build_object('confirmedAt',now(),'confirmedBy',auth.uid(),'catalogItemId',v_mapping.catalog_item_id));
    update item_mappings set comparison_track='exact',confidence_score=100,match_method='manual' where id=v_mapping.id;
    v_review:=jsonb_set(jsonb_set(v_review,'{reviewRequired}','false'::jsonb),'{reviewFields}','[]'::jsonb);
    v_review:=jsonb_set(v_review,'{baseline}',jsonb_build_object('description',v_new.description,'brand',v_new.brand,'packSize',v_new.pack_size,'sellingUnit',v_new.selling_unit,'price',v_new.price,'gtin',v_new.gtin,'manufacturerCode',v_new.manufacturer_code));
  end if;
  update vendor_items set description=v_new.description,brand=v_new.brand,pack_size=v_new.pack_size,
    price=v_new.price,selling_unit=v_new.selling_unit,unit_cost_unit=v_new.unit_cost_unit,
    price_source=case when v_vendor_price_edit then 'manual_edit' when coalesce((p_patch->>'approve_row')::boolean,false) then 'price_list' else price_source end,
    price_expired_at=case when v_vendor_price_edit or coalesce((p_patch->>'approve_row')::boolean,false) then null else price_expired_at end,
    price_quote_valid_until=case when v_vendor_price_edit or coalesce((p_patch->>'approve_row')::boolean,false) then null else price_quote_valid_until end,
    price_basis=case when v_price_changed and not v_vendor_price_edit then p_price_basis else price_basis end,
    price_unavailable=case
      when p_patch ? 'price' then v_new.price is null
      -- Recover an older false-unavailable flag only from its active retained
      -- observation. An incoming or withdrawn observation cannot revive it.
      when v_price_changed and v_old.price_unavailable and v_old.price_source='price_list'
        and not (v_review ? 'retainedSource') and nullif(v_review->>'sourceDocumentId','') is not null
        and v_review#>>'{row,priceUnavailable}' is distinct from 'true'
        and v_review#>'{row,price}'=to_jsonb(v_old.price) and v_old.price>0 then false
      else price_unavailable
    end,
    field_resolutions=v_new.field_resolutions,import_row=v_review,row_revision=row_revision+1,
    last_updated=case when p_patch ? 'price' or coalesce((p_patch->>'approve_row')::boolean,false) then now() else last_updated end
    where id=v_old.id returning * into v_new;
  -- The API's p_price_available describes conversion to a purchasing cost.
  -- Only a convertible, released amount can become invoice quote history.
  if v_price_changed and coalesce(p_price_available,false) and not v_new.price_unavailable
    and v_new.price_basis is not null and v_new.selling_unit is not null
    and (not v_vendor_price_edit or (v_mapping.id is not null and v_new.price_basis=p_price_basis
      and nullif(btrim(v_new.pack_size),'') is not null))
    and v_new.price_expired_at is null
    and (v_new.price_quote_valid_until is null or v_new.price_quote_valid_until >= current_date)
    and v_new.import_row->>'reviewRequired' is distinct from 'true' then
    insert into price_history(vendor_item_id,organization_id,price,source,effective_date,quote_valid_until,
      source_file_name,source_line,source_description,selling_unit,price_basis)
    values (v_new.id,p_organization_id,v_new.price,case when v_vendor_price_edit then 'manual_edit' else 'price_list' end,now(),v_new.price_quote_valid_until,
      case when v_vendor_price_edit then null else 'Catalog field correction' end,
      case when v_vendor_price_edit then 'Manual price confirmation: '||v_new.description||' — '||v_new.price
        else v_old.import_row->'row'->>'sourceLine' end,v_new.description,v_new.selling_unit,v_new.price_basis);
  end if;
  return to_jsonb(v_new);
end;
$function$;
