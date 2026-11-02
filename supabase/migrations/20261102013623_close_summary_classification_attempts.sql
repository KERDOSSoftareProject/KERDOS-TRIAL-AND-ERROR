-- Permanent fences for an exact unconfirmed summary-save request. Source/history
-- need not advance; a late old client or direct insert must respect the fence.
create table if not exists public.invoice_summary_closed_attempts(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),invoice_id uuid not null references public.invoices(id),request_id uuid not null,
 review jsonb not null,confirmed boolean not null default false,created_by uuid not null default auth.uid(),created_at timestamptz not null default current_timestamp,snapshot jsonb not null,
 unique(organization_id,request_id)
);
create index if not exists invoice_summary_closed_invoice on public.invoice_summary_closed_attempts(invoice_id);
alter table public.invoice_summary_closed_attempts enable row level security;
revoke all on public.invoice_summary_closed_attempts from public,anon,authenticated,service_role;
grant select on public.invoice_summary_closed_attempts to authenticated;
grant insert(organization_id,invoice_id,request_id,review,confirmed) on public.invoice_summary_closed_attempts to authenticated;
drop policy if exists "summary closed members read" on public.invoice_summary_closed_attempts;
create policy "summary closed members read" on public.invoice_summary_closed_attempts for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=invoice_summary_closed_attempts.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "summary closed managers insert" on public.invoice_summary_closed_attempts;
create policy "summary closed managers insert" on public.invoice_summary_closed_attempts for insert to authenticated with check(created_by=(select auth.uid()) and exists(select 1 from public.organization_members m where m.organization_id=invoice_summary_closed_attempts.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager')));
create or replace function public.kerdos_guard_summary_request()
returns trigger language plpgsql security invoker set search_path=public as $$
declare previous uuid;expected jsonb;reason text;
begin
 if not exists(select 1 from public.organization_members where organization_id=new.organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager membership is required for summary save or closure';end if;
 if new.confirmed is distinct from true then raise exception 'Explicitly confirm summary save or closure';end if;
 if new.request_id is null then raise exception 'A stable summary request is required';end if;
 perform 1 from public.purchase_order_lines l where l.id in(select order_line_id from public.estimated_order_receipts where organization_id=new.organization_id and invoice_id=new.invoice_id) order by l.id for update;
 perform 1 from public.invoices where id=new.invoice_id and organization_id=new.organization_id for update;
 if not found then raise exception 'Invoice is outside this organization';end if;
 perform pg_advisory_xact_lock(hashtextextended(new.organization_id::text||':summary-classification:'||new.request_id::text,0));
 if new.created_by is distinct from (select auth.uid()) or new.created_at is distinct from current_timestamp then raise exception 'Summary actor and time must match';end if;
 if tg_table_name='invoice_summary_classifications' then
  if exists(select 1 from public.invoice_summary_closed_attempts where organization_id=new.organization_id and request_id=new.request_id) then raise exception 'This summary classification attempt is permanently closed';end if;
 else
  if exists(select 1 from public.invoice_summary_classifications where organization_id=new.organization_id and request_id=new.request_id) then raise exception 'A saved classification already exists; recover its result';end if;
  previous:=(new.review->>'previousId')::uuid;reason:=new.review->>'reason';
  if public.kerdos_valid_approval_withdrawal_reason(reason) is distinct from true then raise exception 'Retain the confirmed classification reason';end if;
  expected:=jsonb_build_object('kind','invoice_summary_classification_review','version',1,'organizationId',new.organization_id,'invoiceId',new.invoice_id,'basis',new.review->'basis','previousId',previous,'mappings',new.review->'mappings','reason',reason);
  if new.review is distinct from expected or (previous is not null and not exists(select 1 from public.invoice_summary_classifications where id=previous and organization_id=new.organization_id and invoice_id=new.invoice_id)) then raise exception 'Retain the exact scoped summary request to close';end if;
  perform public.kerdos_classified_invoice_summary(new.review->'basis',new.review->'mappings');
  new.snapshot:=jsonb_build_object('kind','invoice_summary_closed_attempt','version',1,'id',new.id,'organizationId',new.organization_id,'invoiceId',new.invoice_id,'requestId',new.request_id,'review',new.review,'closedBy',new.created_by,'closedAt',new.created_at);
 end if;
 return new;
end;
$$;
drop trigger if exists a_summary_request_guard on public.invoice_summary_classifications;
create trigger a_summary_request_guard before insert on public.invoice_summary_classifications for each row execute function public.kerdos_guard_summary_request();
drop trigger if exists a_summary_closed_request_guard on public.invoice_summary_closed_attempts;
create trigger a_summary_closed_request_guard before insert on public.invoice_summary_closed_attempts for each row execute function public.kerdos_guard_summary_request();
drop trigger if exists summary_closed_immutable on public.invoice_summary_closed_attempts;
create trigger summary_closed_immutable before update or delete on public.invoice_summary_closed_attempts for each row execute function public.kerdos_freeze_summary_classification();
create or replace function public.kerdos_close_summary_classification_attempt(p_organization_id uuid,p_invoice_id uuid,p_request_id uuid,p_review jsonb,p_requested_by uuid,p_confirmed boolean)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare saved public.invoice_summary_classifications%rowtype;closed public.invoice_summary_closed_attempts%rowtype;
begin
 if p_requested_by is null or p_requested_by is distinct from (select auth.uid()) then raise exception 'Retained classification request belongs to another signed-in user';end if;
 if not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager membership is required to close summary attempts';end if;
 if p_confirmed is distinct from true then raise exception 'Explicitly confirm closing this unconfirmed classification attempt';end if;
 if p_request_id is null then raise exception 'A stable summary request is required';end if;
 perform 1 from public.purchase_order_lines l where l.id in(select order_line_id from public.estimated_order_receipts where organization_id=p_organization_id and invoice_id=p_invoice_id) order by l.id for update;
 perform 1 from public.invoices where id=p_invoice_id and organization_id=p_organization_id for update;
 if not found then raise exception 'Invoice is outside this organization';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':summary-classification:'||p_request_id::text,0));
 select * into saved from public.invoice_summary_classifications where organization_id=p_organization_id and request_id=p_request_id;
 if found then
  if saved.invoice_id is distinct from p_invoice_id or saved.created_by is distinct from (select auth.uid()) or saved.review is distinct from p_review then raise exception 'Summary request belongs to different confirmed evidence';end if;
  return jsonb_build_object('status','saved','record',saved.snapshot);
 end if;
 select * into closed from public.invoice_summary_closed_attempts where organization_id=p_organization_id and request_id=p_request_id;
 if found then
  if closed.invoice_id is distinct from p_invoice_id or closed.created_by is distinct from (select auth.uid()) or closed.review is distinct from p_review then raise exception 'Summary request belongs to different confirmed evidence';end if;
 else
  insert into public.invoice_summary_closed_attempts(organization_id,invoice_id,request_id,review,confirmed) values(p_organization_id,p_invoice_id,p_request_id,p_review,p_confirmed) returning * into closed;
 end if;
 return jsonb_build_object('status','closed','attempt',closed.snapshot);
end;
$$;
create or replace function public.kerdos_review_summary_classification(p_organization_id uuid,p_invoice_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare result jsonb;
begin
 select jsonb_build_object('source',public.kerdos_review_invoice_reconciliation(p_organization_id,p_invoice_id),
 'history',(select coalesce(jsonb_agg(snapshot order by revision),'[]') from public.invoice_summary_classifications where organization_id=p_organization_id and invoice_id=p_invoice_id),
 'closedAttempts',(select coalesce(jsonb_agg(snapshot order by created_at,id),'[]') from public.invoice_summary_closed_attempts where organization_id=p_organization_id and invoice_id=p_invoice_id),
 'canClassify',exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager'))) into result;
 return result;
end;
$$;
revoke all on function public.kerdos_guard_summary_request(),public.kerdos_close_summary_classification_attempt(uuid,uuid,uuid,jsonb,uuid,boolean) from public,anon,service_role;
grant execute on function public.kerdos_guard_summary_request(),public.kerdos_close_summary_classification_attempt(uuid,uuid,uuid,jsonb,uuid,boolean) to authenticated;
