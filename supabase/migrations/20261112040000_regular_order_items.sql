create index if not exists purchase_orders_regular_items_idx
  on public.purchase_orders (organization_id, (coalesce(submitted_at, created_at)) desc, id desc)
  where status = 'submitted';

create index if not exists purchase_order_lines_regular_items_idx
  on public.purchase_order_lines (purchase_order_id, catalog_item_id)
  where quantity > 0;

create or replace function public.kerdos_regular_item_ids(
  p_organization_id uuid,
  p_min_orders integer default 2,
  p_order_window integer default 5,
  p_max_gap_days integer default 60
)
returns table(catalog_item_id uuid)
language plpgsql
stable
security invoker
set search_path = ''
as $$
begin
  if not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = (select auth.uid())
  ) then
    raise exception 'Access denied to organization order history' using errcode = '42501';
  end if;

  if p_min_orders is null or p_order_window is null or p_max_gap_days is null
     or p_min_orders < 1 or p_order_window < p_min_orders or p_max_gap_days < 1 then
    raise exception 'Invalid regular-order thresholds' using errcode = '22023';
  end if;

  return query
  with recursive recent_orders as (
    select po.id, coalesce(po.submitted_at, po.created_at) as executed_at
    from public.purchase_orders po
    where po.organization_id = p_organization_id and po.status = 'submitted'
      and coalesce(po.submitted_at, po.created_at) is not null
    order by executed_at desc, po.id desc
    limit p_order_window
  ), order_items as (
    select distinct r.id as order_id, r.executed_at, c.id as item_id, c.merged_into_id
    from recent_orders r
    join public.purchase_order_lines l on l.purchase_order_id = r.id and l.quantity > 0
    join public.catalog_items c on c.id = l.catalog_item_id and c.organization_id = p_organization_id
    union
    select i.order_id, i.executed_at, c.id, c.merged_into_id
    from order_items i
    join public.catalog_items c on c.id = i.merged_into_id and c.organization_id = p_organization_id
  )
  select i.item_id
  from order_items i
  where i.merged_into_id is null
  group by i.item_id
  having count(distinct i.order_id) >= p_min_orders
     and max(i.executed_at) >= current_timestamp - make_interval(days => p_max_gap_days)
  order by i.item_id;
end;
$$;

revoke all on function public.kerdos_regular_item_ids(uuid, integer, integer, integer) from public, anon;
grant execute on function public.kerdos_regular_item_ids(uuid, integer, integer, integer) to authenticated;
