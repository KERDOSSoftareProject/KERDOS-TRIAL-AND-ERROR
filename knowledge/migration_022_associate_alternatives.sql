-- One atomic approval of specifically selected vendor alternatives.
create or replace function public.kerdos_associate_alternatives(p_organization_id uuid,p_vendor_item_ids uuid[],p_target_catalog_item_id uuid,p_name text,p_preferred_brand text,p_revisions jsonb)
returns jsonb language plpgsql set search_path=public as $$
declare v_item catalog_items%rowtype; v_vendor vendor_items%rowtype; v_key text; v_value jsonb; v_count integer; v_resolutions jsonb;
begin
 if auth.uid() is null or not exists(select 1 from organization_members where organization_id=p_organization_id and user_id=auth.uid() and role in ('owner','manager')) then raise exception 'Owner or manager access is required'; end if;
 select count(distinct id) into v_count from unnest(p_vendor_item_ids) id;
 if v_count<2 or v_count>100 then raise exception 'Select between 2 and 100 vendor products'; end if;
 if nullif(btrim(p_name),'') is null then raise exception 'Enter the shared item type'; end if;
 perform 1 from vendor_items where id=any(p_vendor_item_ids) and organization_id=p_organization_id order by id for update;
 if (select count(*) from vendor_items where id=any(p_vendor_item_ids) and organization_id=p_organization_id)<>v_count then raise exception 'A selected product is outside this organization'; end if;
 select * into v_item from catalog_items where id=p_target_catalog_item_id and organization_id=p_organization_id for update;
 if not found then raise exception 'Choose an existing item in this organization'; end if;
 if not exists(select 1 from item_mappings where catalog_item_id=v_item.id and vendor_item_id=any(p_vendor_item_ids) and organization_id=p_organization_id) then raise exception 'Choose a target from the selected items'; end if;
 if (select count(distinct vendor_item_id) from item_mappings where vendor_item_id=any(p_vendor_item_ids) and organization_id=p_organization_id)<>v_count then raise exception 'A selected association changed; refresh and select again'; end if;
 for v_vendor in select * from vendor_items where id=any(p_vendor_item_ids) and organization_id=p_organization_id order by id loop
  if (p_revisions->>v_vendor.id::text)::bigint is null or (p_revisions->>v_vendor.id::text)::bigint<>v_vendor.row_revision then raise exception 'A selected product changed; refresh and select again'; end if;
  v_resolutions:=coalesce(v_vendor.field_resolutions,'{}'::jsonb)-'automatic_group';
  for v_key,v_value in select key,value from jsonb_each(jsonb_build_object('description',v_vendor.description,'brand',v_vendor.brand,'pack_size',v_vendor.pack_size,'selling_unit',v_vendor.selling_unit,'price',v_vendor.price,'catalog_item_id',v_item.id,'category_id',v_item.category_id)) loop
   v_resolutions:=jsonb_set(v_resolutions,array[v_key],jsonb_build_object('value',v_value,'confirmedAt',now(),'confirmedBy',auth.uid(),'sourceValue',coalesce(v_resolutions->v_key->'sourceValue',v_value)));
  end loop;
  v_resolutions:=jsonb_set(v_resolutions,'{row_approval}',jsonb_build_object('confirmedAt',now(),'confirmedBy',auth.uid(),'catalogItemId',v_item.id));
  update vendor_items set field_resolutions=v_resolutions,row_revision=row_revision+1 where id=v_vendor.id;
 end loop;
 update item_mappings set catalog_item_id=v_item.id,comparison_track='exact',confidence_score=100,match_method='manual' where organization_id=p_organization_id and vendor_item_id=any(p_vendor_item_ids);
 update catalog_items set name=left(btrim(p_name),120),comparison_mode='alternatives',preferred_brand=nullif(btrim(p_preferred_brand),''),brand_locked=false,locked_brand=null where id=v_item.id;
 return jsonb_build_object('catalogItemId',v_item.id,'masterItemNumber',v_item.master_item_number,'associated',v_count);
end;
$$;
revoke all on function public.kerdos_associate_alternatives(uuid,uuid[],uuid,text,text,jsonb) from public;
grant execute on function public.kerdos_associate_alternatives(uuid,uuid[],uuid,text,text,jsonb) to authenticated;
