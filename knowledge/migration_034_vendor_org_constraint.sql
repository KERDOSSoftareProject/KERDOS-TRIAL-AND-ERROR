-- A1.1 source reconciliation from the verified kerdos-test schema.
-- Apply after migration_033_auto_processing.sql, which adds vendor_id.
-- A routing address may only point to a vendor in its own organization.

DO $migration$
BEGIN
  IF EXISTS (
    SELECT 1
      FROM public.email_routing_addresses a
      LEFT JOIN public.vendors v ON v.id = a.vendor_id
     WHERE a.vendor_id IS NOT NULL
       AND (v.id IS NULL OR v.organization_id <> a.organization_id)
  ) THEN
    RAISE EXCEPTION 'Existing routing address has a vendor outside its organization';
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.vendors'::regclass
       AND conname = 'vendors_org_id_unique'
  ) THEN
    ALTER TABLE public.vendors
      ADD CONSTRAINT vendors_org_id_unique UNIQUE (organization_id, id);
  END IF;

  -- Replace the vendor-only FK introduced by migration_033. The composite
  -- reference enforces same-org assignments even for service-role writes.
  ALTER TABLE public.email_routing_addresses
    DROP CONSTRAINT IF EXISTS email_routing_addresses_vendor_id_fkey;

  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint
     WHERE conrelid = 'public.email_routing_addresses'::regclass
       AND conname = 'fk_routing_address_vendor_org'
  ) THEN
    ALTER TABLE public.email_routing_addresses
      ADD CONSTRAINT fk_routing_address_vendor_org
      FOREIGN KEY (organization_id, vendor_id)
      REFERENCES public.vendors(organization_id, id)
      ON DELETE SET NULL (vendor_id);
  END IF;
END;
$migration$;
