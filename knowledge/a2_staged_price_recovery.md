# Held price-row recovery

PR89 covers accepted rows through price history. A newly held row intentionally
has no accepted history, so a lost first reply still produced a second listing
in the actual SQL regression. This follow-up preserves its committed identity
without making the held observation into a usable quote.

The existing source document retains an append-only staged_row_receipts map:
row ordinal to saved listing ID and SHA-256 of source/pricing inputs. The quote
RPC locks the owned document and records listing plus receipt in the same
transaction. Exact held replays return that ID without mutating listing fields,
revision, timestamp, review evidence or price history. This still works after a
correction or newer source supersedes the listing. A receipt write failure rolls
back the listing write. Receipts cannot be cleared or reassigned, and new entries
must reference this document's organization/vendor listing. Existing document
RLS and security-invoker authorization remain in force; no privileged API added.

A deliberate current-row resolution may use the known saved listing ID. An old
held retry cannot undo that resolution. A different positive price from an old
held source cannot overwrite a newer source; it requires current evidence and
review. The previous accepted-history replay guard remains in place.

The browser document service explicitly stamps staged_receipts_version=1 for
new source records. Existing documents and older producers remain unversioned;
they are not bulk relabelled or guessed. For an unversioned held row, the RPC
requires exactly one current saved listing with matching organization/vendor,
source document/row key, raw source row/line, description, code, pack, brand,
price, selling unit/basis and identifiers. It records a receipt and recovers that
identity without rewriting the listing. Missing, ambiguous, edited or superseded
legacy identities stay retained for review instead of creating another listing.
The legacy marker cannot be changed to bypass that check. Older producer and
worker code is unchanged; this is the authenticated browser import contract,
not a new background-automation acceptance claim.

Actual SQL regressions cover the original held duplicate, receipt stability,
correction, old retry after newer pricing, conflicting input, append-only and
version integrity, atomic rollback, RLS isolation and exact/conservative legacy
recovery. Migrations run twice in the fixture. Independent PostgreSQL CI adds
held commit/rollback/conflict races to the three accepted races, with observed
lock waits, correct listing/history/receipt counts and database cleanup. Existing
rendered automatic-ingestion checks verify the browser's new-document marker.

Refresh deployed KERDOS for the updated browser document contract. Companion
0.2.1 needs no replacement. Existing completed exact-file pilot acceptance
remains valid. Fresh/changed supplier saving, remaining installed-session and
lifecycle cases, and independent original-binary verification remain open.
Accounting expansion stays paused; no Order Guide, supplier order or payment
change. Existing originals, completed keys and source snapshots are not edited.
