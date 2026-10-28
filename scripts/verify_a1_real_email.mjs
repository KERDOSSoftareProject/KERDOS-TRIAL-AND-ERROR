/**
 * scripts/verify_a1_real_email.mjs
 *
 * A1 real-email pre-flight inspector.
 *
 * Usage:
 *   node scripts/verify_a1_real_email.mjs
 *
 * This script does NOT send email or modify any data.
 * Exits 1 on failure, 2 while acceptance remains unverified. Never claims a live pass.
 * Default: test receiver. A1_RECEIVER_MODE=custom-domain inspects future domain setup.
 *
 * Required:
 *   SUPABASE_URL              — kerdos-test project URL
 *   SUPABASE_SERVICE_ROLE_KEY — service role key (for email_routing_addresses via RLS bypass)
 *
 * Required to check kerdos_private.receiving_domains:
 *   DATABASE_URL              — postgres connection string (service role or superuser)
 *                               e.g. postgresql://postgres:<password>@db.<ref>.supabase.co:5432/postgres
 *                               kerdos_private is not exposed via the REST API, so direct SQL is needed.
 *
 * Optional:
 *   POSTMARK_SERVER_TOKEN     — Postmark server token (X-Postmark-Server-Token);
 *                               used with GET /server to inspect the current server's inbound config.
 */

import { createClient } from "@supabase/supabase-js";

const supabaseUrl    = process.env.SUPABASE_URL            ?? "";
const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";
const databaseUrl    = process.env.DATABASE_URL            ?? "";
const postmarkToken  = process.env.POSTMARK_SERVER_TOKEN   ?? "";

// ── helpers ──────────────────────────────────────────────────────────────

let failures = 0;
let unverified = 0;
const testMode = process.env.A1_RECEIVER_MODE !== "custom-domain";
const organizationId = process.env.A1_ORGANIZATION_ID;
const vendorId = process.env.A1_VENDOR_ID;
const testAddresses = [process.env.A1_PRICE_ADDRESS, process.env.A1_INVOICE_ADDRESS];
function pending(label) { unverified++; info(`UNVERIFIED: ${label}`); }

function pass(label) { console.log(`  ✓ ${label}`); }
function fail(label) { failures++; console.log(`  ✗ ${label}`); }
function info(label) { console.log(`  · ${label}`); }
function section(title) { console.log(`\n── ${title} ──`); }

// ── 1. env check ─────────────────────────────────────────────────────────

section("Environment");

if (supabaseUrl !== "https://gwtnaudjfoxjermhvhpx.supabase.co") {
  fail("This inspector is restricted to kerdos-test."); process.exit(1);
}
if (testMode && (!organizationId || !vendorId || testAddresses.some(a => !a))) {
  fail("Set A1_ORGANIZATION_ID, A1_VENDOR_ID, A1_PRICE_ADDRESS and A1_INVOICE_ADDRESS for the isolated test."); process.exit(1);
}
if (supabaseUrl && serviceRoleKey) {
  pass(`SUPABASE_URL set (${supabaseUrl.slice(0, 45)}…)`);
  pass("SUPABASE_SERVICE_ROLE_KEY set");
} else {
  fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — set them and re-run");
  process.exit(1);
}

if (testMode) {
  info("Existing Postmark receiver mode: owned domains and delivery_ready are not prerequisites.");
} else if (databaseUrl) {
  pass("DATABASE_URL set — will query kerdos_private.receiving_domains via postgres");
} else {
  info("DATABASE_URL not set — will print SQL to run manually in the Supabase SQL editor");
  info("  kerdos_private is intentionally excluded from the REST API; direct SQL is required.");
}

if (postmarkToken) {
  pass("POSTMARK_SERVER_TOKEN set — will inspect Postmark server inbound config");
} else {
  info("POSTMARK_SERVER_TOKEN not set — skipping Postmark API inspection");
}

// ── 2. kerdos_private.receiving_domains ──────────────────────────────────
//
// This schema is not exposed via Supabase REST. The only correct paths are:
//   a) Direct postgres connection (DATABASE_URL)
//   b) A SECURITY DEFINER function in the public schema (none exists yet)
//   c) Manual SQL in the Supabase dashboard

if (!testMode) {
section("Platform domain configuration (kerdos_private.receiving_domains)");

if (databaseUrl) {
  // Lazy-import postgres client — available in Node without install if pg is present,
  // otherwise fall through to the manual-SQL path.
  let sql;
  try {
    const { default: postgres } = await import("postgres");
    sql = postgres(databaseUrl, { max: 1, ssl: "require" });
  } catch {
    try {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: true } });
      sql = { query: (q) => pool.query(q), end: () => pool.end() };
    } catch {
      sql = null;
    }
  }

  if (!sql) {
    fail("DATABASE_URL is set but neither 'postgres' nor 'pg' npm packages are available");
    info("Run: npm install postgres  (or pg)  then retry, or use the manual SQL below.");
  } else {
    try {
      let rows;
      if (typeof sql === "function") {
        // postgres (slonik-style tagged template)
        rows = await sql`SELECT price_sheet_domain, invoice_domain, delivery_ready FROM kerdos_private.receiving_domains LIMIT 1`;
        await sql.end();
      } else {
        // pg Pool
        const result = await sql.query(
          "SELECT price_sheet_domain, invoice_domain, delivery_ready FROM kerdos_private.receiving_domains LIMIT 1"
        );
        rows = result.rows;
        await sql.end();
      }

      if (!rows || rows.length === 0) {
        fail("kerdos_private.receiving_domains is empty — platform domains not configured");
        info("Platform operator must INSERT one row:");
        info("  INSERT INTO kerdos_private.receiving_domains");
        info("    (price_sheet_domain, invoice_domain, delivery_ready)");
        info("  VALUES ('pricing.yourdomain.com', 'invoices.yourdomain.com', true);");
        info("  Do not run this until DNS MX records and Postmark streams are verified.");
      } else {
        const cfg = rows[0];
        if (cfg.delivery_ready) {
          pass(`price_sheet_domain: ${cfg.price_sheet_domain}  (delivery_ready = true)`);
          pass(`invoice_domain:     ${cfg.invoice_domain}  (delivery_ready = true)`);
          info("Automatic address provisioning is active.");
        } else {
          fail("delivery_ready = false — automatic addresses are not provisioned yet");
          info(`price_sheet_domain: ${cfg.price_sheet_domain}`);
          info(`invoice_domain:     ${cfg.invoice_domain}`);
          info("Set delivery_ready = true only after DNS and Postmark are verified.");
        }
      }
    } catch {
      fail("postgres query failed; inspect connection details privately.");
      info("Check that DATABASE_URL is correct and the database is reachable.");
    }
  }
} else {
  info("Run the following in the Supabase SQL editor to check domain configuration:");
  info("  SELECT price_sheet_domain, invoice_domain, delivery_ready");
  info("  FROM kerdos_private.receiving_domains;");
  pending("Domain configuration has not been queried. Expected: one delivery-ready row.");
  info("If the table is empty, platform domains have not been configured yet.");
}

}

// ── 3. Automatic receiving addresses ─────────────────────────────────────
// email_routing_addresses is in the public schema; service role bypasses RLS.

section(testMode ? "Isolated test receiving registrations" : "Automatic receiving addresses");

const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

let routeQuery = supabase
  .from("email_routing_addresses")
  .select("routing_address, document_type, vendor_id, organization_id, is_active")
  .order("routing_address");
routeQuery = testMode
  ? routeQuery.eq("organization_id", organizationId).eq("vendor_id", vendorId).in("routing_address", testAddresses)
  : routeQuery.eq("is_automatic", true);
const { data: autoAddrs, error: autoErr } = await routeQuery;

if (autoErr) {
  fail("Cannot read receiving registrations.");
} else if (!autoAddrs || autoAddrs.length === 0) {
  fail("No matching receiving registrations found");
  info("Addresses are provisioned when delivery_ready = true and vendors are active.");
  info("If delivery_ready is already true, check that vendors exist and are active.");
} else {
  const active   = autoAddrs.filter(a => a.is_active);
  const inactive = autoAddrs.filter(a => !a.is_active);
  if (active.length > 0) {
    pass(`${active.length} active receiving registration(s)`);
    for (const a of active) {
      info(`  ${a.routing_address}  [${a.document_type ?? "untyped"}]  vendor=${a.vendor_id?.slice(0, 8)}`);
    }
  } else {
    fail("Automatic addresses exist but none are active");
  }
  if (testMode && !["pricelist", "invoice"].every((type, i) => active.some(a => a.document_type === type && a.routing_address === testAddresses[i]))) fail("Both test addresses must have their expected document type.");
  if (inactive.length) info(`${inactive.length} inactive (vendor deactivated or domain changed)`);
}

// ── 4. Manual / test receiving addresses (must not be touched) ────────────

section("Manual receiving addresses (do not reassign)");

const { data: manualAddrs, error: manualErr } = await supabase
  .from("email_routing_addresses")
  .select("routing_address, document_type, vendor_id, is_active")
  .eq("is_automatic", false)
  .order("routing_address");

if (manualErr) {
  fail("Cannot read test/manual addresses.");
} else if (!manualAddrs || manualAddrs.length === 0) {
  info("No manual routing addresses found");
} else {
  info(`${manualAddrs.length} manual address(es) — must not be reassigned or overwritten:`);
  for (const a of manualAddrs) {
    info(`  ${a.routing_address}  [${a.document_type ?? "untyped"}]  active=${a.is_active}`);
  }
}

// ── 5. Postmark server inbound configuration ──────────────────────────────
//
// POSTMARK_SERVER_TOKEN is a per-server credential, not an account token.
// The correct endpoint for server-level inspection is GET /server
// using the X-Postmark-Server-Token header.
// The /servers (plural) endpoint requires an account token — a different credential.

if (postmarkToken) {
  section("Postmark server inbound configuration");

  try {
    const res = await fetch("https://api.postmarkapp.com/server", {
      headers: {
        "Accept": "application/json",
        "X-Postmark-Server-Token": postmarkToken,
      },
      signal: AbortSignal.timeout(10_000),
    });

    if (res.status === 401) {
      fail("Postmark returned 401 — check that POSTMARK_SERVER_TOKEN is a valid server token");
    } else if (!res.ok) {
      fail(`Postmark GET /server returned HTTP ${res.status}`);
    } else {
      const s = await res.json();
      info(`Server: [${s.ID}] ${s.Name}`);

      const inboundDomain  = s.InboundDomain  || null;
      const inboundAddress = s.InboundAddress || null;
      const inboundHookUrl = s.InboundHookUrl || null;

      if (inboundDomain) {
        pass(`InboundDomain: ${inboundDomain}`);
      } else {
        if (!testMode) fail("InboundDomain is not set for custom-domain mode.");
        else info("Custom InboundDomain is not needed for the Postmark test receiver.");
      }

      if (inboundAddress) {
        info(`InboundAddress (test stream): ${inboundAddress}`);
        if (testMode && testAddresses.some(a => a.replace(/\+[^@]+@/, "@") !== inboundAddress)) fail("Test aliases do not match this Postmark receiver.");
      }

      if (inboundHookUrl) {
        const hook = new URL(inboundHookUrl);
        info("Webhook URL credentials are withheld.");
        if (hook.origin !== supabaseUrl || hook.pathname !== "/functions/v1/inbound-email" || hook.search || hook.hash) {
          fail("InboundHookUrl does not look like the inbound-email Edge Function — verify it");
        }
      } else {
        fail("InboundHookUrl is not set — webhook must point to the inbound-email Edge Function");
      }
    }
  } catch {
    fail("Postmark API inspection failed; error details withheld to protect credentials.");
  }
} else {
  section("Postmark server inbound configuration");
  pending("Postmark configuration not inspected; server token is unavailable.");
  info(testMode ? "Test receiver requires a working authenticated webhook; owned domains are unnecessary." : "Custom-domain requirements:");
  if (!testMode) info("  · InboundDomain registered for each receiving domain (price-sheet + invoice)");
  if (!testMode) info("  · MX record for each domain → inbound.postmarkapp.com  priority 10");
  info("  · InboundHookUrl → https://<ref>.supabase.co/functions/v1/inbound-email");
  info("  · Webhook Basic auth matching POSTMARK_WEBHOOK_USERNAME / POSTMARK_WEBHOOK_PASSWORD");
}

// ── 6. Pre-flight checklist ───────────────────────────────────────────────

if (!testMode) {
section("Custom-domain checklist (future platform setup)");
console.log(`
  [ ] Future domain ownership: configure when actual domains are acquired.
  [ ] DNS MX records: each receiving domain → inbound.postmarkapp.com  priority 10
        dig MX <domain>   or   nslookup -type=MX <domain>
  [ ] Postmark InboundDomain registered for each receiving domain.
  [ ] Postmark InboundHookUrl → inbound-email Edge Function URL.
  [ ] POSTMARK_WEBHOOK_USERNAME and POSTMARK_WEBHOOK_PASSWORD set in Supabase Secrets.
  [ ] Existing manual routing addresses unchanged (provisioner only touches is_automatic=true).
  [ ] inbound-email Edge Function deployed and ACTIVE on kerdos-test.
`);

}

// ── 7. Real-email verification steps ─────────────────────────────────────

section("Real-email verification steps (registered Postmark test aliases are sufficient)");
console.log(`
  Step 1 — Price sheet:
    Send a real CSV price list to the provisioned price-sheet address for the test vendor.
    Pass: auto_imported plus stored original and a linked complete document containing the expected 10.37 price.
    SQL:  SELECT processing_status, import_document_id
          FROM inbound_attachments ORDER BY created_at DESC LIMIT 5;
          SELECT COUNT(*) FROM price_history WHERE source_document_id = <import_document_id>;

  Step 2 — Invoice with valid lines:
    Send a real invoice CSV to the provisioned invoice address.
    Pass: auto_imported plus stored original, correct receipt ownership/type, and exact expected invoice header/lines/qty/price/total.
    SQL:  SELECT h.invoice_date, h.total_amount, COUNT(l.*) AS lines
          FROM invoices h JOIN invoice_lines l ON l.invoice_id = h.id
          GROUP BY h.id ORDER BY h.created_at DESC LIMIT 1;

  Step 3 — Duplicate delivery:
    Re-send the same email (or use Postmark retry simulation).
    Pass: no second invoice or import_document row created.
    SQL:  Confirm COUNT(*) of invoices and import_documents unchanged.

  Step 4 — Partial recovery:
    Use only an isolated expired-worker fixture; never reset an active lease or client attachment.
    Observe the approved recovery-sweep schedule dispatching it.
    Pass for a valid fixture: auto_imported with the expected saved values and no duplicate rows.
    needs_review is an exception result to investigate, not a successful valid-file automation pass.

  Step 5 — Needs-review path:
    Send an invoice with an arithmetic mismatch (qty * unit_price ≠ line_total).
    Pass: processing_status = 'needs_review'; attachment visible in Inbox.

  Scope every SQL query to A1_ORGANIZATION_ID and the exact fixture message/document.
  Global latest-row queries above are illustrative only, never acceptance evidence.
  Evidence categories must be recorded separately:
    local evidence       — already confirmed (passing unit/PGlite tests)
    deployed evidence    — deployed synthetic tests (confirmed via Supabase deployment #60)
    real-email evidence  — Steps 1–5 above; Task 1 stays open until this is complete.
`);

pending("Real-email saved originals, exact line/price values, duplicate delivery and recovery must be observed separately; Inbox arrival/status alone is not a pass.");

// ── exit ─────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.log(`\n  ${failures} check(s) failed — resolve them before proceeding.\n`);
  process.exit(1);
} else if (unverified > 0) {
  console.log(`\n  ${unverified} check(s) remain unverified; Task 1 stays open.\n`);
  process.exit(2);
} else {
  process.exit(0);
}
