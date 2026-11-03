// Read-only projection of the comparison saved with each invoice line.
// Never reconstructs quote evidence from a current price or a recorded variance.
const finite=value=>value!=null&&String(value).trim()!==''&&Number.isFinite(Number(value));
const round=value=>Math.round((value+Number.EPSILON)*100)/100;
export const comparisonReasonLabels={
  no_eligible_quote:'No eligible quote',lookup_error:'Quote lookup failed',quote_expired:'Quote expired',
  source_ineligible:'Source does not support comparison',unknown_billed_unit:'Billed unit is unknown',
  basis_incompatible:'Quote and invoice units cannot be compared',client_window_exceeded:'Outside the client refresh window',invalid_rate:'Price is missing or invalid',
};
export function quoteEvidenceLabel(item){
  if(item.quotedPrice==null)return 'Quote evidence unavailable';
  if(item.quotedSource==='manual_edit')return 'Manual price edit';
  return item.sourceDocument?.file_name||(item.sourceDocumentId?'Price sheet document unavailable':'Price sheet reference unavailable');
}
export function buildVarianceReport(invoices=[],vendors=[],{from='',to=''}={}){
  const group=(id,name)=>({vendorId:id,vendorName:name,items:[],lines:[],invoicesCompared:[],comparedLineCount:0,uncomparedLineCount:0,missingEvidenceCount:0});
  const groups=new Map(vendors.map(v=>[v.id,group(v.id,v.name)]));
  const selected=invoices.filter(i=>{const d=String(i.invoice_date||'').slice(0,10);return (!from||d&&d>=from)&&(!to||d&&d<=to);});
  const dates=selected.map(i=>String(i.invoice_date||'').slice(0,10)).filter(Boolean).sort(),lines=[];
  for(const invoice of selected){
    if(!groups.has(invoice.vendor_id))groups.set(invoice.vendor_id,group(invoice.vendor_id,invoice.vendors?.name||'Vendor unavailable'));
    const g=groups.get(invoice.vendor_id);let compared=false;
    for(const [index,line] of (invoice.invoice_lines||[]).entries()){
      const performed=!line.quoted_comparison_note&&finite(line.price_variance);
      const difference=performed?Number(line.price_variance):null;
      const quantity=finite(line.quantity)&&Number(line.quantity)>=0?Number(line.quantity):null;
      const variance=performed&&Math.abs(difference)>=0.005;
      const item={id:line.id||`${invoice.id}:${index}`,date:invoice.invoice_date||'',vendorName:g.vendorName,
        invoiceId:invoice.id,invoiceNumber:invoice.invoice_number||'',invoiceFile:invoice.file_name||'',
        description:line.description||'',performed,variance,
        status:performed?(variance?(difference>0?'Overcharge':'Undercharge'):'Compared: zero variance'):'Not compared',
        reason:performed?'':comparisonReasonLabels[line.quoted_comparison_note]||'No recorded comparison',
        quotedPrice:finite(line.quoted_rate)?Number(line.quoted_rate):null,
        chargedPrice:finite(line.unit_price)?Number(line.unit_price):null,difference,quantity,
        impact:performed&&quantity!=null?round(difference*quantity):null,
        billedUnit:line.selling_unit||'',quotedDate:line.quoted_effective_date||'',
        quotedSource:line.quoted_source||'',quotedSourceRate:finite(line.quoted_source_rate)?Number(line.quoted_source_rate):null,
        quotedBasis:line.quoted_basis||'',quotedUnit:line.quoted_basis==='measure'?(line.quoted_history?.selling_unit||''):(line.quoted_basis||''),quoteHistoryId:line.quoted_price_history_id||'',sourceDocumentId:line.quoted_source_document_id||'',
        sourceDocument:line.quoted_document||null,sourceRow:line.quoted_history?.source_line||'',
      };
      if(performed){g.comparedLineCount++;compared=true;if(item.quotedPrice==null)g.missingEvidenceCount++;}
      else g.uncomparedLineCount++;
      if(variance)g.items.push(item);
      g.lines.push(item);lines.push(item);
    }
    if(compared)g.invoicesCompared.push({id:invoice.id,number:invoice.invoice_number||'',fileName:invoice.file_name||'',date:invoice.invoice_date||''});
  }
  return {vendors:[...groups.values()],lines,invoices:selected,period:{from:from||dates[0]||'',to:to||dates.at(-1)||''}};
}
const escape=value=>{const s=String(value??'');return /[",\n\r]/.test(s)?'"'+s.replaceAll('"','""')+'"':s;};
export function buildComparisonReportCSV(report){
  const rows=[['Period From','Period To','Vendor','Invoice Date','Invoice #','Invoice File','Item','Result','Reason','Compared Quote Rate','Billed Unit','Charged Rate','Rate Difference','Billed Quantity','Line Impact','Quote Date','Quote Source','Original Quote Rate','Original Quote Basis','Original Quote Unit','Quote Row ID','Price Sheet ID','Price Sheet File','Source Row']];
  for(const vendor of report.vendors){
    if(!vendor.lines.length)rows.push([report.period.from,report.period.to,vendor.vendorName,'','','','','No completed comparisons',...Array(16).fill('')]);
    for(const l of vendor.lines)rows.push([report.period.from,report.period.to,vendor.vendorName,l.date,l.invoiceNumber,l.invoiceFile,l.description,l.status,l.reason||(!l.quotedPrice&&l.quotedPrice!==0?'Quote evidence unavailable':''),l.quotedPrice,l.billedUnit,l.chargedPrice,l.difference,l.quantity,l.impact,l.quotedDate,l.quotedSource,l.quotedSourceRate,l.quotedBasis,l.quotedUnit,l.quoteHistoryId,l.sourceDocumentId,l.sourceDocument?.file_name||'',l.sourceRow]);
  }
  return rows.map(row=>row.map(escape).join(',')).join('\r\n');
}
