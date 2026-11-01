-- Manual records of payments made elsewhere. No transfer or bank integration.
create or replace function public.kerdos_valid_payment_reference(reference text)
returns boolean language sql immutable security invoker set search_path=public as $$
 select reference is not null and reference=btrim(reference,U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF') and char_length(reference) between 1 and 200;
$$;
create table if not exists public.invoice_payments(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),invoice_id uuid not null references public.invoices(id),
 approval_id uuid not null references public.invoice_accounting_approvals(id),request_id uuid not null,
 paid_cents bigint not null check(paid_cents between 1 and 9007199254740991),paid_on date not null,method text not null check(method in ('check','bank_transfer','card','cash','other')),
 reference text not null check(public.kerdos_valid_payment_reference(reference)),reference_key text not null,
 review jsonb not null,confirmed boolean not null default false,created_by uuid not null default auth.uid(),created_at timestamptz not null default current_timestamp,snapshot jsonb not null,
 unique(organization_id,request_id),unique(invoice_id,reference_key)
);
create index if not exists invoice_payments_approval on public.invoice_payments(approval_id);
create table if not exists public.invoice_payment_reversals(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),invoice_id uuid not null references public.invoices(id),payment_id uuid not null unique references public.invoice_payments(id),
 reason text not null check(public.kerdos_valid_approval_withdrawal_reason(reason)),confirmed boolean not null default false,created_by uuid not null default auth.uid(),created_at timestamptz not null default current_timestamp,snapshot jsonb not null
);
create index if not exists invoice_payment_reversals_org on public.invoice_payment_reversals(organization_id);
create index if not exists invoice_payment_reversals_invoice on public.invoice_payment_reversals(invoice_id);
alter table public.invoice_payments enable row level security;
alter table public.invoice_payment_reversals enable row level security;
revoke all on public.invoice_payments,public.invoice_payment_reversals from public,anon,authenticated,service_role;
grant select on public.invoice_payments,public.invoice_payment_reversals to authenticated;
grant insert(organization_id,approval_id,request_id,review,confirmed) on public.invoice_payments to authenticated;
grant insert(organization_id,payment_id,reason,confirmed) on public.invoice_payment_reversals to authenticated;
drop policy if exists "payment members read" on public.invoice_payments;
create policy "payment members read" on public.invoice_payments for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=invoice_payments.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "payment managers insert" on public.invoice_payments;
create policy "payment managers insert" on public.invoice_payments for insert to authenticated with check(created_by=(select auth.uid()) and exists(select 1 from public.organization_members m where m.organization_id=invoice_payments.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager')));
drop policy if exists "payment reversal members read" on public.invoice_payment_reversals;
create policy "payment reversal members read" on public.invoice_payment_reversals for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=invoice_payment_reversals.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "payment reversal managers insert" on public.invoice_payment_reversals;
create policy "payment reversal managers insert" on public.invoice_payment_reversals for insert to authenticated with check(created_by=(select auth.uid()) and exists(select 1 from public.organization_members m where m.organization_id=invoice_payment_reversals.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager')));
create or replace function public.kerdos_review_invoice_payment(p_organization_id uuid,p_invoice_id uuid,p_approval_id uuid,p_paid_cents bigint,p_paid_on date,p_method text,p_reference text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare a public.invoice_accounting_approvals%rowtype;s jsonb;total numeric;paid numeric;pc bigint;rc bigint;
begin
 if not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager membership is required to record payments';end if;
 if p_paid_cents is null or p_paid_cents<1 or p_paid_cents>9007199254740991 or p_paid_on is null or p_paid_on<date '0001-01-01' or p_paid_on>date '9999-12-31' or p_method is null or p_method not in ('check','bank_transfer','card','cash','other') or public.kerdos_valid_payment_reference(p_reference) is distinct from true then raise exception 'Review a positive exact payment amount, actual date, method and trimmed reference';end if;
 select * into a from public.invoice_accounting_approvals where id=p_approval_id and organization_id=p_organization_id and invoice_id=p_invoice_id;
 if not found or exists(select 1 from public.invoice_approval_withdrawals where approval_id=p_approval_id) then raise exception 'Choose a current non-withdrawn accounting approval';end if;
 s:=public.kerdos_review_invoice_reconciliation(p_organization_id,p_invoice_id);
 if a.source is distinct from s or public.kerdos_invoice_approval_gate(s)->'eligible' is distinct from 'true'::jsonb then raise exception 'Invoice needs current clean accounting approval before payment recording';end if;
 if exists(select 1 from public.invoice_payments where invoice_id=p_invoice_id and reference_key=lower(p_reference)) then raise exception 'Payment reference is already recorded, including reversed history';end if;
 total:=public.kerdos_invoice_money_cents(s->'header'->'recordedTotal');
 select coalesce(sum(p.paid_cents),0) into paid from public.invoice_payments p where p.invoice_id=p_invoice_id and not exists(select 1 from public.invoice_payment_reversals r where r.payment_id=p.id);
 select count(*) into pc from public.invoice_payments where invoice_id=p_invoice_id;
 select count(*) into rc from public.invoice_payment_reversals where invoice_id=p_invoice_id;
 if total is null or total<0 or paid>total or paid+p_paid_cents>total then raise exception 'Payment exceeds the remaining approved invoice balance';end if;
 return jsonb_build_object('kind','invoice_payment_review','version',1,'organizationId',p_organization_id,'invoiceId',p_invoice_id,'approvalId',a.id,'approval',a.snapshot,'amountCents',p_paid_cents,'paidOn',p_paid_on,'method',p_method,'reference',p_reference,'invoiceTotalCents',total,'recordedPaidCents',paid,'remainingCents',total-paid,'ledgerRevision',jsonb_build_object('payments',pc,'reversals',rc));
end;
$$;
create or replace function public.kerdos_prepare_invoice_payment()
returns trigger language plpgsql security invoker set search_path=public as $$
declare a public.invoice_accounting_approvals%rowtype;fresh jsonb;
begin
 if new.confirmed is distinct from true then raise exception 'Confirm this payment was made elsewhere and belongs to this invoice';end if;
 select * into a from public.invoice_accounting_approvals where id=new.approval_id and organization_id=new.organization_id;
 if not found then raise exception 'Approval is outside this organization';end if;
 -- Same order as approval/receiving. Pins receipt evidence, withdrawal and new payment records.
 perform 1 from public.purchase_order_lines l where l.id in(select order_line_id from public.estimated_order_receipts where organization_id=new.organization_id and invoice_id=a.invoice_id) order by l.id for update;
 perform 1 from public.invoices where id=a.invoice_id and organization_id=new.organization_id for update;
 fresh:=public.kerdos_review_invoice_payment(new.organization_id,a.invoice_id,a.id,(new.review->>'amountCents')::bigint,(new.review->>'paidOn')::date,new.review->>'method',new.review->>'reference');
 if fresh is distinct from new.review then raise exception 'Payment source, balance or ledger history changed; review again';end if;
 if new.created_by is distinct from (select auth.uid()) or new.created_at is distinct from current_timestamp then raise exception 'Payment actor and time must match';end if;
 new.invoice_id:=a.invoice_id;new.paid_cents:=(fresh->>'amountCents')::bigint;new.paid_on:=(fresh->>'paidOn')::date;new.method:=fresh->>'method';new.reference:=fresh->>'reference';new.reference_key:=lower(new.reference);
 new.snapshot:=jsonb_build_object('kind','invoice_payment_record','version',1,'id',new.id,'organizationId',new.organization_id,'invoiceId',a.invoice_id,'approvalId',a.id,'requestId',new.request_id,'amountCents',new.paid_cents,'paidOn',new.paid_on,'method',new.method,'reference',new.reference,'invoiceTotalCents',fresh->'invoiceTotalCents','recordedBy',new.created_by,'recordedAt',new.created_at,'sourceReview',fresh);
 return new;
end;
$$;
drop trigger if exists invoice_payment_prepare on public.invoice_payments;
create trigger invoice_payment_prepare before insert on public.invoice_payments for each row execute function public.kerdos_prepare_invoice_payment();
create or replace function public.kerdos_freeze_invoice_payment_history()
returns trigger language plpgsql security invoker set search_path=public as $$
begin raise exception 'Invoice payment and reversal history is immutable';end;
$$;
drop trigger if exists invoice_payment_immutable on public.invoice_payments;
create trigger invoice_payment_immutable before update or delete on public.invoice_payments for each row execute function public.kerdos_freeze_invoice_payment_history();
drop trigger if exists invoice_payment_reversal_immutable on public.invoice_payment_reversals;
create trigger invoice_payment_reversal_immutable before update or delete on public.invoice_payment_reversals for each row execute function public.kerdos_freeze_invoice_payment_history();
create or replace function public.kerdos_save_invoice_payment(p_organization_id uuid,p_request_id uuid,p_review jsonb,p_confirmed boolean)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare saved public.invoice_payments%rowtype;invoice uuid:=(p_review->>'invoiceId')::uuid;
begin
 if not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager membership is required to record payments';end if;
 if p_confirmed is distinct from true then raise exception 'Confirm this payment was made elsewhere and belongs to this invoice';end if;
 perform 1 from public.purchase_order_lines l where l.id in(select order_line_id from public.estimated_order_receipts where organization_id=p_organization_id and invoice_id=invoice) order by l.id for update;
 perform 1 from public.invoices where id=invoice and organization_id=p_organization_id for update;
 if not found then raise exception 'Invoice is outside this organization';end if;
 select * into saved from public.invoice_payments where organization_id=p_organization_id and request_id=p_request_id;
 if found then
  if saved.invoice_id is distinct from invoice or saved.created_by is distinct from (select auth.uid()) or saved.review is distinct from p_review then raise exception 'Payment request belongs to different confirmed evidence';end if;
  return saved.snapshot;
 end if;
 insert into public.invoice_payments(organization_id,approval_id,request_id,review,confirmed) values(p_organization_id,(p_review->>'approvalId')::uuid,p_request_id,p_review,p_confirmed) returning * into saved;return saved.snapshot;
end;
$$;
create or replace function public.kerdos_prepare_invoice_payment_reversal()
returns trigger language plpgsql security invoker set search_path=public as $$
declare p public.invoice_payments%rowtype;
begin
 if not exists(select 1 from public.organization_members where organization_id=new.organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager membership is required to reverse payment records';end if;
 if new.confirmed is distinct from true or public.kerdos_valid_approval_withdrawal_reason(new.reason) is distinct from true then raise exception 'Confirm reversal with a trimmed reason of 10 to 500 characters';end if;
 select * into p from public.invoice_payments where id=new.payment_id and organization_id=new.organization_id;
 if not found then raise exception 'Payment is outside this organization';end if;
 perform 1 from public.invoices where id=p.invoice_id and organization_id=new.organization_id for update;
 if new.created_by is distinct from (select auth.uid()) or new.created_at is distinct from current_timestamp then raise exception 'Reversal actor and time must match';end if;
 new.invoice_id:=p.invoice_id;
 new.snapshot:=jsonb_build_object('kind','invoice_payment_reversal','version',1,'id',new.id,'organizationId',p.organization_id,'invoiceId',p.invoice_id,'paymentId',p.id,'amountCents',p.paid_cents,'reason',new.reason,'reversedBy',new.created_by,'reversedAt',new.created_at);return new;
end;
$$;
drop trigger if exists invoice_payment_reversal_prepare on public.invoice_payment_reversals;
create trigger invoice_payment_reversal_prepare before insert on public.invoice_payment_reversals for each row execute function public.kerdos_prepare_invoice_payment_reversal();
create or replace function public.kerdos_reverse_invoice_payment(p_organization_id uuid,p_payment_id uuid,p_reason text,p_confirmed boolean)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare p public.invoice_payments%rowtype;r public.invoice_payment_reversals%rowtype;
begin
 if not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager membership is required to reverse payment records';end if;
 if p_confirmed is distinct from true or public.kerdos_valid_approval_withdrawal_reason(p_reason) is distinct from true then raise exception 'Confirm reversal with a trimmed reason of 10 to 500 characters';end if;
 select * into p from public.invoice_payments where id=p_payment_id and organization_id=p_organization_id;
 if not found then raise exception 'Payment is outside this organization';end if;
 perform 1 from public.invoices where id=p.invoice_id and organization_id=p_organization_id for update;
 select * into r from public.invoice_payment_reversals where payment_id=p_payment_id;
 if found then
  if r.created_by is distinct from (select auth.uid()) or r.reason is distinct from p_reason then raise exception 'Payment already reversed by a different confirmed request';end if;return r.snapshot;
 end if;
 insert into public.invoice_payment_reversals(organization_id,payment_id,reason,confirmed) values(p_organization_id,p_payment_id,p_reason,p_confirmed) returning * into r;return r.snapshot;
end;
$$;
create or replace function public.kerdos_invoice_payment_ledger(p_organization_id uuid,p_invoice_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare approval_review jsonb;history jsonb;
begin
 approval_review:=public.kerdos_review_invoice_approval_audit(p_organization_id,p_invoice_id);
 select jsonb_build_object('payments',(select coalesce(jsonb_agg(snapshot order by created_at,id),'[]') from public.invoice_payments where organization_id=p_organization_id and invoice_id=p_invoice_id),'reversals',(select coalesce(jsonb_agg(snapshot order by created_at,id),'[]') from public.invoice_payment_reversals where organization_id=p_organization_id and invoice_id=p_invoice_id)) into history;
 return history||jsonb_build_object('approvalReview',approval_review);
end;
$$;
revoke all on function public.kerdos_valid_payment_reference(text),public.kerdos_review_invoice_payment(uuid,uuid,uuid,bigint,date,text,text),public.kerdos_prepare_invoice_payment(),public.kerdos_freeze_invoice_payment_history(),public.kerdos_save_invoice_payment(uuid,uuid,jsonb,boolean),public.kerdos_prepare_invoice_payment_reversal(),public.kerdos_reverse_invoice_payment(uuid,uuid,text,boolean),public.kerdos_invoice_payment_ledger(uuid,uuid) from public,anon,service_role;
grant execute on function public.kerdos_valid_payment_reference(text),public.kerdos_review_invoice_payment(uuid,uuid,uuid,bigint,date,text,text),public.kerdos_prepare_invoice_payment(),public.kerdos_freeze_invoice_payment_history(),public.kerdos_save_invoice_payment(uuid,uuid,jsonb,boolean),public.kerdos_prepare_invoice_payment_reversal(),public.kerdos_reverse_invoice_payment(uuid,uuid,text,boolean),public.kerdos_invoice_payment_ledger(uuid,uuid) to authenticated;
