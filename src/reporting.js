import {blockReason,orderable} from "./core/ordering.js";
import {formatMoney} from "./localization.js";

function csvEscape(value){const text=String(value??"");return /[",\n\r]/.test(text)?`"${text.replace(/"/g,'""')}"`:text;}
function rowsToCSV(rows){return rows.map(row=>row.map(csvEscape).join(",")).join("\r\n");}

export function downloadTextFile(filename,content,mimeType){
  const url=URL.createObjectURL(new Blob([content],{type:`${mimeType};charset=utf-8;`}));
  const anchor=document.createElement("a");anchor.href=url;anchor.download=filename;
  document.body.appendChild(anchor);anchor.click();anchor.remove();URL.revokeObjectURL(url);
}

export function buildCatalogExportCSV(productList,vendors){
  const rows=[["Item","Category","Best Price","Best Vendor","Best Per Unit","Status","Confidence",...vendors.map(vendor=>vendor.name)]];
  for(const item of productList){
    const cheapest=item.options.filter(orderable)[0]||item.options[0]||null;
    let status="No price on file",confidence="";
    if(cheapest){if(!orderable(cheapest))status=blockReason(cheapest);else if(cheapest.matchTrack==="similar"){status="Needs review";confidence=`${cheapest.matchConfidence}%`;}else status="100% matched";}
    const vendorCells=vendors.map(vendor=>{const option=item.options.find(candidate=>candidate.vendorId===vendor.id);return option?.casePrice?formatMoney(option.casePrice):"";});
    const best=cheapest&&orderable(cheapest)?cheapest:null;
    rows.push([item.name,item.category,best?formatMoney(best.casePrice):"",best?best.vendorName:"",best?.perUnit?`${formatMoney(best.perUnit.price)}/${best.perUnit.unit}`:"",status,confidence,...vendorCells]);
  }
  return rowsToCSV(rows);
}

export function buildVarianceReport(invoices,vendors,{from="",to=""}={}){
  const makeGroup=(id,name)=>({vendorId:id,vendorName:name,items:[],invoicesCompared:[],comparedLineCount:0,uncomparedLineCount:0});
  const groups=new Map(vendors.map(vendor=>[vendor.id,makeGroup(vendor.id,vendor.name)]));
  const selected=invoices.filter(invoice=>{const date=String(invoice.invoice_date||"").slice(0,10);return (!from||date&&date>=from)&&(!to||date&&date<=to);});
  const dates=selected.map(invoice=>String(invoice.invoice_date||"").slice(0,10)).filter(Boolean).sort();
  const lines=[];
  for(const invoice of selected){
    if(!groups.has(invoice.vendor_id))groups.set(invoice.vendor_id,makeGroup(invoice.vendor_id,invoice.vendors?.name||"Vendor unavailable"));
    const group=groups.get(invoice.vendor_id);
    let compared=false;
    for(const [index,line] of (invoice.invoice_lines||[]).entries()){
    if(line.price_variance==null||!Number.isFinite(Number(line.price_variance))){group.uncomparedLineCount++;continue;}
    group.comparedLineCount++;compared=true;
    if(Math.abs(line.price_variance)<0.005)continue;
    const impact=line.price_variance*(line.line_total&&line.unit_price?line.line_total/line.unit_price:1);
    const item={id:`${invoice.id||lines.length}:${index}`,date:invoice.invoice_date||"",vendorName:group.vendorName,invoiceNumber:invoice.invoice_number||"",description:line.description,quotedPrice:line.unit_price-line.price_variance,chargedPrice:line.unit_price,difference:Number(line.price_variance),impact:Math.round(impact*100)/100};
    group.items.push(item);lines.push(item);
    }
    if(compared)group.invoicesCompared.push({id:invoice.id,number:invoice.invoice_number||"",fileName:invoice.file_name||"",date:invoice.invoice_date||""});
  }
  return {vendors:[...groups.values()],lines,invoices:selected,period:{from:from||dates[0]||"",to:to||dates.at(-1)||""}};
}

export function buildVarianceReportCSV(invoices,vendors){
  const report=buildVarianceReport(invoices,vendors);
  const rows=[["Date","Vendor","Invoice #","Item","Quoted Price","Charged Price","Difference","Line Total Impact"]];
  for(const item of report.lines)rows.push([item.date,item.vendorName,item.invoiceNumber,item.description,formatMoney(item.quotedPrice),formatMoney(item.chargedPrice),formatMoney(item.difference),formatMoney(item.impact)]);
  if(!report.lines.length)for(const vendor of report.vendors)rows.push(["",vendor.vendorName,"","0 variances found","","","",""]);
  return rowsToCSV(rows);
}
