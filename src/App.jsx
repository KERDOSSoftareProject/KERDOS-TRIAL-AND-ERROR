import {BrandCoinFaces} from "./ui/Brand.jsx";
import {Drachma} from "./ui/Drachma.jsx";
import {MobileDetailWindow} from './ui/MobileDetailWindow.jsx';
import {orderAmountText,orderLineAmountText} from "./core/estimated-orders.js";
import {OrderBasket,mobileOrderQuery,useLayoutQuery} from './pages/OrderBasket.jsx';
import {OrderGuideListings,useOrderGuideListingAutosave} from './pages/OrderGuideListings.jsx';
import {automaticAlternativeVerified} from "./core/alternative-groups.js";
import {productLabelLinked,productLabelOrderPath} from "./core/label-association.js";
import { useState, useEffect, useMemo, useRef } from "react";
import { backend } from "./backend/index.js";
import { createSessionController } from "./session.js";
import { createDocumentService } from "./services/documents.js";
import { autoPlaceable,orderGuideAssessment,BLOCKER_LABELS,initialsFor } from "./core/catalog-fields.js";
import {normalizeCatalogQuote} from "./core/quote-basis.js";
import {quotedUnitOrigin} from "./core/listing-provenance.js";
import {calculatedUnitCost} from "./core/quote-controls.js";
import { holdingPen } from "./services/categories.js";
import { createOrganizationService } from "./services/organization.js";
import { createVendorService } from "./services/vendors.js";
import { createCatalogService } from "./services/catalog.js";
import { createOperationsService } from "./services/operations.js";
import { loadSnapshot, saveSnapshot } from "./offline-store.js";
import { configureProcurement, getProcurementContext, priceBasisFor, parsePackSize, brandsMatch, quoteStatus, comparePurchasingPack, compareProductIdentity, casePriceFromQuote } from "./procurement.js";
import { blockReason, compareOrderOffers, orderable, priceForOffer, rankVendorOffers, solveOrder, supportsOrderUnit } from "./core/ordering.js";
import {orderGuideGroups,orderGuideCategories} from './core/order-guide-groups.js';
import {productGroupApproved} from './core/product-associations.js';
import {clientProductName} from './core/client-product-name.js';
import {sourceOnlyListings} from './core/source-only-listings.js';
import { configureLocale, formatDate, formatMoney } from "./localization.js";
import { buildComparisonReportCSV, downloadTextFile } from "./reporting.js";
import {InvoicesPage,PriceSheetsPage} from "./pages/DocumentPages.jsx";
import {LandingGate,OrgGate} from "./pages/AccessPages.jsx";
import {InvoiceEditModal,AddVendorModal} from "./pages/RecordModals.jsx";
import {TeamPanel} from "./pages/TeamPanel.jsx";
import {CatalogPanel} from "./pages/CatalogAdminPanel.jsx";
import {ItemCatalogPanel} from "./pages/ItemCatalogPanel.jsx";
import {PasteModal} from "./pages/ImportModal.jsx";
import {VendorDetail} from "./pages/VendorDetail.jsx";
import {EmailInboxPanel} from "./pages/EmailInboxPanel.jsx";
import WelcomeScreen,{userInitials} from "./pages/WelcomeScreen.jsx";
import TabHeading from "./ui/TabHeading.jsx";
import {pageName} from "./ui/workspace-pages.js";
import VendorConnectPage from "./pages/VendorConnectPage.jsx";
import {settleScheduledImport} from "./services/scheduled-refresh-result.js";
import {listMessages} from "./services/email-routing.js";
import {PALETTE,btn,fieldHighlight,inp} from "./ui/styles.js";

const documents=createDocumentService(backend);
const organizationService=createOrganizationService(backend);
const vendorService=createVendorService(backend);
const operationsService=createOperationsService(backend);
const catalogService=createCatalogService(backend);
const sessionController=createSessionController(backend.session);
const regularsDefaultMinimum=5;


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
    try { return sessionStorage.getItem("kerdos.activeTab.v2") || "home"; }
    catch { return "home"; }
  });
  const [accountMenuOpen,setAccountMenuOpen]=useState(false);
  const [inboxAttentionCount,setInboxAttentionCount]=useState(0);
  const [showPaste,setShowPaste]=useState(false);
  const [companionImport,setCompanionImport]=useState(null);
  useEffect(()=>{setCompanionImport(null);},[org?.id,org?.role]);
  // One plain line after an import finishes on its own; it clears itself.
  const [importNotice,setImportNotice]=useState(null);
  const [companionResult,setCompanionResult]=useState(null);
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
  const [openPriceMenu,setOpenPriceMenu]=useState(null);
  const [activeOrderItem,setActiveOrderItem]=useState(null);
  const [orderGuideView,setOrderGuideView]=useState(null);
  const [regularItems,setRegularItems]=useState(null);
  const orderItemClickedAt=useRef(0);
  const orderBrowseControlsRef=useRef(null);
  const listingEdits=useOrderGuideListingAutosave({backend,organizationId:org?.id,userId:session?.user?.id,editorKey:tab==="order"?openPriceMenu:null,
    canManage:['owner','manager'].includes(org?.role),vendorItems,mappings,onSaved:async (vendorItem,mapping,patch)=>{
      // A legacy device-only price must not conceal a freshly saved quote.
      if(['price','pack_size','selling_unit'].some(field=>Object.hasOwn(patch,field)))setNegotiatedPrices(previous=>{
        const next={...previous};
        for(const unit of ['case','each']){
          const key=`${mapping.catalog_item_id}_${unit}`;
          if(!next[key])continue;
          const prices={...next[key]};delete prices[vendorItem.vendor_id];
          if(Object.keys(prices).length)next[key]=prices;else delete next[key];
        }
        return next;
      });
      await loadData();
    }});
  const [splitOrders,setSplitOrders]=useState({}); // {item/unit key: {vendorId, quantity}}
  useEffect(()=>{
    if(tab==="order")return;
    setOpenPriceMenu(null);
    setActiveOrderItem(null);
    setOrderGuideView(null);
    orderItemClickedAt.current=0;
  },[tab]);
  useEffect(()=>{
    if(tab!=="order")return;
    let frame=0;
    const followVisibleRow=()=>{
      frame=0;
      const rows=document.querySelectorAll('[data-order-item-name]');
      const firstRow=rows[0];
      if(!firstRow)return;
      if(window.scrollY<=1){
        setActiveOrderItem(firstRow.dataset.orderItemName);
        return;
      }
      if(Date.now()-orderItemClickedAt.current<300)return;
      const visibleTop=Math.max(0,orderBrowseControlsRef.current?.getBoundingClientRect().bottom??0);
      const target=Math.max(visibleTop,window.innerHeight*0.65);
      let closest=null,distance=Infinity;
      for(const element of rows){
        const rect=element.getBoundingClientRect();
        if(rect.bottom<=visibleTop||rect.top>=window.innerHeight)continue;
        const gap=Math.abs((rect.top+rect.bottom)/2-target);
        if(gap<distance){closest=element.dataset.orderItemName;distance=gap;}
      }
      if(closest)setActiveOrderItem(previous=>previous===closest?previous:closest);
    };
    const onScroll=()=>{if(!frame)frame=window.requestAnimationFrame(followVisibleRow);};
    window.addEventListener('scroll',onScroll,{passive:true});
    return ()=>{window.removeEventListener('scroll',onScroll);if(frame)window.cancelAnimationFrame(frame);};
  },[tab]);
  const mobileOrder=useLayoutQuery(mobileOrderQuery);
  const mobileDetails=useLayoutQuery(`${mobileOrderQuery}, (hover: none) and (pointer: coarse)`);
  useEffect(()=>{
    if(openPriceMenu==null||mobileDetails)return;
    const closeOutside=event=>{if(!(event.target instanceof Element)||!event.target.closest("[data-price-menu]"))setOpenPriceMenu(null);};
    const closeEscape=event=>{if(event.key==="Escape")setOpenPriceMenu(null);};
    document.addEventListener("pointerdown",closeOutside);
    document.addEventListener("keydown",closeEscape);
    return ()=>{document.removeEventListener("pointerdown",closeOutside);document.removeEventListener("keydown",closeEscape);};
  },[openPriceMenu,mobileDetails]);
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
  const [orderVendorFilter,setOrderVendorFilter]=useState("");
  const [orderSortMode,setOrderSortMode]=useState("alphabetical");
  const [orderGuideOpenCount,setOrderGuideOpenCount]=useState(0);
  function openOrderGuide(){
    setSearch("");
    setOrderCategoryFilter("");
    setOrderVendorFilter("");
    setOpenPriceMenu(null);
    setActiveOrderItem(null);
    setOrderGuideView(null);
    orderItemClickedAt.current=0;
    setOrderGuideOpenCount(count=>count+1);
    setTab("order");
  }

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
      if(entered) setTab("home");
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
  // sign-in starts on Welcome via sessionController.
  useEffect(()=>{
    try { sessionStorage.setItem("kerdos.activeTab.v2", tab); } catch {}
  },[tab]);

  useEffect(()=>{
    const previous=window.history.scrollRestoration;
    window.history.scrollRestoration="manual";
    return ()=>{window.history.scrollRestoration=previous;};
  },[]);
  useEffect(()=>{
    if(!loading) window.scrollTo?.({left:0,top:0,behavior:"instant"});
  },[tab,loading,orderGuideOpenCount]);

  // Inbox tracks actionable attachments; there is no read/unread state.
  useEffect(()=>{
    if(!org?.id||tab!=="home"||!["owner","manager"].includes(org.role))return;
    let active=true;
    listMessages(backend,org.id).then(messages=>{
      if(active)setInboxAttentionCount(messages.reduce((sum,message)=>sum+(message.pending_count||0),0));
    }).catch(()=>{if(active)setInboxAttentionCount(0);});
    return ()=>{active=false;};
  },[org?.id,org?.role,tab]);

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
  const regularItemsScope=session?.user?.id&&org?.id?`${session.user.id}:${org.id}`:null;
  useEffect(()=>{
    if(tab!=="order"||loading||!regularItemsScope||!backend.regularItems)return;
    let current=true;
    async function loadRegularItems(){
      try{
        const rows=await backend.regularItems.list(org.id);
        if(current)setRegularItems({scope:regularItemsScope,ids:new Set((rows||[]).map(row=>row.catalog_item_id))});
      }catch{
        if(current)setRegularItems({scope:regularItemsScope,ids:null});
      }
    }
    void loadRegularItems();
    return ()=>{current=false;};
  },[tab,loading,regularItemsScope,org?.id,loadSeq,orderGuideOpenCount]);

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
    setOrderGuideView(null);setActiveOrderItem(null);
    await loadData(organizationId);
  }

  useEffect(()=>{
    if(!org||showPaste||companionImport) return;
    return backend.realtime.subscribeToOrganization(org.id,()=>{void loadData();});
  },[org?.id,showPaste,companionImport]);

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
    const revisions=new Map(vendorItems.map(row=>[row.id,row.row_revision??0]));
    const key=JSON.stringify([org.id,autoPlaceRetry,ready.map(r=>[r.mappingId,revisions.get(r.vendorItemId)]).sort()]);
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
    const procurement=getProcurementContext();
    const products=catalogItems.filter(ci=>(!ci.merged_into_id||mappingsByCatalog.has(ci.id))&&!sourceOnlyListings((mappingsByCatalog.get(ci.id)||[]).map(m=>viMap.get(m.vendor_item_id)).filter(Boolean))).map(ci=>{
      const ciMappings=mappingsByCatalog.get(ci.id)||[];
      const lockedBrand=ci.brand_locked?(ci.locked_brand||null):null;
      const options=ciMappings.map(m=>{
        const saved=viMap.get(m.vendor_item_id);
        const v=saved?vMap.get(saved.vendor_id):null;
        if(!saved||!v) return null;
        const peers=ciMappings.filter(other=>other.id!==m.id).map(other=>viMap.get(other.vendor_item_id)).filter(Boolean);
        const vi=normalizeCatalogQuote(saved,peers,{item:ci,mapping:m,groupMappings:ciMappings,settings:org?.settings});
        // Preserve the actual quoted price even when expired. Block it from
        // ordering and comparison; never turn a historical quote into $0.
        const quote=quoteStatus(vi,org?.settings||{});
        const expired=quote==="expired";
        const invoiceOnly=quote==="invoice_only";
        const labelLinked=productLabelLinked(m);
        const clientApproved=m.match_method==="manual"&&!!vi.field_resolutions?.row_approval;
        const costOverride=clientApproved?vi.field_resolutions?.unit_cost_override?.value:null;
        const pack=vi.pack_size||(costOverride?"Client-approved purchasing pack":null);
        const assessment=orderGuideAssessment({item:ci,vendorItem:vi,mapping:m,vendor:v,category:categoriesById.get(ci.category_id),
          peers,categories,settings:org?.settings||{}});
        // A full-pack equivalent supports comparison across pack sizes.
        // An each quote keeps its original amount for purchasing.
        const unitOrigin=quotedUnitOrigin(vi);
        const quoteBasis=unitOrigin.orderingUnitOnly?null:vi.price_basis||priceBasisFor(vi.selling_unit)?.basis||null;
        const quoteUnit=quoteBasis==="measure"?(vi.selling_unit||null):null;
        const price=costOverride?Number(costOverride.packPrice):quoteBasis?casePriceFromQuote(vi.price,quoteBasis,quoteUnit,pack):null;
        const eachPack=quoteBasis==="each"?parsePackSize(pack):null;
        const basisUnconvertible=quoteBasis==="each"?!eachPack?.parsed:price==null&&quoteBasis==="measure";
        // A locked brand blocks every vendor item that is a different
        // brand - and one with no brand listed, since "unknown" cannot
        // be verified as the locked brand.
        const brandMismatch=!!lockedBrand&&!brandsMatch(vi.brand,lockedBrand);
        // Show supported arithmetic for held listings without admitting it to ranking.
        const projectedRate=vi.quoteBasisInference?.kind==="inferred";
        const knownRate=vi.quoteBasisInference?.kind!=="unresolved"&&quote==="current"&&unitOrigin.status==="confirmed";
        const displayRate=!expired&&!invoiceOnly&&(projectedRate||knownRate)?calculatedUnitCost(vi,{industry:org?.industry}):null;
        return {
          vendorId:v.id, vendorName:v.name,
          vendorItemId:vi.id, vendorItemCode:vi.vendor_item_code,vendorNvim:vi.nvim_number,
          brand:vi.brand, packSize:pack, description:vi.description,clientApproved,costOverride,automaticAlternative:automaticAlternativeVerified(vi,ci,ciMappings.map(other=>viMap.get(other.vendor_item_id)).filter(Boolean))||productGroupApproved(vi,ci,m),
          casePrice:price,
          quotedPrice:vi.price==null?null:parseFloat(vi.price), quoteBasis, quoteUnit, basisUnconvertible,
          displayRate:displayRate&&!displayRate.estimated&&displayRate.price>0?displayRate:null,
          projectedQuote:projectedRate?{note:vi.quoteBasisInference.price!=null&&!vi.quoteBasisInference.evidence.references?"Unit carried forward":"Inferred"}:null,
          eachPrice:eachPack?.parsed&&Number(vi.price)>0?Number(vi.price):null, eachSize:eachPack?.eachStr||null,
          mappingId:m.id,
          matchConfidence:m.confidence_score, matchTrack:m.comparison_track, matchMethod:m.match_method,
          labelLinked:productLabelOrderPath(ci,m,vi),labelOrderReady:labelLinked&&assessment.ready,
          expired,
          priceUnavailable:quote==="unavailable",
          invoiceOnly,
          unverified:(!labelLinked&&(m.comparison_track!=="exact"||m.confidence_score!==100))||!assessment.ready,
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
        if(option.labelLinked)continue;
        const conflicting=options.some(other=>{
          if(other.vendorItemId===option.vendorItemId)return false;
          // A provisional pack cannot invalidate the other vendors' saved comparisons.
          const savedPack=viMap.get(option.vendorItemId)?.pack_size||option.packSize;
          const otherSavedPack=viMap.get(other.vendorItemId)?.pack_size||other.packSize;
          return comparePurchasingPack(savedPack,otherSavedPack).status!=="same" ||
            compareProductIdentity(option.description,other.description).status!=="same" ||
            // Brand difference only matters when the client requires a specific brand
          (ci.brand_locked&&!!(option.brand||other.brand)&&!brandsMatch(option.brand,other.brand));
        });
        if(conflicting&&((!option.clientApproved&&!option.automaticAlternative)||ci.comparison_mode==="exact")){
          option.unverified=true;
          option.comparisonWarning="Linked vendor products differ in description or pack; review this catalog item";
        }
      }

      // Case and Each are independent purchasing choices. A linked offer
      // contributes comparison evidence only after its own quote is ready.
      let orderComparisonUnit=null;
      for(const orderUnit of ["case","each"]){
        const unitOffers=options.filter(option=>supportsOrderUnit(option,orderUnit));
        const comparison=compareOrderOffers(unitOffers,{orderUnit,preferredUnit:ci.canonical_unit,industry:org?.industry});
        orderComparisonUnit||=comparison.unit;
        for(const option of unitOffers){
          option.perUnit=comparison.rates.get(option)||null;
          if(orderable(option)&&!comparison.comparable.has(option)){
            option.unverified=true;
            option.qualificationReason="Choose a shared comparison measurement or correct the pack before ranking alternatives";
          }
        }
      }
      const displayUnit=ci.canonical_unit||orderComparisonUnit;
      const linkedListings=ciMappings.map(m=>viMap.get(m.vendor_item_id)).filter(Boolean);
      const clientName=clientProductName(ci,linkedListings,org?.industry,procurement);

      return {
        catalogItemId:ci.id,
        masterItemNumber:ci.master_item_number,
        name:clientName||'Product name needed',
        hasProductIdentity:!!clientName&&(!!ci.concept_key||linkedListings.some(row=>procurement.readProductLabel(row).key!==null)),
        category:ci.catalog_categories?.name||penName,
        categoryReview:!!ci.category_review, categoryReason:ci.category_reason||null,
        createdAt:ci.created_at,
        brandLocked:ci.brand_locked||false,
        preferredBrand:ci.preferred_brand||null,comparisonMode:ci.comparison_mode||"alternatives",
        lockedBrand,
        matchingBehavior:ci.matching_behavior||"flexible",
        canonicalUnit:ci.canonical_unit||null,
        displayUnit,
        options,
        // All distinct vendor IDs linked to this KERDOS item, regardless of
        // whether they are currently orderable. Used by the multi-vendor badge
        // so that held vendors (expired quote, unverified match, etc.) are
        // counted and disclosed rather than silently dropped.
        allLinkedVendorIds:[...new Set(options.map(o=>o.vendorId))],
      };
    });
    // A saved basket may still use a former group number. Keep that line and
    // its explicit supplier choice available without adding a duplicate guide row.
    const byId=new Map(products.map(product=>[product.catalogItemId,product]));
    for(const alias of catalogItems.filter(item=>item.merged_into_id)){
      if(!(quantities[`${alias.id}_case`]>0||quantities[`${alias.id}_each`]>0))continue;
      let target=alias;const seen=new Set();
      while(target?.merged_into_id&&!seen.has(target.id)){seen.add(target.id);target=catalogItems.find(item=>item.id===target.merged_into_id);}
      const product=byId.get(target?.id);
      if(product&&!byId.has(alias.id))products.push({...product,catalogItemId:alias.id,masterItemNumber:alias.master_item_number,hasProductIdentity:false});
    }
    return products;
  },[catalogItems,categories,vendorItems,mappings,vendors,vendorColors,vocabulary,org?.settings,clockTick,quantities]);

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
    mappings.filter(m=>!productLabelLinked(m)&&(m.comparison_track!=="exact"||m.confidence_score!==100)).length,
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
      const unit=dragged.key.endsWith("_each")?"each":"case";
      const option=product.options.find(candidate=>candidate.vendorId===vendorId&&orderable(candidate)&&supportsOrderUnit(candidate,unit));
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
      for(const unit of ["case","each"]){
        const key=`${prod.catalogItemId}_${unit}`;
        const quantity=quantities[key]||0;
        if(quantity<=0)continue;
        const negotiation=negotiatedPrices[key];
        const unitOffers=prod.options.filter(o=>supportsOrderUnit(o,unit));
        const ranked=rankVendorOffers(unitOffers,negotiation,unit);
        const customVendorId=vendorOverride[key]||null;
        const selectedOffer=ranked.find(o=>orderable(o)&&(o.vendorItemId===customVendorId||o.vendorId===customVendorId));
        const preferredOffer=ranked.find(o=>orderable(o)&&prod.preferredBrand&&brandsMatch(o.brand,prod.preferredBrand));
        const primaryOffer=selectedOffer||preferredOffer||ranked.find(orderable);
        const split=splitOrders[key];
        const splitQty=split&&(!customVendorId||selectedOffer)&&split.vendorId!==primaryOffer?.vendorId&&
          ranked.some(o=>o.vendorId===split.vendorId&&orderable(o))?Math.min(quantity-1,Math.max(0,Math.floor(Number(split.quantity)||0))):0;
        const options=unitOffers.map(o=>({...o,price:priceForOffer(o,negotiation,unit),packSize:unit==="each"?o.eachSize:o.packSize,orderUnit:unit}));
        items.push({...prod,catalogItemId:unit==="each"?key:prod.catalogItemId,quantity:quantity-splitQty,orderUnit:unit,options,
          forcedVendorId:customVendorId||(splitQty>0?primaryOffer?.vendorId:preferredOffer?.vendorItemId)||null,forcedPrice:null});
        if(splitQty>0)items.push({...prod,catalogItemId:`${prod.catalogItemId}_split_${unit}`,quantity:splitQty,orderUnit:unit,options,
          forcedVendorId:split.vendorId,forcedPrice:null});
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

  const baselineSpend=useMemo(()=>assignments.reduce((total,line)=>
    total+r2(line.cheapestPrice*line.quantity),0),[assignments]);
  const blockedCartItems=assignments.filter(a=>a.unorderable||!a.assignedVendorId);
  const totalSpend=baskets.reduce((s,b)=>s+b.dollar,0);
  const totalUnits=baskets.reduce((s,b)=>s+b.units,0);

  const orderCategoryList=useMemo(()=>orderGuideCategories(productList),[productList]);
  const regularItemIds=regularItems?.scope===regularItemsScope?regularItems.ids:null;
  const regularCount=useMemo(()=>regularItemIds
    ?productList.filter(item=>regularItemIds.has(item.catalogItemId)&&item.hasProductIdentity!==false&&item.options.length>0).length
    :0,[productList,regularItemIds]);
  const orderView=orderGuideView??(regularCount>=regularsDefaultMinimum?'regulars':'all');
  const showingRegulars=orderView==='regulars';
  const filtered=useMemo(()=>showingRegulars&&!regularItemIds?[]:orderGuideGroups(productList,{
    search,category:orderCategoryFilter,vendor:orderVendorFilter,sort:orderSortMode,regularIds:showingRegulars?regularItemIds:null,
  }),[productList,search,orderCategoryFilter,orderVendorFilter,orderSortMode,showingRegulars,regularItemIds]);
  const highlightedOrderItem=filtered[0]?.items.some(item=>item.catalogItemId===activeOrderItem)
    ?activeOrderItem:filtered[0]?.items[0]?.catalogItemId;
  function chooseOrderView(view){
    setOrderGuideView(view);
    setActiveOrderItem(null);
    orderItemClickedAt.current=0;
    setOpenPriceMenu(null);
    setOrderGuideOpenCount(count=>count+1);
  }

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
    if(blockedCartItems.length){alert(`${blockedCartItems.length} item(s) need a confirmed current quote. Review them in Item Catalog before submitting.`);return;}
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
        <Drachma size={56} label="Loading KERDOS" style={{gap:0}} showLabel={false} />
        <div style={{fontWeight:900,fontSize:20,letterSpacing:"0.18em",color:"#4A90D9",marginTop:8}}>KERDOS</div>
        <div style={{marginTop:12,opacity:0.6,fontSize:13}}>Loading...</div>
      </div>
    </div>
  );
  if(!session) return <LandingGate />;
  if(!org) return <OrgGate user={session.user} onComplete={o=>{setOrg(o);loadData();}} />;

  const account = session.user;
  const metadata = account.user_metadata;
  const savedInitials = metadata?.kerdos_initials;
  const accountName = [metadata?.full_name, metadata?.name, account.full_name, account.name]
    .find(name => typeof name === "string" && name.trim())?.trim();
  const catalogEditors = accountName
    ? {...editors,[account.id]:{...editors[account.id],name:accountName}}
    : editors;
  const accountInitials = typeof savedInitials === "string" && /^\p{L}{1,3}$/u.test(savedInitials)
    ? savedInitials.toUpperCase()
    : accountName ? userInitials(accountName) : initialsFor({email:account.email}) || "?";
  const welcomeName = org.settings?.welcome_name;
  const clientName = (typeof welcomeName === "string" && welcomeName.trim()) || org.name;

  return (
    <div className="workspace-shell" style={{minHeight:"100vh",background:"#003584"}}>
      <style>{`
        .workspace-shell { --workspace-header-height:60px; --workspace-tabs-height:54px; --browse-top:calc(var(--workspace-header-height) + var(--workspace-tabs-height)); }
        .workspace-sticky-tabs { position:sticky; top:var(--workspace-header-height); z-index:120; height:var(--workspace-tabs-height); max-width:1400px; margin:12px auto 18px; padding:0 18px; background:#003584; }
        .workspace-sticky-tabs h1 { flex:none; }
        .workspace-sticky-tabs nav { overflow-x:auto; padding:4px 2px; }
        .workspace-sticky-tabs nav button { flex:none; white-space:nowrap; }
        .workspace-browse-controls { position:sticky; top:var(--browse-top); z-index:100; background:#003584; padding-bottom:10px; }
        .mobile-page-picker { display:none; }
        @media (max-width:720px) {
          .workspace-shell { overflow-wrap:anywhere; }
          .workspace-sticky-tabs { justify-content:space-between; }
          .workspace-sticky-tabs h1 { flex:1; min-width:0; font-size:14px!important; overflow-wrap:anywhere; }
          .workspace-sticky-tabs nav { display:none!important; }
          .mobile-page-picker { display:block; max-width:56%; min-height:44px; border:1px solid #B7C8DE; background:white; color:#003584; border-radius:8px; font:inherit; font-size:16px; padding:4px 8px; }
          .workspace-browse-controls input,.workspace-browse-controls select { min-height:44px; min-width:0!important; max-width:100%; font-size:16px!important; }
          .catalog-browse-filters { display:grid!important; grid-template-columns:repeat(2,minmax(0,1fr)); gap:8px!important; padding:10px!important; margin-bottom:8px!important; }
          .catalog-browse-filters > select { width:100%!important; }
          .mobile-edit-table,.mobile-edit-table > tbody { display:block; width:100%; min-width:0!important; }
          .mobile-edit-table > thead { display:none; }
          .mobile-edit-table > tbody > tr { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); padding:8px; border-top:1px solid #DEE7F0; }
          .mobile-edit-table > tbody > tr > td { display:block; min-width:0!important; overflow-wrap:anywhere; }
          .mobile-edit-table td[colspan],.mobile-edit-table td[data-mobile-wide] { grid-column:1 / -1; }
          .mobile-edit-table td[data-field-label]::before { display:block; content:attr(data-field-label); margin-bottom:4px; font-weight:700; color:#52647A; }
          .mobile-edit-table input,.mobile-edit-table select { width:100%!important; min-width:0!important; min-height:44px; font-size:16px!important; }
          .mobile-edit-table button { min-height:44px; }
          .document-browse-row { flex-wrap:wrap; }
          .document-browse-title { flex:1 1 100%; white-space:normal!important; overflow-wrap:anywhere; }
          .document-browse-title > div:first-child { white-space:normal!important; overflow-wrap:anywhere; }
          .document-browse-actions { flex-wrap:wrap; min-width:0; max-width:100%; }
          .vendor-detail-item-name { white-space:normal!important; overflow-wrap:anywhere; }
        }
        @media (max-height:480px) { .workspace-browse-controls { position:relative; top:auto; } }
      `}</style>

      {/* HEADER */}
      <header style={{background:tab==="home"?"#003584":"white",color:tab==="home"?"white":"#1A4FA8",padding:"0 22px",height:"var(--workspace-header-height)",
        display:"flex",alignItems:"center",justifyContent:"space-between",
        position:"sticky",top:0,zIndex:200,boxShadow:"0 2px 8px rgba(0,0,0,0.3)"}}>
        <button type="button" onClick={()=>setTab("home")} aria-label="KERDOS Home" style={{display:"flex",alignItems:"center",gap:9,border:0,background:"none",color:tab==="home"?"white":"#1A4FA8",cursor:"pointer",fontWeight:900,fontSize:19,letterSpacing:".12em"}}><span className="kerdos-header-coin"><BrandCoinFaces size={28} className="kerdos-header-coin-turn" /></span>KERDOS</button>
        <div style={{position:"relative"}}>
          <button type="button" aria-label="Account menu" aria-expanded={accountMenuOpen} onClick={()=>setAccountMenuOpen(open=>!open)} style={{width:36,height:36,borderRadius:"50%",border:0,background:tab==="home"?"rgba(255,255,255,0.12)":"#E6EEF9",color:tab==="home"?"#69F0AE":"#1A4FA8",fontWeight:700,cursor:"pointer"}}>{accountInitials}</button>
          {accountMenuOpen&&<div style={{position:"absolute",right:0,top:42,minWidth:180,maxWidth:"calc(100vw - 76px)",overflowWrap:"anywhere",background:"white",boxShadow:"0 4px 16px #0003",borderRadius:8,padding:12,zIndex:210,color:"#0F1C2E",fontSize:12}}>
            <div style={{marginBottom:10,fontWeight:700}}>{accountName||account.email||"Your account"}</div>
            {organizations.length>1&&<select aria-label="Active organization" value={org.id} onChange={e=>{setAccountMenuOpen(false);switchOrganization(e.target.value);}} style={{width:"100%",marginBottom:10}}>{organizations.map(o=><option key={o.id} value={o.id}>{o.name}</option>)}</select>}
            <button type="button" onClick={()=>{setAccountMenuOpen(false);try{sessionStorage.removeItem("kerdos.activeTab.v2");}catch{} backend.session.signOut().catch(err=>alert(err.message));}} style={{background:"none",border:0,color:"#1A4FA8",cursor:"pointer",padding:0}}>Sign out</button>
          </div>}
        </div>
      </header>

      {offline&&(
        <div style={{background:"#FFF3E0",color:"#8A4F00",padding:"8px 16px",fontSize:12,fontWeight:600,display:"flex",justifyContent:"space-between",alignItems:"center",gap:12}}>
          <span>Working offline — showing your workspace as of {formatDate(offline.since)}. Your basket remains saved on this device.</span>
          <button onClick={()=>loadData()} style={{...btn("#8A4F00","white",{fontSize:11,padding:"5px 10px"})}}>Retry</button>
        </div>
      )}

      <TabHeading title={pageName(tab)} onHome={()=>setTab("home")} activeTab={tab} role={org.role} sticky onNavigate={id=>id==="order"?openOrderGuide():setTab(id)} />

      {tab==="home"&&<WelcomeScreen clientName={clientName} userName={accountName} role={org.role}
        attentionCount={needsAttentionCount} invoiceReviewCount={invoiceReviewCount}
        inboxCount={inboxAttentionCount} onNavigate={id=>id==="order"?openOrderGuide():setTab(id)} />}

      <div style={{maxWidth:1400,margin:"0 auto",padding:"0 18px 80px",display:tab==="home"?"none":undefined}}>

        {/* HOME TAB */}
        {/* ORDER TAB */}
        {tab==="order"&&(
          <div className="order-layout">
            <style>{`
              .order-layout { display:flex; gap:18px; align-items:flex-start; max-width:1320px; margin:0 auto; }
              .order-aside { width:330px; flex-shrink:0; position:sticky; top:var(--browse-top); align-self:flex-start; max-height:calc(100vh - var(--browse-top) - 8px); overflow-y:auto; overscroll-behavior:contain; scrollbar-gutter:stable; }
              .order-aside-inner { position:static; }
              .order-column-head { font-size:9px; font-weight:800; color:#718096; letter-spacing:.06em; text-transform:uppercase; }
              .order-browse-filters select { max-width:48%; min-width:0; }
              .order-price-grid { display:grid; grid-template-columns:minmax(0,1fr); gap:6px; }
              .order-price-card { min-width:0; border-radius:8px; padding:6px 8px; background:white; text-align:left; }
              .order-item-listings { border-top:1px solid #E3E7ED; }
              .order-item-grid { display:grid; grid-template-columns:minmax(220px,1fr) 88px 104px minmax(370px,420px); gap:2px 10px; align-items:center; padding:8px 12px; }
              .order-item { display:contents; }
              .order-item[data-active="true"] > .order-item-name,
              .order-item[data-active="true"] > .order-item-unit,
              .order-item[data-active="true"] > .order-item-qty,
              .order-item[data-active="true"] > .order-item-price { background:#DCEBFC!important; box-shadow:inset 0 2px #1565C0,inset 0 -2px #1565C0; }
              .order-item[data-active="true"] > .order-item-name { border-left:3px solid #1565C0; }
              .order-item[data-active="true"] > .order-item-price { border-right:3px solid #1565C0; }
              @media (max-width:1240px) {
                .order-item-grid { grid-template-columns:minmax(120px,1fr) 80px 104px minmax(190px,1.35fr); }
              }
              @media ${mobileOrderQuery} {
                .order-layout { display:block; }
                .order-item-grid { display:block; }
                .order-column-head { display:none; }
                .order-item { display:grid; grid-template-columns:minmax(0,1fr) minmax(120px,1fr); border:1px solid #6B9BCD; border-bottom-width:2px; border-radius:10px; background:#DCEBFC; padding:8px; margin-bottom:10px; }
                .order-item-name,.order-item-price,.order-item-listings { grid-column:1 / -1; }
                .order-item-name,.order-item-price { border:0!important; }
                .order-item-name { color:#003584; }
                .order-item-price { background:transparent!important; padding:6px 0 0!important; }
                .order-item-unit,.order-item-qty { background:#EEF5FF!important; border-color:#C6DAF3!important; }
                .order-item-name > div:first-child { white-space:normal!important; font-size:16px!important; overflow-wrap:anywhere; }
                .order-item select,.order-item input { font-size:16px!important; min-height:44px; }
                .order-item-qty button { width:44px!important; height:44px!important; }
                .order-price-card > button:first-child { min-height:44px; font-size:14px!important; }
                .order-price-card > button[aria-expanded="true"] { background:#003584!important; border-color:#003584!important; color:white; }
                .mobile-basket-launch { position:fixed; z-index:130; left:12px; right:12px; bottom:calc(10px + env(safe-area-inset-bottom)); display:flex; gap:12px; justify-content:space-between; align-items:center; min-height:48px; padding:8px 16px; border:1px solid #C8DAF2; border-radius:10px; background:#003584; color:white; font-family:inherit; font-size:16px; font-weight:700; box-shadow:0 3px 14px #00204F66; cursor:pointer; }
                .mobile-basket-dialog { position:fixed; inset:auto 0 0; margin:0; width:100%; max-width:none; max-height:85dvh; box-sizing:border-box; padding:0 14px calc(14px + env(safe-area-inset-bottom)); border:0; border-radius:16px 16px 0 0; background:#F2F6FA; overflow:auto; overscroll-behavior:contain; }
                .mobile-basket-dialog::backdrop { background:#17243A88; }
                .mobile-basket-heading { display:flex; align-items:center; justify-content:space-between; position:sticky; top:0; z-index:1; background:#F2F6FA; padding:6px 0; color:#003584; }
                .mobile-basket-heading button { min-height:44px; padding:0 14px; border:1px solid #B8C8DC; background:white; border-radius:8px; font-size:16px; cursor:pointer; }
                body:has(.mobile-basket-dialog[open]) { overflow:hidden; }
                .order-layout > main { width:100%; }
                .order-aside { width:100%; position:static; max-height:none; overflow:visible; }
                .order-aside-inner { position:static; }
                .order-price-grid { grid-template-columns:1fr; }
                .order-browse-filters select { flex:1; }
              }
            `}</style>
            <main style={{flex:1,minWidth:0}}>
              <div ref={orderBrowseControlsRef} className="workspace-browse-controls" role="region" aria-label="Order Guide controls">
                {backend.regularItems&&productList.length>0&&<div role="group" aria-label="Order Guide lists" style={{display:"flex",gap:8,padding:"0 0 10px"}}>
                  {[['all','All Items'],['regulars',`Regulars (${regularCount})`]].map(([view,label])=><button
                    type="button" key={view} aria-pressed={orderView===view} onClick={()=>chooseOrderView(view)}
                    style={btn(orderView===view?'#DCEBFC':'#17529B',orderView===view?'#003584':'white')}>{label}</button>)}
                </div>}
                <div className="order-browse-filters" style={{display:"flex",gap:12,marginBottom:14,padding:18,borderRadius:10,background:"#DCE9FA"}}>
                  <select aria-label="Vendors" value={orderVendorFilter} onChange={e=>{setOrderVendorFilter(e.target.value);}} style={{...inp,width:180,background:"white",color:"#174EAB",fontWeight:700}}>
                    <option value="">Vendors</option>
                    {vendors.map(v=><option key={v.id} value={v.id}>{v.name}</option>)}
                  </select>
                  <select aria-label="Item Categories" value={orderCategoryFilter} onChange={e=>{setOrderCategoryFilter(e.target.value);}} style={{...inp,width:220,background:"white",color:"#174EAB",fontWeight:700}}>
                    <option value="">Item Categories</option>
                    {orderCategoryList.map(c=><option key={c} value={c}>{c}</option>)}
                  </select>
                  <select aria-label="Sort" value={orderSortMode} onChange={e=>setOrderSortMode(e.target.value)} style={{...inp,width:180,background:"white",color:"#174EAB",fontWeight:700}}>
                    <option value="alphabetical">Item A–Z</option>
                    <option value="added">Date Added</option>
                    <option value="itemNumber">Item #</option>
                    <option value="vendorCode">Vendor Code</option>
                  </select>
                </div>
                <input value={search} onChange={e=>setSearch(e.target.value)}
                  placeholder={`🔍 Search ${productList.length} items by name, vendor wording, or code...`}
                  style={inp} />
              </div>

              {!showingRegulars&&productList.length===0&&(
                <div style={{background:"white",borderRadius:10,padding:32,textAlign:"center",boxShadow:"0 1px 3px rgba(0,0,0,0.08)"}}>
                  <div style={{fontSize:32,marginBottom:8}}>📋</div>
                  <h3 style={{margin:"0 0 8px"}}>No items yet</h3>
                  <p style={{color:"#888",fontSize:14,margin:"0 0 16px"}}>Import a vendor price list to get started</p>
                  <button onClick={()=>setTab("priceSheets")} style={{...btn("#003584")}}>Import Price Sheet</button>
                </div>
              )}

              {showingRegulars&&filtered.length===0&&(
                <div style={{background:"white",borderRadius:10,padding:24,color:"#24436B",marginBottom:12}}>
                  <b>{regularItems?.scope!==regularItemsScope?"Loading regular items":!regularItemIds?"Regulars are unavailable":regularCount?"No regular items match these filters":"No regular items yet"}</b>
                  {regularItemIds&&regularCount===0&&<p>Regulars builds from submitted orders. Items fall off after 60 days without an order.</p>}
                  <button type="button" onClick={()=>chooseOrderView('all')} style={{...btn("#003584"),marginTop:10}}>View All Items</button>
                </div>
              )}

              {!showingRegulars&&productList.length>0&&filtered.length===0&&(
                <div style={{background:"white",borderRadius:10,padding:24,color:"#24436B",marginBottom:12}}>
                  <b>{search||orderCategoryFilter||orderVendorFilter?"No KERDOS items match this filter":"Your Order Guide has no product groups yet"}</b>
                  <p style={{margin:"8px 0",fontSize:13}}>{search||orderCategoryFilter||orderVendorFilter?"Clear the search or choose All in both menus to see your product groups.":"Product groups with vendor listings appear here alphabetically. Unidentified source rows remain in Item Catalog."}</p>
                  {search||orderCategoryFilter||orderVendorFilter?<button onClick={()=>{setSearch("");setOrderCategoryFilter("");setOrderVendorFilter("");}} style={btn("#003584")}>Show Full List</button>:<button onClick={()=>setTab("catalog")} style={btn("#003584")}>Open Item Catalog</button>}
                </div>
              )}

              {filtered.map(group=>(
                <div key={group.category} style={{marginBottom:8}}>
                  <div style={{background:"white",borderRadius:8}}>
                    <div className="order-item-grid">
                      <div className="order-column-head" style={{padding:"2px 2px 7px"}}>Item</div>
                      <div className="order-column-head" style={{padding:"2px 6px 7px"}}>Unit</div>
                      <div className="order-column-head" style={{padding:"2px 6px 7px",textAlign:"center"}}>Qty</div>
                      <div className="order-column-head" style={{padding:"2px 6px 7px"}}>PRICE</div>
                      {group.items.map(item=>{
                        const caseKey=`${item.catalogItemId}_case`;
                        const eachKey=`${item.catalogItemId}_each`;
                        const caseQty=quantities[caseKey]||0;
                        const eachQty=quantities[eachKey]||0;
                        const hasCase=item.linkedOptions.some(o=>supportsOrderUnit(o,"case"));
                        const hasEach=item.linkedOptions.some(o=>supportsOrderUnit(o,"each"));
                        // Keep an unsupported saved quantity selectable so it can be removed.
                        const canSelectCase=hasCase||caseQty>0;
                        const canSelectEach=hasEach||eachQty>0;
                        const selectedUnit=canSelectEach&&(!canSelectCase||unitSelection[item.catalogItemId]==="each")?"each":"case";
                        const activeKey=selectedUnit==="case"?caseKey:eachKey;
                        const activeQty=selectedUnit==="case"?caseQty:eachQty;
                        const cartItemIdForActive=selectedUnit==="case"?item.catalogItemId:item.catalogItemId+"_each";
                        const assignment=assignMap.get(cartItemIdForActive);
                        const negotiation=negotiatedPrices[activeKey];
                        const linkedForUnit=item.linkedOptions.filter(o=>supportsOrderUnit(o,selectedUnit));
                        const allUnitListings=rankVendorOffers(linkedForUnit,negotiation,selectedUnit);
                        const rankedOptions=allUnitListings.filter(orderable);
                        const heldOptions=allUnitListings.filter(o=>!orderable(o)).sort((a,b)=>(a.unitPrice??Infinity)-(b.unitPrice??Infinity));
                        const chosenLinkedOption=item.linkedOptions.find(o=>o.vendorItemId===vendorOverride[activeKey]);
                        const wrongUnit=chosenLinkedOption&&!supportsOrderUnit(chosenLinkedOption,selectedUnit);
                        const selectedHeldOption=chosenLinkedOption&&(wrongUnit||!orderable(chosenLinkedOption))?chosenLinkedOption:null;
                        const selectedReadyOption=rankedOptions.find(o=>o.vendorItemId===vendorOverride[activeKey]||o.vendorId===vendorOverride[activeKey]);
                        const displayOption=selectedHeldOption||selectedReadyOption||(
                          assignment?rankedOptions.find(opt=>opt.vendorItemId===assignment.vendorItemId):null
                        )||rankedOptions.find(o=>item.preferredBrand&&brandsMatch(o.brand,item.preferredBrand))||rankedOptions[0]||heldOptions[0];
                        const activePrice=wrongUnit?null:selectedHeldOption?priceForOffer(selectedHeldOption,null,selectedUnit):
                          selectedReadyOption?selectedReadyOption.unitPrice:assignment&&!assignment.unorderable?assignment.price:displayOption?.unitPrice;
                        const activeVendorName=displayOption?.vendorName||assignment?.assignedVendorName;
                        const activeVendorId=displayOption?.vendorId||assignment?.assignedVendorId;
                        const vc=vendorColors.get(activeVendorId)||PALETTE[0];
                        const menuOpen=openPriceMenu===activeKey;
                        const activeBlocked=!!selectedHeldOption||!displayOption||!orderable(displayOption)||(!!assignment?.unorderable&&!selectedReadyOption);
                        const activeBlockReason=activeBlocked?(wrongUnit?"This listing has no quote for the selected unit":displayOption?blockReason(displayOption):"No quote for the selected unit"):null;
                        const allListings=[...allUnitListings,...item.linkedOptions.filter(o=>!supportsOrderUnit(o,selectedUnit))];
                        const pendingListingEdit=menuOpen?null:allListings.map(offer=>listingEdits.drafts[offer.vendorItemId]).find(edit=>edit?.error||edit?.phase==='queued'||edit?.phase==='saving');
                        const vendorCount=new Set(allUnitListings.filter(offer=>offer.unitPrice>0).map(offer=>offer.vendorId)).size;
                        const multipleVendors=vendorCount>1;
                        const alternativesMenu=menuOpen&&<OrderGuideListings canManage={['owner','manager'].includes(org.role)}
                          offers={allListings} selectedId={displayOption?.vendorItemId} vendorItems={vendorItems} unit={selectedUnit} listingEdits={listingEdits}
                          onSelect={offer=>{
                            const nextUnit=supportsOrderUnit(offer,"each")?"each":"case";
                            if(nextUnit!==selectedUnit)setUnitSelection(previous=>({...previous,[item.catalogItemId]:nextUnit}));
                            setVendorOverride(previous=>({...previous,[`${item.catalogItemId}_${nextUnit}`]:offer.vendorItemId}));
                            setOpenPriceMenu(null);
                          }}/>;
                        const cells=[
                          <div className="order-item-name" data-order-item-name={item.catalogItemId} key={item.catalogItemId+"_name"} draggable={!activeBlocked}
                            onDragStart={event=>{event.dataTransfer.effectAllowed="copy";event.dataTransfer.setData("text/plain",activeKey);setDragItem({catalogItemId:item.catalogItemId,key:activeKey,name:item.name});}}
                            onDragEnd={()=>{setDragItem(null);setDropTarget(null);}}
                            title={activeBlocked?undefined:"Drag onto a vendor basket to order from that vendor"}
                            style={{minWidth:0,padding:"8px 8px 8px 2px",borderTop:"1px solid #F2F2F2",cursor:activeBlocked?"default":"grab",opacity:dragItem?.key===activeKey?0.5:1}}>
                            <div style={{fontWeight:600,fontSize:12.5,overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>
                              {item.name}
                            </div>
                            <div style={{fontSize:10,color:'#52647A',marginTop:4}}>KERDOS #{item.masterItemNumber}</div>
                            {!showingRegulars&&regularItemIds?.has(item.catalogItemId)&&<span style={{fontSize:10,color:"#176247"}}>Regular</span>}
                          </div>,
                          <div className="order-item-unit" key={item.catalogItemId+"_unit"} style={{padding:"8px 6px",borderTop:"1px solid #F2F2F2",borderLeft:"1px solid #EEE",background:hasEach?fieldHighlight.fill:"#FAFBFC"}}>
                            <select aria-label={`Order unit for ${item.name}`} value={selectedUnit} onChange={e=>setUnitSelection(prev=>({...prev,[item.catalogItemId]:e.target.value}))}
                              style={{width:"100%",fontSize:11,padding:"4px 2px",borderRadius:6,border:hasEach?`2px solid ${fieldHighlight.accent}`:"1px solid #DDD",background:"white",color:hasEach?fieldHighlight.accent:"#444",fontWeight:hasEach?800:400}}>
                              <option value="case" disabled={!canSelectCase}>Case {!hasCase?"(unavailable)":""}</option>
                              <option value="each" disabled={!canSelectEach}>Each {!hasEach?"(unavailable)":""}</option>
                            </select>
                          </div>,
                          <div className="order-item-qty" key={item.catalogItemId+"_qty"} style={{display:"flex",alignItems:"center",justifyContent:"center",gap:4,padding:"8px 6px",borderTop:"1px solid #F2F2F2",borderLeft:"1px solid #EEE",background:"#F5F8FF"}}>
                            <button aria-label={`Remove one ${selectedUnit} of ${item.name}`} onClick={()=>setQty(activeKey,activeQty-1)}
                              style={{width:26,height:26,borderRadius:7,border:"1px solid #FFCDD2",background:"#FFEBEE",cursor:"pointer",fontSize:15,fontWeight:800,color:"#D32F2F",flexShrink:0}}>−</button>
                            <span style={{width:18,textAlign:"center",fontWeight:800,fontSize:13,color:activeQty>0?vc.accent:"#CCC"}}>{activeQty||"·"}</span>
                            <button aria-label={`Add one ${selectedUnit} of ${item.name}`} onClick={()=>{if(!activeBlocked){if(activeQty===0&&orderVendorFilter){const filteredOffer=rankedOptions.find(o=>orderable(o)&&o.vendorId===orderVendorFilter);if(filteredOffer)setVendorOverride(prev=>({...prev,[activeKey]:filteredOffer.vendorItemId}));}setQty(activeKey,activeQty+1);}}} disabled={activeBlocked}
                              title={activeBlocked?activeBlockReason:undefined}
                              style={{width:26,height:26,borderRadius:7,border:"none",background:activeBlocked?"#DDD":"#2E7D32",cursor:activeBlocked?"not-allowed":"pointer",fontSize:15,fontWeight:800,color:"white",flexShrink:0}}>+</button>
                          </div>,
                          <div className="order-item-price" key={item.catalogItemId+"_price"} style={{padding:"6px",borderTop:"1px solid #F2F2F2",borderLeft:"1px solid #EEE",background:"#FAFBFC"}}>
                            <div className="order-price-grid">
                              <div className="order-price-card" data-price-menu style={{border:"1px solid #CBD5E1",position:"relative"}}>
                              <button onClick={()=>setOpenPriceMenu(menuOpen?null:activeKey)} aria-label={`Price choices for ${item.name}`} aria-haspopup={mobileDetails?"dialog":"true"} aria-expanded={menuOpen}
                                aria-description={multipleVendors?`${vendorCount} vendors quote this item`:undefined}
                                title={[activeBlocked&&activeBlockReason,multipleVendors&&`${vendorCount} vendors quote this item`].filter(Boolean).join(' · ')||undefined} style={{width:'100%',textAlign:'left',padding:'7px 9px',border:multipleVendors?`2px solid ${fieldHighlight.accent}`:'1px solid #CBD5E1',borderRadius:6,background:multipleVendors?fieldHighlight.fill:'white',cursor:'pointer',fontSize:12}}>
                                {activeVendorName||'Select listing'} · {activePrice==null?'Price unavailable':formatMoney(activePrice)} <span style={{float:'right'}}>{menuOpen?'▴':'▾'}</span>
                              </button>
                              {pendingListingEdit&&<small role={pendingListingEdit.error?'alert':'status'} style={{display:'block',color:pendingListingEdit.error?'#B42318':'#52647A',marginTop:4}}>{pendingListingEdit.error||'Saving listing changes…'}</small>}
                              </div>
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
                          </div>,
                          ...(menuOpen?[mobileDetails
                            ?<MobileDetailWindow title="Vendor options" kind="vendor" key={item.catalogItemId+'_listings'} itemName={item.name} onMinimize={()=>setOpenPriceMenu(null)}>{alternativesMenu}</MobileDetailWindow>
                            :<div className="order-item-listings" data-price-menu key={item.catalogItemId+'_listings'} style={{gridColumn:'1 / -1',minWidth:0}}>{alternativesMenu}</div>]:[]),
                        ];

                        return <div className="order-item" key={item.catalogItemId} data-active={highlightedOrderItem===item.catalogItemId}
                          onClickCapture={()=>{orderItemClickedAt.current=Date.now();setActiveOrderItem(item.catalogItemId);}}
                          onFocusCapture={()=>setActiveOrderItem(item.catalogItemId)}>{cells}</div>;
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
                            <div style={{fontSize:11,fontWeight:700,color:po.status==="submitted"?"#0A8A4B":"#888",textTransform:"capitalize"}}>{po.estimated_snapshot?"Recorded · sending unconfirmed":po.status||"submitted"}</div>
                          </div>
                          <div style={{display:"flex",alignItems:"center",gap:10}}>
                            <div style={{fontWeight:800,fontSize:15}}>{orderAmountText(po)}</div>
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
                                  <div>{line.quantity}× {line.estimated_snapshot?.terms?.description||vi?.description||"Item"}</div>
                                  <div style={{fontWeight:700}}>{orderLineAmountText(line)}</div>
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
            <OrderBasket mobile={mobileOrder} summary={`${totalUnits} units · ${formatMoney(totalSpend)}`}>
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
                      <span style={{fontSize:11,opacity:0.6}}>Best unit-price total</span>
                      <span style={{fontWeight:600}}>{formatMoney(baselineSpend)}</span>
                    </div>
                    <div style={{display:"flex",justifyContent:"space-between",marginBottom:12}}>
                      <span style={{fontSize:11,opacity:0.6}}>Optimized total</span>
                      <span style={{fontWeight:800,fontSize:16,color:totalSpend>baselineSpend+0.01?"#FF9800":"#69F0AE"}}>{formatMoney(totalSpend)}</span>
                    </div>
                    <button onClick={submitOrders} disabled={blockedCartItems.length>0}
                      title={blockedCartItems.length?"Review the items needing a quote in Item Catalog":undefined}
                      style={{...btn(blockedCartItems.length?"#777":"#4A90D9"),width:"100%"}}>
                      Record {baskets.length} Order{baskets.length>1?"s":""} (not sent)
                    </button>
                  </div>
                </>)}
              </div>
            </OrderBasket>
          </div>
        )}

        {/* DOCUMENT PAGES — kept outside App.jsx so each workflow has one clear home */}
        {tab==="invoices"&&(
          <InvoicesPage
            orgId={org.id} vendors={vendors} invoices={invoices} vendorFilter={recordsVendorFilter} setVendorFilter={setRecordsVendorFilter}
            vendorColors={vendorColors} formatDate={formatDate} formatMoney={formatMoney}
            attentionCount={flaggedInvoiceLines.length+invoiceDerivedItems.length} role={org.role}
            onImport={vendorId=>{setSelectedVendorId(vendorId);setImportMode("invoice");setShowPaste(true);}}
            onExport={scope=>downloadTextFile(`price-variance-report-${new Date().toISOString().split("T")[0]}.csv`,buildComparisonReportCSV(scope.report),"text/csv")}
            onViewSource={viewSourceDocument} onViewOriginal={viewStoredFile} onEdit={setEditingInvoice} onDelete={deleteInvoice}
            expandedId={expandedInvoiceId} setExpandedId={setExpandedInvoiceId}
          />
        )}

        {tab==="priceSheets"&&(
          <PriceSheetsPage
            orgId={org.id} vendors={vendors} importDocuments={importDocuments}
            vendorFilter={priceSheetVendorFilter} setVendorFilter={setPriceSheetVendorFilter} vendorColors={vendorColors}
            formatDate={formatDate} role={org.role}
            onImport={vendorId=>{setSelectedVendorId(vendorId);setImportMode("pricelist");setShowPaste(true);}}
            onExpireVendor={expireVendorQuotes}
            onDelete={deletePriceSheet} onClear={clearPriceSheet}
            onViewOriginal={viewStoredFile} onViewSource={viewSourceDocument}
            industry={org.industry} vocabulary={vocabulary} reviewPriceSheet={backend.documents.reviewPriceSheet} onReviewSaved={loadData}
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
            {blockedCartItems.length>0&&(
              <div role="status" style={{background:"#FFF3E0",color:"#8A4F00",borderRadius:9,padding:12,marginBottom:14,fontSize:12}}>
                <b>{blockedCartItems.length} item(s) in your order need a confirmed vendor quote.</b>
                {blockedCartItems.map(a=><div key={a.catalogItemId} style={{marginTop:5}}>{a.name}: review the product, pack, and saved quote here before ordering.</div>)}
              </div>
            )}
            {org.role!=="employee"&&unmappedCount>0&&(
              <div style={{background:"#FFF3E0",borderRadius:10,padding:16,marginBottom:14,textAlign:"center"}}>
                <div role="status" style={{fontWeight:800,color:"#E65100"}}>{backfilling?`Bringing ${unmappedCount} imported item${unmappedCount===1?"":"s"} into the catalog…`:catalogRepairError||`${unmappedCount} imported item${unmappedCount===1?"":"s"} waiting for catalog links`}</div>
              </div>
            )}

            {autoPlaceError&&org.role!=="employee"&&<div role="alert" style={{background:"#FFF3E0",padding:12,marginBottom:12,borderRadius:8}}>
              {autoPlaceError} <button disabled={autoPlacing} onClick={()=>setAutoPlaceRetry(n=>n+1)} style={btn("#003584")}>Retry</button>
            </div>}
            <ItemCatalogPanel mobileDetails={mobileDetails} industry={org.industry} settings={org.settings} orgId={org.id} role={org.role} userId={session.user.id} productList={productList} vendors={vendors} catalogItems={catalogItems} mappings={mappings}
              vendorItems={vendorItems} categories={categories} vocabulary={vocabulary} editors={catalogEditors}
              onUpdated={loadData} />
          </>
        )}

        {/* TEAM TAB */}
        {tab==="inbox"&&(org.role==="owner"||org.role==="manager")&&(
          <>
            <EmailInboxPanel
              orgId={org.id}
              industry={org.industry}
              vendors={vendors}
              orgSettings={org.settings}
              catalogItems={catalogItems}
              categories={categories}
              vocabulary={vocabulary}
              vendorItems={vendorItems}
              mappings={mappings}
              onDone={loadData}
            />
          </>
        )}
        {tab==="team"&&(org.role==="owner"||org.role==="manager")&&(
          <>
            <TeamPanel orgId={org.id} orgName={org.name} orgIndustry={org.industry} orgSettings={org.settings} categories={categories} myRole={org.role} currentUserId={session.user.id} currentUserEmail={session.user.email} onOrgUpdated={loadData}
              logoUrl={logoUrl} onLogoUpload={handleLogoUpload} logoUploading={logoUploading} />
            <div style={{height:28}} />
            <div style={{background:"white",borderRadius:10,padding:16,boxShadow:"0 1px 3px rgba(0,0,0,0.08)"}}>
              <div className="workspace-browse-controls" role="region" aria-label="Vendor management controls" style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:12,background:"white",paddingBottom:0}}>
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
        {["owner","manager"].includes(org.role)&&<VendorConnectPage key={org.id} visible={tab==="vendorConnect"} backend={backend} organizationId={org.id} vendors={vendors} role={org.role} importInProgress={companionImport?.organizationId===org.id} importResult={companionResult?.organizationId===org.id?companionResult:null} onTransferStart={()=>setCompanionResult(null)} onCompanionImport={payload=>{
          if(showPaste||companionImport||payload.organizationId!==org.id||!vendors.some(v=>v.id===payload.vendorId&&v.is_active!==false))throw new Error('Import unavailable');
          setCompanionImport(payload);
        }} />}
      </div>

      {companionImport&&companionImport.organizationId===org.id&&["owner","manager"].includes(org.role)&&<PasteModal key={companionImport.evidence.sha256} industry={org.industry} vendors={vendors} orgId={org.id} orgSettings={org.settings} catalogItems={catalogItems} categories={categories} vocabulary={vocabulary} vendorItems={vendorItems} mappings={mappings} onClose={()=>setCompanionImport(null)} onDone={loadData} onIssue={async issue=>{
        const payload=companionImport;
        try{
          await settleScheduledImport(backend,payload.evidence,issue.importDocumentId);
          setCompanionResult({organizationId:payload.organizationId,vendorId:payload.vendorId,...issue,completedAt:Date.now()});
        }catch{setCompanionResult({organizationId:payload.organizationId,vendorId:payload.vendorId,status:'needs_attention',message:'Pricing was retained, but the scheduled result could not be confirmed. Review this attempt before another scheduled export.'});}
      }} onFinished={async notice=>{
        const payload=companionImport;
        try{
          await settleScheduledImport(backend,payload.evidence,notice.importDocumentId,{required:true});
          setImportNotice(notice);setCompanionResult({organizationId:payload.organizationId,vendorId:payload.vendorId,message:notice.message,completedAt:Date.now()});
        }catch{setCompanionResult({organizationId:payload.organizationId,vendorId:payload.vendorId,status:'needs_attention',message:'Pricing was retained, but the scheduled result could not be confirmed. Review this attempt before another scheduled export.'});}
        finally{setCompanionImport(null);}
      }} automaticCompanion initialVendorId={companionImport.vendorId} initialMode="pricelist" initialFiles={[companionImport.file]} companionEvidence={companionImport.evidence} />}
      {showPaste&&!companionImport&&org.role!=="employee"&&<PasteModal industry={org.industry} vendors={vendors} orgId={org.id} orgSettings={org.settings} catalogItems={catalogItems} categories={categories} vocabulary={vocabulary} vendorItems={vendorItems} mappings={mappings} onClose={()=>setShowPaste(false)} onDone={loadData} onFinished={setImportNotice} initialVendorId={selectedVendorId} initialMode={importMode} />}
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
