/**
 * inbound-email  —  Supabase Edge Function
 *
 * Receives Postmark inbound webhooks and queues attachments for review.
 *
 * Security model
 * ──────────────
 * • HTTP Basic authentication: Postmark sends Authorization: Basic base64(user:pass).
 *   Credentials are compared against POSTMARK_WEBHOOK_USERNAME and
 *   POSTMARK_WEBHOOK_PASSWORD env vars (set in Supabase Secrets).
 * • Service role key: the function uses SUPABASE_SERVICE_ROLE_KEY, which
 *   bypasses RLS. Every query is explicitly scoped to the organization_id
 *   resolved from the validated routing address. Cross-org data access is
 *   structurally impossible because organisation_id is read from
 *   email_routing_addresses before any other table is touched.
 *
 * Idempotency
 * ───────────
 * Postmark retries failed deliveries up to 10 times. The function checks
 * inbound_messages for postmark_message_id before inserting. If the record
 * already exists it falls through to attachment processing (idempotent)
 * and returns 200 once all attachments are durably stored.
 *
 * Attachment handoff
 * ──────────────────
 * The function does NOT attempt to parse attachment content. It:
 *   1. Decodes the base64 Content field from Postmark's JSON payload
 *   2. Uploads raw bytes to Supabase Storage at
 *      {orgId}/inbound/{messageId}/{attachmentIndex}
 *      (the original filename is kept in the DB row; omitted from the key)
 *   3. Writes an inbound_attachments row with import_document_id = null
 *
 * The browser UI then shows a "Review & Import" button. Clicking it fetches
 * the file from Storage, creates a File object, and opens PasteModal with
 * the file pre-loaded. fileToText() runs in the browser during that
 * interaction — vendor selection is still required — preserving the full
 * Interpret → Compare → Decide flow.
 *
 * Retry / transient error handling
 * ─────────────────────────────────
 * processAttachments() (in attachment-processor.mjs) throws on any
 * transient Storage or DB error.  The catch block here returns HTTP 500,
 * causing Postmark to retry.  Only permanent errors (malformed base64) are
 * logged-and-skipped inside the module.
 *
 * Environment variables required (set in Supabase Dashboard → Secrets)
 * ─────────────────────────────────────────────────────────────────────
 *   POSTMARK_WEBHOOK_USERNAME    — username for HTTP Basic auth
 *   POSTMARK_WEBHOOK_PASSWORD    — password for HTTP Basic auth
 *   SUPABASE_URL                 — injected automatically by Supabase
 *   SUPABASE_SERVICE_ROLE_KEY    — injected automatically by Supabase
 *   POSTMARK_SERVER_TOKEN        — required for optional email forwarding
 *   POSTMARK_FORWARD_FROM        — verified sender address used as From on
 *                                  forwarded messages (required if POSTMARK_SERVER_TOKEN is set)
 */

import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { processAttachments } from "./attachment-processor.mjs";

// ── Types ──────────────────────────────────────────────────────────────────

interface PostmarkAttachment {
  Name: string;
  Content: string;   // base64-encoded bytes
  ContentType: string;
  ContentLength: number;
}

interface PostmarkPayload {
  MessageID: string;
  OriginalRecipient: string;   // full To address; routing key
  FromFull: { Email: string; Name?: string };
  Subject?: string;
  TextBody?: string;
  Attachments?: PostmarkAttachment[];
}

// ── Optional forwarding ────────────────────────────────────────────────────
//
// If a routing address row has forward_to set, a plain-text copy of the
// inbound email is forwarded via Postmark's send API after successful storage.
//
// Limitations:
//   • Text body only — attachments and HTML body are NOT forwarded.
//   • Forwarding is best-effort: a failure is logged but never surfaces as an
//     HTTP 500, so Postmark does not retry the webhook on forward errors.
//   • We only forward on the FIRST successful processing (the fresh-message
//     path). Idempotent retries that land on the existing-message path skip
//     forwarding to avoid duplicate copies.
//
// Required env vars (set in Supabase Dashboard → Secrets):
//   POSTMARK_SERVER_TOKEN   — Postmark API token for sending
//   POSTMARK_FORWARD_FROM   — a Postmark-verified sender address used as the
//                             From address on forwarded messages; MUST be a
//                             verified sender in the Postmark account — using
//                             the inbound routing address as From would cause
//                             delivery failures because it is not verified.

interface ForwardParams {
  forwardTo:     string;
  originalFrom:  string;
  originalName:  string | null | undefined;
  subject:       string | null | undefined;
  bodyText:      string | null | undefined;
  originalTo:    string;    // the routing address that received it
}

async function forwardEmail(params: ForwardParams): Promise<void> {
  const token = Deno.env.get("POSTMARK_SERVER_TOKEN");
  if (!token) {
    console.warn("inbound-email: POSTMARK_SERVER_TOKEN not set; skipping forward");
    return;
  }

  // POSTMARK_FORWARD_FROM must be a verified sender address in the Postmark
  // account.  Using the inbound routing address (originalTo) as From would
  // cause delivery failures because inbound addresses are not verified senders.
  const fromAddress = Deno.env.get("POSTMARK_FORWARD_FROM");
  if (!fromAddress) {
    console.warn("inbound-email: POSTMARK_FORWARD_FROM not set; skipping forward to", params.forwardTo);
    return;
  }

  const { forwardTo, originalFrom, originalName, subject, bodyText, originalTo } = params;

  // Re-constitute a legible sender line, e.g. "Alice <alice@example.com>"
  const replyTo = originalName
    ? `${originalName} <${originalFrom}>`
    : originalFrom;

  // Note: only the text body is forwarded.  Attachments and HTML are not included.
  const body = {
    From:    fromAddress,          // verified Postmark sender address
    To:      forwardTo,
    ReplyTo: replyTo,
    Subject: subject ? `Fwd: ${subject}` : "(forwarded message)",
    TextBody: [
      `---------- Forwarded message ----------`,
      `From: ${replyTo}`,
      `To:   ${originalTo}`,
      subject ? `Subject: ${subject}` : "",
      "",
      bodyText ?? "(no text body)",
    ].filter(line => line !== null).join("\n"),
  };

  const res = await fetch("https://api.postmarkapp.com/email", {
    method:  "POST",
    headers: {
      "Accept":                  "application/json",
      "Content-Type":            "application/json",
      "X-Postmark-Server-Token": token,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "(unreadable)");
    console.error(`inbound-email: forward to ${forwardTo} failed — HTTP ${res.status}: ${text}`);
  }
}

// ── HTTP Basic auth ────────────────────────────────────────────────────────

function verifyBasicAuth(authHeader: string | null): boolean {
  if (!authHeader || !authHeader.startsWith("Basic ")) return false;
  const expectedUser = Deno.env.get("POSTMARK_WEBHOOK_USERNAME") ?? "";
  const expectedPass = Deno.env.get("POSTMARK_WEBHOOK_PASSWORD") ?? "";
  if (!expectedUser || !expectedPass) return false;

  try {
    const b64 = authHeader.slice("Basic ".length);
    const decoded = atob(b64);
    const colonIndex = decoded.indexOf(":");
    if (colonIndex < 0) return false;
    const user = decoded.slice(0, colonIndex);
    const pass = decoded.slice(colonIndex + 1);
    // Constant-time comparison to avoid timing attacks
    return timingSafeEqual(user, expectedUser) && timingSafeEqual(pass, expectedPass);
  } catch {
    return false;
  }
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let mismatch = 0;
  for (let i = 0; i < a.length; i++) {
    mismatch |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return mismatch === 0;
}

// ── Main handler ───────────────────────────────────────────────────────────

Deno.serve(async (req: Request): Promise<Response> => {
  // 1. Only accept POST
  if (req.method !== "POST") {
    return new Response("Method Not Allowed", { status: 405 });
  }

  // 2. Verify HTTP Basic credentials
  if (!verifyBasicAuth(req.headers.get("Authorization"))) {
    return new Response("Unauthorized", { status: 401 });
  }

  // 3. Parse Postmark JSON payload
  let payload: PostmarkPayload;
  try {
    payload = await req.json();
  } catch {
    return new Response("Bad Request: invalid JSON", { status: 400 });
  }

  const {
    MessageID: postmarkMessageId,
    OriginalRecipient: originalRecipient,
    FromFull,
    Subject: subject,
    TextBody: bodyText,
    Attachments: attachments = [],
  } = payload;

  if (!postmarkMessageId || !originalRecipient) {
    return new Response("Bad Request: missing MessageID or OriginalRecipient", { status: 400 });
  }

  // 4. Build Supabase admin client (service role key — bypasses RLS)
  const supabase = createClient(
    Deno.env.get("SUPABASE_URL") ?? "",
    Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "",
    { auth: { persistSession: false } }
  );

  // 5. Look up organization by routing address (case-insensitive)
  const normalizedAddress = originalRecipient.toLowerCase().trim();
  const { data: routingRow, error: routingErr } = await supabase
    .from("email_routing_addresses")
    .select("id, organization_id, forward_to")
    .eq("routing_address", normalizedAddress)
    .eq("is_active", true)
    .single();

  if (routingErr || !routingRow) {
    // Return 200 so Postmark does not retry unknown addresses forever.
    console.warn(`inbound-email: no active routing address for ${normalizedAddress}`);
    return new Response("OK", { status: 200 });
  }

  const { id: routingAddressId, organization_id: organizationId, forward_to: forwardTo } = routingRow;

  // 6. Idempotency check — if the message was already recorded, resume
  //    attachment processing in case a prior attempt crashed mid-way.
  const { data: existing } = await supabase
    .from("inbound_messages")
    .select("id")
    .eq("postmark_message_id", postmarkMessageId)
    .eq("organization_id", organizationId)
    .maybeSingle();

  if (existing) {
    try {
      await processAttachments(supabase, organizationId, existing.id, attachments);
    } catch (e) {
      console.error("inbound-email: attachment processing failed (existing message)", e);
      return new Response("Internal Server Error", { status: 500 });
    }
    return new Response("OK", { status: 200 });
  }

  // 7. Write inbound_messages row
  const { data: messageRow, error: msgErr } = await supabase
    .from("inbound_messages")
    .insert({
      organization_id: organizationId,
      routing_address_id: routingAddressId,
      postmark_message_id: postmarkMessageId,
      sender_email: FromFull.Email,
      sender_name: FromFull.Name ?? null,
      subject: subject ?? null,
      body_text: bodyText ?? null,
    })
    .select("id")
    .single();

  if (msgErr) {
    if ((msgErr as any)?.code === "23505") {
      // A concurrent retry won the INSERT race. Load the existing row and
      // resume attachment work; returning 200 without checking attachments
      // would silently drop any that the first request hadn't yet stored.
      const { data: raceRow, error: raceErr } = await supabase
        .from("inbound_messages")
        .select("id")
        .eq("postmark_message_id", postmarkMessageId)
        .eq("organization_id", organizationId)
        .single();

      if (raceErr || !raceRow) {
        // 23505 guarantees the row is there; treat as transient if we can't find it.
        console.error("inbound-email: 23505 but could not load existing message", raceErr);
        return new Response("Internal Server Error", { status: 500 });
      }

      try {
        await processAttachments(supabase, organizationId, raceRow.id, attachments);
      } catch (e) {
        console.error("inbound-email: attachment processing failed (23505 race)", e);
        return new Response("Internal Server Error", { status: 500 });
      }
      return new Response("OK", { status: 200 });
    }

    console.error("inbound-email: failed to insert message", msgErr);
    return new Response("Internal Server Error", { status: 500 });
  }

  if (!messageRow) {
    return new Response("Internal Server Error", { status: 500 });
  }

  // 8. Process attachments for a freshly-inserted message
  try {
    await processAttachments(supabase, organizationId, messageRow.id, attachments);
  } catch (e) {
    console.error("inbound-email: attachment processing failed (new message)", e);
    return new Response("Internal Server Error", { status: 500 });
  }

  // 9. Optional forwarding — best-effort; never fails the webhook
  if (forwardTo) {
    forwardEmail({
      forwardTo,
      originalFrom:  FromFull.Email,
      originalName:  FromFull.Name,
      subject,
      bodyText,
      originalTo:    normalizedAddress,
    }).catch(e => console.error("inbound-email: forward threw unexpectedly", e));
  }

  return new Response("OK", { status: 200 });
});
