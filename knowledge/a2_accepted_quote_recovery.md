# Accepted price-row recovery

The automatic-repeat pilot passed for the already completed 87-row source. A
separate recovery check found a gap before document completion: migration 015
only deduplicated history after mutating the vendor listing. A lost first reply
could create another listing; replaying an older partial source could overwrite
a newer accepted quotation even though its history insert did nothing.

The authenticated quote RPC now locks the owned source document before applying
a keyed row. If that document/row already has accepted price history, it checks
saved quotation evidence and returns the committed listing ID without changing
listing fields, revision, time or incoming evidence. Catalog-link and progress
recovery may continue using that ID. A conflicting price, source line,
description, selling unit, basis or supplied listing ID rejects. Organization,
vendor and owner/manager checks still run first. No security-definer privilege
or new public endpoint is introduced. Deployed explicit case/each pricing rules
are preserved. Existing no-key legacy behavior and unresolved rows without an
accepted history record are outside this new replay guard.

The embedded SQL regression first failed against the old function because the
retry returned a second listing. It covers the fixed lost-reply path, revision
stability, old-source replay after a newer accepted price, altered evidence and
listing rejection, employee/outsider isolation and legacy no-key behavior. The
migration is applied twice in the fixture. Separate-session CI tests require an
observed PostgreSQL lock wait, then verify commit, rollback and conflicting
requests each leave one listing and one history record. Their databases are
synthetic, loopback-only and removed afterward.

This is recovery hardening, not a new installed-browser acceptance. Fresh or
changed supplier pricing still needs live verification. Accounting expansion
remains paused; no supplier order, payment or approved Order Guide change.
