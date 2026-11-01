-- Read-only invoice-wide evidence; one statement, no client row-limit truncation.
create or replace function public.kerdos_review_invoice_reconciliation(p_organization_id uuid,p_invoice_id uuid)
returns jsonb language plpgsql security invoker set search_path=public as $$
declare result jsonb;
begin
 if (select auth.uid()) is null or not exists(select 1 from public.organization_members where organization_id=p_organization_id and user_id=(select auth.uid())) then raise exception 'Organization membership is required';end if;
 select jsonb_build_object('kind','invoice_reconciliation_source','version',1,'organizationId',i.organization_id,'invoiceId',i.id,
 'header',jsonb_build_object('id',i.id,'organizationId',i.organization_id,'vendorId',i.vendor_id,'invoiceNumber',i.invoice_number,'invoiceDate',i.invoice_date,'recordedTotal',i.total_amount,'rawText',i.raw_text,'fileName',i.file_name,'filePath',i.file_path),
 'lines',(select coalesce(jsonb_agg(jsonb_build_object('id',il.id,'invoiceId',il.invoice_id,'vendorItemId',il.vendor_item_id,'description',il.description,'quantity',il.quantity,'unitPrice',il.unit_price,'amount',il.line_total,'sellingUnit',il.selling_unit,'sourceLine',il.source_line) order by il.id),'[]') from public.invoice_lines il where il.invoice_id=i.id),
 'receipts',(select coalesce(jsonb_agg(r.snapshot order by r.created_at,r.id),'[]') from public.estimated_order_receipts r where r.organization_id=p_organization_id and r.invoice_id=i.id),
 'reversals',(select coalesce(jsonb_agg(v.snapshot order by v.created_at,v.id),'[]') from public.estimated_receipt_reversals v join public.estimated_order_receipts r on r.id=v.receipt_id where v.organization_id=p_organization_id and r.invoice_id=i.id)) into result
 from public.invoices i where i.id=p_invoice_id and i.organization_id=p_organization_id;
 if result is null then raise exception 'Invoice is outside this organization';end if;
 return result;
end;
$$;
revoke all on function public.kerdos_review_invoice_reconciliation(uuid,uuid) from public,anon,service_role;
grant execute on function public.kerdos_review_invoice_reconciliation(uuid,uuid) to authenticated;
