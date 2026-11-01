-- Generated with Supabase CLI 2.122.0; version matches hosted migration history.
-- I · A · Task 2. Installed in kerdos-test.
-- Retain the installed
-- export source/credential contracts. Pending setup is not an authenticated source.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
SET LOCAL idle_in_transaction_session_timeout='10s';
CREATE TABLE public.vendor_connection_adapters (
 adapter_key text PRIMARY KEY CHECK(adapter_key ~ '^[a-z][a-z0-9-]{0,79}$'),
 display_name text NOT NULL,
 retrieval_kind text NOT NULL CHECK(retrieval_kind IN ('https_export','portal_session')),
 execution_model text NOT NULL CHECK(execution_model IN ('server_export','local_browser')),
 setup_available boolean NOT NULL DEFAULT false,
 portal_origin text CHECK(portal_origin ~ '^https://[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]{1,5})?$'),
 CHECK((execution_model='local_browser' AND portal_origin IS NOT NULL) OR (execution_model='server_export' AND portal_origin IS NULL))
);
ALTER TABLE public.vendor_connection_adapters ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vendor_connection_adapters FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.vendor_connection_adapters TO authenticated;
CREATE POLICY vendor_connection_adapter_read ON public.vendor_connection_adapters
 FOR SELECT TO authenticated USING ((SELECT auth.uid()) IS NOT NULL);
-- Adapter definitions are platform metadata, not client/vendor/account records.
-- MOXe is a first adapter candidate; no pilot client, account, list ID or session.
INSERT INTO public.vendor_connection_adapters VALUES
 ('https-export','Approved pricing export','https_export','server_export',true,NULL),
 ('us-foods-moxe','US Foods MOXē','portal_session','local_browser',true,'https://order.usfoods.com');
CREATE TABLE public.vendor_connection_requests (
 id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
 organization_id uuid NOT NULL REFERENCES public.organizations(id) ON DELETE CASCADE,
 vendor_id uuid NOT NULL,
 adapter_key text NOT NULL REFERENCES public.vendor_connection_adapters(adapter_key),
 state text NOT NULL DEFAULT 'setup_requested' CHECK(state IN ('setup_requested','cancelled')),
 created_at timestamptz NOT NULL DEFAULT now(),
 FOREIGN KEY (organization_id,vendor_id) REFERENCES public.vendors(organization_id,id) ON DELETE CASCADE,
 UNIQUE (organization_id,vendor_id,adapter_key)
);
ALTER TABLE public.vendor_connection_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON public.vendor_connection_requests FROM PUBLIC,anon,authenticated;
GRANT SELECT ON public.vendor_connection_requests TO authenticated;
GRANT INSERT(organization_id,vendor_id,adapter_key) ON public.vendor_connection_requests TO authenticated;
GRANT UPDATE(state) ON public.vendor_connection_requests TO authenticated;
CREATE POLICY vendor_connection_request_read ON public.vendor_connection_requests
 FOR SELECT TO authenticated USING (EXISTS (
 SELECT 1 FROM public.organization_members m WHERE m.organization_id=vendor_connection_requests.organization_id
 AND m.user_id=(SELECT auth.uid()) AND m.role IN ('owner','manager')));
CREATE POLICY vendor_connection_request_insert ON public.vendor_connection_requests
 FOR INSERT TO authenticated WITH CHECK (state='setup_requested' AND EXISTS (
 SELECT 1 FROM public.organization_members m WHERE m.organization_id=vendor_connection_requests.organization_id
 AND m.user_id=(SELECT auth.uid()) AND m.role IN ('owner','manager')) AND EXISTS (
 SELECT 1 FROM public.vendors v WHERE v.organization_id=vendor_connection_requests.organization_id
 AND v.id=vendor_connection_requests.vendor_id AND v.is_active) AND EXISTS (
 SELECT 1 FROM public.vendor_connection_adapters a WHERE a.adapter_key=vendor_connection_requests.adapter_key AND a.setup_available));
CREATE POLICY vendor_connection_request_cancel ON public.vendor_connection_requests
 FOR UPDATE TO authenticated USING (EXISTS (
 SELECT 1 FROM public.organization_members m WHERE m.organization_id=vendor_connection_requests.organization_id
 AND m.user_id=(SELECT auth.uid()) AND m.role IN ('owner','manager')))
 WITH CHECK (state IN ('setup_requested','cancelled') AND EXISTS (
 SELECT 1 FROM public.organization_members m WHERE m.organization_id=vendor_connection_requests.organization_id
 AND m.user_id=(SELECT auth.uid()) AND m.role IN ('owner','manager')) AND
 (state='cancelled' OR (EXISTS (SELECT 1 FROM public.vendors v WHERE v.id=vendor_id AND v.organization_id=vendor_connection_requests.organization_id AND v.is_active) AND EXISTS (SELECT 1 FROM public.vendor_connection_adapters a WHERE a.adapter_key=vendor_connection_requests.adapter_key AND a.setup_available))));
CREATE FUNCTION public.kerdos_request_vendor_connection(p_organization_id uuid,p_vendor_id uuid,p_adapter_key text)
RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path='' AS $$
DECLARE request_id uuid;
BEGIN
 IF auth.uid() IS NULL THEN RAISE EXCEPTION 'Authentication is required'; END IF;
 -- RLS and column grants apply even when the caller skips this RPC.
 SELECT id INTO request_id FROM public.vendor_connection_requests
 WHERE organization_id=p_organization_id AND vendor_id=p_vendor_id AND adapter_key=p_adapter_key;
 IF request_id IS NOT NULL THEN
 UPDATE public.vendor_connection_requests SET state='setup_requested' WHERE id=request_id AND state='cancelled';
 RETURN request_id; END IF;
 INSERT INTO public.vendor_connection_requests(organization_id,vendor_id,adapter_key)
 VALUES(p_organization_id,p_vendor_id,p_adapter_key)
 ON CONFLICT(organization_id,vendor_id,adapter_key) DO NOTHING RETURNING id INTO request_id;
 IF request_id IS NULL THEN
 SELECT id INTO request_id FROM public.vendor_connection_requests
 WHERE organization_id=p_organization_id AND vendor_id=p_vendor_id AND adapter_key=p_adapter_key;
 END IF;
 RETURN request_id;
END$$;
REVOKE ALL ON FUNCTION public.kerdos_request_vendor_connection(uuid,uuid,text) FROM PUBLIC,anon;
GRANT EXECUTE ON FUNCTION public.kerdos_request_vendor_connection(uuid,uuid,text) TO authenticated;
-- No Vault access, fake credentials, operational sources, session capture,
-- source activation, schedule or receipt-kind changes are introduced here.
COMMIT;
