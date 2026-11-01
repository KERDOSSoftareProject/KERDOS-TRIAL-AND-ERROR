import {estimatedOrderExport} from '../core/estimated-orders.js';
import {createEstimatedOrderService} from '../services/estimated-orders.js';
import {downloadTextFile} from '../reporting.js';
import {useEffect,useRef,useState} from 'react';
import {MovableDialog} from '../ui/MovableDialog.jsx';
import {backend} from '../backend/index.js';
import {createEstimatedDraftService} from '../services/estimated-purchase-drafts.js';
import {createVariableWeightService,variableWeightConfirmationState} from '../services/variable-weight.js';
import {createDraftRecoveryStore,draftSaveDefinitelyFailed} from '../services/draft-recovery-store.js';
import {prepareEstimatedPurchaseDraft} from '../core/estimated-purchase-drafts.js';
import {parsePackSize,priceBasisFor} from '../procurement.js';
import {formatMoney} from '../localization.js';
import {btn,inp} from '../ui/styles.js';

const estimatedOrderService=createEstimatedOrderService(backend);
const draftService=createEstimatedDraftService(backend),confirmationService=createVariableWeightService(backend);
const estimateLabel=e=>Number.isFinite(e?.amount)&&e.amount>0?formatMoney(e.amount):Number.isFinite(e?.minimum)&&Number.isFinite(e?.maximum)&&e.minimum>0&&e.maximum>=e.minimum?`${formatMoney(e.minimum)}–${formatMoney(e.maximum)}`:'Unresolved';
const rateLabel=value=>value==null||!Number.isFinite(Number(value))||Number(value)<=0?'Unquoted':`${formatMoney(value)}${Number(value)!==Math.round(Number(value)*100)/100?` (stated rate ${value})`:''}`;
const displayDate=value=>{const date=new Date(value);return Number.isFinite(date.getTime())?date.toLocaleString():'Date unavailable';};
const purchasingRole=role=>['owner','manager','employee'].includes(role);
function browserStore(org,user){let storage;try{storage=globalThis.localStorage;}catch{}return createDraftRecoveryStore(storage,org,user);}

export function EstimatedDraftLauncher(props){
  const [open,setOpen]=useState(false);
  if(!purchasingRole(props.role)||!props.userId||!draftService.supported||!confirmationService.supported)return null;
  return <>
    <button onClick={()=>setOpen(true)} style={btn('#003584','white',{fontSize:12,padding:'8px 14px'})}>Estimated drafts</button>
    {open&&<EstimatedPurchaseDrafts key={`${props.orgId}:${props.userId}`} {...props} service={draftService} approvalService={confirmationService} onClose={()=>setOpen(false)}/>}
  </>;
}

export function EstimatedPurchaseDrafts({orgId,userId,role,vendors=[],vendorItems=[],mappings=[],catalogItems=[],settings={},service,approvalService,orderService=estimatedOrderService,onClose,store:providedStore,makeRequestId=()=>crypto.randomUUID()}){
  const [store]=useState(()=>providedStore||browserStore(orgId,userId));
  const [basket,setBasket]=useState(()=>store.readBasket()),[pending,setPending]=useState(()=>store.pending());
  const [approvals,setApprovals]=useState(()=>store.readConfirmations()),[offline,setOffline]=useState(false),[loading,setLoading]=useState(true);
  const [saved,setSaved]=useState([]),[offset,setOffset]=useState(0),[hasOlder,setHasOlder]=useState(false),[view,setView]=useState('prepare'),[selected,setSelected]=useState(null);
  const [busy,setBusy]=useState(false),[consent,setConsent]=useState(''),[retry,setRetry]=useState(null),[retryConsent,setRetryConsent]=useState(false),[cancelTarget,setCancelTarget]=useState(null);
  const [orderReview,setOrderReview]=useState(null),[orderConsent,setOrderConsent]=useState(false),[minimumConsent,setMinimumConsent]=useState(false),[recordedOrder,setRecordedOrder]=useState(null);
  const [closeTarget,setCloseTarget]=useState(null),[error,setError]=useState(''),[notice,setNotice]=useState('');
  const alive=useRef(true),working=useRef(false);
  const scopedItems=vendorItems.filter(v=>v.organization_id===orgId&&parsePackSize(v.pack_size)?.catchWeight&&priceBasisFor(v.selling_unit)?.basis==='measure');
  const ids=scopedItems.map(v=>v.id).sort().join('|');
  useEffect(()=>{alive.current=true;return ()=>{alive.current=false;};},[]);
  useEffect(()=>{
    if(!purchasingRole(role)||!orgId||!userId){setLoading(false);return;}
    let active=true;setLoading(true);
    Promise.allSettled([approvalService.list(orgId,ids?ids.split('|'):[]),service.list(orgId,0)]).then(([a,d])=>{
      if(!active||!alive.current)return;
      if(a.status==='fulfilled'){setApprovals(a.value);store.saveConfirmations(a.value);setOffline(false);}else{setOffline(true);setError(a.reason.message||String(a.reason));}
      if(d.status==='fulfilled'){setSaved(d.value);setOffset(d.value.length);setHasOlder(d.value.length===50);}else setError(d.reason.message||String(d.reason));
      setLoading(false);
    });
    return ()=>{active=false;};
  },[orgId,ids,approvalService,service,store,role,userId]);
  function remember(next){if(!store.saveBasket(next)&&alive.current)setNotice('Changes are in this window only; local recovery storage is unavailable.');if(alive.current)setBasket(next);}
  const now=new Date().toISOString();
  const rows=scopedItems.filter(v=>v.vendor_id===basket.vendorId).map(listing=>{
    const links=mappings.filter(m=>m.organization_id===orgId&&m.vendor_item_id===listing.id&&m.comparison_track==='exact'&&m.confidence_score===100);
    const mapping=links.length===1?links[0]:null;
    const approval=approvals.find(a=>a.terms?.vendorItemId===listing.id&&a.terms?.catalogItemId===mapping?.catalog_item_id);
    const input={organizationId:orgId,vendorId:basket.vendorId,catalogItemId:mapping?.catalog_item_id,listing,mapping,approval,settings,now,quantity:basket.quantities[listing.id]||'',orderUnit:'case'};
    const state=variableWeightConfirmationState(input,approval);
    return {listing,input,eligible:state.confirmed,reason:links.length>1?'Resolve multiple catalog associations first':state.reason||'Confirm the catalog association and variable-weight terms first',name:catalogItems.find(c=>c.id===mapping?.catalog_item_id)?.name||listing.description};
  });
  const selectedRows=rows.filter(r=>Number(basket.quantities[r.listing.id])>0||basket.quantities[r.listing.id]&&Number(basket.quantities[r.listing.id])!==0);
  const missing=Object.keys(basket.quantities).filter(id=>basket.quantities[id]&&Number(basket.quantities[id])!==0&&!vendorItems.some(v=>v.id===id&&v.organization_id===orgId));
  let preview=null,problem='Choose at least one confirmed item and its whole-case quantity.';
  if(selectedRows.length){try{
    if(selectedRows.some(r=>!r.eligible)||missing.length)throw new Error('Resolve or remove selections whose terms are no longer confirmed.');
    preview=prepareEstimatedPurchaseDraft({organizationId:orgId,vendorId:basket.vendorId,requestId:'preview',lines:selectedRows.map(r=>r.input),confirmed:true,now});problem='';
  }catch(err){problem=err.message;}}
  const fingerprint=preview?JSON.stringify(preview.lines):'',accepted=!!fingerprint&&consent===fingerprint;
  useEffect(()=>{setConsent('');},[fingerprint]);
  const canEdit=purchasingRole(role)&&!busy&&!pending.length;
  const scopedVendors=vendors.filter(v=>v.organization_id===orgId);
  const canCancelSelected=selected?.status==='draft'&&!selected.submittedOrderId&&(selected.createdBy===userId||['owner','manager'].includes(role));
  const vendorName=id=>scopedVendors.find(v=>v.id===id)?.name||'Supplier';
  async function refresh(){
    if(working.current)return;working.current=true;setLoading(true);setError('');
    try{const [a,d]=await Promise.all([approvalService.list(orgId,ids?ids.split('|'):[]),service.list(orgId,0)]);if(!alive.current)return;setApprovals(a);store.saveConfirmations(a);setSaved(d);setOffset(d.length);setHasOlder(d.length===50);setOffline(false);setPending(store.pending());}
    catch(err){if(alive.current){setError(err.message||String(err));setOffline(true);}}
    finally{working.current=false;if(alive.current)setLoading(false);}
  }
  function adopt(entry,record){
    const kept=store.settle(entry,'saved',record.id);
    const quantities={...basket.quantities};for(const line of entry.intent.lines)delete quantities[line.terms.vendorItemId];
    remember({...basket,quantities});
    if(!alive.current)return;
    setPending(store.pending());setRetry(null);setRetryConsent(false);setConsent('');setSelected(record);setView('saved');
    setSaved(prior=>[record,...prior.filter(d=>d.id!==record.id)]);setNotice(kept?'Draft saved. Nothing has been ordered or sent.':'Draft saved. Its recovery journal still needs updating.');
  }
  async function send(entry,retrying=false){
    try{const record=await service.savePrepared(entry.intent,{confirmed:true});adopt(entry,record);}
    catch(err){
      const definite=draftSaveDefinitelyFailed(err)&&!retrying;
      if(definite)store.settle(entry,'failed');
      if(alive.current){setPending(store.pending());setConsent('');if(definite){setRetry(null);setRetryConsent(false);}setError(err.message||String(err));setNotice(definite?'Save failed. Review the current terms before trying again.':'The save result is unknown. Check the saved result before starting another draft.');}
    }
  }
  async function save(){
    if(working.current||!canEdit||loading||offline||!accepted||!preview)return;
    working.current=true;setBusy(true);setError('');setNotice('');
    try{
      const outstanding=store.pending();if(outstanding.length){setPending(outstanding);throw new Error('Recover the pending save before starting another draft.');}
      const intent=prepareEstimatedPurchaseDraft({organizationId:orgId,vendorId:basket.vendorId,requestId:makeRequestId(),lines:selectedRows.map(r=>r.input),confirmed:true,now:new Date().toISOString()});
      if(JSON.stringify(intent.lines)!==fingerprint)throw new Error('Terms changed. Review the draft again.');
      if(!store.retain(intent))throw new Error('Cannot retain the recovery request on this device. Nothing was sent.');
      const entry=store.pending().find(p=>p.intent.requestId===intent.requestId);
      if(!entry)throw new Error('Recovery request could not be read. Nothing was sent.');
      if(store.pending().some(p=>p.intent.requestId!==intent.requestId)){store.settle(entry,'failed');setPending(store.pending());throw new Error('Another save is pending. Recover it first; this request was not sent.');}
      setPending(store.pending());await send(entry);
    }catch(err){if(alive.current)setError(err.message||String(err));}
    finally{working.current=false;if(alive.current)setBusy(false);}
  }
  async function recover(entry){
    if(working.current)return;working.current=true;setBusy(true);setError('');setCloseTarget(null);setRetry(null);setRetryConsent(false);
    try{const record=await service.recover(orgId,entry.intent.requestId,entry.intent);if(record)adopt(entry,record);else if(alive.current){setRetry(entry);setNotice('No saved draft found yet. Retry this same request to avoid creating a second draft.');}}
    catch(err){if(alive.current)setError(err.message||String(err));}
    finally{working.current=false;if(alive.current)setBusy(false);}
  }
  async function closeAttempt(){
    if(working.current||!closeTarget)return;const entry=closeTarget;
    working.current=true;setBusy(true);setError('');
    try{
      const result=await service.closeAttempt(entry.intent,{confirmed:true});
      if(result.status==='saved')adopt(entry,result.draft);
      else {
        const kept=store.settle(entry,'closed');
        if(alive.current){setPending(store.pending());setRetry(null);setRetryConsent(false);setConsent('');setNotice(kept?'Save attempt closed. No draft was saved; your selections are retained for review.':'Save attempt closed on the server. Its recovery journal still needs updating.');}
      }
      if(alive.current)setCloseTarget(null);
    }catch(err){if(alive.current){setError(err.message||String(err));setNotice('Closure is unconfirmed. The retained save remains available to check or close again.');}}
    finally{working.current=false;if(alive.current)setBusy(false);}
  }
  async function retrySave(){if(working.current||!retry||!retryConsent)return;working.current=true;setBusy(true);setError('');try{await send(retry,true);}finally{working.current=false;if(alive.current)setBusy(false);}}
  async function openDraft(record){if(working.current)return;working.current=true;setBusy(true);setError('');try{const fresh=await service.get(orgId,record.id);if(!fresh)throw new Error('Draft is no longer available.');if(alive.current){setSelected(fresh);setCancelTarget(null);setOrderReview(null);setOrderConsent(false);setMinimumConsent(false);setRecordedOrder(null);}}catch(err){if(alive.current)setError(err.message||String(err));}finally{working.current=false;if(alive.current)setBusy(false);}}
  async function cancel(){
    if(working.current||!cancelTarget||!canCancelSelected||selected.id!==cancelTarget)return;working.current=true;setBusy(true);setError('');
    try{const record=await service.cancel(orgId,cancelTarget);if(alive.current){setSelected(record);setSaved(prior=>prior.map(d=>d.id===record.id?record:d));setCancelTarget(null);setNotice('Draft cancelled. Its history is preserved.');}}
    catch(err){if(alive.current)setError(err.message||String(err));}
    finally{working.current=false;if(alive.current)setBusy(false);}
  }
  async function reviewOrder(){
    if(working.current||!selected||!canCancelSelected||!orderService.supported)return;working.current=true;setBusy(true);setError('');setOrderReview(null);setOrderConsent(false);setMinimumConsent(false);
    try{const result=await orderService.review(orgId,selected);if(alive.current){setOrderReview(result);setCancelTarget(null);}}
    catch(err){if(alive.current)setError(err.message||String(err));}finally{working.current=false;if(alive.current)setBusy(false);}
  }
  function showRecordedOrder(order){
    if(!alive.current)return;setRecordedOrder(order);setOrderReview(null);setOrderConsent(false);setMinimumConsent(false);setSelected(prior=>({...prior,submittedOrderId:order.id}));setSaved(prior=>prior.map(d=>d.id===order.sourceDraftId?{...d,submittedOrderId:order.id}:d));setCancelTarget(null);setNotice('Order recorded in KERDOS. Export it to send separately; vendor receipt is not confirmed.');
  }
  async function recordOrder(){
    if(working.current||!orderReview||!orderConsent)return;working.current=true;setBusy(true);setError('');
    try{showRecordedOrder(await orderService.submit(orderReview,{confirmed:true,minimumAcknowledged:minimumConsent}));}
    catch(err){if(alive.current){setError(err.message||String(err));setOrderConsent(false);setNotice('Order recording is unconfirmed. Check the recorded result before retrying this same draft.');}}
    finally{working.current=false;if(alive.current)setBusy(false);}
  }
  async function recoverOrder(){
    if(working.current||!selected)return;working.current=true;setBusy(true);setError('');
    try{const order=await orderService.recover(orgId,selected.id);if(order)showRecordedOrder(order);else if(alive.current)setNotice('No recorded order found. Review and retry this same saved draft.');}
    catch(err){if(alive.current)setError(err.message||String(err));}finally{working.current=false;if(alive.current)setBusy(false);}
  }
  async function older(){if(working.current)return;working.current=true;setBusy(true);setError('');try{const page=await service.list(orgId,offset);if(alive.current){setSaved(prior=>[...new Map([...prior,...page].map(d=>[d.id,d])).values()]);setOffset(offset+page.length);setHasOlder(page.length===50);}}catch(err){if(alive.current)setError(err.message||String(err));}finally{working.current=false;if(alive.current)setBusy(false);}}
  function snapshot(lines,estimate){return <div><table style={{width:'100%',borderCollapse:'collapse'}}><thead><tr><th>Product / saved terms</th><th>Cases</th><th>Line estimate</th></tr></thead><tbody>{lines.map(l=><tr key={l.id||l.terms.vendorItemId}><td style={{padding:8}}>{l.terms.description}<br/><small>{l.terms.packSize} · {rateLabel(l.terms.quotedRate)} per {l.terms.quotedUnit}</small></td><td>{l.quantity}</td><td>{estimateLabel(l.estimate)}</td></tr>)}</tbody></table><p><b>Estimated total: {estimateLabel(estimate)}</b></p><p>Final charge: unknown. Delivered weight determines the invoice charge; estimates and range endpoints are not guaranteed.</p></div>;}
  if(!purchasingRole(role)||!orgId||!userId)return null;
  return <MovableDialog label="Estimated purchase drafts" maxWidth={920} zIndex={1200}><div style={{padding:24,background:'white',color:'#19395F'}}>
    <h3 style={{marginTop:0}}>Estimated drafts</h3>
    <p>Prepare and save variable-weight case quantities. Saving a draft does not place or send an order.</p>
    <div style={{display:'flex',gap:8,flexWrap:'wrap'}}><button disabled={busy} onClick={()=>{setView('prepare');setCancelTarget(null);}} style={btn(view==='prepare'?'#003584':'#E8F1FB',view==='prepare'?'white':'#003584')}>Prepare draft</button><button disabled={busy} onClick={()=>{setView('saved');setCancelTarget(null);}} style={btn(view==='saved'?'#003584':'#E8F1FB',view==='saved'?'white':'#003584')}>Saved drafts</button><button disabled={busy||loading} onClick={refresh} style={btn('#E8F1FB','#003584')}>Refresh drafts and confirmations</button><button disabled={busy} onClick={onClose} style={btn('#EEE','#444')}>Close</button></div>
    {loading&&<p role="status">Loading saved drafts and confirmations…</p>}
    {error&&<p role="alert" style={{color:'#A32B20'}}>{error}</p>}{notice&&<p role="status">{notice}</p>}
    {offline&&<p>Connection unavailable. Local selections are retained; refresh confirmations before saving.</p>}
    {pending.length>0&&<section style={{background:'#FFF4D9',padding:12,marginTop:12}}><b>A save needs checking.</b><p>Recover the result before starting another draft.</p>{pending.map(entry=><div key={entry.intent.requestId} style={{marginBottom:12}}>{vendorName(entry.intent.vendorId)} · {displayDate(entry.createdAt)} · Estimate {estimateLabel(entry.intent.estimate)} <button disabled={busy||loading} onClick={()=>recover(entry)} style={btn('#003584','white')}>Check saved result</button> <button disabled={busy||loading} onClick={()=>{setCloseTarget(entry);setRetry(null);setRetryConsent(false);}} style={btn('#E8F1FB','#003584')}>Close save attempt</button></div>)}</section>}
    {closeTarget&&<section><h4>{vendorName(closeTarget.intent.vendorId)} · Unresolved save</h4>{snapshot(closeTarget.intent.lines,closeTarget.intent.estimate)}<p>Close this unresolved save attempt? If a draft was saved, KERDOS will recover it. Otherwise, this request will be permanently closed and cannot save later. Your selections will remain for review.</p><button disabled={busy} onClick={closeAttempt} style={btn('#003584','white')}>Confirm closing save attempt</button><button disabled={busy} onClick={()=>setCloseTarget(null)} style={btn('#EEE','#444')}>Keep save attempt</button></section>}
    {retry&&<section>{snapshot(retry.intent.lines,retry.intent.estimate)}<label><input type="checkbox" aria-label="Confirm retry of estimated draft" checked={retryConsent} disabled={busy} onChange={e=>setRetryConsent(e.target.checked)}/> I confirm retrying these saved terms with the same request.</label><button disabled={busy||!retryConsent} onClick={retrySave} style={btn('#003584','white')}>Retry same save</button></section>}
    {view==='prepare'&&<section>
      <label>Vendor<select aria-label="Estimated draft vendor" value={basket.vendorId} disabled={!canEdit} onChange={e=>{remember({...basket,vendorId:e.target.value});setConsent('');}} style={{...inp,margin:10}}><option value="">Select vendor</option>{scopedVendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}</select></label>
      {basket.vendorId&&<table style={{width:'100%',marginTop:12}}><thead><tr><th>Product</th><th>Rate and pack</th><th>Cases</th></tr></thead><tbody>{rows.map(r=><tr key={r.listing.id}><td style={{padding:8}}>{r.name}{!r.eligible&&<small style={{display:'block'}}>{r.reason}</small>}</td><td>{rateLabel(r.listing.price)} per {r.listing.selling_unit}<br/>{r.listing.pack_size}</td><td><input type="number" min="0" max="2147483647" step="1" aria-label={`Cases for ${r.name} (${r.listing.vendor_item_code||''})`} value={basket.quantities[r.listing.id]||''} disabled={!canEdit||!r.eligible||loading} onChange={e=>remember({...basket,quantities:{...basket.quantities,[r.listing.id]:e.target.value}})} style={{...inp,width:90}}/>{basket.quantities[r.listing.id]&&<button disabled={!canEdit} aria-label={`Remove ${r.name} from draft`} onClick={()=>{const q={...basket.quantities};delete q[r.listing.id];remember({...basket,quantities:q});}}>Remove</button>}</td></tr>)}</tbody></table>}
      {basket.vendorId&&!rows.length&&!loading&&<p>No variable-weight listings are available for this vendor.</p>}
      {missing.map(id=><p key={id}>A saved selection is no longer available. <button disabled={!canEdit} onClick={()=>{const q={...basket.quantities};delete q[id];remember({...basket,quantities:q});}}>Remove unavailable selection</button></p>)}
      {preview?snapshot(preview.lines,preview.estimate):<p>{problem}</p>}
      <label style={{display:'block',margin:'12px 0'}}><input type="checkbox" aria-label="Confirm saving estimated draft" checked={accepted} disabled={!preview||!canEdit||loading||offline} onChange={e=>setConsent(e.target.checked?fingerprint:'')}/> I reviewed the quantities and estimates and want to save this draft.</label>
      <button disabled={!preview||!accepted||!canEdit||loading||offline} onClick={save} style={btn('#003584','white')}>{busy?'Saving…':'Save estimated draft'}</button>
    </section>}
    {view==='saved'&&<section><h4>Saved drafts</h4>{!saved.length&&!loading&&<p>No saved estimated drafts.</p>}{saved.map(d=><div key={d.id} style={{padding:10,borderBottom:'1px solid #DEE7F0'}}>{vendorName(d.vendorId)} · {displayDate(d.createdAt)} · {d.submittedOrderId?'Order recorded':d.status==='cancelled'?'Cancelled':'Draft'} · Estimate {estimateLabel(d.estimate)} <button disabled={busy||loading} onClick={()=>openDraft(d)} style={btn('#E8F1FB','#003584')}>Open draft</button></div>)}{hasOlder&&<button disabled={busy||loading} onClick={older} style={btn('#E8F1FB','#003584')}>Load older drafts</button>}
      {selected&&<article style={{background:'#F1F6FC',padding:12,marginTop:12}}><h4>{vendorName(selected.vendorId)} · {selected.submittedOrderId?'Order recorded':selected.status==='cancelled'?'Cancelled draft':'Saved draft'}</h4>{snapshot(selected.lines,selected.estimate)}<p>These are saved terms. Current confirmations must be checked again before any future order.</p>{orderService.supported&&<div style={{margin:'12px 0'}}>{canCancelSelected&&<button disabled={busy||loading} onClick={reviewOrder} style={btn('#003584','white')}>Review order submission</button>} <button disabled={busy||loading} onClick={recoverOrder} style={btn('#E8F1FB','#003584')}>Check recorded order</button></div>}
      {orderReview&&<section><h4>Review order submission</h4>{snapshot(selected.lines,orderReview.estimate)}<p>Delivery minimum: {orderReview.deliveryMinimum.status==='unknown'?'monetary requirement unconfirmed until the actual charge is known':orderReview.deliveryMinimum.status==='units_short'?'case quantity is below the stated minimum':'case requirement met; no monetary requirement recorded'}.</p>{orderReview.deliveryMinimum.status==='unknown'&&<label style={{display:'block'}}><input type="checkbox" aria-label="Acknowledge unconfirmed delivery minimum" checked={minimumConsent} disabled={busy} onChange={e=>setMinimumConsent(e.target.checked)}/> I understand the monetary delivery minimum is unconfirmed and will verify with the vendor.</label>}<label style={{display:'block'}}><input type="checkbox" aria-label="Confirm recording estimated order" checked={orderConsent} disabled={busy} onChange={e=>setOrderConsent(e.target.checked)}/> I reviewed these quantities, source terms and estimates and want to record this order. I will send it separately.</label><button disabled={busy||!orderConsent||orderReview.deliveryMinimum.status==='units_short'||orderReview.deliveryMinimum.status==='unknown'&&!minimumConsent} onClick={recordOrder} style={btn('#003584','white')}>Record estimated order</button></section>}
      {recordedOrder&&<section><h4>Recorded order {recordedOrder.id}</h4>{snapshot(recordedOrder.lines,recordedOrder.estimate)}<p>Recorded {displayDate(recordedOrder.submittedAt)}. Vendor receipt is unconfirmed.</p><button disabled={busy} onClick={()=>downloadTextFile(`KERDOS_Order_${recordedOrder.id}.txt`,estimatedOrderExport(recordedOrder,{organizationId:orgId,draftId:selected.id,vendorName:vendorName(recordedOrder.vendorId)}),'text/plain;charset=utf-8')} style={btn('#003584','white')}>Export recorded order</button></section>}
      {canCancelSelected&&<button disabled={busy||loading} onClick={()=>setCancelTarget(selected.id)} style={btn('#E8F1FB','#003584')}>Cancel saved draft</button>}{canCancelSelected&&cancelTarget===selected.id&&<div><p>Cancel this draft? Saved terms and history will remain.</p><button disabled={busy} onClick={cancel} style={btn('#003584','white')}>Confirm cancellation</button><button disabled={busy} onClick={()=>setCancelTarget(null)} style={btn('#EEE','#444')}>Keep draft</button></div>}</article>}
    </section>}
  </div></MovableDialog>;
}
