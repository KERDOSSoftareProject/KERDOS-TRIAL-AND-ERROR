-- Automatic alternatives do not fabricate client approvals or field evidence.
create or replace function public.kerdos_alternative_key(p_description text,p_brand text,p_pack text)
returns text language sql immutable set search_path=public as $$
 with normalized as (
  select btrim(regexp_replace(lower(coalesce(p_description,'')),'[^a-z0-9%]+',' ','g')) description,
   btrim(regexp_replace(lower(coalesce(p_brand,'')),'[^a-z0-9%]+',' ','g')) brand,
   btrim(regexp_replace(lower(coalesce(p_pack,'')),'[^a-z0-9%]+',' ','g')) pack
 ), tokens as (
  select token,brand from normalized,
   lateral regexp_split_to_table(case when pack='' then description else replace(' '||description||' ',' '||pack||' ',' ') end,'\s+') token
 ) select coalesce(string_agg(token,' ' order by token collate "C"),'') from tokens
 where token<>'' and token not in ('and','the','of') and not(token=any(regexp_split_to_array(brand,'\s+')));
$$;

create or replace function public.kerdos_group_automatic_alternatives(p_organization_id uuid,p_vendor_item_ids uuid[],p_target_catalog_item_id uuid,p_key text,p_dimension text,p_revisions jsonb)
returns integer language plpgsql set search_path=public as $$
declare v_item catalog_items%rowtype; v_row vendor_items%rowtype; v_mapping item_mappings%rowtype; v_count integer;
begin
 if auth.uid() is null or not exists(select 1 from organization_members where organization_id=p_organization_id and user_id=auth.uid() and role in ('owner','manager')) then raise exception 'Owner or manager access is required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,23));
 select count(distinct id) into v_count from unnest(p_vendor_item_ids) id;
 if v_count<2 or v_count>100 or length(p_key)<4 or p_key is null or p_dimension is null or p_dimension='unknown' then raise exception 'Automatic grouping needs clear product details'; end if;
 perform 1 from vendor_items where organization_id=p_organization_id and id=any(p_vendor_item_ids) order by id for update;
 if (select count(*) from vendor_items where organization_id=p_organization_id and id=any(p_vendor_item_ids))<>v_count then raise exception 'Product is outside this organization'; end if;
 perform 1 from item_mappings where organization_id=p_organization_id and vendor_item_id=any(p_vendor_item_ids) order by id for update;
 select * into v_item from catalog_items where id=p_target_catalog_item_id and organization_id=p_organization_id for update;
 if not found or v_item.category_id is null or v_item.brand_locked or v_item.preferred_brand is not null or v_item.comparison_mode='exact' then raise exception 'This item does not allow automatic alternatives'; end if;
 if not exists(select 1 from item_mappings where organization_id=p_organization_id and catalog_item_id=v_item.id and vendor_item_id=any(p_vendor_item_ids)) then raise exception 'Target is outside the selected products'; end if;
 for v_row in select * from vendor_items where organization_id=p_organization_id and id=any(p_vendor_item_ids) order by id loop
  if (p_revisions->>v_row.id::text)::bigint is null or (p_revisions->>v_row.id::text)::bigint<>v_row.row_revision then raise exception 'Product changed; refresh and retry'; end if;
  if v_row.field_resolutions ? 'automatic_group_excluded' or v_row.field_resolutions ? 'unit_cost_override' or nullif(btrim(v_row.pack_size),'') is null or kerdos_alternative_key(v_row.description,v_row.brand,v_row.pack_size)<>p_key then raise exception 'Product details do not support automatic grouping'; end if;
  select * into v_mapping from item_mappings where organization_id=p_organization_id and vendor_item_id=v_row.id;
  if not found then raise exception 'Product association is missing'; end if;
  if not exists(select 1 from catalog_items where id=v_mapping.catalog_item_id and organization_id=p_organization_id and category_id=v_item.category_id and not coalesce(brand_locked,false) and comparison_mode='alternatives' and preferred_brand is null) then raise exception 'Category or comparison preference differs'; end if;
  if exists(select 1 from item_mappings m join vendor_items v on v.id=m.vendor_item_id where m.organization_id=p_organization_id and m.catalog_item_id=v_mapping.catalog_item_id and (kerdos_alternative_key(v.description,v.brand,v.pack_size)<>p_key or v.field_resolutions ? 'automatic_group_excluded' or v.field_resolutions ? 'unit_cost_override')) then raise exception 'Existing group contains different products'; end if;
 end loop;
 for v_row in select * from vendor_items where organization_id=p_organization_id and id=any(p_vendor_item_ids) order by id loop
  select * into v_mapping from item_mappings where organization_id=p_organization_id and vendor_item_id=v_row.id;
  update vendor_items set field_resolutions=jsonb_set(coalesce(field_resolutions,'{}'),'{automatic_group}',jsonb_build_object(
   'originalCatalogItemId',coalesce(field_resolutions->'automatic_group'->>'originalCatalogItemId',v_mapping.catalog_item_id::text),
   'catalogItemId',v_item.id,'key',p_key,'dimension',p_dimension,'groupedAt',now(),'groupedBy',auth.uid())),row_revision=row_revision+1 where id=v_row.id;
  update item_mappings set catalog_item_id=v_item.id,comparison_track='exact',confidence_score=100,match_method='rule_based' where id=v_mapping.id;
 end loop;
 return v_count;
end;
$$;

create or replace function public.kerdos_separate_automatic_alternatives(p_organization_id uuid,p_target_catalog_item_id uuid)
returns integer language plpgsql set search_path=public as $$
declare v_row vendor_items%rowtype; v_original uuid; v_count integer:=0;
begin
 if auth.uid() is null or not exists(select 1 from organization_members where organization_id=p_organization_id and user_id=auth.uid() and role in ('owner','manager')) then raise exception 'Owner or manager access is required'; end if;
 perform pg_advisory_xact_lock(hashtextextended(p_organization_id::text,23));
 for v_row in select v.* from vendor_items v join item_mappings m on m.vendor_item_id=v.id and m.organization_id=v.organization_id
  where v.organization_id=p_organization_id and m.catalog_item_id=p_target_catalog_item_id and m.match_method='rule_based' and v.field_resolutions->'automatic_group'->>'catalogItemId'=p_target_catalog_item_id::text order by v.id for update of v,m loop
  v_original:=(v_row.field_resolutions->'automatic_group'->>'originalCatalogItemId')::uuid;
  if not exists(select 1 from catalog_items where id=v_original and organization_id=p_organization_id) then raise exception 'Original item is unavailable; use the catalog link editor'; end if;
  update item_mappings set catalog_item_id=v_original,comparison_track='review',confidence_score=null,match_method='manual' where organization_id=p_organization_id and vendor_item_id=v_row.id;
  update vendor_items set field_resolutions=jsonb_set(field_resolutions-'automatic_group','{automatic_group_excluded}','true'),row_revision=row_revision+1 where id=v_row.id;
  v_count:=v_count+1;
 end loop;
 return v_count;
end;
$$;
revoke all on function public.kerdos_group_automatic_alternatives(uuid,uuid[],uuid,text,text,jsonb) from public;
revoke all on function public.kerdos_separate_automatic_alternatives(uuid,uuid) from public;
grant execute on function public.kerdos_group_automatic_alternatives(uuid,uuid[],uuid,text,text,jsonb) to authenticated;
grant execute on function public.kerdos_separate_automatic_alternatives(uuid,uuid) to authenticated;
