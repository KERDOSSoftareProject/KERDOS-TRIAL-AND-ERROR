// Shared quote eligibility and provenance resolution.
// Used by both the interactive import path (ImportModal.jsx) and the
// automatic invoice worker (automatic-invoice.js) so that both paths
// apply the same expiry, source-eligibility, and billing-basis rules.
//
// Preserve the existing interactive refresh window when clientSettings is
// supplied. Automatic imports retain their prior policy pending reconciliation.
import {priceBasisFor,quotePriceOnBasis} from '../procurement.js';

const r2 = value => Math.round((value + Number.EPSILON) * 100) / 100;

/**
 * Eligibility note values when comparison cannot be performed.
 * Stored in invoice_lines.quoted_comparison_note so the report can
 * distinguish "variance truly zero" from "comparison was not possible".
 */
export const QUOTE_COMPARISON_NOTES = /** @type {const} */ ({
  NO_ELIGIBLE_QUOTE:    'no_eligible_quote',    // historicalQuote returned null (no price history row)
  QUOTE_EXPIRED:        'quote_expired',         // quote_valid_until < invoiceDate
  SOURCE_INELIGIBLE:    'source_ineligible',     // source not in price_list / manual_edit
  UNKNOWN_BILLED_UNIT:  'unknown_billed_unit',   // invoice selling_unit not recognised by priceBasisFor
  BASIS_INCOMPATIBLE:   'basis_incompatible',    // quotePriceOnBasis returned null
  LOOKUP_ERROR:         'lookup_error',          // historicalQuote threw (network/DB error)
  CLIENT_WINDOW_EXCEEDED: 'client_window_exceeded',
  INVALID_RATE: 'invalid_rate',
});

/**
 * Resolve provenance for one invoice line.
 *
 * @param {object} params
 * @param {object|null} params.quote        — row from historicalQuote (or null)
 * @param {string}      params.invoiceDate  — 'YYYY-MM-DD' invoice date
 * @param {string}      params.billedUnit   — invoice selling_unit for this line
 * @param {string|null} params.packSize     — resolved pack size (vendor item or row)
 *
 * @returns {{
 *   variance:        number|null,
 *   quoteProvenance: object,
 *   comparisonNote:  string|null
 * }}
 *
 * On success, comparisonNote is null and quoteProvenance contains all seven
 * quoted_* fields with meaningful values.  On failure, variance is null,
 * quoteProvenance carries all-null fields, and comparisonNote holds a
 * QUOTE_COMPARISON_NOTES value explaining why comparison was not done.
 * Never returns variance=0 for a line where comparison was not performed.
 */
export function resolveQuoteProvenance({quote,invoiceDate,billedUnit,packSize,unitPrice}) {
  const nullProvenance = {
    quoted_rate:               null,
    quoted_source_rate:        null,
    quoted_basis:              null,
    quoted_effective_date:     null,
    quoted_source:             null,
    quoted_price_history_id:   null,
    quoted_source_document_id: null,
  };

  const fail = note => ({variance:null,quoteProvenance:nullProvenance,comparisonNote:note});

  if (!quote) return fail(QUOTE_COMPARISON_NOTES.NO_ELIGIBLE_QUOTE);

  // Expiry: quote_valid_until is the last date the quote is valid (inclusive).
  const withinVendorTerm = !quote.quote_valid_until || quote.quote_valid_until >= invoiceDate;
  if (!withinVendorTerm) return fail(QUOTE_COMPARISON_NOTES.QUOTE_EXPIRED);

  // Source eligibility: only price_list and manual_edit rows support variance comparison.
  if (!['price_list','manual_edit'].includes(quote.source))
    return fail(QUOTE_COMPARISON_NOTES.SOURCE_INELIGIBLE);

  if (quote.price == null || String(quote.price).trim() === '' ||
      !Number.isFinite(Number(quote.price)) || Number(quote.price) < 0 ||
      unitPrice == null || String(unitPrice).trim() === '' ||
      !Number.isFinite(Number(unitPrice)) || Number(unitPrice) < 0)
    return fail(QUOTE_COMPARISON_NOTES.INVALID_RATE);

  // Billing-basis resolution: the invoice must express a recognisable billed unit.
  const billedBasisStr = String(billedUnit || '').trim();
  if (!billedBasisStr) return fail(QUOTE_COMPARISON_NOTES.UNKNOWN_BILLED_UNIT);
  const billedBasis = priceBasisFor(billedUnit);
  if (!billedBasis) return fail(QUOTE_COMPARISON_NOTES.UNKNOWN_BILLED_UNIT);

  // Convert the quoted rate to the billed basis.
  const comparableQuote = quotePriceOnBasis(
    {
      price:   Number(quote.price),
      basis:   quote.price_basis || null,
      unit:    quote.price_basis === 'measure' ? (quote.selling_unit || null) : null,
      packSize: packSize || null,
    },
    billedBasis,
  );
  if (comparableQuote == null) return fail(QUOTE_COMPARISON_NOTES.BASIS_INCOMPATIBLE);

  const variance = unitPrice != null ? r2(Number(unitPrice) - comparableQuote) : null;

  return {
    variance,
    quoteProvenance: {
      quoted_rate:               comparableQuote,          // basis-converted rate used for comparison
      quoted_source_rate:        Number(quote.price),      // original price-sheet rate (may differ)
      quoted_basis:              quote.price_basis || null,
      quoted_effective_date:     quote.effective_date || null,
      quoted_source:             quote.source || null,
      quoted_price_history_id:   quote.id || null,
      quoted_source_document_id: quote.source_document_id || null,
    },
    comparisonNote: null,
  };
}

// Both UI and worker use this lookup wrapper, so a failed lookup persists the
// same diagnostic instead of being confused with a successful empty query.
export async function lookupQuoteComparison({importService,organizationId,vendorItemId,
  invoiceDate,billedUnit,packSize,unitPrice,clientSettings}) {
  const params={invoiceDate,billedUnit,packSize,unitPrice};
  const empty=resolveQuoteProvenance({...params,quote:null});
  if(!vendorItemId)return empty;
  let quote;
  try {
    if(typeof importService?.historicalQuote!=='function')throw new Error('Quote lookup is unavailable');
    quote=await importService.historicalQuote({organizationId,vendorItemId,invoiceDate});
  } catch(error) {
    return {...empty,comparisonNote:QUOTE_COMPARISON_NOTES.LOOKUP_ERROR,
      lookupError:error.message||String(error)};
  }
  const refreshDays=Number(clientSettings?.price_refresh_days);
  if(quote&&clientSettings?.price_refresh_mode==='automatic'&&refreshDays>0&&
      (new Date(`${invoiceDate}T12:00:00Z`)-new Date(quote.effective_date||0))/86400000>refreshDays)
    return {...empty,comparisonNote:QUOTE_COMPARISON_NOTES.CLIENT_WINDOW_EXCEEDED};
  return resolveQuoteProvenance({...params,quote});
}
