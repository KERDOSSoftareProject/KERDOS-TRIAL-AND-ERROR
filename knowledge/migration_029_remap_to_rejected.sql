-- Migration 029: Atomic remap-to-rejected.
--
-- When an operator deliberately remaps a vendor item back to a catalog item
-- they previously rejected, two things must happen together:
--   1. Remove that catalog item's UUID from field_resolutions.rejected_catalog_item_ids.
--   2. Point item_mappings.catalog_item_id at the destination.
--   3. Bump vendor_items.row_revision.
--
-- The prior approach (two separate JS writes) was unsafe: if the second write
-- failed, the rejection was cleared but the mapping still pointed at the old
-- standalone item, leaving the vendor item in an inconsistent state.
--
-- This RPC does all three in one transaction under a row lock.  It also verifies:
--   a) The operator's row_revision matches (optimistic concurrency).
--   b) The mapping still points at the item the operator saw before acting
--      (stale-mapping check — another session may have remapped concurrently).
--
-- A remap to an item that was NOT previously rejected works fine: the WHERE
-- filter in the array removal is a no-op when the UUID is absent.

create or replace function public.kerdos_remap_to_rejected(
  p_organization_id           uuid,
  p_mapping_id                uuid,
  p_new_catalog_item_id       uuid,
  p_expected_revision         bigint,
  p_expected_catalog_item_id  uuid,
  p_comparison_track          text,
  p_confidence_score          int,
  p_match_method              text
)
returns void language plpgsql set search_path = public as $$
declare
  v_mapping     item_mappings%rowtype;
  v_vendor      vendor_items%rowtype;
  v_resolutions jsonb;
  v_rejected    jsonb;
begin
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
    raise exception 'This product changed; refresh before remapping';
  end if;

  -- Re-read mapping under lock.
  select * into v_mapping from item_mappings
  where id = p_mapping_id and organization_id = p_organization_id
  for update;

  -- Stale-mapping check: mapping must still point at the item the operator saw.
  if v_mapping.catalog_item_id <> p_expected_catalog_item_id then
    raise exception 'The association changed since you loaded this page; refresh and try again';
  end if;

  -- Organization ownership check: the destination catalog item must belong to the
  -- same organization.  Without this, a caller could remap to any item in the database
  -- by guessing its UUID, which would leak cross-org data.
  if not exists (
    select 1 from catalog_items
    where id = p_new_catalog_item_id and organization_id = p_organization_id
  ) then
    raise exception 'Destination catalog item not found in this organization';
  end if;

  -- Remove this catalog item's UUID from rejected_catalog_item_ids (if present).
  -- Uses a WHERE filter so absent UUIDs are a safe no-op.
  v_resolutions := coalesce(v_vendor.field_resolutions, '{}'::jsonb);
  select coalesce(jsonb_agg(value), '[]'::jsonb) into v_rejected
  from jsonb_array_elements_text(
    coalesce(v_resolutions -> 'rejected_catalog_item_ids', '[]'::jsonb)
  )
  where value <> p_new_catalog_item_id::text;
  v_resolutions := jsonb_set(v_resolutions, '{rejected_catalog_item_ids}', v_rejected);

  -- Update vendor_items and item_mappings atomically, bump row_revision.
  update vendor_items
  set field_resolutions = v_resolutions,
      row_revision      = row_revision + 1
  where id = v_vendor.id;

  update item_mappings
  set catalog_item_id  = p_new_catalog_item_id,
      comparison_track = p_comparison_track,
      confidence_score = p_confidence_score,
      match_method     = p_match_method
  where id = p_mapping_id;
end;
$$;

revoke all on function public.kerdos_remap_to_rejected(uuid, uuid, uuid, bigint, uuid, text, int, text) from public;
grant execute on function public.kerdos_remap_to_rejected(uuid, uuid, uuid, bigint, uuid, text, int, text) to authenticated;
