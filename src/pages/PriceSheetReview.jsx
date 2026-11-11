import {useEffect,useRef,useState} from "react";
import {priceBasisFor} from "../procurement.js";
import {unitLabel} from "../core/unit-labels.js";
import {btn,inp} from "../ui/styles.js";
import {QuotedPerControl} from "./QuotedPerControl.jsx";

const primary=btn("#003584","white",{fontSize:12,padding:"8px 12px"});
const secondary=btn("#E8F1FB","#003584",{fontSize:12,padding:"8px 12px"});
const buttons={display:"flex",gap:8,flexWrap:"wrap"};
const reviewFieldLabels=fields=>fields.map(field=>field==="selling_unit"?"quoted per":String(field).replaceAll("_"," ")).join(", ");

function ReviewRows({title,rows,excluded,onToggle,disabled}){
  if(!rows.length)return null;
  return <details open style={{marginTop:10}}>
    <summary>{title} ({rows.length})</summary>
    <ul style={{margin:"6px 0 0",paddingLeft:22,maxHeight:240,overflowY:"auto"}}>
      {rows.map(row=><li key={row.listingId} style={{marginBottom:4}}>
        {onToggle?<label><input type="checkbox" aria-label={`Include ${row.description||row.listingId}`} checked={!excluded.has(row.listingId)} disabled={disabled} onChange={()=>onToggle(row.listingId)}/> <b>{row.description||row.listingId}</b></label>:<b>{row.description||row.listingId}</b>}
        {row.vendorItemCode&&<> · #{row.vendorItemCode}</>}{row.packSize&&<> · {row.packSize}</>}
        {row.vendorName&&<> · {row.vendorName}</>}{row.fileName&&<> · {row.fileName}</>}
        {row.sellingUnit&&<> · Quoted per {unitLabel(row.sellingUnit)}</>}{row.reason&&<> · {row.reason}</>}
        {row.previousReviewFields?.length>0&&<div>Current review fields {reviewFieldLabels(row.previousReviewFields)}</div>}
        {row.reviewRequired===false?<div>Source review clears</div>:row.reviewFields?.length>0&&<div>Review fields {reviewFieldLabels(row.reviewFields)}</div>}
      </li>)}
    </ul>
  </details>;
}

function ReviewCounts({counts,applied=false}){
  if(!Number.isInteger(counts?.ready)||!Number.isInteger(counts?.total))return null;
  const measured=applied&&Number.isInteger(counts.readyAfter)&&Number.isInteger(counts.totalAfter);
  return <p>
    {applied?"Order Guide ready before save":"Order Guide ready"} {counts.ready} of {counts.total}
    {measured?<> · Ready after save {counts.readyAfter} of {counts.totalAfter}</>:Number.isInteger(counts.projectedReady)&&<> · Projected after approval {counts.projectedReady} of {counts.total}</>}
  </p>;
}

export function PriceSheetReview({organizationId,documentId,role,industry,vocabulary,reviewPriceSheet,onSaved}){
  const [mode,setMode]=useState(null);
  const [unit,setUnit]=useState("");
  const [preview,setPreview]=useState(null);
  const [excluded,setExcluded]=useState(()=>new Set());
  const [result,setResult]=useState(null);
  const [error,setError]=useState("");
  const [pending,setPending]=useState(false);
  const inFlight=useRef(false);
  const mounted=useRef(false);
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;};},[]);
  const workspace=documentId===undefined;
  const canConfirm=!workspace&&(role==="owner"||role==="manager");
  const canRecheck=role==="owner";
  const confirmation=mode==="confirmation";
  if((!canConfirm&&!canRecheck)||typeof reviewPriceSheet!=="function")return null;

  function choose(next){
    setMode(next);
    setPreview(null);
    setExcluded(new Set());
    setResult(null);
    setError("");
  }

  async function run(action,values={}){
    if(inFlight.current)return;
    inFlight.current=true;
    setPending(true);
    setError("");
    const isPreview=action.startsWith("preview-");
    if(isPreview&&!values.listingIds)setPreview(null);
    try{
      const scope=workspace?{organizationId}:{organizationId,documentId};
      const response=await reviewPriceSheet({...scope,action,...values});
      if(!mounted.current)return;
      if(isPreview){
        setPreview(response);
        setExcluded(new Set());
      }else{
        setPreview(null);
        setMode(null);
        setResult({action,counts:response?.counts,readinessRefreshRequired:response?.readinessRefreshRequired});
        try{await onSaved?.();}
        catch{if(mounted.current)setError("The change was saved. Refresh the workspace to see it in the catalog.");}
      }
    }catch(err){
      if(!mounted.current)return;
      setError(err?.message||"Could not review this price sheet. Try again.");
      if(err?.cause?.status===409)setPreview(null);
    }finally{
      if(mounted.current)setPending(false);
      inFlight.current=false;
    }
  }

  const rows=preview?.rows||[];
  const held=preview?.held||[];
  const selectionChanged=excluded.size>0;
  const selectedIds=rows.filter(row=>!excluded.has(row.listingId)).map(row=>row.listingId);
  function toggleListing(id){
    setExcluded(current=>{
      const next=new Set(current);
      if(next.has(id))next.delete(id);else next.add(id);
      return next;
    });
  }
  function updatePreview(){
    if(!selectedIds.length)return;
    const values=confirmation?{unit,listingIds:selectedIds}:{listingIds:selectedIds};
    void run(confirmation?"preview-confirmation":"preview-recheck",values);
  }
  return <section aria-label={workspace?"Workspace price sheet recheck":"Price sheet review"} style={workspace?{marginBottom:14,fontSize:13}:{marginTop:14,fontSize:13}}>
    <div style={buttons}>
      {canConfirm&&<button type="button" disabled={pending} onClick={()=>choose("confirmation")} style={secondary}>Confirm quoted per</button>}
      {canRecheck&&<button type="button" disabled={pending} onClick={()=>{choose("recheck");void run("preview-recheck");}} style={secondary}>{workspace?"Preview workspace recheck":"Preview source recheck"}</button>}
    </div>
    {mode&&<div style={{marginTop:12}}>
      {confirmation&&<>
        <p>Verify the quoted unit on the original price sheet before confirming.</p>
        <QuotedPerControl label="Confirmed quoted unit" industry={industry} vocabulary={vocabulary} value={unit} onChange={value=>{setUnit(value);setPreview(null);setExcluded(new Set());setError("");}} disabled={pending} style={{...inp,width:"min(100%, 200px)"}}/>
        <button type="button" disabled={pending||!priceBasisFor(unit)} onClick={()=>void run("preview-confirmation",{unit})} style={{...secondary,marginLeft:8}}>Preview confirmation</button>
      </>}
      {preview&&<>
        {selectionChanged?<p>{selectedIds.length} of {rows.length} listings selected. {selectedIds.length?"Update the preview before approving.":"Select at least one listing."}</p>:<ReviewCounts counts={preview.counts}/>}
        <ReviewRows title={confirmation?"Eligible listings":"Listings in this recheck"} rows={rows} excluded={excluded} onToggle={toggleListing} disabled={pending}/>
        <ReviewRows title="Listings held" rows={held}/>
        {!rows.length&&<p>No eligible listings for this action.</p>}
      </>}
      <div style={{...buttons,marginTop:12}}>
        {preview&&selectionChanged&&<button type="button" disabled={pending||!selectedIds.length} onClick={updatePreview} style={secondary}>Update preview</button>}
        {preview?.token&&rows.length>0&&<button type="button" disabled={pending||selectionChanged} onClick={()=>{if(!selectionChanged)void run(confirmation?"confirm":"apply-recheck",{token:preview.token});}} style={primary}>{confirmation?"Confirm verified unit":workspace?"Approve workspace recheck":"Approve source recheck"}</button>}
        <button type="button" disabled={pending} onClick={()=>choose(null)} style={secondary}>Cancel</button>
      </div>
    </div>}
    {pending&&<p role="status">Working…</p>}
    {result&&<div role="status">
      <p>{result.action==="confirm"?"Quoted unit confirmation saved.":"Source recheck saved."}</p>
      <ReviewCounts counts={result.counts} applied/>
      {result.readinessRefreshRequired&&<p>Refresh the workspace for the current Order Guide count.</p>}
    </div>}
    {error&&<p role="alert" style={{color:"#A32B20"}}>{error}</p>}
  </section>;
}
