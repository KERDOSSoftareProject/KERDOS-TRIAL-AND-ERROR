begin;

-- The available choices come from prepared industry data. Vocabulary is
-- provisioned in the same transaction as creating or changing the company.
create or replace function kerdos_private.require_industry_and_seed_vocabulary()
returns trigger
language plpgsql security invoker set search_path = '' as $$
declare
  chosen text := btrim(coalesce(new.industry, ''));
begin
  if chosen = '' then
    raise exception using errcode = '22023', message = 'Choose an industry.';
  end if;
  if not exists (
    select 1 from public.industry_templates t
    where lower(btrim(t.industry)) = lower(chosen)
      and exists (
        select 1 from public.industry_vocabulary v
        where lower(btrim(v.industry)) = lower(chosen)
      )
  ) then
    raise exception using errcode = '22023', message = 'Choose an industry from the list.';
  end if;

  insert into public.org_vocabulary (organization_id, kind, term, canonical)
  select new.id, v.kind, lower(btrim(v.term)), v.canonical
  from public.industry_vocabulary v
  where lower(btrim(v.industry)) = lower(chosen)
  on conflict (organization_id, kind, term) do nothing;
  return new;
end;
$$;

revoke all on function kerdos_private.require_industry_and_seed_vocabulary() from public, anon, authenticated;

drop trigger if exists require_industry_and_seed_vocabulary on public.organizations;
create trigger require_industry_and_seed_vocabulary
after insert or update of industry on public.organizations
for each row execute function kerdos_private.require_industry_and_seed_vocabulary();

commit;
