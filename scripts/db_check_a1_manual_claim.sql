-- A1 manual/background ownership check. Run against kerdos-test after the
-- draft migration is applied, or concatenate the migration after BEGIN for a
-- rollback-only preflight. Every fixture is rolled back.
BEGIN;

DO $check$
DECLARE
  v_org uuid;
  v_user uuid;
  v_route uuid;
  v_message uuid;
  v_manual uuid;
  v_worker uuid;
  v_token uuid;
  v_ready boolean;
  v_status text;
  v_rejected boolean := false;
BEGIN
  SELECT organization_id, user_id INTO v_org, v_user
    FROM public.organization_members WHERE user_id IS NOT NULL LIMIT 1;
  IF v_org IS NULL THEN RAISE EXCEPTION 'No organization member fixture available'; END IF;

  INSERT INTO public.email_routing_addresses
    (organization_id, routing_address, label, is_active)
  VALUES (v_org, 'a1-manual-' || gen_random_uuid()::text || '@inbound.kerdos.com',
          'A1 manual claim rollback fixture', false)
  RETURNING id INTO v_route;
  INSERT INTO public.inbound_messages
    (organization_id, routing_address_id, postmark_message_id, sender_email)
  VALUES (v_org, v_route, 'a1-manual-' || gen_random_uuid()::text, 'test@test.invalid')
  RETURNING id INTO v_message;
  INSERT INTO public.inbound_attachments
    (organization_id, message_id, attachment_index, filename, storage_path)
  VALUES (v_org, v_message, 0, '__a1_manual_claim__', 'a1-manual/test/0')
  RETURNING id INTO v_manual;
  INSERT INTO public.inbound_attachments
    (organization_id, message_id, attachment_index, filename, storage_path)
  VALUES (v_org, v_message, 1, '__a1_worker_claim__', 'a1-manual/test/1')
  RETURNING id INTO v_worker;

  PERFORM set_config('request.jwt.claim.sub', v_user::text, true);
  SELECT public.begin_manual_attachment_review(v_org, v_manual) INTO v_ready;
  SELECT processing_status INTO v_status FROM public.inbound_attachments WHERE id=v_manual;
  IF v_ready IS NOT TRUE OR v_status <> 'needs_review' THEN
    RAISE EXCEPTION 'manual-first failed: ready %, status %', v_ready, v_status;
  END IF;
  IF public.claim_attachment(v_manual) IS NOT NULL THEN
    RAISE EXCEPTION 'manual-first failed: worker claimed reviewed attachment';
  END IF;
  IF public.begin_manual_attachment_review(v_org, v_manual) IS NOT TRUE THEN
    RAISE EXCEPTION 'manual claim was not idempotent';
  END IF;

  SELECT public.claim_attachment(v_worker) INTO v_token;
  IF v_token IS NULL THEN RAISE EXCEPTION 'worker fixture did not claim'; END IF;
  SELECT public.begin_manual_attachment_review(v_org, v_worker) INTO v_ready;
  IF v_ready IS NOT FALSE THEN RAISE EXCEPTION 'worker-first allowed manual review'; END IF;
  BEGIN
    PERFORM public.mark_attachment_ingested(v_worker, gen_random_uuid(), 'auto_imported');
  EXCEPTION WHEN OTHERS THEN
    IF position('being processed automatically' IN SQLERRM) > 0 THEN
      v_rejected := true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'worker-first allowed manual completion'; END IF;

  PERFORM set_config('request.jwt.claim.sub', gen_random_uuid()::text, true);
  v_rejected := false;
  BEGIN
    PERFORM public.begin_manual_attachment_review(v_org, v_manual);
  EXCEPTION WHEN OTHERS THEN
    IF position('permission denied' IN SQLERRM) > 0 THEN
      v_rejected := true;
    ELSE
      RAISE;
    END IF;
  END;
  IF NOT v_rejected THEN RAISE EXCEPTION 'nonmember gained manual review access'; END IF;

  IF has_function_privilege('anon', 'public.begin_manual_attachment_review(uuid,uuid)', 'EXECUTE')
     OR NOT has_function_privilege('authenticated', 'public.begin_manual_attachment_review(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'manual review RPC grants are incorrect';
  END IF;
  RAISE NOTICE 'PASS: manual-first, worker-first, idempotency, completion guard, membership, grants';
END;
$check$;

ROLLBACK;
SELECT 'PASS: manual-first, worker-first, idempotency, completion guard, membership, grants; fixtures rolled back' AS result;
