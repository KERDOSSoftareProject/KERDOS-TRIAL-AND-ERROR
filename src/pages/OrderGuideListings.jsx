import {useState} from 'react';
import {createCatalogRowsService} from '../services/catalog-rows.js';
import {formatMoney} from '../localization.js';
import {blockReason,orderable} from '../core/ordering.js';

// The source listing and its optimistic revision are the same records edited
// in Item Catalog. A price edit confirms only price, never unrelated fields.
export function OrderGuideListings({backend,organizationId,canManage,offers,selectedId,vendorItems,mappings,unit='case',onSelect,onApplied}){
 const [drafts,setDrafts]=useState({}),[busy,setBusy]=useState(null),[error,setError]=useState('');
 const [saved,setSaved]=useState('');
 async function apply(offer){
  const raw=drafts[offer.vendorItemId],value=Number(raw);
  if(raw==null||String(raw).trim()===''||!Number.isFinite(value)||value<=0){setError('Enter a price above zero.');return;}
  setBusy(offer.vendorItemId);setError('');setSaved('');
  try{
   const vendorItem=vendorItems.find(row=>row.id===offer.vendorItemId);
   const mapping=mappings.find(row=>row.vendor_item_id===offer.vendorItemId);
   await createCatalogRowsService(backend).save({organizationId,vendorItem,mapping,patch:{price:value}});
   await onApplied(offer);
   setDrafts(previous=>{const next={...previous};delete next[offer.vendorItemId];return next;});
   setSaved(`Saved ${offer.vendorName} price.`);
  }catch(reason){setError(reason.message||'Price could not be saved.');}
  finally{setBusy(null);}
 }
 return <div role="region" aria-label="Group listings" data-price-menu style={{padding:'8px 0',minWidth:0}}>
  <div style={{overflowX:'auto'}}><table style={{width:'100%',borderCollapse:'collapse',fontSize:12,textAlign:'left'}}>
   <thead><tr>{['Vendor','Product','Brand','Pack','Unit','Price',''].map((label,i)=><th key={i} style={{padding:6,fontSize:10,color:'#667085',fontWeight:600}}>{label}</th>)}</tr></thead>
   <tbody>{offers.map(offer=>{
    const row=vendorItems.find(value=>value.id===offer.vendorItemId);
    return <tr key={offer.vendorItemId} style={{borderTop:'1px solid #E6EAF0'}}>
     <td style={{padding:6}}><button type="button" aria-label={`Select ${offer.vendorName} listing ${offer.vendorItemCode||offer.vendorItemId}`} aria-pressed={selectedId===offer.vendorItemId} onClick={()=>onSelect(offer)} style={{padding:6,border:'1px solid #CBD5E1',borderRadius:5,background:'white',cursor:'pointer',fontSize:12}}>{selectedId===offer.vendorItemId?'✓ ':''}{offer.vendorName}</button></td>
     <td style={{padding:6,minWidth:170}}>{offer.description}<small style={{display:'block',color:'#667085'}}>{offer.vendorItemCode}</small></td>
     <td style={{padding:6}}>{offer.brand||'—'}</td><td style={{padding:6,whiteSpace:'nowrap'}}>{offer.packSize||'—'}</td><td style={{padding:6}}>{row?.selling_unit||'—'}</td>
     <td style={{padding:6}}><input aria-label={`Price for listing ${offer.vendorItemId}`} type="number" min="0.01" step="any" disabled={!canManage||busy!=null} value={drafts[offer.vendorItemId]??row?.price??''} onChange={event=>{setDrafts(previous=>({...previous,[offer.vendorItemId]:event.target.value}));setSaved('');}} onKeyDown={event=>{if(event.key==='Enter'&&canManage&&busy==null)void apply(offer);}} style={{width:85,padding:6,border:'1px solid #CBD5E1',borderRadius:5}}/>
      {unit==='each'&&<small style={{display:'block',color:'#667085'}}>Quoted price · {offer.eachPrice==null?'—':formatMoney(offer.eachPrice)+'/each'}</small>}
     </td><td style={{padding:6}}>{canManage&&<button type="button" aria-label={`Apply price for listing ${offer.vendorItemId}`} disabled={busy!=null||drafts[offer.vendorItemId]==null} onClick={()=>void apply(offer)} style={{padding:'7px 10px',background:'#003584',color:'white',border:0,borderRadius:5,cursor:'pointer',fontSize:12}}>{busy===offer.vendorItemId?'Saving…':'Apply'}</button>}
      {!orderable(offer)&&<details style={{marginTop:4,color:'#875200',fontSize:11}}><summary>Review</summary>{blockReason(offer)}</details>}
     </td>
    </tr>;
   })}</tbody>
  </table></div>
  {error&&<div role="alert" style={{color:'#B42318',padding:6}}>{error}</div>}
  {saved&&<div role="status" style={{color:'#276742',padding:6}}>{saved}</div>}
 </div>;
}
