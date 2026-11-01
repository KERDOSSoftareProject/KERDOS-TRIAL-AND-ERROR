-- Estimated drafts are not submitted purchase orders or actual charges.
-- Existing scalar-price order submission and its client interface are unchanged.
-- Members need a locked read of an approval while drafting. UPDATE remains
-- owner/manager-only through WITH CHECK plus the immutable revocation trigger.
drop policy if exists "variable approvals managers revoke" on public.variable_weight_approvals;
create policy "variable approvals managers revoke" on public.variable_weight_approvals for update to authenticated
 using(exists(select 1 from public.organization_members m where m.organization_id=variable_weight_approvals.organization_id and m.user_id=(select auth.uid())))
 with check(revoked_by=(select auth.uid()) and revoked_at=current_timestamp and exists(select 1 from public.organization_members m where m.organization_id=variable_weight_approvals.organization_id and m.user_id=(select auth.uid()) and m.role in ('owner','manager')));

create or replace function public.kerdos_estimated_weight_cost(p_terms jsonb,p_quantity numeric)
returns jsonb language plpgsql immutable set search_path=public as $$
declare pack jsonb; raw_unit text; unit_code text; factor numeric; billed_factor numeric;
 rate numeric; count_units numeric:=1; lo numeric; hi numeric; n jsonb; a numeric; b numeric;
begin
 if p_quantity is null or p_quantity<=0 or p_quantity<>trunc(p_quantity) or p_quantity>2147483647 then raise exception 'A draft needs whole cases within the supported quantity limit'; end if;
 pack:=public.kerdos_variable_mass_pack(p_terms->>'packSize');
 if pack is null then raise exception 'A readable variable mass pack is required'; end if;
 raw_unit:=substring(lower(p_terms->>'packSize') from '(kilograms?|pounds?|ounces?|grams?|lbs?|oz|kg|g|#)(?:[[:space:]]*(?:av|avg|ave|average|approx|approximately|catch[[:space:]]*wt|catch[[:space:]]*weight|c/w|cw|rw|random[[:space:]]*wt|random[[:space:]]*weight|var(iable)?[[:space:]]*wt|var(iable)?[[:space:]]*weight)[.]?|a[.]?)$');
 unit_code:=public.kerdos_mass_unit(case when raw_unit='#' then 'LB' else raw_unit end);
 factor:=case unit_code when 'LB' then 453.59237 when 'OZ' then 28.349523125 when 'KG' then 1000 when 'G' then 1 end;
 billed_factor:=case public.kerdos_mass_unit(p_terms->>'quotedUnit') when 'LB' then 453.59237 when 'OZ' then 28.349523125 when 'KG' then 1000 when 'G' then 1 end;
 if factor is null or billed_factor is null then raise exception 'Stated compatible mass units are required'; end if;
 rate:=(p_terms->>'quotedRate')::numeric;
 if factor<>billed_factor then rate:=round(rate*factor/billed_factor,4); end if;
 for n in select value from jsonb_array_elements(pack->'counts') loop count_units:=count_units*n::numeric; end loop;
 lo:=(pack->>'minimumBase')::numeric/factor;hi:=(pack->>'maximumBase')::numeric/factor;
 a:=round(round(rate*count_units*lo,4)*p_quantity,2);b:=round(round(rate*count_units*hi,4)*p_quantity,2);
 if a<=0 or b<a or a*100>9007199254740991 or b*100>9007199254740991 then raise exception 'Estimated amount cannot be represented'; end if;
 if (pack->>'range')::boolean then return jsonb_build_object('amount',null,'minimum',a,'maximum',b,'estimated',true,'guaranteed',false); end if;
 return jsonb_build_object('amount',a,'minimum',null,'maximum',null,'estimated',true,'guaranteed',false);
end;
$$;

create or replace function public.kerdos_estimated_draft_intents(p_organization_id uuid,p_vendor_id uuid,p_lines jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare line jsonb; approval public.variable_weight_approvals%rowtype; terms jsonb; estimate jsonb; revision bigint; item_id uuid; expected jsonb;
begin
 if (select auth.uid()) is null or not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager','employee')) then raise exception 'Purchasing membership is required'; end if;
 if jsonb_typeof(p_lines) is distinct from 'array' or jsonb_array_length(p_lines) not between 1 and 100 then raise exception 'A draft needs one to one hundred lines'; end if;
 if not exists(select 1 from public.vendors where id=p_vendor_id and organization_id=p_organization_id) then raise exception 'Vendor is outside this organization'; end if;
 if (select count(distinct value->'terms'->>'vendorItemId') from jsonb_array_elements(p_lines))<>jsonb_array_length(p_lines) then raise exception 'Duplicate or missing vendor items are not allowed'; end if;
 -- Lock all listings in stable order before approvals; confirmation uses the same listing-first order.
 for item_id in select distinct (value->'terms'->>'vendorItemId')::uuid from jsonb_array_elements(p_lines) order by 1 loop
   perform 1 from public.vendor_items where id=item_id and organization_id=p_organization_id and vendor_id=p_vendor_id for share;
   if not found then raise exception 'Draft listing is outside the organization or vendor'; end if;
 end loop;
 for line in select value from jsonb_array_elements(p_lines) loop
   select * into approval from public.variable_weight_approvals where id=(line->>'approvalId')::uuid and organization_id=p_organization_id and vendor_id=p_vendor_id and vendor_item_id=(line->'terms'->>'vendorItemId')::uuid for share;
   if not found or approval.revoked_at is not null or approval.approved_at>current_timestamp then raise exception 'A saved active approval is required'; end if;
   select row_revision into revision from public.vendor_items where id=approval.vendor_item_id and organization_id=p_organization_id;
   if revision is distinct from (line->>'expectedRevision')::bigint then raise exception 'The listing changed; reload before saving the draft'; end if;
   terms:=public.kerdos_variable_weight_terms(p_organization_id,approval.vendor_item_id,approval.mapping_id);
   if terms is distinct from approval.terms or terms is distinct from line->'terms' then raise exception 'Approved source terms changed; review them again'; end if;
   estimate:=public.kerdos_estimated_weight_cost(terms,(line->>'quantity')::numeric);
   expected:=jsonb_build_object('kind','estimated_purchase_line_intent','version',1,'terms',terms,'approvalId',approval.id,'quantity',(line->>'quantity')::numeric,'orderUnit','case','estimate',estimate,'actualCharge',null,'requiresAuthenticatedPersistence',true,'expectedRevision',revision);
   if line is distinct from expected then raise exception 'Draft line differs from the authoritative terms and estimate'; end if;
 end loop;
 return p_lines;
end;
$$;

create or replace function public.kerdos_estimated_draft_total(p_lines jsonb)
returns jsonb language plpgsql immutable set search_path=public as $$
declare line jsonb; lo numeric:=0; hi numeric:=0; ranges boolean:=false; e jsonb;
begin
 for line in select value from jsonb_array_elements(p_lines) loop
   e:=line->'estimate';ranges:=ranges or e->>'amount' is null;
   lo:=lo+coalesce((e->>'amount')::numeric,(e->>'minimum')::numeric);
   hi:=hi+coalesce((e->>'amount')::numeric,(e->>'maximum')::numeric);
 end loop;
 if lo is null or hi is null or lo<=0 or hi<lo or hi*100>9007199254740991 then raise exception 'Draft estimate cannot be represented'; end if;
 return jsonb_build_object('amount',case when ranges then null else lo end,'minimum',case when ranges then lo else null end,'maximum',case when ranges then hi else null end,'estimated',true,'guaranteed',false);
end;
$$;

create or replace function public.kerdos_estimated_draft_snapshot(p_id uuid,p_requested jsonb,p_saved jsonb)
returns boolean language plpgsql immutable set search_path=public as $$
declare i integer; requested jsonb; saved jsonb;
begin
 if jsonb_typeof(p_saved) is distinct from 'array' or jsonb_array_length(p_requested)<>jsonb_array_length(p_saved) then return false; end if;
 if (select count(distinct value->>'id') from jsonb_array_elements(p_saved))<>jsonb_array_length(p_saved) then return false; end if;
 for i in 0..jsonb_array_length(p_requested)-1 loop
   requested:=p_requested->i;saved:=p_saved->i;
   if coalesce(saved->>'id','') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
   or saved is distinct from (requested-'kind'-'requiresAuthenticatedPersistence'-'expectedRevision')||jsonb_build_object('id',saved->>'id','orderId',p_id,'kind','estimated_purchase_draft_line','rowRevision',requested->'expectedRevision') then return false; end if;
 end loop;
 return true;
end;
$$;

create table if not exists public.estimated_purchase_drafts(
 id uuid primary key default gen_random_uuid(),organization_id uuid not null references public.organizations(id),vendor_id uuid not null references public.vendors(id),
 request_id uuid not null,created_by uuid not null,created_at timestamptz not null default current_timestamp,
 requested_lines jsonb not null,lines jsonb not null,estimate jsonb not null,
 final_charge numeric check(final_charge is null),status text not null default 'draft' check(status in ('draft','cancelled')),
 cancelled_at timestamptz,cancelled_by uuid,
 check((status='draft' and cancelled_at is null and cancelled_by is null) or (status='cancelled' and cancelled_at is not null and cancelled_by is not null)),
 unique(organization_id,request_id)
);
create index if not exists estimated_purchase_drafts_vendor on public.estimated_purchase_drafts(vendor_id);
alter table public.estimated_purchase_drafts enable row level security;
revoke all on public.estimated_purchase_drafts from public,anon,authenticated;
grant select on public.estimated_purchase_drafts to authenticated;
grant insert(id,organization_id,vendor_id,request_id,created_by,requested_lines,lines,estimate) on public.estimated_purchase_drafts to authenticated;
grant update(status,cancelled_at,cancelled_by) on public.estimated_purchase_drafts to authenticated;
drop policy if exists "draft members read" on public.estimated_purchase_drafts;
create policy "draft members read" on public.estimated_purchase_drafts for select to authenticated using(exists(select 1 from public.organization_members where organization_id=estimated_purchase_drafts.organization_id and user_id=(select auth.uid())));
drop policy if exists "draft purchasing create" on public.estimated_purchase_drafts;
create policy "draft purchasing create" on public.estimated_purchase_drafts for insert to authenticated with check(
 created_by=(select auth.uid()) and created_at=current_timestamp and status='draft' and final_charge is null
 and requested_lines=public.kerdos_estimated_draft_intents(organization_id,vendor_id,requested_lines)
 and public.kerdos_estimated_draft_snapshot(id,requested_lines,lines) and estimate=public.kerdos_estimated_draft_total(requested_lines));
drop policy if exists "draft creator manager cancel" on public.estimated_purchase_drafts;
create policy "draft creator manager cancel" on public.estimated_purchase_drafts for update to authenticated
 using(exists(select 1 from public.organization_members where organization_id=estimated_purchase_drafts.organization_id and user_id=(select auth.uid()) and (created_by=(select auth.uid()) or role in ('owner','manager'))))
 with check(status='cancelled' and cancelled_by=(select auth.uid()) and cancelled_at=current_timestamp);

create or replace function public.kerdos_estimated_draft_immutable()
returns trigger language plpgsql security invoker set search_path=public as $$
begin
 if to_jsonb(new)-'status'-'cancelled_at'-'cancelled_by' is distinct from to_jsonb(old)-'status'-'cancelled_at'-'cancelled_by'
 or old.status<>'draft' or new.status<>'cancelled' or new.cancelled_at is distinct from current_timestamp or new.cancelled_by is distinct from (select auth.uid()) then raise exception 'Draft snapshots are immutable; only cancellation is allowed'; end if;
 return new;
end;
$$;
drop trigger if exists estimated_draft_immutable on public.estimated_purchase_drafts;
create trigger estimated_draft_immutable before update on public.estimated_purchase_drafts for each row execute function public.kerdos_estimated_draft_immutable();

create or replace function public.kerdos_save_estimated_draft(p_organization_id uuid,p_vendor_id uuid,p_request_id uuid,p_lines jsonb)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare saved public.estimated_purchase_drafts%rowtype; draft_id uuid:=gen_random_uuid(); snapshots jsonb;
begin
 if (select auth.uid()) is null or not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in ('owner','manager','employee')) then raise exception 'Purchasing membership is required'; end if;
 if p_request_id is null then raise exception 'A stable draft request ID is required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text||':'||p_request_id::text,0));
 select * into saved from public.estimated_purchase_drafts where organization_id=p_organization_id and request_id=p_request_id;
 if found then
   if saved.created_by is distinct from (select auth.uid()) or saved.vendor_id is distinct from p_vendor_id or saved.requested_lines is distinct from p_lines then raise exception 'Draft request ID already belongs to another request'; end if;
   return to_jsonb(saved);
 end if;
 perform public.kerdos_estimated_draft_intents(p_organization_id,p_vendor_id,p_lines);
 select jsonb_agg((value-'kind'-'requiresAuthenticatedPersistence'-'expectedRevision')||jsonb_build_object('id',gen_random_uuid(),'orderId',draft_id,'kind','estimated_purchase_draft_line','rowRevision',value->'expectedRevision') order by ordinal)
 into snapshots from jsonb_array_elements(p_lines) with ordinality as parts(value,ordinal);
 insert into public.estimated_purchase_drafts(id,organization_id,vendor_id,request_id,created_by,requested_lines,lines,estimate)
 values(draft_id,p_organization_id,p_vendor_id,p_request_id,(select auth.uid()),p_lines,snapshots,public.kerdos_estimated_draft_total(p_lines)) returning * into saved;
 return to_jsonb(saved);
end;
$$;
create or replace function public.kerdos_cancel_estimated_draft(p_organization_id uuid,p_draft_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare saved public.estimated_purchase_drafts%rowtype;
begin
 select * into saved from public.estimated_purchase_drafts where organization_id=p_organization_id and id=p_draft_id for update;
 if not found then raise exception 'Draft is outside this organization'; end if;
 if not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and (saved.created_by=(select auth.uid()) or role in ('owner','manager'))) then raise exception 'Only the creator, owner or manager can cancel this draft'; end if;
 if saved.status='draft' then update public.estimated_purchase_drafts set status='cancelled',cancelled_at=current_timestamp,cancelled_by=(select auth.uid()) where id=saved.id returning * into saved; end if;
 return to_jsonb(saved);
end;
$$;
revoke all on function public.kerdos_estimated_weight_cost(jsonb,numeric),public.kerdos_estimated_draft_intents(uuid,uuid,jsonb),public.kerdos_estimated_draft_total(jsonb),public.kerdos_estimated_draft_snapshot(uuid,jsonb,jsonb),public.kerdos_estimated_draft_immutable(),public.kerdos_save_estimated_draft(uuid,uuid,uuid,jsonb),public.kerdos_cancel_estimated_draft(uuid,uuid) from public,anon;
grant execute on function public.kerdos_estimated_weight_cost(jsonb,numeric),public.kerdos_estimated_draft_intents(uuid,uuid,jsonb),public.kerdos_estimated_draft_total(jsonb),public.kerdos_estimated_draft_snapshot(uuid,jsonb,jsonb),public.kerdos_estimated_draft_immutable(),public.kerdos_save_estimated_draft(uuid,uuid,uuid,jsonb),public.kerdos_cancel_estimated_draft(uuid,uuid) to authenticated;
