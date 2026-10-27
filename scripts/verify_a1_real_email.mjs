/**
 * scripts/verify_a1_real_email.mjs
 *
 * A1 real-email verification checklist and pre-flight inspector.
 *
 * Usage:
 *   node scripts/verify_a1_real_email.mjs
 *
 * This script does NOT send email or modify any data. It:
 *   1. Inspects the existing Postmark inbound setup via env vars and DB state.
 *   2. Checks kerdos_private.receiving_domains for platform domain configuration.
 *   3. Checks whether automatic receiving addresses have been provisioned.
 *   4. Prints the exact steps needed before a real-email test can proceed.
 *
 * Required env vars (same as the Edge Function):
 *   SUPABASE_URL              — kerdos-test project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service role key for kerdos_private access
 *
 * Optional (to inspect Postmark setup):
 *   POSTMARK_SERVER_TOKEN     — Postmark API token; read-only calls only
 */

import { createClient } from "@supabase/supabase-js";

const url            = process.env.SUPABASE_URL            ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const postmarkToken  = process.env.POSTMARK_SERVER_TOKEN   ?? "";

// ── helpers ──────────────────────────────────────────────────────────────

function pass(label) { console.log(`  ✓ ${label}`); }
function fail(label) { console.log(`  ✗ ${label}`); }
function info(label) { console.log(`  · ${label}`); }
function section(title) { console.log(`\n── ${title} ──`); }

// ── 1. env check ─────────────────────────────────────────────────────────

section("Environment");
if (url && serviceRoleKey) {
  pass(`SUPABASE_URL set (${url.slice(0, 40)}…)`);
  pass("SUPABASE_SERVICE_ROLE_KEY set");
} else {
  fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — set them and re-run");
  process.exit(1);
}
if (postmarkToken) {
  pass("POSTMARK_SERVER_TOKEN set — will inspect Postmark inbound streams");
} else {
  info("POSTMARK_SERVER_TOKEN not set — skipping Postmark API inspection");
}

// ── 2. DB checks ──────────────────────────────────────────────────────────

const supabase = createClient(url, serviceRoleKey, { auth: { persistSession: false } });

section("Platform domain configuration (kerdos_private.receiving_domains)");

// Service-role can read kerdos_private via rpc or direct query.
// The table has RLS disabled but schema is restricted to service_role.
const { data: domainRows, error: domainErr } = await supabase
  .rpc("kerdos_private_receiving_domains_read")
  .select("*")
  .catch(() => ({ data: null, error: { message: "RPC not available" } }));

// Fall back: direct query (works if running with service role)
let domains = domainRows;
let domainsErr = domainErr;
if (!domains) {
  const r = await supabase
    .schema("kerdos_private")
    .from("receiving_domains")
    .select("*");
  domains = r.data;
  domainsErr = r.error;
}

if (domainsErr) {
  fail(`Cannot read kerdos_private.receiving_domains: ${domainsErr.message}`);
  info("This table requires service_role access. If the migration is applied, check that");
  info("SUPABASE_SERVICE_ROLE_KEY matches the kerdos-test project.");
} else if (!domains || domains.length === 0) {
  fail("kerdos_private.receiving_domains is empty — platform domains not configured");
  info("Platform operator must INSERT one row with delivery-ready price_sheet_domain and invoice_domain.");
  info("Example (do not run until DNS and Postmark are confirmed ready):");
  info("  INSERT INTO kerdos_private.receiving_domains");
  info("    (price_sheet_domain, invoice_domain, delivery_ready)");
  info("  VALUES ('pricing.yourdomain.com', 'invoices.yourdomain.com', true);");
} else {
  const cfg = domains[0];
  if (cfg.delivery_ready) {
    pass(`price_sheet_domain: ${cfg.price_sheet_domain}  (delivery_ready = true)`);
    pass(`invoice_domain:     ${cfg.invoice_domain}  (delivery_ready = true)`);
    info("Automatic provisioning is active. Vendors should have receiving addresses.");
  } else {
    info(`price_sheet_domain: ${cfg.price_sheet_domain}  (delivery_ready = FALSE)`);
    info(`invoice_domain:     ${cfg.invoice_domain}  (delivery_ready = FALSE)`);
    fail("delivery_ready is false — automatic addresses are not provisioned yet.");
    info("Set delivery_ready = true only after DNS MX records and Postmark streams are verified.");
  }
}

// ── 3. Automatic receiving addresses ─────────────────────────────────────

section("Automatic receiving addresses (email_routing_addresses)");

const { data: autoAddrs, error: autoErr } = await supabase
  .from("email_routing_addresses")
  .select("routing_address, document_type, vendor_id, organization_id, is_active")
  .eq("is_automatic", true)
  .order("routing_address");

if (autoErr) {
  fail(`Cannot read email_routing_addresses: ${autoErr.message}`);
} else if (!autoAddrs || autoAddrs.length === 0) {
  fail("No automatic receiving addresses found");
  info("These are provisioned automatically when delivery_ready = true and vendors are active.");
} else {
  const active   = autoAddrs.filter(a => a.is_active);
  const inactive = autoAddrs.filter(a => !a.is_active);
  pass(`${active.length} active automatic address(es)`);
  for (const a of active) {
    info(`  ${a.routing_address}  [${a.document_type ?? "untyped"}]  vendor=${a.vendor_id?.slice(0,8)}`);
  }
  if (inactive.length) info(`${inactive.length} inactive (vendor deactivated or domain changed)`);
}

// ── 4. Existing test receiver ─────────────────────────────────────────────

section("Existing test / manual receiving addresses (do not reassign)");

const { data: manualAddrs, error: manualErr } = await supabase
  .from("email_routing_addresses")
  .select("routing_address, document_type, vendor_id, is_active")
  .eq("is_automatic", false)
  .order("routing_address");

if (manualErr) {
  fail(`Cannot read manual addresses: ${manualErr.message}`);
} else if (!manualAddrs || manualAddrs.length === 0) {
  info("No manual (non-automatic) routing addresses found");
} else {
  info(`${manualAddrs.length} manual address(es) — these must not be reassigned or overwritten:`);
  for (const a of manualAddrs) {
    info(`  ${a.routing_address}  [${a.document_type ?? "untyped"}]  active=${a.is_active}`);
  }
}

// ── 5. Postmark inspection ────────────────────────────────────────────────

if (postmarkToken) {
  section("Postmark inbound streams");

  try {
    const res = await fetch("https://api.postmarkapp.com/servers", {
      headers: {
        "Accept": "application/json",
        "X-Postmark-Account-Token": postmarkToken,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      fail(`Postmark API returned HTTP ${res.status} — check POSTMARK_SERVER_TOKEN`);
    } else {
      const body = await res.json();
      const servers = body.Servers ?? [];
      info(`Found ${servers.length} Postmark server(s):`);
      for (const s of servers) {
        info(`  [${s.ID}] ${s.Name}  InboundAddress: ${s.InboundAddress || "(none)"}`);
        if (s.InboundDomain) info(`       InboundDomain: ${s.InboundDomain}`);
      }
      // Look for inbound streams
      const withInbound = servers.filter(s => s.InboundAddress || s.InboundDomain);
      if (withInbound.length === 0) {
        fail("No Postmark server has an inbound address or domain configured");
        info("Add an inbound domain in the Postmark dashboard for each receiving domain.");
      } else {
        pass(`${withInbound.length} server(s) with inbound configuration`);
        info("Confirm MX records for each inbound domain point to inbound.postmarkapp.com (priority 10).");
      }
    }
  } catch (err) {
    fail(`Postmark API call failed: ${err.message}`);
  }
} else {
  section("Postmark inbound streams");
  info("Set POSTMARK_SERVER_TOKEN to inspect Postmark inbound stream configuration.");
  info("Required before real-email verification:");
  info("  · One inbound domain per receiving domain (price-sheet domain + invoice domain)");
  info("  · MX record for each domain → inbound.postmarkapp.com  priority 10");
  info("  · Webhook URL for each stream → https://<project>.supabase.co/functions/v1/inbound-email");
  info("  · Webhook auth: HTTP Basic  (POSTMARK_WEBHOOK_USERNAME:POSTMARK_WEBHOOK_PASSWORD)");
  info("  · SMTP must be enabled on the server for the webhook to fire on received mail");
}

// ── 6. Summary of what's still needed ────────────────────────────────────

section("What must be confirmed before setting delivery_ready = true");
console.log(`
  [ ] Domain ownership: confirm you control the price-sheet and invoice domains.
      Dino: supply the actual domain(s) — the platform operator inserts them.
  [ ] DNS MX records: each receiving domain must have MX → inbound.postmarkapp.com (priority 10).
      Verify with: dig MX <domain>  or  nslookup -type=MX <domain>
  [ ] Postmark inbound domains: each domain registered in the Postmark dashboard under
      an inbound stream, with the webhook pointing to the inbound-email Edge Function.
  [ ] Postmark webhook credentials: POSTMARK_WEBHOOK_USERNAME and POSTMARK_WEBHOOK_PASSWORD
      set in kerdos-test Supabase Secrets, matching the inbound stream's webhook auth.
  [ ] Existing test receiver: confirm its routing_address row stays untouched.
      The automatic provisioner only touches is_automatic=true rows.
  [ ] Inbound-email Edge Function deployed ACTIVE (confirmed in interaction gate).
`);

section("Real-email verification steps (run AFTER delivery_ready = true)");
console.log(`
  Step 1 — Price sheet:
    Send a real CSV price list to the provisioned price-sheet address for the test vendor.
    Expected: inbound_attachments row appears with processing_status = 'auto_imported'.
    Verify: SELECT processing_status, import_document_id FROM inbound_attachments ORDER BY created_at DESC LIMIT 5;
            SELECT status FROM import_documents WHERE id = <import_document_id>;
            SELECT COUNT(*) FROM price_history WHERE source_document_id = <import_document_id>;

  Step 2 — Invoice with valid lines:
    Send a real invoice CSV to the provisioned invoice address.
    Expected: processing_status = 'auto_imported', invoice saved with lines/qty/price.
    Verify: SELECT h.invoice_date, h.total_amount, COUNT(l.*) as lines
            FROM invoices h JOIN invoice_lines l ON l.invoice_id = h.id
            WHERE h.organization_id = '<org>'
            GROUP BY h.id ORDER BY h.created_at DESC LIMIT 1;

  Step 3 — Duplicate delivery:
    Re-send the same email (or the Postmark retry simulation).
    Expected: same auto_imported status, NO second invoice or import_document row.
    Verify: COUNT(*) of invoices and import_documents unchanged.

  Step 4 — Partial recovery (simulated):
    Use the recovery-sweep endpoint against a stuck 'processing' attachment (from fixtures
    or a forced hold). Expected: recovery sweep dispatches it, result is auto_imported or
    needs_review — never permanently stuck.

  Step 5 — Needs-review path:
    Send an invoice with arithmetic mismatch (qty * unit_price ≠ line_total).
    Expected: processing_status = 'needs_review', attachment appears in Inbox for manual review.

  Record each step result separately: local evidence | deployed evidence | real-email evidence.
  Do not mark A1 complete until Steps 1–5 have real-email evidence.
`);
