import {suggestedAlternativeGroups} from "../core/alternative-groups.js";
import {useMemo,useState} from "react";
import {backend} from "../backend/index.js";
import {calculatedUnitCost} from "../core/quote-controls.js";
import {unitLabel} from "../core/unit-labels.js";
import {formatMoney} from "../localization.js";
import {btn,inp} from "../ui/styles.js";
export function AssociateAlternatives({orgId,selectedVendorIds,vendorItems,catalogItems,mappings,vendors,onUpdated,onClear}){
 const [open,setOpen]=useState(false),[target,setTarget]=useState(""),[name,setName]=useState(""),[preferred,setPreferred]=useState(""),[busy,setBusy]=useState(false),[error,setError]=useState("");
 const [suggestionIds,setSuggestionIds]=useState(null),[showSuggestions,setShowSuggestions]=useState(false);
 const suggestions=useMemo(()=>suggestedAlternativeGroups({vendorItems,catalogItems,mappings}),[vendorItems,catalogItems,mappings]);
 const automaticIds=[...new Set(vendorItems.filter(v=>v.field_resolutions?.automatic_group).map(v=>v.field_resolutions.automatic_group.catalogItemId))];
 const activeIds=suggestionIds||selectedVendorIds;
 const selected=vendorItems.filter(v=>activeIds.includes(v.id));
 const ids=new Set(mappings.filter(m=>activeIds.includes(m.vendor_item_id)).map(m=>m.catalog_item_id));
 const choices=catalogItems.filter(i=>ids.has(i.id));
 const brands=[...new Set(selected.map(v=>v.brand).filter(Boolean))];
 async function apply(){setBusy(true);setError("");try{
  if(!backend.catalog.associateAlternatives)throw new Error("This data provider does not support grouping alternatives yet.");
  await backend.catalog.associateAlternatives({organizationId:orgId,vendorItemIds:selected.map(v=>v.id),targetCatalogItemId:target,name,preferredBrand:preferred,revisions:Object.fromEntries(selected.map(v=>[v.id,v.row_revision||0]))});
  setOpen(false);setSuggestionIds(null);onClear();await onUpdated();
 }catch(e){setError(e.message);}finally{setBusy(false);}}
 function review(ids){
  const linked=new Set(mappings.filter(m=>ids.includes(m.vendor_item_id)).map(m=>m.catalog_item_id));
  const first=catalogItems.find(i=>linked.has(i.id));setSuggestionIds(ids);setTarget(first?.id||"");setName(first?.name||"");setPreferred("");setError("");setOpen(true);
 }
 async function separate(id){setBusy(true);setError("");try{await backend.catalog.separateAutomaticAlternatives({organizationId:orgId,targetCatalogItemId:id});await onUpdated();}catch(e){setError(e.message);}finally{setBusy(false);}}
 return <><button disabled={selectedVendorIds.length<2} onClick={()=>review(selectedVendorIds)} style={btn("#E8F1FB","#003584",{fontSize:12,margin:6})}>Associate selected ({selectedVendorIds.length})</button>
 {selectedVendorIds.length>0&&<button onClick={onClear} style={{fontSize:12}}>Clear selection</button>}
 <button onClick={()=>setShowSuggestions(!showSuggestions)} style={{fontSize:12,margin:6}}>{showSuggestions?"Hide":"Review"} suggested associations ({suggestions.length})</button>
 {showSuggestions&&<div style={{padding:10,border:"1px solid #ddd",borderRadius:6}}>
 <p>Clear matches group automatically across brands. These suggestions need your review. Brand restrictions and missing pricing details still apply.</p>
 {automaticIds.map(id=><div key={id} style={{margin:6}}>Automatically grouped: #{catalogItems.find(i=>i.id===id)?.master_item_number} {catalogItems.find(i=>i.id===id)?.name} <button disabled={busy} onClick={()=>separate(id)}>Separate group</button></div>)}
 {suggestions.map((g,index)=><div key={index} style={{borderTop:"1px solid #ddd",padding:8}}>{g.rows.map(v=><div key={v.id}>{vendors.find(x=>x.id===v.vendor_id)?.name} · {v.description} · {v.brand||"Brand not stated"} · {v.pack_size||"Pack missing"}</div>)}<div style={{fontSize:12}}>{g.reason}</div><div style={{display:"flex",gap:6,marginTop:6}}>
      <button disabled={busy} onClick={()=>review(g.rows.map(v=>v.id))} style={{...btn("#E8F1FB","#003584",{fontSize:11})}}>Review and approve</button>
      <button disabled={busy} style={{...btn("#003584","white",{fontSize:11})}} onClick={async()=>{
        setBusy(true);setError("");
        try{
          const ids=g.rows.map(v=>v.id);
          const linked=new Set(mappings.filter(m=>ids.includes(m.vendor_item_id)).map(m=>m.catalog_item_id));
          // Use the entry with the lowest KERDOS number as the target —
          // that is always the established item, not the newly created one.
          const linked_items=catalogItems.filter(i=>linked.has(i.id)).sort((a,b)=>Number(a.master_item_number)-Number(b.master_item_number));
          const first=linked_items[0];
          if(!first)throw new Error("Could not find the KERDOS entry.");
          await backend.catalog.associateAlternatives({organizationId:orgId,vendorItemIds:ids,targetCatalogItemId:first.id,name:first.name,preferredBrand:"",revisions:Object.fromEntries(ids.map(id=>[id,{}]))});
          onClear();await onUpdated();
        }catch(e){setError(e.message);}finally{setBusy(false);}
      }}>Accept all shown</button>
    </div></div>)}
 {!suggestions.length&&<p>No uncertain associations found.</p>}
 {error&&!open&&<p role="alert" style={{color:"#B42318"}}>{error}</p>}
 </div>}
 {open&&<div role="dialog" aria-modal="true" aria-label="Associate alternatives" style={{position:"fixed",inset:0,background:"#0006",zIndex:1100,display:"grid",placeItems:"center"}}><div style={{background:"white",padding:24,borderRadius:10,maxWidth:680,width:"90vw",maxHeight:"85vh",overflowY:"auto"}}>
 <p>Approve these products as acceptable alternatives. They will share the selected KERDOS number and keep each vendor's brand, description and pack. Missing pricing details still need completion.</p>
 {selected.map(v=>{const cost=calculatedUnitCost(v);return <div key={v.id} style={{padding:7,borderBottom:"1px solid #ddd"}}>{vendors.find(x=>x.id===v.vendor_id)?.name} · {v.description} · {v.brand||"Brand not stated"} · {v.pack_size||"Pack missing"} · {cost?`${formatMoney(cost.price)} / ${unitLabel(cost.unit)}`:"Unit cost incomplete"}</div>;})}
 <label style={{display:"block",marginTop:12}}>Shared KERDOS item<select style={inp} value={target} onChange={e=>setTarget(e.target.value)}>{choices.map(i=><option key={i.id} value={i.id}>#{i.master_item_number} {i.name}</option>)}</select></label>
 <label style={{display:"block",marginTop:12}}>Item type<input style={inp} value={name} onChange={e=>setName(e.target.value)}/></label>
 <label style={{display:"block",marginTop:12}}>Preferred brand (optional)<select style={inp} value={preferred} onChange={e=>setPreferred(e.target.value)}><option value="">No preference</option>{brands.map(b=><option key={b} value={b}>{b}</option>)}</select></label>
 {error&&<p role="alert" style={{color:"#B42318"}}>{error}</p>}
 <button disabled={busy} onClick={apply} style={btn("#003584","white",{marginTop:16})}>{busy?"Associating…":"Approve alternatives"}</button><button disabled={busy} onClick={()=>{setOpen(false);setSuggestionIds(null);}} style={{marginLeft:12}}>Cancel</button>
 </div></div>}</>;
}
