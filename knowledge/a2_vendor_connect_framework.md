# Vendor Connect shared framework

I · Procurement → A · Automated Ingestion → Task 2 · Vendor Integration
Client page: Vendor Connect. Implementation increment: November 1, 2026.

## Result

The application can prepare a client-vendor setup request using an approved
provider definition. It can list, cancel and restart those requests. This is
not account authentication and never implies an active connection.

Pending requests are separate from the existing credential-bearing HTTPS-export
sources. The latter remain operator-enrolled. No placeholder secret is needed,
and no client can activate a source, claim a worker lease or mark setup connected.

Platform adapter definitions describe retrieval/execution methods. They contain
no client, vendor account, list ID, product count, credential or session. Each
request uses the saved organization/vendor foreign key. The pilot remains
client Hornets Nest Deli → vendor US Foods → provider MOXē. Pilot identity is
configuration and acceptance evidence, not a universal code constant.

## Implemented locally

- `adapter.mjs`: trusted execution interface; legacy HTTPS default; explicit
  unsupported adapter/local execution outcomes; bounded artifact validation;
  safe result reasons. No MOXē adapter or cookie capture is registered.
- Existing orchestration retains claim → retrieve → hash → retain → stage →
  dispatch → finish. `downloadExport()` and the original-byte protections remain.
- `vendor-connect.js`: provider-independent service using the records adapter
  and an optional named enrollment capability. Reads and cancellation include
  organization scope. Errors do not expose backend diagnostics or credentials.
- Vendor Connect page: vendor/provider selection, pending state, cancellation,
  restart, organization-switch invalidation, role guard and safe missing-schema
  behavior. No password field, login button or operational retrieval promise.
- SQL proposal: security-invoker enrollment RPC backed by RLS and column-level
  grants. Cross-client writes/reads and connection-state promotion are denied.
  Approved adapter metadata is client-readable and not client-editable.
- Result-contract proposal: accepts unsupported adapter, execution unavailable
  and verification-needed outcomes and pauses affected export sources. Stored
  observations remain intact; automatic retry cannot repeatedly attempt MFA.

## Installation boundary

Both SQL files ending `_draft.sql` are review proposals, not applied migrations.
The Supabase CLI is unavailable in this workspace, so no migration-history name
has been fabricated. Generate actual migrations with the CLI after review,
inspect current target schema/advisors and apply to the isolated test environment
before deploying this feature. Never modify the earlier applied migration.

The existing claim RPC does not yet return portal execution metadata. No portal
source is enrolled in this increment. That claim/source extension belongs with
the verified execution design, not with a fake portal credential. The pending
request metadata already describes the candidate retrieval kind.

Deploying the worker requires its new `adapter.mjs` module and the matching
result-contract update. Keep portal adapters unregistered until their runner,
identity checks and authentication are proved. Existing HTTPS sources continue
using their current claim shape and download contract.

No live database, credentials, schedule, hosting, GitHub push or deployment was
changed by this increment. On the old schema the page keeps setup unavailable;
it does not create local pretend connections or queue secret-bearing actions.

## Adopted review findings

Reuse HTTPS/export storage/leases/replay/ingestion. Add a shared adapter interface,
client-scoped setup and explicit permission boundaries. Account verification and
session lifecycle still require implementation.

Do not treat manual file upload as automatic `vendor_pull` provenance. Do not
assume a KERDOS webpage can capture another site's cookies. Do not presume that
paid hosting is required or that cookie replay works. Preserve free-only and
no-AI-call constraints. Browser automation is an execution adapter, not the core.

## Next required proof

1. Validate a real MOXē CSV, including the Product Prices option, full row count,
   fields, quoted units and values. This proves source quality, not retrieval.
2. Prove a packaged local browser/helper approach: user signs into the vendor's
   own page, completes MFA there, and explicitly authorizes the limited adapter.
   No cookie extraction from the KERDOS page, broad browser permissions or
   assumptions about ChatGPT's browser tools.
3. Establish safe helper-to-KERDOS authorization and tenant-bound file delivery.
   Do not place Supabase service credentials in a browser/helper. Keep original
   retention, snapshots, duplicate protection and existing import rules.
4. Prove cancellation fencing, expiry/reconnect/disconnect, selected-list
   persistence, changed prices and scheduling limits. Offline desktop data may
   remain usable, but vendor retrieval requires network and a running executor.
5. Extend connection/source/claim contracts around that proof, then complete
   real supplier end-to-end acceptance. No automatic MOXē login, export, upload
   or scheduled supplier pull is claimed by the current local checks.

## Validation

`npm run test:a2` includes the original 26 adapter/SQL/importer checks plus a new
result-contract check (27), 8 SQL/adapter/service checks and rendered UI/provider
checks. SQL tests execute in local PGlite with generated identities; Vault and
HTTP transports in the existing suite are simulated. New client permission
tests execute as authenticated/anonymous database roles. These are local tests,
not hosted Supabase or real supplier acceptance.

## Second increment — source validation and local companion prototype

A real MOXē Main Items CSV was downloaded through ChatGPT’s interactive browser
on November 1. Its 87 rows were compared against KERDOS’s parser: 522 exact
field comparisons across code, description, brand, pack, price and unit. The
original is retained privately, outside the repository. No real client pricing
or account/list identifier is embedded in regression fixtures.

The first parse returned 84 rows. The source exposed early fuzzy header matching
stealing explicit later columns and a product/brand being mistaken for a repeated
header. The general fix prioritizes exact labels, retains classification/storage
fields as source metadata, recognizes the explicit product fields, and prevents
a priced data row from changing the header map. The corrected parse retains all
87 rows and matches all six source fields. Two zero-price/missing-unit rows stay
unavailable; unsupported pack expressions still require review.

`companion/chrome` contains an unpacked, user-started local export prototype.
Its provider registry dispatches to a vendor-specific MOXē adapter; the generic
popup carries no vendor logic. It asks Chrome for only activeTab and scripting.
There is no cookies API, credential entry, session capture, all-sites access,
remote script, paid service, KERDOS upload or scheduler. The client signs into
the vendor directly and opens their selected list. The adapter checks account
and exact list title, opens Download, requires CSV and selects Product Prices.
It reports only download_requested, not a confirmed file or import.

Account/export/title selectors were inspected in the actual portal; execution
was tested against a controlled DOM model. Installation and execution as a real
Chrome extension remain OPEN. No extension was installed and no browser access
was granted by this source change. It is a candidate execution proof, not a
released or operational Vendor Connect integration. The next step is an
explicitly authorized installed-extension pilot, followed by safe file capture
and tenant-bound ingestion.

## Third increment — one-use companion handoff (local, not deployed)

The installed 0.1.0 pilot was followed by a user-returned Main Items CSV with
87 rows and the same exact bytes as the earlier source. That supports the export
workflow; the file alone does not prove its execution path or ingestion.

The current 0.2.0 source supersedes the export-only description above. The app
arms a ten-minute, one-use client/vendor assignment from a selected pending
setup. The provider key and approved origin come from the operator-managed
adapter registry; the receiver and page contain no supplier-specific branches.
A second synthetic supplier exercises the same receiver unchanged. Pairing from the approved KERDOS tab installs an isolated bridge; the
companion saves the ticket only in trusted extension session storage. The
vendor-specific adapter uses a temporary MAIN-world Blob observation during the
selected normal CSV export. Exact captured bytes go to the existing signed-in
KERDOS tab, without exposing its credentials to the extension. KERDOS validates
and hashes the bytes and supplies its own organization/vendor to the importer.
The receiver acknowledges only received_for_review. Saved prices depend on the
existing import workflow, including unknown-column and unresolved-row review.

The original download may still appear; users do not select it for upload.
Blob capture must be proven against real MOXē. It may not capture if the portal
uses server-navigation downloads or a different MIME type. Capture is bound to a download anchor whose CSV filename matches the selected
list; unrelated Blobs/download names are ignored. No provider
endpoint or session replay was invented. No background scheduling was added.

`knowledge/a2_companion_evidence_draft.sql` is a separate unapplied schema
proposal: nullable immutable retrieval_evidence on import_documents, using
browser_companion/user_approved_browser_session assertions, SHA-256 and byte
length. The authenticated app retains the original file/evidence before saving
new prices; it fails closed when the new column is absent. Manual imports omit
this field and cannot later be promoted by changing it. Existing complete
content duplicates retain their original provenance. The evidence is not a
supplier signature and is not labelled as a server vendor_pull receipt. Existing
inbound message/source/credential contracts remain unchanged.

Local acceptance executes the app/isolated bridge exchange and exact-byte/hash
checks; foreign-origin/sender, replay, invalid CSV/HTML/size, expiration and
cancellation cases; controlled Blob export and hook cleanup; and actual SQL
shape/immutability constraints. The real importer also runs with simulated
persistence to prove original/evidence retention before quote writes and
fail-closed behavior when the evidence column is missing. The existing role/organization tests remain.
Live end-to-end acceptance is OPEN. None of these drafts has been applied or
source changes pushed/deployed by this increment. Next: review/apply the three
separate SQL drafts, deploy the app, reload the companion, and run the Hornets
Nest Deli / US Foods pilot with exact-byte and scoped-record verification.


## Deployment checkpoint — November 1, 2026

The four reviewed migrations are installed in kerdos-test with bounded lock and
statement timeouts. CLI-generated files were aligned to the versions returned
by hosted migration history: 20261101135440 setup, 20261101135453 finish results,
20261101135500 companion evidence, 20261101135540 import access boundary. The
original proposal files remain regression-test sources; the installed versions
are under supabase/migrations.

Deployment preflight found an existing permissive import_documents ALL policy
which bypassed the separate manager-write policies. The narrow access migration
removes that redundant policy, keeps member reads/owner-manager writes, and adds
a validated organization/vendor foreign key. All 34 existing documents had valid
ownership and remain retained. Local executed tests include employee denial and
cross-client vendor inserts/updates. Hosted rollback-only role smoke verifies
setup idempotence, cancel/restart, evidence immutability and nonmember denial; it
does not represent real user-auth or browser acceptance. No smoke records remain.

The vendor-price-pull worker is version 2 and process-attachment version 14.
Deployed source was compared with the reviewed bundles; service authentication
settings are preserved. Security advisor results match the preflight baseline;
no new findings were introduced. Existing recovery cron is retained and no
Task 2 schedule or operational source is enabled. Full local regression, A2
access/adapter checks and GitHub Pages production build passed. Frontend rollout
and the installed 0.2.0 live supplier handoff are tracked in the current task list.
