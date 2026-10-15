// Recorded invoices, history and purchase orders. These are business records;
// provider syntax stays behind this boundary.
async function run(promise,operation){const {data,error}=await promise;if(error)throw new Error(`${operation}: ${error.message}`);return data;}

export function createOperationsService(backend){
  const table=backend.records.query;
  return {
    updateInvoice(invoiceId,patch){return run(table("invoices").update(patch).eq("id",invoiceId),"Could not update the invoice");},
    deleteInvoice(organizationId,invoiceId){return backend.documents.deleteInvoiceRecord(organizationId,invoiceId);},
    deletePriceSheet(organizationId,documentId){return backend.documents.deletePriceSheet(organizationId,documentId);},
    olderPriceHistory(organizationId,offset,limit=2000){
      return run(table("price_history").select("*").eq("organization_id",organizationId).order("effective_date",{ascending:false}).order("id",{ascending:false}).range(offset,offset+limit-1),"Could not load earlier price sheets");
    },
    async submitOrder({organizationId,userId,basket}){
      if(!backend.orders?.submit)throw new Error("This provider must support atomic order recording");
      const lines=basket.items.map(item=>({
        catalog_item_id:item.catalogItemId.replace(/_(?:split_)?(?:case|each)$/, ""),
        vendor_item_id:item.vendorItemId,quantity:item.quantity,unit_price:item.price,
        line_total:item.lineTotal,order_unit:item.orderUnit,pack_size:item.packSize||null,
      }));
      return backend.orders.submit({p_organization_id:organizationId,p_vendor_id:basket.vendorId,
        p_created_by:userId,p_total_amount:basket.dollar,p_notes:basket.notes||null,p_lines:lines});
    },
  };
}
