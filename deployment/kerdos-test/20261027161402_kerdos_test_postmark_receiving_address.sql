-- Deployment configuration for kerdos-test (gwtnaudjfoxjermhvhpx) only.
-- Enables the exact receiving address assigned by the owner's free Postmark
-- inbound stream. This is a public receiving address, not a credential.
-- Do not apply this environment-specific exception to the production project.
ALTER TABLE public.email_routing_addresses
  DROP CONSTRAINT IF EXISTS email_routing_addresses_inbound_domain;
ALTER TABLE public.email_routing_addresses
  ADD CONSTRAINT email_routing_addresses_inbound_domain CHECK (
    routing_address LIKE '%@inbound.kerdos.com'
    OR routing_address = 'aa55b9cf38e8fab147fc4c8b7e914e7d@inbound.postmarkapp.com'
  );
