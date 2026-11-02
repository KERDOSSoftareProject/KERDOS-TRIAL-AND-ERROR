-- Append-only relabelling of retained summary lines. No source or amount edits.
create or replace function public.kerdos_invoice_summary_basis(s jsonb)
returns jsonb language sql immutable security invoker set search_path=public as $$
 select jsonb_build_object('rawText',coalesce(s->'header'->>'rawText',''),'itemSources',(select coalesce(jsonb_agg(v->'sourceLine' order by n),'[]') from jsonb_array_elements(s->'lines') with ordinality x(v,n)));
$$;
create or replace function public.kerdos_classified_invoice_summary(b jsonb,mappings jsonb)
returns text language plpgsql immutable security invoker set search_path=public as $$
declare lines text[];m jsonb;idx integer;previous integer:=0;kind text;label text;recognized text;known_label text;raw text;parts text[];money text;item jsonb;trimchars text:=U&'\0009\000A\000B\000C\000D\0020\00A0\1680\2000\2001\2002\2003\2004\2005\2006\2007\2008\2009\200A\2028\2029\202F\205F\3000\FEFF';
begin
 if jsonb_typeof(b->'rawText') is distinct from 'string' or octet_length(b->>'rawText')>4000000 or char_length(b->>'rawText')>1000000 or jsonb_typeof(b->'itemSources') is distinct from 'array' or jsonb_typeof(mappings) is distinct from 'array' or jsonb_array_length(mappings)>50 then raise exception 'Summary classification needs bounded retained source and mappings';end if;
 lines:=string_to_array(replace(b->>'rawText',E'\r',''),E'\n');
 for item in select value from jsonb_array_elements(b->'itemSources') loop if jsonb_typeof(item) not in ('string','null') then raise exception 'Invalid retained item source';end if;end loop;
 for m in select value from jsonb_array_elements(mappings) loop
  if jsonb_typeof(m->'lineNumber') is distinct from 'number' or (m->>'lineNumber')!~'^[1-9][0-9]{0,5}$' then raise exception 'Choose unique ordered summary source lines';end if;
  idx:=(m->>'lineNumber')::integer;kind:=m->>'kind';
  label:=case kind when 'subtotal' then 'Subtotal' when 'tax' then 'Tax' when 'freight' then 'Freight' when 'credits' then 'Credits' when 'other' then 'Other charges' when 'total' then 'Invoice Total' end;
  if label is null or idx<=previous or idx>coalesce(array_length(lines,1),0) or m is distinct from jsonb_build_object('lineNumber',idx,'kind',kind) then raise exception 'Choose unique ordered source lines and supported summary categories';end if;previous:=idx;raw:=lines[idx];
  for item in select value from jsonb_array_elements(b->'itemSources') loop
   if btrim(regexp_replace(raw,'['||trimchars||',|]+',' ','g'))=btrim(regexp_replace(coalesce(item#>>'{}',''),'['||trimchars||',|]+',' ','g')) then raise exception 'Summary source is an item line';end if;
  end loop;
  parts:=regexp_match(btrim(raw,trimchars),'^(.+?)[[:space:]]*[:\t, ][[:space:]]*([(]?-?[$]?([0-9]+|[0-9]{1,3}(,[0-9]{3})+)[.][0-9]{2}[)]?)[[:space:]]*$');
  if parts is null then raise exception 'Classify a complete retained monetary summary line';end if;
  known_label:=regexp_replace(regexp_replace(lower(btrim(parts[1])),'[:[:space:]]+$','','g'),'[[:space:]]+',' ','g');
  recognized:=case when known_label~'^(subtotal|sub total|merchandise subtotal|item subtotal)$' then 'subtotal' when known_label~'^(invoice total|grand total|total due|amount due|total)$' then 'total' when known_label~'^(tax|sales tax|vat|gst|hst)$' then 'tax' when known_label~'^(freight|shipping|shipping charge|delivery|delivery charge|delivery fee)$' then 'freight' when known_label~'^(credit|credits|discount|discounts)$' then 'credits' when known_label~'^(fuel surcharge|service charge|handling fee|other charges|other fees)$' then 'other' end;
  if recognized is not null and recognized<>kind then raise exception 'Recognized summary labels retain their existing category';end if;
  money:=replace(replace(parts[2],',',''),'$','');
  if left(money,1)='(' then if right(money,1)<>')' or position('-' in money)>0 then raise exception 'Summary monetary sign needs clarification';end if;money:='-'||substr(money,2,char_length(money)-2);elsif right(money,1)=')' then raise exception 'Summary monetary sign needs clarification';end if;
  if public.kerdos_invoice_money_cents(to_jsonb(money)) is null then raise exception 'Summary monetary precision needs clarification';end if;
  lines[idx]:=label||' '||parts[2];
 end loop;
 return coalesce(array_to_string(lines,E'\n'),'');
end;
$$;
create table if not exists public.invoice_summary_classifications(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),invoice_id uuid not null references public.invoices(id),request_id uuid not null,
 revision bigint not null,previous_id uuid unique references public.invoice_summary_classifications(id),review jsonb not null,confirmed boolean not null default false,
 created_by uuid not null default auth.uid(),created_at timestamptz not null default current_timestamp,snapshot jsonb not null,
 unique(organization_id,request_id),unique(invoice_id,revision)
);
alter table public.invoice_summary_classifications enable row level security;
revoke all on public.invoice_summary_classifications from public,anon,authenticated,service_role;
grant select on public.invoice_summary_classifications to authenticated;
grant insert(organization_id,invoice_id,request_id,review,confirmed) on public.invoice_summary_classifications to authenticated;
drop policy if exists "summary members read" on public.invoice_summary_classifications;
create policy "summary members read" on public.invoice_summary_classifications for select to authenticated using(exists(select 1 from public.organization_members m where m.organization_id=invoice_summary_classifications.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "summary managers insert" on public.invoice_summary_classifications;
create policy "summary managers insert" on public.invoice_summary_classifications for insert to authenticated with check(created_by=(select auth.uid()) and exists(select 1 from public.organization_members m where m.organization_id=invoice_summary_classifications.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager')));
create or replace function public.kerdos_review_invoice_reconciliation(p_organization_id uuid,p_invoice_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare result jsonb;
begin
 if (select auth.uid()) is null or not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid())) then raise exception 'Organization membership is required';end if;
 select jsonb_build_object('kind','invoice_reconciliation_source','version',1,'organizationId',i.organization_id,'invoiceId',i.id,
 'header',jsonb_build_object('id',i.id,'organizationId',i.organization_id,'vendorId',i.vendor_id,'invoiceNumber',i.invoice_number,'invoiceDate',i.invoice_date,'recordedTotal',i.total_amount,'rawText',i.raw_text,'fileName',i.file_name,'filePath',i.file_path),
 'lines',(select coalesce(jsonb_agg(jsonb_build_object('id',il.id,'invoiceId',il.invoice_id,'vendorItemId',il.vendor_item_id,'description',il.description,'quantity',il.quantity,'unitPrice',il.unit_price,'amount',il.line_total,'sellingUnit',il.selling_unit,'sourceLine',il.source_line) order by il.id),'[]') from public.invoice_lines il where il.invoice_id=i.id),
 'receipts',(select coalesce(jsonb_agg(r.snapshot order by r.created_at,r.id),'[]') from public.estimated_order_receipts r where r.organization_id=p_organization_id and r.invoice_id=i.id),
 'reversals',(select coalesce(jsonb_agg(v.snapshot order by v.created_at,v.id),'[]') from public.estimated_receipt_reversals v join public.estimated_order_receipts r on r.id=v.receipt_id where v.organization_id=p_organization_id and r.invoice_id=i.id))||coalesce((select jsonb_build_object('summaryClassification',c.snapshot) from public.invoice_summary_classifications c where c.organization_id=p_organization_id and c.invoice_id=i.id order by c.revision desc limit 1),'{}'::jsonb) into result
 from public.invoices i where i.id=p_invoice_id and i.organization_id=p_organization_id;
 if result is null then raise exception 'Invoice is outside this organization';end if;
 return result;
end;
$$;
create or replace function public.kerdos_invoice_approval_gate(s jsonb)
returns jsonb language plpgsql immutable security invoker set search_path=public as $$
declare l jsonb;r jsonb;raw text;m text[];label text;kind text;money text;n numeric;lines_total numeric:=0;adjusted numeric;amounts jsonb:='{}';seen text[]:='{}';keys text[]:='{}';k text;reasons text[]:='{}';active integer;summary_text text;classification jsonb;
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
 classification:=s->'summaryClassification';summary_text:=s->'header'->>'rawText';
 if classification is not null then
  if classification->>'kind' is distinct from 'invoice_summary_classification' or classification->'basis' is distinct from public.kerdos_invoice_summary_basis(s) or classification->>'organizationId' is distinct from s->>'organizationId' or classification->>'invoiceId' is distinct from s->>'invoiceId' then return jsonb_build_object('eligible',false,'reasons',jsonb_build_array('Summary classification source changed; review again'));end if;
  summary_text:=public.kerdos_classified_invoice_summary(classification->'basis',classification->'mappings');
  if summary_text is distinct from classification->>'classifiedText' then return jsonb_build_object('eligible',false,'reasons',jsonb_build_array('Summary classification does not match its source'));end if;
 end if;
 for raw in select unnest(string_to_array(replace(coalesce(summary_text,''),E'\r',''),E'\n')) loop
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

create or replace function public.kerdos_prepare_summary_classification()
returns trigger language plpgsql security invoker set search_path=public as $$
declare source jsonb;latest public.invoice_summary_classifications%rowtype;basis jsonb;reason text;text_value text;expected jsonb;
begin
 if not exists(select 1 from public.organization_members where organization_id=new.organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager membership is required to classify invoice summary';end if;
 if new.confirmed is distinct from true then raise exception 'Explicitly confirm classification of retained source';end if;
 perform 1 from public.purchase_order_lines l where l.id in(select order_line_id from public.estimated_order_receipts where organization_id=new.organization_id and invoice_id=new.invoice_id) order by l.id for update;
 perform 1 from public.invoices where id=new.invoice_id and organization_id=new.organization_id for update;
 if not found then raise exception 'Invoice is outside this organization';end if;
 perform 1 from public.invoice_lines where invoice_id=new.invoice_id order by id for update;
 source:=public.kerdos_review_invoice_reconciliation(new.organization_id,new.invoice_id);basis:=public.kerdos_invoice_summary_basis(source);
 select * into latest from public.invoice_summary_classifications where invoice_id=new.invoice_id order by revision desc limit 1;
 reason:=new.review->>'reason';
 if public.kerdos_valid_approval_withdrawal_reason(reason) is distinct from true then raise exception 'Enter a trimmed classification reason of 10 to 500 characters';end if;
 expected:=jsonb_build_object('kind','invoice_summary_classification_review','version',1,'organizationId',new.organization_id,'invoiceId',new.invoice_id,'basis',basis,'previousId',latest.id,'mappings',new.review->'mappings','reason',reason);
 if new.review is distinct from expected then raise exception 'Invoice source or classification history changed; review again';end if;
 text_value:=public.kerdos_classified_invoice_summary(basis,new.review->'mappings');
 if new.created_by is distinct from (select auth.uid()) or new.created_at is distinct from current_timestamp then raise exception 'Classification actor and time must match';end if;
 new.revision:=coalesce(latest.revision,0)+1;new.previous_id:=latest.id;
 new.snapshot:=jsonb_build_object('kind','invoice_summary_classification','version',1,'id',new.id,'organizationId',new.organization_id,'invoiceId',new.invoice_id,'requestId',new.request_id,'revision',new.revision,'previousId',new.previous_id,'basis',basis,'mappings',new.review->'mappings','classifiedText',text_value,'reason',reason,'recordedBy',new.created_by,'recordedAt',new.created_at);
 return new;
end;
$$;
drop trigger if exists summary_classification_prepare on public.invoice_summary_classifications;
create trigger summary_classification_prepare before insert on public.invoice_summary_classifications for each row execute function public.kerdos_prepare_summary_classification();
create or replace function public.kerdos_freeze_summary_classification()
returns trigger language plpgsql security invoker set search_path=public as $$
begin raise exception 'Invoice summary classification history is immutable';end;
$$;
drop trigger if exists summary_classification_immutable on public.invoice_summary_classifications;
create trigger summary_classification_immutable before update or delete on public.invoice_summary_classifications for each row execute function public.kerdos_freeze_summary_classification();
create or replace function public.kerdos_save_summary_classification(p_organization_id uuid,p_invoice_id uuid,p_request_id uuid,p_review jsonb,p_confirmed boolean)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare saved public.invoice_summary_classifications%rowtype;
begin
 if not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager membership is required to classify invoice summary';end if;
 if p_confirmed is distinct from true then raise exception 'Explicitly confirm classification of retained source';end if;
 perform 1 from public.purchase_order_lines l where l.id in(select order_line_id from public.estimated_order_receipts where organization_id=p_organization_id and invoice_id=p_invoice_id) order by l.id for update;
 perform 1 from public.invoices where id=p_invoice_id and organization_id=p_organization_id for update;
 if not found then raise exception 'Invoice is outside this organization';end if;
 select * into saved from public.invoice_summary_classifications where organization_id=p_organization_id and request_id=p_request_id;
 if found then
  if saved.invoice_id is distinct from p_invoice_id or saved.created_by is distinct from (select auth.uid()) or saved.review is distinct from p_review then raise exception 'Classification request belongs to different confirmed evidence';end if;
  return saved.snapshot;
 end if;
 insert into public.invoice_summary_classifications(organization_id,invoice_id,request_id,review,confirmed) values(p_organization_id,p_invoice_id,p_request_id,p_review,p_confirmed) returning * into saved;
 return saved.snapshot;
end;
$$;
create or replace function public.kerdos_review_summary_classification(p_organization_id uuid,p_invoice_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare result jsonb;
begin
 -- One statement keeps current source/history/permissions coherent.
 select jsonb_build_object('source',public.kerdos_review_invoice_reconciliation(p_organization_id,p_invoice_id),
 'history',(select coalesce(jsonb_agg(snapshot order by revision),'[]') from public.invoice_summary_classifications where organization_id=p_organization_id and invoice_id=p_invoice_id),
 'canClassify',exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager'))) into result;
 return result;
end;
$$;
revoke all on function public.kerdos_invoice_summary_basis(jsonb),public.kerdos_classified_invoice_summary(jsonb,jsonb),public.kerdos_prepare_summary_classification(),public.kerdos_freeze_summary_classification(),public.kerdos_save_summary_classification(uuid,uuid,uuid,jsonb,boolean),public.kerdos_review_summary_classification(uuid,uuid) from public,anon,service_role;
grant execute on function public.kerdos_invoice_summary_basis(jsonb),public.kerdos_classified_invoice_summary(jsonb,jsonb),public.kerdos_prepare_summary_classification(),public.kerdos_freeze_summary_classification(),public.kerdos_save_summary_classification(uuid,uuid,uuid,jsonb,boolean),public.kerdos_review_summary_classification(uuid,uuid) to authenticated;
