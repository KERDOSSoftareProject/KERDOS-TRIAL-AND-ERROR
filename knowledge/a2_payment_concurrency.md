# Task 2: independent PostgreSQL purchasing and payment sessions

`npm run test:task2-concurrency` exercises the actual migration functions with
three distinct PostgreSQL backend PIDs: two authenticated-role sessions and a
monitor. An ephemeral PostgreSQL 17.6 service runs on the CI runner. No Supabase
connection, application secret, bank API, email or production data is used.

The test refuses non-loopback hosts, connection query overrides and any initial
database other than `postgres`. It creates a UUID-named fixture database, applies
the same migration/fixture setup as the embedded receipt SQL suite, and drops
that database after ending the worker sessions. It verifies removal. The CI
service/container is disposable; the harness is not for a shared database server.

Each race holds the first operation uncommitted, starts the second operation in
a different session, and requires `pg_blocking_pids` to prove the second waits on
the first. It then commits or rolls back the first and checks the exact outcome.
Timeouts bound statements, lock waits, monitoring and the CI job. Expected business
rejections must have SQLSTATE P0001 and the relevant reason; a timeout, deadlock
or unrelated SQL error does not pass. Cleanup releases the blocker even when a
monitoring/assertion failure occurs.

Thirteen cases cover competing payments that would overpay, competing payments
whose amount fits but whose reviewed history is stale, identical same-actor
request retry after commit and rollback, different-actor request reuse,
correction branching, exact correction replay, rolled-back correction retry,
approval withdrawal before and after payment, receipt reversal before and after
payment, and payment reversal invalidating a waiting stale save. Independent
queries check record/reversal counts and exact active cents; correction lineage,
reference retention, historical replay, withdrawal counts and source eligibility
are checked where relevant. Owner and manager roles participate explicitly.

Twenty-two further races cover draft save versus permanent attempt closure in
both operation orders with commit and rollback, identical draft-save retries,
different-actor request reuse, identical order submission after commit/rollback,
conflicting submission actors, and cancellation before/after submission. Receipt
cases cover same-source retries after commit/rollback, conflicting actors,
competing quantities on one order, one invoice line claimed by different orders,
reversal invalidating a waiting receipt review, and receipt replacement branching,
exact replay and rollback. Creator employees, owners and managers participate.
Independent queries check draft/closure exclusivity, order/submission/line counts,
rolled-back identities, receipt/reversal/replacement counts, active case quantities,
actual charge cents, retained/released source reservations and replacement lineage.
A stale receipt is saved only after a new review; reversal does not reactivate it.
The suite requires all 35 cases to run, so accidental omission cannot silently pass.

The new CI workflow runs on pull requests and main, and may be run manually.
The ordinary full test/build suite remains separate. This evidence covers actual
PostgreSQL lock contention and migration-function behavior. It does not establish
browser sign-in, Supabase HTTP/JWT/session-pooler behavior, a complete hosted
schema integration, physical receiving or bank settlement. Those acceptance
gates, credits/refunds and cross-invoice allocation stay open. Task 1 remains
code/database complete awaiting domains; Task 2 remains open.
