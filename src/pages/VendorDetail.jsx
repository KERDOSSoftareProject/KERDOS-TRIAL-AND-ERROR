import {useState} from "react";
import {backend} from "../backend/index.js";
import {createCatalogService,mappingVerification} from "../services/catalog.js";
import {createVendorService} from "../services/vendors.js";
import {currencyCode,formatDate,formatMoney} from "../localization.js";
import {quoteStatus} from "../procurement.js";
import {btn,inp} from "../ui/styles.js";

const catalogService=createCatalogService(backend);
const vendorService=createVendorService(backend);

export function VendorDetail({vendor,vc,vendorItems,invoices,purchaseOrders,priceHistory,mappings,catalogItems,orgId,myRole,onViewOriginal,onBack,onUpdated,onEditInvoice,onDeleteInvoice,onExpireOne,onImport,orgSettings,hasMorePrices,loadingMorePrices,onLoadMorePrices}) {
  const [editing,setEditing]=useState(false);
  const [name,setName]=useState(vendor.name);
  const [email,setEmail]=useState(vendor.email||"");
  const [minDollar,setMinDollar]=useState(vendor.delivery_minimum_dollar||"");
  const [minUnits,setMinUnits]=useState(vendor.delivery_minimum_units||"");
  const [saving,setSaving]=useState(false);
  const [error,setError]=useState("");
  const [priceEditId,setPriceEditId]=useState(null);
  const [priceEditValue,setPriceEditValue]=useState("");
  const [itemSearch,setItemSearch]=useState("");
  const [showItems,setShowItems]=useState(false);
  const [mapEditId,setMapEditId]=useState(null);
  const [mapEditValue,setMapEditValue]=useState("");
  const [mapError,setMapError]=useState("");
  const [mapBusy,setMapBusy]=useState(false);
  const [expandedOrderId,setExpandedOrderId]=useState(null);
  const [expandedPeriod,setExpandedPeriod]=useState(null);

  const canManage = myRole==="owner"||myRole==="manager";

  async function saveVendorDetails(){
    setSaving(true); setError("");
    try{await vendorService.update(vendor.id,{name:name.trim(),email:email.trim()||null,delivery_minimum_dollar:minDollar?parseFloat(minDollar):null,delivery_minimum_units:minUnits?parseInt(minUnits,10):null});}
    catch(err){setError(err.message);setSaving(false);return;}
    setEditing(false); setSaving(false);
    onUpdated();
  }

  async function deactivateVendor(){
    if(!window.confirm(`Remove ${vendor.name} from your active vendors? This can only be undone from the database directly.`)) return;
    setError("");
    try{
      await vendorService.deactivate(vendor.id);
      onUpdated();
      onBack();
    }catch(err){ setError(err.message); }
  }

  async function savePriceEdit(item){
    const newPrice=parseFloat(priceEditValue);
    if(isNaN(newPrice)||newPrice<=0){ setPriceEditId(null); return; }
    setError("");
    try{
      if(Math.abs((item.price||0)-newPrice)>0.001){
        await vendorService.recordManualPrice({organizationId:orgId,item,price:newPrice});
      }
      setPriceEditId(null);
      onUpdated();
    }catch(err){ setError(err.message); }
  }

  const items = vendorItems.filter(vi=>vi.vendor_id===vendor.id
    && (!itemSearch || vi.description.toLowerCase().includes(itemSearch.toLowerCase())));
  const vendorInvoices = invoices.filter(inv=>inv.vendor_id===vendor.id);
  const vendorOrders = (purchaseOrders||[]).filter(po=>po.vendor_id===vendor.id);

  // Looks up the current client-item mapping (if any) for a vendor item,
  // so the item list can show what it's linked to and let that be
  // corrected directly, not just items the matching engine happened to
  // flag as uncertain.
  const ciById=new Map((catalogItems||[]).map(ci=>[ci.id,ci]));
  function mappingFor(vendorItemId){
    const m=(mappings||[]).find(m=>m.vendor_item_id===vendorItemId);
    if(!m) return {mapping:null,catalogItem:null};
    return {mapping:m,catalogItem:ciById.get(m.catalog_item_id)||null};
  }

  async function saveItemMapping(vendorItem){
    setMapError("");
    const target=(catalogItems||[]).find(ci=>ci.id===mapEditValue);
    if(!target){ setMapError("Choose a catalog item."); return; }
    setMapBusy(true);
    const {mapping}=mappingFor(vendorItem.id);
    try{
      const linked=(mappings||[]).filter(link=>link.catalog_item_id===target.id&&link.vendor_item_id!==vendorItem.id).map(link=>vendorItems.find(item=>item.id===link.vendor_item_id)).filter(Boolean);
      const verification=mappingVerification(vendorItem,target,linked);
      await catalogService.assignVendorItem({organizationId:orgId,vendorItemId:vendorItem.id,catalogItemId:target.id,mappingId:mapping?.id||null,verification});
      setMapEditId(null); setMapEditValue("");
      onUpdated();
    }catch(err){ setMapError(err.message); }
    setMapBusy(false);
  }

  const vendorItemIds=new Set(vendorItems.filter(vi=>vi.vendor_id===vendor.id).map(vi=>vi.id));
  const vendorPricePeriods=(()=>{
    const groups=new Map();
    (priceHistory||[]).forEach(ph=>{
      if(!vendorItemIds.has(ph.vendor_item_id)) return;
      if(!groups.has(ph.effective_date)) groups.set(ph.effective_date,[]);
      groups.get(ph.effective_date).push(ph);
    });
    return [...groups.entries()]
      .map(([date,entries])=>({date,entries}))
      .sort((a,b)=>new Date(b.date)-new Date(a.date));
  })();

  return (
    <div>
      <button onClick={onBack} style={{background:"none",border:"none",cursor:"pointer",color:"rgba(255,255,255,0.75)",fontSize:13,marginBottom:14,padding:0}}>← Back</button>
      {error&&!editing&&<div style={{background:"#FFF3E0",color:"#E65100",padding:"10px 12px",borderRadius:8,fontSize:13,marginBottom:14}}>{error}</div>}
      <div style={{background:"white",borderRadius:12,padding:20,marginBottom:14,boxShadow:"0 1px 3px rgba(0,0,0,0.08)"}}>
        {!editing?(<>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",marginBottom:14}}>
            <div>
              <div style={{fontWeight:900,fontSize:20,color:vc.accent}}>{vendor.name}</div>
              <div style={{fontSize:12,color:"#888",marginTop:2}}>{vendorItems.filter(vi=>vi.vendor_id===vendor.id).length} items · Min {formatMoney(vendor.delivery_minimum_dollar)} · {vendor.delivery_minimum_units||0} units</div>
              {vendor.email&&<div style={{fontSize:12,color:"#888",marginTop:2}}>✉️ {vendor.email}</div>}
            </div>
            <div style={{display:"flex",flexDirection:"column",alignItems:"flex-end",gap:6}}>
              <a href={`https://www.google.com/search?q=${encodeURIComponent(vendor.name)}`} target="_blank" rel="noreferrer"
                style={{fontSize:12,color:"#003584",textDecoration:"none",fontWeight:700}}>Research ↗</a>
              {canManage&&<button onClick={()=>setEditing(true)} style={{background:"none",border:"none",cursor:"pointer",color:"#888",fontSize:12,padding:0}}>✎ Edit</button>}
            </div>
          </div>
          {vendorItems.filter(vi=>vi.vendor_id===vendor.id).length===0
            ? <div style={{fontSize:13,color:"#555",background:"#F0F6FF",padding:"12px 14px",borderRadius:8,display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                <span>No imported items yet for {vendor.name}.</span>
                {canManage&&onImport&&<button onClick={()=>onImport(vendor.id)}
                  style={{fontSize:12,fontWeight:700,padding:"6px 14px",borderRadius:6,background:"#003584",color:"white",border:"none",cursor:"pointer",whiteSpace:"nowrap",marginLeft:12}}>
                  Import price sheet
                </button>}
              </div>
            : <div style={{fontSize:12,color:"#777",background:"#F7F9FC",padding:"9px 11px",borderRadius:7}}>
                Import more price sheets from the Price Sheets tab or invoices from the Invoices tab.
              </div>
          }
        </>):(<>
          <div style={{marginBottom:10}}>
            <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Vendor name</div>
            <input style={inp} value={name} onChange={e=>setName(e.target.value)} />
          </div>
          <div style={{marginBottom:10}}>
            <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Email — where to send orders</div>
            <input style={inp} type="email" value={email} onChange={e=>setEmail(e.target.value)} placeholder="orders@vendor.com" />
          </div>
          <div style={{display:"flex",gap:8,marginBottom:10}}>
            <div style={{flex:1}}>
              <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Min order ({currencyCode()})</div>
              <input style={inp} type="number" value={minDollar} onChange={e=>setMinDollar(e.target.value)} />
            </div>
            <div style={{flex:1}}>
              <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Min items</div>
              <input style={inp} type="number" value={minUnits} onChange={e=>setMinUnits(e.target.value)} />
            </div>
          </div>
          {error&&<div style={{color:"#E65100",fontSize:12,marginBottom:10}}>{error}</div>}
          <div style={{display:"flex",gap:8,marginBottom:10}}>
            <button onClick={()=>setEditing(false)} style={{...btn("#EEE","#555"),flex:1}}>Cancel</button>
            <button onClick={saveVendorDetails} disabled={saving} style={{...btn("#003584"),flex:2}}>{saving?"Saving...":"Save changes"}</button>
          </div>
          {myRole==="owner"&&(
            <button onClick={deactivateVendor} style={{background:"none",border:"none",cursor:"pointer",color:"#E65100",fontSize:12,padding:0}}>Remove this vendor</button>
          )}
        </>)}
      </div>

      <div style={{background:"white",borderRadius:12,marginBottom:14,boxShadow:"0 1px 3px rgba(0,0,0,0.08)",overflow:"hidden"}}>
        <button onClick={()=>setShowItems(!showItems)} style={{width:"100%",background:"none",border:"none",cursor:"pointer",padding:"14px 18px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <span style={{fontWeight:700,fontSize:14}}>Items & Pricing ({vendorItems.filter(vi=>vi.vendor_id===vendor.id).length})</span>
          <span style={{color:"#CCC"}}>{showItems?"▲":"▼"}</span>
        </button>
        {showItems&&(
          <div style={{padding:"0 18px 16px"}}>
            <input style={{...inp,marginBottom:10}} value={itemSearch} onChange={e=>setItemSearch(e.target.value)} placeholder="🔍 Search items..." />
            <div style={{maxHeight:320,overflowY:"auto"}}>
              {items.length===0?(
                <p style={{color:"#888",fontSize:13}}>No items match.</p>
              ):items.map(item=>{
                const {catalogItem}=mappingFor(item.id);
                return (
                <div key={item.id} style={{padding:"8px 0",borderBottom:"1px solid #F0F0F0"}}>
                  <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                    <div style={{fontSize:13,flex:1,minWidth:0,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{item.description}</div>
                    {priceEditId===item.id?(
                      <div style={{display:"flex",gap:6,alignItems:"center",flexShrink:0}}>
                        <input style={{...inp,width:80,padding:"4px 8px",fontSize:13}} type="number" step="0.01" autoFocus
                          value={priceEditValue} onChange={e=>setPriceEditValue(e.target.value)} />
                        <button onClick={()=>savePriceEdit(item)} style={{...btn("#003584","white",{fontSize:11,padding:"5px 8px"})}}>✓</button>
                        <button onClick={()=>setPriceEditId(null)} style={{...btn("#EEE","#555",{fontSize:11,padding:"5px 8px"})}}>✕</button>
                      </div>
                    ):(
                      <div style={{display:"flex",gap:8,alignItems:"center",flexShrink:0}}>
                        <span style={{fontWeight:700,fontSize:13}}>{formatMoney(item.price)}</span>
                        {canManage&&<button onClick={()=>{setPriceEditId(item.id);setPriceEditValue(String(item.price||""));}} style={{background:"none",border:"none",cursor:"pointer",color:"#888",fontSize:12}}>✎</button>}
                        {canManage&&quoteStatus(item,orgSettings||{})==="current"&&<button onClick={()=>onExpireOne(item)} style={{background:"none",border:"none",cursor:"pointer",color:"#E65100",fontSize:11}}>Remove price from Order Guide</button>}
                      </div>
                    )}
                  </div>
                  {canManage&&(
                    mapEditId===item.id?(
                      <div style={{display:"flex",gap:6,alignItems:"center",marginTop:6}}>
                        <span style={{fontSize:11,color:"#888"}}>Catalog item:</span>
                        <select style={{...inp,maxWidth:260,padding:"4px 8px",fontSize:12}} autoFocus value={mapEditValue} onChange={e=>setMapEditValue(e.target.value)}>
                          <option value="">Choose a product...</option>
                          {[...(catalogItems||[])].sort((a,b)=>a.name.localeCompare(b.name)).map(ci=><option key={ci.id} value={ci.id}>{ci.name}</option>)}
                        </select>
                        <button disabled={mapBusy} onClick={()=>saveItemMapping(item)} style={{...btn("#003584","white",{fontSize:11,padding:"4px 9px"})}}>Save</button>
                        <button onClick={()=>{setMapEditId(null);setMapError("");}} style={{...btn("#EEE","#555",{fontSize:11,padding:"4px 9px"})}}>✕</button>
                      </div>
                    ):(
                      <div style={{display:"flex",gap:6,alignItems:"center",marginTop:4}}>
                        <span style={{fontSize:11,color:"#AAA"}}>
                          {catalogItem?<>Linked to <b style={{color:"#666"}}>{catalogItem.name}</b></>:"Not linked to a catalog item"}
                        </span>
                        <button onClick={()=>{setMapEditId(item.id);setMapEditValue(catalogItem?.id||"");setMapError("");}}
                          style={{background:"none",border:"none",cursor:"pointer",color:"#888",fontSize:11,padding:0}}>✎</button>
                      </div>
                    )
                  )}
                  {mapEditId===item.id&&mapError&&<div style={{color:"#E65100",fontSize:11,marginTop:4}}>{mapError}</div>}
                </div>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div style={{fontSize:11,fontWeight:800,color:"rgba(255,255,255,0.7)",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:8}}>Invoice history</div>
      {vendorInvoices.length===0?(
        <div style={{background:"white",borderRadius:10,padding:24,textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.08)"}}>
          <p style={{color:"#888",fontSize:13,margin:0}}>No invoices recorded for {vendor.name} yet</p>
        </div>
      ):vendorInvoices.map(inv=>(
        <div key={inv.id} style={{background:"white",borderRadius:8,padding:14,marginBottom:8,
          display:"flex",justifyContent:"space-between",alignItems:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.06)"}}>
          <div style={{fontSize:12,color:"#888"}}>{formatDate(inv.invoice_date)||formatDate(inv.created_at)}{inv.invoice_number?` · #${inv.invoice_number}`:""}</div>
          <div style={{display:"flex",alignItems:"center",gap:8}}>
            <div style={{fontWeight:800,fontSize:15}}>{formatMoney(inv.total_amount)}</div>
            {inv.file_path&&<button onClick={()=>onViewOriginal(inv.file_path)} style={{...btn("#003584","white",{fontSize:11,padding:"5px 10px"})}}>View</button>}
            {canManage&&<button onClick={()=>onEditInvoice(inv)} style={{background:"none",border:"none",cursor:"pointer",color:"#888",fontSize:14,padding:0}} title="Edit">✎</button>}
            {canManage&&<button onClick={()=>onDeleteInvoice(inv)} style={{background:"none",border:"none",cursor:"pointer",color:"#E65100",fontSize:16,padding:0}} title="Delete">×</button>}
          </div>
        </div>
      ))}

      <div style={{fontSize:11,fontWeight:800,color:"rgba(255,255,255,0.7)",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:8,marginTop:20}}>Order history</div>
      {vendorOrders.length===0?(
        <div style={{background:"white",borderRadius:10,padding:24,textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.08)"}}>
          <p style={{color:"#888",fontSize:13,margin:0}}>No orders placed with {vendor.name} yet</p>
        </div>
      ):vendorOrders.map(po=>{
        const isOpen = expandedOrderId===po.id;
        const lines = po.purchase_order_lines||[];
        return (
          <div key={po.id} style={{background:"white",borderRadius:8,marginBottom:8,boxShadow:"0 1px 3px rgba(0,0,0,0.06)",overflow:"hidden"}}>
            <button onClick={()=>setExpandedOrderId(isOpen?null:po.id)}
              style={{width:"100%",background:"none",border:"none",cursor:"pointer",padding:"14px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{textAlign:"left"}}>
                <div style={{fontSize:12,color:"#888"}}>{formatDate(po.created_at)} · {lines.length} item{lines.length===1?"":"s"}</div>
                <div style={{fontSize:11,fontWeight:700,color:po.status==="submitted"?"#0A8A4B":"#888",textTransform:"capitalize"}}>{po.status||"submitted"}</div>
              </div>
              <div style={{display:"flex",alignItems:"center",gap:10}}>
                <div style={{fontWeight:800,fontSize:15}}>{formatMoney(po.total_amount)}</div>
                <span style={{color:"#CCC"}}>{isOpen?"▲":"▼"}</span>
              </div>
            </button>
            {isOpen&&(
              <div style={{borderTop:"1px solid #F0F0F0",padding:"10px 14px"}}>
                {lines.length===0?(
                  <div style={{color:"#AAA",fontSize:12}}>No line items recorded for this order.</div>
                ):lines.map(line=>{
                  const vi = vendorItems.find(v=>v.id===line.vendor_item_id);
                  return (
                    <div key={line.id} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"5px 0",borderBottom:"1px solid #FAFAFA"}}>
                      <div>{line.quantity}× {vi?.description||"Item"}</div>
                      <div style={{fontWeight:700}}>{formatMoney(line.line_total)}</div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}

      <div style={{fontSize:11,fontWeight:800,color:"rgba(255,255,255,0.7)",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:8,marginTop:20}}>Price history by period</div>
      {hasMorePrices&&<button onClick={onLoadMorePrices} disabled={loadingMorePrices} style={{...btn("white","#003584"),marginBottom:8}}>{loadingMorePrices?"Loading…":"Load earlier price history"}</button>}
      {vendorPricePeriods.length===0?(
        <div style={{background:"white",borderRadius:10,padding:24,textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.08)"}}>
          <p style={{color:"#888",fontSize:13,margin:0}}>No price sheets imported for {vendor.name} yet</p>
        </div>
      ):vendorPricePeriods.map(period=>{
        const isOpen=expandedPeriod===period.date;
        return (
          <div key={period.date} style={{background:"white",borderRadius:8,marginBottom:8,boxShadow:"0 1px 3px rgba(0,0,0,0.06)",overflow:"hidden"}}>
            <button onClick={()=>setExpandedPeriod(isOpen?null:period.date)}
              style={{width:"100%",background:"none",border:"none",cursor:"pointer",padding:"14px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
              <div style={{textAlign:"left"}}>
                <div style={{fontWeight:700,fontSize:13}}>Quoted {formatDate(period.date)}</div>
                <div style={{fontSize:12,color:"#888"}}>{period.entries.length} item{period.entries.length===1?"":"s"} in this sheet</div>
              </div>
              <span style={{color:"#CCC"}}>{isOpen?"▲":"▼"}</span>
            </button>
            {isOpen&&(
              <div style={{borderTop:"1px solid #F0F0F0",padding:"10px 14px"}}>
                {period.entries.map(entry=>{
                  const vi=vendorItems.find(v=>v.id===entry.vendor_item_id);
                  return (
                    <div key={entry.id} style={{display:"flex",justifyContent:"space-between",fontSize:12,padding:"5px 0",borderBottom:"1px solid #FAFAFA"}}>
                      <div>{vi?.description||"Item"}</div>
                      <div style={{textAlign:"right"}}><div style={{fontWeight:700}}>{formatMoney(entry.price)}</div>
                                  {entry.quote_valid_until&&<div style={{fontSize:10,color:"#999"}}>Vendor valid through {formatDate(entry.quote_valid_until)}</div>}
                                </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}
