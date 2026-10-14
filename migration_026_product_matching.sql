-- Atomic engine reassociation. Product interpretation remains provider-neutral
-- JavaScript; this boundary protects organization, roles and stale rows.
create or replace function public.kerdos_match_vendor_item(p_organization_id uuid,p_mapping_id uuid,p_expected_catalog_item_id uuid,p_target_catalog_item_id uuid,p_expected_revision bigint,p_track text)
returns jsonb language plpgsql set search_path=public as $$
declare v_mapping item_mappings%rowtype; v_vendor vendor_items%rowtype;
begin
 if auth.uid() is null or not exists(select 1 from organization_members where organization_id=p_organization_id and user_id=auth.uid() and role in ('owner','manager')) then raise exception 'Owner or manager access is required'; end if;
 if p_track not in ('exact','review') or p_track is null then raise exception 'Unknown matching track'; end if;
 select * into v_mapping from item_mappings where id=p_mapping_id and organization_id=p_organization_id;
 if not found then raise exception 'Association not found'; end if;
 select * into v_vendor from vendor_items where id=v_mapping.vendor_item_id and organization_id=p_organization_id for update;
 if not found or p_expected_revision is null or v_vendor.row_revision<>p_expected_revision then raise exception 'Product changed; refresh before matching'; end if;
 select * into v_mapping from item_mappings where id=p_mapping_id and organization_id=p_organization_id for update;
 if v_mapping.catalog_item_id<>p_expected_catalog_item_id or v_mapping.match_method='manual' then raise exception 'Association changed or was set by the client'; end if;
 perform 1 from catalog_items where id=p_target_catalog_item_id and organization_id=p_organization_id for update;
 if not found then raise exception 'Target item is outside this organization'; end if;
 if not exists(select 1 from item_mappings where catalog_item_id=p_target_catalog_item_id and organization_id=p_organization_id and vendor_item_id<>v_vendor.id) then raise exception 'Target needs an existing vendor listing'; end if;
 if exists(select 1 from item_mappings m join vendor_items v on v.id=m.vendor_item_id where m.catalog_item_id=p_target_catalog_item_id and m.organization_id=p_organization_id and (coalesce(v_vendor.field_resolutions->'rejected_vendor_item_ids','[]'::jsonb) ? v.id::text or coalesce(v.field_resolutions->'rejected_vendor_item_ids','[]'::jsonb) ? v_vendor.id::text)) then raise exception 'This association was rejected by the client'; end if;
 update item_mappings set catalog_item_id=p_target_catalog_item_id,comparison_track=p_track,confidence_score=case when p_track='exact' then 100 else 70 end,match_method='rule_based' where id=p_mapping_id;
 update vendor_items set row_revision=row_revision+1,field_resolutions=coalesce(field_resolutions,'{}'::jsonb)-'automatic_group' where id=v_vendor.id;
 return jsonb_build_object('catalogItemId',p_target_catalog_item_id,'track',p_track);
end;
$$;
revoke all on function public.kerdos_match_vendor_item(uuid,uuid,uuid,uuid,bigint,text) from public;
grant execute on function public.kerdos_match_vendor_item(uuid,uuid,uuid,uuid,bigint,text) to authenticated;
