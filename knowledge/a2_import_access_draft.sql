-- Deployment preflight found an older permissive ALL policy alongside the
-- intended manager-write/member-read policies. This targeted change preserves
-- the latter and prevents the ALL policy from bypassing their role boundary.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
SET LOCAL idle_in_transaction_session_timeout='10s';
DROP POLICY IF EXISTS "import_documents: members access" ON public.import_documents;
-- Existing source documents were checked before deployment: no mismatched
-- organization/vendor ownership. The composite FK also protects direct API calls.
ALTER TABLE public.import_documents ADD CONSTRAINT import_documents_vendor_org_fkey
 FOREIGN KEY(organization_id,vendor_id) REFERENCES public.vendors(organization_id,id) NOT VALID;
ALTER TABLE public.import_documents VALIDATE CONSTRAINT import_documents_vendor_org_fkey;
COMMIT;
