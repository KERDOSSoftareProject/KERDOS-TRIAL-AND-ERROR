import {MovableDialog} from "../ui/MovableDialog.jsx";
import {AssociateAlternatives} from './AssociateAlternatives.jsx';
import {clientProductName} from '../core/client-product-name.js';
import {compareItems} from '../core/catalog-browse.js';
import {unitLabel} from "../core/unit-labels.js";
import {editablePack,serializePack} from "../core/pack-editor.js";
import {QuotedPerControl} from "./QuotedPerControl.jsx";
import {calculatedUnitCost,comparisonUnits,defaultComparisonUnit} from "../core/quote-controls.js";
import {buildCategoryDropdown} from "../services/categories.js";
import {useState,useEffect,useRef} from "react";
import {backend} from "../backend/index.js";
import {createCatalogRowsService} from "../services/catalog-rows.js";
import {createVariableWeightService} from '../services/variable-weight.js';
import {VariableWeightConfirmation} from './VariableWeightConfirmation.jsx';
import {CATALOG_COLUMNS,catalogRowEvidence,unitChoices,orderGuideAssessment,BLOCKER_LABELS} from "../core/catalog-fields.js";
import {parsePackSize,priceBasisFor,casePriceFromQuote,estimateCaseCost} from "../procurement.js";
import {formatMoney} from "../localization.js";
import {btn,inp} from "../ui/styles.js";

const service=createCatalogRowsService(backend);
const variableWeightService=createVariableWeightService(backend);
const cellStyle={padding:8,borderBottom:"1px solid #DEE7F0",verticalAlign:"top"};
const BASE_COLUMNS=new Set(['itemNumber','vendor','vendorItemNumber','category','itemName','product','price']);
const BASE_EDIT_FIELDS=new Set(['description','price','category_id']);
const inputStyle={...inp,fontSize:12,padding:6,width:"100%",minWidth:85,boxSizing:"border-box"};
// Source and editor notes remain available without confidence/origin badges.
function Evidence({field}){
  if(field.label)return null;
  if(field.value==null||field.value==="")return <small style={{display:"block",marginTop:4,color:"#8D5900"}}>Empty</small>;
  return field.by?<small title={field.reason} style={{display:"block",marginTop:4,color:"#003584",fontWeight:800}}>{field.by}</small>:null;
}
function EditableRow({autoSave=false,userId,baseFieldsOnly=false,selected,onSelect,clientName,industry,allCatalogItems,allVendorItems,allMappings,orgId,item,vendorItem,mapping,vendor,categories,vocabulary,canManage,onUpdated,onDetails,peers=[],settings={},editors={},variableApproval,onVariableApprovalChanged}){
  const storageKey=autoSave&&userId?`kerdos-catalog-draft:${orgId}:${userId}:${vendorItem.id}`:null;
  const [recovery]=useState(()=>{try{return storageKey?JSON.parse(window.localStorage.getItem(storageKey)||'null'):null;}catch{return null;}});
  const [trialVisible,setTrialVisible]=useState(recovery?.visible||{});
  const [draft,setDraft]=useState(recovery?.draft||{});
  const [nameDraft,setNameDraft]=useState(recovery?.nameDraft??null);
  const [numberDraft,setNumberDraft]=useState(recovery?.numberDraft??null);
  const [base,setBase]=useState(recovery?.revision!=null?{...vendorItem,row_revision:recovery.revision}:null);
  const [busy,setBusy]=useState(false);
  const [error,setError]=useState(recovery?.revision!=null&&recovery.revision!==(vendorItem.row_revision||0)?"This listing changed. Review your recovered edits before retrying.":"");
  const [saved,setSaved]=useState(false);
  const [overrideOpen,setOverrideOpen]=useState(false);
  const [overrideCost,setOverrideCost]=useState(recovery?.overrideCost||"");
  const [overrideUnit,setOverrideUnit]=useState("LB");
  const [overridePackPrice,setOverridePackPrice]=useState("");
  const [details,setDetails]=useState(false);
  const [packParts,setPackParts]=useState(null);
  const mounted=useRef(true);
  useEffect(()=>{mounted.current=true;return ()=>{mounted.current=false;};},[]);
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
  const dirty=Object.keys(draft).some(key=>autoSave||!baseFieldsOnly||BASE_EDIT_FIELDS.has(key))||nameDirty||linkDirty;
  function edit(key,value){setTrialVisible(prior=>({...prior,[key]:true}));setBase(b=>b||vendorItem);setDraft(d=>({...d,[key]:value}));setSaved(false);setError("");}
  const parsedPack=parsePackSize(current.pack_size);
  const currentBasis=priceBasisFor(current.selling_unit);
  const caseEstimate=estimateCaseCost(current.price,currentBasis?.basis,currentBasis?.unit||current.selling_unit,current.pack_size);
  const displayed=key=>baseFieldsOnly&&autoSave&&!trialVisible[key]?"":current[key]??"";
  const shownPack=packParts||editablePack(displayed("pack_size"));
  const overrideMetric=baseFieldsOnly?trialVisible.unit_cost_unit?current.unit_cost_unit:null:current.unit_cost_unit||defaultComparisonUnit(current.pack_size,industry);
  const overrideBasis=priceBasisFor(displayed("selling_unit"));
  const overrideCasePrice=casePriceFromQuote(current.price,overrideBasis?.basis,overrideBasis?.unit||displayed("selling_unit"),displayed("pack_size"));
  useEffect(()=>{
    if(!autoSave||!canManage||!(Number(overrideCost)>0)||!overrideMetric||!(overrideCasePrice>0)||busy)return;
    const value={price:Number(overrideCost),unit:overrideMetric,packPrice:overrideCasePrice};
    if(JSON.stringify(draft.unit_cost_override)!==JSON.stringify(value))edit("unit_cost_override",value);
  },[autoSave,canManage,overrideCost,overrideMetric,overrideCasePrice,busy]);
  function changePack(key,value){
    const parts={...shownPack,[key]:value};
    if(key==="type"&&value==="each")parts.count=1;
    setPackParts(parts);
    edit("pack_size",serializePack(parts));
  }
  async function save(override=null){
    if(!autoSave&&!baseFieldsOnly&&!override&&!calculatedUnitCost(current,{industry})){
      setOverridePackPrice(String(current.price||""));setOverrideOpen(true);return;
    }
    setBusy(true);setError("");
    try{
      // One write: the row's fields and the client's item name land
      // together or not at all.
      if(linkDirty&&!destination)throw new Error("Enter an existing KERDOS item number from this catalog.");
      if(linkDirty&&(nameDirty||Object.hasOwn(draft,"category_id")))throw new Error(autoSave?"Finish the item name/category edits before changing its association.":"Apply the item name/category edits before changing its association.");
      const basePatch={...Object.fromEntries(Object.entries(draft).filter(([key])=>BASE_EDIT_FIELDS.has(key))),...(nameDirty?{item_name:nameDraft.trim()}:{}),...(linkDirty?{catalog_item_id:destination.id}:{})};
      if(baseFieldsOnly&&!autoSave&&!Object.keys(basePatch).length)return;
      const patch=autoSave?{...draft,...(nameDirty?{item_name:nameDraft.trim()}:{}),...(linkDirty?{catalog_item_id:destination.id}:{})}:baseFieldsOnly?basePatch:{description:current.description,brand:current.brand||"",pack_size:current.pack_size||"",selling_unit:current.selling_unit||"",price:current.price||override?.packPrice, ...draft,approve_row:true,
        unit_cost_override:override||current.field_resolutions?.unit_cost_override?.value||null,
        ...(!linkDirty?{category_id:categoryId,item_name:nameDraft?.trim()||item.name}:{}),...(nameDirty?{item_name:nameDraft.trim()}:{ }),...(linkDirty?{catalog_item_id:destination.id}:{})};
      const receipt=await service.save({organizationId:orgId,vendorItem:base||vendorItem,mapping,patch});
      if(autoSave&&storageKey){try{window.localStorage.setItem(storageKey,JSON.stringify({draft:{},nameDraft:null,numberDraft:null,visible:trialVisible,revision:receipt?.row_revision??((original.row_revision||0)+1),overrideCost:Object.hasOwn(patch,"unit_cost_override")?"":overrideCost}));}catch{}}
      if(!mounted.current)return;
      let refreshError='';try{await onUpdated();}catch{refreshError='Saved, but the catalog could not refresh. Refresh the page before editing again.';}
      if(!mounted.current)return;
      setDraft(prior=>baseFieldsOnly&&!autoSave?Object.fromEntries(Object.entries(prior).filter(([key])=>!BASE_EDIT_FIELDS.has(key))):{});setNameDraft(null);setNumberDraft(null);setBase(autoSave&&receipt?.id?receipt:null);if(!baseFieldsOnly||autoSave)setPackParts(null);setSaved(true);setError(refreshError);setOverrideOpen(false);if(Object.hasOwn(patch,"unit_cost_override"))setOverrideCost("");
    }
    catch(err){if(mounted.current)setError(err.message||String(err));}
    finally{if(mounted.current)setBusy(false);}
  }
  useEffect(()=>{
    if(!autoSave||!storageKey)return;
    try{window.localStorage.setItem(storageKey,JSON.stringify({draft,nameDraft,numberDraft,visible:trialVisible,revision:original.row_revision||0,overrideCost}));}catch{}
  },[autoSave,storageKey,draft,nameDraft,numberDraft,trialVisible,original.row_revision,overrideCost]);
  useEffect(()=>{
    if(!autoSave||!canManage||!dirty||busy||error)return;
    const timer=setTimeout(()=>{void save();},700);
    return ()=>clearTimeout(timer);
  },[autoSave,canManage,dirty,busy,error,draft,nameDraft,numberDraft,baseFieldsOnly]);
  const saveStatus=autoSave?<small role={error?'alert':'status'} style={{display:'block',marginTop:4,color:error?'#A32B20':'#276742'}}>{busy?'Saving…':error?error:dirty?'Waiting to save…':saved?'Saved':''}{error&&dirty&&<><button onClick={()=>setError('')} style={{border:0,background:'none',color:'#003584'}}>Retry</button><button onClick={()=>{setDraft({});setNameDraft(null);setNumberDraft(null);setBase(null);setOverrideCost('');setError('');}} style={{border:0,background:'none'}}>Discard unsaved edits</button></>}</small>:null;
  const fields={product:"description",brand:"brand",price:"price"};
  return <>
    <tr style={{background:dirty?"#FFFDF3":"white"}}>
      <td style={cellStyle}>{canManage&&<input type="checkbox" aria-label={`Select ${vendorItem.description} for alternatives`} checked={selected} onChange={onSelect}/>}</td>
      {CATALOG_COLUMNS.map(([key])=>{
        if(baseFieldsOnly&&!autoSave&&!BASE_COLUMNS.has(key))return <td key={key} data-blank-trial-field={key} style={cellStyle}/>;
        const f=evidence[key];let content;
        if(key==="itemNumber")content=<span aria-label={`KERDOS item number for ${vendorItem.vendor_item_code}`} style={{fontFamily:"monospace",fontWeight:700,color:"#003584",display:"block",padding:"6px 0"}}>{(baseFieldsOnly?displayItem:item).master_item_number!=null?`#${(baseFieldsOnly?displayItem:item).master_item_number}`:"—"}</span>;
        else if(key==="vendor")content=<span>{f.value}</span>;
        else if(key==="vendorItemNumber")content=<span>{f.value||"NVIM pending"}</span>;
        else if(key==="category"){const {industryCategories,legacyCurrent,holdingPenCurrent}=buildCategoryDropdown({categories,industry,currentCategory:category,clientCategories:autoSave});content=<select aria-label={`Category for ${vendorItem.vendor_item_code}`} style={{...inputStyle,minWidth:130}} disabled={!canManage||busy||linkDirty} value={categoryId||""} onChange={e=>edit("category_id",e.target.value)}><option value="" disabled>Choose category</option>{holdingPenCurrent&&<option key={holdingPenCurrent.id} value={holdingPenCurrent.id} disabled>Unclassified — assign a category</option>}{legacyCurrent&&<option key={legacyCurrent.id} value={legacyCurrent.id}>{legacyCurrent.name}</option>}{industryCategories.map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>;}
        else if(key==="pack")content=<>
          <select aria-label={`Pack for ${vendorItem.vendor_item_code}`} style={{...inputStyle,minWidth:100}} disabled={!canManage||busy} value={shownPack.type} onChange={e=>changePack("type",e.target.value)}>
            <option value="" disabled>Select</option><option value="case">Case</option><option value="each">Each</option>
          </select>
          {shownPack.type&&<>
            {shownPack.type==="case"&&<label style={{display:"block",marginTop:4}}>{shownPack.innerCounts?.length?"Inner packs in case":"Eaches in case"}<input aria-label={`Count for ${vendorItem.vendor_item_code}`} type="number" min="1" step="1" style={inputStyle} disabled={!canManage||busy} value={shownPack.count} onChange={e=>changePack("count",e.target.value)}/></label>}
            {shownPack.type==="case"&&shownPack.innerCounts?.map((count,index)=><label key={index} style={{display:"block",marginTop:4}}>Units in inner pack {index+1}<input aria-label={`Inner count ${index+1} for ${vendorItem.vendor_item_code}`} type="number" min="1" step="1" style={inputStyle} disabled={!canManage||busy} value={count} onChange={e=>changePack("innerCounts",shownPack.innerCounts.map((n,i)=>i===index?e.target.value:n))}/></label>)}
            {Object.hasOwn(shownPack,"rangeMinimum")?<>
              <label style={{display:"block",marginTop:4}}>Minimum weight in each<input aria-label={`Minimum weight for ${vendorItem.vendor_item_code}`} type="number" min="0.001" step="any" style={inputStyle} disabled={!canManage||busy} value={shownPack.rangeMinimum} onChange={e=>changePack("rangeMinimum",e.target.value)}/></label>
              <label style={{display:"block",marginTop:4}}>Maximum weight in each<input aria-label={`Maximum weight for ${vendorItem.vendor_item_code}`} type="number" min="0.001" step="any" style={inputStyle} disabled={!canManage||busy} value={shownPack.rangeMaximum} onChange={e=>changePack("rangeMaximum",e.target.value)}/></label>
            </>:<label style={{display:"block",marginTop:4}}>Amount in each<input aria-label={`Amount in each for ${vendorItem.vendor_item_code}`} type="number" min="0.001" step="any" style={inputStyle} disabled={!canManage||busy} value={shownPack.size} onChange={e=>changePack("size",e.target.value)}/></label>}
            <label style={{display:"block",marginTop:4}}>Measurement<select aria-label={`Each measurement for ${vendorItem.vendor_item_code}`} style={inputStyle} disabled={!canManage||busy} value={shownPack.unit} onChange={e=>changePack("unit",e.target.value)}>
              <option value="" disabled>Select measurement</option>
              {shownPack.unit&&!packUnits.some(u=>u.value===shownPack.unit)&&<option value={shownPack.unit}>{unitLabel(shownPack.unit)}</option>}
              {packUnits.map(u=><option key={u.value} value={u.value}>{unitLabel(u.value)}</option>)}
            </select></label>
            {shownPack.catchWeight&&<small>Average weight retained</small>}
          </>}
          {!baseFieldsOnly&&!parsedPack?.parsed&&current.pack_size&&!/^(CASE|EACH):/.test(current.pack_size)&&<small style={{display:"block"}}>From sheet: {current.pack_size}</small>}
        </>;
        else if(key==="itemName")content=<><input list={baseFieldsOnly?`client-items-${vendorItem.id}`:undefined} aria-label={`Item name for ${item.master_item_number}`} style={{...inputStyle,minWidth:180,fontWeight:400}} disabled={!canManage||busy} value={linkDirty?displayItem.name:nameDraft??clientName??item.name??""} placeholder="Your name for this product" onChange={e=>{setBase(b=>b||vendorItem);const target=allCatalogItems.find(candidate=>!candidate.merged_into_id&&candidate.name===e.target.value);if(baseFieldsOnly&&target){setNumberDraft(String(target.master_item_number));setNameDraft(null);if(autoSave)setDraft(prior=>Object.fromEntries(Object.entries(prior).filter(([key])=>key!=="category_id")));}else{setNumberDraft(null);setNameDraft(e.target.value);}setSaved(false);setError("");}} />{baseFieldsOnly&&<datalist id={`client-items-${vendorItem.id}`}>{allCatalogItems.filter(candidate=>!candidate.merged_into_id).map(candidate=><option key={candidate.id} value={candidate.name}/>)}</datalist>}</>;
        else if(fields[key])content=<input aria-label={`${key} for ${vendorItem.vendor_item_code}`} style={{...inputStyle,minWidth:key==="product"?220:95}} disabled={!canManage||busy} type={key==="price"?"number":"text"} step={key==="price"?"any":undefined} min={key==="price"?"0":undefined} value={key==="brand"?displayed("brand"):current[fields[key]]??""} placeholder={key==="brand"?"Blank if absent":""} onChange={e=>edit(fields[key],e.target.value)} />;
        else if(key==="sellingUnit")content=<>
          <QuotedPerControl industry={industry} vocabulary={vocabulary} label={`Quoted per for ${vendorItem.vendor_item_code}`} style={{...inputStyle,minWidth:130}} disabled={!canManage||busy} value={displayed("selling_unit")} onChange={value=>edit("selling_unit",value)}/>
          {!baseFieldsOnly&&caseEstimate&&<small style={{display:"block",marginTop:4}}>Case estimate: {caseEstimate.amount!=null?formatMoney(caseEstimate.amount):`${formatMoney(caseEstimate.minimum)}–${formatMoney(caseEstimate.maximum)}`}. Final charge depends on delivered weight.</small>}
        </>;
        else content=<>
          {autoSave?<><input aria-label={`Unit cost for ${vendorItem.vendor_item_code}`} style={inputStyle} type="number" min="0" step="any" disabled={!canManage||busy} value={overrideCost||(baseFieldsOnly&&!trialVisible.unit_cost_override?"":f.value??"")} onChange={e=>{setOverrideCost(e.target.value);setSaved(false);setError("");}}/>{overrideCost&&(!overrideMetric||!(overrideCasePrice>0))&&<small>Complete the pack and quoted unit and choose a measurement to save this unit cost.</small>}</>:f.value==null?<span style={{color:"#8D5900",fontWeight:700}}>Undetermined</span>:<span>{f.estimated?"Est. ":""}{formatMoney(f.value)}</span>}
          <select aria-label={`Unit cost metric for ${vendorItem.vendor_item_code}`} style={{...inputStyle,marginTop:4,minWidth:100}} disabled={!canManage||busy||!comparisonUnits(current.pack_size).length} value={baseFieldsOnly&&autoSave&&!trialVisible.unit_cost_unit?"":current.unit_cost_unit||f.unit||defaultComparisonUnit(current.pack_size,industry)||""} onChange={e=>edit("unit_cost_unit",e.target.value)}>
            <option value="" disabled>Select measurement</option>
            {current.unit_cost_unit&&!comparisonUnits(current.pack_size).includes(current.unit_cost_unit)&&<option value={current.unit_cost_unit}>{unitLabel(current.unit_cost_unit)} — check pack</option>}
            {comparisonUnits(current.pack_size).map(unit=><option key={unit} value={unit}>{unitLabel(unit)}</option>)}
          </select>
          {!baseFieldsOnly&&f.unit&&<small style={{display:"block"}}>per {unitLabel(f.unit).toLowerCase()}{dirty?" · preview":""}</small>}
        </>;
        const sourceKey={product:"description",pack:"packSize",sellingUnit:"sellingUnit"}[key]||key;
        const change=vendorItem.import_row?.reviewRequired&&vendorItem.import_row?.changes?.find(c=>c.field===sourceKey);
        return <td key={key} style={{...cellStyle,background:change?"#FFF3E0":undefined}}>{content}{!baseFieldsOnly&&<Evidence field={f}/>}{autoSave&&key==="product"&&saveStatus}{change&&<small style={{display:"block",color:"#9B4400"}} title={change.reason}>Changed on new sheet</small>}</td>;
      })}
      {!autoSave&&<td style={{...cellStyle,minWidth:115}}>
        {canManage&&<button disabled={busy||(baseFieldsOnly&&!dirty)} onClick={()=>save()} style={{...btn("#003584","white",{fontSize:11,padding:6})}}>{busy?"Applying…":"Apply"}</button>}
        {dirty&&<button disabled={busy} onClick={()=>{setDraft(prior=>baseFieldsOnly?Object.fromEntries(Object.entries(prior).filter(([key])=>!BASE_EDIT_FIELDS.has(key))):{});setNameDraft(null);setNumberDraft(null);setBase(null);if(!baseFieldsOnly)setPackParts(null);setError("");}} style={{border:0,background:"none",cursor:"pointer",fontSize:11}}>Undo edits</button>}
        {!baseFieldsOnly&&<button onClick={()=>setDetails(!details)} style={{display:"block",marginTop:6,border:0,background:"none",cursor:"pointer",color:"#245785"}}>Details</button>}
        {vendorItem.import_row?.reviewRequired&&<small style={{display:"block",color:"#9B4400"}}>New quote needs review</small>}
        {!baseFieldsOnly&&parsedPack?.catchWeight&&currentBasis?.basis==='measure'&&<VariableWeightConfirmation service={variableWeightService} organizationId={orgId} listing={vendorItem} mapping={mapping} catalogItemId={item.id} settings={settings} approval={variableApproval} disabled={dirty||busy} canManage={canManage} onChanged={onVariableApprovalChanged}/>}
        {saved&&<small role="status" style={{color:"#276742"}}>Saved</small>}
        {error&&<div role="alert" style={{fontSize:11,color:"#A32B20",whiteSpace:"normal"}}>{error}</div>}
      </td>}
    </tr>
    {!autoSave&&!baseFieldsOnly&&overrideOpen&&<tr><td colSpan={CATALOG_COLUMNS.length+2}>
      <MovableDialog label="Unit cost override" maxWidth={428} zIndex={1000}>
        <div style={{background:"white",padding:24,borderRadius:10,width:380,maxWidth:"90vw"}}>
          <div>KERDOS cannot calculate unit cost from this pack and quoted unit. Enter your approved values to continue.</div>
          <label style={{display:"block",marginTop:12}}>Unit cost<input aria-label="Override unit cost" type="number" min="0" step="any" style={inputStyle} value={overrideCost} onChange={e=>setOverrideCost(e.target.value)}/></label>
          <label style={{display:"block",marginTop:12}}>Per measurement<select aria-label="Override measurement" style={inputStyle} value={overrideUnit} onChange={e=>setOverrideUnit(e.target.value)}>{unitChoices(vocabulary,false,"").map(u=><option key={u.value} value={u.value}>{unitLabel(u.value)}</option>)}</select></label>
          <label style={{display:"block",marginTop:12}}>Price for one purchasing pack<input aria-label="Override purchasing pack price" type="number" min="0" step="any" style={inputStyle} value={overridePackPrice} onChange={e=>setOverridePackPrice(e.target.value)}/></label>
          <small>This is the amount charged when you order quantity 1.</small>
          {error&&<div role="alert" style={{color:"#A32B20"}}>{error}</div>}
          <div style={{marginTop:16}}><button disabled={busy} onClick={()=>save({price:Number(overrideCost),unit:overrideUnit,packPrice:Number(overridePackPrice)})} style={btn("#003584","white")}>Apply override</button><button disabled={busy} onClick={()=>setOverrideOpen(false)} style={{marginLeft:12}}>Cancel</button></div>
        </div>
      </MovableDialog>
    </td></tr>}
    {!baseFieldsOnly&&details&&<tr><td colSpan={CATALOG_COLUMNS.length+2} style={{...cellStyle,background:"#F2F6FA"}}>
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
      <ul style={{fontSize:12}}>{CATALOG_COLUMNS.map(([key,label])=><li key={key}><b>{label}:</b> {evidence[key].reason.replace(/Manual association/g,"Client-selected association").replace(/Automated association/g,"Catalog association")}</li>)}</ul>
      <button disabled={dirty||busy} onClick={onDetails} style={{...btn("#E8F1FB","#003584",{fontSize:11})}}>Vendor comparison and association details</button>
    </td></tr>}
  </>;
}
export function CatalogRows({autoSave=false,userId,baseFieldsOnly=false,sortMode="alphabetical",industry="",orgId,items,catalogItems,vendorItems,mappings,vendors,categories,vocabulary,canManage,onUpdated,onDetails,settings={},editors={}}){
  const [selected,setSelected]=useState(new Set());
  const [expanded,setExpanded]=useState(new Set());
  const [sort,setSort]=useState({key:"itemName",direction:1});
  const [variableApprovals,setVariableApprovals]=useState({}),[approvalError,setApprovalError]=useState('');
  const variableIds=vendorItems.filter(v=>parsePackSize(v.pack_size)?.catchWeight&&priceBasisFor(v.selling_unit)?.basis==='measure').map(v=>v.id).sort().join('|');
  useEffect(()=>{
    let active=true;setVariableApprovals({});setApprovalError('');
    if(variableWeightService.supported&&orgId&&variableIds)variableWeightService.list(orgId,variableIds.split('|')).then(rows=>{
      if(active)setVariableApprovals(Object.fromEntries(rows.map(row=>[row.terms.vendorItemId,row])));
    }).catch(err=>{if(active)setApprovalError(err.message||String(err));});
    return ()=>{active=false;};
  },[orgId,variableIds]);
  const catalog=new Map(catalogItems.map(i=>[i.id,i])),viById=new Map(vendorItems.map(v=>[v.id,v])),vendorById=new Map(vendors.map(v=>[v.id,v]));
  const visible=new Set(items.map(i=>i.catalogItemId));
  const rows=mappings.filter(m=>visible.has(m.catalog_item_id)).flatMap(mapping=>{
    const item=catalog.get(mapping.catalog_item_id),vendorItem=viById.get(mapping.vendor_item_id);if(!item||!vendorItem)return [];
    const vendor=vendorById.get(vendorItem.vendor_id),category=categories.find(c=>c.id===item.category_id);
    // The other vendors' rows on this item, for cross-vendor checks.
    const peers=mappings.filter(o=>o.catalog_item_id===mapping.catalog_item_id&&o.id!==mapping.id).map(o=>viById.get(o.vendor_item_id)).filter(Boolean);
    const clientName=clientProductName(item,[vendorItem,...peers],industry)||'Product name needed';
    return [{mapping,item,vendorItem,vendor,peers,clientName,evidence:catalogRowEvidence({item,vendorItem,vendor,mapping,category,peers,categories})}];
  }).sort((a,b)=>{
    const av=sort.key==='itemName'?a.clientName:a.evidence[sort.key].value,bv=sort.key==='itemName'?b.clientName:b.evidence[sort.key].value;
    if(av==null)return bv==null?0:1;if(bv==null)return -1;
    const compared=typeof av==="number"&&typeof bv==="number"?av-bv:String(av).localeCompare(String(bv),undefined,{numeric:true,sensitivity:'base'});
    if(compared)return sort.direction*compared;
    return Number(a.item.master_item_number)-Number(b.item.master_item_number)||a.item.id.localeCompare(b.item.id)||String(a.vendor?.name||'').localeCompare(String(b.vendor?.name||''))||a.vendorItem.id.localeCompare(b.vendorItem.id);
  });
  // Organize by saved catalog identity only. This view never creates or
  // changes an association, and identical names on different IDs stay separate.
  const groups=new Map();
  for(const row of rows){
    if(!groups.has(row.item.id))groups.set(row.item.id,{id:row.item.id,name:row.clientName,number:row.item.master_item_number,rows:[]});
    groups.get(row.item.id).rows.push(row);
  }
  for(const item of items)if(!groups.has(item.catalogItemId)){
    const catalogItem=catalog.get(item.catalogItemId);
    groups.set(item.catalogItemId,{id:item.catalogItemId,name:clientProductName(catalogItem||{name:item.name},[],industry)||item.name||'Product name needed',number:catalogItem?.master_item_number??item.masterItemNumber,rows:[]});
  }
  const browseById=new Map(items.map(item=>[item.catalogItemId,item]));
  const orderedGroups=[...groups.values()].sort((a,b)=>compareItems({...browseById.get(a.id),name:a.name,masterItemNumber:a.number,options:browseById.get(a.id)?.options||[]},{...browseById.get(b.id),name:b.name,masterItemNumber:b.number,options:browseById.get(b.id)?.options||[]},sortMode)||a.id.localeCompare(b.id));
  return <div data-catalog-base-trial={baseFieldsOnly} style={{borderRadius:10,background:"white",marginBottom:16}}>
    {approvalError&&<p role="alert" style={{padding:12,color:'#A32B20'}}>Could not load variable-weight confirmations: {approvalError}</p>}
    {orderedGroups.map(group=><details key={group.id} data-catalog-group={group.id} open={expanded.has(group.id)} onToggle={event=>{const open=event.currentTarget.open;setExpanded(prior=>{if(prior.has(group.id)===open)return prior;const next=new Set(prior);if(open)next.add(group.id);else next.delete(group.id);return next;});}} style={{borderTop:'1px solid #DEE7F0'}}>
      <summary style={{padding:'14px 16px',color:'#003584',background:'#E8F0FA',cursor:'pointer',fontWeight:700}}>{group.name}<span style={{marginLeft:12,fontSize:12,fontWeight:400}}>KERDOS #{group.number??'—'}</span></summary>
      {canManage&&selected.size>0&&group.rows.some(row=>selected.has(row.vendorItem.id))&&<div style={{padding:10}}><AssociateAlternatives showSuggestionTools={false} orgId={orgId} selectedVendorIds={[...selected]} vendorItems={vendorItems} catalogItems={catalogItems} mappings={mappings} vendors={vendors} onUpdated={onUpdated} onClear={()=>setSelected(new Set())}/></div>}
      <div style={{overflowX:'auto'}}><table aria-label={`Vendor listings for ${group.name}`} style={{borderCollapse:"collapse",width:"100%",minWidth:1250,fontSize:12}}><thead><tr><th style={cellStyle}>Select</th>{CATALOG_COLUMNS.map(([key,label])=><th key={key} style={{...cellStyle,textAlign:"left",background:"#E8F0FA"}} aria-sort={sort.key===key?sort.direction===1?"ascending":"descending":"none"}><button style={{border:0,background:"none",fontWeight:700,cursor:"pointer"}} onClick={()=>setSort(s=>({key,direction:s.key===key?-s.direction:1}))}>{label}{sort.key===key?sort.direction===1?" ↑":" ↓":""}</button></th>)}{!autoSave&&<th style={cellStyle}>Actions</th>}</tr></thead>
      <tbody>{group.rows.map(row=><EditableRow autoSave={autoSave} userId={userId} baseFieldsOnly={baseFieldsOnly} selected={selected.has(row.vendorItem.id)} onSelect={()=>setSelected(prior=>{const next=new Set(prior);if(next.has(row.vendorItem.id))next.delete(row.vendorItem.id);else next.add(row.vendorItem.id);return next;})} variableApproval={variableApprovals[row.vendorItem.id]} onVariableApprovalChanged={approval=>setVariableApprovals(prior=>({...prior,[row.vendorItem.id]:approval}))} industry={industry} allCatalogItems={catalogItems} allVendorItems={vendorItems} allMappings={mappings} settings={settings} editors={editors} key={`${orgId}:${userId||""}:${row.vendorItem.id}`} {...row} orgId={orgId} categories={categories} vocabulary={vocabulary} canManage={canManage} onUpdated={onUpdated} onDetails={()=>onDetails(row.item.id)} />)}
      {!group.rows.length&&<tr><td colSpan={CATALOG_COLUMNS.length+1} style={cellStyle}>No vendor listing linked yet.</td><td><button onClick={()=>onDetails(group.id)}>Details</button></td></tr>}
      </tbody>
    </table></div></details>)}
  </div>;
}
