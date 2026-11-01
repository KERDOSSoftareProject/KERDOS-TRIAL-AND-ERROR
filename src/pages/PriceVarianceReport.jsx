import {useEffect,useMemo,useState} from "react";
import {MovableDialog} from "../ui/MovableDialog.jsx";
import {buildVarianceReport} from "../reporting.js";
import {formatDate,formatMoney} from "../localization.js";
import {backend} from "../backend/index.js";
import {createVarianceReportService} from "../services/variance-report.js";

const reportService=createVarianceReportService(backend);
const action={border:"1px solid #CCD9EC",borderRadius:8,padding:"9px 14px",background:"#003584",color:"white",fontFamily:"inherit",fontWeight:700,cursor:"pointer"};
const cell={padding:"9px 10px",borderBottom:"1px solid #E4EAF1",textAlign:"left"};

export default function PriceVarianceReport({orgId,invoices,vendors,onClose,onExport,service=reportService}){
  const [from,setFrom]=useState(""),[to,setTo]=useState("");
  const [state,setState]=useState({orgId:null,invoices:[],error:""});
  const [retry,setRetry]=useState(0);
  useEffect(()=>{
    if(!orgId)return;
    let active=true;
    setState({orgId:null,invoices:[],error:""});
    service.invoices(orgId).then(rows=>{if(active)setState({orgId,invoices:rows,error:""});}).catch(error=>{if(active)setState({orgId,invoices:[],error:error.message});});
    return ()=>{active=false;};
  },[orgId,service,retry]);
  const loading=!!orgId&&state.orgId!==orgId;
  const source=orgId?state.orgId===orgId?state.invoices:[]:invoices;
  const report=useMemo(()=>buildVarianceReport(source,vendors,{from,to}),[source,vendors,from,to]);
  const invalid=!!(from&&to&&from>to);
  const error=orgId&&state.orgId===orgId?state.error:"";
  const period=report.period.from&&report.period.to?`${formatDate(report.period.from)} – ${formatDate(report.period.to)}`:"All recorded dates";
  return <MovableDialog label="Price Variance Report" maxWidth={1000}>
    <div style={{background:"white",color:"#17243A",padding:22}} onKeyDown={event=>{if(event.key==="Escape")onClose();}}>
      <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",gap:14,flexWrap:"wrap",marginBottom:14}}>
        <h2 style={{margin:0,fontSize:22,color:"#003584"}}>Price Variance Report</h2>
        <div style={{display:"flex",gap:8}}><button type="button" style={action} disabled={loading||invalid||!!error} onClick={()=>onExport({invoices:report.invoices,vendors})}>Download CSV</button><button type="button" style={{...action,background:"#E8F0FA",color:"#003584"}} onClick={onClose}>Close</button></div>
      </div>
      <div style={{display:"flex",gap:14,flexWrap:"wrap",marginBottom:12}}>
        <label>From <input type="date" aria-label="Report from date" value={from} onChange={event=>setFrom(event.target.value)} style={{padding:8,border:"1px solid #CCD9EC",borderRadius:6}}/></label>
        <label>To <input type="date" aria-label="Report to date" value={to} onChange={event=>setTo(event.target.value)} style={{padding:8,border:"1px solid #CCD9EC",borderRadius:6}}/></label>
      </div>
      {invalid?<p role="alert">Choose an end date on or after the start date.</p>:loading?<p role="status">Loading invoice comparisons…</p>:error?<div role="alert">{error} <button type="button" style={action} onClick={()=>setRetry(value=>value+1)}>Retry</button></div>:<>
      <p style={{fontSize:13,color:"#64748B",margin:"0 0 18px"}}>Report period: {period}. Results use recorded invoice comparisons. A missing comparison is not a confirmed price match.</p>
      {!report.vendors.length&&<p>No vendors are set up for this client.</p>}
      {report.vendors.map(vendor=><section key={vendor.vendorId||"unavailable"} aria-label={`${vendor.vendorName} variance results`} style={{border:"1px solid #DCE6F4",borderRadius:10,marginBottom:12,overflow:"hidden"}}>
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap",padding:"13px 15px",background:"#E8F0FA",color:"#003584"}}><strong>{vendor.vendorName}</strong><span>{vendor.items.length} {vendor.items.length===1?"variance":"variances"} found</span></div>
        <div style={{padding:"10px 15px",fontSize:12,lineHeight:1.6}}>
          <div>Period: {period}</div>
          <div>Invoices compared: {vendor.invoicesCompared.length}</div>
          {vendor.invoicesCompared.length>0?<>
            <ul style={{margin:"4px 0 8px",paddingLeft:20}}>{vendor.invoicesCompared.map((invoice,index)=><li key={invoice.id||index}>{invoice.number?`Invoice #${invoice.number}`:invoice.fileName||"Invoice number not recorded"} · {invoice.date?formatDate(invoice.date):"Date not recorded"}{invoice.number&&invoice.fileName?` · ${invoice.fileName}`:""}</li>)}</ul>
            <div>Price sheet compared: reference not recorded with the saved comparisons.</div>
          </>:<div>No completed invoice comparisons in this period.</div>}
          {vendor.uncomparedLineCount>0&&<div>{vendor.uncomparedLineCount} invoice {vendor.uncomparedLineCount===1?"line has":"lines have"} no recorded comparison.</div>}
        </div>
        {vendor.items.length>0&&<div style={{overflowX:"auto"}}><table style={{borderCollapse:"collapse",width:"100%",fontSize:12}}>
          <thead><tr>{["Date","Invoice #","Item","Quoted","Charged","Difference","Line impact"].map(label=><th key={label} style={cell}>{label}</th>)}</tr></thead>
          <tbody>{vendor.items.map(item=><tr key={item.id}><td style={cell}>{formatDate(item.date)}</td><td style={cell}>{item.invoiceNumber}</td><td style={cell}>{item.description}</td>{[item.quotedPrice,item.chargedPrice,item.difference,item.impact].map((value,index)=><td key={index} style={{...cell,whiteSpace:"nowrap"}}>{formatMoney(value)}</td>)}</tr>)}</tbody>
        </table></div>}
      </section>)}
      </>}
    </div>
  </MovableDialog>;
}
