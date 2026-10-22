-- ============================================================
-- Migration 034: enforce same-org vendor assignment on routing addresses
--
-- Problem: email_routing_addresses.vendor_id is a simple FK to vendors.id
-- with no org-scoping. A routing address belonging to org A could reference
-- a vendor belonging to org B.
--
-- Fix: replace the single-column FK with a composite FK
--   (organization_id, vendor_id) → vendors(organization_id, id)
--   ON DELETE SET NULL (vendor_id)
--
-- Why composite FK and not a CHECK constraint or trigger:
--   A CHECK constraint cannot query other tables. A trigger needs maintenance.
--   A composite FK is declarative, enforced by the DB engine on every
--   INSERT/UPDATE, and is zero-maintenance.
--
-- Why PostgreSQL allows this with a nullable vendor_id:
--   PostgreSQL skips FK enforcement when any column in the FK key is NULL.
--   vendor_id IS NULL (no vendor assigned) is always valid.
--
-- Delete behavior:
--   Migration 033 added vendor_id with ON DELETE SET NULL via the simple FK
--   email_routing_addresses_vendor_id_fkey. That FK is dropped here and
--   replaced by the composite FK, which carries the same ON DELETE SET NULL
--   semantic using the PG 17 column-list syntax: ON DELETE SET NULL (vendor_id).
--   Deleting a vendor clears only vendor_id and leaves the routing address and
--   its organization intact.
--
-- Apply to: kerdos-test first, then production after verification.
--
-- Prerequisites:
--   Migration 032 (creates email_routing_addresses)
--   Migration 032 addendum (gap fixes)
--   Migration 033 (adds vendor_id to email_routing_addresses)
--
-- Verification checks (run after applying; see a1.1-gap3-checks.sql):
--   Check 1: same-org assignment accepted
--   Check 2: cross-org assignment rejected
--   Check 3: NULL vendor accepted
--   Check 4: vendor deletion clears vendor_id (SET NULL)
-- ============================================================

BEGIN;

-- ── Pre-check: surface any existing violations before altering ────────────
DO $$
DECLARE
  violation_count integer;
BEGIN
  SELECT COUNT(*)
    INTO violation_count
    FROM public.email_routing_addresses ra
    JOIN public.vendors v ON v.id = ra.vendor_id
   WHERE ra.vendor_id IS NOT NULL
     AND v.organization_id <> ra.organization_id;

  IF violation_count > 0 THEN
    RAISE EXCEPTION
      'Migration 034 pre-check failed: % email_routing_addresses row(s) reference a vendor '
      'from a different organization. Fix these rows before applying this migration.',
      violation_count;
  END IF;

  RAISE NOTICE 'Migration 034 pre-check passed: no cross-org vendor assignments found.';
END $$;

-- ── Step 1: drop the existing single-column FK from migration 033 ─────────
-- That FK was: vendor_id uuid REFERENCES vendors(id) ON DELETE SET NULL
-- Its auto-generated name is email_routing_addresses_vendor_id_fkey.
-- The composite FK in Step 3 takes over its enforcement and delete behavior.
ALTER TABLE public.email_routing_addresses
  DROP CONSTRAINT IF EXISTS email_routing_addresses_vendor_id_fkey;

-- ── Step 2: unique constraint on vendors(organization_id, id) ─────────────
-- PostgreSQL requires the referenced column set to have a declared unique
-- constraint. vendors.id is the PK, but PG does not allow using a PK column
-- in a composite FK target unless the full referenced set is declared unique.
ALTER TABLE public.vendors
  ADD CONSTRAINT vendors_org_id_unique
  UNIQUE (organization_id, id);

-- ── Step 3: composite FK on email_routing_addresses ───────────────────────
-- Enforces that the vendor referenced by a routing address belongs to the
-- same organization. ON DELETE SET NULL (vendor_id) uses PG 17 column-list
-- syntax to clear only vendor_id (not organization_id) when the vendor row
-- is deleted, preserving the routing address itself.
ALTER TABLE public.email_routing_addresses
  ADD CONSTRAINT fk_routing_address_vendor_org
  FOREIGN KEY (organization_id, vendor_id)
  REFERENCES public.vendors (organization_id, id)
  ON DELETE SET NULL (vendor_id);

COMMIT;
