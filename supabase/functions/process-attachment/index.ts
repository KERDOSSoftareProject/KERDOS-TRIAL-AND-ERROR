/**
 * process-attachment/index.ts
 *
 * Supabase Edge Function entry point for A1.2.e automatic attachment processing.
 *
 * Invoked by inbound-email/attachment-processor.mjs after it
 * stores each inbound attachment in Storage and the inbound_attachments table.
 *
 * Request body (JSON):
 *   { attachmentId: string, organizationId: string }
 *
 * Response: 200 for processed/review/skipped; 500 for operational failures.
 *   { outcome: "auto_imported" | "needs_review" | "failed" | "skipped", reason?: string }
 *
 * The function:
 *   1. Validates the request body.
 *   2. Resolves vendorId by joining inbound_attachments → inbound_messages →
 *      email_routing_addresses.  If the routing address has no vendor_id the
 *      attachment goes straight to needs_review.
 *   3. Claims the attachment via claim_attachment (pending → processing,
 *      issuing a lease token). Returns "skipped" if already handled.
 *   4. Runs processAttachmentInBackground — which updates processing_status and
 *      calls set_attachment_processing_status via service-backend.mjs.
 *   5. Returns the outcome JSON.
 *
 * Security: require the service-role bearer token before reading the body.
 *
 * Operational failures return HTTP 500 so inbound-email can retry the handoff.
 */

// @ts-ignore: Deno std path
import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createServiceBackend } from "./service-backend.mjs";
import { processAttachmentInBackground } from "./background-import.mjs";
import { authorizedServiceRequest } from "./request-auth.mjs";

// ── CORS headers (inbound-email is a peer function, not a browser) ─────────
// We still emit JSON content-type so any tooling parsing the response is happy.
const HEADERS = { "Content-Type": "application/json" };

serve(async (req: Request) => {
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if (!authorizedServiceRequest(req.headers.get("Authorization"), serviceKey)) {
    return new Response(JSON.stringify({ outcome: "failed", reason: "Unauthorized" }),
      { status: 401, headers: HEADERS });
  }
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
        { status: 500, headers: HEADERS }
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
      { status: 500, headers: HEADERS }
    );
  }

  // ── No vendor → needs_review immediately ──────────────────────────────────
  if (!vendorId) {
    if (attachment.processing_status !== "pending") {
      return new Response(JSON.stringify({ outcome: "skipped", reason: "attachment already handled" }),
        { status: 200, headers: HEADERS });
    }
    try {
      await backend.attachments.markNeedsReviewIfPending(
        attachmentId,
        "Routing address has no vendor assigned — manual review required."
      );
    } catch (e: any) {
      console.error("[process-attachment] setStatus(needs_review) failed:", e?.message);
      return new Response(JSON.stringify({ outcome: "failed", reason: "review status failed" }),
        { status: 500, headers: HEADERS });
    }
    return new Response(
      JSON.stringify({ outcome: "needs_review", reason: "no vendor on routing address" }),
      { status: 200, headers: HEADERS }
    );
  }

  // ── Claim the attachment and acquire its processing lease ──────────────────
  let claimed: string | null;
  try {
    claimed = await backend.attachments.claim(attachmentId);
  } catch (e: any) {
    console.error("[process-attachment] claim error:", e?.message);
    return new Response(
      JSON.stringify({ outcome: "failed", reason: "claim: " + (e?.message ?? "unknown") }),
      { status: 500, headers: HEADERS }
    );
  }

  if (!claimed) {
    // Another worker already transitioned this attachment out of pending.
    console.log(`[process-attachment] ${attachmentId} already claimed — skipping`);
    return new Response(
      JSON.stringify({ outcome: "skipped", reason: "already claimed by another worker" }),
      { status: 200, headers: HEADERS }
    );
  }

  // ── Run the import pipeline ────────────────────────────────────────────────
  // Renew during long rows, not only between rows. The database fence rejects
  // price and status writes after recovery revokes this token.
  let renewal: Promise<unknown> | null = null;
  const heartbeat = setInterval(() => {
    if (renewal) return;
    renewal = backend.attachments.renewLease()
      .catch((e: Error) => {
        backend.attachments.loseLease();
        console.error("[process-attachment] heartbeat failed:", e.message);
      })
      .finally(() => { renewal = null; });
  }, 120_000);
  try {
    const result = await processAttachmentInBackground(
      backend,
      attachment,
      { organizationId, vendorId }
    );
    backend.attachments.assertLease();
    return new Response(JSON.stringify(result), { status: 200, headers: HEADERS });
  } catch (e: any) {
    // Unhandled error inside the pipeline.  background-import.mjs is expected
    // to handle its own errors and update processing_status; this outer catch
    // only fires if it throws before completing that update.
    console.error("[process-attachment] pipeline error:", e?.message, e?.stack);
    // Keep operational failures retryable; never overwrite a recovered worker.
    if (!String(e?.message).includes("LEASE_LOST")) {
      try {
        await backend.attachments.setStatus(attachmentId, "needs_review", e?.message ?? "pipeline error");
      } catch (_) { /* the lease may already have been revoked */ }
    }
    return new Response(
      JSON.stringify({ outcome: "failed", reason: e?.message ?? "pipeline error" }),
      { status: 500, headers: HEADERS }
    );
  } finally {
    clearInterval(heartbeat);
    if (renewal) await renewal;
  }
});
