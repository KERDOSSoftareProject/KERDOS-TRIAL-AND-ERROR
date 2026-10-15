import {AssociateAlternatives} from "./AssociateAlternatives.jsx";
import {unitLabel} from "../core/unit-labels.js";
import {editablePack,serializePack} from "../core/pack-editor.js";
import {QuotedPerControl} from "./QuotedPerControl.jsx";
import {calculatedUnitCost,comparisonUnits,defaultComparisonUnit} from "../core/quote-controls.js";
import {useState,useMemo} from "react";
import {backend} from "../backend/index.js";
import {createCatalogRowsService} from "../services/catalog-rows.js";
import {CATALOG_COLUMNS,catalogRowEvidence,unitChoices,orderGuideAssessment,qualificationSummary,BLOCKER_LABELS} from "../core/catalog-fields.js";
import {parsePackSize,priceBasisFor,casePriceFromQuote} from "../procurement.js";
import {formatMoney} from "../localization.js";
import {btn,inp} from "../ui/styles.js";

const service=createCatalogRowsService(backend);
const cellStyle={padding:8,borderBottom:"1px solid #DEE7F0",verticalAlign:"top"};
const inputStyle={...inp,fontSize:12,padding:6,width:"100%",minWidth:85,boxSizing:"border-box"};
// A percentage only where there is a value; an empty cell is simply empty.
// A percentage only where there is a value. A value the client set shows
// their initials beside it; hover for the reason and any note.
function Evidence({field}){
  if(field.label)return <small title={field.reason} style={{display:"block",marginTop:4,fontWeight:800,color:field.label==="Manual"?"#8D5900":"#38704E"}}>{field.label}</small>;
  if(field.accuracy==null||field.value==null||field.value==="")return <small style={{display:"block",marginTop:4,color:"#8D5900"}}>Empty</small>;
  const color=field.accuracy>=90?"#38704E":field.accuracy>=70?"#8D5900":"#B03A2E";
  return <small title={field.reason} style={{display:"block",marginTop:4,color}}>{field.accuracy}%{field.by?<span style={{marginLeft:6,fontWeight:800,color:"#003584"}}>{field.by}</span>:null}</small>;
}
function EditableRow({selected,onSelect,industry,allCatalogItems,allVendorItems,allMappings,orgId,item,vendorItem,mapping,vendor,categories,vocabulary,canManage,onUpdated,onDetails,peers=[],settings={},editors={}}){
  const [draft,setDraft]=useState({});
  const [nameDraft,setNameDraft]=useState(null);
  const [numberDraft,setNumberDraft]=useState(null);
  const [base,setBase]=useState(null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState("");
  const [saved,setSaved]=useState(false);
  const [overrideOpen,setOverrideOpen]=useState(false);
  const [overrideCost,setOverrideCost]=useState("");
  const [overrideUnit,setOverrideUnit]=useState("LB");
  const [overridePackPrice,setOverridePackPrice]=useState("");
  const [details,setDetails]=useState(false);
  const [packParts,setPackParts]=useState(null);
  const original=base||vendorItem;
  const resolutions={...original.field_resolutions};
  const sourceKeys={pack_size:"packSize",selling_unit:"sellingUnit"};
  for(const key of Object.keys(draft))if(key!=="item_name")resolutions[key]={value:draft[key],
    sourceValue:resolutions[key]?.sourceValue??original.import_row?.row?.[sourceKeys[key]||key]??original[key]};
  const current={...original,...draft,field_resolutions:resolutions};
  if(["price","pack_size","selling_unit"].some(key=>Object.hasOwn(draft,key))){
    delete current.field_resolutions.unit_cost_override;
    const basis=priceBasisFor(current.selling_unit);
    current.price_basis=basis?.basis||null;
    current.price_unavailable=!(basis&&Number(current.price)>0&&parsePackSize(current.pack_size)?.parsed&&casePriceFromQuote(current.price,basis.basis,basis.unit||current.selling_unit,current.pack_size)!=null);
  }
  const linkDirty=numberDraft!=null&&numberDraft.trim()!==String(item.master_item_number);
  const destination=linkDirty?allCatalogItems.find(ci=>String(ci.master_item_number)===numberDraft.trim()):item;
  const displayItem=destination||item;
  const displayPeers=linkDirty&&destination?allMappings.filter(m=>m.catalog_item_id===destination.id&&m.vendor_item_id!==vendorItem.id).map(m=>allVendorItems.find(vi=>vi.id===m.vendor_item_id)).filter(Boolean):peers;
  const categoryId=linkDirty?displayItem.category_id:draft.category_id??item.category_id;
  const category=categories.find(c=>c.id===categoryId);
  const evidenceItem={...displayItem,category_id:categoryId,category_review:'category_id' in draft?!!category?.is_holding_pen:displayItem.category_review};
  const previewMapping=linkDirty?{...mapping,catalog_item_id:displayItem.id,comparison_track:"review",confidence_score:null}:mapping;
  const evidence=catalogRowEvidence({item:evidenceItem,vendorItem:current,mapping:previewMapping,vendor,category,peers:displayPeers,categories,industry,editors});
  const assessment=orderGuideAssessment({item:evidenceItem,vendorItem:current,mapping:previewMapping,vendor,category,peers:displayPeers,categories,settings});
  const packUnits=unitChoices(vocabulary,true,industry);
  const nameDirty=nameDraft!=null&&nameDraft.trim()!==(item.name||"");
  const dirty=Object.keys(draft).length>0||nameDirty||linkDirty;
  function edit(key,value){setBase(b=>b||vendorItem);setDraft(d=>({...d,[key]:value}));setSaved(false);setError("");}
  const parsedPack=parsePackSize(current.pack_size);
  const shownPack=packParts||editablePack(current.pack_size);
  function changePack(key,value){
    const parts={...shownPack,[key]:value};
    if(key==="type"&&value==="each")parts.count=1;
    setPackParts(parts);
    edit("pack_size",serializePack(parts));
  }
  async function save(override=null){
    if(!override&&!calculatedUnitCost(current,{industry})){
      setOverridePackPrice(String(current.price||""));setOverrideOpen(true);return;
    }
    setBusy(true);setError("");
    try{
      // One write: the row's fields and the client's item name land
      // together or not at all.
      if(linkDirty&&!destination)throw new Error("Enter an existing KERDOS item number from this catalog.");
      if(linkDirty&&(nameDirty||Object.hasOwn(draft,"category_id")))throw new Error("Apply the item name/category edits before changing its association.");
      const patch={description:current.description,brand:current.brand||"",pack_size:current.pack_size||"",selling_unit:current.selling_unit||"",price:current.price||override?.packPrice, ...draft,approve_row:true,
        unit_cost_override:override||current.field_resolutions?.unit_cost_override?.value||null,
        ...(!linkDirty?{category_id:categoryId,item_name:nameDraft?.trim()||item.name}:{}),...(nameDirty?{item_name:nameDraft.trim()}:{ }),...(linkDirty?{catalog_item_id:destination.id}:{})};
      await service.save({organizationId:orgId,vendorItem:base||vendorItem,mapping,patch});
      setDraft({});setNameDraft(null);setNumberDraft(null);setBase(null);setPackParts(null);setSaved(true);setOverrideOpen(false);await onUpdated();
    }
    catch(err){setError(err.message||String(err));}
    finally{setBusy(false);}
  }
  const fields={product:"description",brand:"brand",price:"price"};
  return <>
    <tr style={{background:dirty?"#FFFDF3":"white"}}>
      <td style={cellStyle}>{canManage&&<input type="checkbox" aria-label={`Select ${vendorItem.description} for alternatives`} checked={selected} onChange={onSelect}/>}</td>
      {CATALOG_COLUMNS.map(([key])=>{
        const f=evidence[key];let content;
        if(key==="itemNumber")content=<>
          <input aria-label={`KERDOS item number for ${vendorItem.vendor_item_code}`} inputMode="numeric" style={{...inputStyle,fontWeight:400,width:105}} disabled={!canManage||busy} value={numberDraft??String(item.master_item_number)} onChange={e=>{setNumberDraft(e.target.value.replace(/^#/,""));setSaved(false);setError("");}}/>
          {linkDirty&&<small style={{display:"block",color:destination?"#245785":"#A32B20"}}>{destination?`Link to ${destination.name}`:"Enter an existing KERDOS number"}</small>}
        </>;
        else if(key==="vendor")content=<span>{f.value}</span>;
        else if(key==="vendorItemNumber")content=<span>{f.value||"NVIM pending"}</span>;
        else if(key==="category")content=<select aria-label={`Category for ${vendorItem.vendor_item_code}`} style={{...inputStyle,minWidth:130}} disabled={!canManage||busy||linkDirty} value={categoryId||""} onChange={e=>edit("category_id",e.target.value)}><option value="" disabled>Choose category</option>{categories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>;
        else if(key==="pack")content=<>
          <select aria-label={`Pack for ${vendorItem.vendor_item_code}`} style={{...inputStyle,minWidth:100}} disabled={!canManage||busy} value={shownPack.type} onChange={e=>changePack("type",e.target.value)}>
            <option value="" disabled>Select</option><option value="case">Case</option><option value="each">Each</option>
          </select>
          {shownPack.type&&<>
            {shownPack.type==="case"&&<label style={{display:"block",marginTop:4}}>Eaches in case<input aria-label={`Count for ${vendorItem.vendor_item_code}`} type="number" min="1" step="1" style={inputStyle} disabled={!canManage||busy} value={shownPack.count} onChange={e=>changePack("count",e.target.value)}/></label>}
            <label style={{display:"block",marginTop:4}}>Amount in each<input aria-label={`Amount in each for ${vendorItem.vendor_item_code}`} type="number" min="0.001" step="any" style={inputStyle} disabled={!canManage||busy} value={shownPack.size} onChange={e=>changePack("size",e.target.value)}/></label>
            <label style={{display:"block",marginTop:4}}>Measurement<select aria-label={`Each measurement for ${vendorItem.vendor_item_code}`} style={inputStyle} disabled={!canManage||busy} value={shownPack.unit} onChange={e=>changePack("unit",e.target.value)}>
              <option value="" disabled>Select measurement</option>
              {shownPack.unit&&!packUnits.some(u=>u.value===shownPack.unit)&&<option value={shownPack.unit}>{unitLabel(shownPack.unit)}</option>}
              {packUnits.map(u=><option key={u.value} value={u.value}>{unitLabel(u.value)}</option>)}
            </select></label>
            {shownPack.catchWeight&&<small>Average weight retained</small>}
          </>}
          {!parsedPack?.parsed&&current.pack_size&&!/^(CASE|EACH):/.test(current.pack_size)&&<small style={{display:"block"}}>From sheet: {current.pack_size}</small>}
        </>;
        else if(key==="itemName")content=<input aria-label={`Item name for ${item.master_item_number}`} style={{...inputStyle,minWidth:180,fontWeight:400}} disabled={!canManage||busy||linkDirty} value={linkDirty?displayItem.name:nameDraft??item.name??""} placeholder="Your name for this product" onChange={e=>{setBase(b=>b||vendorItem);setNameDraft(e.target.value);setSaved(false);setError("");}} />;
        else if(fields[key])content=<input aria-label={`${key} for ${vendorItem.vendor_item_code}`} style={{...inputStyle,minWidth:key==="product"?220:95}} disabled={!canManage||busy} type={key==="price"?"number":"text"} step={key==="price"?"any":undefined} min={key==="price"?"0":undefined} value={current[fields[key]]??""} placeholder={key==="brand"?"Blank if absent":""} onChange={e=>edit(fields[key],e.target.value)} />;
        else if(key==="sellingUnit")content=<QuotedPerControl industry={industry} vocabulary={vocabulary} label={`Quoted per for ${vendorItem.vendor_item_code}`} style={{...inputStyle,minWidth:130}} disabled={!canManage||busy} value={current.selling_unit||""} onChange={value=>edit("selling_unit",value)}/>;
        else content=<>
          {f.value==null?<span style={{color:"#8D5900",fontWeight:700}}>Undetermined</span>:<span>{formatMoney(f.value)}</span>}
          <select aria-label={`Unit cost metric for ${vendorItem.vendor_item_code}`} style={{...inputStyle,marginTop:4,minWidth:100}} disabled={!canManage||busy||!comparisonUnits(current.pack_size).length} value={current.unit_cost_unit||f.unit||defaultComparisonUnit(current.pack_size,industry)||""} onChange={e=>edit("unit_cost_unit",e.target.value)}>
            <option value="" disabled>Select measurement</option>
            {current.unit_cost_unit&&!comparisonUnits(current.pack_size).includes(current.unit_cost_unit)&&<option value={current.unit_cost_unit}>{unitLabel(current.unit_cost_unit)} — check pack</option>}
            {comparisonUnits(current.pack_size).map(unit=><option key={unit} value={unit}>{unitLabel(unit)}</option>)}
          </select>
          {f.unit&&<small style={{display:"block"}}>per {unitLabel(f.unit).toLowerCase()}{dirty?" · preview":""}</small>}
        </>;
        const sourceKey={product:"description",pack:"packSize",sellingUnit:"sellingUnit"}[key]||key;
        const change=vendorItem.import_row?.reviewRequired&&vendorItem.import_row?.changes?.find(c=>c.field===sourceKey);
        return <td key={key} style={{...cellStyle,background:change?"#FFF3E0":undefined}}>{content}<Evidence field={f}/>{change&&<small style={{display:"block",color:"#9B4400"}} title={change.reason}>Changed on new sheet</small>}</td>;
      })}
      <td style={{...cellStyle,minWidth:115}}>
        {canManage&&<button disabled={busy} onClick={()=>save()} style={{...btn("#003584","white",{fontSize:11,padding:6})}}>{busy?"Applying…":"Apply"}</button>}
        {dirty&&<button disabled={busy} onClick={()=>{setDraft({});setNameDraft(null);setNumberDraft(null);setBase(null);setPackParts(null);setError("");}} style={{border:0,background:"none",cursor:"pointer",fontSize:11}}>Undo edits</button>}
        <button onClick={()=>setDetails(!details)} style={{display:"block",marginTop:6,border:0,background:"none",cursor:"pointer",color:"#245785"}}>Details</button>
        {vendorItem.import_row?.reviewRequired&&<small style={{display:"block",color:"#9B4400"}}>New quote needs review</small>}
        {saved&&<small role="status" style={{color:"#276742"}}>Saved</small>}
        {error&&<div role="alert" style={{fontSize:11,color:"#A32B20",whiteSpace:"normal"}}>{error}</div>}
      </td>
    </tr>
    {overrideOpen&&<tr><td colSpan={CATALOG_COLUMNS.length+2}>
      <div role="dialog" aria-modal="true" aria-label="Unit cost override" style={{position:"fixed",inset:0,background:"#0006",zIndex:1000,display:"grid",placeItems:"center"}}>
        <div style={{background:"white",padding:24,borderRadius:10,width:380,maxWidth:"90vw"}}>
          <div>KERDOS cannot calculate unit cost from this pack and quoted unit. Enter your approved values to continue.</div>
          <label style={{display:"block",marginTop:12}}>Unit cost<input aria-label="Override unit cost" type="number" min="0" step="any" style={inputStyle} value={overrideCost} onChange={e=>setOverrideCost(e.target.value)}/></label>
          <label style={{display:"block",marginTop:12}}>Per measurement<select aria-label="Override measurement" style={inputStyle} value={overrideUnit} onChange={e=>setOverrideUnit(e.target.value)}>{unitChoices(vocabulary,false,"").map(u=><option key={u.value} value={u.value}>{unitLabel(u.value)}</option>)}</select></label>
          <label style={{display:"block",marginTop:12}}>Price for one purchasing pack<input aria-label="Override purchasing pack price" type="number" min="0" step="any" style={inputStyle} value={overridePackPrice} onChange={e=>setOverridePackPrice(e.target.value)}/></label>
          <small>This is the amount charged when you order quantity 1.</small>
          {error&&<div role="alert" style={{color:"#A32B20"}}>{error}</div>}
          <div style={{marginTop:16}}><button disabled={busy} onClick={()=>save({price:Number(overrideCost),unit:overrideUnit,packPrice:Number(overridePackPrice)})} style={btn("#003584","white")}>Apply override</button><button disabled={busy} onClick={()=>setOverrideOpen(false)} style={{marginLeft:12}}>Cancel</button></div>
        </div>
      </div>
    </td></tr>}
    {details&&<tr><td colSpan={CATALOG_COLUMNS.length+2} style={{...cellStyle,background:"#F2F6FA"}}>
      <div style={{fontWeight:700,marginBottom:10}}>{assessment.ready?"Meets Order Guide field requirements":"Waiting on: "+assessment.blockers.map(code=>BLOCKER_LABELS[code]).join("; ")}{dirty?" (unsaved preview)":""}</div>
      <small style={{display:"block",marginBottom:10}}>Case count is the number of eaches inside. Each always has count 1. Weight or volume is separate; Quoted per tells us how the vendor charges.</small>
      {vendorItem.import_row?.reviewRequired&&<div style={{background:"#FFF3E0",padding:10,fontSize:12,marginBottom:10}}>
        <b>Incoming quote: {formatMoney(vendorItem.import_row.row?.price)} · pack {vendorItem.import_row.row?.packSize||"not stated"} · per {vendorItem.import_row.row?.sellingUnit||"not stated"}</b>
        <div>{(vendorItem.import_row.conflicts||[]).join(" ")}</div>
        {canManage&&<button disabled={busy} onClick={()=>{const r=vendorItem.import_row.row;edit("price",r.price??"");if(r.description)edit("description",r.description);if(r.brand)edit("brand",r.brand);if(r.packSize)edit("pack_size",r.packSize);edit("selling_unit",r.sellingUnit||"");}} style={{...btn("#FFF","#875200",{fontSize:11,marginTop:6})}}>Review incoming values in this row</button>}
        {canManage&&<button disabled={busy} onClick={()=>{if(window.confirm("Keep the saved product, brand, pack and quoted unit, and accept this incoming amount on that basis?"))edit("price",vendorItem.import_row.row?.price??"");}} style={{...btn("#FFF","#875200",{fontSize:11,marginLeft:8,marginTop:6})}}>Keep saved fields; review new price</button>}
      </div>}
      <div style={{fontSize:12,marginBottom:6}}>To associate this vendor item with another catalog item, enter its existing KERDOS number and Apply changes. Apply approves this association. You can edit it again at any time.</div>
      <div style={{fontSize:12}}>Source: {vendorItem.import_row?.row?.sourceLine||"Original source is available under Price Sheets."}</div>
      <div style={{fontSize:11,marginTop:6}}>Percentages show how well each value holds up against the rest of the row, the vendor's history and your other vendors. A blank cell has no percentage; it is simply empty.</div>
      <ul style={{fontSize:12}}>{CATALOG_COLUMNS.map(([key,label])=><li key={key}><b>{label}:</b> {evidence[key].reason}</li>)}</ul>
      <button disabled={dirty||busy} onClick={onDetails} style={{...btn("#E8F1FB","#003584",{fontSize:11})}}>Vendor comparison and association details</button>
    </td></tr>}
  </>;
}
export function CatalogRows({industry="",orgId,items,catalogItems,vendorItems,mappings,vendors,categories,vocabulary,canManage,onUpdated,onDetails,settings={},editors={}}){
  const summary=useMemo(()=>qualificationSummary({catalogItems,vendorItems,mappings,vendors,categories,settings}),[catalogItems,vendorItems,mappings,vendors,categories,settings]);
  const [selected,setSelected]=useState(new Set());
  const [sort,setSort]=useState({key:"product",direction:1});
  const catalog=new Map(catalogItems.map(i=>[i.id,i])),viById=new Map(vendorItems.map(v=>[v.id,v])),vendorById=new Map(vendors.map(v=>[v.id,v]));
  const visible=new Set(items.map(i=>i.catalogItemId));
  const rows=mappings.filter(m=>visible.has(m.catalog_item_id)).flatMap(mapping=>{
    const item=catalog.get(mapping.catalog_item_id),vendorItem=viById.get(mapping.vendor_item_id);if(!item||!vendorItem)return [];
    const vendor=vendorById.get(vendorItem.vendor_id),category=categories.find(c=>c.id===item.category_id);
    // The other vendors' rows on this item, for cross-vendor checks.
    const peers=mappings.filter(o=>o.catalog_item_id===mapping.catalog_item_id&&o.id!==mapping.id).map(o=>viById.get(o.vendor_item_id)).filter(Boolean);
    return [{mapping,item,vendorItem,vendor,peers,evidence:catalogRowEvidence({item,vendorItem,vendor,mapping,category,peers,categories})}];
  }).sort((a,b)=>{
    const av=a.evidence[sort.key].value,bv=b.evidence[sort.key].value;
    if(av==null)return bv==null?0:1;if(bv==null)return -1;
    return sort.direction*(typeof av==="number"&&typeof bv==="number"?av-bv:String(av).localeCompare(String(bv),undefined,{numeric:true}));
  });
  const linked=new Set(rows.map(r=>r.item.id));
  return <div style={{overflowX:"auto",borderRadius:10,background:"white",marginBottom:16}}>
    <div style={{padding:12,fontSize:12}}>Correct any cell, then save its row. Missing fields can be completed later.
      <details style={{marginTop:8}}><summary>{summary.ready} of {summary.total} vendor rows meet Order Guide requirements · {summary.blocked} need evidence</summary>
        <p>All required fields need at least 90%, a verified product association and a current quote. A row can have more than one blocker.</p>
        <ul>{summary.blockers.map(blocker=><li key={blocker.code}>{blocker.label}: {blocker.count}</li>)}</ul>
      </details>
    </div>
    {canManage&&<AssociateAlternatives orgId={orgId} selectedVendorIds={[...selected]} vendorItems={vendorItems} catalogItems={catalogItems} mappings={mappings} vendors={vendors} onUpdated={onUpdated} onClear={()=>setSelected(new Set())}/>}
    <table style={{borderCollapse:"collapse",width:"100%",minWidth:1250,fontSize:12}}><thead><tr><th style={cellStyle}>Select</th>{CATALOG_COLUMNS.map(([key,label])=><th key={key} style={{...cellStyle,textAlign:"left",background:"#E8F0FA"}} aria-sort={sort.key===key?sort.direction===1?"ascending":"descending":"none"}><button style={{border:0,background:"none",fontWeight:700,cursor:"pointer"}} onClick={()=>setSort(s=>({key,direction:s.key===key?-s.direction:1}))}>{label}{sort.key===key?sort.direction===1?" ↑":" ↓":""}</button></th>)}<th style={cellStyle}>Actions</th></tr></thead>
      <tbody>{rows.map(row=><EditableRow selected={selected.has(row.vendorItem.id)} onSelect={()=>setSelected(prior=>{const next=new Set(prior);if(next.has(row.vendorItem.id))next.delete(row.vendorItem.id);else next.add(row.vendorItem.id);return next;})} industry={industry} allCatalogItems={catalogItems} allVendorItems={vendorItems} allMappings={mappings} settings={settings} editors={editors} key={row.vendorItem.id} {...row} orgId={orgId} categories={categories} vocabulary={vocabulary} canManage={canManage} onUpdated={onUpdated} onDetails={()=>onDetails(row.item.id)} />)}
      {items.filter(i=>!linked.has(i.catalogItemId)).map(i=><tr key={i.catalogItemId}><td style={cellStyle}/><td style={cellStyle}>#{i.masterItemNumber}</td><td colSpan={CATALOG_COLUMNS.length-1} style={cellStyle}>{i.name} · No vendor listing linked yet.</td><td><button onClick={()=>onDetails(i.catalogItemId)}>Details</button></td></tr>)}
      </tbody>
    </table>
  </div>;
}
