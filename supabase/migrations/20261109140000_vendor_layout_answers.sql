-- Persist only a vendor's answered header layout. Organization rows have a
-- read policy but no client UPDATE policy; a whole-settings update cannot save.
create or replace function public.kerdos_remember_vendor_layout(
  p_organization_id uuid, p_vendor_id uuid, p_fingerprint text, p_answers jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare result jsonb;
begin
  if auth.uid() is null or not exists (
    select 1 from public.organization_members m
    where m.organization_id=p_organization_id and m.user_id=auth.uid()
      and m.role in ('owner','manager')
  ) or not exists (
    select 1 from public.vendors v
    where v.id=p_vendor_id and v.organization_id=p_organization_id and v.is_active
  ) then
    raise exception using errcode='42501', message='vendor_layout_access_denied';
  end if;
  if p_fingerprint is null or length(p_fingerprint) not between 1 and 1000
    or jsonb_typeof(p_answers) is distinct from 'object'
    or (select count(*) from jsonb_object_keys(p_answers)) not between 1 and 100
    or exists (
      select 1 from jsonb_each_text(p_answers) a
      where a.key !~ '^(0|[1-9][0-9]?)$'
        or a.value not in ('description','code','brand','packSize','sellingUnit','price','gtin','mfrCode','qty','amount','ignore')
    ) then
    raise exception using errcode='22023', message='invalid_vendor_layout_answer';
  end if;
  update public.organizations o set settings=jsonb_set(
    coalesce(o.settings,'{}'::jsonb), '{vendorLayouts}',
    coalesce(o.settings->'vendorLayouts','{}'::jsonb) || jsonb_build_object(
      p_vendor_id::text,
      coalesce(o.settings->'vendorLayouts'->(p_vendor_id::text),'{}'::jsonb) || jsonb_build_object(
        p_fingerprint,
        coalesce(o.settings #> array['vendorLayouts',p_vendor_id::text,p_fingerprint],'{}'::jsonb) || p_answers
      )
    ), true
  ) where o.id=p_organization_id returning o.settings into result;
  if not found then raise exception using errcode='42501',message='vendor_layout_access_denied'; end if;
  return result;
end; $$;
revoke all on function public.kerdos_remember_vendor_layout(uuid,uuid,text,jsonb) from public,anon,authenticated;
grant execute on function public.kerdos_remember_vendor_layout(uuid,uuid,text,jsonb) to authenticated;
