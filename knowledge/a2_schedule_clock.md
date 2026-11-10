# A2.b.vi: local schedule clock foundation

The private `next_scheduled_at` helper computes the next weekly local-time slot
strictly after a supplied instant. ISO weekdays are Monday 1 through Sunday 7.
It accepts only a known database timezone, a nonempty unique weekday set, a
time below 24:00 and a finite reference instant. It is an invoker function with
an empty search path and no API-role execution grant.

The helper has no clock reads, writes, credentials or network operations.
This migration does not add a schedule record, enable a runner, alter existing
interval-based hosted pulls, or claim that scheduled retrieval is delivered.

## Calendar policy

Use PostgreSQL's local-timestamp conversion rules consistently:

- A missing local hour uses the offset before the transition. For example,
  New York 2026-03-08 02:30 resolves to 03:30 daylight time (07:30 UTC).
- A repeated local hour uses the offset after the transition. New York
  2026-11-01 01:30 resolves once, to the later occurrence (06:30 UTC).
- An entirely skipped civil date is omitted, rather than silently moving a
  selected weekday to another date. A Friday schedule across Samoa's skipped
  2011-12-30 waits for the following Friday.
- A slot exactly equal to the reference instant is excluded. Future claim and
  schedule-version code must apply its own explicit effective-window/grace
  rules; those ownership decisions do not belong in this pure clock helper.

The database session's timezone does not change the calculation. Each slot is
derived from its calendar date and local time, not the previous job's finish
time. Thus a late finish cannot gradually move the schedule.

## Validation and remaining work

`scripts/test_a2_schedule_clock.mjs` executes the exact migration twice and the
same assertions using PGlite locally or an isolated, loopback-only PostgreSQL
database in the existing independent-session CI job. Tests cover exact UTC
offsets, missing/repeated hours, weekly boundaries, leap dates, fractional-hour
zones, a skipped civil date, varied finish durations, invalid inputs and
function privileges. This clock test does not prove a two-session claim race.

Before enabling schedules, the existing A2.b.vi work still needs versioned
owned schedule records, atomic server-computed slot claims, immutable Unknown
outcomes, validated receipt identity, cancellation gates, owner UI and bounded
open-tab execution. No in-slot retry is introduced by this foundation.

Timezone conversions depend on the target database's timezone data. The tested
cases are not a certification of every zone or installed hosted version. Before
an actual zone is enrolled, verify its conversions on that target; the October
30 Supabase timezone-data notice identifies affected older versions separately.

References reviewed November 6, 2026:

- https://www.postgresql.org/docs/current/datetime-invalid-input.html
- https://supabase.com/docs/guides/database/functions
- https://supabase.com/changelog/tzdata-local-time-vancouver-edmonton-casablanca

Claude's Part I is preparation for this existing task, not 38 separate tasks.
Its DST expectations are fixed assertions, not an "or reverse" alternative;
claim races belong in independent PostgreSQL sessions when claims are added.
