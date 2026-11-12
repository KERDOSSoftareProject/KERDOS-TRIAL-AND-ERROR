# Regular Order Items

**KERDOS → Division I Procurement → Module G Order Guide**

A new workspace opens the full Order Guide. Regulars builds automatically from
the workspace’s recorded purchase orders. Once five current Order Guide
items qualify, Regulars becomes the default on opening the guide. All Items
remains available, and a buyer’s choice stays active while they work in the
guide. The two views use the same Order Guide rows, filters and basket.

## Qualification

- An item must appear with positive quantity in at least two of the last five
  submitted purchase orders for the workspace. Multiple lines on one PO count once.
- Its most recent qualifying purchase must be within 60 days. Items expire
  automatically when the list next loads. Exactly 60 days is included.
- Use the recorded submission timestamp where present. Standard order records
  created directly in submitted status use their creation timestamp when no
  submission timestamp exists.
- Drafts, cancelled POs and baskets are excluded. A recorded PO can qualify
  even when vendor delivery of the order has yet to be confirmed.
- History for merged catalog numbers follows the current KERDOS item.
- The five-item default threshold counts only groups currently shown in the
  Order Guide. Search, category and vendor filters apply inside either view.

## Implementation

The read-only `kerdos_regular_item_ids` RPC uses the signed-in caller’s
workspace membership and existing row-level security. Its SQL parameters
default to two orders, a five-order window, and a 60-day recency limit.
Workspace-specific configuration and manual pinning or removal are future work.

KERDOS refreshes the list when opening the Order Guide and after a successful
workspace refresh, including after recording an order. The full guide remains
usable while the list loads or when the provider cannot load it.

## Verification

Run `npm run test:order-guide-groups` for filtering, default selection,
manual switching, and real PostgreSQL-engine tests for qualification, recency,
existing orders and workspace access.
