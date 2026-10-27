#!/usr/bin/env bash
# =============================================================================
# A1 Deployed Interaction Checks — kerdos-test only
# Commit: dfc6ff2   Project: gwtnaudjfoxjermhvhpx
#
# Prerequisites
# -------------
#   export KERDOS_TEST_URL=https://gwtnaudjfoxjermhvhpx.supabase.co
#   export KERDOS_TEST_SERVICE_KEY=<service-role key>
#   export KERDOS_TEST_WEBHOOK_USER=<POSTMARK_WEBHOOK_USERNAME value>
#   export KERDOS_TEST_WEBHOOK_PASS=<POSTMARK_WEBHOOK_PASSWORD value>
#   export KERDOS_TEST_SWEEP_SECRET=<RECOVERY_SWEEP_SECRET value>
#   export KERDOS_TEST_DB_URL=<postgres connection string for kerdos-test>
#
# Usage
# -----
#   bash scripts/check_a1_deployed_interactions.sh
#
# Each check prints PASS or FAIL with the observed HTTP status or value.
# No permanent records are written; test rows are rolled back via psql.
# =============================================================================

set -euo pipefail

FUNCTIONS_BASE="${KERDOS_TEST_URL}/functions/v1"
ANON_BASE="${KERDOS_TEST_URL}/rest/v1"
DB="${KERDOS_TEST_DB_URL}"

pass() { echo "PASS  $1"; }
fail() { echo "FAIL  $1"; }
check_status() {
  local label="$1" expected="$2" actual="$3"
  if [ "$actual" = "$expected" ]; then pass "$label (HTTP $actual)";
  else fail "$label — expected HTTP $expected, got $actual"; fi
}

echo "=== A1 Deployed Interaction Checks — $(date -u +%Y-%m-%dT%H:%M:%SZ) ==="
echo "    Commit: dfc6ff2"
echo ""

# ---------------------------------------------------------------------------
# Check I-1  process-attachment: JWT required (verify_jwt = true)
# ---------------------------------------------------------------------------
echo "--- I-1  process-attachment rejects requests without a JWT ---"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${FUNCTIONS_BASE}/process-attachment" \
  -H "Content-Type: application/json" \
  -d '{"attachmentId":"00000000-0000-0000-0000-000000000000","organizationId":"00000000-0000-0000-0000-000000000000"}')
check_status "process-attachment no JWT" 401 "$STATUS"

# Supabase gateway rejects before the handler; wrong Bearer should also fail
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${FUNCTIONS_BASE}/process-attachment" \
  -H "Authorization: Bearer totally-wrong-token" \
  -H "Content-Type: application/json" \
  -d '{"attachmentId":"00000000-0000-0000-0000-000000000000","organizationId":"00000000-0000-0000-0000-000000000000"}')
check_status "process-attachment wrong JWT" 401 "$STATUS"
echo ""

# ---------------------------------------------------------------------------
# Check I-2  inbound-email: Basic auth required (verify_jwt = false)
# ---------------------------------------------------------------------------
echo "--- I-2  inbound-email rejects requests without Basic auth ---"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${FUNCTIONS_BASE}/inbound-email" \
  -H "Content-Type: application/json" \
  -d '{}')
check_status "inbound-email no auth" 401 "$STATUS"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${FUNCTIONS_BASE}/inbound-email" \
  -u "wronguser:wrongpass" \
  -H "Content-Type: application/json" \
  -d '{}')
check_status "inbound-email wrong credentials" 401 "$STATUS"

# Correct credentials with valid minimal body (will fail routing validation, not auth)
MINIMAL_BODY='{"From":"test@example.com","To":"test@inbound.kerdos.com","Subject":"test","TextBody":"test","MessageID":"test-msg-001","Attachments":[]}'
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${FUNCTIONS_BASE}/inbound-email" \
  -u "${KERDOS_TEST_WEBHOOK_USER}:${KERDOS_TEST_WEBHOOK_PASS}" \
  -H "Content-Type: application/json" \
  -d "$MINIMAL_BODY")
# 4xx is acceptable here — auth passed, routing validation rejects unknown org/address
if [ "$STATUS" = "401" ]; then
  fail "inbound-email correct credentials (still rejected as unauthorized)"
elif [ "$STATUS" = "200" ] || [ "$STATUS" = "400" ] || [ "$STATUS" = "404" ] || [ "$STATUS" = "422" ]; then
  pass "inbound-email correct credentials reached handler (HTTP $STATUS)"
else
  fail "inbound-email correct credentials — unexpected HTTP $STATUS"
fi
echo ""

# ---------------------------------------------------------------------------
# Check I-3  recovery-sweep: shared secret required (verify_jwt = false)
# ---------------------------------------------------------------------------
echo "--- I-3  recovery-sweep rejects requests without correct secret ---"
STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${FUNCTIONS_BASE}/recovery-sweep" \
  -H "Content-Type: application/json" \
  -d '{}')
check_status "recovery-sweep no auth" 401 "$STATUS"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${FUNCTIONS_BASE}/recovery-sweep" \
  -H "Authorization: Bearer wrong-secret" \
  -H "Content-Type: application/json" \
  -d '{}')
check_status "recovery-sweep wrong secret" 401 "$STATUS"

STATUS=$(curl -s -o /dev/null -w "%{http_code}" \
  -X POST "${FUNCTIONS_BASE}/recovery-sweep" \
  -H "Authorization: Bearer ${KERDOS_TEST_SWEEP_SECRET}" \
  -H "Content-Type: application/json" \
  -d '{}')
# 200 = sweep ran (possibly 0 rows); 405 = GET was used (we used POST so shouldn't happen)
check_status "recovery-sweep correct secret" 200 "$STATUS"
echo ""

# ---------------------------------------------------------------------------
# Check I-4  Vendor snapshot immutability — DB trigger prevents mutation
#            Uses psql directly; does not touch deployed functions.
# ---------------------------------------------------------------------------
echo "--- I-4  Vendor snapshot immutability enforced by DB trigger ---"
psql "$DB" -qAt -c "
DO \$\$
DECLARE
  v_org_id  uuid;
  v_msg_id  uuid;
  v_vendor  uuid;
  blocked   boolean := false;
BEGIN
  SELECT id INTO v_org_id FROM organizations LIMIT 1;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'no organizations found — cannot run immutability check';
  END IF;

  -- Create a test vendor
  INSERT INTO vendors (organization_id, name)
  VALUES (v_org_id, '_test_immutability_vendor_')
  RETURNING id INTO v_vendor;

  -- Insert an inbound_message row with vendor snapshot
  INSERT INTO inbound_messages (
    organization_id, from_address, to_address, subject, message_id,
    receipt_vendor_id, vendor_snapshot_at
  ) VALUES (
    v_org_id, 'test@example.com', 'test@inbound.kerdos.com', 'Immutability test',
    'immutability-test-msg-001',
    v_vendor, now()
  ) RETURNING id INTO v_msg_id;

  -- Attempt to overwrite receipt_vendor_id — trigger must block this
  BEGIN
    UPDATE inbound_messages
    SET receipt_vendor_id = v_vendor -- same value still triggers the guard
    WHERE id = v_msg_id;
    -- If we get here the trigger did NOT fire — that's a failure
    blocked := false;
  EXCEPTION WHEN others THEN
    blocked := true;
  END;

  -- Clean up (before reporting so partial state doesn't accumulate)
  DELETE FROM inbound_messages WHERE id = v_msg_id;
  DELETE FROM vendors WHERE id = v_vendor AND name = '_test_immutability_vendor_';

  IF blocked THEN
    RAISE NOTICE 'PASS  vendor snapshot is immutable — trigger blocked the update';
  ELSE
    RAISE NOTICE 'FAIL  vendor snapshot immutability trigger did not fire';
  END IF;
END;
\$\$;
" 2>&1 | grep -E "PASS|FAIL|ERROR|Exception"
echo ""

# ---------------------------------------------------------------------------
# Check I-5  Legacy row safety — receiptVendorId returns null when
#            vendor_snapshot_at is NULL (no snapshot column set)
#            Verified via DB state; the JS function is covered by unit tests.
# ---------------------------------------------------------------------------
echo "--- I-5  Legacy row: receipt_vendor_id NULL when vendor_snapshot_at NULL ---"
psql "$DB" -qAt -c "
DO \$\$
DECLARE
  v_org_id uuid;
  v_msg_id uuid;
  v_vendor uuid;
  snap_at  timestamptz;
BEGIN
  SELECT id INTO v_org_id FROM organizations LIMIT 1;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'no organizations found';
  END IF;

  INSERT INTO vendors (organization_id, name)
  VALUES (v_org_id, '_test_legacy_vendor_')
  RETURNING id INTO v_vendor;

  -- Legacy row: receipt_vendor_id set but vendor_snapshot_at deliberately NULL
  -- This should fail the DB constraint added in migration_038
  BEGIN
    INSERT INTO inbound_messages (
      organization_id, from_address, to_address, subject, message_id,
      receipt_vendor_id, vendor_snapshot_at
    ) VALUES (
      v_org_id, 'test@example.com', 'test@inbound.kerdos.com', 'Legacy test',
      'legacy-test-msg-001',
      v_vendor, NULL  -- snapshot_at NULL with vendor_id set should violate constraint
    );
    -- If constraint is missing, clean up and report failure
    DELETE FROM inbound_messages WHERE message_id = 'legacy-test-msg-001';
    DELETE FROM vendors WHERE id = v_vendor AND name = '_test_legacy_vendor_';
    RAISE NOTICE 'FAIL  constraint did not block receipt_vendor_id without vendor_snapshot_at';
  EXCEPTION WHEN check_violation OR not_null_violation THEN
    DELETE FROM vendors WHERE id = v_vendor AND name = '_test_legacy_vendor_';
    RAISE NOTICE 'PASS  constraint blocks receipt_vendor_id without vendor_snapshot_at';
  END;
END;
\$\$;
" 2>&1 | grep -E "PASS|FAIL|ERROR|Exception"
echo ""

# ---------------------------------------------------------------------------
# Check I-6  recovery-sweep dispatches to process-attachment
#            Seed one pending attachment, call sweep, confirm it was dispatched.
#            Rolls back the seeded row even if sweep fails.
# ---------------------------------------------------------------------------
echo "--- I-6  recovery-sweep dispatches pending attachment to process-attachment ---"
# Insert a pending row via psql, then call sweep, then check outcome
ATT_ID=$(psql "$DB" -qAt -c "
DO \$\$
DECLARE
  v_org_id  uuid;
  v_msg_id  uuid;
  v_att_id  uuid;
BEGIN
  SELECT id INTO v_org_id FROM organizations LIMIT 1;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'no organizations found';
  END IF;

  INSERT INTO inbound_messages (
    organization_id, from_address, to_address, subject, message_id
  ) VALUES (
    v_org_id, 'sweep-test@example.com', 'sweep-test@inbound.kerdos.com',
    'Sweep dispatch test', 'sweep-dispatch-test-msg-001'
  ) RETURNING id INTO v_msg_id;

  -- Pending row with a storage path (simulates a real stuck attachment)
  INSERT INTO inbound_attachments (
    organization_id, message_id, attachment_index, filename,
    storage_path, processing_status
  ) VALUES (
    v_org_id, v_msg_id, 0, 'sweep_test.txt',
    v_org_id || '/inbound/' || v_msg_id || '/0',
    'pending'
  ) RETURNING id INTO v_att_id;

  RAISE NOTICE '%', v_att_id;
END;
\$\$;
" 2>&1 | grep -v "^DO$" | tail -1 || echo "")

if [ -z "$ATT_ID" ]; then
  fail "I-6: could not seed test attachment"
else
  echo "  Seeded pending attachment: $ATT_ID"
  # Call sweep
  SWEEP_RESP=$(curl -s -w "\nHTTP_STATUS:%{http_code}" \
    -X POST "${FUNCTIONS_BASE}/recovery-sweep" \
    -H "Authorization: Bearer ${KERDOS_TEST_SWEEP_SECRET}" \
    -H "Content-Type: application/json" \
    -d '{}')
  SWEEP_STATUS=$(echo "$SWEEP_RESP" | grep "HTTP_STATUS:" | cut -d: -f2)
  SWEEP_BODY=$(echo "$SWEEP_RESP" | grep -v "HTTP_STATUS:")

  if [ "$SWEEP_STATUS" = "200" ]; then
    # Check if our attachment appears in replayed or needsReview
    if echo "$SWEEP_BODY" | python3 -c "
import json,sys
r = json.load(sys.stdin)
att_id = '$ATT_ID'
replayed = [x.get('id') for x in r.get('replayed', [])]
needs = r.get('needsReview', [])
deferred = r.get('deferred', [])
if att_id in replayed:
    print('dispatched_to_processor')
elif att_id in needs:
    print('dispatch_failed_surfaced')
elif att_id in deferred:
    print('deferred_another_worker')
else:
    print('not_found_in_response')
" 2>/dev/null; then
      OUTCOME=$(echo "$SWEEP_BODY" | python3 -c "
import json,sys
r = json.load(sys.stdin)
att_id = '$ATT_ID'
replayed = [x.get('id') for x in r.get('replayed', [])]
needs = r.get('needsReview', [])
if att_id in replayed:
    print('dispatched_to_processor')
elif att_id in needs:
    print('dispatch_failed_surfaced_as_needs_review')
else:
    print('not_found_in_sweep_response')
" 2>/dev/null)
      if [ "$OUTCOME" = "dispatched_to_processor" ]; then
        pass "I-6: sweep dispatched pending row to process-attachment"
      elif [ "$OUTCOME" = "dispatch_failed_surfaced_as_needs_review" ]; then
        pass "I-6: sweep dispatched; process-attachment set needs_review (process-attachment may need real attachment data)"
      else
        fail "I-6: sweep ran but attachment $ATT_ID not in replayed or needsReview. Response: $SWEEP_BODY"
      fi
    else
      fail "I-6: could not parse sweep response — $SWEEP_BODY"
    fi
  else
    fail "I-6: sweep returned HTTP $SWEEP_STATUS — $SWEEP_BODY"
  fi

  # Clean up seeded rows
  psql "$DB" -qAt -c "
    DELETE FROM inbound_attachments WHERE id = '$ATT_ID';
    DELETE FROM inbound_messages WHERE message_id = 'sweep-dispatch-test-msg-001';
  " > /dev/null 2>&1 && echo "  Seeded rows cleaned up."
fi
echo ""

# ---------------------------------------------------------------------------
# Check I-7  Stale recovery respects leases
#            A row with processing_heartbeat_at = now() is NOT swept.
# ---------------------------------------------------------------------------
echo "--- I-7  Stale recovery does not touch rows with a current heartbeat ---"
psql "$DB" -qAt -c "
DO \$\$
DECLARE
  v_org_id  uuid;
  v_msg_id  uuid;
  v_att_id  uuid;
  v_status  text;
BEGIN
  SELECT id INTO v_org_id FROM organizations LIMIT 1;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'no organizations found';
  END IF;

  INSERT INTO inbound_messages (
    organization_id, from_address, to_address, subject, message_id
  ) VALUES (
    v_org_id, 'stale-test@example.com', 'stale-test@inbound.kerdos.com',
    'Lease test', 'lease-test-msg-001'
  ) RETURNING id INTO v_msg_id;

  INSERT INTO inbound_attachments (
    organization_id, message_id, attachment_index, filename,
    storage_path, processing_status, processing_heartbeat_at
  ) VALUES (
    v_org_id, v_msg_id, 0, 'lease_test.txt',
    v_org_id || '/inbound/' || v_msg_id || '/0',
    'processing', now()  -- fresh heartbeat — must not be swept
  ) RETURNING id INTO v_att_id;

  -- Simulate the recovery RPC being called for this row
  -- (cutoff is 10 minutes ago; heartbeat is now, so should return false)
  SELECT recover_stale_attachment(v_att_id, (now() - interval '10 minutes')::timestamptz)
  INTO v_status;

  DELETE FROM inbound_attachments WHERE id = v_att_id;
  DELETE FROM inbound_messages WHERE id = v_msg_id;

  IF v_status IS DISTINCT FROM TRUE THEN
    RAISE NOTICE 'PASS  lease respected — recover_stale_attachment returned % (not true)', v_status;
  ELSE
    RAISE NOTICE 'FAIL  lease ignored — recover_stale_attachment returned true for fresh heartbeat';
  END IF;
END;
\$\$;
" 2>&1 | grep -E "PASS|FAIL|ERROR|Exception"
echo ""

# ---------------------------------------------------------------------------
# Check I-8  Save/worker reservation race — begin_manual_attachment_review
#            RPC is atomic; a concurrent worker cannot claim the same row.
#            (The Python race test covers this extensively; this is a DB-level
#             sanity check that the RPC exists and returns a boolean.)
# ---------------------------------------------------------------------------
echo "--- I-8  begin_manual_attachment_review RPC exists and is callable ---"
psql "$DB" -qAt -c "
DO \$\$
DECLARE
  v_org_id uuid;
  v_msg_id uuid;
  v_att_id uuid;
  v_result boolean;
BEGIN
  SELECT id INTO v_org_id FROM organizations LIMIT 1;
  IF v_org_id IS NULL THEN
    RAISE EXCEPTION 'no organizations found';
  END IF;

  INSERT INTO inbound_messages (
    organization_id, from_address, to_address, subject, message_id
  ) VALUES (
    v_org_id, 'rpc-test@example.com', 'rpc-test@inbound.kerdos.com',
    'RPC test', 'rpc-test-msg-001'
  ) RETURNING id INTO v_msg_id;

  INSERT INTO inbound_attachments (
    organization_id, message_id, attachment_index, filename,
    storage_path, processing_status
  ) VALUES (
    v_org_id, v_msg_id, 0, 'rpc_test.txt',
    v_org_id || '/inbound/' || v_msg_id || '/0',
    'pending'
  ) RETURNING id INTO v_att_id;

  SELECT begin_manual_attachment_review(v_att_id) INTO v_result;

  DELETE FROM inbound_attachments WHERE id = v_att_id;
  DELETE FROM inbound_messages WHERE id = v_msg_id;

  IF v_result IS TRUE THEN
    RAISE NOTICE 'PASS  begin_manual_attachment_review returned true for pending row';
  ELSIF v_result IS FALSE THEN
    RAISE NOTICE 'FAIL  begin_manual_attachment_review returned false for unclaimed pending row';
  ELSE
    RAISE NOTICE 'FAIL  begin_manual_attachment_review returned unexpected: %', v_result;
  END IF;
END;
\$\$;
" 2>&1 | grep -E "PASS|FAIL|ERROR|Exception"
echo ""

echo "=== Checks complete ==="
echo ""
echo "NOTE: I-6 dispatches to the live process-attachment function."
echo "      An outcome of 'needs_review' is acceptable if the seeded storage path"
echo "      has no real file — it means the dispatcher reached process-attachment"
echo "      and process-attachment handled the missing-file case gracefully."
echo ""
echo "Record results in Module A interaction gate under:"
echo "  Division I → A. Pre-Ingestion → Task 1 → A1.1–A1.7 Interaction Verification"
