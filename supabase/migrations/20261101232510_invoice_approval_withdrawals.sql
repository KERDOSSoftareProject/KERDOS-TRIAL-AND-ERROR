-- Append-only withdrawal of one approval; a fresh approval remains a separate act.
create or replace function public.kerdos_valid_approval_withdrawal_reason(reason text)
returns boolean language sql immutable security invoker set search_path=public as $$
 select reason is not null and reason=btrim(reason,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') and char_length(reason) between 10 and 500;
$$;
create table if not exists public.invoice_approval_withdrawals(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),invoice_id uuid not null references public.invoices(id),
 approval_id uuid not null unique references public.invoice_accounting_approvals(id),reason text not null check(public.kerdos_valid_approval_withdrawal_reason(reason)),confirmed boolean not null default false,
 created_by uuid not null default auth.uid(),created_at timestamptz not null default current_timestamp,snapshot jsonb not null
);
create index if not exists approval_withdrawals_org on public.invoice_approval_withdrawals(organization_id);
create index if not exists approval_withdrawals_invoice on public.invoice_approval_withdrawals(invoice_id);
alter table public.invoice_approval_withdrawals enable row level security;
revoke all on public.invoice_approval_withdrawals from public,anon,authenticated,service_role;
grant select on public.invoice_approval_withdrawals to authenticated;
grant insert(organization_id,approval_id,reason,confirmed) on public.invoice_approval_withdrawals to authenticated;
drop policy if exists "withdrawal members read" on public.invoice_approval_withdrawals;
create policy "withdrawal members read" on public.invoice_approval_withdrawals for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=invoice_approval_withdrawals.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "withdrawal managers insert" on public.invoice_approval_withdrawals;
create policy "withdrawal managers insert" on public.invoice_approval_withdrawals for insert to authenticated with check(created_by=(select auth.uid()) and exists(select 1 from public.organization_members m where m.organization_id=invoice_approval_withdrawals.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager')));
create or replace function public.kerdos_prepare_approval_withdrawal()
returns trigger language plpgsql security invoker set search_path=public as $$
declare a public.invoice_accounting_approvals%rowtype;
begin
 if not exists(select 1 from public.organization_members where organization_id=new.organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager membership is required to withdraw approval';end if;
 if new.confirmed is distinct from true then raise exception 'Explicitly confirm accounting approval withdrawal';end if;
 if public.kerdos_valid_approval_withdrawal_reason(new.reason) is distinct from true then raise exception 'Enter a trimmed withdrawal reason of 10 to 500 characters';end if;
 select * into a from public.invoice_accounting_approvals where id=new.approval_id and organization_id=new.organization_id;
 if not found then raise exception 'Approval is outside this organization';end if;
 -- No order-line locks follow this header lock. Save and withdrawal serialize here.
 perform 1 from public.invoices where id=a.invoice_id and organization_id=new.organization_id for update;
 if not found then raise exception 'Approval invoice is unavailable';end if;
 if new.created_by is distinct from (select auth.uid()) or new.created_at is distinct from current_timestamp then raise exception 'Withdrawal actor and time must match';end if;
 new.invoice_id:=a.invoice_id;
 new.snapshot:=jsonb_build_object('kind','invoice_approval_withdrawal','version',1,'id',new.id,'organizationId',new.organization_id,'invoiceId',a.invoice_id,'approvalId',a.id,'reason',new.reason,'withdrawnBy',new.created_by,'withdrawnAt',new.created_at);
 return new;
end;
$$;
drop trigger if exists approval_withdrawal_prepare on public.invoice_approval_withdrawals;
create trigger approval_withdrawal_prepare before insert on public.invoice_approval_withdrawals for each row execute function public.kerdos_prepare_approval_withdrawal();
create or replace function public.kerdos_freeze_approval_withdrawal()
returns trigger language plpgsql security invoker set search_path=public as $$
begin raise exception 'Approval withdrawal history is immutable';end;
$$;
drop trigger if exists approval_withdrawal_immutable on public.invoice_approval_withdrawals;
create trigger approval_withdrawal_immutable before update or delete on public.invoice_approval_withdrawals for each row execute function public.kerdos_freeze_approval_withdrawal();
create or replace function public.kerdos_withdraw_invoice_approval(p_organization_id uuid,p_approval_id uuid,p_reason text,p_confirmed boolean)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare a public.invoice_accounting_approvals%rowtype;s public.invoice_approval_withdrawals%rowtype;
begin
 if not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager membership is required to withdraw approval';end if;
 if p_confirmed is distinct from true then raise exception 'Explicitly confirm accounting approval withdrawal';end if;
 if public.kerdos_valid_approval_withdrawal_reason(p_reason) is distinct from true then raise exception 'Enter a trimmed withdrawal reason of 10 to 500 characters';end if;
 select * into a from public.invoice_accounting_approvals where id=p_approval_id and organization_id=p_organization_id;
 if not found then raise exception 'Approval is outside this organization';end if;
 perform 1 from public.invoices where id=a.invoice_id and organization_id=p_organization_id for update;
 select * into s from public.invoice_approval_withdrawals where approval_id=a.id;
 if found then
  if s.created_by is distinct from (select auth.uid()) or s.reason is distinct from p_reason then raise exception 'Approval already withdrawn by a different confirmed request; refresh history';end if;
  return s.snapshot;
 end if;
 insert into public.invoice_approval_withdrawals(organization_id,approval_id,reason,confirmed) values(p_organization_id,p_approval_id,p_reason,p_confirmed) returning * into s;return s.snapshot;
end;
$$;
create or replace function public.kerdos_review_invoice_approval_audit(p_organization_id uuid,p_invoice_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare s jsonb;history jsonb;can_approve boolean;
begin
 s:=public.kerdos_review_invoice_reconciliation(p_organization_id,p_invoice_id);
 select jsonb_build_object('approvals',(select coalesce(jsonb_agg(snapshot order by created_at,id),'[]') from public.invoice_accounting_approvals where organization_id=p_organization_id and invoice_id=p_invoice_id),'withdrawals',(select coalesce(jsonb_agg(snapshot order by created_at,id),'[]') from public.invoice_approval_withdrawals where organization_id=p_organization_id and invoice_id=p_invoice_id)) into history;
 select exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) into can_approve;
 return history||jsonb_build_object('source',s,'gate',public.kerdos_invoice_approval_gate(s),'canApprove',can_approve);
end;
$$;
-- Legacy readers cannot count a withdrawn approval as current. New readers retain full audit.
create or replace function public.kerdos_review_invoice_approval(p_organization_id uuid,p_invoice_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare result jsonb;active jsonb;
begin
 result:=public.kerdos_review_invoice_approval_audit(p_organization_id,p_invoice_id);
 select coalesce(jsonb_agg(a.value order by a.ordinality),'[]') into active from jsonb_array_elements(result->'approvals') with ordinality a where not exists(select 1 from jsonb_array_elements(result->'withdrawals') w where w.value->>'approvalId'=a.value->>'id');
 return result||jsonb_build_object('approvals',active,'withdrawals','[]'::jsonb);
end;
$$;
revoke all on function public.kerdos_valid_approval_withdrawal_reason(text),public.kerdos_prepare_approval_withdrawal(),public.kerdos_freeze_approval_withdrawal(),public.kerdos_withdraw_invoice_approval(uuid,uuid,text,boolean),public.kerdos_review_invoice_approval_audit(uuid,uuid) from public,anon,service_role;
grant execute on function public.kerdos_valid_approval_withdrawal_reason(text),public.kerdos_prepare_approval_withdrawal(),public.kerdos_freeze_approval_withdrawal(),public.kerdos_withdraw_invoice_approval(uuid,uuid,text,boolean),public.kerdos_review_invoice_approval_audit(uuid,uuid) to authenticated;
