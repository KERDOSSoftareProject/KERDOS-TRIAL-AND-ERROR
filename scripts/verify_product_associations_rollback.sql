-- Hosted test-project verification. JWT claims exercise database authorization;
-- this is not a real browser sign-in. All changes below are rolled back.
begin;
set local statement_timeout='20s';
set local lock_timeout='3s';
do $$declare actor uuid;begin
 select user_id into actor from public.organization_members where organization_id='89b0ee59-f39f-4a4e-8da0-329d3c3f8bcf' and role in('owner','manager') order by user_id limit 1;
 if actor is null then raise exception 'Trial owner/manager not found';end if;
 perform set_config('request.jwt.claim.sub',actor::text,true);
end;$$;
set local role authenticated;
do $$declare org uuid:='89b0ee59-f39f-4a4e-8da0-329d3c3f8bcf';request uuid:=gen_random_uuid();members jsonb;target uuid;before_fields jsonb;after_fields jsonb;before_maps jsonb;result jsonb;restored jsonb;count_before bigint;
begin
 select jsonb_agg(jsonb_build_object('id',v.id,'revision',v.row_revision,'catalogItemId',m.catalog_item_id) order by v.id),
 (array_agg(c.id order by c.master_item_number,c.id))[1] into members,target from public.vendor_items v join public.item_mappings m on m.vendor_item_id=v.id and m.organization_id=v.organization_id join public.catalog_items c on c.id=m.catalog_item_id
 where v.organization_id=org and v.description ilike '%honey%must%';
 if jsonb_array_length(members)<>4 then raise exception 'Unexpected example membership; inspect the current source';end if;
 select jsonb_agg(to_jsonb(v)-'row_revision'-'field_resolutions' order by v.id) into before_fields from public.vendor_items v where id in(select (value->>'id')::uuid from jsonb_array_elements(members));
 select jsonb_agg(to_jsonb(m) order by m.id) into before_maps from public.item_mappings m where vendor_item_id in(select (value->>'id')::uuid from jsonb_array_elements(members));
 select count(*) into count_before from public.price_history where organization_id=org;
 begin
  perform public.kerdos_associate_product_group(org,request,target,'Honey Mustard Dressing',jsonb_set(members,'{0,revision}','999999'::jsonb),'product-associations-1',true);
  raise exception 'Stale save unexpectedly succeeded';
 exception when raise_exception then if sqlerrm not like '%changed%' then raise;end if;end;
 result:=public.kerdos_associate_product_group(org,request,target,'Honey Mustard Dressing',members,'product-associations-1',true);
 if result->>'associated'<>'4' then raise exception 'Group count mismatch';end if;
 if public.kerdos_associate_product_group(org,request,target,'Honey Mustard Dressing',members,'product-associations-1',true) is distinct from result then raise exception 'Retry proof changed';end if;
 select jsonb_agg(to_jsonb(v)-'row_revision'-'field_resolutions' order by v.id) into after_fields from public.vendor_items v where id in(select (value->>'id')::uuid from jsonb_array_elements(members));
 if after_fields is distinct from before_fields then raise exception 'Source or quote fields changed';end if;
 if (select count(*) from public.price_history where organization_id=org)<>count_before then raise exception 'Price history changed';end if;
 if (select count(distinct catalog_item_id) from public.item_mappings where vendor_item_id in(select (value->>'id')::uuid from jsonb_array_elements(members)))<>1 then raise exception 'Group was not saved';end if;
 restored:=public.kerdos_restore_product_group(org,request);
 if restored->>'restored'<>'true' then raise exception 'Restore did not complete';end if;
 if (select jsonb_agg(to_jsonb(m) order by m.id) from public.item_mappings m where vendor_item_id in(select (value->>'id')::uuid from jsonb_array_elements(members))) is distinct from before_maps then raise exception 'Original mapping evidence not restored';end if;
end;$$;
reset role;
select 'PASS hosted real-source association save, retry, source/quote preservation, price-history preservation, stale-write rejection and exact mapping restore; transaction rolled back' result;
rollback;
