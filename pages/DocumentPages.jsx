import {useEffect,useRef,useState} from "react";
import {createPortal} from "react-dom";

const navy="#073B83",ink="#17243A",muted="#6D7A8B",line="#E4EAF1",surface="#F5F8FC";
const button=(background,color="white")=>({background,color,border:"1px solid transparent",borderRadius:9,padding:"10px 14px",fontWeight:800,cursor:"pointer",fontSize:12,boxShadow:"0 1px 2px rgba(16,35,61,.08)"});
const card={background:"white",borderRadius:12,marginBottom:8,border:`1px solid ${line}`,boxShadow:"0 3px 12px rgba(16,35,61,.05)",overflow:"hidden"};

function VendorFilter({vendors,value,onChange,label="View vendor"}){
  return <label style={{display:"flex",alignItems:"center",gap:10,fontSize:11,fontWeight:800,color:muted}}>{label}
    <select value={value||""} onChange={event=>onChange(event.target.value||null)} style={{minWidth:220,background:"white",color:ink,border:`1px solid ${line}`,borderRadius:9,padding:"9px 34px 9px 11px",fontWeight:700}}>
      <option value="">All vendors</option>{vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
    </select>
  </label>;
}

function PageHeader({eyebrow,title,description,actionLabel,onAction,secondaryLabel,onSecondary}){
  return <div style={{background:"linear-gradient(135deg,#FFFFFF 0%,#F3F8FF 100%)",border:`1px solid ${line}`,borderRadius:16,padding:"22px 24px",marginBottom:14,boxShadow:"0 8px 28px rgba(16,35,61,.08)"}}>
    <div style={{fontSize:10,fontWeight:800,color:"#4A90D9",letterSpacing:"0.1em",textTransform:"uppercase",marginBottom:4}}>{eyebrow}</div>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,flexWrap:"wrap"}}>
      <div><h2 style={{margin:"0 0 5px",fontSize:24,color:navy,letterSpacing:"-.02em"}}>{title}</h2><div style={{fontSize:12,color:muted,maxWidth:720,lineHeight:1.5}}>{description}</div></div>
      <div style={{display:"flex",gap:8}}>
        {secondaryLabel&&<button onClick={onSecondary} style={button("#E8F5E9","#2E7D32")}>{secondaryLabel}</button>}
        {actionLabel&&<button onClick={onAction} style={button("#003584")}>{actionLabel}</button>}
      </div>
    </div>
  </div>;
}

function MoreMenu({children,label="Vendor actions"}){
  const [open,setOpen]=useState(false);
  const trigger=useRef(null),panel=useRef(null);
  const [position,setPosition]=useState({top:0,left:0});
  useEffect(()=>{
    if(!open)return;
    const dismiss=event=>{if(!trigger.current?.contains(event.target)&&!panel.current?.contains(event.target))setOpen(false);};
    const escape=event=>{if(event.key==="Escape")setOpen(false);};
    const scroll=()=>setOpen(false);
    document.addEventListener("pointerdown",dismiss);document.addEventListener("keydown",escape);
    window.addEventListener("scroll",scroll,true);window.addEventListener("resize",scroll);
    return ()=>{document.removeEventListener("pointerdown",dismiss);document.removeEventListener("keydown",escape);window.removeEventListener("scroll",scroll,true);window.removeEventListener("resize",scroll);};
  },[open]);
  function toggle(){
    if(!open){const rect=trigger.current.getBoundingClientRect();setPosition({left:Math.max(8,Math.min(rect.right-240,window.innerWidth-248)),top:rect.bottom+126>window.innerHeight?Math.max(8,rect.top-126):rect.bottom+5});}
    setOpen(!open);
  }
  return <div onClick={event=>event.stopPropagation()}><button ref={trigger} aria-label={label} aria-expanded={open} title={label} onClick={toggle} style={{...button("white",navy),border:`1px solid ${line}`,padding:"7px 11px",fontSize:17,lineHeight:1}}>•••</button>
    {open&&createPortal(<div ref={panel} role="menu" onClick={()=>setOpen(false)} style={{position:"fixed",left:position.left,top:position.top,zIndex:1000,width:"min(240px, calc(100vw - 16px))",maxHeight:"min(220px, 60vh)",overflowY:"auto",background:"white",border:`1px solid ${line}`,borderRadius:10,boxShadow:"0 12px 30px rgba(16,35,61,.25)",padding:6}}>{children}</div>,document.body)}
  </div>;
}

function MenuButton({children,onClick,danger=false}){return <button onClick={onClick} style={{width:"100%",textAlign:"left",background:"transparent",color:danger?"#B53722":ink,border:0,borderRadius:7,padding:"9px 10px",fontWeight:700,cursor:"pointer"}}>{children}</button>;}

function VendorSection({name,count,accent,children,actions,defaultOpen=false}){
  const [open,setOpen]=useState(defaultOpen);
  return <section style={{...card,marginBottom:12}}>
    <div style={{height:4,background:accent||navy}}/>
    <div onClick={()=>setOpen(!open)} style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12,padding:"15px 17px",cursor:"pointer",userSelect:"none"}}>
      <div style={{display:"flex",alignItems:"center",gap:12}}><span style={{width:9,height:9,borderRadius:99,background:accent||navy}}/><div><h3 style={{margin:0,fontSize:15,color:ink}}>{name}</h3><div style={{fontSize:11,color:muted,marginTop:2}}>{count}</div></div></div>
      <div onClick={event=>event.stopPropagation()} style={{display:"flex",alignItems:"center",gap:10}}>{actions}<button onClick={()=>setOpen(!open)} aria-label={open?"Collapse vendor":"Open vendor"} style={{border:0,background:"transparent",color:muted,cursor:"pointer",fontSize:15}}>{open?"▲":"▼"}</button></div>
    </div>
    {open&&<div style={{background:surface,borderTop:`1px solid ${line}`,padding:12}}>{children}</div>}
  </section>;
}

function DocumentRow({title,meta,amount,warning,open,onToggle,children,controls}){
  return <article style={{...card,boxShadow:"none",marginBottom:8}}>
    <div onClick={onToggle} title="Click to open details" style={{padding:"13px 14px",display:"flex",justifyContent:"space-between",alignItems:"center",gap:14,cursor:"pointer",userSelect:"none"}}>
      <div style={{minWidth:0}}><div style={{fontWeight:800,fontSize:13,color:ink,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>▤ {title}</div><div style={{fontSize:11,color:muted,marginTop:3}}>{meta}</div>{warning}</div>
      <div style={{display:"flex",alignItems:"center",gap:11,flexShrink:0}}>{amount&&<b style={{fontSize:14,color:ink}}>{amount}</b>}{controls}<span style={{color:"#9AA6B5"}}>{open?"▲":"▼"}</span></div>
    </div>{open&&<div style={{borderTop:`1px solid ${line}`,padding:14,background:"#FBFCFE"}}>{children}</div>}
  </article>;
}

export function InvoicesPage({vendors,invoices,vendorFilter,setVendorFilter,vendorColors,formatDate,formatMoney,
  attentionCount,role,onImport,onExport,onViewOriginal,onEdit,onDelete,expandedId,setExpandedId}){
  const groups=new Map();
  for(const invoice of invoices){
    const lines=invoice.invoice_lines||[];
    const flagged=lines.filter(line=>line.price_variance!=null&&Math.abs(line.price_variance)>0.009);
    const row={...invoice,_lines:lines,_flagged:flagged,_totalVariance:flagged.reduce((sum,line)=>sum+Number(line.price_variance||0),0)};
    const id=invoice.vendor_id||"unknown";
    if(!groups.has(id))groups.set(id,[]);
    groups.get(id).push(row);
  }
  const vendorGroups=[...groups.entries()].map(([vendorId,rows])=>({vendorId,vendorName:rows[0]?.vendors?.name||vendors.find(v=>v.id===vendorId)?.name||"Unknown vendor",rows:rows.sort((a,b)=>new Date(b.invoice_date||b.created_at)-new Date(a.invoice_date||a.created_at))})).sort((a,b)=>a.vendorName.localeCompare(b.vendorName));
  const visible=vendorFilter?vendorGroups.filter(group=>group.vendorId===vendorFilter):vendorGroups;
  return <div>
    <PageHeader eyebrow="Purchasing records" title="Invoice History" description="Invoices are preserved as their original files for historical reference. KERDOS reads them in the background only to verify that ordered items and charged prices agree with the applicable price sheet." actionLabel={role!=="employee"?"🧾 Import Invoice":null} onAction={()=>onImport(vendorFilter)} secondaryLabel="Export Variance Report" onSecondary={onExport}/>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",margin:"0 0 14px",padding:"10px 12px",background:"rgba(255,255,255,.10)",borderRadius:11}}><VendorFilter vendors={vendors} value={vendorFilter} onChange={setVendorFilter}/><span style={{fontSize:11,color:"rgba(255,255,255,.78)"}}>{visible.reduce((sum,group)=>sum+group.rows.length,0)} invoice file{visible.reduce((sum,group)=>sum+group.rows.length,0)===1?"":"s"}</span></div>
    {attentionCount>0&&<div style={{background:"#FFF3E0",color:"#8A5A00",borderRadius:8,padding:"9px 12px",fontSize:12,marginBottom:14}}>{attentionCount} invoice price comparison{attentionCount===1?"":"s"} need review. The original invoice remains the source record.</div>}
    {!visible.length?<div style={{...card,padding:34,textAlign:"center",color:"#888"}}>No invoices recorded yet. Use <b>Import Invoice</b> above.</div>:visible.map(group=>{
      const color=vendorColors.get(group.vendorId)||{accent:"#003584"};
      return <VendorSection key={group.vendorId} name={group.vendorName} count={`${group.rows.length} invoice${group.rows.length===1?"":"s"}`} accent={color.accent} defaultOpen={Boolean(vendorFilter)} actions={role!=="employee"&&<MoreMenu><MenuButton onClick={()=>onImport(group.vendorId)}>Import invoice for {group.vendorName}</MenuButton></MoreMenu>}>
        {group.rows.map(invoice=>{const open=expandedId===invoice.id;const openOriginal=()=>invoice.file_path?onViewOriginal(invoice.file_path):setExpandedId(open?null:invoice.id);return <DocumentRow key={invoice.id} title={invoice.file_name||`Invoice${invoice.invoice_number?` #${invoice.invoice_number}`:""}`} meta={`${formatDate(invoice.invoice_date)||formatDate(invoice.created_at)}${invoice.invoice_number?` · Invoice #${invoice.invoice_number}`:""} · Click to open original`} amount={formatMoney(invoice.total_amount)} open={open&&!invoice.file_path} onToggle={openOriginal} warning={invoice._flagged.length>0&&<div style={{fontSize:11,fontWeight:700,color:invoice._totalVariance>0?"#C64A1B":"#0A7C48",marginTop:3}}>⚠ {formatMoney(Math.abs(invoice._totalVariance))} {invoice._totalVariance>0?"over":"under"} quoted</div>} controls={<><button onClick={event=>{event.stopPropagation();openOriginal();}} title="Open original invoice" style={{background:"none",border:"none",cursor:"pointer",color:navy}}>↗</button>{role!=="employee"&&<button onClick={event=>{event.stopPropagation();onEdit(invoice);}} title="Edit invoice record" style={{background:"none",border:"none",cursor:"pointer",color:muted}}>✎</button>}{role!=="employee"&&<button onClick={event=>{event.stopPropagation();onDelete(invoice);}} title="Delete invoice" style={{background:"none",border:"none",color:"#C64A1B",fontSize:16,cursor:"pointer"}}>×</button>}</>}>
            <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}><div><b style={{fontSize:11,color:ink}}>Original invoice file</b><div style={{fontSize:11,color:muted,marginTop:3}}>KERDOS retained the extracted data for price verification; the original document remains the historical record.</div></div>{invoice.file_path&&<button onClick={()=>onViewOriginal(invoice.file_path)} style={button("#003584")}>Open original file</button>}</div>
        </DocumentRow>;})}
      </VendorSection>;
    })}
  </div>;
}

export function PriceSheetsPage({vendors,importDocuments,vendorFilter,setVendorFilter,vendorColors,
  formatDate,role,onImport,onExpireVendor,onDelete,onClear,onViewOriginal,onViewSource,
  expandedId,setExpandedId,hasMore,loadingMore,onLoadMore}){
  // Only a saved import is a document. Price changes and catalog corrections
  // remain in price_history and never create files or affect these counts.
  const documents=(importDocuments||[]).filter(doc=>doc.document_kind==="pricelist").map(doc=>({id:doc.id,vendorId:doc.vendor_id,date:doc.created_at,fileName:doc.file_name||"Imported price sheet",filePath:doc.file_path,status:doc.status,completedCount:Array.isArray(doc.completed_keys)?doc.completed_keys.length:null}));
  const groups=new Map();for(const doc of documents){if(!groups.has(doc.vendorId))groups.set(doc.vendorId,[]);groups.get(doc.vendorId).push(doc);}
  const vendorGroups=[...groups.entries()].map(([vendorId,docs])=>({vendorId,vendorName:vendors.find(v=>v.id===vendorId)?.name||"Unknown vendor",documents:docs.sort((a,b)=>new Date(b.date)-new Date(a.date))})).sort((a,b)=>a.vendorName.localeCompare(b.vendorName));
  const visible=vendorFilter?vendorGroups.filter(group=>group.vendorId===vendorFilter):vendorGroups;
  return <div>
    <PageHeader eyebrow="Vendor source files" title="Price Sheet History" description="Your imported price sheets, organized by vendor and date. Open a file to view the original document." actionLabel={role!=="employee"?"📋 Import Price Sheet":null} onAction={()=>onImport(vendorFilter)}/>
    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",margin:"0 0 14px",padding:"10px 12px",background:"rgba(255,255,255,.10)",borderRadius:11}}><VendorFilter vendors={vendors} value={vendorFilter} onChange={setVendorFilter}/><span style={{fontSize:11,color:"rgba(255,255,255,.78)"}}>{visible.reduce((sum,group)=>sum+group.documents.length,0)} source file{visible.reduce((sum,group)=>sum+group.documents.length,0)===1?"":"s"}</span></div>
    {!visible.length?<div style={{...card,padding:34,textAlign:"center",color:"#888"}}>
      {vendorFilter
        ? <><div style={{marginBottom:10}}>No price sheets on file for <b>{vendors.find(v=>v.id===vendorFilter)?.name||"this vendor"}</b> yet.</div>
            {role!=="employee"&&onImport&&<button onClick={()=>onImport(vendorFilter)} style={{fontSize:13,fontWeight:700,padding:"8px 18px",borderRadius:8,background:"#003584",color:"white",border:"none",cursor:"pointer"}}>Import price sheet</button>}</>
        : <>No price sheets imported yet. Use <b>Import Price Sheet</b> above.</>
      }
    </div>:visible.map(group=>{const color=vendorColors.get(group.vendorId)||{accent:"#003584"};return <VendorSection key={group.vendorId} name={group.vendorName} count={`${group.documents.length} source file${group.documents.length===1?"":"s"}`} accent={color.accent} defaultOpen={Boolean(vendorFilter)} actions={role!=="employee"&&<MoreMenu><MenuButton onClick={()=>onImport(group.vendorId)}>Import price sheet</MenuButton><MenuButton danger onClick={()=>onExpireVendor(group.vendorId)}>Remove current prices from Order Guide</MenuButton></MoreMenu>}>
      {group.documents.map(doc=>{const key=String(doc.id),open=expandedId===key;const importState=doc.status==="partial"?" · Import marked incomplete":doc.status==="processing"?" · Import in progress":"";const savedCount=doc.completedCount===null?"":` · ${doc.completedCount} row${doc.completedCount===1?"":"s"} checkpointed`;return <DocumentRow key={key} title={doc.fileName} meta={`${formatDate(doc.date)}${importState}${savedCount} · Click to open`} open={open} onToggle={()=>setExpandedId(open?null:key)} controls={role!=="employee"&&<MoreMenu label={`Actions for ${doc.fileName}`}><MenuButton onClick={()=>onClear(doc)}>Clear current prices</MenuButton><MenuButton danger onClick={()=>onDelete(doc,true)}>Delete &amp; re-import</MenuButton><MenuButton danger onClick={()=>onDelete(doc,false)}>Delete source</MenuButton></MoreMenu>}>
        <button onClick={()=>doc.filePath?onViewOriginal(doc.filePath):onViewSource(doc.id)} style={button("#003584")}>{doc.filePath?"Open original file":"Open original source"}</button>
      </DocumentRow>;})}
    </VendorSection>;})}
    {hasMore&&<button onClick={onLoadMore} disabled={loadingMore} style={button("white","#003584")}>{loadingMore?"Loading…":"Load earlier imported documents"}</button>}
  </div>;
}
