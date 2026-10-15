/**
 * bs-context-precedence-test.mjs
 *
 * Tests dictionary behaviour for "b/s" (alias of "boneless skinless") across
 * product contexts — including the mixed case "chicken sausage" where both
 * poultry and sausage context words are present.
 *
 * Guards that must hold:
 *   1. Pure poultry context   → b/s is blocked (contextKnown, but still product/context-guarded by the engine)
 *      Wait — "b/s" with matching poultry context IS contextKnown=true, automatic=true, NOT blocked.
 *      Re-check: blocked = kind==="ambiguous" || (kind==="product" && original!==canonical && !contextKnown)
 *      For boneless skinless (kind="product"), original="b s", canonical="boneless skinless" → original!==canonical.
 *      So blocked iff !contextKnown. Poultry context → contextKnown=true → NOT blocked → unresolved is empty.
 *      That means compareProductIdentity sees NO unresolved for "CHICKEN B/S BREAST"
 *      and proceeds to word-level comparison.
 *
 *   2. Pure sausage context   → b/s is blocked (contextKnown=false for current entry) → unresolved → "review"
 *
 *   3. Mixed context (chicken sausage) → b/s is NOT blocked (poultry context word present → contextKnown=true)
 *      This is a real ambiguity: the engine resolves "b/s" as "boneless skinless" when
 *      "chicken" is present, even if "sausage" is also present. The result is "review"
 *      at the identity level only if other terms conflict — NOT from unresolved.
 *      This means a "chicken sausage b/s" product would NOT trigger the unresolved guard.
 *
 *   4. If a "brown and serve" synonym for "b&s" were added with context:["sausage"],
 *      the mixed context case MUST stay under review — both interpretations
 *      fire and neither can override the other.
 *
 * This test suite documents current behaviour so any future synonym addition
 * can be validated against it.
 *
 * Run: node src/knowledge/bs-context-precedence-test.mjs
 */

import {configureProcurement, compareProductIdentity, productIdentity} from '../procurement.js';
configureProcurement({industry:'restaurant', vocabulary:[]});
await new Promise(r=>setTimeout(r,10));

let passed=0, failed=0;
function t(label, actual, expected) {
  if (actual === expected) {
    console.log(`  PASS  ${label}`);
    passed++;
  } else {
    console.error(`  FAIL  ${label}`);
    console.error(`        expected=${JSON.stringify(expected)} got=${JSON.stringify(actual)}`);
    failed++;
  }
}
function unresolvedTerms(desc) {
  return productIdentity(desc).unresolved.map(u=>u.source);
}
function cpiStatus(a, b) {
  return compareProductIdentity(a, b).status;
}

// ── 1. Poultry context: b/s IS contextKnown → not blocked ───────────────────
console.log('\n── b/s with poultry context (contextKnown=true) ──');

// "CHICKEN B/S BREAST" — "chicken" is in the context list → contextKnown=true
// blocked = kind==="product" && original!==canonical && !contextKnown → false
// So unresolved is empty; "boneless skinless" is the automatic expansion.
t('CHICKEN B/S BREAST: b/s not in unresolved (contextKnown=true)',
  unresolvedTerms('CHICKEN B/S BREAST').includes('b s'), false);

t('CHICKEN B/S BREAST vs CHICKEN BONELESS SKINLESS BREAST: same (b/s expanded)',
  cpiStatus('CHICKEN B/S BREAST', 'CHICKEN BONELESS SKINLESS BREAST'), 'same');

t('CHICKEN B/S THIGH vs CHICKEN BONELESS SKINLESS THIGH: same',
  cpiStatus('CHICKEN B/S THIGH', 'CHICKEN BONELESS SKINLESS THIGH'), 'same');

// ── 2. Sausage context only: b/s NOT contextKnown → blocked → unresolved ────
console.log('\n── b/s with sausage context only (contextKnown=false) ──');

t('SAUSAGE B/S PATTY: b/s IS in unresolved (no poultry context)',
  unresolvedTerms('SAUSAGE B/S PATTY').includes('b s'), true);

t('SAUSAGE B&S PATY: b s IS in unresolved',
  unresolvedTerms('SAUSAGE BKF PATY B&S 2 WD').includes('b s'), true);

t('SAUSAGE B/S vs SAUSAGE B/S (identical): review due to unresolved b/s',
  cpiStatus('SAUSAGE BKF PATY B&S 2 WD', 'SAUSAGE BKF PATY B&S 2 WD'), 'review');

// ── 3. Mixed context (chicken sausage): poultry word present ─────────────────
// "CHICKEN SAUSAGE B/S" — "chicken" is in context list → contextKnown=true → not blocked.
// The engine resolves b/s as "boneless skinless" automatically.
// This means the unresolved guard does NOT fire.
// Identity result depends on whether "sausage" and "boneless skinless" conflict.
console.log('\n── b/s with mixed context: chicken sausage ──');

t('CHICKEN SAUSAGE B/S: b/s not in unresolved (chicken satisfies poultry context)',
  unresolvedTerms('CHICKEN SAUSAGE B/S').includes('b s'), false);

// With boneless skinless auto-expanded, "chicken sausage boneless skinless"
// vs "chicken sausage boneless skinless" → same
t('CHICKEN SAUSAGE B/S vs CHICKEN SAUSAGE BONELESS SKINLESS: same (expansion applied)',
  cpiStatus('CHICKEN SAUSAGE B/S', 'CHICKEN SAUSAGE BONELESS SKINLESS'), 'same');

// "chicken sausage b/s" vs "chicken sausage patty" — b/s expands to "boneless skinless"
// on the left; "patty" is only on the right.
// Both sides have non-empty exclusive core sets ("boneless","skinless" vs "patty"),
// so compareProductIdentity returns "different" (not "review").
t('CHICKEN SAUSAGE B/S vs CHICKEN SAUSAGE PATTY: different (boneless skinless vs patty)',
  cpiStatus('CHICKEN SAUSAGE B/S', 'CHICKEN SAUSAGE PATTY'), 'different');

// ── 4. What a "brown and serve" synonym would require ────────────────────────
// If {"kind":"synonym","term":"b&s","canonical":"brown and serve","context":["sausage"]}
// were added, the chicken sausage case would have BOTH:
//   - "b/s" → boneless skinless (via poultry context)
//   - "b&s" → brown and serve (via sausage context)
// These are the same token (B&S → "b s" after punctuation strip).
// The dictionary picks the FIRST matching entry (longest-token-first, stable sort).
// This means the two meanings compete for the same token — whichever entry appears
// first in the sorted list wins. The mixed case cannot safely resolve either meaning.
// The test below documents that the current engine does NOT have this ambiguity:
console.log('\n── Absence of "brown and serve" synonym (current state) ──');

// Currently no "brown and serve" in the restaurant vocabulary at all.
// Verified by checking productIdentity on a pure brown-and-serve phrase.
const bnsRaw = productIdentity('BROWN AND SERVE SAUSAGE PATTY');
t('BROWN AND SERVE: no unresolved terms (words pass through as raw tokens)',
  bnsRaw.unresolved.length, 0);

// And no synonym resolves "b&s" to "brown and serve" currently.
const bnsAbbr = productIdentity('SAUSAGE B&S PATTY');
t('SAUSAGE B&S: unresolved contains "b s" (boneless skinless blocked, no b&s synonym)',
  bnsAbbr.unresolved.map(u=>u.source).includes('b s'), true);

// ── 5. If a sausage-context synonym were added for b&s ───────────────────────
// Simulate with a vocabulary row — as if {"kind":"synonym","term":"b&s","canonical":"brown and serve"}
// were added with context:["sausage"]. We do NOT add it here; this section only
// describes what MUST be tested before any such addition.
console.log('\n── Required tests before any "brown and serve" synonym is added ──');
console.log('  (Not yet run — synonym not added. These describe the required gate.)');
console.log('  REQUIRED: SAUSAGE B&S with synonym active → productIdentity.unresolved empty');
console.log('  REQUIRED: SAUSAGE B&S vs SAUSAGE BROWN AND SERVE → "same"');
console.log('  REQUIRED: CHICKEN B/S BREAST with synonym active → b/s still resolves as boneless skinless');
console.log('  REQUIRED: CHICKEN SAUSAGE B/S with BOTH context words → must be "review" (ambiguous)');
console.log('  REQUIRED: plain CHICKEN B/S (no sausage) → boneless skinless expansion unchanged');
console.log('  None of these can be run until primary-source evidence confirms the meaning.');

// ── Summary ─────────────────────────────────────────────────────────────────
console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
