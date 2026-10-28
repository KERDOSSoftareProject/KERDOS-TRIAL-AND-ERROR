/**
 * scripts/verify_a1_real_email.mjs
 *
 * A1 real-email pre-flight inspector.
 *
 * Usage:
 *   node scripts/verify_a1_real_email.mjs
 *
 * This script does NOT send email or modify any data.
 * It exits 0 when all checks pass, 1 when any check fails.
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

function pass(label) { console.log(`  ✓ ${label}`); }
function fail(label) { failures++; console.log(`  ✗ ${label}`); }
function info(label) { console.log(`  · ${label}`); }
function section(title) { console.log(`\n── ${title} ──`); }

// ── 1. env check ─────────────────────────────────────────────────────────

section("Environment");

if (supabaseUrl && serviceRoleKey) {
  pass(`SUPABASE_URL set (${supabaseUrl.slice(0, 45)}…)`);
  pass("SUPABASE_SERVICE_ROLE_KEY set");
} else {
  fail("SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY are required — set them and re-run");
  process.exit(1);
}

if (databaseUrl) {
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

section("Platform domain configuration (kerdos_private.receiving_domains)");

if (databaseUrl) {
  // Lazy-import postgres client — available in Node without install if pg is present,
  // otherwise fall through to the manual-SQL path.
  let sql;
  try {
    const { default: postgres } = await import("postgres");
    sql = postgres(databaseUrl, { max: 1, ssl: { rejectUnauthorized: false } });
  } catch {
    try {
      const { Pool } = await import("pg");
      const pool = new Pool({ connectionString: databaseUrl, ssl: { rejectUnauthorized: false } });
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
    } catch (err) {
      fail(`postgres query failed: ${err.message}`);
      info("Check that DATABASE_URL is correct and the database is reachable.");
    }
  }
} else {
  info("Run the following in the Supabase SQL editor to check domain configuration:");
  info("  SELECT price_sheet_domain, invoice_domain, delivery_ready");
  info("  FROM kerdos_private.receiving_domains;");
  info("Expected: one row with delivery_ready = true and real domain values.");
  info("If the table is empty, platform domains have not been configured yet.");
}

// ── 3. Automatic receiving addresses ─────────────────────────────────────
// email_routing_addresses is in the public schema; service role bypasses RLS.

section("Automatic receiving addresses (email_routing_addresses)");

const supabase = createClient(supabaseUrl, serviceRoleKey, { auth: { persistSession: false } });

const { data: autoAddrs, error: autoErr } = await supabase
  .from("email_routing_addresses")
  .select("routing_address, document_type, vendor_id, organization_id, is_active")
  .eq("is_automatic", true)
  .order("routing_address");

if (autoErr) {
  fail(`Cannot read email_routing_addresses: ${autoErr.message}`);
} else if (!autoAddrs || autoAddrs.length === 0) {
  fail("No automatic receiving addresses found");
  info("Addresses are provisioned when delivery_ready = true and vendors are active.");
  info("If delivery_ready is already true, check that vendors exist and are active.");
} else {
  const active   = autoAddrs.filter(a => a.is_active);
  const inactive = autoAddrs.filter(a => !a.is_active);
  if (active.length > 0) {
    pass(`${active.length} active automatic address(es)`);
    for (const a of active) {
      info(`  ${a.routing_address}  [${a.document_type ?? "untyped"}]  vendor=${a.vendor_id?.slice(0, 8)}`);
    }
  } else {
    fail("Automatic addresses exist but none are active");
  }
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
  fail(`Cannot read manual addresses: ${manualErr.message}`);
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
        fail("InboundDomain is not set — add one in the Postmark dashboard for each receiving domain");
      }

      if (inboundAddress) {
        info(`InboundAddress (test stream): ${inboundAddress}`);
      }

      if (inboundHookUrl) {
        pass(`InboundHookUrl: ${inboundHookUrl}`);
        if (!inboundHookUrl.includes("/functions/v1/inbound-email")) {
          fail("InboundHookUrl does not look like the inbound-email Edge Function — verify it");
        }
      } else {
        fail("InboundHookUrl is not set — webhook must point to the inbound-email Edge Function");
      }
    }
  } catch (err) {
    fail(`Postmark API call failed: ${err.message}`);
  }
} else {
  section("Postmark server inbound configuration");
  info("Set POSTMARK_SERVER_TOKEN to inspect live Postmark configuration.");
  info("Required before real-email verification:");
  info("  · InboundDomain registered for each receiving domain (price-sheet + invoice)");
  info("  · MX record for each domain → inbound.postmarkapp.com  priority 10");
  info("  · InboundHookUrl → https://<ref>.supabase.co/functions/v1/inbound-email");
  info("  · Webhook Basic auth matching POSTMARK_WEBHOOK_USERNAME / POSTMARK_WEBHOOK_PASSWORD");
}

// ── 6. Pre-flight checklist ───────────────────────────────────────────────

section("Pre-flight checklist (must all pass before delivery_ready = true)");
console.log(`
  [ ] Domain ownership: Dino supplies the actual domains (or subdomains).
  [ ] DNS MX records: each receiving domain → inbound.postmarkapp.com  priority 10
        dig MX <domain>   or   nslookup -type=MX <domain>
  [ ] Postmark InboundDomain registered for each receiving domain.
  [ ] Postmark InboundHookUrl → inbound-email Edge Function URL.
  [ ] POSTMARK_WEBHOOK_USERNAME and POSTMARK_WEBHOOK_PASSWORD set in Supabase Secrets.
  [ ] Existing manual routing addresses unchanged (provisioner only touches is_automatic=true).
  [ ] inbound-email Edge Function deployed and ACTIVE on kerdos-test.
`);

// ── 7. Real-email verification steps ─────────────────────────────────────

section("Real-email verification steps (run AFTER delivery_ready = true and addresses provisioned)");
console.log(`
  Step 1 — Price sheet:
    Send a real CSV price list to the provisioned price-sheet address for the test vendor.
    Pass: inbound_attachments.processing_status = 'auto_imported'
    SQL:  SELECT processing_status, import_document_id
          FROM inbound_attachments ORDER BY created_at DESC LIMIT 5;
          SELECT COUNT(*) FROM price_history WHERE source_document_id = <import_document_id>;

  Step 2 — Invoice with valid lines:
    Send a real invoice CSV to the provisioned invoice address.
    Pass: processing_status = 'auto_imported'; invoice row and lines saved.
    SQL:  SELECT h.invoice_date, h.total_amount, COUNT(l.*) AS lines
          FROM invoices h JOIN invoice_lines l ON l.invoice_id = h.id
          GROUP BY h.id ORDER BY h.created_at DESC LIMIT 1;

  Step 3 — Duplicate delivery:
    Re-send the same email (or use Postmark retry simulation).
    Pass: no second invoice or import_document row created.
    SQL:  Confirm COUNT(*) of invoices and import_documents unchanged.

  Step 4 — Partial recovery:
    Force an attachment into 'processing' state, then invoke the recovery-sweep endpoint.
    Pass: attachment resolves to 'auto_imported' or 'needs_review' — never permanently stuck.

  Step 5 — Needs-review path:
    Send an invoice with an arithmetic mismatch (qty * unit_price ≠ line_total).
    Pass: processing_status = 'needs_review'; attachment visible in Inbox.

  Evidence categories must be recorded separately:
    local evidence       — already confirmed (passing unit/PGlite tests)
    deployed evidence    — deployed synthetic tests (confirmed via Supabase deployment #60)
    real-email evidence  — Steps 1–5 above; Task 1 stays open until this is complete.
`);

// ── exit ─────────────────────────────────────────────────────────────────

if (failures > 0) {
  console.log(`\n  ${failures} check(s) failed — resolve them before proceeding.\n`);
  process.exit(1);
} else {
  console.log("\n  All checks passed.\n");
  process.exit(0);
}
