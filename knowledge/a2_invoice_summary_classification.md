# Task 2: retained invoice summary classification

Invoices → Reconcile → Clarify summary source lets an owner/manager classify a
complete monetary line already present in the saved invoice text. Select its
line number/category, give a reason, review the derived text, and confirm. The
original header/text, item lines and receipts remain unchanged. The amount token
is copied exactly; amounts cannot be typed, invented or suppressed. Supported
categories are subtotal, tax, freight, credits, other stated charges and total.
Recognized labels retain their existing category. Item-source lines, unsupported
precision/currency, malformed signs, repeated/out-of-order selections and extra
mapping fields reject. Empty mappings create a new revision restoring original
interpretation. Unknown/unselected lines remain visible to the existing gate.

Every save appends a source-bound classification snapshot: original raw text and
item sources, mappings, derived text, reason, actor/time, request, revision and
predecessor. Original records never change. Current source/history and request
identity are checked under order-line then invoice-header locks. RLS permits
member reads and owner/manager insertion; only reviewed inputs are insertable.
Derived audit fields are protected, history is immutable and all functions use
invoker privileges. Anonymous and worker execution/table access are denied.
Existing unique indexes cover organization/request and invoice/revision lookups;
the unique predecessor FK prevents branches. No data migration/backfill.

The current read includes the latest classification only when one exists, keeping
all earlier unclassified DTOs compatible. Both pure JavaScript and independent
SQL validate retained basis and derive the same text. Approval/payment still
require all existing amounts, source arithmetic, clean receipt coverage and
current non-withdrawn approval. New classification metadata invalidates older
approval evidence even when money tokens stay the same. A changed retained basis
is held for fresh review. The classification editor can still read original
source/history to repair that hold. Missing tax/freight/credits never become zero.

Same actor/request/review replay returns its original audit identity; changed
actor/request, stale basis/history and late failures cannot advance the chain.
Historical replay after a later classification never restores the old one. The
UI freezes unconfirmed request details, supports identical retry, refresh/history
recovery and saved-history remount. Reason/category changes invalidate review and
consent. SQL rollback is distinguished from uncertain transport/history errors.
Saved classification refreshes reconciliation, accounting and payment review.
No approval, financial transaction, supplier message or Order Guide change occurs.

Validation covers SQL/core/service parity, source/item protection, role/consent
checks, revision/source CAS, exact and historical replay, approval invalidation,
tampered derived text, late rollback and current metadata. Rendered production
UI checks cover preview, reason invalidation, confirmation, no writes on reading,
unknown response/request, identical retry, history-after-write failure, known SQL
rollback, saved remount, employee view and late response isolation. Seven real
PostgreSQL session races extend the prior35 to42: duplicate commit/rollback,
competing classifications, and classification before/after approval or payment.
Every race must prove a lock wait and verify its outcome and cleanup.

This resolves classification of supported, retained monetary lines. It does not
supply absent source evidence, revise recognized amounts/labels, repair duplicate
summary/item extraction, edit invoice totals, settle bank payments, apply credit
notes, allocate across invoices or handle mixed fixed/estimated receipt coverage.
Actual signed-in hosted/browser and supplier end-to-end acceptance remain open.
Task1 remains code/database complete awaiting domains; Task2 remains open.
