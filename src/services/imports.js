// Persistence helpers for the import workflow. Parsing and matching remain
// pure/core concerns; provider queries are contained here.
async function run(promise,operation){const {data,error}=await promise;if(error)throw new Error(`${operation}: ${error.message}`);return data;}

export function createImportService(backend){
  const table=backend.records.query;
  return {
    findPriceDocument({organizationId,vendorId,fingerprint}){return run(table("import_documents").select("id,status,completed_keys").eq("organization_id",organizationId).eq("vendor_id",vendorId).eq("document_kind","pricelist").eq("fingerprint",fingerprint).maybeSingle(),"Could not verify whether the file was already imported");},
    createPriceDocument(row){return run(table("import_documents").insert(row).select("id").single(),"Could not preserve the source document");},
    async resumeSources(organizationId,vendorId,documentId){
      const quotes=[];
      for(let offset=0;;offset+=500){
        const batch=await run(table("price_history").select("source_row_key,source_line")
          .eq("organization_id",organizationId).eq("source_document_id",documentId).order("id").range(offset,offset+499),"Could not verify saved import rows");
        quotes.push(...batch);if(batch.length<500)break;
      }
      const listings=await this.vendorItems(organizationId,vendorId);
      return [...quotes.map(quote=>({key:quote.source_row_key,sourceLine:quote.source_line})),
        ...listings.filter(listing=>listing.import_row?.sourceDocumentId===documentId)
          .map(listing=>({key:listing.import_row.rowKey,sourceLine:listing.import_row.row?.sourceLine}))];
    },
    finalizeDocument(documentId,status,completedKeys){return run(table("import_documents").update(completedKeys?{status,completed_keys:completedKeys}:{status}).eq("id",documentId),"Could not finalize the source record");},
    // Progress is written as rows complete, so an interrupted import can
    // pick up where it stopped instead of starting over.
    recordProgress(documentId,completedKeys){return run(table("import_documents").update({completed_keys:completedKeys,status:"processing"}).eq("id",documentId),"Could not record import progress");},
    findVendorItem({organizationId,vendorId,code}){
      return run(table("vendor_items").select("*").eq("organization_id",organizationId)
        .eq("vendor_id",vendorId).eq("vendor_item_code",code).maybeSingle(),"Could not look up the item");
    },
    vendorItemById(organizationId,vendorId,itemId){return run(table("vendor_items").select("*")
      .eq("organization_id",organizationId).eq("vendor_id",vendorId).eq("id",itemId).maybeSingle(),"Could not inspect the selected vendor listing");},
    async vendorItems(organizationId,vendorId){
      const listings=[];
      for(let offset=0;;offset+=500){
        const batch=await run(table("vendor_items").select("*").eq("organization_id",organizationId).eq("vendor_id",vendorId)
          .order("id").range(offset,offset+499),"Could not inspect existing vendor products");
        listings.push(...batch);if(batch.length<500)break;
      }
      return listings;
    },
    mapping(organizationId,vendorItemId){return run(table("item_mappings").select("*").eq("organization_id",organizationId).eq("vendor_item_id",vendorItemId).maybeSingle(),"Could not check the catalog link");},
    createMapping(row){return run(table("item_mappings").insert(row).select("id").single(),"Could not link the item to your catalog");},
    async invoiceSources(organizationId,vendorId){
      const invoices=[];
      for(let start=0;;start+=100){
        const batch=await run(table("invoices").select("id,invoice_number,invoice_date,raw_text")
          .eq("organization_id",organizationId).eq("vendor_id",vendorId)
          .order("invoice_date",{ascending:false}).range(start,start+99),"Could not load prior invoices for comparison");
        invoices.push(...batch);
        if(batch.length<100)break;
      }
      return invoices;
    },
    async duplicateInvoice({organizationId,vendorId,invoiceNumber,rawText}){
      let query=table("invoices").select("id").eq("organization_id",organizationId).eq("vendor_id",vendorId);
      query=invoiceNumber?query.eq("invoice_number",invoiceNumber):query.eq("raw_text",rawText);
      const rows=await run(query.limit(1),"Could not check existing invoice");
      return !!rows?.length;
    },
    async historicalQuote({organizationId,vendorItemId,invoiceDate}){
      const rows=await run(table("price_history").select("price,effective_date,quote_valid_until,source,price_basis,selling_unit").eq("organization_id",organizationId).eq("vendor_item_id",vendorItemId).lte("effective_date",`${invoiceDate}T23:59:59.999Z`).order("effective_date",{ascending:false}).limit(1),"Unable to verify historic quote");
      return rows?.[0]||null;
    },
  };
}
