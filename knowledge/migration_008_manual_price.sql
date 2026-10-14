-- A corrected price and its history are one transaction. Check organization
-- membership and the item's organization before changing either record.
create or replace function kerdos_record_manual_price(
  p_organization_id uuid,
  p_vendor_item_id uuid,
  p_price numeric
) returns uuid
language plpgsql
set search_path = public
as $$
declare
  v_item vendor_items%rowtype;
  v_now timestamptz := now();
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if not exists (
    select 1 from organization_members m
    where m.organization_id=p_organization_id and m.user_id=auth.uid()
      and m.role in ('owner','manager')
  ) then raise exception 'Owner or manager access is required'; end if;
  if p_price is null or p_price <= 0 then raise exception 'Price must be positive'; end if;

  select * into v_item from vendor_items
    where id=p_vendor_item_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Vendor product does not belong to this organization'; end if;

  update vendor_items set price=p_price,last_updated=v_now,
    price_source='manual_edit',price_expired_at=null,
    price_quote_valid_until=null,price_unavailable=v_item.pack_size is null
    where id=p_vendor_item_id and organization_id=p_organization_id;

  insert into price_history(vendor_item_id,organization_id,price,source,effective_date,
    source_description,source_line)
  values(p_vendor_item_id,p_organization_id,p_price,'manual_edit',v_now,
    v_item.description,'Manual price confirmation: '||v_item.description||' — '||p_price);
  return p_vendor_item_id;
end;
$$;

revoke all on function kerdos_record_manual_price(uuid,uuid,numeric) from public;
grant execute on function kerdos_record_manual_price(uuid,uuid,numeric) to authenticated;
