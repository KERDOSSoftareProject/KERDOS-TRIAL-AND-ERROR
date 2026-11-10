// Division II — Invoice Match Floor Regression Tests
//
// Verifies that:
//   [1] MATCH_POLICY.invoiceMatchFloor exists and is defined
//   [2] invoiceMatchFloor is strictly greater than reviewFloor (0.50)
//   [3] invoiceMatchFloor equals 0.60 — governing value per Application Outline II·A·1·c:
//       "Stricter 60% match floor vs catalog (false overcharge alert risk)"
//       "Stricter" means stricter than catalog reviewFloor (0.50), not stricter than autoLink (0.85).
//   [4] invoiceMatchFloor is independent of autoLink (a separately named constant)
//
// Score-boundary tests use safeProductScore directly.
// bestInvoiceMatch applies an additional compareProductIdentity gate (must be "same") before
// the score threshold is reached. Tests [5]–[8] test the score threshold in isolation;
// tests [9]–[10] test the gate and the combined behavior.
//
//   [5] Score below 0.60: safeProductScore returns a value that would fail the floor
//   [6] Score at/above 0.60: safeProductScore returns a value that would pass the interactive floor
//   [7] Score between 0.60 and 0.89: passes interactive floor (0.60) but fails automatic floor (0.90)
//   [8] Automatic path: Math.max(0.9, invoiceMatchFloor) = 0.90; confirmed by direct arithmetic
//   [9] compareProductIdentity "same" gate: bestInvoiceMatch requires identity agreement
//       before scoring; without it, score is not reached regardless of threshold
//  [10] Tie-breaking: two equally-scored candidates return null (ambiguous)
//  [11] Caller wiring — interactive path: ImportModal calls bestInvoiceMatch with
//       MATCH_POLICY.invoiceMatchFloor (verified by reading caller source)
//  [12] Caller wiring — automatic path: automatic-invoice.js uses
//       Math.max(0.9, MATCH_POLICY.invoiceMatchFloor) (verified by reading caller source)

import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {MATCH_POLICY,bestInvoiceMatch,safeProductScore,compareProductIdentity} from "../procurement.js";

const __dir=path.dirname(fileURLToPath(import.meta.url));

let passed=0;
function run(label,fn){
  try{fn();console.log(`  ✓ ${label}`);passed++;}
  catch(err){console.error(`  ✗ ${label}\n    ${err.message}`);process.exitCode=1;}
}

console.log("Division II · Invoice Match Floor\n");

// [1] invoiceMatchFloor is defined
run("[1] invoiceMatchFloor is defined in MATCH_POLICY",()=>{
  assert.ok(MATCH_POLICY.invoiceMatchFloor!==undefined,"invoiceMatchFloor missing from MATCH_POLICY");
  assert.equal(typeof MATCH_POLICY.invoiceMatchFloor,"number","invoiceMatchFloor must be a number");
});

// [2] invoiceMatchFloor > reviewFloor (invoice path is stricter than catalog review floor)
run("[2] invoiceMatchFloor > reviewFloor",()=>{
  assert.ok(MATCH_POLICY.invoiceMatchFloor>MATCH_POLICY.reviewFloor,
    `invoiceMatchFloor (${MATCH_POLICY.invoiceMatchFloor}) must be > reviewFloor (${MATCH_POLICY.reviewFloor})`);
});

// [3] invoiceMatchFloor is exactly 0.60 per Application Outline II·A·1·c
run("[3] invoiceMatchFloor is 0.60 (Application Outline para 202)",()=>{
  assert.equal(MATCH_POLICY.invoiceMatchFloor,0.60,
    `invoiceMatchFloor must be exactly 0.60; got ${MATCH_POLICY.invoiceMatchFloor}. ` +
    `Governing: Application Outline II·A·1·c: "Stricter 60% match floor vs catalog".`);
});

// [4] invoiceMatchFloor is a separate named constant from autoLink
run("[4] invoiceMatchFloor is a named constant independent of autoLink",()=>{
  assert.ok("invoiceMatchFloor" in MATCH_POLICY,"invoiceMatchFloor key missing");
  assert.ok("autoLink" in MATCH_POLICY,"autoLink key missing");
  assert.notEqual(MATCH_POLICY.invoiceMatchFloor,MATCH_POLICY.autoLink,
    "invoiceMatchFloor (0.60) must not equal autoLink (0.85)");
});

// [5] Score actually below 0.60
// safeProductScore("CHICKEN BREAST","TURKEY BREAST") returns ~0.44
// This verifies the floor would reject such a pair.
run("[5] Score below 0.60: pair with < 0.60 similarity confirmed by safeProductScore",()=>{
  const score=safeProductScore("CHICKEN BREAST","TURKEY BREAST");
  assert.ok(score<MATCH_POLICY.invoiceMatchFloor,
    `Expected score < ${MATCH_POLICY.invoiceMatchFloor}; got ${score.toFixed(3)} ` +
    `(CHICKEN BREAST vs TURKEY BREAST). ` +
    `Verify: this pair must fall below the interactive floor so it is excluded.`);
});

// [6] Score at or above 0.60 — passes interactive floor
// safeProductScore("BEEF GROUND 80/20","BEEF GROUND 80/20") = 1.0 (exact).
// Also verified: "PORK SHOULDER BLADE" vs "PORK SHOULDER" = 0.883 (between floors).
// An exact match cleanly demonstrates >= 0.60 acceptance.
run("[6] Score at/above 0.60: exact-description pair scores 1.0 — comfortably passes interactive floor",()=>{
  const score=safeProductScore("BEEF GROUND 80/20","BEEF GROUND 80/20");
  assert.ok(score>=MATCH_POLICY.invoiceMatchFloor,
    `Expected score >= ${MATCH_POLICY.invoiceMatchFloor}; got ${score.toFixed(3)}`);
  assert.equal(score,1.0,"exact descriptions must produce score 1.0");
});

// [7] Interactive-only acceptance: identity "same", score in 0.60–0.89 band
//
// Boundary case: "CHICKEN BREAST 4OZ" vs "CHICKEN BREAST 4 OZ"
//   - compareProductIdentity → "same" (same product, same spec, whitespace variant)
//   - safeProductScore → 0.8833 (word-set overlap penalizes the whitespace-split token)
//   - At interactive floor (0.60): bestInvoiceMatch returns a hit → accepted
//   - At automatic floor (0.90): bestInvoiceMatch returns null → rejected
//
// This is the only known identity-approved pair in this implementation where
// bestInvoiceMatch produces a non-null result at 0.60 but null at 0.90.
// The score gap arises because "4OZ" and "4 OZ" tokenize as different word-set entries
// even though the measurement is the same. The identity gate correctly treats them
// as the same product (same measurement value); the score function does not collapse them.
//
// Note: pairs with extra defining terms (e.g., "PORK SHOULDER BLADE" vs "PORK SHOULDER")
// score ~0.883 via safeProductScore but receive identity "review" (unverified extra term),
// so bestInvoiceMatch rejects them. See tests [5] and [6] for score-only coverage of
// those cases; the identity gate is the governing constraint on what bestInvoiceMatch accepts.
run("[7] Interactive-only: identity-approved pair scores 0.8833 — passes 0.60, rejected at 0.90",()=>{
  const desc="CHICKEN BREAST 4OZ";
  const candidate={description:"CHICKEN BREAST 4 OZ"};

  // Confirm identity status is "same" — required for bestInvoiceMatch to reach score check
  const identity=compareProductIdentity(desc,candidate.description);
  assert.equal(identity.status,"same",
    `Expected identity "same" for whitespace-variant spec; got "${identity.status}"`);

  // Confirm score is in interactive-only band
  const score=safeProductScore(desc,candidate.description);
  assert.ok(score>=MATCH_POLICY.invoiceMatchFloor&&score<0.90,
    `Score ${score.toFixed(4)} must be in [0.60, 0.90) — interactive-only band`);

  // Interactive path accepts it
  const interactiveResult=bestInvoiceMatch(desc,[candidate],MATCH_POLICY.invoiceMatchFloor);
  assert.ok(interactiveResult!==null,
    "bestInvoiceMatch must accept identity-approved 0.8833-score pair at interactive floor (0.60)");
  assert.ok(interactiveResult.score>=MATCH_POLICY.invoiceMatchFloor,
    `Result score ${interactiveResult.score.toFixed(4)} must be >= invoiceMatchFloor (0.60)`);

  // Automatic path rejects it
  const autoFloor=Math.max(0.9,MATCH_POLICY.invoiceMatchFloor);
  const autoResult=bestInvoiceMatch(desc,[candidate],autoFloor);
  assert.equal(autoResult,null,
    `bestInvoiceMatch must reject the same pair at automatic floor (${autoFloor})`);
});

// [8] Automatic path: Math.max(0.9, invoiceMatchFloor) = 0.90
run("[8] Automatic path threshold = Math.max(0.9, invoiceMatchFloor) = 0.90",()=>{
  const autoFloor=Math.max(0.9,MATCH_POLICY.invoiceMatchFloor);
  assert.equal(autoFloor,0.90,
    `Math.max(0.9, ${MATCH_POLICY.invoiceMatchFloor}) must equal 0.90; got ${autoFloor}`);
});

// [9] compareProductIdentity gate: bestInvoiceMatch requires status "same" before scoring.
// Without identity agreement, the candidate is blocked before threshold is checked.
// This means tests [5]-[8] above correctly use safeProductScore in isolation —
// real invoice matching requires identity agreement AND score >= threshold.
run("[9] compareProductIdentity gate: conflicting terms blocked before threshold",()=>{
  // "RIB EYE" and "RIBEYE" — may not be synonyms in the base vocabulary.
  // Use a pair confirmed to produce "different" status:
  const identity=compareProductIdentity("BEEF PATTY 4OZ","PORK PATTY 4OZ");
  assert.equal(identity.status,"different",
    `Expected "different" for beef vs pork; got "${identity.status}" (${identity.reason})`);
  // bestInvoiceMatch must return null even at very low threshold because identity gate fires first
  const result=bestInvoiceMatch("BEEF PATTY 4OZ",[{description:"PORK PATTY 4OZ"}],0.10);
  assert.equal(result,null,
    "identity gate must block a conflicting-species pair regardless of score threshold");
});

// [10] Tie-breaking: two equally-scored candidates return null (ambiguous)
run("[10] Two equally-scored candidates return null (ambiguous — no clear winner)",()=>{
  const desc="CHICKEN BREAST";
  const candidates=[{description:"CHICKEN BREAST"},{description:"CHICKEN BREAST"}];
  const result=bestInvoiceMatch(desc,candidates,MATCH_POLICY.invoiceMatchFloor);
  assert.equal(result,null,"tied top candidates (within 0.05) must produce null — ambiguous match");
});

// [11] Caller wiring — interactive path (ImportModal.jsx)
// Reads the source to verify bestInvoiceMatch is called with MATCH_POLICY.invoiceMatchFloor.
run("[11] Caller wiring: ImportModal.jsx uses MATCH_POLICY.invoiceMatchFloor",()=>{
  const src=readFileSync(path.join(__dir,"../pages/ImportModal.jsx"),"utf8");
  assert.ok(
    src.includes("MATCH_POLICY.invoiceMatchFloor"),
    "ImportModal.jsx must reference MATCH_POLICY.invoiceMatchFloor as the threshold"
  );
  assert.ok(
    src.includes("bestInvoiceMatch"),
    "ImportModal.jsx must call bestInvoiceMatch"
  );
});

// [12] Caller wiring — automatic path (automatic-invoice.js)
// Reads the source to verify Math.max(0.9, MATCH_POLICY.invoiceMatchFloor) is used.
run("[12] Caller wiring: automatic-invoice.js uses Math.max(0.9, MATCH_POLICY.invoiceMatchFloor)",()=>{
  const src=readFileSync(path.join(__dir,"./automatic-invoice.js"),"utf8");
  // Match either spaced or unspaced form; require both 0.9 and invoiceMatchFloor as arguments
  assert.ok(
    /Math\.max\(\s*0\.9\s*,\s*MATCH_POLICY\.invoiceMatchFloor\s*\)/.test(src),
    "automatic-invoice.js must use Math.max(0.9, MATCH_POLICY.invoiceMatchFloor) — " +
    "not a hardcoded 0.9, and not the interactive floor directly"
  );
});

console.log(`\n${passed} tests passed.`);
if(process.exitCode===1)console.error("Some tests FAILED.");
