begin;

-- First-time setup must create the company and owner before member-only reads can work.
create or replace function kerdos_private.create_first_organization(
  p_name text, p_industry text, p_vendors jsonb
) returns public.organizations
language plpgsql security definer set search_path = '' as $$
declare
  actor uuid := auth.uid();
  company_name text := btrim(coalesce(p_name, ''));
  company_industry text := btrim(coalesce(p_industry, ''));
  company_slug text;
  company public.organizations;
  vendors_inserted integer;
begin
  if actor is null or coalesce(auth.jwt()->>'is_anonymous', 'false') = 'true' then
    raise exception using errcode = '42501', message = 'Sign in before setting up a company.';
  end if;
  if length(company_name) not between 1 and 200 or length(company_industry) > 200
     or jsonb_typeof(p_vendors) is distinct from 'array' then
    raise exception using errcode = '22023', message = 'Enter a company name and valid vendor details.';
  end if;
  if jsonb_array_length(p_vendors) > 100 then
    raise exception using errcode = '22023', message = 'Add up to 100 vendors during setup.';
  end if;

  -- Serializes retries for one account, including a retry after the original response was lost.
  perform pg_advisory_xact_lock(hashtextextended(actor::text, 0));
  select o.* into company
  from public.organization_members m
  join public.organizations o on o.id = m.organization_id
  where m.user_id = actor and m.role = 'owner'
    and o.name = company_name and o.industry is not distinct from company_industry
  order by o.created_at, o.id limit 1;
  if found then
    return company;
  end if;
  if exists (select 1 from public.organization_members where user_id = actor) then
    raise exception using errcode = '42501', message = 'This account already belongs to a company. Refresh KERDOS to open it.';
  end if;

  company_slug := trim(both '-' from regexp_replace(lower(company_name), '[^a-z0-9]+', '-', 'g'));
  insert into public.organizations (name, slug, industry)
  values (company_name, coalesce(nullif(company_slug, ''), 'company'), company_industry)
  on conflict (slug) do nothing
  returning * into company;
  if not found then
    insert into public.organizations (name, slug, industry)
    values (company_name, coalesce(nullif(company_slug, ''), 'company') || '-' || gen_random_uuid(), company_industry)
    returning * into company;
  end if;

  insert into public.organization_members (organization_id, user_id, role)
  values (company.id, actor, 'owner');

  insert into public.vendors (organization_id, name, delivery_minimum_dollar, delivery_minimum_units)
  select company.id, btrim(v.name), v.delivery_minimum_dollar, v.delivery_minimum_units
  from jsonb_to_recordset(p_vendors) as v(
    name text, delivery_minimum_dollar numeric, delivery_minimum_units integer
  )
  where length(btrim(v.name)) between 1 and 200
    and (v.delivery_minimum_dollar is null or v.delivery_minimum_dollar >= 0 and v.delivery_minimum_dollar < 'Infinity'::numeric)
    and (v.delivery_minimum_units is null or v.delivery_minimum_units >= 0);
  get diagnostics vendors_inserted = row_count;
  if vendors_inserted <> jsonb_array_length(p_vendors) then
    raise exception using errcode = '22023', message = 'Enter a vendor name and nonnegative order minimums.';
  end if;

  return company;
end;
$$;
revoke all on function kerdos_private.create_first_organization(text,text,jsonb) from public, anon, authenticated;
grant execute on function kerdos_private.create_first_organization(text,text,jsonb) to authenticated;

-- Parsed at definition time so authenticated users need no private schema access.
create or replace function public.kerdos_create_first_organization(
  p_name text, p_industry text, p_vendors jsonb
) returns jsonb
language sql security invoker set search_path = ''
return to_jsonb(kerdos_private.create_first_organization(p_name, p_industry, p_vendors));
revoke all on function public.kerdos_create_first_organization(text,text,jsonb) from public, anon, authenticated;
grant execute on function public.kerdos_create_first_organization(text,text,jsonb) to authenticated;

commit;
