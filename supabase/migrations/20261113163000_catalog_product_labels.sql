-- Labels guide new assignments. Existing vendor mappings and item numbers are retained.
alter table public.catalog_items
  add column if not exists concept_key text,
  add column if not exists concept_key_set_at timestamptz,
  add column if not exists concept_split_from_id uuid,
  add column if not exists concept_review_required boolean not null default false,
  add column if not exists concept_review_reason text;

-- Keep split provenance after a parent is retired or removed.
comment on column public.catalog_items.concept_split_from_id is
  'Historical source item for an explicit split. The split is excluded from automatic import targets.';

create index if not exists idx_catalog_items_concept_key
  on public.catalog_items(organization_id, concept_key);

create or replace function public.kerdos_find_or_create_product_item(
  p_organization_id uuid,
  p_concept_key text,
  p_name text,
  p_category_id uuid,
  p_category_review boolean,
  p_category_reason text
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_item public.catalog_items%rowtype;
  v_name text := pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.lower(p_name), '[[:space:]]+', ' ', 'g'));
  v_same_label_count integer;
  v_category_valid boolean;
begin
  if current_user <> 'service_role' and not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = (select auth.uid())
  ) then
    raise exception 'Organization membership is required' using errcode = '42501';
  end if;
  if p_organization_id is null or nullif(v_name, '') is null
    or nullif(pg_catalog.btrim(p_concept_key), '') is null
    or pg_catalog.octet_length(p_concept_key) > 1024 then
    raise exception 'A product name and valid concept key are required' using errcode = '22023';
  end if;

  -- Recheck inside the same lock before creating. There can be multiple saved
  -- items with a label because a client can explicitly split a product.
  perform pg_catalog.pg_advisory_xact_lock(
    pg_catalog.hashtextextended(p_organization_id::text || ':' || p_concept_key, 13163000)
  );
  select count(*) into v_same_label_count
  from public.catalog_items c
  where c.organization_id = p_organization_id and c.concept_key = p_concept_key
    and c.lifecycle_state = 'active' and c.merged_into_id is null and not c.concept_review_required;

  select c.* into v_item
  from public.catalog_items c
  where c.organization_id = p_organization_id
    and c.lifecycle_state = 'active' and c.merged_into_id is null
    and c.concept_split_from_id is null and not c.concept_review_required
    and not exists (
      select 1 from public.item_mappings m
      where m.organization_id = p_organization_id and m.catalog_item_id = c.id and m.match_method = 'rejected'
    )
    and (c.concept_key = p_concept_key or (c.concept_key is null
      and pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.lower(c.name), '[[:space:]]+', ' ', 'g')) = v_name))
  order by (c.concept_key is null), c.created_at, c.id
  limit 1;
  if found then
    if v_item.concept_key is null then
      v_same_label_count := v_same_label_count + 1;
      if p_category_id is not null then
        -- The existing number trigger may reallocate an invalid legacy number.
        -- Stamp only rows with a valid existing number and unchanged name.
        update public.catalog_items c
        set concept_key = p_concept_key, concept_key_set_at = pg_catalog.now()
        from public.catalog_categories cat
        where c.id = v_item.id and c.organization_id = p_organization_id
          and c.name = v_item.name and c.concept_key is null
          and c.lifecycle_state = 'active' and c.merged_into_id is null
          and c.concept_split_from_id is null and not c.concept_review_required
          and cat.id = c.category_id and cat.organization_id = p_organization_id
          and c.master_item_number between cat.range_start and cat.range_end
        returning c.* into v_item;
        if not found then
          -- Re-evaluate after a competing update or an invalid legacy range.
          select c.* into v_item
          from public.catalog_items c
          where c.organization_id = p_organization_id
            and c.lifecycle_state = 'active' and c.merged_into_id is null
            and c.concept_split_from_id is null and not c.concept_review_required
            and not exists (
              select 1 from public.item_mappings m
              where m.organization_id = p_organization_id and m.catalog_item_id = c.id and m.match_method = 'rejected'
            )
            and (c.concept_key = p_concept_key or (c.concept_key is null
              and pg_catalog.btrim(pg_catalog.regexp_replace(pg_catalog.lower(c.name), '[[:space:]]+', ' ', 'g')) = v_name))
          order by (c.concept_key is null), c.created_at, c.id
          limit 1;
        end if;
      end if;
    end if;
    if v_item.id is not null then
      return pg_catalog.jsonb_build_object('item', pg_catalog.to_jsonb(v_item), 'created', false, 'sameLabelCount', v_same_label_count);
    end if;
  end if;

  if p_category_id is null then
    return pg_catalog.jsonb_build_object('item', null, 'created', false, 'sameLabelCount', v_same_label_count);
  end if;

  select exists (
    select 1 from public.catalog_categories cat
    where cat.id = p_category_id and cat.organization_id = p_organization_id
      and cat.range_start > 0 and cat.range_end >= cat.range_start
  ) into v_category_valid;
  if not v_category_valid then
    raise exception 'Choose a category with a valid KERDOS number range in this organization' using errcode = '22023';
  end if;

  -- The catalog's existing trigger allocates and retains the KERDOS number.
  insert into public.catalog_items (
    organization_id, category_id, name, matching_behavior, canonical_unit, brand_locked,
    category_review, category_reason, concept_key, concept_key_set_at
  ) values (
    p_organization_id, p_category_id, pg_catalog.left(pg_catalog.btrim(p_name), 120), 'flexible', null, false,
    coalesce(p_category_review, false), p_category_reason, p_concept_key, pg_catalog.now()
  )
  returning * into v_item;
  return pg_catalog.jsonb_build_object('item', pg_catalog.to_jsonb(v_item), 'created', true, 'sameLabelCount', v_same_label_count + 1);
end;
$$;

revoke all on function public.kerdos_find_or_create_product_item(uuid, text, text, uuid, boolean, text)
  from public, anon, authenticated, service_role;
grant execute on function public.kerdos_find_or_create_product_item(uuid, text, text, uuid, boolean, text)
  to authenticated, service_role;

-- The deployment backfill derives labels with the same JavaScript reader used
-- by imports. Apply a batch only to still-unlabelled rows with the same name.
create or replace function public.kerdos_backfill_product_labels(p_organization_id uuid, p_items jsonb)
returns integer
language plpgsql
security invoker
set search_path = ''
as $$
declare
  v_updated integer;
begin
  if current_user <> 'service_role' then
    raise exception 'Service role access is required' using errcode = '42501';
  end if;
  if pg_catalog.jsonb_typeof(p_items) is distinct from 'array'
    or pg_catalog.jsonb_array_length(p_items) > 200 then
    raise exception 'Provide up to 200 product labels' using errcode = '22023';
  end if;
  update public.catalog_items c
  set concept_key = batch.key, concept_key_set_at = pg_catalog.now()
  from pg_catalog.jsonb_to_recordset(p_items) as batch(id uuid, name text, key text),
    public.catalog_categories cat
  where c.id = batch.id and c.organization_id = p_organization_id and c.name = batch.name
    and c.concept_key is null and c.lifecycle_state = 'active' and c.merged_into_id is null
    and not c.concept_review_required and nullif(pg_catalog.btrim(batch.key), '') is not null
    and pg_catalog.octet_length(batch.key) <= 1024
    and not exists (
      select 1 from public.item_mappings m
      where m.organization_id = p_organization_id and m.catalog_item_id = c.id and m.match_method = 'rejected'
    )
    and cat.id = c.category_id and cat.organization_id = p_organization_id
    and c.master_item_number between cat.range_start and cat.range_end;
  get diagnostics v_updated = row_count;
  return v_updated;
end;
$$;
revoke all on function public.kerdos_backfill_product_labels(uuid, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.kerdos_backfill_product_labels(uuid, jsonb) to service_role;

-- Record an explicit rejection as a split even if the source product has no label yet.
create or replace function public.kerdos_reject_mapping(
  p_organization_id          uuid,
  p_mapping_id               uuid,
  p_expected_revision        bigint,
  p_expected_catalog_item_id uuid
)
returns jsonb language plpgsql set search_path = public as $$
declare
  v_mapping   item_mappings%rowtype;
  v_vendor    vendor_items%rowtype;
  v_item      catalog_items%rowtype;
  v_new       catalog_items%rowtype;
  v_rejected  jsonb;
  v_resolutions jsonb;
begin
  -- Guard: p_expected_catalog_item_id is required — callers must supply the catalog item
  -- they are looking at so the stale-mapping check below can run unconditionally.
  -- A NULL here means the caller is using an outdated code path; fail loudly.
  if p_expected_catalog_item_id is null then
    raise exception 'expected_catalog_item_id is required';
  end if;

  -- Authorization: owner or manager only.
  if auth.uid() is null or not exists (
    select 1 from organization_members
    where organization_id = p_organization_id
      and user_id = auth.uid()
      and role in ('owner', 'manager')
  ) then
    raise exception 'Owner or manager access is required';
  end if;

  -- Read mapping first (no lock yet).
  select * into v_mapping from item_mappings
  where id = p_mapping_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Association not found';
  end if;

  -- Lock vendor item and check revision (optimistic concurrency).
  select * into v_vendor from vendor_items
  where id = v_mapping.vendor_item_id and organization_id = p_organization_id
  for update;
  if not found then
    raise exception 'Vendor product not found';
  end if;
  if p_expected_revision is null or v_vendor.row_revision <> p_expected_revision then
    raise exception 'This product changed; refresh before rejecting';
  end if;

  -- Re-read mapping under lock to guard against concurrent changes.
  select * into v_mapping from item_mappings
  where id = p_mapping_id and organization_id = p_organization_id
  for update;

  -- Stale-mapping check: the operator must have been looking at the same catalog
  -- item they are now rejecting.  p_expected_catalog_item_id is required (checked
  -- above), so this comparison is always meaningful.
  if v_mapping.catalog_item_id <> p_expected_catalog_item_id then
    raise exception 'The association changed since you loaded this page; refresh and try again';
  end if;

  -- Read the wrongly-matched catalog item (for category inheritance).
  select * into v_item from catalog_items
  where id = v_mapping.catalog_item_id and organization_id = p_organization_id;
  if not found then
    raise exception 'Catalog item not found';
  end if;

  -- Create a standalone catalog item for the vendor product.
  -- Inherits the same category placement (and its review flag) so the item
  -- does not lose its KERDOS number range context.
  insert into catalog_items (
    organization_id, category_id, name,
    category_review, category_reason,
    matching_behavior, comparison_mode, brand_locked, concept_split_from_id
  )
  values (
    p_organization_id,
    v_item.category_id,
    left(v_vendor.description, 120),
    v_item.category_review,
    v_item.category_reason,
    'flexible',
    'alternatives',
    false,
    v_item.id
  )
  returning * into v_new;

  -- Append the rejected catalog item ID to field_resolutions.
  v_resolutions := coalesce(v_vendor.field_resolutions, '{}'::jsonb);
  select coalesce(
    jsonb_agg(distinct value),
    '[]'::jsonb
  ) into v_rejected
  from jsonb_array_elements_text(
    coalesce(v_resolutions -> 'rejected_catalog_item_ids', '[]'::jsonb)
    || to_jsonb(v_item.id::text)
  );
  v_resolutions := jsonb_set(v_resolutions, '{rejected_catalog_item_ids}', v_rejected);

  -- Bump row_revision so concurrent reimports see a fresh record.
  update vendor_items
  set field_resolutions = v_resolutions,
      row_revision = row_revision + 1
  where id = v_vendor.id;

  -- Point the mapping at the new standalone item.
  -- match_method='rejected' marks the origin; comparison_track='review' keeps it
  -- out of automatic cross-vendor grouping until confirmed.
  update item_mappings
  set catalog_item_id  = v_new.id,
      comparison_track = 'review',
      confidence_score = 0,
      match_method     = 'rejected'
  where id = p_mapping_id;

  return jsonb_build_object(
    'catalogItemId',      v_new.id,
    'masterItemNumber',   v_new.master_item_number,
    'rejectedCatalogItemId', v_item.id
  );
end;
$$;

revoke all on function public.kerdos_reject_mapping(uuid, uuid, bigint, uuid) from public;
grant execute on function public.kerdos_reject_mapping(uuid, uuid, bigint, uuid) to authenticated;
