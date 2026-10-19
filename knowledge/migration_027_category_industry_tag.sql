-- Migration 027: Tag categories with their source industry.
--
-- catalog_categories previously had no industry column, so there was no way
-- to distinguish categories loaded for a previous industry from those for the
-- current one after an industry change.  This adds the column so that
-- loadStarterPack can stamp new categories, and the UI can filter the dropdown
-- to the current industry.
--
-- Existing categories receive NULL, which the application treats conservatively:
-- legacy categories without an industry tag remain visible in dropdowns rather
-- than being silently hidden.  Operators can manually remove stale categories
-- after verifying that no catalog items are assigned to them.
--
-- Existing catalog item assignments are unaffected; this migration touches only
-- catalog_categories metadata.

alter table catalog_categories
  add column if not exists industry text;
