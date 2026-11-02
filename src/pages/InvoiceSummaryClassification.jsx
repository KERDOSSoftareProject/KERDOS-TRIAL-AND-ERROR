import {useEffect,useRef,useState} from 'react';
import {backend} from '../backend/index.js';
import {btn,inp} from '../ui/styles.js';
import {createSummaryClassificationService} from '../services/invoice-summary-classification.js';
import {classifyInvoiceSummary,invoiceSummaryBasis,sameSummaryData,summaryKinds} from '../core/invoice-summary-classification.js';
import {invoiceSummaryEvidence} from '../core/invoice-reconciliation.js';
import {draftSaveDefinitelyFailed} from '../services/draft-recovery-store.js';
const defaultService=createSummaryClassificationService(backend);
const currentMappings=c=>{const latest=c.history.at(-1);return latest&&sameSummaryData(latest.basis,invoiceSummaryBasis(c.source))?latest.mappings:[];};
const matches=(record,plan)=>record.requestId===plan.requestId&&record.previousId===plan.review.previousId&&record.reason===plan.review.reason&&sameSummaryData(record.basis,plan.review.basis)&&sameSummaryData(record.mappings,plan.review.mappings);
export function InvoiceSummaryClassification({organizationId,invoiceId,service=defaultService,onUpdated}){
 const [context,setContext]=useState(null),[mappings,setMappings]=useState([]),[line,setLine]=useState(''),[kind,setKind]=useState('tax'),[reason,setReason]=useState(''),[preview,setPreview]=useState(null),[confirmed,setConfirmed]=useState(false),[pending,setPending]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const alive=useRef(true),working=useRef(false),sequence=useRef(0);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;sequence.current++;};},[]);
 useEffect(()=>{let active=true;const token=++sequence.current;setContext(null);setMappings([]);setPreview(null);setConfirmed(false);setPending(null);setError('');if(service.supported)service.review(organizationId,invoiceId).then(c=>{if(active&&alive.current&&token===sequence.current){setContext(c);const latest=c.history.at(-1);setMappings(latest&&sameSummaryData(latest.basis,invoiceSummaryBasis(c.source))?latest.mappings:[]);}}).catch(e=>{if(active&&alive.current&&token===sequence.current)setError(e.message);});return()=>{active=false;};},[organizationId,invoiceId,service]);
 function invalidate(){setPreview(null);setConfirmed(false);setError('');}
 function notify(){if(onUpdated)Promise.resolve().then(()=>onUpdated()).catch(()=>{});}
 async function refresh(){
  if(working.current)return;working.current=true;setBusy(true);setError('');setConfirmed(false);const token=++sequence.current;
  try{const c=await service.review(organizationId,invoiceId);if(alive.current&&token===sequence.current){setContext(c);if(pending){const record=c.history.find(r=>r.requestId===pending.requestId);if(record){if(!matches(record,pending))throw Error('Classification request belongs to different evidence');setPending(null);setPreview(null);setReason('');setNotice('Classification found in history. Review the current latest source.');notify();}else setNotice('No saved result found yet. Retry the same classification request.');}else{setMappings(currentMappings(c));setPreview(null);}}}catch(e){if(alive.current&&token===sequence.current){setContext(null);setError(e.message);}}finally{working.current=false;if(alive.current)setBusy(false);}
 }
 function add(){try{const next=[...mappings.filter(m=>m.lineNumber!==Number(line)),{lineNumber:Number(line),kind}].sort((a,b)=>a.lineNumber-b.lineNumber);classifyInvoiceSummary(invoiceSummaryBasis(context.source),next);setMappings(next);setLine('');invalidate();}catch(e){setError(e.message);}}
 function review(){try{if([...reason.trim()].length<10||[...reason.trim()].length>500)throw Error('Enter a classification reason of 10 to 500 characters');const basis=invoiceSummaryBasis(context.source),text=classifyInvoiceSummary(basis,mappings);setPreview({text,evidence:invoiceSummaryEvidence(text,basis.itemSources)});setConfirmed(false);setError('');}catch(e){setError(e.message);}}
 async function save(){
  if(working.current||!confirmed||(!pending&&!preview))return;let request;try{request=pending||service.prepare(context,mappings,reason.trim(),{confirmed:true});}catch(e){setError(e.message);return;}
  const retrying=!!pending;let returned=false;const token=++sequence.current;working.current=true;setBusy(true);setError('');setPending(request);
  try{const saved=await service.save(request,{confirmed:true});returned=true;const c=await service.review(organizationId,invoiceId);const found=c.history.find(r=>r.id===saved.id);if(!found||!matches(found,request))throw Error('Saved classification is missing from refreshed history; retain this request');if(alive.current&&token===sequence.current){setContext(c);setMappings(currentMappings(c));setPending(null);setPreview(null);setConfirmed(false);setReason('');setNotice('Summary classification recorded. Review reconciliation and obtain fresh accounting approval.');notify();}}
  catch(e){if(alive.current&&token===sequence.current){if(draftSaveDefinitelyFailed(e)&&!retrying&&!returned){setPending(null);setPreview(null);}setConfirmed(false);setError(e.message);setNotice('Refresh history or retry this same request to resolve its result.');}}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 if(!service.supported)return null;
 const locked=busy||!!pending;
 return <section aria-label="Invoice summary classification" style={{borderTop:'1px solid #CBDCF2',marginTop:18,paddingTop:12}}><h4>Clarify summary source</h4><p>Classify a complete monetary line already printed in the retained invoice text. Amounts and original text stay intact. Unstated amounts remain unknown; classification does not approve or pay the invoice.</p>
 <button style={btn('#E8F1FB','#003584')} disabled={busy} onClick={refresh}>Refresh summary history</button>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
 {context&&<div><details><summary>Retained invoice text with line numbers</summary><pre style={{maxHeight:300,overflow:'auto',whiteSpace:'pre-wrap'}}>{String(context.source.header.rawText||'').replaceAll('\r','').split('\n').map((t,i)=>`${i+1}: ${t}`).join('\n')}</pre></details>
 {!context.canClassify&&<p>An owner or manager must classify summary source.</p>}
 {(context.canClassify||pending)&&<div><label>Source line number <input aria-label="Summary source line number" type="number" min="1" value={line} disabled={locked} style={inp} onChange={e=>{setLine(e.target.value);invalidate();}}/></label><label>Category <select aria-label="Summary source category" value={kind} disabled={locked} onChange={e=>{setKind(e.target.value);invalidate();}}>{Object.entries(summaryKinds).map(([k,label])=><option key={k} value={k}>{label}</option>)}</select></label><button disabled={locked||!line} onClick={add}>Classify selected source line</button>
 <ul>{mappings.map(m=><li key={m.lineNumber}>Line {m.lineNumber} → {summaryKinds[m.kind]} <button disabled={locked} onClick={()=>{setMappings(mappings.filter(x=>x.lineNumber!==m.lineNumber));invalidate();}}>Remove line {m.lineNumber} classification</button></li>)}</ul><p>Removing every classification restores the original interpretation when saved as a new revision.</p>
 <label>Reason <textarea aria-label="Summary classification reason" value={reason} maxLength={1000} disabled={locked} style={inp} onChange={e=>{setReason(e.target.value);invalidate();}}/></label><button disabled={locked} onClick={review}>Review summary classification</button>
 {preview&&<div><h5>Classification preview — not saved or approved</h5><pre style={{maxHeight:220,overflow:'auto',whiteSpace:'pre-wrap'}}>{preview.text}</pre>{preview.evidence.issues.length>0&&<ul>{preview.evidence.issues.map((issue,i)=><li key={i}>{issue}</li>)}</ul>}<p>Missing source amounts and all invoice reconciliation checks still apply.</p></div>}
 {(preview||pending)&&<div>{pending&&<p>Pending classification request {pending.requestId}. Details are retained for identical retry.</p>}<label><input type="checkbox" aria-label="Confirm retained summary classification" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/> I confirm these categories describe the selected retained source lines.</label><button disabled={busy||!confirmed} style={btn('#003584','white')} onClick={save}>{pending?'Retry same summary classification':'Save confirmed summary classification'}</button></div>}
 </div>}
 {context.history.length>0&&<div><h5>Summary classification history</h5>{context.history.map(r=><p key={r.id}>Revision {r.revision} · {r.reason} · {new Date(r.recordedAt).toLocaleString()} · Recorded by {r.recordedBy} · {r.mappings.length} classified lines{r.id===context.history.at(-1).id?' · Latest':''}</p>)}</div>}</div>}
 </section>;
}
