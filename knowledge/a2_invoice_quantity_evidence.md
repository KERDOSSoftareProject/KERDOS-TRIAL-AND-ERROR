# Invoice quantity source evidence for Task 2 reconciliation

This increment retains invoice quantity provenance through the shared parser,
manual invoice save and automatic invoice save. It does not match a receipt to
an order, determine received cases or settle any final charge.

## Reading and evidence

Tabular rows retain the exact selected quantity header, raw cell, column index,
canonical header line and original normalized source line. Explicit Billed
Quantity/Qty/Weight, Quantity/Weight Billed and Invoice Quantity/Qty headers take
precedence over an earlier ordered count. No vendor-specific mapping is added.
The existing structured goods-invoice reader retains its separately printed
measured Weight/Billed Quantity value and original heading/line, independently
of ordered and delivered counts.

Only explicitly billed headers or the recognized goods-invoice measured field
produce invoice_billed_quantity evidence. Its quantity must equal the retained
raw cell and parsed quantity; its unit must already have valid billing-unit
source evidence. Generic Qty/Quantity/Count, Ordered, Delivered and unlabeled
fields are retained but do not become this evidence by arithmetic. These inputs
need explicit source clarification in the later receipt workflow. Missing or
ambiguous evidence never blocks otherwise valid existing invoice intake.

## Atomic persistence

invoice_lines adds nullable quantity_source and billed_quantity_evidence JSON
columns. Existing rows remain null: there is no backfill or invented evidence.
The existing manual and service-only automatic RPCs retain both fields. Their
ownership, role, receipt snapshot, arithmetic, lease, original/document, replay
and transactional protections are preserved. The database derives canonical
proof from retained source, quantity, unit and billing evidence. A before-write
trigger rejects contradictory supplied proof, including quantity/source edits
that would leave stale proof. Clients cannot turn a generic heading into
confirmation merely by supplying an evidence object.

The JS and SQL rules are compared across valid headers, structured goods rows,
ordered/billed differences, malformed types, missing units, edited quantities,
wrong source lines and ambiguous headings. The helper is invoker-only with
anonymous execution revoked. Existing invoice RLS and role grants are retained.

## Validation and release boundaries

Local checks exercise actual parser → proof → SQL parity, both real invoice
RPCs, automatic atomic save/replay, manual rendered upload payload retention,
unchanged legacy intake and contradiction rollback. Normal full regression,
lint and build include these checks. The attachment worker reuses the shared
parser/automatic-invoice module; its bundle needs the new pure helper while
keeping JWT verification and exact service-bearer checks unchanged.

Hosted verification uses scripts/verify_invoice_quantity_rollback.sql to create
an isolated fixture organization, exercise authenticated manual save and
service-role automatic save/replay, and roll back every record. This is database
role simulation, not real email, Storage-original, browser or invoice-receipt
acceptance. Old invoices must not be silently relabeled when the schema installs.

Open: explicit source clarification for ambiguous quantities; actual submitted
order/invoice-line matching; unique invoice-line receipt protection; partial
receipts and received-case evidence; delivered-weight charge/rate variance;
concurrent receipt checks; signed-in and real supplier acceptance. No receipt,
actual final charge, vendor email or supplier order is created by this increment.
