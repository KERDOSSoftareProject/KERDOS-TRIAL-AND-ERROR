-- Clears imported/test records ONLY for Hornet's Nest Deli, LLC.
-- Retains organization, vendors, users, categories, settings and vocabulary.
-- This removes catalog associations as part of starting the import test over.
-- Uploaded file bytes are not deleted; SQL cannot safely remove Storage files.
begin;
do $reset$
declare
  target_org constant uuid := 'cf97d202-3bc1-445f-ae4d-582ec1d1aa99';
begin
  if not exists (select 1 from public.organizations where id=target_org and slug='hornet-s-nest-deli-llc') then
    raise exception 'Expected test company was not found. Nothing cleared.';
  end if;
  delete from public.invoice_lines where invoice_id in (select id from public.invoices where organization_id=target_org);
  delete from public.purchase_order_lines where purchase_order_id in (select id from public.purchase_orders where organization_id=target_org);
  delete from public.invoices where organization_id=target_org;
  delete from public.purchase_orders where organization_id=target_org;
  delete from public.price_history where organization_id=target_org;
  delete from public.item_mappings where organization_id=target_org;
  delete from public.vendor_items where organization_id=target_org;
  delete from public.catalog_items where organization_id=target_org;
  delete from public.import_documents where organization_id=target_org;
  -- Keep NVIM counters: previously issued vendor numbers are never reused.
end;
$reset$;
commit;

select 'catalog_items' as kind,count(*) as count from public.catalog_items where organization_id='cf97d202-3bc1-445f-ae4d-582ec1d1aa99'
union all select 'vendor_items',count(*) from public.vendor_items where organization_id='cf97d202-3bc1-445f-ae4d-582ec1d1aa99'
union all select 'item_mappings',count(*) from public.item_mappings where organization_id='cf97d202-3bc1-445f-ae4d-582ec1d1aa99'
union all select 'import_documents',count(*) from public.import_documents where organization_id='cf97d202-3bc1-445f-ae4d-582ec1d1aa99'
union all select 'price_history',count(*) from public.price_history where organization_id='cf97d202-3bc1-445f-ae4d-582ec1d1aa99'
union all select 'invoices',count(*) from public.invoices where organization_id='cf97d202-3bc1-445f-ae4d-582ec1d1aa99'
union all select 'purchase_orders',count(*) from public.purchase_orders where organization_id='cf97d202-3bc1-445f-ae4d-582ec1d1aa99';
