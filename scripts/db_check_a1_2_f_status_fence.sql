-- kerdos-test only; run after the draft function patch is reviewed/applied.
-- All fixtures are inside this transaction and rolled back.
BEGIN;
CREATE TEMP TABLE _a12f_fence_results(case_name text, passed boolean) ON COMMIT DROP;
DO $check$
DECLARE
  v_org uuid;
  v_route uuid;
  v_message uuid;
  v_att uuid;
  v_token uuid := gen_random_uuid();
  v_result boolean;
  v_status text;
BEGIN
  INSERT INTO public.organizations(name)
    VALUES ('A1.2.f fence rollback fixture') RETURNING id INTO v_org;
  INSERT INTO public.email_routing_addresses(organization_id,routing_address,label,is_active)
    VALUES (v_org,'a12f-' || gen_random_uuid()::text || '@inbound.kerdos.com',
      'A1.2.f rollback fixture',false) RETURNING id INTO v_route;
  INSERT INTO public.inbound_messages(organization_id,routing_address_id,postmark_message_id,sender_email)
    VALUES (v_org,v_route,'a12f-' || gen_random_uuid()::text,'a12f@example.invalid')
    RETURNING id INTO v_message;
  INSERT INTO public.inbound_attachments(
    organization_id,message_id,attachment_index,filename,storage_path,
    processing_status,processing_lease_token)
    VALUES (v_org,v_message,0,'a12f.csv','a12f/fixture','processing',NULL)
    RETURNING id INTO v_att;

  SELECT public.set_attachment_status_fenced(v_att,'auto_imported',NULL,NULL,v_token)
    INTO v_result;
  SELECT processing_status INTO v_status FROM public.inbound_attachments WHERE id=v_att;
  IF v_result IS DISTINCT FROM false OR v_status <> 'processing' THEN
    RAISE EXCEPTION 'null-token fence failed: result %, status %',v_result,v_status;
  END IF;
  INSERT INTO _a12f_fence_results VALUES ('revoked null token rejected', true);

  UPDATE public.inbound_attachments SET processing_lease_token=v_token WHERE id=v_att;
  SELECT public.set_attachment_status_fenced(v_att,'needs_review','test',NULL,v_token)
    INTO v_result;
  SELECT processing_status INTO v_status FROM public.inbound_attachments WHERE id=v_att;
  IF v_result IS DISTINCT FROM true OR v_status <> 'needs_review' THEN
    RAISE EXCEPTION 'valid-token path failed: result %, status %',v_result,v_status;
  END IF;
  INSERT INTO _a12f_fence_results VALUES ('valid token status update', true);

  SELECT public.set_attachment_status_fenced(v_att,'auto_imported',NULL,NULL,v_token)
    INTO v_result;
  IF v_result IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'terminal-state fence failed: result %',v_result;
  END IF;
  INSERT INTO _a12f_fence_results VALUES ('terminal state cannot be overwritten', true);
  RAISE NOTICE 'A1.2.f status fence: 3/3 passed; transaction will roll back';
END;
$check$;
SELECT case_name,passed FROM _a12f_fence_results ORDER BY case_name;
ROLLBACK;
