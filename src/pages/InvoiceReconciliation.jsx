import {useEffect,useRef,useState} from 'react';
import {backend} from '../backend/index.js';
import {createInvoiceReconciliationService} from '../services/invoice-reconciliation.js';
import {formatMoney} from '../localization.js';
const defaultService=createInvoiceReconciliationService(backend);
const money=cents=>cents==null?'Unknown':formatMoney(cents/100);
const labels={subtotal:'Printed subtotal',tax:'Tax',freight:'Freight / delivery',credits:'Credits / discounts',other:'Other stated charges',total:'Printed invoice total'};
export function InvoiceReconciliation({organizationId,invoiceId,service=defaultService,onClose}){
 const [review,setReview]=useState(null),[error,setError]=useState(''),[loading,setLoading]=useState(false);const sequence=useRef(0);
 async function load(){const request=++sequence.current;setLoading(true);setReview(null);setError('');try{const result=await service.review(organizationId,invoiceId);if(request===sequence.current)setReview(result);}catch(e){if(request===sequence.current)setError(e.message);}finally{if(request===sequence.current)setLoading(false);}}
 useEffect(()=>{if(service.supported)load();return()=>{sequence.current++;};},[organizationId,invoiceId,service]);
 return <section aria-label="Full invoice reconciliation" style={{padding:16,marginBottom:12,background:'white',border:'1px solid #CBDCF2',borderRadius:10}}>
  <div style={{display:'flex',gap:12,alignItems:'center',flexWrap:'wrap'}}><h4 style={{margin:0,color:'#073B83'}}>Invoice reconciliation</h4><button disabled={loading||!service.supported} onClick={load}>Refresh reconciliation</button><button onClick={onClose}>Close reconciliation</button></div>
  <p>Compare the complete saved invoice with its retained source and recorded order receipts. Payment status is not recorded here.</p>
  {!service.supported&&<p>Invoice reconciliation is unavailable.</p>}{loading&&<p role="status">Loading full invoice evidence…</p>}{error&&<p role="alert">{error}</p>}
  {review&&<div><p><b>{review.status==='reconciled'?'Reconciled amounts and receipt links':'Needs review'}</b> · Receipt coverage: {review.coverage} · Order-rate or weight flags: {review.varianceCount}</p>
   <table><tbody><tr><th style={{textAlign:'left'}}>Saved item lines</th><td>{money(review.lineCents)}</td></tr><tr><th style={{textAlign:'left'}}>Recorded invoice total</th><td>{money(review.recordedCents)}</td></tr>{Object.entries(labels).map(([key,label])=><tr key={key}><th style={{textAlign:'left'}}>{label}</th><td>{review.evidence.amounts[key]==null?'Not stated / needs source':money(review.evidence.amounts[key])}</td></tr>)}<tr><th style={{textAlign:'left'}}>Items plus stated adjustments</th><td>{money(review.calculatedCents)}</td></tr><tr><th style={{textAlign:'left'}}>Printed total less calculated total</th><td>{money(review.differenceCents)}</td></tr></tbody></table>
   <p>Active linked item charges: {money(review.linkedCents)} · Item charges without an active receipt: {money(review.unlinkedCents)}. Tax, freight and credit adjustments are shown separately.</p>
   {review.issues.length>0&&<div><h5>Source and amount review</h5><ul>{review.issues.map((issue,i)=><li key={i}>{issue}</li>)}</ul></div>}
   <h5>Every saved invoice line</h5><div style={{maxHeight:350,overflow:'auto'}}><table style={{width:'100%',textAlign:'left'}}><thead><tr><th>Item</th><th>Charge</th><th>Receipt</th><th>Order-rate variance</th></tr></thead><tbody>{review.lines.map(l=><tr key={l.id}><td>{l.description||'Unspecified item'}{l.weightOutsideStatedRange&&<div>Weight outside ordered estimate range</div>}</td><td>{money(l.cents)}</td><td>{l.coverage==='linked'?'Linked':l.coverage==='reversed'?'Reversed — needs review':'Unlinked — needs review'}</td><td>{l.rateVarianceCents==null?'Not linked':money(l.rateVarianceCents)}</td></tr>)}</tbody></table></div>
   <h5>Retained summary source</h5>{review.evidence.entries.length?<pre style={{whiteSpace:'pre-wrap',overflowWrap:'anywhere'}}>{review.evidence.entries.map(e=>`Line ${e.lineNumber}: ${e.sourceLine}`).join('\n')}</pre>:<p>No supported explicit summary amounts found. Check the original invoice.</p>}
  </div>}
 </section>;
}
