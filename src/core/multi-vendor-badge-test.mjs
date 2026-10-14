// Tests for multi-vendor badge logic: allLinkedVendorIds and badge label derivation.
// These tests exercise the same logic used in App.jsx to compute totalLinkedVendors,
// readyVendorCount, and the badge label — without touching matching or readiness gates.

import assert from "node:assert/strict";
import { orderable } from "./ordering.js";

// ---------------------------------------------------------------------------
// Shared helpers — mirror what App.jsx does
// ---------------------------------------------------------------------------

/** Build the allLinkedVendorIds field the productList memo attaches to each item. */
function buildAllLinkedVendorIds(options) {
  return [...new Set(options.map(o => o.vendorId))];
}

/**
 * Derive the badge label string from the same variables App.jsx uses in the render.
 * `allLinkedVendorIds` comes from the product object (pre-filter).
 * `orderableOptions`   is item.options after the orderable filter (what the render receives).
 */
function badgeLabel(allLinkedVendorIds, orderableOptions) {
  const totalLinkedVendors = allLinkedVendorIds.length;
  if (totalLinkedVendors <= 1) return null; // badge not shown
  const readyVendorCount = new Set(orderableOptions.map(o => o.vendorId)).size;
  const heldCount = totalLinkedVendors - readyVendorCount;
  return heldCount > 0
    ? `${totalLinkedVendors} vendors linked · ${readyVendorCount} ready`
    : `${totalLinkedVendors} vendors`;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeOption(vendorId, overrides = {}) {
  return {
    vendorId,
    vendorItemId: `vi-${vendorId}-${Math.random()}`,
    casePrice: 10,
    packSize: "1/10 LB",
    matchTrack: "exact",
    matchConfidence: 100,
    expired: false,
    brandMismatch: false,
    priceUnavailable: false,
    invoiceOnly: false,
    unverified: false,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Scenario 1 — two vendors, both ready
// ---------------------------------------------------------------------------
{
  const options = [
    makeOption("vendor-cityline"),
    makeOption("vendor-minores"),
  ];
  const allLinkedVendorIds = buildAllLinkedVendorIds(options);
  const orderableOptions = options.filter(orderable);

  assert.equal(allLinkedVendorIds.length, 2, "Scenario 1: two distinct vendors saved");
  assert.equal(orderableOptions.length, 2, "Scenario 1: both vendors orderable");
  assert.equal(badgeLabel(allLinkedVendorIds, orderableOptions), "2 vendors",
    "Scenario 1: badge shows '2 vendors' when all are ready");
}

// ---------------------------------------------------------------------------
// Scenario 2 — two vendors, one held (expired quote)
// ---------------------------------------------------------------------------
{
  const options = [
    makeOption("vendor-cityline"),
    makeOption("vendor-minores", { expired: true }),
  ];
  const allLinkedVendorIds = buildAllLinkedVendorIds(options);
  const orderableOptions = options.filter(orderable);

  assert.equal(allLinkedVendorIds.length, 2, "Scenario 2: two distinct vendors saved");
  assert.equal(orderableOptions.length, 1, "Scenario 2: only the non-expired vendor passes orderable");
  assert.equal(badgeLabel(allLinkedVendorIds, orderableOptions), "2 vendors linked · 1 ready",
    "Scenario 2: badge discloses held vendor rather than hiding it");

  // Verify the held vendor is still counted — it MUST appear in allLinkedVendorIds
  assert.ok(allLinkedVendorIds.includes("vendor-minores"),
    "Scenario 2: held vendor-minores is present in allLinkedVendorIds");
}

// ---------------------------------------------------------------------------
// Scenario 2b — two vendors, one held (unverified match, not expired)
// ---------------------------------------------------------------------------
{
  const options = [
    makeOption("vendor-cityline"),
    makeOption("vendor-minores", { unverified: true, qualificationReason: "Review in Item Catalog" }),
  ];
  const allLinkedVendorIds = buildAllLinkedVendorIds(options);
  const orderableOptions = options.filter(orderable);

  assert.equal(allLinkedVendorIds.length, 2, "Scenario 2b: both vendors saved");
  assert.equal(orderableOptions.length, 1, "Scenario 2b: unverified vendor excluded from ordering");
  assert.equal(badgeLabel(allLinkedVendorIds, orderableOptions), "2 vendors linked · 1 ready",
    "Scenario 2b: badge still shows held count for unverified match");
}

// ---------------------------------------------------------------------------
// Scenario 3 — duplicate SKUs from one vendor (same vendor_id, two mappings)
//   e.g. vendor imported two line items that both resolved to the same KERDOS number
// ---------------------------------------------------------------------------
{
  const options = [
    makeOption("vendor-cityline", { vendorItemId: "vi-cl-1", casePrice: 10 }),
    makeOption("vendor-cityline", { vendorItemId: "vi-cl-2", casePrice: 11 }),
  ];
  const allLinkedVendorIds = buildAllLinkedVendorIds(options);
  const orderableOptions = options.filter(orderable);

  // Distinct vendors: only 1 (same vendorId appears twice)
  assert.equal(allLinkedVendorIds.length, 1,
    "Scenario 3: duplicate SKUs from one vendor count as 1 distinct vendor");
  // Badge should NOT show — only 1 vendor
  assert.equal(badgeLabel(allLinkedVendorIds, orderableOptions), null,
    "Scenario 3: no multi-vendor badge when all options are from the same vendor");
}

// ---------------------------------------------------------------------------
// Scenario 4 — three vendors, one held — badge shows correct counts
// ---------------------------------------------------------------------------
{
  const options = [
    makeOption("vendor-cityline"),
    makeOption("vendor-minores"),
    makeOption("vendor-usfoods", { priceUnavailable: true }),
  ];
  const allLinkedVendorIds = buildAllLinkedVendorIds(options);
  const orderableOptions = options.filter(orderable);

  assert.equal(allLinkedVendorIds.length, 3, "Scenario 4: three distinct vendors saved");
  assert.equal(orderableOptions.length, 2, "Scenario 4: two ready, one price-unavailable held");
  assert.equal(badgeLabel(allLinkedVendorIds, orderableOptions), "3 vendors linked · 2 ready",
    "Scenario 4: badge shows 3 linked and 2 ready");
}

// ---------------------------------------------------------------------------
// Matching and readiness gates are unchanged — orderable() still blocks the
// same options it always has; we verify it hasn't changed.
// ---------------------------------------------------------------------------
{
  const clean = makeOption("v1");
  assert.ok(orderable(clean), "Gate check: clean option passes orderable");

  const blocked = [
    makeOption("v2", { expired: true }),
    makeOption("v3", { unverified: true }),
    makeOption("v4", { priceUnavailable: true }),
    makeOption("v5", { invoiceOnly: true }),
    makeOption("v6", { brandMismatch: true }),
    makeOption("v7", { matchTrack: "similar", matchConfidence: 80 }),
    makeOption("v8", { packSize: null }),
  ];
  for (const opt of blocked) {
    assert.ok(!orderable(opt), `Gate check: option with flags should not be orderable: ${JSON.stringify(opt)}`);
  }
}

console.log("Multi-vendor badge logic tests passed (5 scenarios + gate checks)");
