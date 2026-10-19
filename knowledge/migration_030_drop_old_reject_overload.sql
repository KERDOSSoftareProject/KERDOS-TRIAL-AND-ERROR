-- Migration 030: Drop the original three-argument overload of kerdos_reject_mapping.
--
-- When migration 028 was first applied, kerdos_reject_mapping had three parameters:
--   (p_organization_id uuid, p_mapping_id uuid, p_expected_revision bigint)
--
-- Migration 028 was later updated to add a fourth parameter (p_expected_catalog_item_id
-- uuid default null) for the stale-mapping check.  PostgreSQL treats different parameter
-- lists as distinct overloads, so CREATE OR REPLACE only added the four-argument variant
-- — it did NOT replace the three-argument function.  That old overload remained callable
-- and would bypass the stale-mapping check entirely.
--
-- This migration removes the old overload so only the four-argument version remains.
-- The IF EXISTS guard makes it safe to run on a database that never had the three-argument
-- version (e.g. a fresh schema that started with migration 028 already updated).

drop function if exists public.kerdos_reject_mapping(uuid, uuid, bigint);
