-- A1.7 database check for kerdos-test (gwtnaudjfoxjermhvhpx) only.
-- Run AFTER migration_035_partial_import_recovery.sql is applied.
-- All fixture writes, role claims, and temporary tables are rolled back.
-- Read the final A1.7 NOTICE summary; a preflight failure makes no fixtures.
BEGIN;

CREATE TEMP TABLE _a17_results (
  case_name text NOT NULL,
  passed boolean NOT NULL,
  detail text NOT NULL
) ON COMMIT DROP;

DO $check$
DECLARE
  v_function_oid oid;
  v_user uuid;
  v_org uuid;
  v_other_org uuid;
  v_vendor uuid;
  v_route uuid;
  v_message uuid;
  v_complete uuid;
  v_partial uuid;
  v_other_doc uuid;
  v_att_guard uuid;
  v_att_good uuid;
  v_att_other uuid;
  v_status text;
  v_link uuid;
  v_pass boolean;
  v_detail text;
BEGIN
  v_function_oid := to_regprocedure('public.mark_attachment_ingested(uuid,uuid,text)');

  v_pass := v_function_oid IS NOT NULL
    AND (SELECT count(*) = 1 FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
         WHERE n.nspname = 'public' AND p.proname = 'mark_attachment_ingested');
  INSERT INTO _a17_results VALUES ('T1 signature and no old overload', v_pass,
    CASE WHEN v_pass THEN 'one public function, exactly (uuid,uuid,text)'
         ELSE 'expected exactly one public (uuid,uuid,text) function; no fixtures created' END);
  IF NOT v_pass THEN RETURN; END IF;

  v_pass := NOT has_function_privilege('anon', v_function_oid, 'EXECUTE')
    AND has_function_privilege('authenticated', v_function_oid, 'EXECUTE');
  INSERT INTO _a17_results VALUES ('T2 effective grants', v_pass,
    format('anon=%s authenticated=%s',
      has_function_privilege('anon', v_function_oid, 'EXECUTE'),
      has_function_privilege('authenticated', v_function_oid, 'EXECUTE')));
  IF NOT v_pass THEN RETURN; END IF;

  -- Use an existing real auth user for the membership FK. The membership is
  -- only in this transaction. No auth account is created or modified.
  SELECT id INTO v_user FROM auth.users ORDER BY id LIMIT 1;
  IF v_user IS NULL THEN RAISE EXCEPTION 'No auth user is available for fixture membership'; END IF;

  INSERT INTO public.organizations(name) VALUES ('A1.7 rollback fixture') RETURNING id INTO v_org;
  INSERT INTO public.organizations(name) VALUES ('A1.7 other-org rollback fixture') RETURNING id INTO v_other_org;
  INSERT INTO public.organization_members(organization_id,user_id,role)
    VALUES (v_org,v_user,'owner');
  INSERT INTO public.vendors(organization_id,name)
    VALUES (v_org,'A1.7 fixture vendor') RETURNING id INTO v_vendor;
  INSERT INTO public.email_routing_addresses(organization_id,routing_address,label,is_active)
    VALUES (v_org,'a17-' || gen_random_uuid()::text || '@inbound.kerdos.com',
      'A1.7 rollback fixture',false) RETURNING id INTO v_route;
  INSERT INTO public.inbound_messages(organization_id,routing_address_id,postmark_message_id,sender_email)
    VALUES (v_org,v_route,'a17-' || gen_random_uuid()::text,'a17-fixture@example.invalid')
    RETURNING id INTO v_message;
  INSERT INTO public.import_documents(organization_id,vendor_id,document_kind,status)
    VALUES (v_org,v_vendor,'pricelist','complete') RETURNING id INTO v_complete;
  INSERT INTO public.import_documents(organization_id,vendor_id,document_kind,status)
    VALUES (v_org,v_vendor,'pricelist','partial') RETURNING id INTO v_partial;
  INSERT INTO public.import_documents(organization_id,document_kind,status)
    VALUES (v_other_org,'pricelist','complete') RETURNING id INTO v_other_doc;
  INSERT INTO public.inbound_attachments(organization_id,message_id,attachment_index,filename,storage_path,processing_status)
    VALUES (v_org,v_message,0,'a17-guard.csv','a17/guard','needs_review') RETURNING id INTO v_att_guard;
  INSERT INTO public.inbound_attachments(organization_id,message_id,attachment_index,filename,storage_path,processing_status)
    VALUES (v_org,v_message,1,'a17-good.csv','a17/good','needs_review') RETURNING id INTO v_att_good;
  INSERT INTO public.inbound_attachments(organization_id,message_id,attachment_index,filename,storage_path,processing_status)
    VALUES (v_org,v_message,2,'a17-other.csv','a17/other','needs_review') RETURNING id INTO v_att_other;
  PERFORM set_config('request.jwt.claim.sub',v_user::text,true);

  -- A failed expected call must leave the attachment unchanged.
  v_pass := false; v_detail := 'call unexpectedly succeeded';
  BEGIN
    PERFORM public.mark_attachment_ingested(v_att_guard,v_partial,'auto_imported');
  EXCEPTION WHEN OTHERS THEN
    v_detail := SQLERRM;
    v_pass := position('import document is not complete' in SQLERRM) > 0;
  END;
  SELECT v_pass AND processing_status = 'needs_review' AND import_document_id IS NULL
    INTO v_pass FROM public.inbound_attachments WHERE id = v_att_guard;
  INSERT INTO _a17_results VALUES ('T3 incomplete document rejected without mutation',coalesce(v_pass,false),v_detail);

  v_pass := true; v_detail := 'linked and finalized';
  BEGIN
    PERFORM public.mark_attachment_ingested(v_att_good,v_complete,'auto_imported');
  EXCEPTION WHEN OTHERS THEN v_pass := false; v_detail := SQLERRM;
  END;
  SELECT processing_status,import_document_id INTO v_status,v_link
    FROM public.inbound_attachments WHERE id=v_att_good;
  v_pass := v_pass AND v_status='auto_imported' AND v_link=v_complete;
  INSERT INTO _a17_results VALUES ('T4 complete document linked with final status',v_pass,v_detail);

  v_pass := true; v_detail := 'same document accepted';
  BEGIN
    PERFORM public.mark_attachment_ingested(v_att_good,v_complete,'auto_imported');
  EXCEPTION WHEN OTHERS THEN v_pass := false; v_detail := SQLERRM;
  END;
  INSERT INTO _a17_results VALUES ('T5 idempotent retry',v_pass,v_detail);

  v_pass := true; v_detail := 'same document status replayed';
  BEGIN
    PERFORM public.mark_attachment_ingested(v_att_good,v_complete,'needs_review');
  EXCEPTION WHEN OTHERS THEN v_pass := false; v_detail := SQLERRM;
  END;
  SELECT v_pass AND processing_status='needs_review' AND import_document_id=v_complete
    INTO v_pass FROM public.inbound_attachments WHERE id=v_att_good;
  INSERT INTO _a17_results VALUES ('T6 idempotent status replay',coalesce(v_pass,false),v_detail);

  v_pass := false; v_detail := 'different document unexpectedly accepted';
  BEGIN
    PERFORM public.mark_attachment_ingested(v_att_good,v_partial,NULL);
  EXCEPTION WHEN OTHERS THEN
    v_detail := SQLERRM;
    v_pass := position('already linked to a different import document' in SQLERRM)>0;
  END;
  INSERT INTO _a17_results VALUES ('T7 different document rejected',v_pass,v_detail);

  v_pass := false; v_detail := 'invalid status unexpectedly accepted';
  BEGIN
    PERFORM public.mark_attachment_ingested(v_att_other,v_complete,'bad_value');
  EXCEPTION WHEN OTHERS THEN
    v_detail := SQLERRM; v_pass := position('invalid p_final_status' in SQLERRM)>0;
  END;
  INSERT INTO _a17_results VALUES ('T8 invalid status rejected',v_pass,v_detail);

  v_pass := false; v_detail := 'null document unexpectedly accepted';
  BEGIN
    PERFORM public.mark_attachment_ingested(v_att_other,NULL,NULL);
  EXCEPTION WHEN OTHERS THEN
    v_detail := SQLERRM; v_pass := position('p_import_document_id cannot be null' in SQLERRM)>0;
  END;
  INSERT INTO _a17_results VALUES ('T9 null document rejected',v_pass,v_detail);

  v_pass := false; v_detail := 'cross-org document unexpectedly accepted';
  BEGIN
    PERFORM public.mark_attachment_ingested(v_att_other,v_other_doc,NULL);
  EXCEPTION WHEN OTHERS THEN
    v_detail := SQLERRM;
    v_pass := position('belongs to a different organization' in SQLERRM)>0;
  END;
  INSERT INTO _a17_results VALUES ('T10 cross-org document rejected',v_pass,v_detail);

  PERFORM set_config('request.jwt.claim.sub',gen_random_uuid()::text,true);
  v_pass := false; v_detail := 'nonmember unexpectedly accepted';
  BEGIN
    PERFORM public.mark_attachment_ingested(v_att_other,v_complete,NULL);
  EXCEPTION WHEN OTHERS THEN
    v_detail := SQLERRM; v_pass := position('permission denied' in SQLERRM)>0;
  END;
  INSERT INTO _a17_results VALUES ('T11 nonmember rejected',v_pass,v_detail);
EXCEPTION WHEN OTHERS THEN
  INSERT INTO _a17_results VALUES ('fixture or unexpected test error',false,SQLERRM);
END;
$check$;

DO $summary$
DECLARE v_total int; v_fail int; v_detail text;
BEGIN
  SELECT count(*),count(*) FILTER(WHERE NOT passed) INTO v_total,v_fail FROM _a17_results;
  SELECT string_agg(case_name || ': ' || detail,E'\n' ORDER BY case_name)
    INTO v_detail FROM _a17_results WHERE NOT passed;
  IF v_total=11 AND v_fail=0 THEN
    RAISE NOTICE 'A1.7 DB CHECK: PASS — 11/11; ROLLBACK follows';
  ELSE
    RAISE NOTICE 'A1.7 DB CHECK: FAIL — %/11 passed, % recorded. %; ROLLBACK follows',
      v_total-v_fail,v_total,coalesce(v_detail,'Missing cases');
  END IF;
END;
$summary$;

-- This output is useful in clients that hide NOTICE messages.
SELECT case_name,passed,detail FROM _a17_results ORDER BY case_name;
ROLLBACK;
