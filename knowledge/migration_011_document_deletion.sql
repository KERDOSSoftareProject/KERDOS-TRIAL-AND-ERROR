-- Delete one organization's source document and its dependent history together.
-- Current quotes from a deleted price sheet become unavailable. Associations,
-- accepted descriptions, pack sizes and prices from other sheets are retained.
create or replace function public.kerdos_delete_price_sheet(p_organization_id uuid,p_document_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_doc public.import_documents%rowtype;
  v_quotes integer;
begin
  if auth.uid() is null or not exists (
    select 1 from public.organization_members m
    where m.organization_id=p_organization_id and m.user_id=auth.uid()
      and m.role in ('owner','manager')
  ) then raise exception 'Owner or manager access is required for this organization'; end if;
  select * into v_doc from public.import_documents
  where id=p_document_id and organization_id=p_organization_id and document_kind='pricelist'
  for update;
  if not found then raise exception 'Price sheet not found for this organization'; end if;

  update public.vendor_items set price=null,price_unavailable=true,
    price_quote_valid_until=null,price_expired_at=null
  where organization_id=p_organization_id and price_source='price_list'
    and (import_row->>'sourceDocumentId')=p_document_id::text;

  delete from public.price_history
  where organization_id=p_organization_id and source_document_id=p_document_id;
  get diagnostics v_quotes=row_count;
  delete from public.import_documents
  where id=p_document_id and organization_id=p_organization_id;

  return jsonb_build_object('file_path',v_doc.file_path,'removed_quotes',v_quotes);
end;
$$;
revoke all on function public.kerdos_delete_price_sheet(uuid,uuid) from public;
grant execute on function public.kerdos_delete_price_sheet(uuid,uuid) to authenticated;

create or replace function public.kerdos_delete_invoice_record(p_organization_id uuid,p_invoice_id uuid)
returns jsonb language plpgsql security definer set search_path=pg_catalog as $$
declare
  v_invoice public.invoices%rowtype;
begin
  if auth.uid() is null or not exists (
    select 1 from public.organization_members m
    where m.organization_id=p_organization_id and m.user_id=auth.uid()
      and m.role in ('owner','manager')
  ) then raise exception 'Owner or manager access is required for this organization'; end if;
  select * into v_invoice from public.invoices
  where id=p_invoice_id and organization_id=p_organization_id for update;
  if not found then raise exception 'Invoice not found for this organization'; end if;
  delete from public.invoice_lines where invoice_id=p_invoice_id;
  delete from public.invoices where id=p_invoice_id and organization_id=p_organization_id;
  return jsonb_build_object('file_path',v_invoice.file_path);
end;
$$;
revoke all on function public.kerdos_delete_invoice_record(uuid,uuid) from public;
grant execute on function public.kerdos_delete_invoice_record(uuid,uuid) to authenticated;
