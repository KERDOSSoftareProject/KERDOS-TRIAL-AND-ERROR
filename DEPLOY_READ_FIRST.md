# KERDOS — vendor NVIM build

This package contains the complete app source. NVIM is assigned only to vendor listings without a vendor supplied item number. The shared KERDOS item number remains separate.

1. In the existing Supabase project's SQL Editor, run only `knowledge/migration_012_vendor_nvim.sql` and confirm success. It backfills NVIM only for existing listings without vendor codes and allocates future numbers per organization and vendor. It does not clear data.
2. Unzip the package. Upload its contents (files and folders, not the ZIP) into the root of the existing GitHub repository on `main`.
3. Wait for `Deploy KERDOS Preview` to turn green, then refresh the app.
4. On Price Sheets, select a file. The row review opens automatically; review and save the rows deliberately. The vendor column shows a supplied vendor code when present, or NVIM for an unnumbered saved listing. On Invoices, select a file and confirm the date and flagged lines; the original invoice is retained when the invoice saves.

Item Catalog shows the supplied vendor code or NVIM in the vendor cell. Every import scans for new vendor items. The next price sheet can reuse an existing listing despite a price change or reordered rows. If an unnumbered row's product, pack or brand cannot identify exactly one saved listing, it waits for review. The vendor cell offers a manual selection of an existing NVIM, with the same identity checks.

Do not paste NVIM as a vendor item code or send it on the vendor purchase order. Invoice-only listings without vendor codes receive NVIM too, ready for a later matching price sheet. The test-client reset file is separate and must not be run as part of this deployment.

An interrupted import still cannot safely resume; keep the tab open until it completes.
