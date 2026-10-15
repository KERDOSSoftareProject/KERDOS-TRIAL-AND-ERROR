import { createClient } from "@supabase/supabase-js";
import { BackendError, providerResult } from "./contract.js";
import { createRecords } from "./records.js";

const SNAPSHOT_QUERIES = Object.freeze([
  ["vendors", c=>c.from("vendors").select("*").eq("is_active",true).order("name")],
  ["catalogItems", c=>c.from("catalog_items").select("*,catalog_categories(name)").order("master_item_number")],
  ["categories", c=>c.from("catalog_categories").select("*").order("name")],
  ["vendorItems", c=>c.from("vendor_items").select("*").order("id")],
  ["mappings", c=>c.from("item_mappings").select("*").order("id")],
  ["invoices", c=>c.from("invoices").select("*,vendors(name),invoice_lines(*)").order("invoice_date",{ascending:false,nullsFirst:false}).order("created_at",{ascending:false}).limit(30)],
  ["purchaseOrders", c=>c.from("purchase_orders").select("*,purchase_order_lines(*)").order("created_at",{ascending:false}).limit(30)],
  ["priceHistory", c=>c.from("price_history").select("*").order("effective_date",{ascending:false}).order("id",{ascending:false}).limit(2000)],
  ["importDocuments", c=>c.from("import_documents").select("*").eq("document_kind","pricelist").order("created_at",{ascending:false}).order("id",{ascending:false}).limit(500)],
  ["vocabulary", c=>c.from("org_vocabulary").select("*")],
]);

export function createSupabaseBackend({url,anonKey}) {
  if(!url||!anonKey) throw new Error("Supabase adapter requires an external URL and anonymous key");
  // Auth belongs to this browser tab. A refresh or a switch to another tab
  // keeps the session; closing this tab ends it. Remove the old default
  // localStorage token once so an earlier persistent login cannot revive it.
  const storageKey=`sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
  try{window.localStorage.removeItem(storageKey);}catch{}
  const client=createClient(url,anonKey,{auth:{storage:window.sessionStorage,storageKey,persistSession:true}});
  return {
    kind:"supabase",
    session:{
      get:()=>providerResult(client.auth.getSession(),"Load session").then(x=>x?.session||null),
      subscribe(listener){
        const result=client.auth.onAuthStateChange((event,session)=>listener({event,session:session||null}));
        return ()=>result?.data?.subscription?.unsubscribe?.();
      },
      signIn:(credentials)=>providerResult(client.auth.signInWithPassword(credentials),"Sign in"),
      signUp:(credentials)=>providerResult(client.auth.signUp(credentials),"Create account"),
      signOut:()=>providerResult(client.auth.signOut(),"Sign out"),
    },
    workspace:{
      memberships(userId){
        return providerResult(client.from("organization_members").select("organization_id,role,organizations(*)").eq("user_id",userId),"Load organizations");
      },
      async snapshot(organizationId){
        return loadWorkspaceSnapshot(client,organizationId);
      },
    },
    orders:{submit(row){return providerResult(client.rpc("kerdos_submit_order",row),"Record order");}},
    documents:{
      upload(path,file,options){return providerResult(client.storage.from("documents").upload(path,file,options),"Upload document");},
      signedUrl(path,seconds=3600){return providerResult(client.storage.from("documents").createSignedUrl(path,seconds),"Open document");},
      remove(paths){return providerResult(client.storage.from("documents").remove(paths),"Remove document");},
      deletePriceSheet(organizationId,documentId){return providerResult(client.rpc("kerdos_delete_price_sheet",{p_organization_id:organizationId,p_document_id:documentId}),"Delete price sheet");},
      deleteInvoiceRecord(organizationId,invoiceId){return providerResult(client.rpc("kerdos_delete_invoice_record",{p_organization_id:organizationId,p_invoice_id:invoiceId}),"Delete invoice");},
    },
    realtime:{
      subscribeToOrganization(organizationId,onChange){
        let timer;
        const schedule=()=>{clearTimeout(timer);timer=setTimeout(onChange,300);};
        const channel=client.channel(`kerdos:${organizationId}`)
          .on("postgres_changes",{event:"*",schema:"public",table:"vendor_items",filter:`organization_id=eq.${organizationId}`},schedule)
          .on("postgres_changes",{event:"*",schema:"public",table:"invoices",filter:`organization_id=eq.${organizationId}`},schedule)
          .subscribe();
        return ()=>{clearTimeout(timer);client.removeChannel(channel);};
      },
    },
    pricing:{
      applyQuote(quote){
        return providerResult(client.rpc("kerdos_apply_price_quote",{
          p_vendor_item_id:quote.vendorItemId||null,
          p_organization_id:quote.organizationId,
          p_vendor_id:quote.vendorId,
          p_vendor_item_code:quote.vendorItemCode||null,
          p_description:quote.description,
          p_pack_size:quote.packSize||null,
          p_price:quote.price??null,
          p_price_unavailable:!!quote.priceUnavailable,
          p_effective_date:quote.effectiveDate,
          p_quote_valid_until:quote.quoteValidUntil||null,
          p_source_file_path:quote.sourceFilePath||null,
          p_source_file_name:quote.sourceFileName||null,
          p_source_line:quote.sourceLine||null,
          p_source_document_id:quote.sourceDocumentId,
          p_selling_unit:quote.sellingUnit||null,
          p_price_basis:quote.priceBasis||null,
          p_gtin:quote.gtin||null,
          p_manufacturer_code:quote.manufacturerCode||null,
          p_import_row:quote.importRow||null,
          p_field_resolutions:quote.fieldResolutions||null,
          p_brand:quote.brand||null,
        }),"Apply price quotation");
      },
    },
    catalog:{
      groupAutomaticAlternatives(row){return providerResult(client.rpc("kerdos_group_automatic_alternatives",{p_organization_id:row.organizationId,p_vendor_item_ids:row.vendorItemIds,p_target_catalog_item_id:row.targetCatalogItemId,p_key:row.key,p_dimension:row.dimension,p_revisions:row.revisions}),"Group automatic alternatives");},
      separateAutomaticAlternatives(row){return providerResult(client.rpc("kerdos_separate_automatic_alternatives",{p_organization_id:row.organizationId,p_target_catalog_item_id:row.targetCatalogItemId}),"Separate automatic alternatives");},
      associateAlternatives(row){return providerResult(client.rpc("kerdos_associate_alternatives",{p_organization_id:row.organizationId,p_vendor_item_ids:row.vendorItemIds,p_target_catalog_item_id:row.targetCatalogItemId,p_name:row.name,p_preferred_brand:row.preferredBrand||null,p_revisions:row.revisions}),"Associate selected alternatives");},
      saveRow(row){return providerResult(client.rpc("kerdos_save_catalog_row",{
        p_organization_id:row.organizationId,p_vendor_item_id:row.vendorItemId,p_mapping_id:row.mappingId,
        p_expected_revision:row.expectedRevision,p_patch:row.patch,p_price_basis:row.priceBasis,p_price_available:row.priceAvailable,
      }),"Save catalog row");},
    },
    invoices:{
      record(header,lines){
        return providerResult(client.rpc("kerdos_record_invoice",{p_header:header,p_lines:lines}),"Record invoice");
      },
    },
    team:{
      async acceptInvite(code,userId){
        const rows=await providerResult(client.rpc("kerdos_accept_invite",{p_code:code,p_user_id:userId}),"Accept invitation");
        const accepted=rows?.[0];
        if(!accepted) throw new BackendError("Accept invitation",new Error("Invitation was not accepted"));
        return accepted;
      },
    },
    records:createRecords(spec=>executeSupabaseRecordQuery(client,spec)),
  };
}

// Only this adapter interprets KERDOS records as Supabase queries. A different
// provider implements the same records interface without exposing its SDK.
export function executeSupabaseRecordQuery(client,spec) {
  let query=client.from(spec.table);
  if(spec.action==="select") query=query.select(spec.columns||"*");
  else if(spec.action==="delete") query=query.delete();
  else if(["insert","update","upsert"].includes(spec.action)) query=query[spec.action](spec.value);
  else throw new Error(`Unsupported KERDOS records action: ${spec.action}`);
  if(spec.action!=="select"&&spec.columns) query=query.select(spec.columns);
  for(const {operator,column,value} of spec.filters) query=query[operator](column,value);
  for(const {column,options} of spec.orders) query=query.order(column,options);
  if(spec.range) query=query.range(spec.range.from,spec.range.to);
  if(spec.limit!==undefined) query=query.limit(spec.limit);
  if(spec.cardinality) query=query[spec.cardinality]();
  return query;
}

export async function loadWorkspaceSnapshot(client,organizationId){
        const entries=await Promise.all(SNAPSHOT_QUERIES.map(async ([name,build])=>{
          const paged=["catalogItems","vendorItems","mappings","categories","vendors","vocabulary"].includes(name);
          if(!paged)return [name,await providerResult(build(client).eq("organization_id",organizationId),`Load ${name}`)||[]];
          const rows=[];
          for(let offset=0;;offset+=500){
            const batch=await providerResult(build(client).eq("organization_id",organizationId).order("id").range(offset,offset+499),`Load ${name}`)||[];
            rows.push(...batch);
            if(batch.length<500)break;
          }
          return [name,rows];
        }));
        return Object.fromEntries(entries);
}
