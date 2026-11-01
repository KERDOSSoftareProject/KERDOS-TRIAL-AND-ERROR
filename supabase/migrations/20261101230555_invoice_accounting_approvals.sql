-- Server-side independent approval gate. Client eligibility is never authority.
create or replace function public.kerdos_invoice_money_cents(v jsonb)
returns numeric language plpgsql immutable security invoker set search_path=public as $$
declare s text:=v#>>'{}'; n numeric;
begin
 if s is null or char_length(s)>32 or s!~'^-?[0-9]+([.][0-9]{1,2})?$' then return null;end if;
 n:=s::numeric;if jsonb_typeof(v)='number' and abs(n)>1000000000000 then return null;end if;
 n:=n*100;if abs(n)>9007199254740991 then return null;end if;return n;
end;
$$;
create or replace function public.kerdos_invoice_approval_gate(s jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=public as $$
declare l jsonb;r jsonb;raw text;m text[];label text;kind text;money text;n numeric;lines_total numeric:=0;adjusted numeric;amounts jsonb:='{}';seen text[]:='{}';keys text[]:='{}';k text;reasons text[]:='{}';active integer;
begin
 if s->>'kind'<>'invoice_reconciliation_source' or jsonb_typeof(s->'lines')<>'array' or jsonb_array_length(s->'lines')=0 then return jsonb_build_object('eligible',false,'reasons',jsonb_build_array('Saved invoice lines are required'));end if;
 for l in select value from jsonb_array_elements(s->'lines') loop
  keys:=array_append(keys,regexp_replace(regexp_replace(btrim(coalesce(l->>'sourceLine','')),'[,\t|]+',' ','g'),'[[:space:]]+',' ','g'));
  n:=public.kerdos_invoice_money_cents(l->'amount');if n is null then reasons:=array_append(reasons,'Item monetary precision needs clarification');else lines_total:=lines_total+n;end if;
  if abs(lines_total)>9007199254740991 then reasons:=array_append(reasons,'Item monetary sum exceeds supported precision');end if;
  active:=0;
  for r in select rr.value from jsonb_array_elements(s->'receipts') rr where rr.value->>'invoiceLineId'=l->>'id' and not exists(select 1 from jsonb_array_elements(s->'reversals') vv where vv.value->>'receiptId'=rr.value->>'id') loop
   active:=active+1;
   if public.kerdos_invoice_money_cents(r->'rateVariance') is distinct from 0::numeric or r->'weightOutsideStatedRange'='true'::jsonb then reasons:=array_append(reasons,'Order rate or weight flags require resolution');end if;
   if r->>'invoiceDocumentId' is distinct from s->>'invoiceId' or r->>'vendorItemId' is distinct from l->>'vendorItemId' or r->>'billedUnit' is distinct from l->>'sellingUnit' or r->'billedQuantity' is distinct from l->'quantity' or r->'billedRate' is distinct from l->'unitPrice' or r->'actualCharge' is distinct from l->'amount' or r->>'sourceLine' is distinct from l->>'sourceLine' then reasons:=array_append(reasons,'Receipt differs from its current invoice source');end if;
  end loop;
  if active<>1 then reasons:=array_append(reasons,'Every invoice line needs one active receipt');end if;
 end loop;
 for raw in select unnest(string_to_array(replace(coalesce(s->'header'->>'rawText',''),E'\r',''),E'\n')) loop
  k:=regexp_replace(regexp_replace(btrim(raw),'[,\t|]+',' ','g'),'[[:space:]]+',' ','g');
  m:=regexp_match(btrim(raw),'^(.+?)[[:space:]]*[:\t, ][[:space:]]*([(]?-?[$]?([0-9]+|[0-9]{1,3}(,[0-9]{3})+)[.][0-9]{2}[)]?)[[:space:]]*$');
  if m is null then
   -- Be conservative with unsupported currencies/summary syntax, never infer zero.
   if not(k=any(keys)) and ((raw~*'\m(total|subtotal|tax|freight|credit|discount|surcharge|balance|fee|charges?)\M' and raw~'[$0-9]') or raw~'[$€£¥₹₽₩¢]' or raw~'[0-9]+[.,][0-9]{2}[[:space:]]*$' or (raw collate "C" ~ '[^ -~]' and raw~'[0-9]')) then reasons:=array_append(reasons,'Unsupported monetary source needs clarification');end if;
   continue;
  end if;
  label:=regexp_replace(regexp_replace(lower(btrim(m[1])),'[:[:space:]]+$','','g'),'[[:space:]]+',' ','g');
  kind:=case when label~'^(subtotal|sub total|merchandise subtotal|item subtotal)$' then 'subtotal' when label~'^(invoice total|grand total|total due|amount due|total)$' then 'total' when label~'^(tax|sales tax|vat|gst|hst)$' then 'tax' when label~'^(freight|shipping|shipping charge|delivery|delivery charge|delivery fee)$' then 'freight' when label~'^(credit|credits|discount|discounts)$' then 'credits' when label~'^(fuel surcharge|service charge|handling fee|other charges|other fees)$' then 'other' end;
  if kind is null then if not(k=any(keys)) then reasons:=array_append(reasons,'Unclassified monetary source needs clarification');end if;continue;end if;
  if k=any(keys) then reasons:=array_append(reasons,'Summary source is also an item line');end if;
  if label=any(seen) or (kind in ('total','subtotal') and amounts?kind) then reasons:=array_append(reasons,'Repeated summary amount needs clarification');end if;seen:=array_append(seen,label);
  money:=replace(replace(m[2],',',''),'$','');
  if left(money,1)='(' then if right(money,1)<>')' or position('-' in money)>0 then money:='invalid';else money:='-'||substr(money,2,char_length(money)-2);end if;elsif right(money,1)=')' then money:='invalid';end if;
  n:=public.kerdos_invoice_money_cents(to_jsonb(money));if kind='credits' then n:=-abs(n);end if;
  if n is null or (kind<>'credits' and n<0) then reasons:=array_append(reasons,'Summary monetary precision or sign needs clarification');end if;
  n:=coalesce((amounts->>kind)::numeric,0)+n;if n is null or abs(n)>9007199254740991 then reasons:=array_append(reasons,'Summary monetary sum exceeds supported precision');end if;
  amounts:=jsonb_set(amounts,array[kind],coalesce(to_jsonb(n),'null'));
 end loop;
 foreach kind in array array['subtotal','tax','freight','credits','total'] loop if (amounts->>kind) is null then reasons:=array_append(reasons,'Explicit '||kind||' source is required');end if;end loop;
 adjusted:=lines_total+(amounts->>'tax')::numeric+(amounts->>'freight')::numeric+(amounts->>'credits')::numeric+coalesce((amounts->>'other')::numeric,0);
 if abs(adjusted)>9007199254740991 or adjusted is null or adjusted is distinct from (amounts->>'total')::numeric or lines_total is distinct from (amounts->>'subtotal')::numeric or public.kerdos_invoice_money_cents(s->'header'->'recordedTotal') is distinct from (amounts->>'total')::numeric then reasons:=array_append(reasons,'Invoice source arithmetic or recorded total needs resolution');end if;
 return jsonb_build_object('eligible',cardinality(reasons)=0,'reasons',to_jsonb(reasons));
end;
$$;
create table if not exists public.invoice_accounting_approvals(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),invoice_id uuid not null references public.invoices(id),request_id uuid not null,
 source jsonb not null,note text not null default '' check(char_length(note)<=500 and note=btrim(note)),confirmed boolean not null default false,
 created_by uuid not null default auth.uid(),created_at timestamptz not null default current_timestamp,snapshot jsonb not null,
 unique(organization_id,request_id)
);
create index if not exists invoice_approvals_invoice on public.invoice_accounting_approvals(invoice_id);
alter table public.invoice_accounting_approvals enable row level security;
revoke all on public.invoice_accounting_approvals from public,anon,authenticated,service_role;
grant select on public.invoice_accounting_approvals to authenticated;
grant insert(organization_id,invoice_id,request_id,source,note,confirmed) on public.invoice_accounting_approvals to authenticated;
drop policy if exists "approval members read" on public.invoice_accounting_approvals;
create policy "approval members read" on public.invoice_accounting_approvals for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=invoice_accounting_approvals.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "approval managers insert" on public.invoice_accounting_approvals;
create policy "approval managers insert" on public.invoice_accounting_approvals for insert to authenticated with check(created_by=(select auth.uid()) and exists(select 1 from public.organization_members m where m.organization_id=invoice_accounting_approvals.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager')));
create or replace function public.kerdos_prepare_invoice_approval()
returns trigger language plpgsql security invoker set search_path=public as $$
declare fresh jsonb;gate jsonb;
begin
 if not exists(select 1 from public.organization_members where organization_id=new.organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager membership is required for accounting approval';end if;
 if new.confirmed is distinct from true then raise exception 'Explicitly confirm accounting approval';end if;
 -- Match receipt save/reversal lock order. Header UPDATE lock also fences FK inserts.
 perform 1 from public.purchase_order_lines l where l.id in(select order_line_id from public.estimated_order_receipts where organization_id=new.organization_id and invoice_id=new.invoice_id) order by l.id for update;
 perform 1 from public.invoices where id=new.invoice_id and organization_id=new.organization_id for update;
 fresh:=public.kerdos_review_invoice_reconciliation(new.organization_id,new.invoice_id);
 if fresh is distinct from new.source then raise exception 'Invoice or receipt evidence changed; refresh and review again';end if;
 gate:=public.kerdos_invoice_approval_gate(fresh);
 if gate->'eligible' is distinct from 'true'::jsonb then raise exception 'Invoice does not pass accounting approval checks';end if;
 if new.created_by is distinct from (select auth.uid()) or new.created_at is distinct from current_timestamp then raise exception 'Approval actor and time must match';end if;
 new.snapshot:=jsonb_build_object('kind','invoice_accounting_approval','version',1,'id',new.id,'organizationId',new.organization_id,'invoiceId',new.invoice_id,'requestId',new.request_id,'source',fresh,'gate',gate,'note',new.note,'approvedBy',new.created_by,'approvedAt',new.created_at);
 return new;
end;
$$;
drop trigger if exists invoice_approval_prepare on public.invoice_accounting_approvals;
create trigger invoice_approval_prepare before insert on public.invoice_accounting_approvals for each row execute function public.kerdos_prepare_invoice_approval();
create or replace function public.kerdos_freeze_invoice_approval()
returns trigger language plpgsql security invoker set search_path=public as $$
begin raise exception 'Accounting approval history is immutable';end;
$$;
drop trigger if exists invoice_approval_immutable on public.invoice_accounting_approvals;
create trigger invoice_approval_immutable before update or delete on public.invoice_accounting_approvals for each row execute function public.kerdos_freeze_invoice_approval();
create or replace function public.kerdos_review_invoice_approval(p_organization_id uuid,p_invoice_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare s jsonb;history jsonb;can_approve boolean;
begin
 s:=public.kerdos_review_invoice_reconciliation(p_organization_id,p_invoice_id);
 select coalesce(jsonb_agg(snapshot order by created_at,id),'[]') into history from public.invoice_accounting_approvals where organization_id=p_organization_id and invoice_id=p_invoice_id;
 select exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) into can_approve;
 return jsonb_build_object('source',s,'gate',public.kerdos_invoice_approval_gate(s),'approvals',history,'canApprove',can_approve);
end;
$$;
create or replace function public.kerdos_save_invoice_approval(p_organization_id uuid,p_invoice_id uuid,p_request_id uuid,p_source jsonb,p_note text,p_confirmed boolean)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare saved public.invoice_accounting_approvals%rowtype;
begin
 if not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager membership is required for accounting approval';end if;
 if p_confirmed is distinct from true then raise exception 'Explicitly confirm accounting approval';end if;
 if p_note is null or p_note is distinct from btrim(p_note) or char_length(p_note)>500 then raise exception 'Use a trimmed approval note of at most 500 characters';end if;
 perform 1 from public.purchase_order_lines l where l.id in(select order_line_id from public.estimated_order_receipts where organization_id=p_organization_id and invoice_id=p_invoice_id) order by l.id for update;
 perform 1 from public.invoices where id=p_invoice_id and organization_id=p_organization_id for update;
 select * into saved from public.invoice_accounting_approvals where organization_id=p_organization_id and request_id=p_request_id;
 if found then
  if saved.invoice_id is distinct from p_invoice_id or saved.created_by is distinct from (select auth.uid()) or saved.source is distinct from p_source or saved.note is distinct from p_note then raise exception 'Approval request already belongs to different confirmed evidence';end if;
  return saved.snapshot;
 end if;
 insert into public.invoice_accounting_approvals(organization_id,invoice_id,request_id,source,note,confirmed) values(p_organization_id,p_invoice_id,p_request_id,p_source,p_note,p_confirmed) returning * into saved;return saved.snapshot;
end;
$$;
revoke all on function public.kerdos_invoice_money_cents(jsonb),public.kerdos_invoice_approval_gate(jsonb),public.kerdos_prepare_invoice_approval(),public.kerdos_freeze_invoice_approval(),public.kerdos_review_invoice_approval(uuid,uuid),public.kerdos_save_invoice_approval(uuid,uuid,uuid,jsonb,text,boolean) from public,anon,service_role;
grant execute on function public.kerdos_invoice_money_cents(jsonb),public.kerdos_invoice_approval_gate(jsonb),public.kerdos_prepare_invoice_approval(),public.kerdos_freeze_invoice_approval(),public.kerdos_review_invoice_approval(uuid,uuid),public.kerdos_save_invoice_approval(uuid,uuid,uuid,jsonb,text,boolean) to authenticated;
