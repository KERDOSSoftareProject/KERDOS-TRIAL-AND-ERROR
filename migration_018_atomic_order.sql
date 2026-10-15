
-- Migration 018: atomic order submission.
-- The order header and all its lines save together. A dropped connection
-- or a failed line write can no longer leave an orphaned order header.
-- The function returns the new purchase_order row.

create or replace function public.kerdos_submit_order(
  p_organization_id uuid,
  p_vendor_id uuid,
  p_created_by uuid,
  p_total_amount numeric,
  p_notes text default null,
  p_lines jsonb default '[]'
) returns jsonb
language plpgsql
set search_path = public
as $$
declare
  v_order purchase_orders%rowtype;
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if not exists (
    select 1 from organization_members
    where organization_id=p_organization_id and user_id=auth.uid()
      and role in ('owner','manager','employee')
  ) then raise exception 'Organization membership is required'; end if;
  if not exists (
    select 1 from vendors where id=p_vendor_id and organization_id=p_organization_id
  ) then raise exception 'Vendor is outside the requested organization'; end if;
  if jsonb_array_length(p_lines)=0 then raise exception 'An order needs at least one line item'; end if;

  insert into purchase_orders(
    organization_id,vendor_id,created_by,status,total_amount,notes
  ) values (
    p_organization_id,p_vendor_id,p_created_by,'submitted',p_total_amount,p_notes
  ) returning * into v_order;

  insert into purchase_order_lines(
    purchase_order_id,catalog_item_id,vendor_item_id,
    vendor_item_code,description,quantity,unit_price,line_total,
    pack_size,selling_unit
  )
  select
    v_order.id,
    (line->>'catalog_item_id')::uuid,
    (line->>'vendor_item_id')::uuid,
    line->>'vendor_item_code',
    line->>'description',
    (line->>'quantity')::numeric,
    (line->>'unit_price')::numeric,
    (line->>'line_total')::numeric,
    line->>'pack_size',
    line->>'selling_unit'
  from jsonb_array_elements(p_lines) as line;

  return to_jsonb(v_order);
end;
$$;
revoke all on function public.kerdos_submit_order(uuid,uuid,uuid,numeric,text,jsonb) from public;
grant execute on function public.kerdos_submit_order(uuid,uuid,uuid,numeric,text,jsonb) to authenticated;
