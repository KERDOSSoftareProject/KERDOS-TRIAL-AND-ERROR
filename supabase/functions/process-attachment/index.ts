/**
 * process-attachment/index.ts
 *
 * Supabase Edge Function entry point for A1.2.e automatic attachment processing.
 *
 * Invoked by inbound-email/attachment-processor.mjs (fire-and-forget) after it
 * stores each inbound attachment in Storage and the inbound_attachments table.
 *
 * Request body (JSON):
 *   { attachmentId: string, organizationId: string }
 *
 * Response (always 200 so inbound-email does not retry):
 *   { outcome: "auto_imported" | "needs_review" | "failed" | "skipped", reason?: string }
 *
 * The function:
 *   1. Validates the request body.
 *   2. Resolves vendorId by joining inbound_attachments → inbound_messages →
 *      email_routing_addresses.  If the routing address has no vendor_id the
 *      attachment goes straight to needs_review.
 *   3. Claims the attachment (atomic processing_status CAS: pending/needs_review
 *      → processing).  Returns "skipped" if another worker beat us to it.
 *   4. Runs processAttachmentInBackground — which updates processing_status and
 *      calls set_attachment_processing_status via service-backend.mjs.
 *   5. Returns the outcome JSON.
 *
 * Security: uses the service-role key (bypasses RLS).  The request is not
 * user-facing — it is only called by the inbound-email function on the same
 * project.  No auth header is required because both functions share the
 * service-role key and the attachment record has already been validated by the
 * caller.
 *
 * The function never throws to its caller; all errors are caught and turned
 * into a { outcome: "failed" } JSON response.
 */

// @ts-ignore: Deno std path
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createServiceBackend } from "./service-backend.mjs";
import { processAttachmentInBackground } from "./background-import.mjs";

// ── CORS headers (inbound-email is a peer function, not a browser) ─────────
// We still emit JSON content-type so any tooling parsing the response is happy.
const HEADERS = { "Content-Type": "application/json" };

serve(async (req: Request) => {
  // ── Parse body ─────────────────────────────────────────────────────────────
  let attachmentId: string;
  let organizationId: string;

  try {
    const body = await req.json();
    attachmentId  = body?.attachmentId;
    organizationId = body?.organizationId;
    if (!attachmentId || !organizationId) {
      return new Response(
        JSON.stringify({ outcome: "failed", reason: "attachmentId and organizationId are required" }),
        { status: 400, headers: HEADERS }
      );
    }
  } catch (e) {
    return new Response(
      JSON.stringify({ outcome: "failed", reason: "invalid JSON body" }),
      { status: 400, headers: HEADERS }
    );
  }

  // ── Build service-role backend ─────────────────────────────────────────────
  let backend: ReturnType<typeof createServiceBackend>;
  try {
    backend = createServiceBackend();
  } catch (e: any) {
    // Missing env vars — deployment misconfiguration.
    console.error("[process-attachment] backend init failed:", e?.message);
    return new Response(
      JSON.stringify({ outcome: "failed", reason: "backend init: " + (e?.message ?? "unknown") }),
      { status: 500, headers: HEADERS }
    );
  }

  const supabase = backend._supabase;

  // ── Resolve vendorId ───────────────────────────────────────────────────────
  //
  // Join: inbound_attachments → inbound_messages → email_routing_addresses
  //
  // email_routing_addresses.vendor_id (nullable) was added in
  // migration_033_auto_processing.sql.  When NULL the routing address has no
  // vendor mapping; we cannot run the import pipeline without one.
  let attachment: Record<string, unknown>;
  let vendorId: string | null;

  try {
    const { data, error } = await supabase
      .from("inbound_attachments")
      .select(`
        id, organization_id, filename, content_type, file_size_bytes,
        storage_path, processing_status,
        inbound_messages (
          email_routing_addresses ( vendor_id )
        )
      `)
      .eq("id", attachmentId)
      .eq("organization_id", organizationId)
      .single();

    if (error || !data) {
      const reason = error?.message ?? "attachment not found";
      console.error("[process-attachment] attachment lookup failed:", reason);
      return new Response(
        JSON.stringify({ outcome: "failed", reason }),
        { status: 200, headers: HEADERS }
      );
    }

    attachment = data as Record<string, unknown>;

    // Drill into the nested join result (Supabase returns array for 1:many,
    // object for many:1).
    const msg = (data as any).inbound_messages;
    const era = msg?.email_routing_addresses;
    vendorId = era?.vendor_id ?? null;
  } catch (e: any) {
    console.error("[process-attachment] routing lookup error:", e?.message);
    return new Response(
      JSON.stringify({ outcome: "failed", reason: e?.message ?? "routing lookup failed" }),
      { status: 200, headers: HEADERS }
    );
  }

  // ── No vendor → needs_review immediately ──────────────────────────────────
  if (!vendorId) {
    try {
      await backend.attachments.setStatus(
        attachmentId,
        "needs_review",
        "Routing address has no vendor assigned — manual review required."
      );
    } catch (e: any) {
      console.error("[process-attachment] setStatus(needs_review) failed:", e?.message);
    }
    return new Response(
      JSON.stringify({ outcome: "needs_review", reason: "no vendor on routing address" }),
      { status: 200, headers: HEADERS }
    );
  }

  // ── Claim the attachment (optimistic lock) ─────────────────────────────────
  let claimed: boolean;
  try {
    claimed = await backend.attachments.claim(attachmentId);
  } catch (e: any) {
    console.error("[process-attachment] claim error:", e?.message);
    return new Response(
      JSON.stringify({ outcome: "failed", reason: "claim: " + (e?.message ?? "unknown") }),
      { status: 200, headers: HEADERS }
    );
  }

  if (!claimed) {
    // Another worker already transitioned this attachment out of
    // pending/needs_review.  Not an error — idempotent skip.
    console.log(`[process-attachment] ${attachmentId} already claimed — skipping`);
    return new Response(
      JSON.stringify({ outcome: "skipped", reason: "already claimed by another worker" }),
      { status: 200, headers: HEADERS }
    );
  }

  // ── Run the import pipeline ────────────────────────────────────────────────
  try {
    const result = await processAttachmentInBackground(
      backend,
      attachment,
      { organizationId, vendorId }
    );
    return new Response(JSON.stringify(result), { status: 200, headers: HEADERS });
  } catch (e: any) {
    // Unhandled error inside the pipeline.  background-import.mjs is expected
    // to handle its own errors and update processing_status; this outer catch
    // only fires if it throws before completing that update.
    console.error("[process-attachment] pipeline error:", e?.message, e?.stack);
    try {
      await backend.attachments.setStatus(attachmentId, "failed", e?.message ?? "pipeline error");
    } catch (_) {
      // best-effort; don't let a status write failure mask the original error
    }
    return new Response(
      JSON.stringify({ outcome: "failed", reason: e?.message ?? "pipeline error" }),
      { status: 200, headers: HEADERS }
    );
  }
});
