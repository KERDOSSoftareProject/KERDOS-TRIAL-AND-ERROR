-- Recovery binds the retained actor to the actual authenticated request, including
-- account changes between a browser preflight and the RPC reaching PostgreSQL.
create or replace function public.kerdos_save_summary_classification_as_actor(p_organization_id uuid,p_invoice_id uuid,p_request_id uuid,p_review jsonb,p_requested_by uuid,p_confirmed boolean)
returns jsonb language plpgsql security invoker set search_path=public as $$
begin
 if p_requested_by is null or p_requested_by is distinct from (select auth.uid()) then raise exception 'Retained classification request belongs to another signed-in user';end if;
 return public.kerdos_save_summary_classification(p_organization_id,p_invoice_id,p_request_id,p_review,p_confirmed);
end;
$$;
revoke all on function public.kerdos_save_summary_classification_as_actor(uuid,uuid,uuid,jsonb,uuid,boolean) from public,anon,service_role;
grant execute on function public.kerdos_save_summary_classification_as_actor(uuid,uuid,uuid,jsonb,uuid,boolean) to authenticated;
