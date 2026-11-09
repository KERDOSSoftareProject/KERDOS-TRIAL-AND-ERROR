import {useEffect,useMemo,useRef,useState} from 'react';
import {createCatalogRowsService} from '../services/catalog-rows.js';
import {formatMoney} from '../localization.js';

const PRICE_AUTOSAVE_DELAY_MS=700;

// The App owns the draft so closing the listing menu cannot cancel its save.
export function useOrderGuidePriceAutosave({backend,organizationId,userId,canManage,vendorItems,mappings,onSaved}){
 const scope=useMemo(()=>({backend,organizationId,userId,canManage}),[backend,organizationId,userId,canManage]);
 const activeScope=useRef(scope);activeScope.current=scope;
 useEffect(()=>{activeScope.current=scope;return ()=>{if(activeScope.current===scope)activeScope.current=null;};},[scope]);
 const [state,setState]=useState({scope,rows:{}});
 const drafts=state.scope===scope?state.rows:null;
 const waiting=Object.values(drafts||{}).filter(draft=>draft.phase==='waiting').sort((a,b)=>a.dueAt-b.dueAt)[0];
 const saving=Object.values(drafts||{}).some(draft=>draft.phase==='saving');
 function update(id,change){
  setState(previous=>{
   const rows={...(previous.scope===scope?previous.rows:{})};
   if(change)rows[id]=change;else delete rows[id];
   return {scope,rows};
  });
 }
 function edit(id,raw){
  if(!canManage||drafts?.[id]?.phase==='saving')return;
  const row=vendorItems.find(item=>item.id===id);
  const value=Number(raw);
  const invalid=!String(raw).trim()||!Number.isFinite(value)||value<=0;
  if(!invalid&&Number(row?.price)===value){update(id,null);return;}
  const revision=drafts?.[id]?.phase==='waiting'?drafts[id].revision:row?.row_revision||0;
  update(id,{id,raw,value,revision,dueAt:Date.now()+PRICE_AUTOSAVE_DELAY_MS,phase:invalid?'error':'waiting',error:invalid?'Enter a price above zero.':''});
 }
 function flush(id){
  if(!canManage)return;
  setState(previous=>{
   const draft=previous.scope===scope?previous.rows[id]:null;
   if(draft?.phase!=='waiting'||draft.dueAt===0)return previous;
   return {...previous,rows:{...previous.rows,[id]:{...draft,dueAt:0}}};
  });
 }
 useEffect(()=>{
  if(!canManage||!waiting||saving)return;
  const timer=setTimeout(async()=>{
   if(activeScope.current!==scope)return;
   const {id,value,revision}=waiting;
   update(id,{...waiting,phase:'saving'});
   let vendorItem,mapping;
   try{
    vendorItem=vendorItems.find(row=>row.id===id);
    mapping=mappings.find(row=>row.vendor_item_id===id);
    await createCatalogRowsService(backend).save({organizationId,vendorItem:vendorItem&&{...vendorItem,row_revision:revision},mapping,patch:{price:value}});
   }catch(reason){
    if(activeScope.current===scope)update(id,{...waiting,phase:'error',error:reason.message||'Price could not be saved.'});
    return;
   }
   if(activeScope.current!==scope)return;
   try{
    await onSaved(vendorItem,mapping);
    if(activeScope.current===scope)update(id,{phase:'saved'});
   }catch{
    if(activeScope.current===scope)update(id,{phase:'saved',error:'Price saved. Refresh to load the updated listing.'});
   }
  },Math.max(0,waiting.dueAt-Date.now()));
  return ()=>clearTimeout(timer);
 },[backend,scope,canManage,waiting,saving]);
 return {drafts:drafts||{},edit,flush,discard:id=>update(id,null)};
}

export function OrderGuideListings({canManage,offers,selectedId,vendorItems,unit='case',onSelect,priceEdits}){
 return <div role="region" aria-label="Group listings" data-price-menu style={{padding:'8px 0',minWidth:0}}>
  <div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse',fontSize:12,textAlign:'left'}}>
   <thead><tr>{['Vendor','Product','Brand','Pack','Unit','Price',''].map((label,i)=><th key={i} style={{padding:6,fontSize:10,color:'#667085',fontWeight:600}}>{label}</th>)}</tr></thead>
   <tbody>{offers.map(offer=>{
    const row=vendorItems.find(value=>value.id===offer.vendorItemId);
    const draft=priceEdits.drafts[offer.vendorItemId];
    const status=draft?.error||(draft?.phase==='waiting'?'Waiting to save…':draft?.phase==='saving'?'Saving…':draft?.phase==='saved'?'Saved':'');
    return <tr key={offer.vendorItemId} style={{borderTop:'1px solid #E6EAF0'}}>
     <td style={{padding:6}}><button type="button" aria-label={`Select ${offer.vendorName} listing ${offer.vendorItemCode||offer.vendorItemId}`} aria-pressed={selectedId===offer.vendorItemId} onClick={()=>onSelect(offer)} style={{padding:6,border:'1px solid #CBD5E1',borderRadius:5,background:'white',cursor:'pointer',fontSize:12}}>{selectedId===offer.vendorItemId?'✓ ':''}{offer.vendorName}</button></td>
     <td style={{padding:6,minWidth:170}}>{offer.description}<small style={{display:'block',color:'#667085'}}>{offer.vendorItemCode}</small></td>
     <td style={{padding:6}}>{offer.brand||'—'}</td><td style={{padding:6,whiteSpace:'nowrap'}}>{offer.packSize||'—'}</td><td style={{padding:6}}>{row?.selling_unit||'—'}</td>
     <td style={{padding:6}}><input aria-label={`Price for listing ${offer.vendorItemId}`} type="number" min="0.01" step="any" disabled={!canManage||draft?.phase==='saving'} value={draft?.raw??row?.price??''}
      onChange={event=>priceEdits.edit(offer.vendorItemId,event.target.value)} onBlur={()=>priceEdits.flush(offer.vendorItemId)}
      onKeyDown={event=>{if(event.key==='Enter'){event.preventDefault();priceEdits.flush(offer.vendorItemId);}}} style={{width:85,padding:6,border:'1px solid #CBD5E1',borderRadius:5}}/>
      {unit==='each'&&<small style={{display:'block',color:'#667085'}}>Quoted price · {offer.eachPrice==null?'—':formatMoney(offer.eachPrice)+'/each'}</small>}
     </td><td style={{padding:6}}>{status&&<small role={draft.error?'alert':'status'} style={{display:'block',color:draft.error?'#B42318':'#276742'}}>{status}</small>}
      {canManage&&draft?.phase==='error'&&<><button type="button" onClick={()=>priceEdits.edit(offer.vendorItemId,draft.raw)}>Retry</button><button type="button" onClick={()=>priceEdits.discard(offer.vendorItemId)}>Discard edit</button></>}
     </td>
    </tr>;
   })}</tbody>
  </table></div>
 </div>;
}
