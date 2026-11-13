# Catalog product label backfill

Apply the catalog product label migration before running the backfill. From a trusted terminal, set `SUPABASE_URL` and `SUPABASE_SERVICE_ROLE_KEY` for the intended project. Run the script once per organization whose existing catalog should be labelled.

```sh
node scripts/backfill-product-labels.mjs ORGANIZATION_UUID
node scripts/backfill-product-labels.mjs ORGANIZATION_UUID --apply
```

The first command reports how many unlabelled items the shared product reader can identify. The second stamps the key and timestamp on eligible items whose name still matches the name used to derive the key. It skips merged, retired, provisional, and unresolved review items. A row also needs a valid existing category and number range before the backfill can stamp it. These guards keep lifecycle and item-number triggers from altering existing catalog state.

Existing labels, item names, KERDOS numbers, and vendor assignments are preserved. Multiple items may retain the same label. A repeated run can safely finish a partially completed backfill.
