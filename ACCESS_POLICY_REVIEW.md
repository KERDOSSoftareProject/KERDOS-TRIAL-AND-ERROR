# KERDOS access policy — local review, not deployed

Decision (23 September 2026): employees may browse the order guide and catalog, see vendor prices, and prepare orders. Only managers and owners may import invoices or price sheets, change vendor pricing, edit catalog items or mappings, and change team or organization settings.

The current UI now hides employee invoice import/edit/delete and catalog edit controls. This is usability protection, not a security boundary. The database must enforce this policy for every table and storage object. The uploaded project includes migrations 003–007, but not the base schema or its complete policies, so this copy cannot establish the effective live permissions. In particular, the handoff reports an older `user_has_role()` recognizing `owner`/`member` and permissive organization and invitation policies. Do not apply a guessed replacement policy to production.

Before deployment, inspect actual definitions of `organization_members`, `organizations`, `catalog_items`, `item_mappings`, `vendors`, `vendor_items`, `price_history`, `invoices`, `invoice_lines`, `import_documents`, `purchase_orders`, `purchase_order_lines`, `invite_codes`, `profiles`, and the `documents` storage bucket. For every organization-owned row, require membership for reads and owner/manager for catalog, vendor, document, invoice, price, team and setting writes. Employees need only the narrowly scoped order write operation. Check `WITH CHECK` on inserts and updates and preserve owner creation and invitation acceptance flows. Add provider-neutral permission scenarios plus real Supabase tests with separate owner, manager, employee, and nonmember accounts on a staging database. Verify that direct API calls, not just hidden buttons, fail for forbidden writes and cross-organization reads.

Read-only policy inventory to run on a staging database:

```sql
select schemaname, tablename, policyname, cmd, roles, qual, with_check
from pg_policies
where schemaname in ('public', 'storage')
order by schemaname, tablename, policyname;

select n.nspname as schema_name, c.relname as table_name,
       c.relrowsecurity as rls_enabled, c.relforcerowsecurity as rls_forced
from pg_class c join pg_namespace n on n.oid=c.relnamespace
where n.nspname in ('public','storage') and c.relkind in ('r','p')
order by 1,2;
```

No live database policy was modified or certified during this review.
