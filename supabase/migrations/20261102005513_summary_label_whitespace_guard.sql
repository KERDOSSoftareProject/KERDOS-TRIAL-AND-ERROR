-- Keep recognized categories protected across JavaScript whitespace, including NBSP.
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
  known_label:=regexp_replace(lower(btrim(regexp_replace(parts[1],'['||trimchars||']+',' ','g'))),'[: ]+$','','g');
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
