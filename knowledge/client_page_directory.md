# Client page directory

November 1, 2026. Canonical UI labels live in `src/ui/workspace-pages.js`.

| Page | Existing architectural home |
| --- | --- |
| Welcome (Home) | IV · A · Language Table; entry and navigation |
| Order Guide | I · G · Order Guide |
| Item Catalog | I · D · Item Catalog |
| Price Sheets | I · B · Manual Ingestion; shared processing |
| Invoices | I · B · Manual Ingestion; II · A · Invoice Matching |
| Inbox | I · A · Task 1 · Email Routing |
| Vendor Connect | I · A · Task 2 · Vendor Integration |
| Admin | Account, team, vendor administration and cross-module settings |
| Vendor Details | Vendor context for pricing, source documents and history |

Pages are client screens, not additional Divisions or Modules. Existing task
numbers and progress keys are retained. The Library outline, map and task list
carry this same directory.

Vendor Connect adds the matching Welcome tile and top navigation destination,
restricted to owners/managers just like Inbox and Admin. The page explicitly
states account setup is coming soon. It collects no credentials, makes no
connection/status query and does not claim any supplier is connected.

The existing approved HTTPS export adapter has controlled hosted acceptance
(see `a2_hosted_pull_verification.md`). Real supplier login/export and interactive
MOXe access remain unverified. This UI change does not modify workers, schemas,
secrets, schedules, orders or ingestion behavior. Publication and signed-in
acceptance remain open for review before deployment.
