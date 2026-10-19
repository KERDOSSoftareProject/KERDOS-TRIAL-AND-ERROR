-- Migration 028: Atomic mapping rejection.
--
-- Rejection records a human decision that a specific catalog item is the wrong
-- match for a vendor product.  The vendor item is given its own standalone
-- catalog item so it remains visible and orderable under the usual readiness
-- rules.  The rejected catalog item ID is stored in
-- vendor_items.field_resolutions.rejected_catalog_item_ids so future imports
-- (which skip matchOrCreate when an existing mapping is found) and deliberate
-- remaps can consult it.
--
-- Three properties are preserved across reimports:
--   1. The standalone mapping created here survives because importPriceRow
--      finds existingMapping and never calls matchOrCreate again.
--   2. The rejected catalog item ID is recorded so a deliberate remap back to
--      that item can clear only that one rejection, leaving any others intact.
--   3. Vendor item fields, price history, and KERDOS number are untouched.
--
-- A later explicit remap to a DIFFERENT catalog item leaves rejected_catalog_item_ids
-- unchanged.  A remap to the EXACT rejected item removes only that UUID from the
-- array (handled in the JS service layer via remapToExisting).
--
-- This function never touches the wrongly-matched catalog item or its other
-- vendor links.

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
    matching_behavior, comparison_mode, brand_locked
  )
  values (
    p_organization_id,
    v_item.category_id,
    left(v_vendor.description, 120),
    v_item.category_review,
    v_item.category_reason,
    'flexible',
    'alternatives',
    false
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

-- p_expected_catalog_item_id is now required (no default); the three-argument overload
-- is dropped by migration_030.  Only this four-argument variant remains.
revoke all on function public.kerdos_reject_mapping(uuid, uuid, bigint, uuid) from public;
grant execute on function public.kerdos_reject_mapping(uuid, uuid, bigint, uuid) to authenticated;
