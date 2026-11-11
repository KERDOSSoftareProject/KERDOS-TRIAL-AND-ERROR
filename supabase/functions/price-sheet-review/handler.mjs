import { qualificationSummary } from "../../../src/core/catalog-fields.js";
import { readInvoiceEvidence } from "../../../src/core/invoice-evidence.js";
import { planDocumentQuoteConfirmation, planSourceReviewRecheck, workspaceProcurement } from "../../../src/core/source-review-recheck.js";

const uuid = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const actions = new Map([
  ["preview-confirmation", {operation: "confirm", preview: true}],
  ["confirm", {operation: "confirm", preview: false}],
  ["preview-recheck", {operation: "recheck", preview: true}],
  ["apply-recheck", {operation: "recheck", preview: false}],
]);
const encoder = new TextEncoder();
const decoder = new TextDecoder();
const previewLifetime = 15 * 60 * 1000;

class ReviewError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.status = status;
  }
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (!value || typeof value !== "object") return JSON.stringify(value);
  return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
}

const base64Url = bytes => btoa(Array.from(bytes, byte => String.fromCharCode(byte)).join("")).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
const fromBase64Url = value => Uint8Array.from(atob(value.replaceAll("-", "+").replaceAll("_", "/")), char => char.charCodeAt(0));

async function fingerprint(value) {
  return base64Url(new Uint8Array(await crypto.subtle.digest("SHA-256", encoder.encode(stableJson(value)))));
}

function previewTokens(secret) {
  const key = crypto.subtle.importKey("raw", encoder.encode(secret), {name: "HMAC", hash: "SHA-256"}, false, ["sign", "verify"]);
  const message = data => encoder.encode(`kerdos/price-sheet-review/1:${data}`);
  return {
    async sign(value) {
      const data = base64Url(encoder.encode(JSON.stringify(value)));
      const signature = await crypto.subtle.sign("HMAC", await key, message(data));
      return `${data}.${base64Url(new Uint8Array(signature))}`;
    },
    async read(token) {
      if (typeof token !== "string") throw new ReviewError("Open a fresh review preview.");
      try {
        const [data, signature, extra] = token.split(".");
        if (!data || !signature || extra !== undefined ||
          !await crypto.subtle.verify("HMAC", await key, fromBase64Url(signature), message(data))) throw new Error();
        return JSON.parse(decoder.decode(fromBase64Url(data)));
      } catch {
        throw new ReviewError("The review preview is invalid. Open a fresh preview.");
      }
    },
  };
}

function readyCounts(workspace, procurement, now, listings = workspace.listings) {
  const {total, ready} = qualificationSummary({
    vendorItems: listings, catalogItems: workspace.catalogItems, mappings: workspace.mappings,
    categories: workspace.categories, vendors: workspace.vendors,
    settings: workspace.organization.settings || {}, now, procurement,
  });
  return {ready, total};
}

function previewListing(row, operation) {
  const listing = row.expectedListing;
  if (operation === "confirm") {
    return {
      ...listing,
      selling_unit: row.sellingUnit,
      price_basis: row.priceBasis,
      price_unavailable: row.priceUnavailable,
      field_resolutions: {...listing.field_resolutions, selling_unit: {
        value: row.sellingUnit, confirmedBy: "projected", sourceValue: listing.import_row?.row?.sellingUnit ?? null,
      }},
    };
  }
  return {
    ...listing,
    import_row: {...listing.import_row, reviewFields: row.reviewFields, reviewRequired: row.reviewRequired, baseline: row.baseline},
  };
}

async function preparePlan(workspace, {operation, unit, listingIds, now}) {
  const procurement = workspaceProcurement(workspace);
  const {organization, vocabulary, document, documents, listings, mappings, rawInvoices} = workspace;
  const invoicesByVendor = new Map();
  for (const invoice of rawInvoices) {
    const vendorInvoices = invoicesByVendor.get(invoice.vendor_id) || [];
    vendorInvoices.push(invoice);
    invoicesByVendor.set(invoice.vendor_id, vendorInvoices);
  }
  const invoices = [...invoicesByVendor].flatMap(([vendorId, entries]) => readInvoiceEvidence(entries, organization.id, vendorId, procurement));
  const input = {organization, vocabulary, listings, mappings, invoices, listingIds, now};
  const result = operation === "confirm"
    ? planDocumentQuoteConfirmation({...input, document, unit})
    : planSourceReviewRecheck({...input, documents});
  const before = readyCounts(workspace, procurement, now);
  const replacements = new Map(result.rows.map(row => [row.listingId, previewListing(row, operation)]));
  const after = readyCounts(workspace, procurement, now, listings.map(row => replacements.get(row.id) || row));
  const counts = {...before, projectedReady: after.ready};
  const affectedDocuments = new Set(result.rows.map(row => row.expectedListing.import_row.sourceDocumentId));
  return {
    plan: {
      documentId: document?.id ?? null,
      documentFingerprint: document?.fingerprint ?? null,
      ...(document ? {} : {documents: documents.filter(entry => affectedDocuments.has(entry.id)).map(({id, fingerprint}) => ({id, fingerprint}))}),
      industry: organization.industry,
      vocabulary,
      settings: organization.settings ?? null,
      ...(operation === "confirm" ? {unit} : {}),
      rows: result.rows,
      summary: counts,
    },
    held: result.held,
    counts,
  };
}

const showRows = (rows, held, workspace) => {
  const listings = new Map(workspace.listings.map(row => [row.id, row]));
  const fileNames = new Map(workspace.documents.map(doc => [doc.id, doc.file_name]));
  const vendorNames = new Map(workspace.vendors.map(vendor => [vendor.id, vendor.name]));
  const label = id => {
    const listing = listings.get(id);
    return {
      description: listing?.description, fileName: fileNames.get(listing?.import_row?.sourceDocumentId),
      vendorName: vendorNames.get(listing?.vendor_id), vendorItemCode: listing?.vendor_item_code, packSize: listing?.pack_size,
    };
  };
  return {
    rows: rows.map(row => ({
      listingId: row.listingId,
      ...label(row.listingId),
      ...(row.sellingUnit ? {sellingUnit: row.sellingUnit, packSize: row.packSize} : {previousReviewFields: row.expectedListing.import_row.reviewFields, reviewFields: row.reviewFields, reviewRequired: row.reviewRequired}),
    })),
    held: held.map(row => ({...row, ...label(row.listingId)})),
  };
};

export function createPriceSheetReviewHandler({authenticate, membership, loadWorkspace, readOperation, applyOperation, secret, clock = () => new Date(), reportError = () => {}}) {
  if (!secret) throw new Error("Price sheet review signing key is missing");
  const tokens = previewTokens(secret);
  return async function review(request) {
    try {
      const actorId = await authenticate(request);
      if (!actorId) throw new ReviewError("Sign in to review a price sheet.", 401);
      const input = await request.json().catch(() => null);
      const action = actions.get(input?.action);
      const documentId = input?.documentId ?? null;
      if (!action || !uuid.test(input?.organizationId || "") ||
        (documentId ? !uuid.test(documentId) : action.operation !== "recheck")) {
        throw new ReviewError("Choose a price sheet and review action.");
      }
      const {operation, preview} = action;
      const {organizationId} = input;
      const role = await membership(organizationId, actorId);
      if (role !== "owner" && (operation === "recheck" || role !== "manager")) {
        throw new ReviewError(operation === "recheck" ? "Only the workspace owner can approve a source recheck." : "Owner or manager access is required.", 403);
      }
      const scope = {organizationId, documentId, actorId, operation};
      let approval;
      let unit = input.unit;
      let listingIds = input.listingIds;
      if (!preview) {
        approval = await tokens.read(input.token);
        if (Object.keys(scope).some(key => scope[key] !== approval[key])) {
          throw new ReviewError("This preview belongs to a different review action or account.", 403);
        }
        const saved = await readOperation({...scope, operationId: approval.operationId});
        if (saved) return {receipt: saved, counts: saved.summary};
        if (clock().getTime() >= approval.expiresAt) throw new ReviewError("The review preview expired. Open a fresh preview.", 409);
        unit = approval.unit;
        listingIds = approval.listingIds;
      }
      if (listingIds !== undefined) {
        if (!Array.isArray(listingIds) || !listingIds.length || listingIds.some(id => typeof id !== "string" || !uuid.test(id))) {
          throw new ReviewError("Select listings to include in the review.");
        }
        listingIds = [...new Set(listingIds)].sort();
      }
      if (operation === "confirm" && (typeof unit !== "string" || !unit.trim() || unit.length > 80)) {
        throw new ReviewError("Choose the quoted unit on the source document.");
      }
      const workspace = await loadWorkspace(organizationId, documentId);
      if (workspace?.organization?.id !== organizationId || (documentId && (
        !workspace.document || workspace.document.organization_id !== organizationId || workspace.document.id !== documentId ||
        workspace.document.document_kind !== "pricelist" || workspace.document.status === "processing"
      ))) {
        throw new ReviewError("The retained price sheet is unavailable for review.", 409);
      }
      const {plan, held, counts} = await preparePlan(workspace, {operation, unit, listingIds, now: clock()});
      const planHash = await fingerprint({plan, held});
      if (preview) {
        const token = plan.rows.length ? await tokens.sign({
          ...scope, operationId: crypto.randomUUID(), unit, listingIds, planHash, expiresAt: clock().getTime() + previewLifetime,
        }) : null;
        return {token, ...showRows(plan.rows, held, workspace), counts};
      }
      if (!plan.rows.length || approval.planHash !== planHash) {
        throw new ReviewError("The source or workspace changed since this preview. Review a fresh preview before applying.", 409);
      }
      const receipt = await applyOperation({...scope, operationId: approval.operationId, plan});
      // The receipt retains the approved projection. Re-read the live state to
      // distinguish observed readiness from that projection.
      try {
        const current = await loadWorkspace(organizationId, documentId);
        const observed = readyCounts(current, workspaceProcurement(current), clock());
        return {receipt, counts: {...receipt.summary, readyAfter: observed.ready, totalAfter: observed.total}};
      } catch (error) {
        reportError(error);
        return {receipt, counts: receipt.summary, readinessRefreshRequired: true};
      }
    } catch (error) {
      if (error instanceof ReviewError) return {status: error.status, error: error.message};
      reportError(error);
      return {status: 409, error: "The price sheet review could not run. Check workspace settings and open a fresh preview."};
    }
  };
}
