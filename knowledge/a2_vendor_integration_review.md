# Module A · Task 2 · Vendor Integration

Status: tested implementation draft; schema, function and cron not deployed.
This is the original three-item Task 2, not a new module or renamed task.

## Implemented

1. **Store client vendor credentials securely per vendor.** Sources live in the
   private schema, with a composite organization/vendor foreign key. Credentials
   live in Vault; source rows hold only secret IDs. Enrollment/rotation is an
   operator-only private function. No browser secret reads, editable JWT claims,
   client routing selectors or service key exposure. Rotation fences old leases;
   source deletion removes its secret while preserving source receipts.
2. **Scheduled or on-demand pricing pull.** The first adapter reads an explicitly
   approved HTTPS price-export endpoint using Basic or Bearer credentials. It
   rejects redirects, query-string credentials, IP/local hostnames, private DNS
   results, HTML login pages, wrong file types and empty/oversize responses.
   Three leased sources run concurrently; each download is bounded to 30 seconds
   and 5 MiB. Dispatch has a 90-second bound. A source can be due or pulled on
   demand. The private scheduler reads its operations credential from a Vault
   reference. The draft includes an idempotent named five-minute cron command;
   it is deliberately not enabled by applying the schema alone.
3. **Automatically route pulled data into ingestion.** Preserve original bytes,
   create an atomic revision/content-keyed receipt and pending attachment, then invoke the
   existing process-attachment worker. The receipt carries the authoritative
   organization/vendor/pricelist snapshot. No vendor inference or manual Save.
   An immediate identical replay preserves receipt/attachment identity. Content A → B → A advances the source revision so a genuine return to an earlier price sheet is not suppressed as an old duplicate; each observation has a distinct storage path/import fingerprint. Revision changes and receipt staging commit atomically under the source lease. Storage conflicts require an
   exact byte comparison. Failed dispatch leaves a durable attachment available
   to existing A1 recovery. `received` means durable intake/handoff, not a false
   promise that every source row was accepted.

The existing email path still requires a routing address. Only the explicit
`vendor_pull` source kind allows a null routing address, with a non-null vendor,
pricelist type and receipt snapshot. Pulled receipts are labelled “Automatic
vendor price pull” and “not an email delivery”; Postmark transport evidence is
not claimed. Owned receiving domains are not needed for this pull path.

## Evidence

- `npm run test:a2`: 22 executed checks, actual Edge entrypoint authentication,
  export adapter and PostgreSQL-compatible SQL. SDK transport, DNS/HTTP and Vault
  are simulated locally; this is not hosted portal acceptance.
- Actual kerdos-test Vault: create disposable synthetic credential, assert stored
  value differs from plaintext and decrypted value matches, roll back, confirm
  named test secret absent. Passed October29,2026 UTC. No real credential used.
- Full repository checks include test:a2; lint and production build are required
  before the draft is handed off.

## Deployment sequence and rollback

1. Review `a2_vendor_integration_draft.sql`, then generate a real migration with
   Supabase CLI. The CLI is unavailable in this workspace; no migration-history
   filename is fabricated. Run against kerdos-test only and inspect advisors.
2. Confirm the actual Vault functions, source foreign keys, receipt constraints,
   grants, disabled source behavior and unchanged email processing. Preserve
   existing A1 snapshots and test records.
3. Deploy vendor-price-pull with its two local modules and the existing exact
   auth helpers. It performs its own service/operations bearer checks, so its
   gateway JWT flag is false. The service-role key never goes into Vault or the
   browser. The existing operations credential can authenticate the scheduler.
4. Enroll a controlled read-only export, test source isolation and bad auth, pull
   once on demand, verify original and exact catalog/price values, replay, then
   observe a scheduled run without an app tab or direct worker call.
5. Only then configure the private dispatch URL/Vault reference and enable the
   named cron job. Enroll a real vendor only after verifying its supported
   export method and its credential authorization. Keep sources disabled until
   that verification.

Rollback: disable the named cron and source flags first, retire/delete only the
new vendor-price-pull function, preserve its receipts/originals. Existing A1
functions remain unchanged. Do not blindly restore NOT NULL on routing_address_id
after pulled receipts exist; retain the source-kind constraint and audit data.

## Remaining external dependency and limits

No vendor export URL, API documentation or authorized vendor credentials have
been supplied. Therefore no real vendor integration can honestly be marked
complete. This adapter supports a verified read-only export; arbitrary browser
logins, MFA/CAPTCHA/cookie flows require a vendor-specific adapter and are not
implemented or bypassed. No orders or other vendor-side writes occur.

Only trusted operators can approve origins/enroll sources. DNS checks are
defense in depth, not a guarantee against a malicious operator-approved host
performing DNS rebinding. This is not a general-purpose client URL fetch proxy.
Reapproval is required for new export origins. No schema/application changes
have been applied to kerdos-test by this draft.

## Initial live-test approval rejection — historical, October29

The exact proposed test is archived in `a2_live_schema_check_rollback.sql`. It
creates the draft schema/functions/grants/triggers within one transaction, uses
only the isolated synthetic organization/vendor, creates a disposable Vault
credential and three metadata-only source receipts, checks source ownership,
service/client grants and A→B→A/replay identity, deletes the disposable source,
then rolls the transaction back. It performs no storage upload, worker dispatch,
network request, cron enabling or real vendor operation. A three-second lock
timeout bounds lock acquisition; this does not eliminate lock or transaction
failure risks.

Automatic approval review rejected that test before execution because explicit
authorization to apply this draft SQL live was absent and rollback does not
remove the shared-database risks. No workaround or retry was attempted. Read-only
checks confirm the draft table and claim RPC are absent. The archived SQL was unexecuted at that point. Explicit approval was subsequently
granted; the successful actual database test is recorded below. It is not a
permanent migration or a vendor/worker acceptance test. Existing disposable Vault encryption-only evidence
is separate and remains valid.

## Approved actual database test — PASS, October29

Dino explicitly approved the fixed rollback-only test after adding all three
timeouts: lock acquisition3s, statement15s and idle transaction10s. The first
connector attempt returned an expired-requestState error; read-only checks
showed unchanged baseline. An identical approved retry succeeded.

Actual kerdos-test assertions passed for organization/vendor ownership, exact
replay identity, A→B→A revisions, source-kind/snapshot constraints, service versus
client permissions, finishing a pull and deletion of its disposable credential.
The transaction rolled back. Independent follow-up confirmed Task2 table/RPC
absent, no source_kind column persisted,17 messages/34 attachments unchanged,
zero vendor secrets,zero idle transactions and the existing recovery cron active.
See `a2_live_schema_check_results.json`.

This supersedes the earlier unexecuted/approval-blocked status for this exact
test. It remains a database-only test: no storage, worker, email, export-host,
scheduler modification, permanent schema or function deployment. Real vendor
export-to-catalog acceptance is still open.
