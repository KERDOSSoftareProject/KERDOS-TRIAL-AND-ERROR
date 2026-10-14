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
