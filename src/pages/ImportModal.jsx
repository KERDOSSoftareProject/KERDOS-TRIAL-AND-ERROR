import {MovableDialog} from "../ui/MovableDialog.jsx";
import {useEffect,useMemo,useRef,useState} from "react";
import {backend} from "../backend/index.js";
import {fileToText} from "../document-reader.js";
import {parseStructuredDocument} from "../core/document-structuring.js";
import {findDate,findInvoiceNumber,parseDocument} from "../ingestion.js";
import {findUncodedVendorListing,vendorListingLabel} from "../core/vendor-listing.js";
import {bestInvoiceMatch,compareProductIdentity,comparePurchasingPack,MATCH_POLICY,parsePackSize,priceBasisFor,quotePriceOnBasis,brandsMatch} from "../procurement.js";
import {createCatalogService} from "../services/catalog.js";
import {createCategoryService} from "../services/categories.js";
import {createDocumentService} from "../services/documents.js";
import {createImportService} from "../services/imports.js";
import {createOrganizationService} from "../services/organization.js";
import {rememberedLayout,withRememberedLayout,COLUMN_ROLE_LABELS,COLUMN_ROLES_FOR_CHOICE} from "../core/sheet-layout.js";
import {formatMoney} from "../localization.js";
import {explainImportRow} from "../core/import-evidence.js";
import {importResolutions,unitChoices} from "../core/catalog-fields.js";
import {importPriceRow} from "../core/import-price-row.js";
import {verifyResumeRows} from "../core/import-resume.js";
import {checkInboxGroupGuard} from "../core/inbox-group-guard.js";
import {priceDocumentStatus} from "../core/import-status.js";
import {enrichFromInvoices,invoiceEvidence} from "../core/invoice-evidence.js";
import {billingUnitEvidence} from "../core/billing-unit-evidence.js";
import {btn,inp} from "../ui/styles.js";
import {Drachma} from "../ui/Drachma.jsx";

const catalogService=createCatalogService(backend);
const categoryService=createCategoryService(backend);
const documents=createDocumentService(backend);
const importService=createImportService(backend);
const r2=value=>Math.round(value*100)/100;

// A1.7.a: inboxImportDocumentId is the import_documents.id that the background
// worker linked via set_attachment_processing_status when it produced a partial
// (needs_review) result.  When supplied, the save loop looks up the existing
// document by ID + ownership instead of re-fingerprinting — ensuring the user's
// PasteModal session resumes the SAME partial document the worker created rather
// than creating a duplicate under the content fingerprint.
export function PasteModal({industry="",vendors,orgId,orgSettings,catalogItems,categories,vocabulary=[],vendorItems=[],mappings=[],onClose,onDone,onFinished,onBeforeSave,initialVendorId,initialMode,initialFiles,inboxImportDocumentId=null}) {
  const inboxReview=typeof onBeforeSave==="function";
  // The vendor is a choice, never a default: the box opens on "Select
  // vendor" unless you arrived from a specific vendor's page. Nothing can
  // be dropped in until a vendor is chosen, so a sheet can't land under
  // the wrong name.
  const [vendorId,setVendorId]=useState(()=>initialVendorId&&vendors.some(v=>v.id===initialVendorId)?initialVendorId:"");
  // What this import is. Starts from where the person clicked, but a
  // price sheet dropped into Import Invoice is read as a price sheet: no
  // invoice number, no invoice date and a long list of priced items is a
  // price sheet, whatever button opened the window.
  const [mode,setMode]=useState(initialMode||"pricelist");
  const [switchedToPriceSheet,setSwitchedToPriceSheet]=useState(false);
  function looksLikePriceSheet(group){
    return group.documentKind!=="invoice"&&!findInvoiceNumber(group.text)&&!findDate(group.text)&&(group.rows?.length||0)>=8;
  }
  const [pastedText,setPastedText]=useState("");
  const [fileGroups,setFileGroups]=useState([]); // [{id,file,name,text}] — one entry per dragged/selected file
  const [parsedGroups,setParsedGroups]=useState([]); // after Parse: fileGroups (+pasted text) each with rows/skipped attached
  const [step,setStep]=useState(1);
  const [loading,setLoading]=useState(false);
  const saveInFlight=useRef(false);
  const [result,setResult]=useState(null);
  const [dragOver,setDragOver]=useState(false);
  const [fileBusy,setFileBusy]=useState(false);
  const [parsing,setParsing]=useState(false);
  const [parseError,setParseError]=useState("");
  const [acceptedIssues,setAcceptedIssues]=useState(new Set());
  const [saveReview,setSaveReview]=useState("");
  const [autoSaveStarted,setAutoSaveStarted]=useState(false);
  const [sortField,setSortField]=useState("itemNumber");
  const [sortDirection,setSortDirection]=useState(1);
  const [detailKey,setDetailKey]=useState(null);
  const [invoiceSources,setInvoiceSources]=useState([]);
  const [invoiceLoad,setInvoiceLoad]=useState("loading");
  const [acceptedInvoiceConflicts,setAcceptedInvoiceConflicts]=useState(new Set());
  // Step 1.5 — unknown column header confirmation.
  // Each entry: { groupId, fingerprint, unknownHeaders: [{index,label,engineGuess}], confirmedAnswers: {index:role} }
  const [pendingUnknowns,setPendingUnknowns]=useState([]);
  // Staged groups waiting for unknown-column confirmation before advancing to step 2.
  const [stagedGroups,setStagedGroups]=useState([]);
  const quotedUnits=unitChoices(vocabulary,false,industry);
  const initialFileParsed=useRef(false);
  useEffect(()=>{
    if(!initialFiles?.length||!vendorId||fileGroups.length!==initialFiles.length||initialFileParsed.current)return;
    initialFileParsed.current=true;
    void parseSources(fileGroups,"");
  },[vendorId,fileGroups,initialFiles]);

  // When opened from the email inbox, pre-load the supplied File objects so
  // the user lands on the file-ready state rather than an empty drop zone.
  // Vendor selection is still required before parsing can proceed.
  useEffect(()=>{
    if(!initialFiles||!initialFiles.length) return;
    let active=true;
    (async()=>{
      const newGroups=await Promise.all(initialFiles.map(async file=>{
        let reading;
        const text=await fileToText(file,{onRead:result=>{reading=result;}});
        return {reading,id:`${file.name}_${file.size}_${Date.now()}_${Math.random()}`,file,name:file.name,text};
      }));
      if(active) setFileGroups(newGroups);
    })().catch(err=>setParseError(`Could not read attached file: ${err.message||String(err)}`));
    return ()=>{active=false;};
  },[]);// initialFiles is intentionally read only on mount

  useEffect(()=>{
    if(mode!=="pricelist"||!vendorId)return;
    let active=true;
    setInvoiceLoad("loading");setInvoiceSources([]);setAcceptedInvoiceConflicts(new Set());
    importService.invoiceSources(orgId,vendorId).then(invoices=>{
      if(!active)return;
      setInvoiceSources(invoices.flatMap(invoice=>parseDocument(invoice.raw_text||"").rows.map(row=>({
        row,id:invoice.id,number:invoice.invoice_number,date:invoice.invoice_date,
        organizationId:orgId,vendorId,
      }))));
      setInvoiceLoad("ready");
    }).catch(error=>{if(active)setInvoiceLoad(error.message||"Invoice lookup failed");});
    return ()=>{active=false;};
  },[mode,orgId,vendorId]);
  const invoiceClues=useMemo(()=>new Map(parsedGroups.flatMap(group=>group.rows.map((row,index)=>
    [`${group.id}:${index}`,invoiceEvidence(row,invoiceSources)]))),[parsedGroups,invoiceSources]);
  const invoiceConflicts=parsedGroups.flatMap(group=>group.rows.map((row,index)=>`${group.id}:${index}`))
    .filter(key=>invoiceClues.get(key)?.conflicts.length&&!acceptedInvoiceConflicts.has(key));

  async function handleDroppedFiles(files){
    const fileArr=Array.from(files||[]);
    if(!fileArr.length||fileBusy||parsing) return;
    setFileBusy(true);
    const shownAt=Date.now();
    try{
      const newGroups=await Promise.all(fileArr.map(async file=>{
        let reading;
        const text=await fileToText(file,{onRead:result=>{reading=result;}});
        return {reading,id:`${file.name}_${file.size}_${Date.now()}_${Math.random()}`,file,name:file.name,text};
      }));
      const combined=[...fileGroups,...newGroups];
      setFileGroups(combined);
      await parseSources(combined,pastedText);
    }catch(err){
      setParseError(`Could not read the file: ${err.message||String(err)}`);
    }
    // The coin stays up for at least a moment even on a tiny file, so the
    // person sees KERDOS working rather than a flicker.
    const remaining=900-(Date.now()-shownAt);
    if(remaining>0)await new Promise(resolve=>setTimeout(resolve,remaining));
    setFileBusy(false);
  }

  function removeFileGroup(id){
    setFileGroups(prev=>prev.filter(g=>g.id!==id));
  }

  // What this sheet's prices are for, when the sheet doesn't say. "As
  // stated" assumes nothing; choosing Case/Each/a unit applies to every
  // row that has no selling unit of its own. One choice replaces one
  // click per row.
  const [sheetBasis,setSheetBasis]=useState("");
  const knownBrands=useMemo(()=>[...new Set(vendorItems.map(vi=>String(vi.brand||"").trim()).filter(Boolean))],[vendorItems]);
  function settleRow(row){
    let next=row;
    // The person said what this sheet's prices are per. That covers a row
    // with no unit and a row whose unit KERDOS can't read ("P"); the
    // vendor's original token is kept as a detail.
    if(sheetBasis&&mode==="pricelist"&&(!next.sellingUnit||!priceBasisFor(next.sellingUnit))){
      const original=next.sellingUnit;
      next={...next,sellingUnit:sheetBasis,sellingUnitSource:"sheet",...(original?{details:[...(next.details||[]),`unit as printed: ${original}`]}:{})};
    }
    // An unlabeled cell that matches a brand this organization already
    // knows is that brand; the engine fills it and says where it came from.
    if(!next.brand&&next.details?.length&&knownBrands.length){
      const found=next.details.find(detail=>knownBrands.some(known=>brandsMatch(known,detail)));
      if(found)next={...next,brand:found,brandSource:"details"};
    }
    return next;
  }
  // "Import another" returns to the file picker with the same vendor and
  // sheet setting, ready for the next file.
  function startAnother(){
    setFileGroups([]);setParsedGroups([]);setPastedText("");setResult(null);setSaveReview("");setParseError("");
    setAcceptedIssues(new Set());setAcceptedInvoiceConflicts(new Set());setAutoSaveStarted(false);setStep(1);
  }
  // Header answers for this vendor's layouts: remembered ones from the
  // organization's settings, plus any given during this import.
  const organizationService=useMemo(()=>createOrganizationService(backend),[]);
  const [layoutAnswers,setLayoutAnswers]=useState({});   // fingerprint -> {columnIndex: role}
  function answersFor(fingerprint){
    return {...rememberedLayout(orgSettings,vendorId,fingerprint),...(layoutAnswers[fingerprint]||{})};
  }
  function parseWithLayout(text,reading,overrides={}){
    const parse=(part,options={})=>{
      const first=parseDocument(part,options);
      const fingerprint=first.layout?.fingerprint||"";
      const answers=fingerprint?{...answersFor(fingerprint),...(overrides[fingerprint]||{})}:{};
      return Object.keys(answers).length?parseDocument(part,{...options,layoutAnswers:answers}):first;
    };
    // The inbox's retained partial rows keep the worker's existing ordinal
    // contract. B3 changes the separate manual-upload path only.
    return parseStructuredDocument(text,inboxReview?null:reading,parse);
  }
  const layoutsFor=group=>group.parts?.length?group.parts:[group];
  // Unknown column headers: collect any that the engine couldn't map by
  // name, surface them to the client once, and remember only the
  // confirmed answer for this vendor's layout fingerprint. The engine's
  // data-profile guess is the default choice — the client confirms,
  // corrects, or marks it ignored. Silently skips fingerprints for which
  // remembered answers already cover every unknown.
  function gatherUnknownsForConfirmation(groups){
    const toAsk=[];
    for(const g of groups)for(const part of layoutsFor(g)){
      const fp=part.layout?.fingerprint;
      const unknown=(part.layout?.unknown||[]).filter(h=>h.label);
      if(!fp||!unknown.length||toAsk.some(entry=>entry.fingerprint===fp))continue;
      const remembered=rememberedLayout(orgSettings,vendorId,fp);
      // If every unknown already has a remembered answer, no need to ask.
      const needsAnswer=unknown.filter(h=>remembered[String(h.index)]===undefined&&remembered[h.index]===undefined);
      if(!needsAnswer.length)continue;
      const unknownHeaders=needsAnswer.map(h=>{
        const engineGuess=Object.entries(part.columnMap||{}).find(([,i])=>i===h.index)?.[0]||"ignore";
        return {index:h.index,label:h.label,engineGuess};
      });
      toAsk.push({groupId:g.id,fingerprint:fp,unknownHeaders,confirmedAnswers:Object.fromEntries(unknownHeaders.map(h=>[h.index,h.engineGuess]))});
    }
    return toAsk;
  }

  // Apply confirmed answers (from the client or auto-remembered) to a set
  // of parsed groups. Returns settled groups. Persists to orgSettings.
  async function applyConfirmedAnswers(groups,confirmedByFingerprint){
    let settled=groups;
    const toRemember=[];
    for(const [fp,answers] of Object.entries(confirmedByFingerprint)){
      toRemember.push([fp,answers]);
      setLayoutAnswers(prev=>({...prev,[fp]:answers}));
      settled=settled.map(x=>{
        if(!layoutsFor(x).some(part=>part.layout?.fingerprint===fp))return x;
        const parsed=parseWithLayout(x.text,x.reading,confirmedByFingerprint);
        return {...x,rows:parsed.rows.map(settleRow),skipped:parsed.skipped,layout:parsed.layout,columnMap:parsed.columnMap,parts:parsed.parts,structure:parsed.structure};
      });
    }
    if(toRemember.length){
      let next=orgSettings;
      for(const [fp,answers] of toRemember)next=withRememberedLayout(next,vendorId,fp,answers);
      try{await organizationService.update(orgId,{settings:next});}catch{/* remembering is a convenience */}
    }
    return settled;
  }

  // Entry point called after initial parse. If any document has unknown
  // headers that haven't been confirmed before, pause at step 1.5 to ask.
  // Otherwise apply any auto-remembered answers and advance to step 2.
  async function settleUnknownHeaders(groups){
    const toAsk=gatherUnknownsForConfirmation(groups);
    if(toAsk.length){
      setStagedGroups(groups);
      setPendingUnknowns(toAsk);
      setStep(1.5);
      return;
    }
    // Nothing to ask — apply remembered answers for any known fingerprints
    // and go straight to the review step.
    const autoAnswers={};
    for(const g of groups)for(const part of layoutsFor(g)){
      const fp=part.layout?.fingerprint;
      if(!fp)continue;
      const remembered=rememberedLayout(orgSettings,vendorId,fp);
      if(Object.keys(remembered).length)autoAnswers[fp]=remembered;
    }
    const settled=Object.keys(autoAnswers).length?await applyConfirmedAnswers(groups,autoAnswers):groups;
    if(mode==="invoice"&&settled.every(looksLikePriceSheet)){setMode("pricelist");setSwitchedToPriceSheet(true);}
    setParsedGroups(settled);
    setStep(inboxReview?2:1.8);
  }

  // Called when the client clicks "Continue" from the step 1.5 panel.
  async function confirmUnknownHeaders(){
    const confirmedByFingerprint={};
    for(const pending of pendingUnknowns){
      confirmedByFingerprint[pending.fingerprint]={
        ...rememberedLayout(orgSettings,vendorId,pending.fingerprint),
        ...pending.confirmedAnswers,
      };
    }
    const settled=await applyConfirmedAnswers(stagedGroups,confirmedByFingerprint);
    setStagedGroups([]);setPendingUnknowns([]);
    if(mode==="invoice"&&settled.every(looksLikePriceSheet)){setMode("pricelist");setSwitchedToPriceSheet(true);}
    setParsedGroups(settled);
    setStep(inboxReview?2:1.8);
  }
  async function parseSources(files,text){
    // Every dropped/selected file is parsed on its own — never merged into
    // one blob of raw text — since two different vendor documents can use
    // completely different table structures. A pasted blob (if any) is
    // treated as one more independent document, the same way.
    setParseError("");setParsing(true);
    // Yield once so the progress message renders before a large document is read.
    await new Promise(resolve=>setTimeout(resolve,0));
    try{
      const docs=[...files];
      if(text.trim().length>0){
        docs.push({id:"pasted",file:null,name:"Pasted text",text});
      }
      const groups=[];
      for(const d of docs){
        try{
          const parsed=parseWithLayout(d.text,d.reading);
          groups.push({...d,rows:parsed.rows.map(settleRow),skipped:parsed.skipped,documentKind:parsed.documentKind,quoteValidUntil:parsed.quoteValidUntil,invoiceDate:findDate(d.text)||"",layout:parsed.layout,columnMap:parsed.columnMap,parts:parsed.parts,structure:parsed.structure});
        }catch(error){throw new Error(`${d.name}: ${error.message||String(error)}`);}
        await new Promise(resolve=>setTimeout(resolve,0));
      }
      if(!groups.some(group=>group.rows.length)){
        setParseError(`No product rows could be read from ${docs.map(d=>d.name).join(", ")}. Check that the file contains item lines, or paste a sample of its text for review.`);
        return;
      }
      // settleUnknownHeaders handles all step transitions: it either pauses at
      // step 1.5 to ask about unknown columns, or advances directly to step 2.
      await settleUnknownHeaders(groups);
    }catch(error){setParseError(`Could not parse the document: ${error.message||String(error)}`);}
    finally{setParsing(false);}
  }

  function doParse(){void parseSources(fileGroups,pastedText);}

  const allRows=parsedGroups.flatMap(g=>g.rows.map(row=>({...row,_source:g.name})));
  const evidenceRows=parsedGroups.flatMap(g=>g.rows.map((row,index)=>({row,group:g,index,key:`${g.id}:${index}`,
    evidence:explainImportRow(row,{vendor:vendors.find(v=>v.id===vendorId),categories,catalogItems,vendorItems,mappings,documentRows:g.rows,invoices:invoiceSources})})))
    .sort((a,b)=>{
      const av=a.evidence[sortField]?.value,bv=b.evidence[sortField]?.value;
      if(av==null&&bv==null)return a.index-b.index;
      if(av==null)return 1;if(bv==null)return -1;
      return sortDirection*(typeof av==="number"&&typeof bv==="number"?av-bv:String(av).localeCompare(String(bv),undefined,{numeric:true}));
    });
  const allSkipped=parsedGroups.flatMap(g=>g.skipped.map(s=>({...s,_source:g.name})));
  const allIncomplete=allRows.filter(r=>r.priceUnavailable);
  const showSourceTags=parsedGroups.length>1;
  const unsafeDocuments=parsedGroups.filter(g=>g.documentKind==="mixed"||(g.documentKind!=="unknown"&&g.documentKind!==mode));
  const missingInvoiceDates=mode==="invoice"?parsedGroups.filter(g=>g.rows.length&&!/^\d{4}-\d{2}-\d{2}$/.test(g.invoiceDate||"")):[];
  const needsReview=parsedGroups.flatMap(g=>g.rows.map((row,index)=>({groupId:g.id,index,row})))
    .filter(x=>x.row.issues?.length&&!acceptedIssues.has(`${x.groupId}:${x.index}`));
  function updateParsedRow(groupId,index,patch){
    // Editing an ambiguous row invalidates a prior approval of its old value.
    setAcceptedIssues(prev=>{const next=new Set(prev);next.delete(`${groupId}:${index}`);return next;});
    setAcceptedInvoiceConflicts(prev=>{const next=new Set(prev);next.delete(`${groupId}:${index}`);return next;});
    setParsedGroups(groups=>groups.map(g=>g.id!==groupId?g:{...g,rows:g.rows.map((r,i)=>i===index?{...r,...patch,originalFields:r.originalFields||{description:r.description,brand:r.brand,packSize:r.packSize,sellingUnit:r.sellingUnit,price:r.price},manualFields:[...new Set([...(r.manualFields||[]),...Object.keys(patch)])]}:r)}));
  }
  function approveIssue(groupId,index){setAcceptedIssues(prev=>new Set([...prev,`${groupId}:${index}`]));}

  async function doSave(){
    // Reservation is asynchronous. Block a second click immediately, before
    // React's loading state or the first reservation response can arrive.
    if(saveInFlight.current)return;
    saveInFlight.current=true;
    try { await saveImport(); }
    catch(error){
      setSaveReview(`Import stopped: ${error.message||String(error)}. Items already saved remain in your catalog; check the import history before retrying.`);
      setLoading(false);
    }
    finally{saveInFlight.current=false;}
  }

  async function saveImport(){
    if(mode==="pricelist"&&invoiceLoad==="loading"){setSaveReview("Checking existing invoices. Try again in a moment.");return;}
    if(missingInvoiceDates.length){setSaveReview("Confirm the invoice date for each document before recording invoice charges.");return;}
    if(unsafeDocuments.length){setSaveReview("This file identifies itself as an invoice and/or a price update inconsistent with the selected import mode. Split mixed documents, or select the correct mode before saving.");return;}
    if(mode==="invoice"&&needsReview.length){setSaveReview(`${needsReview.length} ambiguous row(s) still need a deliberate correction or approval. No unreviewed amount will change a current vendor quote.`);return;}
    // Inbox preview does not reserve the attachment. The same row lock used by
    // the worker is acquired here, immediately before any save-side effects.
    // A closed preview therefore leaves pending work available to the worker.
    if(onBeforeSave){
      const allowed=await onBeforeSave();
      if(!allowed)throw new Error("Automatic processing claimed this attachment. Refresh the inbox before importing.");
    }
    setSaveReview("");setLoading(true);
    const vendor=vendors.find(v=>v.id===vendorId);
    let updated=0,created=0,invoiceTotal=0,invoicesCreated=0,mapped=0,packsFilled=0,basisReview=0,invoiceLinks=0;
    const identified=[];
    let saveError=null;
    let lastSourceDocumentId=null;
    const inboxReview=typeof onBeforeSave==="function";

    if(mode==="pricelist"){
      const workingCatalogItems=[...catalogItems];
      const workingCategories=[...categories];
      const workingVendorItems=[...vendorItems];
      const currentVendorItems=await importService.vendorItems(orgId,vendorId);
      const currentVendorByCode=new Map(currentVendorItems.filter(vi=>vi.vendor_item_code).map(vi=>[vi.vendor_item_code,vi]));
      const workingMappings=[...mappings];
      const importBatchTime=new Date().toISOString();
      async function applySelectedCategory(catalogItemId,categoryId){
        if(!categoryId)return;
        const current=workingCatalogItems.find(ci=>ci.id===catalogItemId);
        if(!current||current.category_id===categoryId)return;
        const number=await categoryService.assignItem({catalogItemId:current.id,categoryId,catalogItems:workingCatalogItems,categories:workingCategories});
        const index=workingCatalogItems.indexOf(current);
        workingCatalogItems[index]={...current,category_id:categoryId,master_item_number:number};
      }

      // A1.7: inbox resume must target exactly one group.
      // Guard is in src/core/inbox-group-guard.js (pure, importable by tests).
      {
        const guard=checkInboxGroupGuard(inboxImportDocumentId,parsedGroups);
        if(guard.blocked){
          setSaveReview(guard.message);
          setLoading(false);
          return;
        }
      }
      let failedRows=0;
      for(const group of parsedGroups){
        if(!group.rows.length)continue;
        let sourceFilePath=null;
        // Stable SHA-256 of the original extracted text: re-importing the
        // same vendor quotation cannot silently append duplicate history.
        const digest=await crypto.subtle.digest("SHA-256",new TextEncoder().encode(group.text));
        const fingerprint=Array.from(new Uint8Array(digest)).map(n=>n.toString(16).padStart(2,"0")).join("");
        let existingDoc;
        // A1.7.a: when the inbox passes a linked partial-document ID, look it up
        // directly (validates org+vendor ownership) instead of re-fingerprinting.
        // This ensures the user's review session resumes the exact document the
        // background worker created rather than creating a duplicate.
        // If the linked document cannot be verified, fail immediately — do NOT fall
        // back to fingerprint.  A fallback could select or create a different document
        // while the attachment remains linked to the original, producing split history.
        if(inboxImportDocumentId){
          try{existingDoc=await importService.findPriceDocumentById({organizationId:orgId,vendorId,documentId:inboxImportDocumentId});}
          catch(err){failedRows+=group.rows.length;saveError=(saveError?saveError+" ":"")+`${group.name}: ${err.message}`;continue;}
          if(!existingDoc){
            // Document not found or belongs to a different org/vendor — fail safely.
            failedRows+=group.rows.length;
            saveError=(saveError?saveError+" ":"")+`${group.name}: linked import document could not be verified — it may have been deleted or re-assigned to a different vendor.`;
            continue;
          }
        } else {
          try{existingDoc=await importService.findPriceDocument({organizationId:orgId,vendorId,fingerprint});}
          catch(err){failedRows+=group.rows.length;saveError=(saveError?saveError+" ":"")+`${group.name}: ${err.message}`;continue;}
        }
        // A file that finished is not re-run (use Delete & re-import). A
        // file that stopped part-way resumes: rows already recorded as
        // complete are skipped, the rest are saved, and every write below
        // is safe to repeat.
        if(existingDoc&&existingDoc.status==="complete"){saveError=(saveError?saveError+" ":"")+`${group.name}: already imported in full. Use Delete & re-import in Price Sheets to load it again.`;continue;}
        const completedKeys=new Set(Array.isArray(existingDoc?.completed_keys)?existingDoc.completed_keys:[]);
        // A1.7.b: old partial documents (before the row:N fix) have non-standard keys
        // in completed_keys.  verifyResumeRows uses saved.key to index into the row array
        // (rows[N] from row:N) so old-format saved rows cause it to throw before the
        // completedKeys check is even reached.  Block resumption explicitly rather than
        // silently discarding the saved-row evidence — the user needs to know the
        // partial cannot be resumed safely, and they have a clear path (delete and
        // re-import).  On CONFLICT DO NOTHING would not protect against duplicates either
        // because old-format rows were stored under different source_row_key values.
        if(inboxImportDocumentId){
          const validRowKey=/^row:\d+$/;
          const badKeys=[...completedKeys].filter(k=>!validRowKey.test(k));
          if(badKeys.length>0){
            failedRows+=group.rows.length;
            // Explain the delete path precisely:
            // kerdos_delete_price_sheet deletes the import_documents row;
            // the FK on inbound_attachments.import_document_id is ON DELETE SET NULL,
            // so the attachment's link is cleared automatically.  The inbox then
            // shows "Review & Import" for a fresh import — no manual unlinking needed.
            saveError=(saveError?saveError+" ":"")+`${group.name}: this partial import was saved with an older format and cannot be resumed — the saved row evidence uses a different key scheme. Use "Delete & re-import" in Price Sheets; the attachment will reappear in the inbox ready for a fresh import.`;
            continue;
          }
        }
        if(existingDoc){
          try{verifyResumeRows(group.rows,[...completedKeys],await importService.resumeSources(orgId,vendorId,existingDoc.id));}
          catch(error){failedRows+=group.rows.length;saveError=(saveError?saveError+" ":"")+`${group.name}: ${error.message}`;continue;}
        }
        let sourceDocumentId=existingDoc?.id||null;
        lastSourceDocumentId=sourceDocumentId;
        if(!existingDoc){
          if(group.file){
            const uploaded=await documents.uploadOriginal(orgId,vendorId,group.file);
            if(uploaded.error){failedRows+=group.rows.length;saveError=(saveError?saveError+" ":"")+`Could not preserve the original ${group.name}: ${uploaded.error.message}. Prices from that file were not applied.`;continue;}
            sourceFilePath=uploaded.path;
          }
          let storedDoc;
          try{storedDoc=await importService.createPriceDocument({organization_id:orgId,vendor_id:vendorId,document_kind:"pricelist",fingerprint,original_text:group.text,file_name:group.name,file_path:sourceFilePath,status:"processing"});}
          catch(err){failedRows+=group.rows.length;saveError=(saveError?saveError+" ":"")+`${group.name}: ${err.message}`;continue;}
          sourceDocumentId=storedDoc.id;
        }
        // row:N uses the per-group ordinal (rowIndex from entries()).  For manual
        // imports each group has its own document, so per-group keys are unique
        // within that document and verifyResumeRows can safely index rows[N].
        // For inbox resume (inboxImportDocumentId set), the background worker
        // always produces exactly one group from one file, so per-group index
        // equals the global index — the keys align with what the background
        // worker stored without needing a separate global counter.
        const failuresBeforeGroup=failedRows;
      for(const [rowIndex,sourceRow] of group.rows.entries()){
        const completedKey=`row:${rowIndex}`;
        if(completedKeys.has(completedKey))continue;
        let row=enrichFromInvoices(sourceRow,invoiceSources);
        // A price sheet never waits on a person. A row with parser issues or
        // an invoice disagreement is saved with those notes attached, so
        // Item Catalog shows exactly what to finish; nothing is held back.
        const rowKey=`${group.id}:${rowIndex}`;
        // A cell that failed its column's test travels with the row as a
        // named reason (which cell, why), so Item Catalog shows it in place.
        // A cell that failed its column's test already shows in that cell's
        // accuracy; it is not a source conflict and does not hold the row.
        const rowIssues=[...(sourceRow.issues||[]),...(!acceptedInvoiceConflicts.has(rowKey)?(invoiceClues.get(rowKey)?.conflicts||[]):[])];
        const rowNeedsReview=!!rowIssues.length&&!acceptedIssues.has(rowKey);
        try{
        if(!rowNeedsReview&&!row.priceUnavailable&&(!Number.isFinite(Number(row.price))||Number(row.price)<=0)) throw new Error("No confirmed positive unit price");
        let ex=row.code?currentVendorByCode.get(row.code)||null:null;
        if(row.selectedVendorItemId){
          const selected=await importService.vendorItemById(orgId,vendorId,row.selectedVendorItemId);
          if(!selected||selected.vendor_item_code&&selected.vendor_item_code!==row.code)
            throw new Error("The selected NVIM belongs to a different vendor item code. Choose its actual listing.");
          const checked=findUncodedVendorListing(row,[selected]);
          if(checked.item!==selected)throw new Error("The selected NVIM does not agree on product, pack and brand. Correct the row before linking it.");
          if(ex&&ex.id!==selected.id)throw new Error("The vendor's printed code already belongs to another listing. Review both listings.");
          ex=selected;
        }
        if(!ex){
          const candidates=currentVendorItems;
          const found=findUncodedVendorListing(row,candidates);
          if(found.conflict)throw new Error(found.conflict);
          ex=found.item;
          if(ex&&row.code){
            const {error}=await backend.records.query("vendor_items").update({vendor_item_code:row.code})
              .eq("id",ex.id).eq("organization_id",orgId).eq("vendor_id",vendorId);
            if(error)throw new Error(`Could not attach the vendor's new printed code to ${ex.nvim_number?`NVIM-${ex.nvim_number}`:"the saved listing"}: ${error.message}`);
            ex={...ex,vendor_item_code:row.code};
          }
        }
        const priorMapping=ex?await importService.mapping(orgId,ex.id):null;
        const {vendorItemId,needsBasis,match,savedMapping}=await importPriceRow({
          backend,importService,catalogService,
          sourceRow,row,ex,priorMapping,rowIssues,rowNeedsReview,invoiceSources,
          orgId,vendorId,sourceDocumentId,completedKey,importBatchTime,group,sourceFilePath,
          workingCatalogItems,workingCategories,workingVendorItems,workingMappings,
          applySelectedCategory,
        });
        if(ex&&!needsBasis) updated++; else if(!ex) created++;
        if(needsBasis)basisReview++;
        if(match&&savedMapping){
          mapped++;
          identified.push({description:row.description,packSize:row.packSize||ex?.pack_size||null,price:row.price,track:match.track,confidence:match.score==null?null:Math.round(match.score*100),reason:match.reason||null});
        }
        // Inbox resolution must preserve the worker's saved-row contract.
        // Staging an unresolved quote is not completion of that source row.
        if(!inboxReview||!needsBasis){
          await importService.recordProgress(sourceDocumentId,[...completedKeys,completedKey]);
          completedKeys.add(completedKey);
        }
        const saved={...ex,id:vendorItemId,vendor_id:vendorId,organization_id:orgId,
          vendor_item_code:row.code||ex?.vendor_item_code||null,
          description:needsBasis&&ex?ex.description:row.description,
          brand:needsBasis&&ex?ex.brand:row.brand,pack_size:needsBasis&&ex?ex.pack_size:row.packSize,
          original_pack_raw:row.originalPackRaw||ex?.original_pack_raw||null,
          price:needsBasis&&ex?ex.price:row.price,field_resolutions:importResolutions(sourceRow,ex||{})};
        const savedIndex=currentVendorItems.findIndex(vi=>vi.id===vendorItemId);
        if(savedIndex<0)currentVendorItems.push(saved);else currentVendorItems[savedIndex]=saved;
        if(saved.vendor_item_code)currentVendorByCode.set(saved.vendor_item_code,saved);
        }catch(err){
          // Report the first failure verbatim and count the rest; a row
          // that failed is never counted as updated or created.
          failedRows++;
          if(!saveError) saveError=`"${row.description}" — ${err.message||String(err)}`;
        }
      }
        const finalStatus=priceDocumentStatus({failedRows,failuresBeforeGroup,completedKeys,rowCount:group.rows.length});
        try{await importService.finalizeDocument(sourceDocumentId,finalStatus,[...completedKeys]);}
        catch(err){saveError=(saveError?saveError+" ":"")+`${group.name}: ${err.message}`;}
      }
      if(failedRows>1) saveError+=` (${failedRows} rows failed in total; other rows may have different errors.)`;
    } else {
      // Invoice mode: each source document is its own invoice — a dropped
      // batch of 3 invoice PDFs must become 3 separate invoice records,
      // each with its own original file and its own line items, never
      // merged into one.
      //
      // Fetch this vendor's full item list ONCE, reused for both exact and
      // fuzzy matching across every line of every invoice in this batch —
      // avoids a database round-trip per line, and gives the fuzzy fallback
      // below a full candidate pool to compare against.
      const viList=await importService.vendorItems(orgId,vendorId);
      // Same working-copy pattern as price-sheet import, so an item that
      // genuinely matches nothing on file still ends up in the catalog
      // and orderable, instead of vanishing into a permanent "no match".
      const workingCatalogItems=[...catalogItems];
      const workingCategories=[...categories];
      const workingVendorItems=[...vendorItems];
      const workingMappings=[...mappings];

      for(const group of parsedGroups){
        if(!group.rows.length) continue;
        const invoiceIdentified=[];
        const groupTotal=group.rows.reduce((s,row)=>s+(row.amount!=null?row.amount:row.price),0);
        const invoiceNo=findInvoiceNumber(group.text);
        let duplicate;
        try{duplicate=await importService.duplicateInvoice({organizationId:orgId,vendorId,invoiceNumber:invoiceNo,rawText:group.text});}
        catch(err){saveError=(saveError?saveError+" ":"")+err.message;continue;}
        if(duplicate){saveError=(saveError?saveError+" ":"")+`Invoice ${invoiceNo||group.name} is already recorded; duplicate skipped.`;continue;}

        let filePath=null, fileName=null;
        if(group.file){
          const upload=await documents.uploadOriginal(orgId,vendorId,group.file);
          if(upload.error){
            saveError=(saveError?saveError+" ":"")+`"${group.name}": data was extracted, but the original file couldn't be saved: `+upload.error.message;
            // The retained source is part of the invoice audit record. Do not
            // create catalog entries or invoice charges without that original.
            continue;
          } else {
            filePath=upload.path;
            fileName=upload.name;
          }
        }

        const linesToInsert=[];
        for(const row of group.rows){
          // Price verification: look up what this item was actually quoted
          // at (its current vendor price) and compare to what was actually
          // paid on this invoice. A real mismatch here is exactly the kind
          // of thing worth catching — paying more than what was quoted.
          //
          // Matching order: exact item code, then exact description, then
          // — only when neither of those hits — a size-aware fuzzy
          // fallback against this vendor's item descriptions (see
          // bestInvoiceMatch above). That fallback matters most for
          // vendors with no item codes at all (their invoices and price
          // sheets are often separately-typed documents that word the
          // same product slightly differently), where exact matching
          // alone silently loses price verification.
          //
          // Every line gets a real confidence percentage and method
          // recorded — not just matched-or-not — so anything auto-matched
          // at less than full confidence, or not matched at all, can be
          // flagged and studied in Records rather than silently blending in.
          let matched=null, confidence=null, method=null,codeConflict=false,pendingCatalog=null;
          if(row.code){
            const byCode=viList.filter(vi=>vi.vendor_item_code===row.code);
            if(byCode.length>1){codeConflict=true;method="ambiguous_code";}
            matched=byCode.length===1?byCode[0]:null;
            const sameProduct=!!matched&&compareProductIdentity(row.description,matched.description).status==="same";
            // The vendor's own invoice, under the vendor's own item code,
            // states the pack that its price sheet left out. Filling it
            // here records the pack only; it never confirms a mapping.
            if(sameProduct&&!matched.pack_size&&row.packSize&&parsePackSize(row.packSize)?.parsed){
              const {error:packError}=await backend.records.query("vendor_items").update({pack_size:row.packSize}).eq("id",matched.id).eq("organization_id",orgId);
              if(!packError){matched.pack_size=row.packSize;packsFilled++;}
            }
            if(sameProduct&&comparePurchasingPack(row.packSize,matched.pack_size).status==="same"){
              confidence=100; method="code";
            }else if(matched){matched=null;codeConflict=true;method="identity_conflict";}
          }
          if(!matched&&!codeConflict&&row.description){
            const byDescription=viList.filter(vi=>vi.description===row.description&&comparePurchasingPack(row.packSize,vi.pack_size).status==="same");
            if(byDescription.length>1){codeConflict=true;method="ambiguous_description";}
            matched=byDescription.length===1?byDescription[0]:null;
            if(matched&&comparePurchasingPack(row.packSize,matched.pack_size).status==="same"){ confidence=100; method="exact_description"; }
            else matched=null;
          }
          if(!matched&&!codeConflict&&row.description&&viList.length){
            const fuzzy=bestInvoiceMatch(row.description,viList.filter(vi=>comparePurchasingPack(row.packSize,vi.pack_size).status==="same"),MATCH_POLICY.autoLink);
            if(fuzzy){ matched=fuzzy.vendorItem; confidence=Math.round(fuzzy.score*100); method="fuzzy"; }
          }
          // Nothing matched at all - rather than leave this line
          // permanently unmatched (no price ever tracked, never appears
          // in the order guide), create a vendor item from the invoice
          // itself. Clearly flagged price_source:"invoice" so it's never
          // confused with a real price-sheet-quoted price - an actual
          // vendor quote always takes over the moment one comes in,
          // since a later price-sheet import matches on description the
          // same way it always has. Erring toward "create a new entry"
          // rather than force a shaky match is the safer failure mode:
          // a duplicate is visible and fixable, a wrong price match is
          // silently misleading.
          if(!matched&&!codeConflict&&row.description){
            try{
              pendingCatalog=await catalogService.matchOrCreate({organizationId:orgId,vendorId,description:row.description,packSize:row.packSize,catalogItems:workingCatalogItems,categories:workingCategories,vendorItems:workingVendorItems,mappings:workingMappings});
              method="created_from_invoice"; confidence=null;
              invoiceIdentified.push({description:row.description,packSize:row.packSize||null,price:row.price,track:pendingCatalog.track,confidence:pendingCatalog.score==null?null:Math.round(pendingCatalog.score*100),reason:pendingCatalog.reason||null,invoice:true});
            }catch(err){
              method="unmatched";
              saveError=(saveError?saveError+" ":"")+`"${row.description}": ${err.message||String(err)}`;
            }
          }
          // A vendor listing can already exist from an older import but have
          // no catalog link. An invoice must repair that gap too.
          if(matched&&!workingMappings.some(link=>link.vendor_item_id===matched.id)){
            try{
              pendingCatalog=await catalogService.matchOrCreate({organizationId:orgId,vendorId,description:matched.description,packSize:matched.pack_size||row.packSize,brand:matched.brand||null,gtin:matched.gtin||null,manufacturerCode:matched.manufacturer_code||null,catalogItems:workingCatalogItems,categories:workingCategories,vendorItems:workingVendorItems,mappings:workingMappings});
              invoiceIdentified.push({description:row.description,packSize:matched.pack_size||row.packSize||null,price:row.price,track:pendingCatalog.track,confidence:pendingCatalog.score==null?null:Math.round(pendingCatalog.score*100),reason:pendingCatalog.reason||null,invoice:true});
              workingMappings.push({vendor_item_id:matched.id,catalog_item_id:pendingCatalog.catalogItemId});
            }catch(error){saveError=(saveError?saveError+" ":"")+`"${row.description}": catalog link needs review (${error.message||String(error)}).`;}
          }
          if(codeConflict)saveError=(saveError?saveError+" ":"")+`Invoice line ${row.description}: ${method?.startsWith("ambiguous")?"multiple vendor products could match":"item code conflicts with the previously identified product"}; the original invoice line was recorded without a product link.`;
          let quotedPrice=null,quote=null;
          if(matched?.id&&method!=="created_from_invoice"){
            const invoiceDate=group.invoiceDate;
            try{quote=await importService.historicalQuote({organizationId:orgId,vendorItemId:matched.id,invoiceDate});}
            catch(err){saveError=(saveError?saveError+" ":"")+`${row.description}: ${err.message}`;}
            const withinVendorTerm=!quote?.quote_valid_until||quote.quote_valid_until>=invoiceDate;
            const refreshDays=Number(orgSettings?.price_refresh_days);
            const mode=orgSettings?.price_refresh_mode==="automatic"?"automatic":"manual";
            const withinClientWindow=mode!=="automatic"||!refreshDays||
              ((new Date(`${invoiceDate}T12:00:00Z`)-new Date(quote?.effective_date||0))/86400000)<=refreshDays;
            if(quote&&withinVendorTerm&&withinClientWindow&&["price_list","manual_edit"].includes(quote.source))quotedPrice=Number(quote.price);
          }
          // Compare the quote on the basis the invoice bills in. A quote
          // that cannot be expressed on that basis produces no variance
          // rather than a false overcharge or undercharge.
          let comparableQuote=null;
          const billedBasis=priceBasisFor(row.sellingUnit);
          if(quotedPrice!=null&&String(row.sellingUnit||"").trim()&&!billedBasis)
            saveError=(saveError?saveError+" ":"")+`${row.description}: invoice selling unit "${row.sellingUnit}" is unknown; no variance calculated.`;
          if(quotedPrice!=null&&(!String(row.sellingUnit||"").trim()||billedBasis)){
            comparableQuote=quotePriceOnBasis(
              {price:quotedPrice,basis:quote?.price_basis||null,unit:quote?.price_basis==="measure"?quote?.selling_unit:null,packSize:matched?.pack_size||row.packSize||null},
              billedBasis||{basis:"case"});
            if(comparableQuote==null)saveError=(saveError?saveError+" ":"")+`${row.description}: billed per ${row.sellingUnit||"unit"} but the quote could not be expressed that way; no variance recorded.`;
          }
          const variance=comparableQuote!=null?r2(row.price-comparableQuote):null;
          linesToInsert.push({
            vendor_item_id:matched?.id||null, vendor_item_code:row.code, description:row.description,
            quantity:row.qty??null,selling_unit:row.sellingUnit||null,
            source_line:row.sourceLine??null,billing_unit_evidence:billingUnitEvidence(row),
            unit_price:row.price, line_total:(row.amount!=null?row.amount:row.price),
            price_variance:variance, match_confidence:confidence, match_method:method,
            create_vendor_item:!matched&&!codeConflict&&method==="created_from_invoice",
            pack_size:row.packSize||null,catalog_item_id:pendingCatalog?.catalogItemId||null,
            catalog_confidence:pendingCatalog?Math.round((pendingCatalog.score??0)*100):null,
            catalog_track:pendingCatalog?.track||null,
          });
        }
        try{
          await backend.invoices.record({
            organization_id:orgId,vendor_id:vendorId,total_amount:r2(groupTotal),
            raw_text:group.text,invoice_date:group.invoiceDate,invoice_number:invoiceNo,
            file_path:filePath,file_name:fileName,
          },linesToInsert);
          invoiceLinks+=linesToInsert.filter(line=>line.catalog_item_id).length;
          invoicesCreated++;
          invoiceTotal+=groupTotal;
          identified.push(...invoiceIdentified);
        }catch(error){
          if(filePath){try{await documents.remove([filePath]);}catch{}}
          saveError=(saveError?saveError+" ":"")+`"${group.name}" couldn't be recorded: ${error.message||String(error)}`;
        }
      }
    }

    const summary={mode,vendor:vendor?.name,updated,created,mapped,basisReview,invoiceLinks,invoiceTotal:r2(invoiceTotal),invoicesCreated,count:allRows.length,error:saveError,identified,packsFilled};
    setResult(summary);
    // A clean finish closes the import on its own and hands a one-line
    // "Done" to the page behind it. The screen stays open only when
    // something needs to be read: an error, or invoice charges to check.
    if(!saveError&&mode==="pricelist"&&(!inboxReview||basisReview===0)){
      try{await onDone();}catch{/* the page refresh reports its own failure */}
      setLoading(false);
      onFinished?.({message:`Upload successful — ${allRows.length} row${allRows.length===1?"":"s"} from ${vendor?.name||"vendor"} saved${basisReview?`; ${basisReview} to finish in Item Catalog`:""}`,importDocumentId:lastSourceDocumentId||null});
      setStep(4);
      return;
    }
    try{await onDone();}
    catch(error){setResult(previous=>({...previous,error:[previous.error,`Saved, but the catalog could not refresh: ${error.message||String(error)}. Reload the app to see the saved items.`].filter(Boolean).join(" ")}));}
    setStep(3);setLoading(false);
  }

  // Start saving as soon as the parsed rows and invoice cross-reference are
  // ready. A person is needed only when the source contradicts prior evidence.
  useEffect(()=>{
    // The inbox path waits for an explicit Save so closing a preview cannot
    // reserve pending work or race with the automatic processor.
    if(onBeforeSave)return;
    if(step!==2||autoSaveStarted||loading||!allRows.length) return;
    if(unsafeDocuments.length) return;
    // Price sheets save automatically with issues attached to their rows.
    // Invoices still wait: an unreviewed charge must never alter a quote.
    if(mode==="invoice"&&(missingInvoiceDates.length||needsReview.length)) return;
    if(mode==="pricelist"&&invoiceLoad==="loading")return;
    setAutoSaveStarted(true);
    doSave();
  },[mode,step,autoSaveStarted,loading,allRows.length,unsafeDocuments.length,missingInvoiceDates.length,needsReview.length,invoiceLoad,invoiceConflicts.length]);

  return (
    <MovableDialog label="Import document" maxWidth={mode==="pricelist"&&step===2?1450:600} zIndex={1000}>
      <div style={{background:"white",borderRadius:"16px 16px 0 0",padding:20,width:"100%",maxWidth:mode==="pricelist"&&step===2?1450:600,maxHeight:"90vh",overflowY:"auto"}} aria-live="polite">
        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:16}}>
          <h3 style={{margin:0,fontSize:16}}>{inboxReview?"Review unresolved document rows":mode==="pricelist"?"📋 Import Price Sheet":"🧾 Record Invoice"}</h3>
          <button onClick={onClose} style={{background:"none",border:"none",fontSize:24,cursor:"pointer",color:"#888"}}>×</button>
        </div>

        {step===1&&<>
          <div style={{marginBottom:14}}>
            <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Vendor</div>
            <select style={{...inp,color:vendorId?undefined:"#888"}} value={vendorId} onChange={e=>setVendorId(e.target.value)}>
              <option value="">Select vendor…</option>
              {vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
            </select>
          </div>
          {mode==="pricelist"&&<div style={{marginBottom:14}}>
            <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Prices on this sheet are per</div>
            <select style={inp} value={sheetBasis} onChange={e=>setSheetBasis(e.target.value)}>
              <option value="">As stated on the sheet (rows without a unit are finished in Item Catalog)</option>
              <option value="CS">Case — the whole pack</option>
              <option value="EA">Each — one unit in the pack</option>
              <optgroup label="Unit of measure">
                {["LB","OZ","KG","GAL","QT","L"].map(u=><option key={u} value={u}>per {u}</option>)}
              </optgroup>
            </select>
          </div>}
          <div style={{marginBottom:14}}>
            <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Drag in one or more {mode==="pricelist"?"price list":"invoice"} files</div>
            <div
              onDragOver={e=>{e.preventDefault();setDragOver(true);}}
              onDragLeave={()=>setDragOver(false)}
              onDrop={e=>{e.preventDefault();setDragOver(false);handleDroppedFiles(e.dataTransfer.files);}}
              style={{position:"relative",border:dragOver?"2px dashed #003584":"2px dashed #DDD",borderRadius:8,padding:16,textAlign:"center",background:dragOver?"#F0F6FF":"#FAFAFA"}}
            >
              <div style={{fontSize:13,color:"#888",marginBottom:8}}>Drop files here to preview — no data is saved until you click Save Import</div>
              <input type="file" multiple accept=".csv,.txt,.tsv,.xlsx,.xls,.pdf,.eml,.html,.htm"
                onChange={e=>{handleDroppedFiles(e.target.files);e.target.value="";}}
                style={{fontSize:12}} />
              {(fileBusy||parsing)&&<div style={{position:"absolute",inset:0,background:"rgba(255,255,255,0.85)",display:"flex",alignItems:"center",justifyContent:"center",fontSize:13,color:"#003584",fontWeight:700,borderRadius:8}}><Drachma label={parsing?"Reading item rows…":"Reading file…"}/></div>}
            </div>
            {fileGroups.length>0&&(
              <div style={{marginTop:8}}>
                {fileGroups.map(g=>(
                  <div key={g.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",fontSize:12,color:"#555",padding:"6px 10px",background:"#F5F5F5",borderRadius:6,marginBottom:4}}>
                    <span>📎 {g.name} {mode==="invoice"?"— becomes its own invoice":""}</span>
                    <button onClick={()=>removeFileGroup(g.id)} style={{background:"none",border:"none",cursor:"pointer",color:"#E65100",fontSize:14,padding:0}}>✕</button>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div style={{marginBottom:14}}>
            <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Or paste text directly</div>
            <textarea
              style={{...inp,height:120,resize:"vertical",fontFamily:"monospace",fontSize:12}}
              value={pastedText} onChange={e=>setPastedText(e.target.value)}
              onPaste={e=>{const pasted=e.clipboardData.getData("text");if(pasted.trim().length>=10){e.preventDefault();setPastedText(pasted);void parseSources(fileGroups,pasted);}}}
              placeholder="Copy from Excel, email, PDF — paste here..." />
          </div>
          {parseError&&<div role="alert" style={{background:"#FFEBEE",color:"#B71C1C",padding:10,marginBottom:9,fontSize:12}}>{parseError}</div>}
          {pastedText.trim().length>=10&&<button onClick={doParse} disabled={fileBusy||parsing} style={{...btn("#003584"),width:"100%"}}>{parsing?"Reading item rows…":"Review pasted text"}</button>}
        </>}

        {step===1.5&&pendingUnknowns.length>0&&<>
          <div style={{marginBottom:12,fontSize:13,color:"#333"}}>
            <b>Check unrecognized column{pendingUnknowns.flatMap(p=>p.unknownHeaders).length>1?"s":""}</b>
            <p style={{margin:"6px 0 0",color:"#555",fontSize:12}}>
              The engine found column headings it did not recognize. Review the suggested role for each one,
              then click Continue. Your answer will be remembered for this vendor's layout.
            </p>
          </div>
          {pendingUnknowns.map((pending,pi)=>(
            <div key={pending.fingerprint} style={{marginBottom:14,padding:"10px 14px",background:"#F5F7FF",borderRadius:8,border:"1px solid #DDE2F0"}}>
              {pendingUnknowns.length>1&&<div style={{fontSize:11,fontWeight:700,color:"#555",marginBottom:8,textTransform:"uppercase",letterSpacing:"0.5px"}}>
                {stagedGroups.find(g=>g.id===pending.groupId)?.name||"Document"}
              </div>}
              {pending.unknownHeaders.map(h=>(
                <div key={h.index} style={{display:"flex",alignItems:"center",gap:10,marginBottom:8,flexWrap:"wrap"}}>
                  <span style={{fontFamily:"monospace",background:"#EBEBEB",padding:"2px 8px",borderRadius:4,fontSize:12,minWidth:120,flexShrink:0}}>
                    {h.label}
                  </span>
                  <span style={{fontSize:12,color:"#666",flexShrink:0}}>is the</span>
                  <select
                    value={pendingUnknowns[pi].confirmedAnswers[h.index]||"ignore"}
                    onChange={e=>{
                      const role=e.target.value;
                      setPendingUnknowns(prev=>prev.map((p,i)=>i!==pi?p:{
                        ...p,confirmedAnswers:{...p.confirmedAnswers,[h.index]:role}
                      }));
                    }}
                    style={{...inp,fontSize:12,padding:"4px 8px",minWidth:200}}
                  >
                    {COLUMN_ROLES_FOR_CHOICE.map(role=>(
                      <option key={role} value={role}>{COLUMN_ROLE_LABELS[role]||role}</option>
                    ))}
                  </select>
                  {h.engineGuess&&h.engineGuess!=="ignore"&&(
                    <span style={{fontSize:11,color:"#45735b"}}>
                      (engine guessed: {COLUMN_ROLE_LABELS[h.engineGuess]||h.engineGuess})
                    </span>
                  )}
                </div>
              ))}
            </div>
          ))}
          <div style={{display:"flex",gap:8,marginTop:4}}>
            <button onClick={()=>{setStagedGroups([]);setPendingUnknowns([]);setStep(1);}} style={{...btn("#EEE","#555"),flex:1}}>← Back</button>
            <button onClick={confirmUnknownHeaders} style={{...btn("#003584"),flex:2}}>Continue →</button>
          </div>
        </>}

        {step===1.8&&<>
          <div style={{background:"#E8F5E9",padding:"10px 14px",borderRadius:8,marginBottom:14,fontSize:13}}>
            <b>Preview — nothing has been saved yet</b>
          </div>
          {parsedGroups.map(g=>(
            <div key={g.id} style={{marginBottom:12,padding:"10px 14px",background:"#F5F7FF",borderRadius:8,border:"1px solid #DDE2F0"}}>
              <div style={{fontWeight:700,fontSize:13,marginBottom:6}}>📎 {g.name}</div>
              <div style={{fontSize:12,color:"#333",marginBottom:3}}>
                <b>{g.rows.length}</b> product row{g.rows.length===1?"":"s"} read
                {g.skipped.length>0&&<span style={{color:"#B26A00"}}> · {g.skipped.length} line{g.skipped.length===1?"":"s"} skipped (not recognized as product rows)</span>}
              </div>
              {Object.keys(g.columnMap||{}).length>0&&(
                <div style={{fontSize:11,color:"#555",marginTop:4}}>
                  Column roles detected: {Object.keys(g.columnMap).join(", ")}
                </div>
              )}
              {g.layout?.unknown?.filter(h=>h.label).length>0&&(
                <div style={{fontSize:11,color:"#B26A00",marginTop:4}}>
                  Unrecognized columns: {g.layout.unknown.filter(h=>h.label).map(h=>h.label).join(", ")}
                </div>
              )}
            </div>
          ))}
          {!vendorId&&(
            <div style={{marginBottom:14}}>
              <div style={{fontSize:12,fontWeight:600,color:"#666",marginBottom:4}}>Select a vendor to save this import</div>
              <select style={{...inp,color:"#888"}} value={vendorId} onChange={e=>setVendorId(e.target.value)}>
                <option value="">Select vendor…</option>
                {vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
              </select>
            </div>
          )}
          <div style={{display:"flex",gap:8,marginTop:4}}>
            <button onClick={()=>{setParsedGroups([]);setStagedGroups([]);setPendingUnknowns([]);setFileGroups([]);setParseError("");setStep(1);}} style={{...btn("#EEE","#555"),flex:1}}>Cancel</button>
            <button onClick={()=>setStep(2)} disabled={!vendorId} style={{...btn("#003584"),flex:2,opacity:vendorId?1:0.5}} title={vendorId?"":"Select a vendor above to enable saving"}>Save Import →</button>
          </div>
        </>}

        {step===2&&<>
          <div style={{background:"#E8F5E9",padding:"10px 14px",borderRadius:8,marginBottom:14,fontSize:13}}>
            {inboxReview?<>Reviewing {allRows.length} source rows for {vendors.find(v=>v.id===vendorId)?.name||"the receipt vendor"}. Previously saved progress is preserved. {loading?"Applying corrections…":"Resolve the outstanding fields, then apply corrections. Closing this review leaves unresolved rows available for later."}</>:<>Found {allRows.length} items across {parsedGroups.length} document{parsedGroups.length===1?"":"s"} — {loading?"saving automatically…":unsafeDocuments.length||(mode==="invoice"&&(missingInvoiceDates.length||needsReview.length||invoiceConflicts.length))?"resolve the highlighted issue to finish saving":mode==="pricelist"&&(needsReview.length||invoiceConflicts.length)?`saving automatically; ${needsReview.length+invoiceConflicts.length} row${needsReview.length+invoiceConflicts.length===1?"":"s"} will be marked to finish in Item Catalog`:"saving automatically…"}</>}
          </div>
          {mode==="invoice"&&parsedGroups.map(g=><label key={g.id} style={{display:"block",fontSize:12,marginBottom:7}}>
            Invoice date for {g.name}: <input type="date" value={g.invoiceDate||""} onChange={e=>setParsedGroups(groups=>groups.map(x=>x.id===g.id?{...x,invoiceDate:e.target.value}:x))} />
            {!g.invoiceDate&&<span style={{color:"#B26A00"}}> Required</span>}
          </label>)}
          {unsafeDocuments.length>0&&<div style={{background:"#FFEBEE",color:"#B71C1C",padding:10,marginBottom:10,fontSize:12}}>Document type mismatch or mixed invoice and price update: {unsafeDocuments.map(g=>g.name).join(", ")}. Separate the sections, or switch the import type. Nothing from these documents will be saved until resolved.</div>}
          {mode==="pricelist"&&<div style={{background:invoiceLoad==="ready"?"#E8F5E9":"#FFF3E0",padding:9,marginBottom:8,fontSize:12}}>{invoiceLoad==="ready"?`${invoiceSources.length} invoice line(s) available for cross-reference. Invoice amounts do not replace quoted prices.`:invoiceLoad==="loading"?"Checking this vendor's invoices before applying the price sheet…":`Invoice cross-reference unavailable: ${invoiceLoad}. Check invoice history before relying on this import.`}</div>}
          {mode==="pricelist"&&<div style={{overflowX:"auto",marginBottom:12}}>
            <table style={{borderCollapse:"collapse",width:"100%",minWidth:850,fontSize:11}}><thead><tr>
              {[["itemNumber","KERDOS item #"],["vendor","Vendor"],["category","Category"],["product","Product"],["brand","Brand"],["pack","Pack"],["price","Quoted price"],["sellingUnit","Quoted per"],["unitCost","Unit cost"]].map(([key,label])=><th key={key} style={{textAlign:"left",padding:6,borderBottom:"1px solid #ccd"}}><button onClick={()=>{setSortDirection(sortField===key?-sortDirection:1);setSortField(key);}} style={{background:"none",border:0,cursor:"pointer",fontWeight:700}}>{label} {sortField===key?(sortDirection===1?"↑":"↓"):""}</button></th>)}
              <th>Details</th></tr></thead><tbody>{evidenceRows.map(({evidence,key,row,group,index})=><tr key={key}>{["itemNumber","vendor","category","product","brand","pack","price","sellingUnit","unitCost"].map(name=>{
                const f=evidence[name];return <td key={name} title={f.reason} style={{padding:6,borderBottom:"1px solid #eee",whiteSpace:"nowrap"}}>{name==="vendor"?<>{f.value}{vendorItems.some(vi=>vi.vendor_id===vendorId&&!vi.vendor_item_code)&&<select aria-label={`Use saved vendor listing for ${row.description}`} value={row.selectedVendorItemId||""} onChange={e=>updateParsedRow(group.id,index,{selectedVendorItemId:e.target.value||null})} style={{...inp,fontSize:10,minWidth:160,padding:3,display:"block"}}><option value="">Match by product and pack</option>{vendorItems.filter(vi=>vi.vendor_id===vendorId&&!vi.vendor_item_code).map(vi=><option key={vi.id} value={vi.id}>{vendorListingLabel(vi)||"Unnumbered"} · {vi.description} · {vi.pack_size||"pack needed"}</option>)}</select>}</>:name==="category"?<select aria-label={`Category for ${row.description}`} value={row.categoryId||""} onChange={e=>updateParsedRow(group.id,index,{categoryId:e.target.value||null})} style={{...inp,fontSize:11,minWidth:115,padding:4}}><option value="">{f.value||"Uncategorized"}{f.accuracy!=null&&f.accuracy<90?" (suggested)":""}</option>{categories.filter(c=>!c.is_holding_pen).map(c=><option key={c.id} value={c.id}>{c.name}</option>)}</select>:name==="price"?<input aria-label={`Quoted price for ${row.description}`} type="number" min="0" step="any" value={row.priceUnavailable?"":row.price??""} onChange={e=>updateParsedRow(group.id,index,{price:e.target.value===""?null:Number(e.target.value),priceUnavailable:e.target.value==="",priceEdited:true})} style={{...inp,fontSize:11,width:86,padding:4}} />:name==="product"?<input aria-label={`Product for ${row.code||row.description}`} disabled={evidence.knownItem} value={evidence.knownItem?evidence.product.value:row.description||""} onChange={e=>updateParsedRow(group.id,index,{description:e.target.value})} style={{...inp,fontSize:11,width:210,padding:4}} />:name==="brand"?<input aria-label={`Brand for ${row.description}`} disabled={evidence.knownItem} value={row.brand||evidence.brand.value||""} placeholder="Blank if absent" onChange={e=>updateParsedRow(group.id,index,{brand:e.target.value})} style={{...inp,fontSize:11,width:110,padding:4}} />:name==="pack"?<input aria-label={`Pack for ${row.description}`} disabled={evidence.knownItem} value={row.packSize||evidence.pack.value||""} placeholder="e.g. 4/10 LB" onChange={e=>updateParsedRow(group.id,index,{packSize:e.target.value})} style={{...inp,fontSize:11,width:105,padding:4}} />:name==="sellingUnit"?<><select aria-label={`Quoted price per unit for ${row.description}`} disabled={evidence.knownItem&&!!f.value} value={f.value||""} onChange={e=>updateParsedRow(group.id,index,{sellingUnit:e.target.value,sellingUnitSource:"manual"})} style={{...inp,fontSize:11,width:105,padding:4}}><option value="">{f.value?`Likely ${f.value}`:"Select unit"}</option>{quotedUnits.map(unit=><option key={unit.value} value={unit.value}>{unit.label}</option>)}</select>{!evidence.knownItem&&!f.value&&evidence.unitSuggestion&&<button title={evidence.unitSuggestion.reason} onClick={()=>updateParsedRow(group.id,index,{sellingUnit:evidence.unitSuggestion.sellingUnit,sellingUnitSource:"manual"})} style={{border:0,background:"#FFF3E0",color:"#875200",fontSize:10,cursor:"pointer"}}>Confirm suggested {evidence.unitSuggestion?.sellingUnit}</button>}</>:f.value==null?name==="itemNumber"?"New number on save":"—":name==="price"||name==="unitCost"?formatMoney(f.value):f.value}{name==="unitCost"&&f.value!=null&&evidence.pack.value&&<small style={{display:"block"}}>per {evidence.unitCost.unit||"unit"}</small>}{f.accuracy!=null&&<small style={{display:"block",color:f.accuracy<90?"#a65b00":"#45735b"}}>{f.accuracy}%</small>}</td>;
              })}<td><button onClick={()=>setDetailKey(detailKey===key?null:key)}>Details{invoiceClues.get(key)?.conflicts.length?" ⚠":""}</button></td></tr>)}</tbody></table>
            {detailKey&&(()=>{const entry=evidenceRows.find(e=>e.key===detailKey);if(!entry)return null;const clues=invoiceClues.get(detailKey);return <div style={{background:"#f4f6fa",padding:12,marginTop:8,fontSize:12}}><b>{entry.evidence.knownItem?"Known vendor item — saved KERDOS link, updating price":"New or unfinished item — resolve fields"} · {entry.group.name}</b><div style={{marginTop:4}}>Source: {entry.evidence.source}</div>{entry.evidence.conflicts?.length>0&&<div style={{color:"#9B4400"}}>New quote held for review: {entry.evidence.conflicts.join(" ")}</div>}{clues?.matches.length>0&&<div style={{marginTop:7}}>Matched {clues.matches.length} prior invoice line(s) for this vendor.</div>}{Object.entries(clues?.suggestions||{}).map(([field,suggestion])=><div key={field} style={{marginTop:5}}>Invoice {suggestion.source} says {field}: <b>{suggestion.value}</b> <button onClick={()=>updateParsedRow(entry.group.id,entry.index,{[field]:suggestion.value,[`${field}Source`]:"invoice",invoiceSources:{...entry.row.invoiceSources,[field]:suggestion.source},originalFields:entry.row.originalFields||{description:entry.row.description,brand:entry.row.brand,packSize:entry.row.packSize,sellingUnit:entry.row.sellingUnit}})}>Use invoice value</button></div>)}{clues?.conflicts.map((conflict,index)=><div key={index} style={{color:"#9B4400",marginTop:5}}>{conflict}</div>)}{!!clues?.conflicts.length&&<button onClick={()=>setAcceptedInvoiceConflicts(prev=>new Set([...prev,detailKey]))} disabled={acceptedInvoiceConflicts.has(detailKey)} style={{marginTop:6}}>{acceptedInvoiceConflicts.has(detailKey)?"Invoice difference reviewed":"Keep sheet value after review"}</button>}{["itemNumber","vendor","category","product","brand","pack","price","priceBasis","unitCost"].map(name=><div key={name} style={{marginTop:5}}><b>{name}:</b> {entry.evidence[name].value??"blank"} · {entry.evidence[name].accuracy??"not stated"}% — {entry.evidence[name].reason}</div>)}<div style={{marginTop:7}}>Percentages are rule-based evidence levels, not measured error probabilities.</div></div>;})()}
          </div>}

          <div style={{maxHeight:340,overflowY:"auto",marginBottom:14}}>
            {parsedGroups.flatMap(g=>g.rows.map((row,i)=>mode==="pricelist"&&!row.issues?.length?null:(
              <div key={`${g.id}:${i}`} style={{display:"flex",justifyContent:"space-between",padding:"6px 0",borderBottom:"1px solid #F0F0F0",fontSize:13}}>
                <div>
                  {row.code&&<span style={{color:"#888",marginRight:8,fontFamily:"monospace",fontSize:11}}>{row.code}</span>}
                  <span>{row.description}</span>
                  {mode==="invoice"&&<input aria-label="Verify or correct product description" value={row.description} onChange={e=>updateParsedRow(g.id,i,{description:e.target.value})}
                    style={{...inp,fontSize:11,padding:"4px 6px",marginTop:5}} />}
                  {row.packSize&&<span style={{color:"#AAA",marginLeft:6,fontSize:11}}>{row.packSize}</span>}
                  {showSourceTags&&<span style={{color:"#BBB",marginLeft:6,fontSize:10}}>· {g.name}</span>}
                  {!!row.issues?.length&&<div style={{color:"#B26A00",fontSize:11,marginTop:3}}>
                    ⚠ {row.issues.join("; ")}
                    <button onClick={()=>approveIssue(g.id,i)} disabled={acceptedIssues.has(`${g.id}:${i}`)} style={{marginLeft:8,border:"none",background:"#FFF3E0",color:"#9A5700",cursor:"pointer",fontWeight:700}}>{acceptedIssues.has(`${g.id}:${i}`)?"Acknowledged":"Approve as entered"}</button>
                  </div>}

                </div>
                {row.priceUnavailable?(
                  <span style={{fontWeight:700,flexShrink:0,marginLeft:8,color:"#B26A00",fontSize:11}}>no price listed</span>
                ):(
                  <span style={{fontWeight:700,flexShrink:0,marginLeft:8}}>{formatMoney(row.price)}</span>
                )}
              </div>
            )))}
          </div>
          {allIncomplete.length>0&&(
            <div style={{background:"#FFF3E0",padding:"10px 14px",borderRadius:8,marginBottom:14,fontSize:12}}>
              <div style={{fontWeight:700,color:"#B26A00"}}>{allIncomplete.length} product{allIncomplete.length>1?"s":""} listed with no price — a confirmed quote is still needed</div>
              <div style={{color:"#996600",marginTop:2}}>The last-known amount remains in history, but an unavailable quote cannot be selected for ordering.</div>
            </div>
          )}
          {allSkipped.length>0&&(
            <div style={{background:"#FFF3E0",padding:"10px 14px",borderRadius:8,marginBottom:14,fontSize:12}}>
              <div style={{fontWeight:700,color:"#E65100",marginBottom:6}}>{allSkipped.length} line{allSkipped.length>1?"s":""} weren't interpreted as product lines — retained in the original source</div>
              <div style={{maxHeight:120,overflowY:"auto"}}>
                {allSkipped.map((s,i)=>(
                  <div key={i} style={{color:"#999",marginBottom:3,fontFamily:"monospace",fontSize:11}}>
                    "{s.line.slice(0,60)}" — {s.reason}{showSourceTags?` (${s._source})`:""}
                  </div>
                ))}
              </div>
            </div>
          )}
          {saveReview&&<div style={{color:"#B71C1C",fontSize:12,marginBottom:8}}>{saveReview}</div>}
          <div style={{display:"flex",gap:8}}>
            <button onClick={()=>inboxReview?onClose():setStep(1)} style={{...btn("#EEE","#555"),flex:1}}>{inboxReview?"Close review":"← Back"}</button>
            {(onBeforeSave||saveReview||unsafeDocuments.length||(mode==="invoice"&&(missingInvoiceDates.length||needsReview.length||invoiceConflicts.length)))?<button onClick={doSave} disabled={loading||!allRows.length||unsafeDocuments.length>0||(mode==="invoice"&&(needsReview.length>0||missingInvoiceDates.length>0||invoiceConflicts.length>0))||invoiceLoad==="loading"} style={{...btn("#003584"),flex:2}}>{inboxReview?"Apply corrections": "Continue after resolving issues"}</button>:<div style={{flex:2,display:"flex",justifyContent:"center",padding:4}}><Drachma label="Saving…"/></div>}
          </div>
        </>}

        {step===4&&result&&(
          <div style={{textAlign:"center",padding:"24px 0 8px"}}>
            <div style={{fontSize:40,marginBottom:10}}>✅</div>
            <h3 style={{margin:"0 0 6px"}}>Upload successful</h3>
            {switchedToPriceSheet&&<p style={{color:"#8D6E00",fontSize:12,margin:"0 0 6px"}}>This file was a price sheet, so KERDOS filed it under Price Sheets.</p>}
            <p style={{color:"#666",fontSize:14,margin:"0 0 18px"}}>
              {result.count} row{result.count===1?"":"s"} from {result.vendor} saved
              {result.basisReview>0?` · ${result.basisReview} to finish in Item Catalog`:""}
            </p>
            <div style={{display:"flex",gap:10,justifyContent:"center"}}>
              <button onClick={startAnother} style={{...btn("#E8F1FB","#003584",{padding:"10px 18px"})}}>Import another</button>
              <button onClick={onClose} style={{...btn("#003584","white",{padding:"10px 18px"})}}>Done</button>
            </div>
          </div>
        )}
        {step===3&&result&&(
          <div style={{textAlign:"center",padding:"20px 0"}}>
            <div style={{fontSize:40,marginBottom:12}}>{result.error?"⚠️":"✅"}</div>
            <h3 style={{margin:"0 0 8px"}}>{result.error?"Done with items needing attention":"Done"} · {result.vendor}</h3>
            {result.mode==="pricelist"
              ?<p style={{color:"#666",fontSize:14}}>{result.updated} items updated · {result.created} new items added · {result.mapped} linked to your catalog{result.identified?.length?` · ${result.identified.filter(item=>item.track==="exact"&&item.confidence===100).length} of ${result.identified.length} verified automatically`:""}</p>
              :<p style={{color:"#666",fontSize:14}}>{result.invoicesCreated} invoice{result.invoicesCreated===1?"":"s"} recorded · {result.count} line{result.count===1?"":"s"} · {result.invoiceLinks} catalog link{result.invoiceLinks===1?"":"s"} saved · {formatMoney(result.invoiceTotal)} total{result.packsFilled?` · ${result.packsFilled} missing pack size${result.packsFilled===1?"":"s"} filled from this invoice`:""}</p>}
            {result.identified?.length>0&&<div style={{textAlign:"left",background:"#F7F9FC",borderRadius:8,padding:12,maxHeight:230,overflowY:"auto"}}>
              <div style={{fontWeight:700,fontSize:13,marginBottom:7}}>{result.identified.length} vendor listing{result.identified.length===1?"":"s"} linked to your catalog</div>
              {result.identified.map((item,i)=><div key={i} style={{background:"white",border:"1px solid #E1E7F0",borderRadius:6,padding:8,marginBottom:5,fontSize:12}}>
                <b>{item.description}</b><div>Pack: {item.packSize||"Not provided"} · {formatMoney(item.price)}{item.invoice?" paid on invoice (historical)":" quoted"}</div>
                <div style={{color:item.track==="exact"&&item.confidence===100&&item.packSize?"#2E7D32":"#B26A00"}}>{item.track==="exact"&&item.confidence===100&&item.packSize?"Linked · verified 100%":"Linked · needs verification"}{item.track==="review"&&item.confidence!=null?` · ${item.confidence}% wording similarity`:""}{item.track==="review"&&item.reason?` · ${item.reason}`:""}</div>
              </div>)}
              {result.identified.some(item=>item.track!=="exact"||item.confidence!==100||!item.packSize)&&<div style={{fontSize:11,color:"#666"}}>Finish mapping these products in Item Catalog before their prices appear in the Order Guide.</div>}
            </div>}
            {result.error&&<div style={{background:"#FFF3E0",color:"#E65100",padding:"10px 12px",borderRadius:8,fontSize:13,marginTop:12,textAlign:"left"}}>{result.error}</div>}
            {result.basisReview>0&&<div style={{background:"#FFF3E0",color:"#875200",padding:"10px 12px",borderRadius:8,fontSize:13,marginTop:12,textAlign:"left"}}>{result.basisReview} incoming row{result.basisReview===1?"":"s"} saved for review in Item Catalog. Open the row details for the specific field that needs attention. Existing item links and saved quotations are retained; unresolved incoming quotes are not used for ordering.</div>}
            <button onClick={onClose} style={{...btn("#003584"),marginTop:16}}>Done</button>
          </div>
        )}
      </div>
    </MovableDialog>
  );
}

// ── MAIN APP ──────────────────────────────────────────────────────────
