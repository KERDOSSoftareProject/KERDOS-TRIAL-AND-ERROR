import { createClient } from "npm:@supabase/supabase-js@2.117.3";
import { createPriceSheetReviewHandler } from "./handler.mjs";

const url = Deno.env.get("SUPABASE_URL") ?? "";
const anonKey = Deno.env.get("SUPABASE_ANON_KEY") ?? "";
const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
const auth = { persistSession: false, autoRefreshToken: false };
const userClient = createClient(url, anonKey, {auth});
const service = createClient(url, serviceKey, {auth});

async function result<T>(query: PromiseLike<{data: T, error: {message: string} | null}>): Promise<T> {
  const {data, error} = await query;
  if (error) throw new Error(error.message);
  return data;
}

async function rows(table: string, organizationId: string, vendorId?: string) {
  const loaded = [];
  const size = 500;
  for (let offset = 0; ; offset += size) {
    let query = service.from(table).select(table === "invoices" ? "id,vendor_id,invoice_number,invoice_date,raw_text" : "*")
      .eq("organization_id", organizationId);
    if (vendorId) query = query.eq("vendor_id", vendorId);
    const page = await result(query.order("id").range(offset, offset + size - 1));
    if (!Array.isArray(page)) throw new Error(`Missing ${table} data`);
    loaded.push(...page);
    if (page.length < size) return loaded;
  }
}

const handler = createPriceSheetReviewHandler({
  secret: serviceKey,
  async authenticate(request: Request) {
    const token = request.headers.get("authorization")?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (!token) return null;
    const {data, error} = await userClient.auth.getUser(token);
    return error ? null : data.user?.id ?? null;
  },
  async membership(organizationId: string, actorId: string) {
    const member = await result(service.from("organization_members").select("role")
      .eq("organization_id", organizationId).eq("user_id", actorId).maybeSingle());
    return member?.role ?? null;
  },
  async loadWorkspace(organizationId: string, documentId: string | null) {
    const document = documentId
      ? await result(service.from("import_documents").select("*")
        .eq("organization_id", organizationId).eq("id", documentId).eq("document_kind", "pricelist").maybeSingle())
      : null;
    if (documentId && !document) return {document: null};
    const [organization, vocabulary, listings, mappings, catalogItems, categories, vendors] = await Promise.all([
      result(service.from("organizations").select("id,industry,settings").eq("id", organizationId).maybeSingle()),
      rows("org_vocabulary", organizationId),
      rows("vendor_items", organizationId),
      rows("item_mappings", organizationId),
      rows("catalog_items", organizationId),
      rows("catalog_categories", organizationId),
      rows("vendors", organizationId),
    ]);
    const documents = document ? [document] : [];
    if (!document) {
      const heldDocumentIds = [...new Set(listings.filter(row => row.import_row?.reviewRequired)
        .map(row => row.import_row?.sourceDocumentId).filter(id => typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)))].sort();
      for (let start = 0; start < heldDocumentIds.length; start += 100) {
        const batch = await result(service.from("import_documents").select("*").eq("organization_id", organizationId)
          .eq("document_kind", "pricelist").neq("status", "processing").in("id", heldDocumentIds.slice(start, start + 100)).order("id"));
        documents.push(...batch);
      }
    }
    const vendorIds = [...new Set(documents.map(doc => String(doc.vendor_id)))];
    const rawInvoices = (await Promise.all(vendorIds.map(vendorId => rows("invoices", organizationId, vendorId)))).flat();
    return {document, documents, organization, vocabulary, listings, mappings, catalogItems, categories, vendors, rawInvoices};
  },
  readOperation({organizationId, actorId, operationId, operation}: {
    organizationId: string, actorId: string, operationId: string, operation: string,
  }) {
    return result(service.rpc("kerdos_read_quote_unit_operation", {
      p_organization_id: organizationId, p_actor_id: actorId, p_operation_id: operationId, p_action: operation,
    }));
  },
  applyOperation({organizationId, actorId, operationId, operation, plan}: {
    organizationId: string, actorId: string, operationId: string, operation: string, plan: Record<string, unknown>,
  }) {
    return result(service.rpc("kerdos_apply_quote_unit_operation", {
      p_organization_id: organizationId, p_actor_id: actorId, p_operation_id: operationId, p_action: operation, p_plan: plan,
    }));
  },
  reportError(error: Error) { console.error("Price sheet review:", error.message); },
});

const headers = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Cache-Control": "no-store",
};
Deno.serve(async (request) => {
  if (request.method === "OPTIONS") return new Response(null, {status: 204, headers});
  if (request.method !== "POST") return Response.json({error: "Method not allowed."}, {status: 405, headers});
  const {status = 200, ...body} = await handler(request);
  return Response.json(body, {status, headers});
});
