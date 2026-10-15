-- Category-scoped display numbers. UUIDs and vendor links never change.
create table if not exists public.catalog_number_history (
  organization_id uuid not null,
  master_item_number bigint not null,
  catalog_item_id uuid not null,
  category_id uuid,
  assigned_at timestamptz not null default now(),
  primary key (organization_id,master_item_number)
);
alter table public.catalog_number_history enable row level security;
drop policy if exists catalog_number_history_members on public.catalog_number_history;
create policy catalog_number_history_members on public.catalog_number_history for select to authenticated
  using (exists(select 1 from public.organization_members m where m.organization_id=catalog_number_history.organization_id and m.user_id=auth.uid()));
grant select on public.catalog_number_history to authenticated;
insert into public.catalog_number_history(organization_id,master_item_number,catalog_item_id,category_id)
 select organization_id,master_item_number,id,category_id from public.catalog_items where master_item_number is not null
 on conflict do nothing;

create or replace function public.kerdos_assign_category_number() returns trigger
language plpgsql security definer set search_path=public as $$
declare v_start bigint; v_end bigint; v_number bigint;
begin
  if tg_op='UPDATE' then
    if new.organization_id is distinct from old.organization_id then raise exception 'An item cannot move between organizations'; end if;
    if new.category_id is not distinct from old.category_id and exists (
      select 1 from public.catalog_categories c where c.id=new.category_id and c.organization_id=new.organization_id
       and old.master_item_number between c.range_start and c.range_end
    ) then
      new.master_item_number:=old.master_item_number;
      return new;
    end if;
  end if;
  if new.category_id is null then raise exception 'Choose a category before assigning a KERDOS item number'; end if;
  -- Serialize numbering within the organization, including overlapping ranges.
  perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text,20));
  select range_start,range_end into v_start,v_end from public.catalog_categories
   where id=new.category_id and organization_id=new.organization_id;
  if not found or v_start is null or v_start<=0 or v_end is null or v_end<v_start then raise exception 'This category needs a valid item-number range'; end if;
  if tg_op='UPDATE' and old.master_item_number is not null then
    insert into public.catalog_number_history(organization_id,master_item_number,catalog_item_id,category_id)
      values(old.organization_id,old.master_item_number,old.id,old.category_id) on conflict do nothing;
  end if;
  select coalesce(max(n)+1,v_start) into v_number from (
    select master_item_number n from public.catalog_number_history where organization_id=new.organization_id and master_item_number between v_start and v_end
    union all
    select master_item_number from public.catalog_items where organization_id=new.organization_id and master_item_number between v_start and v_end
  ) used;
  if v_number>v_end then raise exception 'This category item-number range is full; extend its range before moving or creating the item'; end if;
  new.master_item_number:=v_number;
  insert into public.catalog_number_history(organization_id,master_item_number,catalog_item_id,category_id)
    values(new.organization_id,v_number,new.id,new.category_id);
  return new;
end;
$$;
revoke all on function public.kerdos_assign_category_number() from public;
drop trigger if exists kerdos_category_number on public.catalog_items;
create trigger kerdos_category_number before insert or update on public.catalog_items
 for each row execute function public.kerdos_assign_category_number();

-- Repair old out-of-range numbers, including the legacy single-digit fallback.
-- Categories lacking ranges are left intact until their range is configured.
update public.catalog_items i set category_id=i.category_id
 from public.catalog_categories c
 where c.id=i.category_id and c.organization_id=i.organization_id
   and c.range_start is not null and c.range_end>=c.range_start
   and (i.master_item_number is null or i.master_item_number<c.range_start or i.master_item_number>c.range_end);
