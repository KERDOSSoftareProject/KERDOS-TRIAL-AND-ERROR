-- Durable identities for held quote rows, which intentionally have no accepted history.
alter table public.import_documents add column if not exists staged_row_receipts jsonb not null default '{}'::jsonb
  check(jsonb_typeof(staged_row_receipts)='object');

-- Existing documents and older producers remain unversioned: their staged identities
-- must be proven from an exact existing listing or retained for review.
alter table public.import_documents add column if not exists staged_receipts_version integer
  check(staged_receipts_version is null or staged_receipts_version=1);
alter table public.import_documents alter column staged_receipts_version drop default;

-- Existing receipts cannot be cleared or reassigned. New receipts must point
-- to a listing in this document's organization/vendor. Existing document RLS
-- still governs all reads and writes; this function is security invoker.
create or replace function public.kerdos_keep_staged_row_receipts() returns trigger
language plpgsql set search_path=public as $$
declare r record;
begin
  if jsonb_typeof(new.staged_row_receipts) is distinct from 'object' then
    raise exception 'Staged source-row receipts must be an object';
  end if;
  if tg_op='UPDATE' then
    if new.staged_receipts_version is distinct from old.staged_receipts_version then
      raise exception 'Staged source-row receipt version cannot be changed';
    end if;
    for r in select key,value from jsonb_each(old.staged_row_receipts) loop
      if new.staged_row_receipts->r.key is distinct from r.value then
        raise exception 'Retained staged source-row receipts cannot be changed or cleared';
      end if;
    end loop;
  end if;
  for r in select key,value from jsonb_each(new.staged_row_receipts) loop
    if tg_op='UPDATE' and old.staged_row_receipts->r.key=r.value then continue;end if;
    if r.key='' or jsonb_typeof(r.value) is distinct from 'object'
      or coalesce(r.value->>'sourceSha256','') !~ '^[0-9a-f]{64}$'
      or not exists(select 1 from public.vendor_items v where v.id=(r.value->>'vendorItemId')::uuid
        and v.organization_id=new.organization_id and v.vendor_id=new.vendor_id) then
      raise exception 'Staged source-row receipt does not match this organization/vendor listing';
    end if;
  end loop;
  return new;
end;$$;
revoke all on function public.kerdos_keep_staged_row_receipts() from public;
drop trigger if exists keep_staged_row_receipts on public.import_documents;
create trigger keep_staged_row_receipts before insert or update of staged_row_receipts,staged_receipts_version
  on public.import_documents for each row execute function public.kerdos_keep_staged_row_receipts();

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
  v_receipt jsonb;
  v_legacy_doc boolean;
  v_candidates jsonb;
  v_legacy jsonb;
  v_row_key text:=p_import_row->>'rowKey';
  v_source_hash text:=encode(sha256(convert_to(jsonb_build_object(
    'code',p_vendor_item_code,'description',p_description,'packSize',p_pack_size,
    'price',p_price,'unavailable',p_price_unavailable,'sellingUnit',p_selling_unit,
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
    if v_receipt is null and v_legacy_doc and p_price_unavailable is true then
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
      if p_price_unavailable is distinct from false or p_vendor_item_id is distinct from v_item_id then
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
  if p_price_unavailable is true and p_source_document_id is not null and v_row_key is not null then
    update import_documents d set staged_row_receipts=jsonb_set(d.staged_row_receipts,array[v_row_key],
      jsonb_build_object('vendorItemId',v_item_id,'sourceSha256',v_source_hash),true)
      where d.id=p_source_document_id and d.organization_id=p_organization_id and d.vendor_id=p_vendor_id;
    if not found then raise exception 'Could not preserve the staged source-row receipt';end if;
  end if;
  return v_item_id;
end;
$$;

revoke all on function kerdos_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid,text,text,text,text,jsonb,jsonb,text) from public;
grant execute on function kerdos_apply_price_quote(uuid,uuid,uuid,text,text,text,numeric,boolean,timestamptz,date,text,text,text,uuid,text,text,text,text,jsonb,jsonb,text) to authenticated;


-- Save one row, its category, and any changed price together. A rejected
-- write rolls back all of them. Optimistic revision prevents lost updates.
