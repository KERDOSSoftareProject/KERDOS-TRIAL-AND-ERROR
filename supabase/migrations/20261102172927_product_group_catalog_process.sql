-- Apply engine groups without pretending a client reviewed their identity.
create or replace function public.kerdos_associate_product_group(p_organization_id uuid,p_request_id uuid,p_target_catalog_item_id uuid,p_name text,p_members jsonb,p_version text,p_confirmed boolean)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare target public.catalog_items%rowtype;v public.vendor_items%rowtype;m public.item_mappings%rowtype;
 ids uuid[];source_ids uuid[];entry jsonb;resolutions jsonb;payload jsonb;before_data jsonb;result_data jsonb;prior public.product_association_events%rowtype;created_target boolean:=false;
begin
 if (select auth.uid()) is null or not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in('owner','manager')) then raise exception 'Owner or manager access is required' using errcode='42501';end if;
 if p_confirmed is null or p_request_id is null or p_version is distinct from 'product-associations-1' then raise exception 'Confirm the current product association review';end if;
 if nullif(btrim(p_name),'') is null or length(p_name)>120 then raise exception 'Enter a product group name up to 120 characters';end if;
 if jsonb_typeof(p_members) is distinct from 'array' or jsonb_array_length(p_members) not between 1 and 100 then raise exception 'Select 1 to 100 listings';end if;
 select array_agg((value->>'id')::uuid order by value->>'id') into ids from jsonb_array_elements(p_members);
 if cardinality(ids)<>(select count(distinct id) from unnest(ids) id) or array_position(ids,null) is not null then raise exception 'Duplicate or missing listing IDs';end if;
 payload:=jsonb_build_object('target',p_target_catalog_item_id,'name',btrim(p_name),'members',p_members,'version',p_version,'confirmed',p_confirmed);
 -- Serializes same-request retries before listing locks; unrelated runs continue.
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 select * into prior from public.product_association_events where request_id=p_request_id;
 if found then
  if prior.organization_id<>p_organization_id or prior.created_by<>(select auth.uid()) or prior.payload is distinct from payload then raise exception 'Request belongs to a different review';end if;
  if prior.restored_at is not null then raise exception 'This saved group was restored; start a fresh review';end if;
  if exists(select 1 from public.item_mappings where organization_id=p_organization_id and vendor_item_id=any(ids) and catalog_item_id<>coalesce(p_target_catalog_item_id,(prior.result->>'catalogItemId')::uuid)) then raise exception 'This review was saved earlier; later associations must be retained. Refresh.';end if;
  return prior.result;
 end if;
 perform 1 from public.vendor_items where organization_id=p_organization_id and id=any(ids) order by id for update;
 if (select count(*) from public.vendor_items where organization_id=p_organization_id and id=any(ids))<>cardinality(ids) then raise exception 'A listing is outside this organization';end if;
 perform 1 from public.item_mappings where organization_id=p_organization_id and vendor_item_id=any(ids) order by vendor_item_id,id for update;
 if (select count(*) from public.item_mappings where organization_id=p_organization_id and vendor_item_id=any(ids))<>cardinality(ids) or
  (select count(distinct vendor_item_id) from public.item_mappings where organization_id=p_organization_id and vendor_item_id=any(ids))<>cardinality(ids) then raise exception 'Each listing needs one current association';end if;
 select array_agg(distinct catalog_item_id) into source_ids from public.item_mappings where organization_id=p_organization_id and vendor_item_id=any(ids);
 
 perform 1 from public.catalog_items where organization_id=p_organization_id and id=any(source_ids||p_target_catalog_item_id) order by id for update;
 if p_target_catalog_item_id is null then
  insert into public.catalog_items(organization_id,category_id,name,comparison_mode)
  select p_organization_id,category_id,btrim(p_name),'alternatives' from public.catalog_items where id=source_ids[1] returning * into target;
  created_target:=true;
 else
  select * into target from public.catalog_items where id=p_target_catalog_item_id and organization_id=p_organization_id;
  if not found or not(p_target_catalog_item_id=any(source_ids)) or target.merged_into_id is not null then raise exception 'Choose a current target from the reviewed listings';end if;
 end if;
 if exists(select 1 from public.catalog_items where id=any(source_ids) and (brand_locked or preferred_brand is not null or comparison_mode='exact')) then raise exception 'A product has a client restriction; retain that decision';end if;
 if exists(select 1 from public.item_mappings where organization_id=p_organization_id and catalog_item_id=target.id and not(vendor_item_id=any(ids))) then raise exception 'Review all existing target listings before grouping';end if;
 if exists(select 1 from public.vendor_items a join public.vendor_items b on b.id=any(ids) and b.organization_id=p_organization_id where a.id=any(ids) and a.organization_id=p_organization_id and coalesce(a.field_resolutions->'rejected_vendor_item_ids','[]'::jsonb)?b.id::text) then raise exception 'A pair was previously rejected; retain that decision';end if;
 for entry in select value from jsonb_array_elements(p_members) loop
  select * into v from public.vendor_items where id=(entry->>'id')::uuid;
  select * into m from public.item_mappings where organization_id=p_organization_id and vendor_item_id=v.id;
  if v.row_revision is distinct from (entry->>'revision')::bigint or m.catalog_item_id is distinct from (entry->>'catalogItemId')::uuid then raise exception 'A listing or association changed; refresh before saving';end if;
 end loop;
 before_data:=jsonb_build_object('createdTarget',created_target,'vendors',(select jsonb_agg(jsonb_build_object('id',id,'field_resolutions',field_resolutions,'row_revision',row_revision) order by id) from public.vendor_items where id=any(ids)),
 'mappings',(select jsonb_agg(to_jsonb(x) order by id) from public.item_mappings x where organization_id=p_organization_id and vendor_item_id=any(ids)),
 'catalog',(select jsonb_agg(jsonb_build_object('id',id,'name',name,'merged_into_id',merged_into_id) order by id) from public.catalog_items where id=any(source_ids||target.id)));
 for v in select * from public.vendor_items where id=any(ids) order by id loop
  resolutions:=coalesce(v.field_resolutions,'{}'::jsonb)-'automatic_group'-'row_approval';
  resolutions:=jsonb_set(resolutions,'{product_group}',jsonb_build_object('catalogItemId',target.id,'description',v.description,'brand',v.brand,'requestId',p_request_id,'confirmed',p_confirmed,'confirmedBy',case when p_confirmed then (select auth.uid()) else null end,'confirmedAt',case when p_confirmed then now() else null end));
  if p_confirmed then resolutions:=jsonb_set(resolutions,'{catalog_item_id}',jsonb_build_object('value',target.id,'confirmedBy',(select auth.uid()),'confirmedAt',now()));else resolutions:=resolutions-'catalog_item_id';end if;
  update public.vendor_items set field_resolutions=resolutions,row_revision=row_revision+1 where id=v.id;
 end loop;
 update public.item_mappings set catalog_item_id=target.id,comparison_track=case when p_confirmed then 'exact' else 'review' end,confidence_score=case when p_confirmed then 100 else 70 end,match_method=case when p_confirmed then 'manual' else 'rule_based' end,reviewed_by=(select auth.uid()),reviewed_at=now() where organization_id=p_organization_id and vendor_item_id=any(ids);
 update public.catalog_items set name=btrim(p_name) where id=target.id;
 update public.catalog_items c set merged_into_id=target.id where c.id=any(source_ids) and c.id<>target.id and not exists(select 1 from public.item_mappings where catalog_item_id=c.id);
 result_data:=jsonb_build_object('catalogItemId',target.id,'masterItemNumber',target.master_item_number,'associated',cardinality(ids),'requestId',p_request_id);
 insert into public.product_association_events(request_id,organization_id,payload,before_state,after_state,result) values(p_request_id,p_organization_id,payload,before_data,
 jsonb_build_object('mappings',(select jsonb_agg(to_jsonb(x) order by id) from public.item_mappings x where organization_id=p_organization_id and vendor_item_id=any(ids)),
 'catalog',(select jsonb_agg(to_jsonb(x) order by id) from public.catalog_items x where id=any(source_ids||target.id))),result_data);
 return result_data;
end;$$;
revoke all on function public.kerdos_associate_product_group(uuid,uuid,uuid,text,jsonb,text,boolean) from public,anon;
grant execute on function public.kerdos_associate_product_group(uuid,uuid,uuid,text,jsonb,text,boolean) to authenticated;


create or replace function public.kerdos_restore_product_group(p_organization_id uuid,p_request_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare event public.product_association_events%rowtype;ids uuid[];entry jsonb;target_id uuid;
begin
 if (select auth.uid()) is null or not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid()) and role in('owner','manager')) then raise exception 'Owner or manager access is required' using errcode='42501';end if;
 perform pg_advisory_xact_lock(hashtextextended(p_request_id::text,0));
 select * into event from public.product_association_events where request_id=p_request_id and organization_id=p_organization_id for update;
 if not found or event.created_by<>(select auth.uid()) then raise exception 'Saved review not found for this user';end if;
 if event.restored_at is not null then return jsonb_build_object('restored',true,'requestId',p_request_id);end if;
 select array_agg((value->>'id')::uuid) into ids from jsonb_array_elements(event.before_state->'vendors');
 target_id:=(event.result->>'catalogItemId')::uuid;
 perform 1 from public.vendor_items where id=any(ids) order by id for update;
 perform 1 from public.item_mappings where organization_id=p_organization_id and vendor_item_id=any(ids) order by vendor_item_id,id for update;
 perform 1 from public.catalog_items where id in(select (value->>'id')::uuid from jsonb_array_elements(event.before_state->'catalog')) order by id for update;
 for entry in select value from jsonb_array_elements(event.before_state->'vendors') loop
  if not exists(select 1 from public.vendor_items where id=(entry->>'id')::uuid and organization_id=p_organization_id and row_revision=(entry->>'row_revision')::bigint+1 and field_resolutions->'product_group'->>'requestId'=p_request_id::text) then raise exception 'Later listing changes must be retained; automatic restore is unavailable';end if;
 end loop;
 if (select count(*) from public.item_mappings where organization_id=p_organization_id and vendor_item_id=any(ids) and catalog_item_id=target_id)<>cardinality(ids) or exists(select 1 from public.item_mappings where catalog_item_id=target_id and not(vendor_item_id=any(ids))) then raise exception 'Later association changes must be retained';end if;
 if (select jsonb_agg(to_jsonb(x) order by id) from public.item_mappings x where organization_id=p_organization_id and vendor_item_id=any(ids)) is distinct from event.after_state->'mappings' then raise exception 'Later mapping decisions must be retained';end if;
 if (select jsonb_agg(to_jsonb(x) order by id) from public.catalog_items x where id in(select (value->>'id')::uuid from jsonb_array_elements(event.before_state->'catalog'))) is distinct from event.after_state->'catalog' then raise exception 'Later catalog decisions must be retained';end if;
 if not exists(select 1 from public.catalog_items where id=target_id and name=event.payload->>'name') then raise exception 'The group name changed; retain the newer decision';end if;
 if exists(select 1 from public.catalog_items where id in(select (value->>'id')::uuid from jsonb_array_elements(event.before_state->'catalog')) and id<>target_id and merged_into_id is distinct from target_id and merged_into_id is not null) then raise exception 'Later catalog changes must be retained';end if;
 for entry in select value from jsonb_array_elements(event.before_state->'mappings') loop
  update public.item_mappings set catalog_item_id=(entry->>'catalog_item_id')::uuid,comparison_track=entry->>'comparison_track',confidence_score=(entry->>'confidence_score')::integer,match_method=entry->>'match_method',reviewed_by=(entry->>'reviewed_by')::uuid,reviewed_at=(entry->>'reviewed_at')::timestamptz where id=(entry->>'id')::uuid and organization_id=p_organization_id;
 end loop;
 for entry in select value from jsonb_array_elements(event.before_state->'vendors') loop
  update public.vendor_items set field_resolutions=entry->'field_resolutions',row_revision=row_revision+1 where id=(entry->>'id')::uuid and organization_id=p_organization_id;
 end loop;
 for entry in select value from jsonb_array_elements(event.before_state->'catalog') loop
  update public.catalog_items set merged_into_id=(entry->>'merged_into_id')::uuid where id=(entry->>'id')::uuid;
 end loop;
 if event.before_state->>'createdTarget'='true' then update public.catalog_items set merged_into_id=(event.before_state->'mappings'->0->>'catalog_item_id')::uuid where id=target_id;else update public.catalog_items set name=(select value->>'name' from jsonb_array_elements(event.before_state->'catalog') where value->>'id'=target_id::text) where id=target_id;end if;
 update public.product_association_events set restored_at=now() where request_id=p_request_id;
 return jsonb_build_object('restored',true,'requestId',p_request_id);
end;$$;
revoke all on function public.kerdos_restore_product_group(uuid,uuid) from public,anon;
grant execute on function public.kerdos_restore_product_group(uuid,uuid) to authenticated;
