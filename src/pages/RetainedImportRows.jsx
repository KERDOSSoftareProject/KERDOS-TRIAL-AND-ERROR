import {useEffect,useState} from "react";
import {retainedUnlinkedRows} from "../core/retained-import-rows.js";
import {formatMoney} from "../localization.js";

export function RetainedImportRows({orgId,vendors,service,search=""}){
  const [state,setState]=useState({orgId:null,rows:[],error:""});
  const [limit,setLimit]=useState(25);
  useEffect(()=>{
    let active=true;
    if(!orgId)return;
    service.retainedPartialDocuments(orgId).then(documents=>{
      if(active)setState({orgId,rows:retainedUnlinkedRows(documents),error:""});
    }).catch(error=>{if(active)setState({orgId,rows:[],error:error.message});});
    return ()=>{active=false;};
  },[orgId,service]);
  if(state.orgId!==orgId)return null;
  if(state.error)return <div role="alert">{state.error}</div>;
  const names=new Map(vendors.map(v=>[v.id,v.name]));
  const query=search.trim().toLowerCase();
  const rows=state.rows.filter(row=>!query||[row.description,row.code,row.fileName,names.get(row.vendorId)].some(value=>String(value||"").toLowerCase().includes(query)));
  if(!rows.length)return null;
  return <section aria-label="Retained incoming rows" style={{background:"#FFF3E0",color:"#593500",borderRadius:10,padding:16,marginBottom:16}}>
    <h4 style={{margin:"0 0 8px"}}>Saved incoming rows · {rows.length} not yet linked</h4>
    <p>These source rows are preserved. Their listing or save needs attention; they are not confirmed catalog matches and are not used for ordering.</p>
    {rows.slice(0,limit).map(row=><div key={row.id} style={{borderTop:"1px solid #D7B88B",padding:"10px 0"}}>
      <strong>{row.description||"Description not stated"}</strong>
      <div>{names.get(row.vendorId)||"Vendor unavailable"}{row.code?` · Vendor #${row.code}`:" · Vendor item identity unresolved"}</div>
      <div>Pack: {row.packSize||"Not stated"} · Amount: {row.price==null?"Not stated":formatMoney(row.price)} · Quoted per: {row.sellingUnit||"Unconfirmed"}</div>
      <details><summary>Source evidence</summary><div>{row.fileName} · source row {Number(row.key.slice(4))+1}{row.position?.page?` · page ${row.position.page}`:""}</div><pre style={{whiteSpace:"pre-wrap"}}>{row.sourceLine||(row.position?.cells||[]).join(" | ")}</pre></details>
    </div>)}
    {rows.length>limit&&<button onClick={()=>setLimit(value=>value+25)}>Show more saved rows</button>}
  </section>;
}
