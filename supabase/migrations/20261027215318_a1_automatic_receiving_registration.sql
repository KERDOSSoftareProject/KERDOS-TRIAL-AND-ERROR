-- Automatic receiving registration. No client configuration action is required.
-- Operator-provided, delivery-ready domains are deliberately NOT seeded here.
CREATE SCHEMA IF NOT EXISTS kerdos_private;
REVOKE ALL ON SCHEMA kerdos_private FROM PUBLIC,anon,authenticated;
CREATE TABLE kerdos_private.receiving_domains (
  singleton boolean PRIMARY KEY DEFAULT true CHECK(singleton),
  price_sheet_domain text NOT NULL,
  invoice_domain text NOT NULL,
  delivery_ready boolean NOT NULL DEFAULT false,
  CHECK(price_sheet_domain=lower(price_sheet_domain) AND invoice_domain=lower(invoice_domain)),
  CHECK(price_sheet_domain<>invoice_domain),
  CHECK(price_sheet_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$'),
  CHECK(invoice_domain ~ '^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$')
);
ALTER TABLE kerdos_private.receiving_domains ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON kerdos_private.receiving_domains FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA kerdos_private TO service_role;
GRANT SELECT,INSERT,UPDATE,DELETE ON kerdos_private.receiving_domains TO service_role;

ALTER TABLE public.email_routing_addresses ADD COLUMN is_automatic boolean NOT NULL DEFAULT false;
CREATE UNIQUE INDEX email_routing_auto_vendor_type ON public.email_routing_addresses(organization_id,vendor_id,document_type)
  WHERE is_automatic AND is_active;
ALTER TABLE public.email_routing_addresses ADD CONSTRAINT automatic_receiver_complete
  CHECK(NOT is_automatic OR NOT is_active OR (vendor_id IS NOT NULL AND document_type IN ('pricelist','invoice')));
-- Clients read their registrations under the existing membership RLS policy.
-- Only the automatic provisioner or platform service may write registrations.
REVOKE INSERT,UPDATE,DELETE ON public.email_routing_addresses FROM anon,authenticated;

CREATE FUNCTION kerdos_private.provision_vendor_receivers(p_vendor_id uuid)
RETURNS integer LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE
 v public.vendors%rowtype;
 cfg kerdos_private.receiving_domains%rowtype;
 client_name text;
 local_name text;
 candidate text;
 target_domain text;
 kind text;
 existing_id uuid;
 written integer:=0;
BEGIN
 SELECT * INTO v FROM public.vendors WHERE id=p_vendor_id FOR UPDATE;
 IF NOT FOUND THEN RETURN 0; END IF;
 SELECT * INTO cfg FROM kerdos_private.receiving_domains WHERE singleton;
 IF cfg.delivery_ready IS DISTINCT FROM true OR v.is_active IS FALSE THEN
   UPDATE public.email_routing_addresses SET is_active=false WHERE vendor_id=v.id AND organization_id=v.organization_id AND is_automatic;
   RETURN 0;
 END IF;
 SELECT coalesce(nullif(slug,''),name) INTO client_name FROM public.organizations WHERE id=v.organization_id;
 client_name:=coalesce(nullif(left(regexp_replace(lower(client_name),'[^a-z0-9]','','g'),24),''),'client'||left(replace(v.organization_id::text,'-',''),8));
 local_name:=client_name||'.'||coalesce(nullif(left(regexp_replace(lower(v.name),'[^a-z0-9]','','g'),24),''),'vendor'||left(replace(v.id::text,'-',''),8));
 FOREACH kind IN ARRAY ARRAY['pricelist','invoice'] LOOP
   target_domain:=CASE kind WHEN 'pricelist' THEN cfg.price_sheet_domain ELSE cfg.invoice_domain END;
   existing_id:=NULL;
   SELECT id INTO existing_id FROM public.email_routing_addresses
    WHERE organization_id=v.organization_id AND vendor_id=v.id AND document_type=kind AND is_automatic
      AND split_part(routing_address,'@',2)=target_domain ORDER BY is_active DESC,created_at LIMIT 1;
   UPDATE public.email_routing_addresses SET is_active=false
    WHERE organization_id=v.organization_id AND vendor_id=v.id AND document_type=kind AND is_automatic
      AND id IS DISTINCT FROM existing_id;
   IF existing_id IS NOT NULL THEN
     UPDATE public.email_routing_addresses SET is_active=true WHERE id=existing_id;
     CONTINUE;
   END IF;
   candidate:=local_name||'@'||target_domain;
   -- Name collisions must never route one client's email into another client.
   PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(candidate,0));
   IF EXISTS(SELECT 1 FROM public.email_routing_addresses WHERE routing_address=candidate) THEN
     candidate:=left(client_name,12)||'.'||left(regexp_replace(lower(v.name),'[^a-z0-9]','','g'),12)||'-'||replace(v.id::text,'-','')||'@'||target_domain;
   END IF;
   INSERT INTO public.email_routing_addresses(organization_id,vendor_id,document_type,routing_address,label,is_active,is_automatic)
    VALUES(v.organization_id,v.id,kind,candidate,CASE kind WHEN 'pricelist' THEN 'Price sheets' ELSE 'Invoices' END,true,true);
   written:=written+1;
 END LOOP;
 RETURN written;
END;
$$;
REVOKE ALL ON FUNCTION kerdos_private.provision_vendor_receivers(uuid) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION kerdos_private.provision_vendor_receivers(uuid) TO service_role;

CREATE FUNCTION kerdos_private.vendor_receiving_registration()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 PERFORM kerdos_private.provision_vendor_receivers(NEW.id);
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION kerdos_private.vendor_receiving_registration() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER vendor_automatic_receiving_registration
 AFTER INSERT OR UPDATE OF name,is_active ON public.vendors
 FOR EACH ROW EXECUTE FUNCTION kerdos_private.vendor_receiving_registration();

CREATE FUNCTION kerdos_private.refresh_receiving_registrations()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
DECLARE vendor_id uuid;
BEGIN
 FOR vendor_id IN SELECT id FROM public.vendors ORDER BY id LOOP
   PERFORM kerdos_private.provision_vendor_receivers(vendor_id);
 END LOOP;
 RETURN NULL;
END;
$$;
REVOKE ALL ON FUNCTION kerdos_private.refresh_receiving_registrations() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER receiving_domain_registration_refresh
 AFTER INSERT OR UPDATE OR DELETE ON kerdos_private.receiving_domains
 FOR EACH STATEMENT EXECUTE FUNCTION kerdos_private.refresh_receiving_registrations();
-- Absence of configuration is explicit: no fake or unreceivable address is generated.
-- Initial configuration (by the platform operator, after DNS/provider verification)
-- automatically provisions every existing active vendor as well as future vendors.

CREATE FUNCTION kerdos_private.retire_vendor_receivers()
RETURNS trigger LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $$
BEGIN
 UPDATE public.email_routing_addresses SET is_active=false WHERE vendor_id=OLD.id AND organization_id=OLD.organization_id AND is_automatic;
 RETURN OLD;
END;
$$;
REVOKE ALL ON FUNCTION kerdos_private.retire_vendor_receivers() FROM PUBLIC,anon,authenticated;
CREATE TRIGGER vendor_retire_receiving_registration BEFORE DELETE ON public.vendors
 FOR EACH ROW EXECUTE FUNCTION kerdos_private.retire_vendor_receivers();
