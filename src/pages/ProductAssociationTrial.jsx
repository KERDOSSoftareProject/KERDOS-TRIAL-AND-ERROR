import {useMemo,useState,useEffect} from 'react';
import {buildProductAssociations} from '../core/product-associations.js';
import {productGroupRequest} from '../services/product-associations.js';
import {backend} from '../backend/index.js';
import {btn,inp} from '../ui/styles.js';

export function ProductAssociationTrial({industry,orgId,vendorItems,catalogItems,mappings,vendors,onUpdated,provider=backend,canManage=false}){
 const [open,setOpen]=useState(true),[query,setQuery]=useState(''),[busy,setBusy]=useState(false),[error,setError]=useState(''),[notice,setNotice]=useState('');
 const [pending,setPending]=useState(null),[history,setHistory]=useState([]),[historyEpoch,setHistoryEpoch]=useState(0);
 const [batch,setBatch]=useState(null);
 useEffect(()=>{
  let active=true;if(open&&provider.catalog.productGroupHistory)provider.catalog.productGroupHistory(orgId).then(rows=>{if(active)setHistory(rows);}).catch(e=>{if(active)setError(e.message);});
  return ()=>{active=false;};
 },[orgId,open,historyEpoch,provider]);
 const preview=useMemo(()=>open?buildProductAssociations({industry,vendorItems,catalogItems,mappings}):null,[open,industry,vendorItems,catalogItems,mappings]);
 const vendorNames=useMemo(()=>new Map(vendors.map(v=>[v.id,v.name])),[vendors]);
 async function save(group){
  setBusy(true);setError('');setNotice('');
  try{
   if(!provider.catalog.associateProductGroup)throw new Error('Product grouping is not available with this data provider.');
   // Keep the exact request after a lost reply; retrying cannot save twice.
   const request=pending?.groupKey===group.key?pending.request:productGroupRequest(group,mappings,{organizationId:orgId,requestId:crypto.randomUUID()});
   setPending({groupKey:group.key,request});
   await provider.catalog.associateProductGroup(request);
   setHistoryEpoch(n=>n+1);setPending(null);
   setNotice('Group saved. Vendor details and pricing evidence retained.');await onUpdated();
  }catch(e){setError(e.message);}finally{setBusy(false);}
 }
 async function restore(requestId){
  setBusy(true);setError('');try{
   await provider.catalog.restoreProductGroup({organizationId:orgId,requestId});
   setNotice('Previous associations restored.');setHistoryEpoch(n=>n+1);await onUpdated();
  }catch(e){setError(e.message);}finally{setBusy(false);}
 }
 async function applyGroups(){
  setBusy(true);setError('');
  const work=batch||{requests:preview.groups.filter(g=>g.canSave&&g.needsApply).map(g=>({...productGroupRequest(g,mappings,{organizationId:orgId,requestId:crypto.randomUUID()}),confirmed:false})),completed:0};
  setBatch(work);
  try{
   for(let i=work.completed;i<work.requests.length;i++){
    await provider.catalog.associateProductGroup(work.requests[i]);
    work.completed=i+1;setBatch({...work});setNotice(`Grouped ${work.completed} of ${work.requests.length} product groups.`);
   }
   setBatch(null);setHistoryEpoch(n=>n+1);setNotice('Product groups applied. Each vendor listing retains its own purchasing checks.');await onUpdated();
  }catch(e){setError(e.message+' Completed groups are retained; retry resumes the same remaining requests.');setHistoryEpoch(n=>n+1);}
  finally{setBusy(false);}
 }
 return <section style={{margin:'12px 0'}} aria-label="Product association trial">
  <button style={btn('#E8F1FB','#003584')} disabled={busy} onClick={()=>setOpen(!open)}>{open?'Hide product groups':'Show product groups'}</button>
  {open&&preview&&<div style={{padding:14,border:'1px solid #B9CDE4',borderRadius:8,marginTop:8}}>
   <h3 style={{marginTop:0}}>Product groups</h3>
   <p>{preview.total} listings · {preview.groups.length} proposed groups · {preview.unresolved.length} unresolved rows.</p>
   <p>One KERDOS item with its associated vendor listings. Different packs and brands remain visible. Applying groups organizes the catalog; each offer keeps its own purchasing checks.</p>
   {canManage&&<button disabled={busy||!!pending||(!batch&&!preview.groups.some(g=>g.canSave&&g.needsApply))} style={btn('#003584','white')} onClick={applyGroups}>{batch?'Resume applying product groups':'Apply product groups to catalog'}</button>}
   <input style={inp} aria-label="Search proposed groups" placeholder="Search product or vendor description" value={query} onChange={e=>setQuery(e.target.value)}/>
   {notice&&<p role="status">{notice}</p>}{error&&<p role="alert" style={{color:'#B42318'}}>{error}</p>}
   {canManage&&<details style={{padding:8}}><summary>My saved grouping trials ({history.length})</summary>{history.map(event=><div key={event.request_id} style={{padding:6}}>{event.payload.name} · {event.result.associated} listings · {new Date(event.created_at).toLocaleString()} {event.restored_at?'· restored':<button disabled={busy} onClick={()=>restore(event.request_id)}>Restore previous associations</button>}</div>)}</details>}
   {preview.groups.filter(g=>[g.label,...g.rows.map(v=>v.description)].some(t=>String(t).toLowerCase().includes(query.toLowerCase()))).map(g=><details key={g.key} style={{borderTop:'1px solid #DEE7F0',padding:8}}>
    <summary>{g.label} · {g.rows.length} listing{g.rows.length===1?'':'s'}{g.saved?' · associated':g.protected?' · existing decision retained':''}</summary>
    <p style={{fontSize:12}}>{g.reason}</p>
    {g.rows.map(row=><div key={row.id} style={{padding:6,borderBottom:'1px solid #EDF2F7'}}><strong>{vendorNames.get(row.vendor_id)||'Vendor'}</strong> · {row.vendor_item_code||'No item code'} · {row.description}<br/>{row.brand||'Brand not stated'} · {row.pack_size||'Pack missing'} · {row.price==null?'Price not stated':String(row.price)} · {row.selling_unit||'Quoted unit not stated'}</div>)}
    {canManage&&g.canSave&&<button style={{...btn('#003584','white'),marginTop:8}} disabled={busy||!!batch||(pending&&pending.groupKey!==g.key)} onClick={()=>save(g)}>{pending?.groupKey===g.key?'Retry same group save':'Confirm this product identity'}</button>}
   </details>)}
   <details style={{padding:8}}><summary>Unresolved source rows ({preview.unresolved.length})</summary>{preview.unresolved.map(({row,reason})=><p key={row.id}>{vendorNames.get(row.vendor_id)} · {row.description||'Missing description'} · {reason}</p>)}</details>
  </div>}
 </section>;
}
