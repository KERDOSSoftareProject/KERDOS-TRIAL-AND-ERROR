import {createSummaryRecoveryStore} from '../services/summary-recovery-store.js';
import {useEffect,useRef,useState} from 'react';
import {backend} from '../backend/index.js';
import {btn,inp} from '../ui/styles.js';
import {createSummaryClassificationService,resolveSummaryRequest} from '../services/invoice-summary-classification.js';
import {classifyInvoiceSummary,invoiceSummaryBasis,sameSummaryData,summaryKinds} from '../core/invoice-summary-classification.js';
import {invoiceSummaryEvidence} from '../core/invoice-reconciliation.js';
const defaultService=createSummaryClassificationService(backend);
const currentMappings=c=>{const latest=c.history.at(-1);return latest&&sameSummaryData(latest.basis,invoiceSummaryBasis(c.source))?latest.mappings:[];};
const recoveryStorage=()=>{try{return globalThis.localStorage;}catch{return null;}};
const matches=(record,plan)=>record.requestId===plan.requestId&&record.previousId===plan.review.previousId&&record.reason===plan.review.reason&&sameSummaryData(record.basis,plan.review.basis)&&sameSummaryData(record.mappings,plan.review.mappings);
export function InvoiceSummaryClassification({organizationId,invoiceId,service=defaultService,onUpdated,storage=recoveryStorage()}){
 const [closeConfirmed,setCloseConfirmed]=useState(false);
 const [attempts,setAttempts]=useState([]),[recoveryReady,setRecoveryReady]=useState(false);
 const [context,setContext]=useState(null),[mappings,setMappings]=useState([]),[line,setLine]=useState(''),[kind,setKind]=useState('tax'),[reason,setReason]=useState(''),[preview,setPreview]=useState(null),[confirmed,setConfirmed]=useState(false),[pending,setPending]=useState(null),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const alive=useRef(true),working=useRef(false),sequence=useRef(0);
 useEffect(()=>{alive.current=true;return()=>{alive.current=false;sequence.current++;};},[]);
 function journal(c){return createSummaryRecoveryStore(storage,organizationId,c.actorId);}
 function selectAttempt(plan){setCloseConfirmed(false);setPending(plan);setMappings(plan.review.mappings);setReason(plan.review.reason);const text=classifyInvoiceSummary(plan.review.basis,plan.review.mappings);setPreview({text,evidence:invoiceSummaryEvidence(text,plan.review.basis.itemSources)});setConfirmed(false);}
 function acceptContext(c,preferred=pending){
  setContext(c);setCloseConfirmed(false);setRecoveryReady(false);
  if(!c.actorId){if(c.canClassify)throw Error('Sign in again before classification recovery');setAttempts([]);setPending(null);setRecoveryReady(true);return;}
  const store=journal(c),unresolved=[];let recovered=0,closed=0;
  for(const entry of store.pending(invoiceId)){const resolution=resolveSummaryRequest(entry.plan,c);if(['saved','closed'].includes(resolution.status)){store.settle(entry.plan,resolution.status,resolution.recordId);if(resolution.status==='saved')recovered++;else closed++;}else unresolved.push({...entry,resolution});}
  setAttempts(unresolved);setRecoveryReady(true);
  const active=unresolved.find(e=>e.plan.requestId===preferred?.requestId)||unresolved[0];
  if(active)selectAttempt(active.plan);else{setPending(null);setMappings(currentMappings(c));setPreview(null);setConfirmed(false);setReason('');}
  if(recovered||closed){setNotice(closed?'Closed classification attempt recovered. This request cannot apply.':'Classification recovered from saved history. Review the current latest source.');notify();}
 }
 useEffect(()=>{let active=true;const token=++sequence.current;setContext(null);setCloseConfirmed(false);setMappings([]);setPreview(null);setConfirmed(false);setPending(null);setAttempts([]);setRecoveryReady(false);setReason('');setError('');setNotice('');if(service.supported)service.review(organizationId,invoiceId).then(c=>{if(active&&alive.current&&token===sequence.current)acceptContext(c,null);}).catch(e=>{if(active&&alive.current&&token===sequence.current)setError(e.message);});return()=>{active=false;};},[organizationId,invoiceId,service,storage]);
 function invalidate(){setCloseConfirmed(false);setPreview(null);setConfirmed(false);setError('');}
 function notify(){if(onUpdated)Promise.resolve().then(()=>onUpdated()).catch(()=>{});}
 async function refresh(){
  if(working.current)return;working.current=true;setBusy(true);setError('');setConfirmed(false);setCloseConfirmed(false);const token=++sequence.current;
  try{const c=await service.review(organizationId,invoiceId);if(alive.current&&token===sequence.current){acceptContext(c);notify();}}
  catch(e){if(alive.current&&token===sequence.current){setRecoveryReady(false);setError(e.message);}}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 async function closeSuperseded(){
  if(working.current||!pending)return;const request=pending,token=++sequence.current;working.current=true;setBusy(true);setError('');setConfirmed(false);
  try{const c=await service.review(organizationId,invoiceId),resolution=resolveSummaryRequest(request,c);if(resolution.status==='pending')throw Error('This attempt is still unresolved. Retry the identical request or refresh history.');journal(c).settle(request,resolution.status,resolution.recordId||null);if(alive.current&&token===sequence.current){acceptContext(c,null);setNotice(resolution.status==='saved'?'Classification found in saved history.':resolution.status==='closed'?'Classification attempt is permanently closed.':'Superseded attempt closed. Its earlier review cannot apply after the newer revision.');notify();}}
  catch(e){if(alive.current&&token===sequence.current)setError(e.message);}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 async function closeUnconfirmed(){
  if(working.current||!pending||!closeConfirmed)return;const request=pending,token=++sequence.current;working.current=true;setBusy(true);setError('');setConfirmed(false);setCloseConfirmed(false);
  try{const result=await service.closeAttempt(request,{confirmed:true});const c=await service.review(organizationId,invoiceId),resolution=resolveSummaryRequest(request,c);if(resolution.status!==result.status||resolution.recordId!==result.record.id)throw Error('Closure result is missing from refreshed history; retain this request');journal(c).settle(request,result.status,result.record.id);if(alive.current&&token===sequence.current){acceptContext(c,null);setNotice(result.status==='saved'?'The classification was already saved. Its historical result was recovered.':'Classification attempt permanently closed. A late save of this request is blocked.');notify();}}
  catch(e){if(alive.current&&token===sequence.current){setError(e.message);setNotice('Closure is unconfirmed. The original request remains retained; refresh history or retry closure.');}}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 function add(){try{const next=[...mappings.filter(m=>m.lineNumber!==Number(line)),{lineNumber:Number(line),kind}].sort((a,b)=>a.lineNumber-b.lineNumber);classifyInvoiceSummary(invoiceSummaryBasis(context.source),next);setMappings(next);setLine('');invalidate();}catch(e){setError(e.message);}}
 function review(){try{if([...reason.trim()].length<10||[...reason.trim()].length>500)throw Error('Enter a classification reason of 10 to 500 characters');const basis=invoiceSummaryBasis(context.source),text=classifyInvoiceSummary(basis,mappings);setPreview({text,evidence:invoiceSummaryEvidence(text,basis.itemSources)});setConfirmed(false);setError('');}catch(e){setError(e.message);}}
 async function save(){
  if(working.current||!confirmed||!recoveryReady||(!pending&&!preview))return;let request,store;
  try{store=journal(context);if(!pending&&store.pending(invoiceId).length){acceptContext(context);throw Error('Resolve retained classification attempts before starting another save.');}request=pending||service.prepare(context,mappings,reason.trim(),{confirmed:true});store.retain(request);}
  catch(e){setError(e.message);return;}
  const token=++sequence.current;working.current=true;setBusy(true);setError('');setCloseConfirmed(false);setPending(request);
  try{const saved=await service.save(request,{confirmed:true});const c=await service.review(organizationId,invoiceId);const found=c.history.find(r=>r.id===saved.id);if(!found||!matches(found,request)||resolveSummaryRequest(request,c).status!=='saved')throw Error('Saved classification is missing from refreshed history; retain this request');store.settle(request,'saved',saved.id);if(alive.current&&token===sequence.current){acceptContext(c,null);setNotice('Summary classification recorded. Review reconciliation and obtain fresh accounting approval.');notify();}}
  catch(e){if(alive.current&&token===sequence.current){setConfirmed(false);setError(e.message);setNotice('The exact request remains retained. Refresh history, retry it, or close it before reviewing a new classification.');}}
  finally{working.current=false;if(alive.current)setBusy(false);}
 }
 if(!service.supported)return null;
 const superseded=pending&&attempts.find(e=>e.requestId===pending.requestId)?.resolution.status==='superseded';
 const locked=busy||!!pending;
 return <section aria-label="Invoice summary classification" style={{borderTop:'1px solid #CBDCF2',marginTop:18,paddingTop:12}}><h4>Clarify summary source</h4><p>Classify a complete monetary line already printed in the retained invoice text. Amounts and original text stay intact. Unstated amounts remain unknown; classification does not approve or pay the invoice.</p>
 <button style={btn('#E8F1FB','#003584')} disabled={busy} onClick={refresh}>Refresh summary history</button>{error&&<p role="alert">{error}</p>}{notice&&<p role="status">{notice}</p>}
 {attempts.length>0&&<div><h5>Unconfirmed classifications</h5><p>Resolve retained attempts before starting another classification.</p>{attempts.map((e,i)=><p key={e.requestId}>{e.plan.review.reason} · {new Date(e.createdAt).toLocaleString()} · {e.resolution.status==='superseded'?'Superseded by a newer revision':'Result still unknown'} <button disabled={busy} onClick={()=>selectAttempt(e.plan)}>Review retained attempt {i+1}</button></p>)}{superseded&&<button disabled={busy} onClick={closeSuperseded}>Close superseded classification attempt</button>}</div>}
 {context&&<div><details><summary>Retained invoice text with line numbers</summary><pre style={{maxHeight:300,overflow:'auto',whiteSpace:'pre-wrap'}}>{String(context.source.header.rawText||'').replaceAll('\r','').split('\n').map((t,i)=>`${i+1}: ${t}`).join('\n')}</pre></details>
 {!context.canClassify&&<p>An owner or manager must classify summary source.</p>}
 {(context.canClassify||pending)&&<div><label>Source line number <input aria-label="Summary source line number" type="number" min="1" value={line} disabled={locked} style={inp} onChange={e=>{setLine(e.target.value);invalidate();}}/></label><label>Category <select aria-label="Summary source category" value={kind} disabled={locked} onChange={e=>{setKind(e.target.value);invalidate();}}>{Object.entries(summaryKinds).map(([k,label])=><option key={k} value={k}>{label}</option>)}</select></label><button disabled={locked||!line} onClick={add}>Classify selected source line</button>
 <ul>{mappings.map(m=><li key={m.lineNumber}>Line {m.lineNumber} → {summaryKinds[m.kind]} <button disabled={locked} onClick={()=>{setMappings(mappings.filter(x=>x.lineNumber!==m.lineNumber));invalidate();}}>Remove line {m.lineNumber} classification</button></li>)}</ul><p>Removing every classification restores the original interpretation when saved as a new revision.</p>
 <label>Reason <textarea aria-label="Summary classification reason" value={reason} maxLength={1000} disabled={locked} style={inp} onChange={e=>{setReason(e.target.value);invalidate();}}/></label><button disabled={locked} onClick={review}>Review summary classification</button>
 {preview&&<div><h5>{pending?'Retained reviewed classification — result unconfirmed':'Classification preview — not saved or approved'}</h5><pre style={{maxHeight:220,overflow:'auto',whiteSpace:'pre-wrap'}}>{preview.text}</pre>{preview.evidence.issues.length>0&&<ul>{preview.evidence.issues.map((issue,i)=><li key={i}>{issue}</li>)}</ul>}<p>Missing source amounts and all invoice reconciliation checks still apply.</p></div>}
 {pending&&context.canClassify&&service.closureSupported&&!superseded&&<div><p>Close this unconfirmed attempt before reviewing different details. If it already saved, its result will be recovered. Otherwise late saves of this exact request will be blocked.</p><label><input type="checkbox" aria-label="Confirm close unconfirmed classification attempt" checked={closeConfirmed} disabled={busy} onChange={e=>setCloseConfirmed(e.target.checked)}/> I confirm this exact unconfirmed attempt should be closed.</label><button disabled={busy||!closeConfirmed} onClick={closeUnconfirmed}>Close unconfirmed classification attempt</button></div>}
 {(preview||pending)&&<div>{pending&&<p>Pending classification. Its reviewed details are retained for an identical retry.</p>}<label><input type="checkbox" aria-label="Confirm retained summary classification" checked={confirmed} disabled={busy} onChange={e=>setConfirmed(e.target.checked)}/> I confirm these categories describe the selected retained source lines.</label><button disabled={busy||!confirmed||!recoveryReady||!!superseded} style={btn('#003584','white')} onClick={save}>{pending?'Retry same summary classification':'Save confirmed summary classification'}</button></div>}
 </div>}
 {context.history.length>0&&<div><h5>Summary classification history</h5>{context.history.map(r=><p key={r.id}>Revision {r.revision} · {r.reason} · {new Date(r.recordedAt).toLocaleString()} · Recorded by {r.recordedBy} · {r.mappings.length} classified lines{r.id===context.history.at(-1).id?' · Latest':''}</p>)}</div>}</div>}
 {context?.closedAttempts?.length>0&&<div><h5>Closed classification attempts</h5><p>Closed requests do not change classified source.</p>{context.closedAttempts.map(r=><p key={r.id}>{r.review.reason} · {new Date(r.closedAt).toLocaleString()} · Closed by {r.closedBy}</p>)}</div>}
 </section>;
}
