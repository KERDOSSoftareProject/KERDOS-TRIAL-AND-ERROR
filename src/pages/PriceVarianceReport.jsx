import {useEffect,useMemo,useState} from 'react';
import {MovableDialog} from '../ui/MovableDialog.jsx';
import {buildVarianceReport,quoteEvidenceLabel} from '../core/variance-report.js';
import {formatDate,formatMoney} from '../localization.js';
import {backend} from '../backend/index.js';
import {createVarianceReportService} from '../services/variance-report.js';
const reportService=createVarianceReportService(backend);
const action={border:'1px solid #CCD9EC',borderRadius:8,padding:'9px 14px',background:'#003584',color:'white',fontFamily:'inherit',fontWeight:700,cursor:'pointer'};
const cell={padding:'9px 10px',borderBottom:'1px solid #E4EAF1',textAlign:'left',verticalAlign:'top'};
const money=value=>value==null?'Unavailable':formatMoney(value);
export default function PriceVarianceReport({orgId,invoices=[],vendors,onClose,onExport,onViewOriginal,onViewSource,service=reportService}){
  const [from,setFrom]=useState(''),[to,setTo]=useState(''),[retry,setRetry]=useState(0);
  const [state,setState]=useState({orgId:null,invoices:[],error:''});
  useEffect(()=>{
    if(!orgId)return;
    let active=true;setState({orgId:null,invoices:[],error:''});
    service.invoices(orgId).then(rows=>{if(active)setState({orgId,invoices:rows,error:''});}).catch(error=>{if(active)setState({orgId,invoices:[],error:error.message});});
    return ()=>{active=false;};
  },[orgId,service,retry]);
  const loading=!!orgId&&state.orgId!==orgId,error=orgId&&state.orgId===orgId?state.error:'';
  const source=orgId?(state.orgId===orgId?state.invoices:[]):invoices;
  const report=useMemo(()=>buildVarianceReport(source,vendors,{from,to}),[source,vendors,from,to]);
  const invalid=!!(from&&to&&from>to);
  const period=report.period.from&&report.period.to?`${formatDate(report.period.from)} – ${formatDate(report.period.to)}`:'All recorded dates';
  return <MovableDialog label="Price Variance Report" maxWidth={1100}>
    <div style={{background:'white',color:'#17243A',padding:22}} onKeyDown={e=>{if(e.key==='Escape')onClose();}}>
      <div role="region" aria-label="Price Variance Report controls" style={{position:'sticky',top:0,zIndex:1,background:'white',paddingBottom:12}}>
        <div style={{display:'flex',justifyContent:'space-between',alignItems:'center',gap:12,flexWrap:'wrap',marginBottom:14}}>
          <h2 style={{margin:0,fontSize:22,color:'#003584'}}>Price Variance Report</h2>
          <div style={{display:'flex',gap:8}}><button type="button" style={action} disabled={loading||invalid||!!error} onClick={()=>onExport({report,invoices:report.invoices,vendors})}>Download CSV</button><button type="button" style={{...action,background:'#E8F0FA',color:'#003584'}} onClick={onClose}>Close</button></div>
        </div>
        <div style={{display:'flex',gap:14,flexWrap:'wrap'}}>
          <label>From <input type="date" aria-label="Report from date" value={from} onChange={e=>setFrom(e.target.value)}/></label>
          <label>To <input type="date" aria-label="Report to date" value={to} onChange={e=>setTo(e.target.value)}/></label>
        </div>
      </div>
      {invalid?<p role="alert">Choose an end date on or after the start date.</p>:loading?<p role="status">Loading invoice comparisons…</p>:error?<div role="alert">{error} <button style={action} onClick={()=>setRetry(n=>n+1)}>Retry</button></div>:<>
        <p style={{fontSize:13,color:'#64748B'}}>Report period: {period}. Compared rates use the invoice’s billed unit. A missing comparison is not a confirmed price match.</p>
        {!report.vendors.length&&<p>No vendors are set up for this client.</p>}
        {report.vendors.map(vendor=><section key={vendor.vendorId||'unavailable'} aria-label={`${vendor.vendorName} variance results`} style={{border:'1px solid #DCE6F4',borderRadius:10,marginBottom:12,overflow:'hidden'}}>
          <div style={{display:'flex',justifyContent:'space-between',gap:12,flexWrap:'wrap',padding:'13px 15px',background:'#E8F0FA',color:'#003584'}}><strong>{vendor.vendorName}</strong><span>{vendor.comparedLineCount?`${vendor.items.length} ${vendor.items.length===1?'variance':'variances'} found`:'No completed comparisons'}</span></div>
          <div style={{padding:'10px 15px',fontSize:12,lineHeight:1.6}}>
            <div>Period: {period}</div><div>Invoices compared: {vendor.invoicesCompared.length} · Lines compared: {vendor.comparedLineCount}</div>
            {vendor.invoicesCompared.length>0&&<ul>{vendor.invoicesCompared.map((invoice,index)=><li key={invoice.id||index}>{invoice.number?`Invoice #${invoice.number}`:invoice.fileName||'Invoice number not recorded'} · {invoice.date?formatDate(invoice.date):'Date not recorded'}{invoice.number&&invoice.fileName?` · ${invoice.fileName}`:''}</li>)}</ul>}
            {vendor.uncomparedLineCount>0&&<div>{vendor.uncomparedLineCount} invoice {vendor.uncomparedLineCount===1?'line has':'lines have'} no completed comparison. Reasons are shown below.</div>}
            {vendor.missingEvidenceCount>0&&<div>{vendor.missingEvidenceCount} recorded {vendor.missingEvidenceCount===1?'comparison lacks':'comparisons lack'} its original quote evidence.</div>}
            {!vendor.lines.length&&<div>No invoice lines in this period.</div>}
          </div>
          {!!vendor.lines.length&&<div style={{overflowX:'auto'}}><table className="mobile-edit-table" role="table" aria-label="Invoice line comparisons" style={{borderCollapse:'collapse',width:'100%',fontSize:12}}>
            <thead><tr>{['Invoice / date','Item','Result','Compared quote','Charged','Rate difference','Billed quantity','Line impact','Quote evidence'].map(label=><th key={label} style={cell}>{label}</th>)}</tr></thead>
            <tbody role="rowgroup">{vendor.lines.map(item=><tr role="row" key={item.id}>
              <td role="cell" data-field-label="Invoice / date" style={cell}>{item.invoiceNumber||item.invoiceFile||'Number unavailable'}{item.invoiceNumber&&item.invoiceFile&&<div>{item.invoiceFile}</div>}<br/>{formatDate(item.date)}</td><td role="cell" data-field-label="Item" data-mobile-wide style={cell}>{item.description}</td>
              <td role="cell" data-field-label="Result" style={cell}>{item.status}{item.reason&&<div>{item.reason}</div>}</td>
              <td role="cell" data-field-label="Compared quote" style={cell}>{money(item.quotedPrice)}{item.quotedPrice!=null&&item.billedUnit&&` / ${item.billedUnit}`}</td>
              <td role="cell" data-field-label="Charged" style={cell}>{money(item.chargedPrice)}{item.billedUnit&&` / ${item.billedUnit}`}</td>
              <td role="cell" data-field-label="Rate difference" style={cell}>{money(item.difference)}</td><td role="cell" data-field-label="Billed quantity" style={cell}>{item.quantity==null?'Unavailable':item.quantity}</td><td role="cell" data-field-label="Line impact" style={cell}>{money(item.impact)}</td>
              <td role="cell" data-field-label="Quote evidence" data-mobile-wide style={cell}>{quoteEvidenceLabel(item)}{item.quotedSourceRate!=null&&<div>Original quote: {money(item.quotedSourceRate)} / {item.quotedUnit||'unit unavailable'}</div>}{item.quotedDate&&<div>Quote date: {formatDate(item.quotedDate)}</div>}
                {item.sourceRow&&<div>Source row: {item.sourceRow}</div>}
                {item.sourceDocument?.file_path&&onViewOriginal&&<button type="button" style={{...action,fontSize:11,padding:'5px 8px'}} onClick={()=>onViewOriginal(item.sourceDocument.file_path)}>Open price sheet</button>}
                {item.sourceDocument&&!item.sourceDocument.file_path&&onViewSource&&<button type="button" style={{...action,fontSize:11,padding:'5px 8px'}} onClick={()=>onViewSource(item.sourceDocumentId)}>Open price sheet source</button>}
              </td>
            </tr>)}</tbody>
          </table></div>}
        </section>)}
      </>}
    </div>
  </MovableDialog>;
}
