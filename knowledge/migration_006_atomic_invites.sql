-- KERDOS 006: consume an invitation and join its organization atomically.
-- The conditional update is the lock: only one caller can consume a code.

create or replace function kerdos_accept_invite(p_code text, p_user_id uuid)
returns table(organization_id uuid, role text)
language plpgsql
security definer
set search_path = pg_catalog
as $$
declare
  v_org uuid;
  v_role text;
begin
  if auth.uid() is null or p_user_id is distinct from auth.uid() then
    raise exception 'Invitation user does not match the signed-in user';
  end if;

  update public.invite_codes
  set used_by=p_user_id, used_at=now()
  where upper(code)=upper(trim(p_code)) and used_by is null
  returning invite_codes.organization_id, invite_codes.role into v_org,v_role;

  if v_org is null then raise exception 'Invitation code was not found or has already been used'; end if;

  insert into public.organization_members(organization_id,user_id,role)
  values(v_org,p_user_id,v_role)
  on conflict do nothing;

  return query select v_org,v_role;
end;
$$;

revoke all on function kerdos_accept_invite(text,uuid) from public;
grant execute on function kerdos_accept_invite(text,uuid) to authenticated;
