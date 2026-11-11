import {useEffect,useMemo,useRef,useState} from 'react';
import {createCatalogRowsService} from '../services/catalog-rows.js';
import {formatMoney} from '../localization.js';
import {orderable} from '../core/ordering.js';

const LISTING_AUTOSAVE_DELAY_MS=700;

// The App owns the draft so closing the listing menu cannot cancel its save.
export function useOrderGuideListingAutosave({backend,organizationId,userId,canManage,vendorItems,mappings,onSaved}){
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
 function queue(id,patch,revision){
  if(!Object.keys(patch).length){update(id,null);return;}
  const price=patch.price;
  const invalid=Object.hasOwn(patch,'price')&&String(price).trim()&&(!Number.isFinite(Number(price))||Number(price)<=0);
  update(id,{id,patch,revision,dueAt:Date.now()+LISTING_AUTOSAVE_DELAY_MS,phase:invalid?'error':'waiting',error:invalid?'Enter a price above zero.':''});
 }
 function edit(id,field,raw){
  const draft=drafts?.[id];
  if(!canManage||draft?.phase==='saving')return;
  const row=vendorItems.find(item=>item.id===id);
  if(!row)return;
  const patch={...draft?.patch,[field]:raw};
  const unchanged=field==='price'&&String(raw).trim()&&row.price!=null?Number(raw)===Number(row.price):String(raw)===String(row[field]??'');
  if(unchanged)delete patch[field];
  queue(id,patch,draft?.revision??(row.row_revision||0));
 }
 function retry(id){
  const draft=drafts?.[id],row=vendorItems.find(item=>item.id===id);
  if(canManage&&draft?.phase==='error'&&row)queue(id,draft.patch,row.row_revision||0);
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
   const {id,patch,revision}=waiting;
   update(id,{...waiting,phase:'saving'});
   let vendorItem,mapping;
   try{
    vendorItem=vendorItems.find(row=>row.id===id);
    mapping=mappings.find(row=>row.vendor_item_id===id);
    const quoteChanged=['price','pack_size','selling_unit'].some(field=>Object.hasOwn(patch,field));
    const correction=quoteChanged&&vendorItem?.field_resolutions?.unit_cost_override?{...patch,unit_cost_override:null}:patch;
    await createCatalogRowsService(backend).save({organizationId,vendorItem:vendorItem&&{...vendorItem,row_revision:revision},mapping,patch:correction});
   }catch(reason){
    if(activeScope.current===scope)update(id,{...waiting,phase:'error',error:reason.message||'Listing could not be saved.'});
    return;
   }
   if(activeScope.current!==scope)return;
   try{
    await onSaved(vendorItem,mapping,patch);
    if(activeScope.current===scope)update(id,{phase:'saved'});
   }catch{
    if(activeScope.current===scope)update(id,{phase:'saved',error:'Listing saved. Refresh to load the updated values.'});
   }
  },Math.max(0,waiting.dueAt-Date.now()));
  return ()=>clearTimeout(timer);
 },[backend,scope,canManage,waiting,saving]);
 return {drafts:drafts||{},edit,flush,retry,discard:id=>update(id,null)};
}

const editorStyle={padding:6,border:'1px solid #CBD5E1',borderRadius:5,boxSizing:'border-box',width:'100%'};

export function OrderGuideListings({canManage,offers,selectedId,vendorItems,unit='case',onSelect,listingEdits}){
 return <div role="region" aria-label="Group listings" data-price-menu style={{padding:'8px 0',minWidth:0}}>
  <div style={{overflowX:'auto'}}><table className="mobile-edit-table" role="table" aria-label="Vendor offers" style={{width:'100%',borderCollapse:'collapse',fontSize:12,textAlign:'left'}}>
   <thead><tr>{['Vendor','Product','Brand','Pack','Price','Unit Price',''].map((label,i)=><th key={i} style={{padding:6,fontSize:10,color:'#667085',fontWeight:600}}>{label}</th>)}</tr></thead>
   <tbody role="rowgroup">{offers.map(offer=>{
    const row=vendorItems.find(value=>value.id===offer.vendorItemId);
    const id=offer.vendorItemId;
    const rate=orderable(offer)?offer.perUnit:null;
    const draft=listingEdits.drafts[id];
    const status=draft?.error||(draft?.phase==='waiting'?'Waiting to save…':draft?.phase==='saving'?'Saving…':draft?.phase==='saved'?'Saved':'');
    const value=field=>draft?.patch?.[field]??row?.[field]??'';
    const disabled=!canManage||!row||draft?.phase==='saving';
    const flush=()=>listingEdits.flush(id);
    const onEnter=event=>{if(event.key==='Enter'){event.preventDefault();flush();}};
    const input=(field,label,{style,...options}={})=> <input aria-label={`${label} for listing ${id}`} style={{...editorStyle,...style}} disabled={disabled} value={value(field)}
      onChange={event=>listingEdits.edit(id,field,event.target.value)} onBlur={flush} onKeyDown={onEnter} {...options}/>;
    return <tr role="row" key={offer.vendorItemId} style={{borderTop:'1px solid #E6EAF0'}}>
     <td role="cell" data-field-label="Vendor" data-mobile-wide style={{padding:6}}><button type="button" aria-label={`Select ${offer.vendorName} listing ${offer.vendorItemCode||offer.vendorItemId}`} aria-pressed={selectedId===offer.vendorItemId} onClick={()=>onSelect(offer)} style={{padding:6,border:'1px solid #CBD5E1',borderRadius:5,background:'white',cursor:'pointer',fontSize:12}}>{selectedId===offer.vendorItemId?'✓ ':''}{offer.vendorName}</button></td>
     <td role="cell" data-field-label="Product" data-mobile-wide style={{padding:6,minWidth:170}}>{input('description','Product')}<small style={{display:'block',color:'#667085'}}>{offer.vendorItemCode}</small></td>
     <td role="cell" data-field-label="Brand" style={{padding:6,minWidth:85}}>{input('brand','Brand',{placeholder:'No brand'})}</td>
     <td role="cell" data-field-label="Pack" style={{padding:6,minWidth:90}}>{input('pack_size','Pack',{placeholder:'4/1 GAL'})}</td>
     <td role="cell" data-field-label="Price" style={{padding:6}}>{input('price','Price',{style:{width:85},type:'number',min:'0.01',step:'any'})}
      {unit==='each'&&<small style={{display:'block',color:'#667085'}}>Quoted price · {offer.eachPrice==null?'—':formatMoney(offer.eachPrice)+'/each'}</small>}
     </td>
     <td role="cell" data-field-label="Unit Price" style={{padding:6,whiteSpace:'nowrap'}}>{rate?
      `${formatMoney(rate.price)} / ${rate.unit==='FLOZ'?'fl oz':rate.unit.toLowerCase()}`:'—'}</td>
     <td role="cell" data-mobile-wide style={{padding:6}}>{status&&<small role={draft.error?'alert':'status'} style={{display:'block',color:draft.error?'#B42318':'#276742'}}>{status}</small>}
      {canManage&&draft?.phase==='error'&&<><button type="button" onClick={()=>listingEdits.retry(id)}>Retry</button><button type="button" onClick={()=>listingEdits.discard(id)}>Discard edit</button></>}
     </td>
    </tr>;
   })}</tbody>
  </table></div>
 </div>;
}
