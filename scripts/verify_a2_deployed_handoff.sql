-- Privileged, rollback-only smoke against the reviewed test project.
-- Simulates database JWT claims; does not prove real browser/auth acceptance.
BEGIN;
SET LOCAL statement_timeout='15s';
SET LOCAL lock_timeout='3s';
DO $test$
DECLARE actor uuid;org uuid;vendor uuid;
BEGIN
 SELECT m.user_id,m.organization_id,v.id INTO actor,org,vendor
 FROM public.organization_members m JOIN public.vendors v ON v.organization_id=m.organization_id
 WHERE m.role IN('owner','manager') AND v.is_active LIMIT 1;
 IF actor IS NULL THEN RAISE EXCEPTION 'No existing owner/manager vendor scope for rollback test';END IF;
 PERFORM set_config('request.jwt.claim.sub',actor::text,true);
 PERFORM set_config('kerdos.test_org',org::text,true);
 PERFORM set_config('kerdos.test_vendor',vendor::text,true);
END$test$;
SET LOCAL ROLE authenticated;
DO $test$
DECLARE org uuid:=current_setting('kerdos.test_org')::uuid;
 vendor uuid:=current_setting('kerdos.test_vendor')::uuid;
 request_id uuid;second_id uuid;doc_id uuid;
BEGIN
 request_id:=public.kerdos_request_vendor_connection(org,vendor,'us-foods-moxe');
 second_id:=public.kerdos_request_vendor_connection(org,vendor,'us-foods-moxe');
 IF request_id IS NULL OR request_id IS DISTINCT FROM second_id THEN RAISE EXCEPTION 'setup not idempotent';END IF;
 UPDATE public.vendor_connection_requests SET state='cancelled' WHERE id=request_id;
 second_id:=public.kerdos_request_vendor_connection(org,vendor,'us-foods-moxe');
 IF NOT EXISTS(SELECT FROM public.vendor_connection_requests WHERE id=second_id AND state='setup_requested') THEN RAISE EXCEPTION 'restart failed';END IF;
 INSERT INTO public.import_documents(organization_id,vendor_id,document_kind,fingerprint,original_text,file_name,status,retrieval_evidence)
 VALUES(org,vendor,'pricelist','rollback-test-'||gen_random_uuid()::text,'Code,Price','rollback-only.csv','processing',jsonb_build_object('kind','browser_companion','assurance','user_approved_browser_session','sha256',repeat('a',64),'byte_length',10)) RETURNING id INTO doc_id;
 BEGIN
  UPDATE public.import_documents SET retrieval_evidence=NULL WHERE id=doc_id;
  RAISE EXCEPTION 'immutable evidence unexpectedly changed';
 EXCEPTION WHEN raise_exception THEN
  IF SQLERRM<>'retrieval_evidence_immutable' THEN RAISE;END IF;
 END;
 UPDATE public.import_documents SET status='complete' WHERE id=doc_id;
END$test$;
RESET ROLE;
DO $test$ BEGIN PERFORM set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);END$test$;
SET LOCAL ROLE authenticated;
DO $test$
BEGIN
 IF EXISTS(SELECT FROM public.vendor_connection_requests) THEN RAISE EXCEPTION 'nonmember can read requests';END IF;
 BEGIN
  PERFORM public.kerdos_request_vendor_connection(current_setting('kerdos.test_org')::uuid,current_setting('kerdos.test_vendor')::uuid,'us-foods-moxe');
  RAISE EXCEPTION 'nonmember enrollment unexpectedly succeeded';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
END$test$;
RESET ROLE;
ROLLBACK;
