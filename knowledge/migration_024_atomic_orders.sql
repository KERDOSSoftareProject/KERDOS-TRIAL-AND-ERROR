-- Record an order and all lines in a single transaction.
alter table public.purchase_order_lines add column if not exists order_unit text;
alter table public.purchase_order_lines add column if not exists pack_size text;
create or replace function public.kerdos_submit_order(
 p_organization_id uuid,p_vendor_id uuid,p_created_by uuid,p_total_amount numeric,
 p_notes text default null,p_lines jsonb default '[]'::jsonb
) returns jsonb language plpgsql set search_path=public as $$
declare v_order public.purchase_orders%rowtype; v_line jsonb; v_total numeric:=0;
begin
 if auth.uid() is null or p_created_by is distinct from auth.uid() then raise exception 'Authentication must match the order creator'; end if;
 if not exists(select 1 from organization_members where organization_id=p_organization_id and user_id=auth.uid() and role in ('owner','manager','employee')) then raise exception 'Organization membership is required'; end if;
 if not exists(select 1 from vendors where id=p_vendor_id and organization_id=p_organization_id) then raise exception 'Vendor is outside the organization'; end if;
 if p_lines is null or jsonb_typeof(p_lines)<>'array' or jsonb_array_length(p_lines)=0 then raise exception 'An order needs line items'; end if;
 for v_line in select value from jsonb_array_elements(p_lines) loop
  if coalesce((v_line->>'quantity')::numeric,0)<=0 or coalesce((v_line->>'unit_price')::numeric,0)<=0 or coalesce(v_line->>'order_unit','') not in ('case','each') then raise exception 'Each line needs a positive quantity, price and purchasing unit'; end if;
  if not exists(select 1 from vendor_items vi join item_mappings m on m.vendor_item_id=vi.id join catalog_items ci on ci.id=m.catalog_item_id where vi.id=(v_line->>'vendor_item_id')::uuid and vi.vendor_id=p_vendor_id and vi.organization_id=p_organization_id and m.organization_id=p_organization_id and ci.id=(v_line->>'catalog_item_id')::uuid and ci.organization_id=p_organization_id) then raise exception 'Order line is outside the vendor or catalog'; end if;
  if (v_line->>'line_total')::numeric is distinct from round((v_line->>'quantity')::numeric*(v_line->>'unit_price')::numeric,2) then raise exception 'Order line total does not match its quantity and price'; end if;
  v_total:=v_total+(v_line->>'line_total')::numeric;
 end loop;
 if p_total_amount is distinct from round(v_total,2) then raise exception 'Order total does not match its lines'; end if;
 insert into purchase_orders(organization_id,vendor_id,created_by,status,total_amount,notes)
 values(p_organization_id,p_vendor_id,auth.uid(),'submitted',v_total,p_notes) returning * into v_order;
 insert into purchase_order_lines(purchase_order_id,catalog_item_id,vendor_item_id,quantity,unit_price,line_total,order_unit,pack_size)
 select v_order.id,(line->>'catalog_item_id')::uuid,(line->>'vendor_item_id')::uuid,
 (line->>'quantity')::numeric,(line->>'unit_price')::numeric,(line->>'line_total')::numeric,line->>'order_unit',line->>'pack_size'
 from jsonb_array_elements(p_lines) line;
 return to_jsonb(v_order);
end;
$$;
revoke all on function public.kerdos_submit_order(uuid,uuid,uuid,numeric,text,jsonb) from public;
grant execute on function public.kerdos_submit_order(uuid,uuid,uuid,numeric,text,jsonb) to authenticated;
