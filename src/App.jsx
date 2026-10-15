import {alternativeGroups,automaticAlternativeVerified} from "./core/alternative-groups.js";
import {defaultComparisonUnit} from "./core/quote-controls.js";
import {AssociateAlternatives} from "./pages/AssociateAlternatives.jsx";
import { useState, useEffect, useMemo, useRef } from "react";
import { backend } from "./backend/index.js";
import { createSessionController } from "./session.js";
import { createDocumentService } from "./services/documents.js";
import { autoPlaceable,orderGuideAssessment,BLOCKER_LABELS } from "./core/catalog-fields.js";
import { holdingPen } from "./services/categories.js";
import { createOrganizationService } from "./services/organization.js";
import { createVendorService } from "./services/vendors.js";
import { createCatalogService } from "./services/catalog.js";
import { createOperationsService } from "./services/operations.js";
import { loadSnapshot, saveSnapshot } from "./offline-store.js";
import { configureProcurement, priceBasisFor, eachPrice, pricePerUnit, parsePackSize, brandsMatch, quoteStatus, comparePurchasingPack, compareProductIdentity, casePriceFromQuote } from "./procurement.js";
import { blockReason, orderable, priceForOffer, rankVendorOffers, offerDollarDifference, solveOrder } from "./core/ordering.js";
import { compareItems, itemMatchesSearch } from "./core/catalog-browse.js";
import { configureLocale, formatDate, formatMoney } from "./localization.js";
import { buildVarianceReportCSV, downloadTextFile } from "./reporting.js";
import {InvoicesPage,PriceSheetsPage} from "./pages/DocumentPages.jsx";
import {LandingGate,OrgGate} from "./pages/AccessPages.jsx";
import {InvoiceEditModal,AddVendorModal} from "./pages/RecordModals.jsx";
import {TeamPanel} from "./pages/TeamPanel.jsx";
import {CatalogPanel} from "./pages/CatalogAdminPanel.jsx";
import {ItemCatalogPanel} from "./pages/ItemCatalogPanel.jsx";
import {PasteModal} from "./pages/ImportModal.jsx";
import {VendorDetail} from "./pages/VendorDetail.jsx";
import {PALETTE,btn,chipStyle,inp} from "./ui/styles.js";

const documents=createDocumentService(backend);
const organizationService=createOrganizationService(backend);
const vendorService=createVendorService(backend);
const operationsService=createOperationsService(backend);
const catalogService=createCatalogService(backend);
const sessionController=createSessionController(backend.session);


async function viewSourceDocument(documentId){
  let data;
  try{data=await documents.source(documentId);}
  catch(error){alert(error.message);return;}
  if(data.file_path){await viewStoredFile(data.file_path);return;}
  const url=URL.createObjectURL(new Blob([data.original_text||""],{type:"text/plain;charset=utf-8"}));
  window.open(url,"_blank");
  setTimeout(()=>URL.revokeObjectURL(url),60000);
}

async function viewStoredFile(path) {
  try{window.open(await documents.signedUrl(path),"_blank");}
  catch(error){alert("Couldn't open file: "+error.message);}
}

// A business's own logo, so their home screen feels like theirs, not a
// generic KERDOS screen. Stored in the same private bucket as documents,
// under a dedicated "logo" folder per organization.
async function uploadOrgLogo(orgId, file) {
  return documents.uploadLogo(orgId,file);
}

async function getSignedUrl(path) {
  try{return await documents.signedUrl(path);}
  catch{return null;}
}

// ── UTILITIES ────────────────────────────────────────────────────────
function r2(n) { return Math.round(n * 100) / 100; }

// ── LANDING ───────────────────────────────────────────────────────────
export default function App() {
  const automaticGrouping=useRef(false);
  const [alternativeSelections,setAlternativeSelections]=useState(new Set());
  const [session,setSession]=useState(undefined);
  const [org,setOrg]=useState(null);
  const [organizations,setOrganizations]=useState([]);
  const [vendors,setVendors]=useState([]);
  const [catalogItems,setCatalogItems]=useState([]);
  const [categories,setCategories]=useState([]);
  const [vendorItems,setVendorItems]=useState([]);
  const [mappings,setMappings]=useState([]);
  const [invoices,setInvoices]=useState([]);
  const [purchaseOrders,setPurchaseOrders]=useState([]);
  const [priceHistory,setPriceHistory]=useState([]);
  const [importDocuments,setImportDocuments]=useState([]);
  const [importDocumentsHasMore,setImportDocumentsHasMore]=useState(false);
  const [loadingOlderDocuments,setLoadingOlderDocuments]=useState(false);
  const [priceHistoryHasMore,setPriceHistoryHasMore]=useState(false);
  const [loadingOlderPrices,setLoadingOlderPrices]=useState(false);
  const [vocabulary,setVocabulary]=useState([]);
  const [quantities,setQuantities]=useState({}); // {catalogItemId_case: n, catalogItemId_each: n}
  const [offline,setOffline]=useState(null);
  const [restoredBasketKey,setRestoredBasketKey]=useState(null);
  const [dragItem,setDragItem]=useState(null);
  const [dropTarget,setDropTarget]=useState(null);
  const [dropNotice,setDropNotice]=useState("");
  const [tab,setTab]=useState(()=>{
    try { return sessionStorage.getItem("kerdos.activeTab") || "order"; }
    catch { return "order"; }
  });
  const [showPaste,setShowPaste]=useState(false);
  // One plain line after an import finishes on its own; it clears itself.
  const [importNotice,setImportNotice]=useState(null);
  // Who is on the team, by user id, so a cell someone edited can show their
  // initials. Loaded once per organization for owners and managers.
  const [editors,setEditors]=useState({});
  useEffect(()=>{
    if(!org||org.role==="employee"){setEditors({});return;}
    let cancelled=false;
    organizationService.team(org.id).then(team=>{
      if(cancelled)return;
      const map={};
      for(const member of team?.members||[])map[member.user_id]={email:member.email||"",name:member.name||member.full_name||""};
      if(session?.user?.id&&!map[session.user.id])map[session.user.id]={email:session.user.email||""};
      setEditors(map);
    }).catch(()=>{ if(!cancelled&&session?.user?.id)setEditors({[session.user.id]:{email:session.user.email||""}}); });
    return ()=>{cancelled=true;};
  },[org?.id,org?.role,session?.user?.id]);
  useEffect(()=>{ if(!importNotice) return; const t=setTimeout(()=>setImportNotice(null),8000); return ()=>clearTimeout(t); },[importNotice]);
  const [selectedVendorId,setSelectedVendorId]=useState(null);
  const [importMode,setImportMode]=useState("pricelist");
  const [vendorDetailId,setVendorDetailId]=useState(null);
  const [logoUrl,setLogoUrl]=useState(null);
  const [logoUploading,setLogoUploading]=useState(false);
  const [showAddVendor,setShowAddVendor]=useState(false);
  const [editingInvoice,setEditingInvoice]=useState(null);
  const [unitSelection,setUnitSelection]=useState({});
  const [vendorOverride,setVendorOverride]=useState({});
  const [negotiatedPrices,setNegotiatedPrices]=useState({}); // unit key -> vendor ID -> agreed price
  const [splitOrders,setSplitOrders]=useState({}); // {item/unit key: {vendorId, quantity}}
  const [openPriceMenu,setOpenPriceMenu]=useState(null);
  useEffect(()=>{
    if(openPriceMenu==null)return;
    const closeOutside=event=>{if(!(event.target instanceof Element)||!event.target.closest("[data-price-menu]"))setOpenPriceMenu(null);};
    const closeEscape=event=>{if(event.key==="Escape")setOpenPriceMenu(null);};
    document.addEventListener("pointerdown",closeOutside);
    document.addEventListener("keydown",closeEscape);
    return ()=>{document.removeEventListener("pointerdown",closeOutside);document.removeEventListener("keydown",closeEscape);};
  },[openPriceMenu]);
  const [customPriceDrafts,setCustomPriceDrafts]=useState({});
  const [negotiatedVendorDrafts,setNegotiatedVendorDrafts]=useState({});
  const [negotiationErrors,setNegotiationErrors]=useState({});
  const [expandedOrderTabOrder,setExpandedOrderTabOrder]=useState(null);
  const [expandedInvoiceId,setExpandedInvoiceId]=useState(null);
  const [expandedPricePeriod,setExpandedPricePeriod]=useState(null);
  const [recordsVendorFilter,setRecordsVendorFilter]=useState(null);
  const [priceSheetVendorFilter,setPriceSheetVendorFilter]=useState(null);
  const [search,setSearch]=useState("");
  const [loading,setLoading]=useState(true);
  const [clockTick,setClockTick]=useState(0);
  useEffect(()=>{const timer=setInterval(()=>setClockTick(n=>n+1),60000);return ()=>clearInterval(timer);},[]);
  // Imported documents always arrive and remain closed. Switching tabs also
  // closes any document that had been opened; history never expands itself.
  useEffect(()=>{
    setExpandedInvoiceId(null);
    setExpandedPricePeriod(null);
  },[tab]);
  // Order Guide's own category filter + sort mode - separate state from
  // Item Catalog's (different tab, different job: this one is for
  // PLACING orders, so it only ever shows items with a vendor price -
  // but the same "browse by item type, order by code/alpha" idea applies.
  const [orderCategoryFilter,setOrderCategoryFilter]=useState("");
  const [orderSortMode,setOrderSortMode]=useState("alpha"); // "alpha" | "itemNumber" | "vendorCode"
  function openOrderGuide(){setSearch("");setOrderCategoryFilter("");setTab("order");}

  // Startup and session transitions are owned by sessionController (see
  // session.js), not decided here. It reports a single "entered" flag for
  // a REAL sign-in, so a token refresh - which the auth provider also
  // reports as SIGNED_IN, and which fires just from switching back to
  // this tab - can't yank someone back to Orders mid-work. It also
  // discards callbacks from a superseded startup, so a fast
  // sign-out/sign-in can't leave a stale session on screen.
  useEffect(()=>{
    let cancelled=false;
    sessionController.start(({session:s,entered})=>{
      if(cancelled) return;
      setSession(s);
      if(entered) setTab("order");
    }).catch(()=>{ if(!cancelled) setSession(null); });
    return ()=>{ cancelled=true; sessionController.stop(); };
  },[]);

  // Without this, dropping a file anywhere outside the exact import drop
  // zone — even one pixel off, or before the import modal is even open —
  // falls through to the browser's default behavior, which just opens the
  // file in the tab instead of letting our own drop handler run.
  useEffect(()=>{
    const preventDefault=e=>e.preventDefault();
    window.addEventListener("dragover",preventDefault);
    window.addEventListener("drop",preventDefault);
    return ()=>{
      window.removeEventListener("dragover",preventDefault);
      window.removeEventListener("drop",preventDefault);
    };
  },[]);

  // Preserve the current workspace on a normal browser refresh. A genuine
  // sign-in still intentionally starts on Order Guide via sessionController.
  useEffect(()=>{
    try { sessionStorage.setItem("kerdos.activeTab", tab); } catch {}
  },[tab]);

  useEffect(()=>{
    if(session===undefined) return;
    if(!session){setLoading(false);return;}
    organizationService.syncProfile(session.user).catch(error=>console.error("Profile sync failed:",error.message));
    loadData();
  },[session]);

  useEffect(()=>{
    const reconnect=()=>{ if(session) loadData(); };
    window.addEventListener("online",reconnect);
    return ()=>window.removeEventListener("online",reconnect);
  },[session,org?.id]);

  // The first load, and a switch of organization, show the loading
  // screen. Every later refresh (after a save, an import, automatic
  // placement) updates the data in place: the page stays put, nothing
  // flashes, and unsaved edits in other rows are untouched.
  const loadedOnce=useRef(false);
  const [loadSeq,setLoadSeq]=useState(0);
  async function loadData(requestedOrganizationId=null){
    const silent=loadedOnce.current&&!requestedOrganizationId;
    if(!silent)setLoading(true);
    const membershipKey=`memberships:${session.user.id}`;
    let mem, usingLocal=null;
    try{
      mem=await backend.workspace.memberships(session.user.id);
      void saveSnapshot(membershipKey,mem);
    }catch(err){
      const kept=await loadSnapshot(membershipKey);
      if(!kept){
        setLoading(false);
        alert(err.message||String(err));
        return;
      }
      mem=kept.value;
      usingLocal={since:kept.savedAt};
    }
    if(!mem?.length){setOrganizations([]);setOrg(null);setLoading(false);return;}
    const available=mem.map(m=>({...m.organizations,role:m.role}));
    setOrganizations(available);
    let savedId=null;
    try{savedId=sessionStorage.getItem("kerdos.organizationId");}catch{}
    const selectedId=requestedOrganizationId||org?.id||savedId;
    const o=available.find(candidate=>candidate.id===selectedId)||available[0];
    try{sessionStorage.setItem("kerdos.organizationId",o.id);}catch{}
    configureLocale(o.settings);
    setOrg(o);
    if(o.logo_url) getSignedUrl(o.logo_url).then(setLogoUrl); else setLogoUrl(null);
    const id=o.id;
    const snapshotKey=`snapshot:${id}`;
    let snapshot;
    try{
      snapshot=await backend.workspace.snapshot(id);
      void saveSnapshot(snapshotKey,snapshot);
      usingLocal=null;
    }
    catch(error){
      const kept=await loadSnapshot(snapshotKey);
      if(!kept){
        setLoading(false);
        alert(`KERDOS kept the existing workspace because it could not refresh data: ${error.message}`);
        return;
      }
      snapshot=kept.value;
      usingLocal={since:kept.savedAt};
    }
    setOffline(usingLocal);
    // The engine reads this org's vocabulary from here on - before any
    // matching, parsing, or per-unit pricing in this session runs.
    configureProcurement({industry:o.industry,vocabulary:snapshot.vocabulary});
    // Automatic cross-vendor grouping writes removed per consensus (2026-10-05).
    // alternativeGroups() still runs at display time for Item Catalog grouping UI.
    // Only explicit client decisions via AssociateAlternatives write to the database.
    if(false&&!usingLocal&&["owner","manager"].includes(o.role)&&backend.catalog.groupAutomaticAlternatives&&!automaticGrouping.current){
      automaticGrouping.current=true;
      let changed=false;
      try{
        const groups=alternativeGroups(snapshot).slice(0,20);
        for(const group of groups){
          await backend.catalog.groupAutomaticAlternatives({organizationId:id,vendorItemIds:group.rows.map(v=>v.id),targetCatalogItemId:group.targetCatalogItemId,key:group.key,dimension:group.dimension,revisions:Object.fromEntries(group.rows.map(v=>[v.id,v.row_revision||0]))});
          changed=true;
        }
        if(changed){snapshot=await backend.workspace.snapshot(id);void saveSnapshot(snapshotKey,snapshot);}
      }catch(error){
        if(changed){try{snapshot=await backend.workspace.snapshot(id);void saveSnapshot(snapshotKey,snapshot);}catch{}}
        setImportNotice({message:"Automatic associations need attention: "+error.message});
      }
      finally{automaticGrouping.current=false;}
    }
    setVocabulary(snapshot.vocabulary);
    setVendors(snapshot.vendors);
    setCatalogItems(snapshot.catalogItems);
    setCategories(snapshot.categories);
    setVendorItems(snapshot.vendorItems);
    setMappings(snapshot.mappings);
    setInvoices(snapshot.invoices);
    setPurchaseOrders(snapshot.purchaseOrders);
    setPriceHistory(snapshot.priceHistory);
    setImportDocuments(snapshot.importDocuments||[]);
    setImportDocumentsHasMore((snapshot.importDocuments||[]).length===500);
    setPriceHistoryHasMore(snapshot.priceHistory.length===2000);
    loadedOnce.current=true;
    setLoading(false);
    setLoadSeq(n=>n+1);
  }

  async function switchOrganization(organizationId){
    if(!organizationId||organizationId===org?.id)return;
    setQuantities({});setVendorOverride({});setNegotiatedPrices({});setUnitSelection({});
    await loadData(organizationId);
  }

  useEffect(()=>{
    if(!org||showPaste) return;
    return backend.realtime.subscribeToOrganization(org.id,()=>{void loadData();});
  },[org?.id,showPaste]);

  const vendorColors=useMemo(()=>new Map(vendors.map((v,i)=>[v.id,PALETTE[i%PALETTE.length]])),[vendors]);

  // Build unified product list — one ranked list per catalog item
  // showing all vendor options cheapest first, with case AND each pricing
  const unmappedCount=useMemo(()=>{
    const mappedIds=new Set(mappings.map(m=>m.vendor_item_id));
    return vendorItems.filter(vi=>!mappedIds.has(vi.id)).length;
  },[vendorItems,mappings]);

  const [backfilling,setBackfilling]=useState(false);
  const [catalogRepairError,setCatalogRepairError]=useState("");
  const attemptedCatalogRepair=useRef(new Set());
  // Automatic association writes removed per consensus (2026-10-05).
  // Unmapped rows appear in Item Catalog for explicit client linking.
  async function backfillMappings(){
    // Automatic association writes removed per consensus (2026-10-05).
    // Unmapped rows appear in Item Catalog for explicit client linking.
    setBackfilling(false);
    setCatalogRepairError("");
  }

  // Automatic placement. Any row whose fields are all solved goes into the
  // Order Guide by itself: the association is recorded as exact and a
  // best-guess category is accepted. Runs after every data load for owners
  // and managers; each set of rows is attempted once, so a refused write
  // can't loop.
        // Automatic standalone placement: a vendor item with all required fields
  // solved gets its own exact association and reaches the Order Guide without
  // any click. This only fires for items that mappingVerification independently
  // confirms as exact — which for a single-vendor item means the item's own
  // fields check out, not that it was compared to another vendor's product.
  // Cross-vendor equivalence still requires an explicit client decision.
  const attemptedAutoPlace=useRef(new Set());
  const [autoPlacing,setAutoPlacing]=useState(false);
  const [autoPlaceError,setAutoPlaceError]=useState("");
  const [autoPlaceRetry,setAutoPlaceRetry]=useState(0);
  useEffect(()=>{
    if(!org||org.role==="employee"||loading||autoPlacing||backfilling)return;
    const ready=autoPlaceable({catalogItems,vendorItems,mappings,vendors,categories,settings:org.settings});
    if(!ready.length)return;
    const key=JSON.stringify([org.id,autoPlaceRetry,ready.map(r=>r.mappingId).sort()]);
    if(attemptedAutoPlace.current.has(key))return;
    attemptedAutoPlace.current.add(key);
    setAutoPlacing(true);setAutoPlaceError("");
    (async()=>{
      try{
        await catalogService.confirmMappings(ready);
        const guessed=[...new Set(ready.filter(r=>r.clearCategoryReview).map(r=>r.catalogItemId))];
        if(guessed.length)await catalogService.confirmCategories(guessed);
        await loadData();
      }catch(error){setAutoPlaceError(`Automatic placement could not finish: ${error.message||String(error)}`);}
      finally{setAutoPlacing(false);}
    })();
  },[org?.id,org?.role,org?.settings,autoPlaceRetry,loading,autoPlacing,backfilling,loadSeq]);

  useEffect(()=>{
    if(tab!=="catalog"||!org||org.role==="employee"||backfilling||!unmappedCount)return;
    const key=`${org.id}:${vendorItems.filter(vi=>!mappings.some(m=>m.vendor_item_id===vi.id)).map(vi=>vi.id).sort().join(",")}`;
    if(attemptedCatalogRepair.current.has(key))return;
    attemptedCatalogRepair.current.add(key);
    void backfillMappings();
  },[tab,org?.id,org?.role,unmappedCount,vendorItems,mappings,backfilling]);

  const productList=useMemo(()=>{
    if(!catalogItems.length) return [];
    const viMap=new Map(vendorItems.map(vi=>[vi.id,vi]));
    const vMap=new Map(vendors.map(v=>[v.id,v]));
    const penName=holdingPen(categories)?.name||"Uncategorized";

    const mappingsByCatalog=new Map();
    for(const mapping of mappings){const group=mappingsByCatalog.get(mapping.catalog_item_id)||[];group.push(mapping);mappingsByCatalog.set(mapping.catalog_item_id,group);}
    const categoriesById=new Map(categories.map(category=>[category.id,category]));
    return catalogItems.map(ci=>{
      const ciMappings=mappingsByCatalog.get(ci.id)||[];
      const lockedBrand=ci.brand_locked?(ci.locked_brand||null):null;
      const options=ciMappings.map(m=>{
        const vi=viMap.get(m.vendor_item_id);
        const v=vi?vMap.get(vi.vendor_id):null;
        if(!vi||!v) return null;
        // Preserve the actual quoted price even when expired. Block it from
        // ordering and comparison; never turn a historical quote into $0.
        const quote=quoteStatus(vi,org?.settings||{});
        const expired=quote==="expired";
        const invoiceOnly=quote==="invoice_only";
        const clientApproved=m.match_method==="manual"&&!!vi.field_resolutions?.row_approval;
        const costOverride=clientApproved?vi.field_resolutions?.unit_cost_override?.value:null;
        const pack=vi.pack_size||(costOverride?"Client-approved purchasing pack":null);
        const assessment=orderGuideAssessment({item:ci,vendorItem:vi,mapping:m,vendor:v,category:categoriesById.get(ci.category_id),
          peers:ciMappings.filter(other=>other.id!==m.id).map(other=>viMap.get(other.vendor_item_id)).filter(Boolean),categories,settings:org?.settings||{}});
        // Every vendor is ranked on the price of one full pack. A quote
        // recorded per pound/gallon/each is converted through the pack;
        // legacy rows with no recorded basis were always pack prices.
        const quoteBasis=vi.price_basis||priceBasisFor(vi.selling_unit)?.basis||null;
        const quoteUnit=quoteBasis==="measure"?(vi.selling_unit||null):null;
        const price=costOverride?Number(costOverride.packPrice):casePriceFromQuote(vi.price,quoteBasis,quoteUnit,pack);
        const basisUnconvertible=price==null&&!!quoteBasis&&quoteBasis!=="case";
        const each=!costOverride&&quote==="current"&&price!=null?eachPrice(price,pack):null;
        // A locked brand blocks every vendor item that is a different
        // brand - and one with no brand listed, since "unknown" cannot
        // be verified as the locked brand.
        const brandMismatch=!!lockedBrand&&!brandsMatch(vi.brand,lockedBrand);
        return {
          vendorId:v.id, vendorName:v.name,
          vendorItemId:vi.id, vendorItemCode:vi.vendor_item_code,vendorNvim:vi.nvim_number,
          brand:vi.brand, packSize:pack, description:vi.description,clientApproved,costOverride,automaticAlternative:automaticAlternativeVerified(vi,ci,ciMappings.map(other=>viMap.get(other.vendor_item_id)).filter(Boolean)),
          casePrice:quote==="unavailable"&&vi.price_basis==null?null:price??(vi.price==null?null:parseFloat(vi.price)),
          quotedPrice:vi.price==null?null:parseFloat(vi.price), quoteBasis, quoteUnit, basisUnconvertible,
          eachPrice:each?.price||null, eachSize:each?.size||null,
          mappingId:m.id,
          matchConfidence:m.confidence_score, matchTrack:m.comparison_track, matchMethod:m.match_method,
          expired,
          priceUnavailable:quote==="unavailable",
          invoiceOnly,
          unverified:m.comparison_track!=="exact"||m.confidence_score!==100||!assessment.ready,
          qualificationBlockers:assessment.blockers,qualificationReason:assessment.blockers.map(code=>BLOCKER_LABELS[code]).join("; "),
          brandMismatch,
          // Unresolved-field explanations and arithmetic conflicts from cell analysis
          cellUnresolved:vi.import_row?.evidence?.cellUnresolved||null,
          cellConflicts:vi.import_row?.evidence?.cellConflicts||null,
        };
      }).filter(Boolean).sort((a,b)=>{
        // Blocked options (stale price, wrong brand) always sink to the
        // bottom regardless of price, so they can never look "cheapest".
        const ab=!orderable(a), bb=!orderable(b);
        if(ab!==bb) return ab?1:-1;
        return a.casePrice-b.casePrice;
      });

      // Older manual links may predate verification. A mixed group is not a
      // valid price comparison even if every saved row says "exact".
      for(const option of options){
        const conflicting=options.some(other=>{
          if(other.vendorItemId===option.vendorItemId)return false;
          return comparePurchasingPack(option.packSize,other.packSize).status!=="same" ||
            compareProductIdentity(option.description,other.description).status!=="same" ||
            // Brand difference only matters when the client requires a specific brand
          (ci.brand_locked&&!!(option.brand||other.brand)&&!brandsMatch(option.brand,other.brand));
        });
        if(conflicting&&((!option.clientApproved&&!option.automaticAlternative)||ci.comparison_mode==="exact")){
          option.unverified=true;
          option.comparisonWarning="Linked vendor products differ in description or pack; review this catalog item";
        }
      }

      // Per-unit price for the honest cross-vendor comparison. Shown in
      // the unit the client chose for this item (canonical_unit), or,
      // until they choose one, the unit of the first readable pack.
      const firstPack=options.map(o=>parsePackSize(o.packSize)).find(p=>p?.parsed);
      const displayUnit=ci.canonical_unit||defaultComparisonUnit(options.find(o=>parsePackSize(o.packSize)?.parsed)?.packSize,org?.industry)||options.find(o=>o.costOverride)?.costOverride.unit||null;
      for(const o of options){
        o.perUnit=o.costOverride?{price:Number(o.costOverride.price),unit:o.costOverride.unit}:(orderable(o)&&displayUnit)?pricePerUnit(o.casePrice,o.packSize,displayUnit):null;
        // Never represent unlike dimensions as competing per-unit offers.
        if(o.perUnit && o.perUnit.unit!==displayUnit) o.perUnit=null;
        if(orderable(o)&&options.filter(orderable).length>1&&!o.perUnit){
          o.unverified=true;o.qualificationReason="Choose a shared comparison measurement or correct the pack before ranking alternatives";
        }
      }

      return {
        catalogItemId:ci.id,
        masterItemNumber:ci.master_item_number,
        name:ci.name,
        category:ci.catalog_categories?.name||penName,
        categoryReview:!!ci.category_review, categoryReason:ci.category_reason||null,
        createdAt:ci.created_at,
        brandLocked:ci.brand_locked||false,
        preferredBrand:ci.preferred_brand||null,comparisonMode:ci.comparison_mode||"alternatives",
        lockedBrand,
        matchingBehavior:ci.matching_behavior||"flexible",
        canonicalUnit:ci.canonical_unit||null,
        displayUnit,
        unitDimension:firstPack?.dimension||null,
        options,
        // All distinct vendor IDs linked to this KERDOS item, regardless of
        // whether they are currently orderable. Used by the multi-vendor badge
        // so that held vendors (expired quote, unverified match, etc.) are
        // counted and disclosed rather than silently dropped.
        allLinkedVendorIds:[...new Set(options.map(o=>o.vendorId))],
      };
    });
  },[catalogItems,categories,vendorItems,mappings,vendors,vendorColors,vocabulary,org?.settings,clockTick]);

  const vMap=useMemo(()=>new Map(vendors.map(v=>[v.id,v])),[vendors]);

  // Invoices tab's own review data: lines with no match, or only a
  // fuzzy match, plus vendor items whose only price on file so far came
  // from an invoice rather than a confirmed price sheet. Lives here (not
  // Item Catalog) because it's specifically about invoice data.
  const flaggedInvoiceLines=useMemo(()=>{
    const out=[];
    for(const inv of invoices){
      const v=vMap.get(inv.vendor_id);
      for(const line of (inv.invoice_lines||[])){
        if(!line.vendor_item_id||line.match_method==="fuzzy"){
          out.push({lineId:line.id, vendorName:v?.name||"—", vendorId:inv.vendor_id,
            invoiceDate:inv.invoice_date, description:line.description,
            price:line.unit_price, confidence:line.match_confidence, noMatch:!line.vendor_item_id});
        }
      }
    }
    return out.sort((a,b)=>(a.confidence??-1)-(b.confidence??-1));
  },[invoices,vMap]);

  const invoiceDerivedItems=useMemo(()=>
    vendorItems.filter(vi=>vi.price_source==="invoice").map(vi=>{
      const v=vMap.get(vi.vendor_id);
      return {id:vi.id, vendorName:v?.name||"—", vendorId:vi.vendor_id, description:vi.description, price:vi.price};
    }),
  [vendorItems,vMap]);

  // Review belongs with catalog items and invoice comparisons. Price Sheets
  // is an archive of imported documents, so it has no item-activity badge.
  const needsAttentionCount=useMemo(()=>
    mappings.filter(m=>m.comparison_track!=="exact"||m.confidence_score!==100).length,
  [mappings]);
  const invoiceReviewCount=flaggedInvoiceLines.length;

  const setQty=(key,val)=>setQuantities(p=>({...p,[key]:Math.max(0,val)}));

  const basketKey=org?`kerdos.basket.${org.id}`:null;
  useEffect(()=>{
    if(!basketKey) return;
    setRestoredBasketKey(null);
    let saved=null;
    try{ saved=JSON.parse(localStorage.getItem(basketKey)||"null"); }catch{}
    setQuantities(saved?.quantities||{});
    setUnitSelection(saved?.unitSelection||{});
    const legacyPrices=saved?.priceOverride||{};
    const legacyVendors=saved?.vendorOverride||{};
    const restoredPrices=saved?.negotiatedPrices||Object.fromEntries(Object.entries(legacyPrices)
      .filter(([key,value])=>legacyVendors[key]&&Number.isFinite(Number(value)))
      .map(([key,value])=>[key,{vendorId:legacyVendors[key],price:Number(value)}]));
    setNegotiatedPrices(Object.fromEntries(Object.entries(restoredPrices).map(([key,value])=>
      [key,value?.vendorId?{[value.vendorId]:value.price}:value])));
    setVendorOverride(saved?.negotiatedPrices?legacyVendors:Object.fromEntries(Object.entries(legacyVendors).filter(([key])=>!(key in legacyPrices))));
    setSplitOrders(saved?.splitOrders||{});
    setRestoredBasketKey(basketKey);
  },[basketKey]);

  useEffect(()=>{
    if(!basketKey||restoredBasketKey!==basketKey) return;
    try{
      localStorage.setItem(basketKey,JSON.stringify({quantities,unitSelection,vendorOverride,negotiatedPrices,splitOrders}));
    }catch{}
  },[basketKey,restoredBasketKey,quantities,unitSelection,vendorOverride,negotiatedPrices,splitOrders]);

  function clearBasket(){
    setQuantities({});
    setVendorOverride({});
    setNegotiatedPrices({});
    setSplitOrders({});
  }

  function dropOnBasket(vendorId){
    const dragged=dragItem;
    setDragItem(null);
    setDropTarget(null);
    if(!dragged) return;
    const product=productList.find(item=>item.catalogItemId===dragged.catalogItemId);
    if(!product) return;
    if(vendorId){
      const wantsEach=dragged.key.endsWith("_each");
      const option=product.options.find(candidate=>candidate.vendorId===vendorId&&orderable(candidate)&&(!wantsEach||candidate.eachPrice));
      if(!option){
        const vendorName=vendors.find(vendor=>vendor.id===vendorId)?.name||"That vendor";
        setDropNotice(`${vendorName} has no current quote for ${product.name}.`);
        window.setTimeout(()=>setDropNotice(""),4000);
        return;
      }
      setVendorOverride(previous=>({...previous,[dragged.key]:vendorId}));
    }
    setQty(dragged.key,(quantities[dragged.key]||0)+1);
  }

  // Build cart items from quantities
  const cartItems=useMemo(()=>{
    const items=[];
    for(const prod of productList){
      const caseKey=`${prod.catalogItemId}_case`;
      const eachKey=`${prod.catalogItemId}_each`;
      const caseQty=quantities[caseKey]||0;
      const eachQty=quantities[eachKey]||0;
      if(caseQty>0){
        const customVendorId=vendorOverride[caseKey]||null;
        const negotiation=negotiatedPrices[caseKey];
        const ranked=rankVendorOffers(prod.options,negotiation);
        const preferredVendorId=ranked.find(o=>orderable(o)&&(o.vendorItemId===customVendorId||o.vendorId===customVendorId))?.vendorId||(ranked.find(o=>orderable(o)&&prod.preferredBrand&&brandsMatch(o.brand,prod.preferredBrand))||ranked.find(orderable))?.vendorId;
        const split=splitOrders[caseKey];
        const splitQty=split&&split.vendorId!==preferredVendorId&&prod.options.some(o=>o.vendorId===split.vendorId&&orderable(o))?Math.min(caseQty-1,Math.max(0,Math.floor(Number(split.quantity)||0))):0;
        items.push({...prod,quantity:caseQty-splitQty,orderUnit:"case",
          options:prod.options.map(o=>({...o,price:priceForOffer(o,negotiation),orderUnit:"case"})),
          forcedVendorId:splitQty>0?preferredVendorId:customVendorId||rankVendorOffers(prod.options,negotiation).find(o=>orderable(o)&&prod.preferredBrand&&brandsMatch(o.brand,prod.preferredBrand))?.vendorItemId||null,
          forcedPrice:null});
        if(splitQty>0)items.push({...prod,catalogItemId:`${prod.catalogItemId}_split_case`,quantity:splitQty,orderUnit:"case",
          options:prod.options.map(o=>({...o,price:priceForOffer(o,negotiation),orderUnit:"case"})),forcedVendorId:split.vendorId,forcedPrice:null});
      }
      if(eachQty>0&&prod.options.some(o=>o.eachPrice)){
        const customVendorId=vendorOverride[eachKey]||null;
        const negotiation=negotiatedPrices[eachKey];
        const ranked=rankVendorOffers(prod.options.filter(o=>o.eachPrice),negotiation,"each");
        const preferredVendorId=ranked.find(o=>orderable(o)&&(o.vendorItemId===customVendorId||o.vendorId===customVendorId))?.vendorId||(ranked.find(o=>orderable(o)&&prod.preferredBrand&&brandsMatch(o.brand,prod.preferredBrand))||ranked.find(orderable))?.vendorId;
        const split=splitOrders[eachKey];
        const splitQty=split&&split.vendorId!==preferredVendorId&&prod.options.some(o=>o.vendorId===split.vendorId&&o.eachPrice&&orderable(o))?Math.min(eachQty-1,Math.max(0,Math.floor(Number(split.quantity)||0))):0;
        items.push({...prod,catalogItemId:`${prod.catalogItemId}_each`,quantity:eachQty-splitQty,orderUnit:"each",
          options:prod.options.filter(o=>o.eachPrice).map(o=>({...o,price:priceForOffer(o,negotiation,"each"),packSize:o.eachSize,orderUnit:"each"})),
          forcedVendorId:splitQty>0?preferredVendorId:customVendorId||rankVendorOffers(prod.options.filter(o=>o.eachPrice),negotiation,"each").find(o=>orderable(o)&&prod.preferredBrand&&brandsMatch(o.brand,prod.preferredBrand))?.vendorItemId||null,
          forcedPrice:null});
        if(splitQty>0)items.push({...prod,catalogItemId:`${prod.catalogItemId}_split_each`,quantity:splitQty,orderUnit:"each",
          options:prod.options.filter(o=>o.eachPrice).map(o=>({...o,price:priceForOffer(o,negotiation,"each"),packSize:o.eachSize,orderUnit:"each"})),forcedVendorId:split.vendorId,forcedPrice:null});
      }
    }
    return items;
  },[productList,quantities,vendorOverride,negotiatedPrices,splitOrders]);

  const assignments=useMemo(()=>solveOrder(cartItems,vendors),[cartItems,vendors]);
  const assignMap=useMemo(()=>new Map(assignments.map(a=>[a.catalogItemId,a])),[assignments]);

  const baskets=useMemo(()=>{
    const map=new Map();
    for(const a of assignments){
      if(a.unorderable||!a.assignedVendorId) continue;
      const b=map.get(a.assignedVendorId)||{vendorId:a.assignedVendorId,vendorName:a.assignedVendorName,items:[],dollar:0,units:0};
      b.items.push(a);b.dollar=r2(b.dollar+a.lineTotal);b.units+=a.quantity;
      map.set(a.assignedVendorId,b);
    }
    return Array.from(map.values());
  },[assignments]);

  const baselineSpend=useMemo(()=>cartItems.reduce((s,i)=>{
    const cheapest=i.options.filter(orderable).sort((a,b)=>a.price-b.price)[0];
    return s+(cheapest?.price||0)*i.quantity;
  },0),[cartItems]);
  const blockedCartItems=assignments.filter(a=>a.unorderable||!a.assignedVendorId);
  const totalSpend=baskets.reduce((s,b)=>s+b.dollar,0);
  const totalUnits=baskets.reduce((s,b)=>s+b.units,0);

  const orderCategoryList=useMemo(()=>{
    // Order Guide only ever lists items with a vendor price (see the
    // options.length>0 filter below) - the category chip list is scoped
    // to that same orderable set, not the full catalog, so a category
    // that's entirely unpriced doesn't show an empty chip here. Order
    // Guide's categories are alphabetical - not the number-range order
    // Item Catalog uses, since this screen is for FINDING something to
    // order, not for working the numbering itself.
    const set=new Set(productList.filter(i=>i.options.some(orderable)).map(p=>p.category));
    return [...set].sort((a,b)=>a.localeCompare(b));
  },[productList]);
  const readyOrderCount=productList.filter(item=>item.options.some(orderable)).length;

  const filtered=useMemo(()=>{
    // Order Guide is for ORDERING - a client-created item with no vendor
    // price mapped to it yet has nothing to order, so it's excluded here
    // even though it's fully visible in Item Catalog.
    const matches=productList.filter(i=>{
      if(!i.options.some(orderable)) return false;
      if(orderCategoryFilter&&i.category!==orderCategoryFilter) return false;
      return itemMatchesSearch(i,search);
    });
    // Category alphabetical first, then ordered within each category by
    // whichever sort mode is active (defaults to alphabetical too, so
    // "alphabetize category, then alphabetize in the category" is the
    // out-of-the-box behavior).
    const groups=new Map();
    matches.forEach(item=>{
      item={...item,options:item.options.filter(orderable)};
      const cat=item.category;
      if(!groups.has(cat)) groups.set(cat,[]);
      groups.get(cat).push(item);
    });
    return [...groups.entries()]
      .map(([category,items])=>({category,items:items.sort((a,b)=>compareItems(a,b,orderSortMode))}))
      .sort((a,b)=>a.category.localeCompare(b.category));
  },[productList,search,orderCategoryFilter,orderSortMode]);

  async function handleLogoUpload(file) {
    if (!file) return;
    setLogoUploading(true);
    const result = await uploadOrgLogo(org.id, file);
    if (result.error) {
      alert("Couldn't upload logo: " + result.error.message);
    } else {
      try {
        await organizationService.update(org.id,{logo_url:result.path});
        const url = await getSignedUrl(result.path);
        setLogoUrl(url);
        setOrg(o => ({ ...o, logo_url: result.path }));
      } catch (err) { alert(err.message); }
    }
    setLogoUploading(false);
  }

  async function deleteInvoice(inv){
    if(!window.confirm(`Delete this ${inv.vendors?.name||""} invoice? This can't be undone.`)) return;
    try{
      const result=await operationsService.deleteInvoice(org.id,inv.id);
      await loadData();
      if(result?.file_path)try{await documents.remove([result.file_path]);}
      catch(err){alert(`Invoice record deleted, but its stored file needs cleanup: ${err.message}`);}
    }catch(err){alert(err.message);}
  }

  async function deletePriceSheet(doc,reimport=false){
    if(!window.confirm(`Delete ${doc.fileName}? Its quote history from this sheet will be removed and its current prices cleared. Product mappings and other sheets remain. You can then import the file again.`))return;
    try{
      const result=await operationsService.deletePriceSheet(org.id,doc.id);
      await loadData();
      if(result?.file_path)try{await documents.remove([result.file_path]);}
      catch(err){alert(`Price sheet record deleted, but its stored file needs cleanup: ${err.message}`);}
      if(reimport){setSelectedVendorId(doc.vendorId);setImportMode("pricelist");setShowPaste(true);}
    }catch(err){alert(err.message);}
  }

  async function clearPriceSheet(doc){
    const active=vendorItems.filter(vi=>vi.vendor_id===doc.vendorId&&vi.import_row?.sourceDocumentId===doc.id&&quoteStatus(vi,org?.settings||{})==="current");
    if(!active.length){alert("This sheet has no current prices to clear.");return;}
    if(!window.confirm(`Remove ${active.length} current price(s) from the Order Guide? This sheet stays in history, and its item links remain.`))return;
    try{await vendorService.expireQuotes({organizationId:org.id,vendorId:doc.vendorId,vendorItemIds:active.map(vi=>vi.id)});await loadData();}
    catch(err){alert(err.message);}
  }

  async function loadOlderPriceHistory(){
    if(!org?.id||loadingOlderPrices)return;
    setLoadingOlderPrices(true);
    try{
      const page=await operationsService.olderPriceHistory(org.id,priceHistory.length);
      setPriceHistory(current=>{
        const existing=new Set(current.map(row=>row.id));
        return [...current,...page.filter(row=>!existing.has(row.id))];
      });
      setPriceHistoryHasMore(page.length===2000);
    }catch(err){alert(err.message);}
    setLoadingOlderPrices(false);
  }

  async function loadOlderDocuments(){
    if(!org?.id||loadingOlderDocuments)return;
    setLoadingOlderDocuments(true);
    try{
      const page=await documents.olderPriceDocuments(org.id,importDocuments.length);
      setImportDocuments(current=>{
        const existing=new Set(current.map(doc=>doc.id));
        return [...current,...page.filter(doc=>!existing.has(doc.id))];
      });
      setImportDocumentsHasMore(page.length===500);
    }catch(err){alert(err.message);}
    finally{setLoadingOlderDocuments(false);}
  }

  async function expireVendorQuotes(vendorId){
    const vendor=vendors.find(v=>v.id===vendorId);
    const active=vendorItems.filter(vi=>vi.vendor_id===vendorId && quoteStatus(vi,org?.settings||{})==="current");
    if(!active.length){alert("No current vendor prices to expire.");return;}
    if(!window.confirm(`Expire ${active.length} current price(s) for ${vendor?.name||"this vendor"}? All quoted amounts remain in Price Sheet History. Nothing is deleted.`)) return;
    try{
      await vendorService.expireQuotes({organizationId:org.id,vendorId,vendorItemIds:active.map(vi=>vi.id)});
      await loadData();
    }catch(err){alert(err.message);}
  }

  async function expireOneQuote(item){
    if(!window.confirm(`Expire ${item.description} for ${vendors.find(v=>v.id===item.vendor_id)?.name||"this vendor"}? Its price stays in history.`))return;
    try{
      await vendorService.expireQuote(item.id);
      await loadData();
    }catch(err){alert(err.message);}
  }

  async function submitOrders(){
    if(blockedCartItems.length){alert(`${blockedCartItems.length} item(s) need a confirmed current quote. Remove them or refresh their prices before submitting.`);return;}
    if(!baskets.length){alert("No orderable items in the basket.");return;}
    let placed=0;
    try{
      for(const basket of baskets){
        await operationsService.submitOrder({organizationId:org.id,userId:session.user.id,basket});
        placed++;
      }
      alert(`${placed} order${placed===1?"":"s"} recorded in KERDOS. These records do NOT send orders to vendors. Use the Email/Text draft buttons and send from your messaging app.`);
      clearBasket();
    }catch(err){
      alert(`${err.message}${placed?` (${placed} order${placed===1?"":"s"} before it did go through.)`:""}`);
    }
    // Recent Orders reads purchase_orders, which the live channel does not
    // watch, so refresh explicitly rather than waiting for the next reload.
    loadData();
  }

  // Send one vendor basket through the user's normal email or text app
  // without changing the optimized basket or recording it as submitted.
  function basketOrderMessage(vendor,basket){
    const lines=[
      "KERDOS Purchase Order",
      `Customer: ${org.name}`,
      `Vendor: ${vendor.name}`,
      "",
      ...basket.items.map(item=>{
        const vi=vendorItems.find(v=>v.id===item.vendorItemId);
        const code=vi?.vendor_item_code?`[${vi.vendor_item_code}] `:"";
        const pack=item.packSize?` (${item.packSize})`:"";
        return `${item.quantity} ${item.orderUnit} × ${code}${vi?.description||item.name}${pack} — ${formatMoney(item.lineTotal)}`;
      }),
      "",
      `Order total: ${formatMoney(basket.dollar)}`,
    ];
    return lines.join("\n");
  }

  function emailBasket(vendor,basket){
    const destination=(vendor.email||window.prompt(`Email address for ${vendor.name}:`,"")||"").trim();
    if(!destination) return;
    const body=basketOrderMessage(vendor,basket);
    if(!window.confirm(`Open an email for ${vendor.name} with this ${basket.items.length}-item order totaling ${formatMoney(basket.dollar)}?`)) return;
    const subject=`${org.name} purchase order — ${vendor.name}`;
    window.location.href=`mailto:${destination}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  }

  function textBasket(vendor,basket){
    const phone=(window.prompt(`Mobile number for ${vendor.name}:`,"")||"").trim();
    if(!phone) return;
    const cleanPhone=phone.replace(/[^+\d]/g,"");
    if(!cleanPhone) return;
    const body=basketOrderMessage(vendor,basket);
    if(!window.confirm(`Open a text message for ${vendor.name} with this ${basket.items.length}-item order totaling ${formatMoney(basket.dollar)}?`)) return;
    window.location.href=`sms:${cleanPhone}?body=${encodeURIComponent(body)}`;
  }

  if(session===undefined||loading) return (
    <div style={{minHeight:"100vh",background:"#003584",display:"flex",alignItems:"center",justifyContent:"center"}}>
      <div style={{color:"white",textAlign:"center"}}>
        <div style={{fontSize:48}}>🦉</div>
        <div style={{fontWeight:900,fontSize:20,letterSpacing:"0.18em",color:"#4A90D9",marginTop:8}}>KERDOS</div>
        <div style={{marginTop:12,opacity:0.6,fontSize:13}}>Loading...</div>
      </div>
    </div>
  );
  if(!session) return <LandingGate />;
  if(!org) return <OrgGate user={session.user} onComplete={o=>{setOrg(o);loadData();}} />;

  return (
    <div style={{fontFamily:"'Inter',-apple-system,sans-serif",minHeight:"100vh",background:"#003584"}}>

      {/* HEADER */}
      <header style={{background:"#003584",color:"white",padding:"0 16px",height:52,
        display:"flex",alignItems:"center",justifyContent:"space-between",
        position:"sticky",top:0,zIndex:200,boxShadow:"0 2px 8px rgba(0,0,0,0.3)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,cursor:"pointer"}} onClick={openOrderGuide}>
          <span style={{fontSize:24}}>🦉</span>
          <div style={{fontWeight:900,fontSize:15,letterSpacing:"0.18em",color:"#4A90D9"}}>KERDOS</div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:14}}>
          {totalSpend>0&&(
            <div style={{textAlign:"right"}}>
              <div style={{fontWeight:800,fontSize:17}}>{formatMoney(totalSpend)}</div>
              {totalSpend>baselineSpend+0.01&&<div style={{fontSize:10,color:"#FF9800"}}>+{formatMoney(totalSpend-baselineSpend)} vs cheapest</div>}
            </div>
          )}
          <div style={{fontSize:11,opacity:0.6,textAlign:"right"}}>
              {organizations.length>1
                ?<select aria-label="Active organization" value={org.id} onChange={e=>switchOrganization(e.target.value)}
                  style={{maxWidth:190,fontSize:11,color:"white",background:"#00204F",border:"1px solid #4A90D9",borderRadius:4,padding:"2px 4px"}}>
                  {organizations.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}
                </select>
                :<div>{org.name}</div>}
            <button onClick={()=>{try{sessionStorage.removeItem("kerdos.activeTab");}catch{} backend.session.signOut().catch(err=>alert(err.message));}} style={{background:"none",border:"none",color:"#4A90D9",cursor:"pointer",fontSize:11,padding:0}}>Sign out</button>
          </div>
        </div>
      </header>

      {offline&&(
        <div style={{background:"#FFF3E0",color:"#8A4F00",padding:"8px 16px",fontSize:12,fontWeight:600,display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}>
          <span>Working offline — showing your workspace as of {formatDate(offline.since)}. Your basket remains saved on this device.</span>
          <button onClick={()=>loadData()} style={{...btn("#8A4F00","white",{fontSize:11,padding:"5px 10px"})}}>Retry</button>
        </div>
      )}

      {/* TABS */}
      <div style={{background:"white",display:"flex",borderBottom:"1px solid #EEE",position:"sticky",top:52,zIndex:100}}>
        {[["order","📋 Order Guide"],
          ["catalog",`🗂️ Item Catalog${needsAttentionCount>0?` (${needsAttentionCount})`:""}`],
          ["priceSheets","📊 Price Sheets"],
          ["invoices",`📁 Invoices${invoiceReviewCount>0?` (${invoiceReviewCount})`:""}`],
          ...(org.role==="owner"||org.role==="manager"?[["team","👥 Admin"]]:[])].map(([id,label])=>(
          <button key={id} onClick={()=>id==="order"?openOrderGuide():setTab(id)}
            style={{flex:1,padding:"12px 4px",border:"none",background:"none",cursor:"pointer",
              fontSize:12,fontWeight:600,
              color:tab===id?"#003584":"#888",
              borderBottom:tab===id?"2px solid #003584":"2px solid transparent"}}>
            {label}
          </button>
        ))}
      </div>

      <div style={{maxWidth:1400,margin:"0 auto",padding:"12px 18px 80px"}}>

        {/* HOME TAB */}
        {/* ORDER TAB */}
        {tab==="order"&&(
          <div className="order-layout">
            <style>{`
              .order-layout { display:flex; gap:18px; align-items:flex-start; max-width:1320px; margin:0 auto; }
              .order-aside { width:330px; flex-shrink:0; position:sticky; top:104px; align-self:flex-start; max-height:calc(100vh - 112px); overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable; }
              .order-aside-inner { position:static; }
              .order-column-head { font-size:9px; font-weight:800; color:#718096; letter-spacing:.06em; text-transform:uppercase; }
              .order-price-grid { display:grid; grid-template-columns:minmax(0,1fr) minmax(0,1fr); gap:6px; }
              .order-price-card { min-width:0; border-radius:8px; padding:6px 8px; background:white; text-align:left; }
              @media (max-width:720px) {
                .order-layout { flex-direction:column; }
                .order-aside { width:100%; position:static; max-height:none; overflow:visible; }
                .order-aside-inner { position:static; }
                .order-price-grid { grid-template-columns:1fr; }
              }
            `}</style>
            <main style={{flex:1,minWidth:0}}>
              <div style={{color:"white",fontSize:13,fontWeight:700,marginBottom:10}}>Order Guide · All vendors · {readyOrderCount} ready item{readyOrderCount===1?"":"s"}</div>
              {vendors.length>0&&(
                <div style={{marginBottom:14}}>
                  <div style={{fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.65)",letterSpacing:"0.06em",textTransform:"uppercase",marginBottom:8}}>Your Vendors — tap for details</div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>
                    {vendors.map(v=>{
                      const vc=vendorColors.get(v.id)||PALETTE[0];
                      return (
                        <button key={v.id} onClick={()=>{setVendorDetailId(v.id);setTab("vendorDetail");}}
                          style={{fontSize:12,fontWeight:700,padding:"6px 12px",borderRadius:20,background:vc.bg,color:vc.accent,border:"none",cursor:"pointer"}}>
                          {v.name}
                        </button>
                      );
                    })}
                  </div>
                </div>
              )}
              <input value={search} onChange={e=>setSearch(e.target.value)}
                placeholder={`🔍 Search ${productList.length} items by name, vendor wording, or code...`}
                style={{...inp,marginBottom:10}} />

              {orderCategoryList.length>0&&(
                <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:10}}>
                  <button onClick={()=>setOrderCategoryFilter("")} style={chipStyle(!orderCategoryFilter)}>
                    Full List
                  </button>
                  {orderCategoryList.map(c=>{
                    const isSelected=orderCategoryFilter===c;
                    return (
                      <button key={c} onClick={()=>setOrderCategoryFilter(isSelected?"":c)} style={chipStyle(isSelected)}>
                        {c}
                      </button>
                    );
                  })}
                </div>
              )}

              {orderCategoryList.length>0&&(
                <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:14}}>
                  <span style={{fontSize:10,fontWeight:700,color:"rgba(255,255,255,0.65)",textTransform:"uppercase",letterSpacing:"0.05em"}}>Sort:</span>
                  {[["alpha","A–Z"],["added","Date Added"],["itemNumber","Item #"],["vendorCode","Vendor Code"]].map(([id,label])=>{
                    const isSelected=orderSortMode===id;
                    return (
                      <button key={id} onClick={()=>setOrderSortMode(id)} style={chipStyle(isSelected,"sm")}>
                        {label}
                      </button>
                    );
                  })}
                </div>
              )}

              {productList.length===0&&(
                <div style={{background:"white",borderRadius:10,padding:32,textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.08)"}}>
                  <div style={{fontSize:32,marginBottom:8}}>📋</div>
                  <h3 style={{margin:"0 0 8px"}}>No items yet</h3>
                  <p style={{color:"#888",fontSize:14,margin:"0 0 16px"}}>Import a vendor price list to get started</p>
                  <button onClick={()=>setTab("priceSheets")} style={{...btn("#003584")}}>Import Price Sheet</button>
                </div>
              )}

              {productList.length>0&&filtered.length===0&&(
                <div style={{background:"white",borderRadius:10,padding:24,color:"#24436B",marginBottom:12}}>
                  <b>{search||orderCategoryFilter?"No ready items match this filter":"Your Order Guide has no ready items yet"}</b>
                  <p style={{margin:"8px 0",fontSize:13}}>{search||orderCategoryFilter?"Clear the search or choose Full List to see all ready items.":"Imported invoice items and vendor listings appear in Item Catalog first. Confirm the product, pack, association and quoted price there; ready items from every vendor then appear here together."}</p>
                  {search||orderCategoryFilter?<button onClick={()=>{setSearch("");setOrderCategoryFilter("");}} style={btn("#003584")}>Show Full List</button>:<button onClick={()=>setTab("catalog")} style={btn("#003584")}>Open Item Catalog</button>}
                </div>
              )}

              {["owner","manager"].includes(org.role)&&<AssociateAlternatives orgId={org.id} selectedVendorIds={productList.filter(i=>alternativeSelections.has(i.catalogItemId)).flatMap(i=>i.options.map(o=>o.vendorItemId))} vendorItems={vendorItems} catalogItems={catalogItems} mappings={mappings} vendors={vendors} onUpdated={()=>loadData()} onClear={()=>setAlternativeSelections(new Set())}/>}
              {filtered.map(group=>(
                <div key={group.category} style={{marginBottom:8}}>
                  <div style={{fontSize:11,fontWeight:800,color:"rgba(255,255,255,0.75)",letterSpacing:"0.08em",textTransform:"uppercase",margin:"14px 0 6px"}}>{group.category}</div>
                  <div style={{background:"white",borderRadius:8}}>
                    <div style={{display:"grid",gridTemplateColumns:"minmax(220px,1fr) 88px 104px minmax(370px,420px)",columnGap:10,rowGap:2,alignItems:"center",padding:"8px 12px"}}>
                      <div className="order-column-head" style={{padding:"2px 2px 7px"}}>Item</div>
                      <div className="order-column-head" style={{padding:"2px 6px 7px"}}>Unit</div>
                      <div className="order-column-head" style={{padding:"2px 6px 7px",textAlign:"center"}}>Qty</div>
                      <div className="order-column-head" style={{padding:"2px 6px 7px"}}>Price comparison</div>
                      {group.items.flatMap(item=>{
                        const caseKey=`${item.catalogItemId}_case`;
                        const eachKey=`${item.catalogItemId}_each`;
                        const caseQty=quantities[caseKey]||0;
                        const eachQty=quantities[eachKey]||0;
                        const hasEach=item.options.some(o=>o.eachPrice);
                        // allLinkedVendorIds is the full set saved to the product object before
                        // the orderable filter runs, so held vendors are counted correctly.
                        const totalLinkedVendors=item.allLinkedVendorIds?.length??new Set(item.options.map(o=>o.vendorId)).size;
                        const readyVendorCount=new Set(item.options.map(o=>o.vendorId)).size; // options already filtered to orderable in filtered useMemo
                        const cheapest=item.options[0];
                        const selectedUnit=hasEach?(unitSelection[item.catalogItemId]||"case"):"case";
                        const activeKey=selectedUnit==="case"?caseKey:eachKey;
                        const activeQty=selectedUnit==="case"?caseQty:eachQty;
                        const activePackSize=selectedUnit==="case"?cheapest?.packSize:cheapest?.eachSize;
                        const cartItemIdForActive=selectedUnit==="case"?item.catalogItemId:item.catalogItemId+"_each";
                        const assignment=assignMap.get(cartItemIdForActive);
                        const negotiation=negotiatedPrices[activeKey];
                        const unitOptions=rankVendorOffers(selectedUnit==="case"?item.options:item.options.filter(o=>o.eachPrice),negotiation,selectedUnit);
                        const rankedOptions=unitOptions.filter(orderable);
                        const displayOption=assignment
                          ?unitOptions.find(opt=>opt.vendorItemId===assignment.vendorItemId)
                          :rankedOptions.find(o=>o.vendorItemId===vendorOverride[activeKey]||o.vendorId===vendorOverride[activeKey])||rankedOptions.find(o=>item.preferredBrand&&brandsMatch(o.brand,item.preferredBrand))||rankedOptions[0];
                        const activePrice=assignment?assignment.price:displayOption?.unitPrice;
                        const activeVendorName=assignment?assignment.assignedVendorName:displayOption?.vendorName;
                        const activeVendorId=assignment?.assignedVendorId||displayOption?.vendorId;
                        const vc=vendorColors.get(activeVendorId)||PALETTE[0];
                        const customPriceIsWinner=Number.isFinite(negotiation?.[activeVendorId]);
                        const negotiationVendorId=negotiatedVendorDrafts[activeKey]||activeVendorId||rankedOptions[0]?.vendorId||"";
                        const customPriceValue=negotiation?.[negotiationVendorId];
                        const menuOpen=openPriceMenu===activeKey;
                        const activeBlocked=assignment?assignment.unorderable:!displayOption;
                        const activeBlockReason=activeBlocked?(displayOption?blockReason(displayOption):"No price on file"):null;
                        const activeOption=item.options.find(o=>o.vendorItemId===displayOption?.vendorItemId)||cheapest;
                        const activeMatchTrack=activeOption?.matchTrack;
                        const activeMatchConfidence=activeOption?.matchConfidence;

                        const alternativesMenu=menuOpen&&<div role="listbox" aria-label={`Alternatives for ${item.name}`} style={{position:"absolute",top:"100%",right:0,zIndex:30,width:"min(520px, calc(100vw - 32px))",maxHeight:280,overflowY:"auto",background:"white",border:"1px solid #CBD5E1",padding:4}}>
                          <div style={{display:"grid",gridTemplateColumns:"minmax(120px,2fr) minmax(90px,1fr) 75px 85px",gap:8,padding:"5px 8px",fontSize:10,color:"#667085"}}><span>Item</span><span>Vendor</span><span>Price</span><span>Difference ($)</span></div>
                          {rankedOptions.filter(opt=>opt.vendorItemId!==displayOption?.vendorItemId).map(opt=><button key={opt.vendorItemId} role="option" aria-selected={false} onClick={()=>{setVendorOverride(prev=>({...prev,[activeKey]:opt.vendorItemId}));setOpenPriceMenu(null);}}
                            style={{width:"100%",display:"grid",gridTemplateColumns:"minmax(120px,2fr) minmax(90px,1fr) 75px 85px",gap:8,padding:"7px 8px",background:"white",border:0,borderTop:"1px solid #EEE",fontSize:12,fontWeight:400,textAlign:"left",cursor:"pointer"}}>
                            <span title={opt.description} style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{opt.description}</span>
                            <span style={{overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{opt.vendorName}</span>
                            <span style={{textAlign:"right"}}>{formatMoney(opt.unitPrice)}</span>
                            <span title={opt.comparisonUnit?"Dollar difference for the same quantity as the lowest-cost purchasing pack":"Dollar difference from the lowest eligible price"} style={{textAlign:"right"}}>{offerDollarDifference(opt,rankedOptions[0])>0?"+":""}{formatMoney(offerDollarDifference(opt,rankedOptions[0]))}</span>
                          </button>)}
                        </div>;
                        const cells=[
                          <div key={item.catalogItemId+"_name"} draggable={!activeBlocked}
                            onDragStart={event=>{event.dataTransfer.effectAllowed="copy";event.dataTransfer.setData("text/plain",activeKey);setDragItem({catalogItemId:item.catalogItemId,key:activeKey,name:item.name});}}
                            onDragEnd={()=>{setDragItem(null);setDropTarget(null);}}
                            title={activeBlocked?undefined:"Drag onto a vendor basket to order from that vendor"}
                            style={{minWidth:0,padding:"8px 8px 8px 2px",borderTop:"1px solid #F2F2F2",cursor:activeBlocked?"default":"grab",opacity:dragItem?.key===activeKey?0.5:1}}>
                            <div style={{fontWeight:600,fontSize:12.5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                              {["owner","manager"].includes(org.role)&&<input type="checkbox" aria-label={`Select ${item.name} for alternatives`} checked={alternativeSelections.has(item.catalogItemId)} onChange={()=>setAlternativeSelections(prev=>{const next=new Set(prev);if(next.has(item.catalogItemId))next.delete(item.catalogItemId);else next.add(item.catalogItemId);return next;})} style={{marginRight:6}}/>}
                              {item.name}
                              {hasEach&&<span title="Available by case or by each" style={{marginLeft:5,fontSize:9,background:"#E0F2F1",color:"#00695C",padding:"2px 5px",borderRadius:4,fontWeight:800}}>CASE + EACH</span>}
                              {totalLinkedVendors>1&&(()=>{
                                const heldCount=totalLinkedVendors-readyVendorCount;
                                const label=heldCount>0
                                  ?`${totalLinkedVendors} vendors linked · ${readyVendorCount} ready`
                                  :`${totalLinkedVendors} vendors`;
                                const tip=heldCount>0
                                  ?`${totalLinkedVendors} vendors carry this item; ${readyVendorCount} have a current eligible price. ${heldCount} held (expired, unverified, or unavailable). Click to compare ready vendors.`
                                  :`${totalLinkedVendors} vendors carry this item. Click to compare prices.`;
                                return <button
                                  type="button"
                                  aria-label={tip}
                                  title={tip}
                                  aria-expanded={menuOpen}
                                  aria-haspopup="listbox"
                                  onClick={e=>{e.stopPropagation();setOpenPriceMenu(prev=>prev===activeKey?null:activeKey);}}
                                  style={{marginLeft:5,fontSize:9,background:heldCount>0?"#FFF8E1":"#E8F1FF",color:heldCount>0?"#B26A00":"#1565C0",padding:"2px 5px",borderRadius:4,fontWeight:800,border:`1px solid ${heldCount>0?"#FFE082":"#BBDEFB"}`,cursor:"pointer",lineHeight:1.4,verticalAlign:"middle"}}>
                                  {label}
                                </button>;
                              })()}
                              {item.lockedBrand&&<span title={`Locked to ${item.lockedBrand} - other brands are never ordered for this item`} style={{marginLeft:4,fontSize:9,background:"#E3F2FD",color:"#1565C0",padding:"1px 4px",borderRadius:4,fontWeight:700}}>🔒 {item.lockedBrand}</span>}
                              {["similar","review"].includes(activeMatchTrack)&&(
                                <span title="Auto-matched to this product below full confidence - worth double-checking it's really the same item"
                                  style={{marginLeft:4,fontSize:9,background:"#FFF3E0",color:"#B26A00",padding:"1px 4px",borderRadius:4,fontWeight:700}}>
                                  🔍 {activeMatchConfidence}%
                                </span>
                              )}
                            </div>
                            <div style={{fontSize:10,color:"#AAA"}}>
                              {activePackSize||""}
                              {!activeBlocked&&activeOption?.perUnit&&<span style={{marginLeft:6,color:"#666",fontWeight:600}}>{formatMoney(activeOption.perUnit.price)}/{activeOption.perUnit.unit}</span>}
                            </div>
                          </div>,
                          <div key={item.catalogItemId+"_unit"} style={{padding:"8px 6px",borderTop:"1px solid #F2F2F2",borderLeft:"1px solid #EEE",background:hasEach?"#E0F2F1":"#FAFBFC"}}>
                            <select aria-label={`Order unit for ${item.name}`} value={selectedUnit} onChange={e=>setUnitSelection(prev=>({...prev,[item.catalogItemId]:e.target.value}))}
                              style={{width:"100%",fontSize:11,padding:"4px 2px",borderRadius:6,border:hasEach?"2px solid #008577":"1px solid #DDD",background:"white",color:hasEach?"#00695C":"#444",fontWeight:hasEach?800:400}}>
                              <option value="case">Case</option>
                              <option value="each" disabled={!hasEach}>Each {!hasEach?"(unavailable)":""}</option>
                            </select>
                          </div>,
                          <div key={item.catalogItemId+"_qty"} style={{display:"flex",alignItems:"center",justifyContent:"center",gap:4,padding:"8px 6px",borderTop:"1px solid #F2F2F2",borderLeft:"1px solid #EEE",background:"#F5F8FF"}}>
                            <button onClick={()=>setQty(activeKey,activeQty-1)}
                              style={{width:26,height:26,borderRadius:7,border:"1px solid #FFCDD2",background:"#FFEBEE",cursor:"pointer",fontSize:15,fontWeight:800,color:"#D32F2F",flexShrink:0}}>−</button>
                            <span style={{width:18,textAlign:"center",fontWeight:800,fontSize:13,color:activeQty>0?vc.accent:"#CCC"}}>{activeQty||"·"}</span>
                            <button onClick={()=>{if(!activeBlocked) setQty(activeKey,activeQty+1);}} disabled={activeBlocked}
                              title={activeBlocked?activeBlockReason:undefined}
                              style={{width:26,height:26,borderRadius:7,border:"none",background:activeBlocked?"#DDD":"#2E7D32",cursor:activeBlocked?"not-allowed":"pointer",fontSize:15,fontWeight:800,color:"white",flexShrink:0}}>+</button>
                          </div>,
                          <div key={item.catalogItemId+"_price"} style={{padding:"6px",borderTop:"1px solid #F2F2F2",borderLeft:"1px solid #EEE",background:"#FAFBFC"}}>
                            <div className="order-price-grid">
                              <div className="order-price-card" data-price-menu style={{border:"1px solid #CBD5E1",position:"relative"}}>
                              <div style={{fontSize:10,color:"#667085",marginBottom:4}}>Vendor price · Power Ranked</div>
                              <button onClick={()=>setOpenPriceMenu(menuOpen?null:activeKey)} aria-label={`Power Ranked alternatives for ${item.name}`} aria-haspopup="listbox" aria-expanded={menuOpen} title="Power Ranked alternatives" style={{width:"100%",textAlign:"left",padding:"7px 9px",border:"1px solid #CBD5E1",borderRadius:6,background:"white",cursor:"pointer",fontSize:12,fontWeight:400}}>
                                {activeBlocked?activeBlockReason:`${activeVendorName} · ${formatMoney(activePrice)}${customPriceIsWinner?" negotiated":""}`} <span style={{float:"right"}}>{menuOpen?"▴":"▾"}</span>
                              </button>
                              {vendorOverride[activeKey]&&<button onClick={()=>setVendorOverride(prev=>{const next={...prev};delete next[activeKey];return next;})} style={{fontSize:10,background:"none",border:0,padding:"4px 0 0",cursor:"pointer"}}>Use lowest price</button>}
                              {alternativesMenu}
                              </div>
                              <div className="order-price-card" title="Price agreed with the vendor you select" style={{border:"1px solid #E3E7ED",background:"white"}}>
                                <div style={{fontSize:10,fontWeight:400,color:"#667085",marginBottom:4}}>Negotiated price</div>
                                <select aria-label={`Negotiated vendor for ${item.name}`} value={negotiationVendorId} onChange={e=>{setNegotiatedVendorDrafts(prev=>({...prev,[activeKey]:e.target.value}));setCustomPriceDrafts(prev=>{const next={...prev};delete next[activeKey];return next;});setNegotiationErrors(prev=>{const next={...prev};delete next[activeKey];return next;});}}
                                  style={{width:"100%",fontSize:10,border:"1px solid #CBD5E1",borderRadius:5,padding:"3px",marginBottom:4,background:"white"}}>
                                  {!rankedOptions.length&&<option value="">No eligible vendor</option>}
                                  {rankedOptions.map(opt=><option key={opt.vendorItemId} value={opt.vendorId}>{opt.vendorName}</option>)}
                                </select>
                                <div style={{display:"flex",gap:4,alignItems:"center"}}>
                                  <input type="number" min="0" step="0.01" aria-label={`Negotiated price for ${item.name}`}
                                    value={customPriceDrafts[activeKey]??String(customPriceValue??"")}
                                    onChange={e=>{setCustomPriceDrafts(prev=>({...prev,[activeKey]:e.target.value}));setNegotiationErrors(prev=>{const next={...prev};delete next[activeKey];return next;});}}
                                    onKeyDown={e=>{if(e.key==="Enter")e.currentTarget.nextElementSibling?.click();}}
                                    placeholder="0.00" style={{width:"100%",minWidth:0,border:"1px solid #CBD5E1",borderRadius:5,padding:"4px",fontSize:11}} />
                                  <button onClick={()=>{
                                    const raw=customPriceDrafts[activeKey];const value=Number(raw);
                                    if(raw==null||raw===""||!Number.isFinite(value)||value<=0||!negotiationVendorId||!rankedOptions.some(opt=>opt.vendorId===negotiationVendorId)){
                                      setNegotiationErrors(prev=>({...prev,[activeKey]:"Choose an available vendor and enter a price above $0."}));return;
                                    }
                                    setNegotiatedPrices(prev=>({...prev,[activeKey]:{...prev[activeKey],[negotiationVendorId]:value}}));
                                    setVendorOverride(prev=>{const next={...prev};delete next[activeKey];return next;});
                                  }} style={{...btn("#003584","white",{padding:"5px 7px",fontSize:10})}}>Apply</button>
                                </div>
                                {negotiationErrors[activeKey]&&<div role="alert" style={{color:"#B42318",fontSize:10,marginTop:4}}>{negotiationErrors[activeKey]}</div>}
                                {Number.isFinite(customPriceValue)&&<div style={{fontSize:9,color:"#24744B",marginTop:3,fontWeight:700}}>Agreed price for {unitOptions.find(o=>o.vendorId===negotiationVendorId)?.vendorName||"selected vendor"}</div>}
                                {Number.isFinite(customPriceValue)&&<button onClick={()=>{
                                  setNegotiatedPrices(prev=>{const next={...prev},perVendor={...next[activeKey]};delete perVendor[negotiationVendorId];if(Object.keys(perVendor).length)next[activeKey]=perVendor;else delete next[activeKey];return next;});
                                  setNegotiatedVendorDrafts(prev=>{const next={...prev};delete next[activeKey];return next;});
                                  setCustomPriceDrafts(prev=>{const next={...prev};delete next[activeKey];return next;});
                                }} style={{border:0,background:"none",padding:"3px 0 0",fontSize:9,color:"#2563EB",cursor:"pointer"}}>↺ Remove this vendor's negotiated price</button>}
                              {activeQty>1&&rankedOptions.some(opt=>opt.vendorId!==activeVendorId)&&(
                                <details open={!!splitOrders[activeKey]?.vendorId} style={{marginTop:6,fontSize:11,color:"#475569"}}>
                                  <summary style={{cursor:"pointer"}}>Split order</summary>
                                  <div style={{display:"flex",alignItems:"center",gap:6}}>
                                    <select aria-label={`Split vendor for ${item.name}`} value={splitOrders[activeKey]?.vendorId||""}
                                      onChange={e=>setSplitOrders(prev=>({...prev,[activeKey]:{vendorId:e.target.value,quantity:prev[activeKey]?.quantity||1}}))}
                                      style={{...inp,flex:1,minWidth:0,fontSize:11,padding:"5px"}}>
                                      <option value="">No split</option>
                                      {rankedOptions.filter(opt=>opt.vendorId!==activeVendorId).map(opt=><option key={opt.vendorItemId} value={opt.vendorId}>{opt.vendorName} · {formatMoney(opt.unitPrice)}</option>)}
                                    </select>
                                    <input aria-label={`Split quantity for ${item.name}`} type="number" min="1" max={activeQty-1} value={splitOrders[activeKey]?.quantity||1}
                                      onChange={e=>setSplitOrders(prev=>({...prev,[activeKey]:{vendorId:prev[activeKey]?.vendorId||"",quantity:e.target.value}}))}
                                      style={{...inp,width:55,padding:"5px",fontSize:11}} />
                                    <span>of {activeQty}</span>
                                  </div>
                                  {splitOrders[activeKey]?.vendorId&&<button onClick={()=>setSplitOrders(prev=>{const next={...prev};delete next[activeKey];return next;})}
                                    style={{border:0,background:"none",color:"#2563EB",padding:"6px 0 0",cursor:"pointer",fontSize:10}}>Remove split</button>}
                                </details>
                              )}
                              </div>
                            </div>
                          </div>,
                        ];

                        return cells;
                      })}
                    </div>
                  </div>
                </div>
              ))}

              {purchaseOrders.length>0&&(
                <div style={{marginTop:24}}>
                  <div style={{fontSize:11,fontWeight:700,color:"rgba(255,255,255,0.7)",letterSpacing:"0.08em",textTransform:"uppercase",marginBottom:10}}>Recent Orders</div>
                  {purchaseOrders.map(po=>{
                    const isOpen=expandedOrderTabOrder===po.id;
                    const lines=po.purchase_order_lines||[];
                    const vendorName=vendors.find(v=>v.id===po.vendor_id)?.name||"Unknown vendor";
                    return (
                      <div key={po.id} style={{background:"white",borderRadius:8,marginBottom:8,boxShadow:"0 1px 3px rgba(0,0,0,0.06)",overflow:"hidden"}}>
                        <button onClick={()=>setExpandedOrderTabOrder(isOpen?null:po.id)}
                          style={{width:"100%",background:"none",border:"none",cursor:"pointer",padding:"14px 14px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <div style={{textAlign:"left"}}>
                            <div style={{fontWeight:700,fontSize:13}}>{vendorName}</div>
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
                              const vi=vendorItems.find(v=>v.id===line.vendor_item_id);
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
                </div>
              )}
            </main>

            {/* BASKETS */}
            <aside className="order-aside">
              <div className="order-aside-inner"
                onDragOver={event=>{if(dragItem){event.preventDefault();event.dataTransfer.dropEffect="copy";if(dropTarget==null)setDropTarget("auto");}}}
                onDragLeave={event=>{if(dropTarget==="auto"&&!event.currentTarget.contains(event.relatedTarget))setDropTarget(null);}}
                onDrop={event=>{event.preventDefault();event.stopPropagation();dropOnBasket(dropTarget&&dropTarget!=="auto"?dropTarget:null);}}
                style={dragItem?{outline:"2px dashed rgba(255,255,255,0.6)",outlineOffset:6,borderRadius:10}:undefined}>
                {dragItem&&(
                  <div style={{background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.35)",borderRadius:9,padding:10,marginBottom:10}}>
                    <div style={{fontSize:11,fontWeight:700,color:"white",marginBottom:6}}>Drop <b>{dragItem.name}</b> on a vendor, or anywhere here for the best price</div>
                    <div style={{display:"flex",gap:6,flexWrap:"wrap"}}>
                      {vendors.map(vendor=>{
                        const color=vendorColors.get(vendor.id)||PALETTE[0];
                        const selected=dropTarget===vendor.id;
                        return <div key={vendor.id}
                          onDragEnter={event=>{event.preventDefault();event.stopPropagation();setDropTarget(vendor.id);}}
                          onDragOver={event=>{event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect="copy";if(dropTarget!==vendor.id)setDropTarget(vendor.id);}}
                          onDrop={event=>{event.preventDefault();event.stopPropagation();dropOnBasket(vendor.id);}}
                          style={{fontSize:12,fontWeight:700,padding:"8px 14px",borderRadius:20,background:selected?"white":color.bg,color:color.accent,outline:selected?`3px solid ${color.accent}`:"none"}}>{vendor.name}</div>;
                      })}
                    </div>
                  </div>
                )}
                {dropNotice&&<div style={{background:"#FFF3E0",color:"#8A4F00",borderRadius:9,padding:"8px 12px",marginBottom:10,fontSize:12,fontWeight:600}}>{dropNotice}</div>}
                {blockedCartItems.length>0&&<div style={{background:"#FFF3E0",color:"#8A4F00",borderRadius:9,padding:12,marginBottom:10,fontSize:12}}>
                  <b>{blockedCartItems.length} item(s) need attention — not in vendor baskets.</b>
                  {blockedCartItems.map(a=><div key={a.catalogItemId} style={{marginTop:5}}>{a.quantity} × {a.name}: confirm a current eligible vendor quote or remove from order.</div>)}
                </div>}
                <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:10}}>
                  <div style={{fontSize:11,fontWeight:800,color:"rgba(255,255,255,0.7)",letterSpacing:"0.08em",textTransform:"uppercase"}}>Order Baskets</div>
                  {baskets.length>0&&(
                    <button onClick={clearBasket}
                      style={{background:"rgba(255,255,255,0.12)",border:"1px solid rgba(255,255,255,0.35)",color:"white",borderRadius:6,padding:"5px 8px",fontSize:10,fontWeight:700,cursor:"pointer"}}>
                      Clear All
                    </button>
                  )}
                </div>

                {baskets.length===0&&(
                  <div style={{background:"white",borderRadius:10,padding:"24px 16px",textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.08)"}}>
                    <div style={{fontSize:28,marginBottom:8}}>🧺</div>
                    <p style={{color:"#888",fontSize:13,margin:0}}>Add items to start a basket</p>
                  </div>
                )}

                {baskets.length>0&&(<>
                  {vendors.map(vendor=>{
                    const basket=baskets.find(b=>b.vendorId===vendor.id);
                    if(!basket) return null;
                    const vc=vendorColors.get(vendor.id)||PALETTE[0];
                    const meetsDollar=!vendor.delivery_minimum_dollar||basket.dollar>=vendor.delivery_minimum_dollar;
                    const meetsUnits=!vendor.delivery_minimum_units||basket.units>=vendor.delivery_minimum_units;
                    const meetsAll=meetsDollar&&meetsUnits;
                    return (
                      <div key={vendor.id}
                        onDragEnter={event=>{if(dragItem){event.preventDefault();event.stopPropagation();setDropTarget(vendor.id);}}}
                        onDragOver={event=>{if(dragItem){event.preventDefault();event.stopPropagation();event.dataTransfer.dropEffect="copy";if(dropTarget!==vendor.id)setDropTarget(vendor.id);}}}
                        onDrop={event=>{event.preventDefault();event.stopPropagation();dropOnBasket(vendor.id);}}
                        style={{background:"white",borderRadius:10,marginBottom:10,
                        border:`2px solid ${dropTarget===vendor.id?"#1565C0":meetsAll?vc.accent:"#FFB74D"}`,overflow:"hidden",
                        boxShadow:dropTarget===vendor.id?"0 0 0 4px rgba(21,101,192,0.25)":"none"}}>
                        <div style={{background:meetsAll?vc.bg:"#FFF8E1",padding:"9px 12px",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <div>
                            <div style={{fontWeight:800,fontSize:13,color:vc.accent}}>{vendor.name}</div>
                            <div style={{fontSize:10,color:"#999"}}>{basket.units} items</div>
                          </div>
                          <div style={{textAlign:"right"}}>
                            <div style={{fontWeight:800,fontSize:15}}>{formatMoney(basket.dollar)}</div>
                            {meetsAll&&<div style={{fontSize:9,color:vc.accent,fontWeight:700}}>✓ READY</div>}
                          </div>
                        </div>
                        {vendor.delivery_minimum_dollar&&(
                          <div style={{padding:"6px 12px 0"}}>
                            <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#AAA",marginBottom:2}}>
                              <span>Min {formatMoney(vendor.delivery_minimum_dollar)}</span>
                              <span style={{color:meetsDollar?vc.accent:"#FF9800",fontWeight:600}}>
                                {meetsDollar?"✓":`${formatMoney(vendor.delivery_minimum_dollar-basket.dollar)} to go`}
                              </span>
                            </div>
                            <div style={{height:3,background:"#EEE",borderRadius:2}}>
                              <div style={{height:"100%",borderRadius:2,transition:"width 0.3s",
                                background:meetsDollar?vc.accent:"#FF9800",
                                width:`${Math.min(100,(basket.dollar/vendor.delivery_minimum_dollar)*100)}%`}} />
                            </div>
                          </div>
                        )}
                        {vendor.delivery_minimum_units&&(
                          <div style={{padding:"6px 12px 8px"}}>
                            <div style={{display:"flex",justifyContent:"space-between",fontSize:9,color:"#AAA",marginBottom:2}}>
                              <span>Min {vendor.delivery_minimum_units} units</span>
                              <span style={{color:meetsUnits?vc.accent:"#FF9800",fontWeight:600}}>
                                {meetsUnits?"✓":`${vendor.delivery_minimum_units-basket.units} unit${vendor.delivery_minimum_units-basket.units===1?"":"s"} to go`}
                              </span>
                            </div>
                            <div style={{height:3,background:"#EEE",borderRadius:2}}>
                              <div style={{height:"100%",borderRadius:2,transition:"width 0.3s",
                                background:meetsUnits?vc.accent:"#FF9800",
                                width:`${Math.min(100,(basket.units/vendor.delivery_minimum_units)*100)}%`}} />
                            </div>
                          </div>
                        )}
                        <div style={{padding:"4px 12px 8px"}}>
                          {basket.items.map(item=>(
                            <div key={item.catalogItemId} style={{display:"flex",justifyContent:"space-between",padding:"2px 0",fontSize:11,borderBottom:"1px solid #F8F8F8"}}>
                              <span style={{color:"#444",minWidth:0,flex:1}}>{item.name}<span style={{display:"block",fontSize:10,color:"#667085"}}>{item.quantity} {item.orderUnit==="each"?"each":"case"}{item.quantity===1?"":"s"} × {formatMoney(item.price)}</span></span>
                              <span style={{fontWeight:700,flexShrink:0,marginLeft:6,color:item.premiumPaid>0.005?"#FF9800":"#333"}}>{formatMoney(item.lineTotal)}</span>
                            </div>
                          ))}
                        </div>
                        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:6,padding:"0 12px 10px"}}>
                          <button onClick={()=>emailBasket(vendor,basket)}
                            style={{border:"1px solid #D7E0EA",background:"#F7FAFD",color:"#24445F",borderRadius:6,padding:"6px 7px",fontSize:10,fontWeight:800,cursor:"pointer"}}>
                            ✉️ Email Order
                          </button>
                          <button onClick={()=>textBasket(vendor,basket)}
                            style={{border:"1px solid #D7E0EA",background:"#F7FAFD",color:"#24445F",borderRadius:6,padding:"6px 7px",fontSize:10,fontWeight:800,cursor:"pointer"}}>
                            💬 Text Order
                          </button>
                        </div>
                        {vendor.email&&(
                          <div style={{fontSize:9,color:"#999",padding:"0 12px 9px",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>Email: {vendor.email}</div>
                        )}
                      </div>
                    );
                  })}

                  <div style={{background:"#003584",borderRadius:10,padding:"14px 16px",color:"white"}}>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                      <span style={{fontSize:11,opacity:0.6}}>Total units</span>
                      <span style={{fontWeight:600}}>{totalUnits}</span>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:4}}>
                      <span style={{fontSize:11,opacity:0.6}}>Cheapest possible</span>
                      <span style={{fontWeight:600}}>{formatMoney(baselineSpend)}</span>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
                      <span style={{fontSize:11,opacity:0.6}}>Optimized total</span>
                      <span style={{fontWeight:800,fontSize:16,color:totalSpend>baselineSpend+0.01?"#FF9800":"#69F0AE"}}>{formatMoney(totalSpend)}</span>
                    </div>
                    <button onClick={submitOrders} disabled={blockedCartItems.length>0}
                      title={blockedCartItems.length?"Resolve the items needing a price first":undefined}
                      style={{...btn(blockedCartItems.length?"#777":"#4A90D9"),width:"100%"}}>
                      Record {baskets.length} Order{baskets.length>1?"s":""} (not sent)
                    </button>
                  </div>
                </>)}
              </div>
            </aside>
          </div>
        )}

        {/* DOCUMENT PAGES — kept outside App.jsx so each workflow has one clear home */}
        {tab==="invoices"&&(
          <InvoicesPage
            vendors={vendors} invoices={invoices} vendorFilter={recordsVendorFilter} setVendorFilter={setRecordsVendorFilter}
            vendorColors={vendorColors} formatDate={formatDate} formatMoney={formatMoney}
            attentionCount={flaggedInvoiceLines.length+invoiceDerivedItems.length} role={org.role}
            onImport={vendorId=>{setSelectedVendorId(vendorId);setImportMode("invoice");setShowPaste(true);}}
            onExport={()=>downloadTextFile(`price-variance-report-${new Date().toISOString().split("T")[0]}.csv`,buildVarianceReportCSV(invoices,vendors),"text/csv")}
            onViewOriginal={viewStoredFile} onEdit={setEditingInvoice} onDelete={deleteInvoice}
            expandedId={expandedInvoiceId} setExpandedId={setExpandedInvoiceId}
          />
        )}

        {tab==="priceSheets"&&(
          <PriceSheetsPage
            vendors={vendors} importDocuments={importDocuments}
            vendorFilter={priceSheetVendorFilter} setVendorFilter={setPriceSheetVendorFilter} vendorColors={vendorColors}
            formatDate={formatDate} role={org.role}
            onImport={vendorId=>{setSelectedVendorId(vendorId);setImportMode("pricelist");setShowPaste(true);}}
            onExpireVendor={expireVendorQuotes}
            onDelete={deletePriceSheet} onClear={clearPriceSheet}
            onViewOriginal={viewStoredFile} onViewSource={viewSourceDocument}
            expandedId={expandedPricePeriod} setExpandedId={setExpandedPricePeriod}
            hasMore={importDocumentsHasMore} loadingMore={loadingOlderDocuments} onLoadMore={loadOlderDocuments}
          />
        )}

        {/* VENDOR DETAIL TAB */}
        {tab==="vendorDetail"&&vendorDetailId&&(()=>{
          const v=vendors.find(x=>x.id===vendorDetailId);
          if(!v) return <p>Vendor not found.</p>;
          const vc=vendorColors.get(v.id)||PALETTE[0];
          return (
            <VendorDetail
              vendor={v} vc={vc} vendorItems={vendorItems} invoices={invoices} purchaseOrders={purchaseOrders} priceHistory={priceHistory}
              mappings={mappings} catalogItems={catalogItems}
              orgId={org.id} myRole={org.role}
              onViewOriginal={viewStoredFile}
              onBack={()=>setTab("order")}
              onUpdated={loadData}
              onEditInvoice={setEditingInvoice}
              onDeleteInvoice={deleteInvoice}
              onExpireOne={expireOneQuote} orgSettings={org.settings}
              hasMorePrices={priceHistoryHasMore} loadingMorePrices={loadingOlderPrices} onLoadMorePrices={loadOlderPriceHistory}
              onImport={vendorId=>{setSelectedVendorId(vendorId);setImportMode("pricelist");setShowPaste(true);}}
            />
          );
        })()}

        {/* ITEM CATALOG TAB */}
        {tab==="catalog"&&(
          <>
            {org.role!=="employee"&&unmappedCount>0&&(
              <div style={{background:"#FFF3E0",borderRadius:10,padding:16,marginBottom:14,textAlign:"center"}}>
                <div role="status" style={{fontWeight:800,color:"#E65100"}}>{backfilling?`Bringing ${unmappedCount} imported item${unmappedCount===1?"":"s"} into the catalog…`:catalogRepairError||`${unmappedCount} imported item${unmappedCount===1?"":"s"} waiting for catalog links`}</div>
              </div>
            )}

            {autoPlaceError&&org.role!=="employee"&&<div role="alert" style={{background:"#FFF3E0",padding:12,marginBottom:12,borderRadius:8}}>
              {autoPlaceError} <button disabled={autoPlacing} onClick={()=>setAutoPlaceRetry(n=>n+1)} style={btn("#003584")}>Retry</button>
            </div>}
            <ItemCatalogPanel industry={org.industry} settings={org.settings} orgId={org.id} role={org.role} productList={productList} vendors={vendors} catalogItems={catalogItems} mappings={mappings}
              vendorItems={vendorItems} categories={categories} vocabulary={vocabulary} editors={editors}
              onUpdated={loadData} />
          </>
        )}

        {/* TEAM TAB */}
        {tab==="team"&&(org.role==="owner"||org.role==="manager")&&(
          <>
            <TeamPanel orgId={org.id} orgName={org.name} orgIndustry={org.industry} orgSettings={org.settings} categories={categories} myRole={org.role} currentUserId={session.user.id} currentUserEmail={session.user.email} onOrgUpdated={loadData}
              logoUrl={logoUrl} onLogoUpload={handleLogoUpload} logoUploading={logoUploading} />
            <div style={{height:28}} />
            <div style={{background:"white",borderRadius:10,padding:16,boxShadow:"0 1px 3px rgba(0,0,0,0.08)"}}>
              <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12}}>
                <h4 style={{margin:0,fontSize:14}}>Your Vendors</h4>
                <button onClick={()=>setShowAddVendor(true)} style={{...btn("#003584","white",{fontSize:12,padding:"6px 12px"})}}>+ Add Vendor</button>
              </div>
              {vendors.map(v=>{
                const vc=vendorColors.get(v.id)||PALETTE[0];
                const count=vendorItems.filter(vi=>vi.vendor_id===v.id).length;
                const invCount=invoices.filter(inv=>inv.vendor_id===v.id).length;
                return (
                  <div key={v.id} style={{padding:"10px 12px",borderRadius:8,marginBottom:6,background:vc.bg}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                      <div style={{cursor:"pointer"}} onClick={()=>{setVendorDetailId(v.id);setTab("vendorDetail");}}>
                        <div style={{fontWeight:700,color:vc.accent}}>{v.name}</div>
                        <div style={{fontSize:11,color:"#888"}}>{count} items · {invCount} invoice{invCount===1?"":"s"} · tap for full history</div>
                      </div>
                      <button onClick={()=>{setVendorDetailId(v.id);setTab("vendorDetail");}} style={{...btn("white",vc.accent,{fontSize:11,padding:"6px 10px",border:`1px solid ${vc.accent}`})}}>Open vendor</button>
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{height:28}} />
            <CatalogPanel orgId={org.id} orgIndustry={org.industry} categories={categories} catalogItems={catalogItems} vocabulary={vocabulary} onUpdated={loadData} />
          </>
        )}
      </div>

      {showPaste&&org.role!=="employee"&&<PasteModal industry={org.industry} vendors={vendors} orgId={org.id} orgSettings={org.settings} catalogItems={catalogItems} categories={categories} vocabulary={vocabulary} vendorItems={vendorItems} mappings={mappings} onClose={()=>setShowPaste(false)} onDone={loadData} onFinished={setImportNotice} initialVendorId={selectedVendorId} initialMode={importMode} />}
      {importNotice&&(
        <div role="status" onClick={()=>setImportNotice(null)} style={{position:"fixed",left:"50%",bottom:24,transform:"translateX(-50%)",background:"#1B5E20",color:"white",padding:"12px 18px",borderRadius:8,fontSize:13,fontWeight:700,boxShadow:"0 6px 20px rgba(0,0,0,0.25)",zIndex:1000,cursor:"pointer"}}>
          {importNotice.message}
        </div>
      )}
      {showAddVendor&&<AddVendorModal orgId={org.id} onClose={()=>setShowAddVendor(false)} onDone={loadData} />}
      {editingInvoice&&org.role!=="employee"&&<InvoiceEditModal invoice={editingInvoice} vendors={vendors} onClose={()=>setEditingInvoice(null)} onDone={loadData} />}
    </div>
  );
}
