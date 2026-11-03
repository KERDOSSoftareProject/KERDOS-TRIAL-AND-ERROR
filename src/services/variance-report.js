export function createVarianceReportService(backend){
  const read=async query=>{const {data,error}=await query;if(error)throw new Error(error.message||'Could not load invoice comparisons.');return data||[];};
  async function related(table,columns,organizationId,ids){
    const rows=[];for(let offset=0;offset<ids.length;offset+=100)rows.push(...await read(backend.records.query(table).select(columns).eq('organization_id',organizationId).in('id',ids.slice(offset,offset+100))));return rows;
  }
  return {async invoices(organizationId){
    if(!organizationId)throw new Error('A client is required to load the report.');
    const found=new Map();
    for(let offset=0;;offset+=200){
      const page=await read(backend.records.query('invoices').select('*,vendors(name),invoice_lines(*)')
        .eq('organization_id',organizationId).order('invoice_date',{ascending:false}).order('id',{ascending:false}).range(offset,offset+199));
      const before=found.size;
      for(const invoice of page){if(invoice.organization_id!==organizationId)throw new Error('Invoice report returned another client’s record.');found.set(invoice.id,invoice);}
      if(page.length<200)break;
      if(found.size===before)throw new Error('Earlier invoice comparisons could not be loaded.');
    }
    const invoices=[...found.values()],lines=invoices.flatMap(i=>i.invoice_lines||[]);
    const docIds=[...new Set(lines.map(l=>l.quoted_source_document_id).filter(Boolean))];
    const historyIds=[...new Set(lines.map(l=>l.quoted_price_history_id).filter(Boolean))];
    const docs=new Map((await related('import_documents','id,organization_id,vendor_id,file_name,file_path,document_kind',organizationId,docIds)).map(d=>[d.id,d]));
    const history=new Map((await related('price_history','id,organization_id,vendor_item_id,source_document_id,source_line,selling_unit',organizationId,historyIds)).map(h=>[h.id,h]));
    return invoices.map(i=>({...i,invoice_lines:(i.invoice_lines||[]).map(l=>{
      const d=docs.get(l.quoted_source_document_id),h=history.get(l.quoted_price_history_id);
      if(d&&(d.organization_id!==organizationId||d.vendor_id!==i.vendor_id)||h&&(h.organization_id!==organizationId||h.vendor_item_id!==l.vendor_item_id||h.source_document_id!==l.quoted_source_document_id))throw new Error('Quote evidence does not belong to this client and vendor listing.');
      return {...l,quoted_document:d||null,quoted_history:h||null};
    })}));
  }};
}
