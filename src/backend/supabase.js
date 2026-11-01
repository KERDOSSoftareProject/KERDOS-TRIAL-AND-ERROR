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

export function createSupabaseBackend({url,anonKey}, clientFactory=createClient) {
  if(!url||!anonKey) throw new Error("Supabase adapter requires an external URL and anonymous key");
  // Auth belongs to this browser tab. A refresh or a switch to another tab
  // keeps the session; closing this tab ends it. Remove the old default
  // localStorage token once so an earlier persistent login cannot revive it.
  const storageKey=`sb-${new URL(url).hostname.split(".")[0]}-auth-token`;
  try{window.localStorage.removeItem(storageKey);}catch{}
  const client=clientFactory(url,anonKey,{auth:{storage:window.sessionStorage,storageKey,persistSession:true}});
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
    inbox:createSupabaseInbox(client),
    vendorConnect:{request({organizationId,vendorId,adapterKey}){return providerResult(client.rpc("kerdos_request_vendor_connection",{p_organization_id:organizationId,p_vendor_id:vendorId,p_adapter_key:adapterKey}),"Prepare vendor connection");}},
    invoicePayments:{
      ledger(organizationId,invoiceId){return providerResult(client.rpc('kerdos_invoice_payment_ledger',{p_organization_id:organizationId,p_invoice_id:invoiceId}),'Load invoice payment ledger');},
      review(organizationId,invoiceId,approvalId,input){return providerResult(client.rpc('kerdos_review_invoice_payment',{p_organization_id:organizationId,p_invoice_id:invoiceId,p_approval_id:approvalId,p_paid_cents:input.amountCents,p_paid_on:input.paidOn,p_method:input.method,p_reference:input.reference}),'Review invoice payment record');},
      save(request){return providerResult(client.rpc('kerdos_save_invoice_payment',{p_organization_id:request.review.organizationId,p_request_id:request.requestId,p_review:request.review,p_confirmed:true}),'Record invoice payment');},
      reverse(organizationId,paymentId,reason){return providerResult(client.rpc('kerdos_reverse_invoice_payment',{p_organization_id:organizationId,p_payment_id:paymentId,p_reason:reason,p_confirmed:true}),'Reverse invoice payment record');},
    },
    invoiceApprovalWithdrawals:{
      withdraw(organizationId,approvalId,reason){return providerResult(client.rpc('kerdos_withdraw_invoice_approval',{p_organization_id:organizationId,p_approval_id:approvalId,p_reason:reason,p_confirmed:true}),'Withdraw invoice accounting approval');},
    },
    invoiceApprovals:{
      review(organizationId,invoiceId){return providerResult(client.rpc('kerdos_review_invoice_approval_audit',{p_organization_id:organizationId,p_invoice_id:invoiceId}),'Review invoice accounting approval');},
      save(request){return providerResult(client.rpc('kerdos_save_invoice_approval',{p_organization_id:request.organizationId,p_invoice_id:request.invoiceId,p_request_id:request.requestId,p_source:request.source,p_note:request.note,p_confirmed:true}),'Save invoice accounting approval');},
    },
    invoiceReconciliation:{
      review(organizationId,invoiceId){return providerResult(client.rpc('kerdos_review_invoice_reconciliation',{p_organization_id:organizationId,p_invoice_id:invoiceId}),'Review full invoice reconciliation');},
    },
    estimatedReceiptReplacements:{
      replace(predecessorId,review,reason){return providerResult(client.rpc('kerdos_replace_estimated_receipt',{p_organization_id:review.organizationId,p_predecessor_id:predecessorId,p_order_line_id:review.orderLine.id,p_invoice_line_id:review.invoiceLine.id,p_received_cases:review.receivedCaseQuantity,p_review:review,p_reason:reason,p_confirmed:true,p_cases_confirmed:true,p_replacement_confirmed:true}),'Replace receipt source');},
    },
    estimatedReceiptReversals:{
      history(organizationId,orderId){return providerResult(client.rpc('kerdos_estimated_receipt_history',{p_organization_id:organizationId,p_order_id:orderId}),'Load receipt and reversal history');},
      reverse(organizationId,receiptId,reason){return providerResult(client.rpc('kerdos_reverse_estimated_receipt',{p_organization_id:organizationId,p_receipt_id:receiptId,p_reason:reason,p_confirmed:true}),'Reverse receipt');},
    },
    estimatedReceipts:{
      candidates(organizationId,orderLineId,offset){return providerResult(client.rpc('kerdos_receipt_candidates',{p_organization_id:organizationId,p_order_line_id:orderLineId,p_offset:offset}),'Load invoice candidates');},
      review(organizationId,orderLineId,invoiceLineId,cases){return providerResult(client.rpc('kerdos_review_estimated_receipt',{p_organization_id:organizationId,p_order_line_id:orderLineId,p_invoice_line_id:invoiceLineId,p_received_cases:cases}),'Review invoice receipt');},
      save(review){return providerResult(client.rpc('kerdos_save_estimated_receipt',{p_organization_id:review.organizationId,p_order_line_id:review.orderLine.id,p_invoice_line_id:review.invoiceLine.id,p_received_cases:review.receivedCaseQuantity,p_review:review,p_confirmed:true,p_cases_confirmed:true}),'Save invoice receipt');},
      list(organizationId,orderId){return providerResult(client.rpc('kerdos_list_estimated_receipts',{p_organization_id:organizationId,p_order_id:orderId}),'Load receipt history');},
    },
    estimatedOrders:{
      review(organizationId,draftId){return providerResult(client.rpc('kerdos_review_estimated_order',{p_organization_id:organizationId,p_draft_id:draftId}),'Review estimated order');},
      submit(review,minimumAcknowledged){return providerResult(client.rpc('kerdos_submit_estimated_order',{p_organization_id:review.organizationId,p_draft_id:review.draftId,p_review:review,p_confirmed:true,p_minimum_acknowledged:minimumAcknowledged}),'Record estimated order');},
      async getByDraft(organizationId,draftId){const row=await providerResult(client.from('estimated_draft_submissions').select('order_snapshot').eq('organization_id',organizationId).eq('draft_id',draftId).maybeSingle(),'Recover estimated order');return row?.order_snapshot||null;},
    },
    estimatedDrafts:{
      closeAttempt(input){return providerResult(client.rpc('kerdos_close_estimated_draft_attempt',{p_organization_id:input.organizationId,p_vendor_id:input.vendorId,p_request_id:input.requestId,p_lines:input.lines}),'Close estimated draft save attempt');},
      list(organizationId,offset){return providerResult(client.from('estimated_purchase_drafts').select('*,estimated_draft_submissions(purchase_order_id)').eq('organization_id',organizationId).order('created_at',{ascending:false}).order('id',{ascending:false}).range(offset,offset+49),'Load estimated drafts');},
      getByRequest(organizationId,requestId){return providerResult(client.from('estimated_purchase_drafts').select('*,estimated_draft_submissions(purchase_order_id)').eq('organization_id',organizationId).eq('request_id',requestId).maybeSingle(),'Recover estimated draft');},
      save(input){return providerResult(client.rpc('kerdos_save_estimated_draft',{p_organization_id:input.organizationId,p_vendor_id:input.vendorId,p_request_id:input.requestId,p_lines:input.lines}),'Save estimated draft');},
      get(organizationId,draftId){return providerResult(client.from('estimated_purchase_drafts').select('*,estimated_draft_submissions(purchase_order_id)').eq('organization_id',organizationId).eq('id',draftId).maybeSingle(),'Load estimated draft');},
      cancel(organizationId,draftId){return providerResult(client.rpc('kerdos_cancel_estimated_draft',{p_organization_id:organizationId,p_draft_id:draftId}),'Cancel estimated draft');},
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
    variableWeight:{
      listApprovals(organizationId,vendorItemIds){
        if(!vendorItemIds.length)return Promise.resolve([]);
        return providerResult(client.from('variable_weight_approvals').select('*').eq('organization_id',organizationId).in('vendor_item_id',vendorItemIds).is('revoked_at',null),'Load variable-weight confirmations');
      },
      approve(row){return providerResult(client.rpc('kerdos_approve_variable_weight',{
        p_organization_id:row.organizationId,p_vendor_item_id:row.vendorItemId,p_mapping_id:row.mappingId,
        p_expected_revision:row.expectedRevision,p_intent:row.intent,
      }),'Confirm variable-weight terms');},
      revoke(row){return providerResult(client.rpc('kerdos_revoke_variable_weight',{
        p_organization_id:row.organizationId,p_approval_id:row.approvalId,
      }),'Revoke variable-weight confirmation');},
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

// Only the provider adapter names and invokes database procedures.
export function createSupabaseInbox(client) {
  return {
    beginManualReview(organizationId, attachmentId) {
      return providerResult(client.rpc("begin_manual_attachment_review", {
        p_organization_id:organizationId, p_attachment_id:attachmentId,
      }), "Reserve Inbox attachment");
    },
    markAttachmentIngested(_organizationId, attachmentId, importDocumentId, finalStatus=null) {
      return providerResult(client.rpc("mark_attachment_ingested", {
        p_attachment_id:attachmentId, p_import_document_id:importDocumentId, p_final_status:finalStatus,
      }), "Complete Inbox attachment");
    },
  };
}
