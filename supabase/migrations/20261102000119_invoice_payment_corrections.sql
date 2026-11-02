-- Immutable same-reference correction chains. Original root reservation remains.
alter table public.invoice_payments add column if not exists corrects_payment_id uuid unique references public.invoice_payments(id);
alter table public.invoice_payments add column if not exists correction_confirmed boolean not null default false;
alter table public.invoice_payments drop constraint if exists invoice_payments_invoice_id_reference_key_key;
create unique index if not exists invoice_payment_reference_roots on public.invoice_payments(invoice_id,reference_key) where corrects_payment_id is null;
grant insert(correction_confirmed) on public.invoice_payments to authenticated;
create or replace function public.kerdos_review_invoice_payment_core(p_organization_id uuid,p_invoice_id uuid,p_approval_id uuid,p_paid_cents bigint,p_paid_on date,p_method text,p_reference text,p_corrects_payment_id uuid,p_reason text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare a public.invoice_accounting_approvals%rowtype;s jsonb;total numeric;paid numeric;pc bigint;rc bigint;previous public.invoice_payments%rowtype;reversal public.invoice_payment_reversals%rowtype;correction jsonb;
begin
 if not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager membership is required to record payments';end if;
 if p_paid_cents is null or p_paid_cents<1 or p_paid_cents>9007199254740991 or p_paid_on is null or p_paid_on<date '0001-01-01' or p_paid_on>date '9999-12-31' or p_method is null or p_method not in ('check','bank_transfer','card','cash','other') or public.kerdos_valid_payment_reference(p_reference) is distinct from true then raise exception 'Review a positive exact payment amount, actual date, method and trimmed reference';end if;
 select * into a from public.invoice_accounting_approvals where id=p_approval_id and organization_id=p_organization_id and invoice_id=p_invoice_id;
 if not found or exists(select 1 from public.invoice_approval_withdrawals where approval_id=p_approval_id) then raise exception 'Choose a current non-withdrawn accounting approval';end if;
 s:=public.kerdos_review_invoice_reconciliation(p_organization_id,p_invoice_id);
 if a.source is distinct from s or public.kerdos_invoice_approval_gate(s)->'eligible' is distinct from 'true'::jsonb then raise exception 'Invoice needs current clean accounting approval before payment recording';end if;
 if p_corrects_payment_id is null then
  if exists(select 1 from public.invoice_payments where invoice_id=p_invoice_id and reference_key=lower(p_reference)) then raise exception 'Payment reference is already recorded, including reversed history';end if;
 else
  if public.kerdos_valid_approval_withdrawal_reason(p_reason) is distinct from true then raise exception 'Enter a trimmed correction reason of 10 to 500 characters';end if;
  select * into previous from public.invoice_payments where id=p_corrects_payment_id and organization_id=p_organization_id and invoice_id=p_invoice_id;
  if not found or previous.reference is distinct from p_reference then raise exception 'Correction must retain the original invoice and payment reference';end if;
  select * into reversal from public.invoice_payment_reversals where payment_id=previous.id;
  if not found then raise exception 'Reverse the original payment record before correcting it';end if;
  if exists(select 1 from public.invoice_payments where corrects_payment_id=previous.id) then raise exception 'Payment already has a correction; select the latest reversed record';end if;
  if exists(select 1 from public.invoice_payments q where q.invoice_id=p_invoice_id and q.reference_key=previous.reference_key and not exists(select 1 from public.invoice_payment_reversals r where r.payment_id=q.id)) then raise exception 'Reference already has an active payment record';end if;
  correction:=jsonb_build_object('paymentId',previous.id,'reversalId',reversal.id,'reason',p_reason);
 end if;
 total:=public.kerdos_invoice_money_cents(s->'header'->'recordedTotal');
 select coalesce(sum(p.paid_cents),0) into paid from public.invoice_payments p where p.invoice_id=p_invoice_id and not exists(select 1 from public.invoice_payment_reversals r where r.payment_id=p.id);
 select count(*) into pc from public.invoice_payments where invoice_id=p_invoice_id;
 select count(*) into rc from public.invoice_payment_reversals where invoice_id=p_invoice_id;
 if total is null or total<0 or paid>total or paid+p_paid_cents>total then raise exception 'Payment exceeds the remaining approved invoice balance';end if;
 return jsonb_build_object('kind','invoice_payment_review','version',1,'organizationId',p_organization_id,'invoiceId',p_invoice_id,'approvalId',a.id,'approval',a.snapshot,'amountCents',p_paid_cents,'paidOn',p_paid_on,'method',p_method,'reference',p_reference,'invoiceTotalCents',total,'recordedPaidCents',paid,'remainingCents',total-paid,'ledgerRevision',jsonb_build_object('payments',pc,'reversals',rc))||case when correction is null then '{}'::jsonb else jsonb_build_object('correction',correction) end;
end;
$$;
create or replace function public.kerdos_review_invoice_payment(p_organization_id uuid,p_invoice_id uuid,p_approval_id uuid,p_paid_cents bigint,p_paid_on date,p_method text,p_reference text)
returns jsonb language sql security invoker set search_path=public as $$
 select public.kerdos_review_invoice_payment_core(p_organization_id,p_invoice_id,p_approval_id,p_paid_cents,p_paid_on,p_method,p_reference,null,null);
$$;
create or replace function public.kerdos_review_invoice_payment_correction(p_organization_id uuid,p_invoice_id uuid,p_approval_id uuid,p_payment_id uuid,p_paid_cents bigint,p_paid_on date,p_method text,p_reason text)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare reference text;
begin
 select p.reference into reference from public.invoice_payments p where p.id=p_payment_id and p.organization_id=p_organization_id and p.invoice_id=p_invoice_id;
 if not found then raise exception 'Payment is outside this invoice or organization';end if;
 return public.kerdos_review_invoice_payment_core(p_organization_id,p_invoice_id,p_approval_id,p_paid_cents,p_paid_on,p_method,reference,p_payment_id,p_reason);
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
 if new.review?'correction' then
  if new.correction_confirmed is distinct from true then raise exception 'Explicitly confirm the payment correction';end if;
  new.corrects_payment_id:=(new.review->'correction'->>'paymentId')::uuid;
  fresh:=public.kerdos_review_invoice_payment_correction(new.organization_id,a.invoice_id,a.id,new.corrects_payment_id,(new.review->>'amountCents')::bigint,(new.review->>'paidOn')::date,new.review->>'method',new.review->'correction'->>'reason');
 else
  if new.correction_confirmed is distinct from false then raise exception 'Regular payment cannot claim correction consent';end if;
  new.corrects_payment_id:=null;
  fresh:=public.kerdos_review_invoice_payment(new.organization_id,a.invoice_id,a.id,(new.review->>'amountCents')::bigint,(new.review->>'paidOn')::date,new.review->>'method',new.review->>'reference');
 end if;
 if fresh is distinct from new.review then raise exception 'Payment source, balance or ledger history changed; review again';end if;
 if new.created_by is distinct from (select auth.uid()) or new.created_at is distinct from current_timestamp then raise exception 'Payment actor and time must match';end if;
 new.invoice_id:=a.invoice_id;new.paid_cents:=(fresh->>'amountCents')::bigint;new.paid_on:=(fresh->>'paidOn')::date;new.method:=fresh->>'method';new.reference:=fresh->>'reference';new.reference_key:=lower(new.reference);
 new.snapshot:=jsonb_build_object('kind','invoice_payment_record','version',1,'id',new.id,'organizationId',new.organization_id,'invoiceId',a.invoice_id,'approvalId',a.id,'requestId',new.request_id,'amountCents',new.paid_cents,'paidOn',new.paid_on,'method',new.method,'reference',new.reference,'invoiceTotalCents',fresh->'invoiceTotalCents','recordedBy',new.created_by,'recordedAt',new.created_at,'sourceReview',fresh);
 return new;
end;
$$;
create or replace function public.kerdos_save_invoice_payment_correction(p_organization_id uuid,p_request_id uuid,p_review jsonb,p_confirmed boolean,p_correction_confirmed boolean)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare saved public.invoice_payments%rowtype;invoice uuid:=(p_review->>'invoiceId')::uuid;
begin
 if not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager membership is required to record payments';end if;
 if p_correction_confirmed is distinct from true or not(p_review?'correction') then raise exception 'Explicitly confirm correction of a reversed payment record';end if;
 if p_confirmed is distinct from true then raise exception 'Confirm this payment was made elsewhere and belongs to this invoice';end if;
 perform 1 from public.purchase_order_lines l where l.id in(select order_line_id from public.estimated_order_receipts where organization_id=p_organization_id and invoice_id=invoice) order by l.id for update;
 perform 1 from public.invoices where id=invoice and organization_id=p_organization_id for update;
 if not found then raise exception 'Invoice is outside this organization';end if;
 select * into saved from public.invoice_payments where organization_id=p_organization_id and request_id=p_request_id;
 if found then
  if saved.invoice_id is distinct from invoice or saved.created_by is distinct from (select auth.uid()) or saved.review is distinct from p_review then raise exception 'Payment request belongs to different confirmed evidence';end if;
  return saved.snapshot;
 end if;
 insert into public.invoice_payments(organization_id,approval_id,request_id,review,confirmed,correction_confirmed) values(p_organization_id,(p_review->>'approvalId')::uuid,p_request_id,p_review,p_confirmed,p_correction_confirmed) returning * into saved;return saved.snapshot;
end;
$$;
revoke all on function public.kerdos_review_invoice_payment_core(uuid,uuid,uuid,bigint,date,text,text,uuid,text),public.kerdos_review_invoice_payment_correction(uuid,uuid,uuid,uuid,bigint,date,text,text),public.kerdos_save_invoice_payment_correction(uuid,uuid,jsonb,boolean,boolean) from public,anon,service_role;
grant execute on function public.kerdos_review_invoice_payment_core(uuid,uuid,uuid,bigint,date,text,text,uuid,text),public.kerdos_review_invoice_payment_correction(uuid,uuid,uuid,uuid,bigint,date,text,text),public.kerdos_save_invoice_payment_correction(uuid,uuid,jsonb,boolean,boolean) to authenticated;
