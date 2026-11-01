export function createVarianceReportService(backend){
  return {
    async invoices(organizationId){
      const found=new Map();
      for(let offset=0;;offset+=200){
        const {data,error}=await backend.records.query("invoices").select("*,vendors(name),invoice_lines(*)")
          .eq("organization_id",organizationId).order("invoice_date",{ascending:false}).order("id",{ascending:false}).range(offset,offset+199);
        if(error)throw new Error(error.message||"Could not load invoice comparisons.");
        const page=data||[],before=found.size;
        for(const invoice of page)found.set(invoice.id,invoice);
        if(page.length<200)return [...found.values()];
        if(found.size===before)throw new Error("Earlier invoice comparisons could not be loaded.");
      }
    },
  };
}
