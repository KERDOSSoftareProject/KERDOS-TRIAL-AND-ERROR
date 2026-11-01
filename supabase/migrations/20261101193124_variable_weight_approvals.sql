-- Confirmation history only: this migration never changes a quote, mapping,
-- source document, review flag or order eligibility.
create or replace function public.kerdos_mass_unit(p_raw text)
returns text language sql immutable set search_path=public as $$
 select case lower(regexp_replace(coalesce(p_raw,''),'[[:space:].]','','g'))
 when 'lb' then 'LB' when 'lbs' then 'LB' when 'pound' then 'LB' when 'pounds' then 'LB'
 when 'oz' then 'OZ' when 'ounce' then 'OZ' when 'ounces' then 'OZ'
 when 'kg' then 'KG' when 'kilogram' then 'KG' when 'kilograms' then 'KG'
 when 'g' then 'G' when 'gram' then 'G' when 'grams' then 'G' end;
$$;

create or replace function public.kerdos_variable_mass_pack(p_raw text)
returns jsonb language plpgsql immutable set search_path=public as $$
declare t text; m text[]; counts jsonb:='[]'; n text; unit text; factor numeric; lo numeric; hi numeric;
begin
 if p_raw is null or length(p_raw)>512 then return null; end if;
 t:=lower(btrim(p_raw));
 t:=regexp_replace(t,'lba[.]?$','lb avg');
 t:=regexp_replace(t,'(lb|lbs)(av|avg)$','\1 \2');
 if t !~ '(av|avg|ave|average|approx|approximately|catch[[:space:]]*wt|catch[[:space:]]*weight|c/w|cw|rw|random[[:space:]]*wt|random[[:space:]]*weight|var(iable)?[[:space:]]*wt|var(iable)?[[:space:]]*weight)[.]?$' then return null; end if;
 t:=btrim(regexp_replace(t,'(av|avg|ave|average|approx|approximately|catch[[:space:]]*wt|catch[[:space:]]*weight|c/w|cw|rw|random[[:space:]]*wt|random[[:space:]]*weight|var(iable)?[[:space:]]*wt|var(iable)?[[:space:]]*weight)[.]?$',''));
 t:=replace(replace(t,'×','x'),'#',' lb ');
 m:=regexp_match(t,'^((?:[0-9]+[[:space:]]*[/x][[:space:]]*)*)([0-9]*[.]?[0-9]+)(?:[[:space:]]*[-‐‑–][[:space:]]*([0-9]*[.]?[0-9]+))?[[:space:]]*([a-z]+)[.]?$');
 if m is null then return null; end if;
 unit:=public.kerdos_mass_unit(m[4]);
 if unit is null then return null; end if;
 factor:=case unit when 'LB' then 453.59237 when 'OZ' then 28.349523125 when 'KG' then 1000 when 'G' then 1 end;
 lo:=m[2]::numeric;hi:=coalesce(m[3],m[2])::numeric;
 if lo<=0 or hi<lo then return null; end if;
 for n in select value from regexp_split_to_table(m[1],'[/x]') value where btrim(value)<>'' loop
   if n::numeric<=0 or n::numeric>9007199254740991 then return null; end if;
   counts:=counts||to_jsonb(n::numeric);
 end loop;
 -- Canonical physical quantities retain packaging topology and range type.
 return jsonb_build_object('counts',counts,'minimumBase',lo*factor,'maximumBase',hi*factor,'range',m[3] is not null);
end;
$$;

create or replace function public.kerdos_variable_weight_terms(p_organization_id uuid,p_vendor_item_id uuid,p_mapping_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare v public.vendor_items%rowtype; m public.item_mappings%rowtype; d public.import_documents%rowtype;
 s jsonb; row_data jsonb; proof jsonb; fields jsonb; settings jsonb; row_key text; row_index integer; tz text;
begin
 if (select auth.uid()) is null or not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid())) then raise exception 'Organization membership is required'; end if;
 select * into v from public.vendor_items where id=p_vendor_item_id and organization_id=p_organization_id for share;
 if not found then raise exception 'Vendor item is outside this organization'; end if;
 select * into m from public.item_mappings where id=p_mapping_id and organization_id=p_organization_id and vendor_item_id=v.id for share;
 if not found or m.comparison_track is distinct from 'exact' or m.confidence_score is distinct from 100 then raise exception 'Confirm the catalog association first'; end if;
 if not exists(select 1 from public.catalog_items where id=m.catalog_item_id and organization_id=p_organization_id)
 or not exists(select 1 from public.vendors where id=v.vendor_id and organization_id=p_organization_id) then raise exception 'Catalog and vendor ownership must match'; end if;
 if v.price is null or v.price<=0 or v.price::text in ('NaN','Infinity','-Infinity') or v.price_source='invoice' or v.price_expired_at is not null then raise exception 'A current positive vendor quotation is required'; end if;
 select o.settings into settings from public.organizations o where id=p_organization_id;
 tz:=coalesce(settings->>'timezone','UTC');
 if not exists(select 1 from pg_timezone_names where name=tz) then tz:='UTC'; end if;
 if v.price_quote_valid_until < timezone(tz,current_timestamp)::date then raise exception 'Quote has expired'; end if;
 if settings->>'price_refresh_mode'='automatic' and coalesce((settings->>'price_refresh_days')::numeric,0)>0
 and extract(epoch from (current_timestamp-v.last_updated))/86400>(settings->>'price_refresh_days')::numeric then raise exception 'Quote has expired'; end if;
 fields:=v.import_row->'reviewFields';
 if coalesce((v.import_row->>'reviewRequired')::boolean,false) and fields is distinct from '["pack_size"]'::jsonb then raise exception 'Resolve the other source fields first'; end if;
 select * into d from public.import_documents where id=(v.import_row->>'sourceDocumentId')::uuid and organization_id=p_organization_id and vendor_id=v.vendor_id and document_kind='pricelist';
 if not found or d.source_rows->>'version' is distinct from '1' then raise exception 'Retained quotation source is required'; end if;
 row_key:=v.import_row->>'rowKey';
 if row_key is null or row_key !~ '^row:(0|[1-9][0-9]*)$' or length(row_key)>14 then raise exception 'Retained source row is required'; end if;
 row_index:=substring(row_key from 5)::integer;
 s:=d.source_rows->'rows'->row_index;
 if s is null or s->>'key' is distinct from row_key then raise exception 'Retained source row is required'; end if;
 if s->'values'->>11 is distinct from 'false' or s->'values'->>10='true' or (s->'values'->>5)::numeric is distinct from v.price then raise exception 'Retain the stated source rate'; end if;
 if nullif(s->'values'->>0,'') is not null and s->'values'->>0 is distinct from v.vendor_item_code then raise exception 'Source product code differs'; end if;
 if public.kerdos_mass_unit(v.selling_unit) is null or public.kerdos_mass_unit(s->'values'->>7) is distinct from public.kerdos_mass_unit(v.selling_unit) then raise exception 'A stated mass billing unit is required'; end if;
 if public.kerdos_variable_mass_pack(v.pack_size) is null or public.kerdos_variable_mass_pack(v.pack_size) is distinct from public.kerdos_variable_mass_pack(s->'values'->>3) then raise exception 'Retain the stated variable pack and its complete range'; end if;
 proof:=s->'billingUnitEvidence';
 if public.kerdos_mass_unit(proof->>'unit') is distinct from public.kerdos_mass_unit(v.selling_unit)
 or not(coalesce((proof->>'kind'='pricing-unit-header' and btrim(proof->>'header') ~* '^(product uom|selling unit|price unit|price uom|pricing unit|pricing basis|price basis|unit of sale|quoted per)$')
 or (proof->>'kind'='goods-invoice-billed-unit' and proof->>'header'='UOM')
 or (proof->>'kind'='explicit-price-unit' and proof->>'source' in ('price cell','price header','document note')),false)) then raise exception 'Stated billing-unit provenance is required'; end if;
 row_data:=coalesce(v.import_row->'evidence',v.import_row->'row');
 if (row_data->>'price')::numeric is distinct from v.price or public.kerdos_mass_unit(row_data->>'sellingUnit') is distinct from public.kerdos_mass_unit(v.selling_unit)
 or public.kerdos_variable_mass_pack(row_data->>'packSize') is distinct from public.kerdos_variable_mass_pack(v.pack_size)
 or coalesce((row_data->>'priceNeedsReview')::boolean,false) then raise exception 'Current source evidence differs from the retained quotation'; end if;
 return jsonb_build_object('organizationId',p_organization_id,'vendorId',v.vendor_id,'catalogItemId',m.catalog_item_id,'vendorItemId',v.id,
 'vendorItemCode',v.vendor_item_code,'description',v.description,'brand',v.brand,'packSize',v.pack_size,'quotedRate',v.price,
 'quotedUnit',public.kerdos_mass_unit(v.selling_unit),'validUntil',v.price_quote_valid_until,
 'lastUpdated',case when v.last_updated is null then null else to_char(v.last_updated at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
 'sourceDocumentId',d.id,'sourceRowKey',row_key,'billingUnitEvidence',proof);
end;
$$;

create table if not exists public.variable_weight_approvals (
 id uuid primary key default gen_random_uuid(),
 organization_id uuid not null references public.organizations(id),vendor_id uuid not null references public.vendors(id),
 vendor_item_id uuid not null references public.vendor_items(id),mapping_id uuid not null references public.item_mappings(id),
 catalog_item_id uuid not null references public.catalog_items(id),
 terms jsonb not null check(jsonb_typeof(terms)='object'),
 approved_by uuid not null,approved_at timestamptz not null default current_timestamp,
 revoked_by uuid,revoked_at timestamptz,
 check((revoked_at is null)=(revoked_by is null))
);
create unique index if not exists variable_weight_approvals_active on public.variable_weight_approvals(organization_id,vendor_item_id,mapping_id) where revoked_at is null;
create index if not exists variable_weight_approvals_item on public.variable_weight_approvals(vendor_item_id);
create index if not exists variable_weight_approvals_vendor on public.variable_weight_approvals(vendor_id);
create index if not exists variable_weight_approvals_mapping on public.variable_weight_approvals(mapping_id);
create index if not exists variable_weight_approvals_catalog on public.variable_weight_approvals(catalog_item_id);
alter table public.variable_weight_approvals enable row level security;
revoke all on public.variable_weight_approvals from public,anon,authenticated;
grant select on public.variable_weight_approvals to authenticated;
grant insert(organization_id,vendor_id,vendor_item_id,mapping_id,catalog_item_id,terms,approved_by) on public.variable_weight_approvals to authenticated;
grant update(revoked_at,revoked_by) on public.variable_weight_approvals to authenticated;
drop policy if exists "variable approvals members read" on public.variable_weight_approvals;
create policy "variable approvals members read" on public.variable_weight_approvals for select to authenticated
 using(exists(select 1 from public.organization_members m where m.organization_id=variable_weight_approvals.organization_id and m.user_id=(select auth.uid())));
drop policy if exists "variable approvals managers insert" on public.variable_weight_approvals;
create policy "variable approvals managers insert" on public.variable_weight_approvals for insert to authenticated with check(
 approved_by=(select auth.uid()) and approved_at=current_timestamp and revoked_at is null and revoked_by is null
 and exists(select 1 from public.organization_members m where m.organization_id=variable_weight_approvals.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager'))
 and terms=public.kerdos_variable_weight_terms(organization_id,vendor_item_id,mapping_id)
 and terms->>'vendorId'=vendor_id::text and terms->>'catalogItemId'=catalog_item_id::text);
drop policy if exists "variable approvals managers revoke" on public.variable_weight_approvals;
create policy "variable approvals managers revoke" on public.variable_weight_approvals for update to authenticated
 using(exists(select 1 from public.organization_members m where m.organization_id=variable_weight_approvals.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager')))
 with check(revoked_by=(select auth.uid()) and revoked_at=current_timestamp and exists(select 1 from public.organization_members m where m.organization_id=variable_weight_approvals.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager')));

create or replace function public.kerdos_variable_approval_immutable()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
 if to_jsonb(new)-'revoked_at'-'revoked_by' is distinct from to_jsonb(old)-'revoked_at'-'revoked_by'
 or old.revoked_at is not null or new.revoked_at is null or new.revoked_at<>current_timestamp or new.revoked_by is distinct from (select auth.uid())
 then raise exception 'Saved approval terms are immutable; only an authenticated revocation is allowed'; end if;
 return new;
end;
$$;
drop trigger if exists variable_approval_immutable on public.variable_weight_approvals;
create trigger variable_approval_immutable before update on public.variable_weight_approvals for each row execute function public.kerdos_variable_approval_immutable();

create or replace function public.kerdos_approve_variable_weight(p_organization_id uuid,p_vendor_item_id uuid,p_mapping_id uuid,p_expected_revision bigint,p_intent jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare terms jsonb; existing public.variable_weight_approvals%rowtype; saved public.variable_weight_approvals%rowtype; revision bigint;
begin
 if (select auth.uid()) is null or not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager permission is required'; end if;
 select row_revision into revision from public.vendor_items where id=p_vendor_item_id and organization_id=p_organization_id for update;
 if not found or revision is distinct from p_expected_revision then raise exception 'The row changed; reload it before confirming terms'; end if;
 terms:=public.kerdos_variable_weight_terms(p_organization_id,p_vendor_item_id,p_mapping_id);
 if p_intent->>'kind' is distinct from 'variable_weight_approval_intent' or p_intent->>'version' is distinct from '1'
 or p_intent->>'requestedBy' is distinct from (select auth.uid())::text or p_intent->>'finalChargeKnown' is distinct from 'false'
 or p_intent->'terms' is distinct from terms then raise exception 'Reviewed source terms changed; review them again'; end if;
 select * into existing from public.variable_weight_approvals where organization_id=p_organization_id and vendor_item_id=p_vendor_item_id and mapping_id=p_mapping_id and revoked_at is null for update;
 if found and existing.terms=terms then return to_jsonb(existing); end if;
 if existing.id is not null then update public.variable_weight_approvals set revoked_at=current_timestamp,revoked_by=(select auth.uid()) where id=existing.id; end if;
 insert into public.variable_weight_approvals(organization_id,vendor_id,vendor_item_id,mapping_id,catalog_item_id,terms,approved_by)
 values(p_organization_id,(terms->>'vendorId')::uuid,p_vendor_item_id,p_mapping_id,(terms->>'catalogItemId')::uuid,terms,(select auth.uid())) returning * into saved;
 return to_jsonb(saved);
end;
$$;

create or replace function public.kerdos_revoke_variable_weight(p_organization_id uuid,p_approval_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare saved public.variable_weight_approvals%rowtype;
begin
 if (select auth.uid()) is null or not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager')) then raise exception 'Owner or manager permission is required'; end if;
 select * into saved from public.variable_weight_approvals where id=p_approval_id and organization_id=p_organization_id for update;
 if not found then raise exception 'Approval is outside this organization'; end if;
 if saved.revoked_at is null then update public.variable_weight_approvals set revoked_at=current_timestamp,revoked_by=(select auth.uid()) where id=saved.id returning * into saved; end if;
 return to_jsonb(saved);
end;
$$;
revoke all on function public.kerdos_mass_unit(text),public.kerdos_variable_mass_pack(text),public.kerdos_variable_weight_terms(uuid,uuid,uuid),public.kerdos_variable_approval_immutable(),public.kerdos_approve_variable_weight(uuid,uuid,uuid,bigint,jsonb),public.kerdos_revoke_variable_weight(uuid,uuid) from public,anon;
grant execute on function public.kerdos_mass_unit(text),public.kerdos_variable_mass_pack(text),public.kerdos_variable_weight_terms(uuid,uuid,uuid),public.kerdos_variable_approval_immutable(),public.kerdos_approve_variable_weight(uuid,uuid,uuid,bigint,jsonb),public.kerdos_revoke_variable_weight(uuid,uuid) to authenticated;
