-- Migration 027: Tag categories with their source industry.
--
-- catalog_categories previously had no industry column, so there was no way
-- to distinguish categories loaded for a previous industry from those for the
-- current one after an industry change.  This adds the column so that
-- loadStarterPack can stamp new categories, and the UI can filter the dropdown
-- to the current industry.
--
-- Existing categories receive NULL.  When an organization has an industry set,
-- the UI filters dropdowns to rows whose industry matches exactly, so untagged
-- legacy categories are NOT offered for new assignments.  Items whose current
-- category falls outside that filtered set are handled in two distinct ways:
--
--   • Out-of-scope real category (non-holding-pen): injected once as a selectable
--     option labeled "<name> (legacy — reclassify)" so the current value renders
--     and the operator can consciously move the item.
--   • Holding pen (is_holding_pen = true): injected as a disabled option labeled
--     "Unclassified — assign a category" so the select renders without going
--     blank, while preventing the holding pen from being re-chosen as a
--     destination.
--
-- Untagged categories whose names match the current industry's starter-pack
-- templates are automatically retagged when loadStarterPack runs; others can be
-- manually removed once no catalog items reference them.
--
-- Existing catalog item assignments are unaffected; this migration touches only
-- catalog_categories metadata.

alter table catalog_categories
  add column if not exists industry text;
