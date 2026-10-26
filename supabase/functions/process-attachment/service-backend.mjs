/**
 * service-backend.mjs
 *
 * Production backend factory for the process-attachment Edge Function.
 *
 * Returns an object matching the interface required by background-import.mjs
 * and tested by process-attachment-test.mjs:
 *
 *   {
 *     kind: "service",
 *     records,              // createRecords(execute) — KERDOS query vocabulary
 *     pricing,              // { applyQuote(quote) }
 *     catalog,              // { matchOrCreate() } — stubs for browser-only ops
 *     orgSettings,          // { vendorLayouts(organizationId) }
 *     attachments,          // { download, claim, setStatus }
 *   }
 *
 * Uses the Supabase service-role key (bypasses RLS).  The calling index.ts
 * has already validated the organization via the routing address before this
 * factory is called, so service-role access here is intentional and bounded.
 *
 * Environment variables (injected by Supabase; set no additional secrets here):
 *   SUPABASE_URL              — project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service role JWT
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { createRecords } from "../../../src/backend/records.js";

// ── Supabase record query executor ────────────────────────────────────────────
//
// Mirrors executeSupabaseRecordQuery from src/backend/supabase.js.
// Kept local so this module has no browser-side imports.

function executeSupabaseRecordQuery(client, spec) {
  let q = client.from(spec.table);
  if      (spec.action === "select") q = q.select(spec.columns || "*");
  else if (spec.action === "delete") q = q.delete();
  else if (["insert", "update", "upsert"].includes(spec.action)) q = q[spec.action](spec.value);
  else throw new Error(`Unsupported KERDOS records action: ${spec.action}`);

  // When an insert/update/upsert specifies columns, chain a .select() so the
  // response contains the requested fields (Supabase v2 convention).
  if (spec.action !== "select" && spec.columns) q = q.select(spec.columns);

  for (const { operator, column, value } of spec.filters) q = q[operator](column, value);
  for (const { column, options } of spec.orders) q = q.order(column, options);
  if (spec.range)            q = q.range(spec.range.from, spec.range.to);
  if (spec.limit !== undefined) q = q.limit(spec.limit);
  if (spec.cardinality)      q = q[spec.cardinality]();
  return q;
}

// ── Factory ───────────────────────────────────────────────────────────────────

/**
 * Create the service-role backend for one Edge Function invocation.
 *
 * @param {{ url?: string, serviceRoleKey?: string }} [opts]
 *   Override the default env-var values; used only in integration tests.
 * @returns {object} backend compatible with background-import.mjs
 */
export function createServiceBackend({
  url             = Deno.env.get("SUPABASE_URL")              ?? "",
  serviceRoleKey  = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
} = {}) {
  if (!url || !serviceRoleKey) {
    throw new Error(
      "createServiceBackend: SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required"
    );
  }

  const supabase = createClient(url, serviceRoleKey, {
    auth: { persistSession: false },
  });

  // ── records ──────────────────────────────────────────────────────────────
  const records = createRecords(spec => executeSupabaseRecordQuery(supabase, spec));

  // ── pricing ──────────────────────────────────────────────────────────────
  //
  // Uses kerdos_auto_apply_price_quote — the service-role variant of
  // kerdos_apply_price_quote.  Identical parameters and return value (new
  // vendor_item id) but skips the auth.uid() caller check since the service
  // role has no user JWT.  Added in migration_033_auto_processing.sql.
  const pricing = {
    applyQuote(quote) {
      return supabase
        .rpc("kerdos_auto_apply_price_quote", {
          p_vendor_item_id:     quote.vendorItemId      || null,
          p_organization_id:    quote.organizationId,
          p_vendor_id:          quote.vendorId,
          p_vendor_item_code:   quote.vendorItemCode    || null,
          p_description:        quote.description,
          p_pack_size:          quote.packSize          || null,
          p_price:              quote.price             ?? null,
          p_price_unavailable:  !!quote.priceUnavailable,
          p_effective_date:     quote.effectiveDate,
          p_quote_valid_until:  quote.quoteValidUntil   || null,
          p_source_file_path:   quote.sourceFilePath    || null,
          p_source_file_name:   quote.sourceFileName    || null,
          p_source_line:        quote.sourceLine        || null,
          p_source_document_id: quote.sourceDocumentId,
          p_selling_unit:       quote.sellingUnit       || null,
          p_price_basis:        quote.priceBasis        || null,
          p_gtin:               quote.gtin              || null,
          p_manufacturer_code:  quote.manufacturerCode  || null,
          p_import_row:         quote.importRow         || null,
          p_field_resolutions:  quote.fieldResolutions  || null,
          p_brand:              quote.brand             || null,
        })
        .then(({ data, error }) => {
          if (error) throw new Error(`kerdos_auto_apply_price_quote: ${error.message}`);
          return data;
        });
    },
  };

  // ── catalog ──────────────────────────────────────────────────────────────
  //
  // matchOrCreate is handled by createCatalogService(backend) using
  // backend.records — the catalog field here is for browser-only
  // operations that are not available in background processing.
  const catalog = {
    matchOrCreate: () => Promise.resolve(null),
    groupAutomaticAlternatives:    () => { throw new Error("not available in background processing"); },
    separateAutomaticAlternatives: () => { throw new Error("not available in background processing"); },
    associateAlternatives:         () => { throw new Error("not available in background processing"); },
    saveRow:                       () => { throw new Error("not available in background processing"); },
  };

  // ── orgSettings ──────────────────────────────────────────────────────────
  //
  // Returns the vendorLayouts portion of organizations.settings (JSONB).
  // background-import.mjs passes this to sheet-layout helpers when resolving
  // remembered column-header layouts for a vendor.
  const orgSettings = {
    async vendorLayouts(organizationId) {
      const { data, error } = await supabase
        .from("organizations")
        .select("settings")
        .eq("id", organizationId)
        .single();
      if (error) throw new Error(`orgSettings.vendorLayouts: ${error.message}`);
      return data?.settings?.vendorLayouts ?? {};
    },
  };

  // ── attachments ──────────────────────────────────────────────────────────

  const attachments = {
    /**
     * Download raw bytes for an inbound attachment from the "documents" bucket.
     *
     * @param {string} storagePath — e.g. "{orgId}/inbound/{messageId}/{index}"
     * @returns {Promise<Uint8Array>}
     */
    async download(storagePath) {
      const { data, error } = await supabase.storage
        .from("documents")
        .download(storagePath);
      if (error) throw new Error(`attachments.download: ${error.message}`);
      // Supabase returns a Blob; convert to Uint8Array for the file reader.
      return new Uint8Array(await data.arrayBuffer());
    },

    /**
     * Atomically claim the attachment for processing.
     *
     * Transitions processing_status from 'pending' or 'needs_review' to
     * 'processing'.  Returns true if the claim succeeded, false if another
     * worker already holds it (concurrent invocation).
     *
     * The condition `processing_status IN ('pending','needs_review')` lets
     * index.ts re-process a 'needs_review' attachment when explicitly retried
     * (e.g. after a vendor is assigned to the routing address).
     *
     * @param {string} attachmentId
     * @returns {Promise<boolean>}
     */
    async claim(attachmentId) {
      const { data, error } = await supabase
        .from("inbound_attachments")
        .update({ processing_status: "processing" })
        .eq("id", attachmentId)
        .in("processing_status", ["pending", "needs_review"])
        .select("id")
        .maybeSingle();
      if (error) throw new Error(`attachments.claim: ${error.message}`);
      return data !== null;
    },

    /**
     * Record the outcome of processing for an attachment.
     *
     * Calls set_attachment_processing_status() — the SECURITY DEFINER
     * service-role function from migration_033_auto_processing.sql.
     * When docId is supplied (auto_imported or needs_review), the attachment
     * is linked to the import document in the same DB transaction.
     *
     * @param {string}      attachmentId
     * @param {string}      status        — 'auto_imported' | 'needs_review' | 'failed' | 'processing'
     * @param {string|null} [reason]      — human-readable reason for needs_review/failed
     * @param {string|null} [docId]       — import_document id to link
     */
    async setStatus(attachmentId, status, reason = null, docId = null) {
      const { error } = await supabase.rpc("set_attachment_processing_status", {
        p_attachment_id:      attachmentId,
        p_status:             status,
        p_error:              reason ?? null,
        p_import_document_id: docId   ?? null,
      });
      if (error) throw new Error(`attachments.setStatus: ${error.message}`);
    },
  };

  return {
    kind: "service",
    records,
    pricing,
    catalog,
    orgSettings,
    attachments,
    // Expose the raw client for use by index.ts (routing-address lookup, etc.)
    _supabase: supabase,
  };
}
