/**
 * EmailInboxPanel.jsx
 *
 * Module A · Pre-Ingestion · Task 1 · Email Routing
 *
 * Two panels exported:
 *   RoutingAddressPanel — create / list / deactivate routing addresses
 *   EmailInboxPanel     — inbox of inbound messages with "Review & Import"
 *
 * "Review & Import" flow:
 *   1. getAttachmentFile()  → File object from Storage
 *   2. Opens PasteModal with initialFiles={[file]}
 *   3. After PasteModal saves, calls markAttachmentIngested()
 *
 * The existing vendor-selection and import-review flow inside PasteModal is
 * preserved exactly; this module only supplies the initial File.
 *
 * Optional forwarding: each routing address has a forward_to field.
 * The Edge Function reads it and can forward a copy to that address.
 * The UI surfaces it as an optional "Forward email text to" input on create.
 */

import {useEffect,useState,useCallback} from "react";
import {backend} from "../backend/index.js";
import {
  createRoutingAddress,
  listRoutingAddresses,
  deactivateRoutingAddress,
  listMessages,
  getMessage,
  listPendingAttachments as _listPendingAttachments,
  markAttachmentIngested,
  getAttachmentFile,
} from "../services/email-routing.js";
import {btn,inp} from "../ui/styles.js";
import {formatDate} from "../localization.js";
import {attachmentRenderOutcome,attachmentActionBlocked} from "../utils/attachment-state.js";

// ── helpers ────────────────────────────────────────────────────────────────

function Section({title,children,action}){
  return(
    <div style={{background:"white",borderRadius:10,padding:16,boxShadow:"0 1px 3px rgba(0,0,0,0.08)",marginBottom:16}}>
      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
        <h4 style={{margin:0,fontSize:14,fontWeight:700}}>{title}</h4>
        {action}
      </div>
      {children}
    </div>
  );
}

function Badge({n,color="#003584"}){
  if(!n) return null;
  return(
    <span style={{background:color,color:"white",borderRadius:10,fontSize:11,fontWeight:700,
      padding:"2px 7px",marginLeft:6,verticalAlign:"middle"}}>
      {n}
    </span>
  );
}

// ── RoutingAddressPanel ────────────────────────────────────────────────────

export function RoutingAddressPanel({orgId,onUpdated}){
  const [addresses,setAddresses]=useState([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [showForm,setShowForm]=useState(false);
  const [address,setAddress]=useState("");
  const [label,setLabel]=useState("");
  const [forwardTo,setForwardTo]=useState("");
  const [saving,setSaving]=useState(false);
  const [deactivating,setDeactivating]=useState(null);

  const load=useCallback(async()=>{
    setLoading(true);setError("");
    try{
      const rows=await listRoutingAddresses(backend,orgId);
      setAddresses(rows);
    }catch(e){setError(e.message);}
    setLoading(false);
  },[orgId]);

  useEffect(()=>{load();},[load]);

  async function handleCreate(e){
    e.preventDefault();
    if(!address.trim()){setError("Routing address is required.");return;}
    setSaving(true);setError("");
    try{
      await createRoutingAddress(backend,orgId,{
        routingAddress:address.trim(),
        label:label.trim()||null,
        forwardTo:forwardTo.trim()||null,
      });
      setShowForm(false);setAddress("");setLabel("");setForwardTo("");
      await load();
      onUpdated?.();
    }catch(e){setError(e.message);}
    setSaving(false);
  }

  async function handleDeactivate(id){
    if(!window.confirm("Remove this routing address? Emails sent to it will no longer be received.")) return;
    setDeactivating(id);setError("");
    try{
      await deactivateRoutingAddress(backend,orgId,id);
      await load();
      onUpdated?.();
    }catch(e){setError(e.message);}
    setDeactivating(null);
  }

  return(
    <Section
      title="📧 Email Routing Addresses"
      action={!showForm&&<button onClick={()=>setShowForm(true)}
        style={{...btn("#003584","white",{fontSize:12,padding:"6px 12px"})}}>+ Add Address</button>}>

      {error&&<p style={{color:"#c62828",fontSize:13,margin:"0 0 10px"}}>{error}</p>}

      {showForm&&(
        <form onSubmit={handleCreate} style={{background:"#F8F9FE",borderRadius:8,padding:14,marginBottom:14}}>
          <div style={{marginBottom:10}}>
            <label style={{fontSize:12,fontWeight:600,display:"block",marginBottom:4}}>
              Routing address <span style={{color:"#c62828"}}>*</span>
            </label>
            <input
              style={{...inp,fontSize:13}}
              placeholder="acme-pricing@inbound.kerdos.com"
              value={address}
              onChange={e=>setAddress(e.target.value)}
              autoFocus
            />
            <p style={{fontSize:11,color:"#888",margin:"4px 0 0"}}>
              Must be a full address on the inbound.kerdos.com domain. Postmark will route
              emails to this address to your inbox below.
            </p>
          </div>
          <div style={{marginBottom:10}}>
            <label style={{fontSize:12,fontWeight:600,display:"block",marginBottom:4}}>Label (optional)</label>
            <input
              style={{...inp,fontSize:13}}
              placeholder="Pricing sheet inbox"
              value={label}
              onChange={e=>setLabel(e.target.value)}
            />
          </div>
          <div style={{marginBottom:14}}>
            <label style={{fontSize:12,fontWeight:600,display:"block",marginBottom:4}}>
              Forward email text to (optional)
            </label>
            <input
              style={{...inp,fontSize:13}}
              placeholder="you@yourcompany.com"
              value={forwardTo}
              onChange={e=>setForwardTo(e.target.value)}
            />
            <p style={{fontSize:11,color:"#888",margin:"4px 0 0"}}>
              If set, the Edge Function will forward a plain-text copy of each received email
              to this address. Attachments and HTML are not included in the forwarded copy.
              Requires POSTMARK_FORWARD_FROM to be set to a verified Postmark sender address
              in Supabase Secrets.
            </p>
          </div>
          <div style={{display:"flex",gap:8}}>
            <button type="submit" disabled={saving}
              style={{...btn("#003584","white",{fontSize:12,padding:"7px 14px",opacity:saving?0.6:1})}}>
              {saving?"Saving…":"Save address"}
            </button>
            <button type="button" onClick={()=>{setShowForm(false);setError("");}}
              style={{...btn("#EEE","#333",{fontSize:12,padding:"7px 14px"})}}>
              Cancel
            </button>
          </div>
        </form>
      )}

      {loading
        ? <p style={{fontSize:13,color:"#888",margin:0}}>Loading…</p>
        : addresses.length===0
          ? <p style={{fontSize:13,color:"#888",margin:0}}>
              No active routing addresses. Add one above so vendors can email price sheets directly to KERDOS.
            </p>
          : (
            <div style={{display:"flex",flexDirection:"column",gap:8}}>
              {addresses.map(a=>(
                <div key={a.id} style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start",
                  background:"#F8F9FE",borderRadius:8,padding:"10px 14px"}}>
                  <div>
                    <div style={{fontWeight:700,fontSize:13,fontFamily:"monospace"}}>{a.routing_address}</div>
                    {a.label&&<div style={{fontSize:12,color:"#555",marginTop:2}}>{a.label}</div>}
                    {a.forward_to&&(
                      <div style={{fontSize:11,color:"#888",marginTop:2}}>↪ text forwarded to {a.forward_to}</div>
                    )}
                  </div>
                  <button
                    disabled={deactivating===a.id}
                    onClick={()=>handleDeactivate(a.id)}
                    style={{...btn("#FFF3E0","#E65100",{fontSize:11,padding:"5px 10px",
                      border:"1px solid #FFCC80",opacity:deactivating===a.id?0.5:1,flexShrink:0,marginLeft:8})}}>
                    {deactivating===a.id?"Removing…":"Remove"}
                  </button>
                </div>
              ))}
            </div>
          )
      }
    </Section>
  );
}

// ── AttachmentRow ──────────────────────────────────────────────────────────
// One row inside a message's attachment list. Handles the fetch → PasteModal
// open → markAttachmentIngested lifecycle for a single attachment.

function AttachmentRow({att,orgId,vendors,orgSettings,catalogItems,categories,vocabulary,vendorItems,mappings,industry,onDone}){
  const [status,setStatus]=useState("idle"); // idle | loading | error | ingested
  const [error,setError]=useState("");
  // Lifted-state for the PasteModal triggered by this attachment
  const [pendingFile,setPendingFile]=useState(null);
  // Gap 3: track import doc id when markAttachmentIngested fails after import success
  const [pendingImportDocumentId,setPendingImportDocumentId]=useState(null);
  // A1.7.c: also preserve the final status so the retry can set processing_status
  // atomically — without it a retry after a transient failure leaves the attachment
  // in 'needs_review' even after the import_document_id link succeeds.
  const [pendingFinalStatus,setPendingFinalStatus]=useState(null);
  const [auditError,setAuditError]=useState("");

  const renderOutcome=attachmentRenderOutcome(att,status);

  async function handleReviewAndImport(){
    if(attachmentActionBlocked(att,status)) return;
    setStatus("loading");setError("");
    let file;
    try{
      file=await getAttachmentFile(backend,orgId,att.id);
    }catch(e){
      setError(e.message||"Could not fetch attachment.");
      setStatus("error");
      return;
    }
    setStatus("idle");
    setPendingFile(file);
  }

  // Called by PasteModal's onFinished after a successful save
  async function handleImportFinished(result){
    const importDocumentId=result?.importDocumentId||result?.id;
    setPendingFile(null);
    if(importDocumentId){
      try{
        // A1.7.c: pass 'auto_imported' so processing_status is updated atomically
        // with the import_document_id link — the attachment clears from the
        // pending queue without a separate status-update round-trip.
        await markAttachmentIngested(backend,orgId,att.id,importDocumentId,"auto_imported");
        setStatus("ingested");
        onDone?.();
      }catch(e){
        // Import succeeded but the audit trail link failed.
        // Preserve the importDocumentId so the user can retry the link
        // without re-importing the file.
        setPendingImportDocumentId(importDocumentId);
        setPendingFinalStatus("auto_imported");
        setAuditError(`Import saved, but the audit link failed: ${e.message}. Click Retry to re-link.`);
      }
    }else{
      onDone?.();
    }
  }

  async function handleRetryAudit(){
    if(!pendingImportDocumentId) return;
    setAuditError("");
    try{
      // A1.7.c: pass the preserved final status so processing_status is updated
      // atomically on retry — mark_attachment_ingested's idempotency path applies it
      // even when the import_document_id link already exists from the first attempt.
      await markAttachmentIngested(backend,orgId,att.id,pendingImportDocumentId,pendingFinalStatus);
      setPendingImportDocumentId(null);
      setPendingFinalStatus(null);
      setStatus("ingested");
      onDone?.();
    }catch(e){
      setAuditError(`Retry failed: ${e.message}`);
    }
  }

  const icon=att.content_type?.includes("pdf")?"📄":att.content_type?.includes("sheet")?"📊":"📎";
  const sizeKB=att.file_size_bytes?`${Math.round(att.file_size_bytes/1024)} KB`:"";

  // Gap 2: permanently failed attachment — show error state, no import button
  if(renderOutcome==="failed"){
    return(
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"7px 0",borderTop:"1px solid #F0F0F0"}}>
        <span style={{fontSize:16,flexShrink:0}}>⚠️</span>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
            {att.filename}
          </div>
          <div style={{fontSize:11,color:"#c62828"}}>Decode failed — {att.ingest_error}</div>
        </div>
        <span style={{fontSize:11,color:"#c62828",fontWeight:700,whiteSpace:"nowrap"}}>⚠ Failed</span>
      </div>
    );
  }

  return(
    <>
      <div style={{display:"flex",alignItems:"center",gap:8,padding:"7px 0",
        borderTop:"1px solid #F0F0F0"}}>
        <span style={{fontSize:16,flexShrink:0}}>{icon}</span>
        <div style={{flex:1,minWidth:0}}>
          <div style={{fontSize:13,fontWeight:600,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
            {att.filename}
          </div>
          {sizeKB&&<div style={{fontSize:11,color:"#888"}}>{sizeKB}</div>}
        </div>
        {renderOutcome==="imported"
          ? <span style={{fontSize:11,color:"#388e3c",fontWeight:700,whiteSpace:"nowrap"}}>✓ Imported</span>
          : <button
              disabled={status==="loading"}
              onClick={handleReviewAndImport}
              style={{...btn(renderOutcome==="partial"?"#E65100":"#003584","white",{fontSize:11,padding:"5px 10px",whiteSpace:"nowrap",
                opacity:status==="loading"?0.6:1,flexShrink:0})}}>
              {status==="loading"?"Loading…":renderOutcome==="partial"?"Complete Import":"Review & Import"}
            </button>
        }
      </div>
      {error&&<p style={{color:"#c62828",fontSize:12,margin:"2px 0 4px"}}>{error}</p>}
      {/* Gap 3: audit-link retry UI shown when import succeeded but markAttachmentIngested failed */}
      {auditError&&(
        <div style={{fontSize:12,color:"#E65100",marginTop:4,display:"flex",alignItems:"center",
          gap:8,flexWrap:"wrap"}}>
          <span>{auditError}</span>
          <button onClick={handleRetryAudit}
            style={{...btn("#FFF3E0","#E65100",{fontSize:11,padding:"4px 8px",
              border:"1px solid #FFCC80"})}}>
            Retry
          </button>
        </div>
      )}

      {/* PasteModal is rendered inline here so each attachment manages its own modal */}
      {pendingFile&&(
        <LazyPasteModal
          file={pendingFile}
          industry={industry}
          vendors={vendors}
          orgId={orgId}
          orgSettings={orgSettings}
          catalogItems={catalogItems}
          categories={categories}
          vocabulary={vocabulary}
          vendorItems={vendorItems}
          mappings={mappings}
          onClose={()=>setPendingFile(null)}
          onDone={()=>{}}
          onFinished={handleImportFinished}
          inboxImportDocumentId={att.import_document_id||null}
        />
      )}
    </>
  );
}

// ── LazyPasteModal ─────────────────────────────────────────────────────────
// Thin wrapper that passes the pre-fetched file via initialFiles.

function LazyPasteModal({file,...pasteProps}){
  // Dynamically import PasteModal so EmailInboxPanel doesn't add to the
  // initial bundle when the inbox tab isn't open.
  const [Comp,setComp]=useState(null);
  useEffect(()=>{
    import("./ImportModal.jsx").then(m=>setComp(()=>m.PasteModal));
  },[]);
  if(!Comp) return null;
  return(
    <Comp
      {...pasteProps}
      initialFiles={[file]}
    />
  );
}

// ── MessageRow ─────────────────────────────────────────────────────────────

function MessageRow({msg,orgId,vendors,orgSettings,catalogItems,categories,vocabulary,vendorItems,mappings,industry,onDone}){
  const [open,setOpen]=useState(false);
  const [detail,setDetail]=useState(null);
  const [loadingDetail,setLoadingDetail]=useState(false);
  const [detailError,setDetailError]=useState("");

  async function toggleOpen(){
    if(open){setOpen(false);return;}
    setOpen(true);
    if(detail) return;
    setLoadingDetail(true);setDetailError("");
    try{
      const row=await getMessage(backend,orgId,msg.id);
      setDetail(row);
    }catch(e){setDetailError(e.message);}
    setLoadingDetail(false);
  }

  const pendingCount=msg.pending_count||0;
  const totalCount=msg.attachment_count||0;
  const dateStr=msg.received_at?formatDate(new Date(msg.received_at)):"";

  return(
    <div style={{borderBottom:"1px solid #F0F0F0"}}>
      <div
        onClick={toggleOpen}
        style={{display:"flex",alignItems:"center",gap:10,padding:"12px 0",cursor:"pointer"}}>
        <span style={{fontSize:18,flexShrink:0}}>{open?"▾":"▸"}</span>
        <div style={{flex:1,minWidth:0}}>
          <div style={{display:"flex",alignItems:"baseline",gap:8,flexWrap:"wrap"}}>
            <span style={{fontWeight:700,fontSize:13,overflow:"hidden",textOverflow:"ellipsis",
              whiteSpace:"nowrap",maxWidth:220}}>
              {msg.sender_name||msg.sender_email}
            </span>
            {msg.sender_name&&(
              <span style={{fontSize:11,color:"#888",overflow:"hidden",textOverflow:"ellipsis",
                whiteSpace:"nowrap"}}>
                {msg.sender_email}
              </span>
            )}
          </div>
          <div style={{fontSize:12,color:"#333",marginTop:2,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
            {msg.subject||"(no subject)"}
          </div>
        </div>
        <div style={{textAlign:"right",flexShrink:0}}>
          <div style={{fontSize:11,color:"#888"}}>{dateStr}</div>
          {totalCount>0&&(
            <div style={{fontSize:11,marginTop:2}}>
              📎 {totalCount}
              {pendingCount>0&&(
                <Badge n={pendingCount} color="#E65100"/>
              )}
            </div>
          )}
        </div>
      </div>

      {open&&(
        <div style={{paddingLeft:28,paddingBottom:12}}>
          {loadingDetail&&<p style={{fontSize:13,color:"#888",margin:0}}>Loading…</p>}
          {detailError&&<p style={{color:"#c62828",fontSize:13,margin:0}}>{detailError}</p>}
          {detail&&(
            <>
              {detail.body_text&&(
                <p style={{fontSize:12,color:"#555",margin:"0 0 10px",
                  whiteSpace:"pre-wrap",maxHeight:100,overflow:"auto",
                  background:"#FAFAFA",padding:"8px 10px",borderRadius:6}}>
                  {detail.body_text}
                </p>
              )}
              {(detail.inbound_attachments||[]).length===0
                ? <p style={{fontSize:12,color:"#888",margin:0}}>No attachments.</p>
                : (detail.inbound_attachments||[]).map(att=>(
                    <AttachmentRow
                      key={att.id}
                      att={att}
                      orgId={orgId}
                      vendors={vendors}
                      orgSettings={orgSettings}
                      catalogItems={catalogItems}
                      categories={categories}
                      vocabulary={vocabulary}
                      vendorItems={vendorItems}
                      mappings={mappings}
                      industry={industry}
                      onDone={()=>{
                        // Refresh detail so pending count updates
                        getMessage(backend,orgId,msg.id).then(r=>{if(r)setDetail(r);});
                        onDone?.();
                      }}
                    />
                  ))
              }
            </>
          )}
        </div>
      )}
    </div>
  );
}

// ── EmailInboxPanel ────────────────────────────────────────────────────────

export function EmailInboxPanel({
  orgId,
  industry="",
  vendors=[],
  orgSettings,
  catalogItems=[],
  categories=[],
  vocabulary=[],
  vendorItems=[],
  mappings=[],
  onDone,
}){
  const [messages,setMessages]=useState([]);
  const [loading,setLoading]=useState(true);
  const [error,setError]=useState("");
  const [pendingTotal,setPendingTotal]=useState(0);

  const load=useCallback(async()=>{
    setLoading(true);setError("");
    try{
      const msgs=await listMessages(backend,orgId);
      setMessages(msgs);
      setPendingTotal(msgs.reduce((n,m)=>n+(m.pending_count||0),0));
    }catch(e){setError(e.message);}
    setLoading(false);
  },[orgId]);

  useEffect(()=>{load();},[load]);

  return(
    <Section
      title={<>📥 Email Inbox{pendingTotal>0&&<Badge n={pendingTotal} color="#E65100"/>}</>}
      action={<button onClick={load}
        style={{...btn("#EEE","#333",{fontSize:12,padding:"6px 12px"})}}>↺ Refresh</button>}>

      {error&&<p style={{color:"#c62828",fontSize:13,margin:"0 0 10px"}}>{error}</p>}

      {loading
        ? <p style={{fontSize:13,color:"#888",margin:0}}>Loading…</p>
        : messages.length===0
          ? <p style={{fontSize:13,color:"#888",margin:0}}>
              No emails received yet. Share a routing address with your vendors so they can
              email price sheets directly to KERDOS.
            </p>
          : messages.map(msg=>(
              <MessageRow
                key={msg.id}
                msg={msg}
                orgId={orgId}
                industry={industry}
                vendors={vendors}
                orgSettings={orgSettings}
                catalogItems={catalogItems}
                categories={categories}
                vocabulary={vocabulary}
                vendorItems={vendorItems}
                mappings={mappings}
                onDone={()=>{load();onDone?.();}}
              />
            ))
      }
    </Section>
  );
}
