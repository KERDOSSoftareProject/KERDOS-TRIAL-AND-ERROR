-- A stable, organization/vendor-scoped number only when the vendor supplied
-- no item code. The shared KERDOS catalog number remains separate.
create table if not exists public.vendor_nvim_counters (
  organization_id uuid not null,
  vendor_id uuid not null,
  last_number bigint not null check (last_number > 0),
  primary key (organization_id, vendor_id)
);
alter table public.vendor_nvim_counters enable row level security;
revoke all on public.vendor_nvim_counters from anon, authenticated;

alter table public.vendor_items add column if not exists nvim_number bigint;

-- Assign existing listings once. Their order here is deterministic; future
-- numbers are allocated by a locked, transactional counter at insertion.
with numbered as (
  select vi.id,
    row_number() over (partition by vi.organization_id, vi.vendor_id
      order by nullif(to_jsonb(vi)->>'created_at','')::timestamptz nulls last,vi.id)
      + coalesce((select max(saved.nvim_number) from public.vendor_items saved
        where saved.organization_id=vi.organization_id and saved.vendor_id=vi.vendor_id),0) as number
  from public.vendor_items vi
  where vi.nvim_number is null and nullif(btrim(vi.vendor_item_code),'') is null
)
update public.vendor_items vi set nvim_number=numbered.number
from numbered where vi.id=numbered.id;

create unique index if not exists vendor_items_nvim_unique
  on public.vendor_items(organization_id,vendor_id,nvim_number);

insert into public.vendor_nvim_counters (organization_id,vendor_id,last_number)
select organization_id,vendor_id,max(nvim_number)
from public.vendor_items group by organization_id,vendor_id
having max(nvim_number) is not null
on conflict (organization_id,vendor_id) do update
  set last_number=greatest(public.vendor_nvim_counters.last_number,excluded.last_number);

create or replace function public.kerdos_assign_vendor_nvim()
returns trigger language plpgsql security definer set search_path=pg_catalog as $$
begin
  if tg_op='UPDATE' then
    if new.organization_id is distinct from old.organization_id
       or new.vendor_id is distinct from old.vendor_id then
      raise exception 'A vendor listing cannot change its organization or vendor';
    end if;
    if old.nvim_number is not null then
      if new.nvim_number is distinct from old.nvim_number then
        raise exception 'A vendor listing NVIM cannot change';
      end if;
      return new;
    end if;
  end if;
  if new.nvim_number is not null then
    raise exception 'A vendor listing NVIM is assigned by KERDOS';
  end if;
  if nullif(btrim(new.vendor_item_code),'') is not null then
    return new;
  end if;
  insert into public.vendor_nvim_counters (organization_id,vendor_id,last_number)
  values (new.organization_id,new.vendor_id,1)
  on conflict (organization_id,vendor_id) do update
    set last_number=public.vendor_nvim_counters.last_number+1
  returning last_number into new.nvim_number;
  return new;
end;
$$;

drop trigger if exists vendor_items_assign_nvim on public.vendor_items;
create trigger vendor_items_assign_nvim
before insert or update on public.vendor_items
for each row execute function public.kerdos_assign_vendor_nvim();
