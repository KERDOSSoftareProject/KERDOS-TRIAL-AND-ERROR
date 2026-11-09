# A2.b.vi: versioned companion schedules and atomic claims

This database foundation is separate from schedule activation. No app code
calls these RPCs yet. No cron, supplier operation, hosted enrollment, or
Supabase migration installation is introduced by this commit.

The new private schema contains schedule versions and slot attempts. Every
real schedule edit closes the preceding effective window and inserts a new
version. Identical settings keep the version; an expected-version argument
rejects stale edits. Cancellation, reconnection and changed account/list labels
retire the current window. Reconnection never revives it implicitly.

The claim RPC takes only a request ID. The database checks the authenticated
owner/manager, active supplier, available browser provider, selection revision,
enabled schedule and effective window, then computes the slot from its own
clock. Grace is an explicit owner configuration (1–60 minutes); it is not an
assumed business default. No historical slot outside grace is claimed.

A request-row lock serializes edits, cancellation and claims. A unique
`(request_id, slot_at)` constraint prevents a slot from getting a second token
regardless of schedule version. An unfinished attempt is never re-leased after
expiry: its display will be Outcome unknown. Conservatively, an unfinished
attempt also blocks future automatic slots until evidence resolves it. The
15-minute lease is only a pending/unknown display boundary, never permission
to repeat work. No in-slot retry is provided.

API roles cannot read or mutate the private tables. Public RPCs are invoker
wrappers around narrowly granted private definer delegates. Definers are needed
for server-written slots/history without client mutation grants; they explicitly
check auth.uid() and current organization role, use an empty search path, and
have no PUBLIC/anonymous/service-role execution grant. Existing credentials and
hosted runner schema privileges are not broadened.

Tests execute the actual migrations twice, exercise authorization, effective
windows, invalid settings, stale edits, grace, cancelled/reopened requests,
open/expired/finished claims and separate clients. PostgreSQL CI also uses
independent sessions and observes a real lock wait before commit/rollback:
only one claim row survives, and an expired unfinished row is not reclaimed.
Fixture clock adjustments are administrator-only inside disposable test
instances; the production RPC has no clock or slot override.

Remaining within the same OPEN A2.b.vi: receipt-bound completion and resolution,
owner-readable schedule/attempt history with accurate Missed derivation, UI,
bounded open-tab due checking and live acceptance. These must precede applying
and enabling the feature. Hosted source scheduling and rejected-credential
retry policy remain separate existing work. This foundation neither changes
that path nor claims an unattended companion.
