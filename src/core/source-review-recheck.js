import {createProcurementContext} from '../procurement.js';
import {invoiceEvidence} from './invoice-evidence.js';
import {quotedUnitOrigin} from './listing-provenance.js';
import {preparePriceImport} from './price-import-review.js';
import {resolveFromInvoiceArithmetic} from './quote-basis.js';
import {canonicalQuoteUnit,documentQuoteEvidence,hasPrintedQuoteUnit} from './source-units.js';

// Match the importer's interpretation context without mutating the browser or
// worker default. A successfully loaded empty vocabulary is valid.
export function workspaceProcurement({organization,vocabulary}){
  if(!organization?.id||typeof organization.industry!=='string'||!organization.industry.trim()||
    !Array.isArray(vocabulary)||vocabulary.some(row=>!row||row.organization_id!==organization.id))
    throw new Error('The organization industry and vocabulary could not be verified.');
  return createProcurementContext({industry:organization.industry,vocabulary});
}

function observationProblem(listing,mapping,document,organization,procurement,now){
  const observation=listing.import_row;
  const row=observation?.row;
  if(!mapping||mapping.organization_id!==organization.id||mapping.vendor_item_id!==listing.id)
    return 'The listing has no current catalog link in this organization.';
  if(!document?.fingerprint||document.document_kind!=='pricelist'||document.status==='processing'||
    document.organization_id!==organization.id||document.vendor_id!==listing.vendor_id||
    observation?.sourceDocumentId!==document.id||!observation.rowKey||!row?.description||observation.retainedSource)
    return 'The retained source row is not the active quote for this document.';
  if(row.cellConflicts?.length||observation.evidence?.cellConflicts?.length||row.issues?.length||row.requiresReview||row.priceNeedsReview)
    return 'The original source has unresolved cell warnings or parser issues.';
  if(row.priceUnavailable||listing.price_source!=='price_list'||!(Number(row.price)>0)||Number(row.price)!==Number(listing.price)||
    procurement.quoteStatus({...listing,price_unavailable:false},organization.settings,now)!=='current')
    return 'The original quote amount is missing, changed, or no longer current.';
  if(procurement.comparePurchasingPack(row.packSize,listing.pack_size).status!=='same')
    return 'The retained source does not verify the saved purchasing pack.';
  return null;
}

function prepareObservation(listing,mapping,source,unit,invoices,listings,procurement){
  const scope={organizationId:listing.organization_id,vendorId:listing.vendor_id};
  const scopedInvoices=invoices.filter(entry=>entry.organizationId===scope.organizationId&&entry.vendorId===scope.vendorId);
  const issues=invoiceEvidence(source,scopedInvoices,procurement).conflicts;
  const incoming=unit?{...source,sellingUnit:unit,sellingUnitSource:'manual'}:source;
  // An explicit confirmation bypasses the importer's blank-unit invoice
  // inference branch. Check that evidence independently before supplying it.
  if(unit){
    const invoice=resolveFromInvoiceArithmetic({...source,sellingUnit:''},scopedInvoices,scope,procurement);
    if(invoice?.conflict)issues.push(`Quoted unit needs review because invoice evidence conflicts. ${invoice.reason}.`);
    else if(invoice&&canonicalQuoteUnit(invoice.sellingUnit,procurement)!==canonicalQuoteUnit(unit,procurement))
      issues.push('Quoted unit differs from verified invoice evidence.');
  }
  try {
    return preparePriceImport(incoming,listing,mapping,issues,scopedInvoices,scope,procurement,listings);
  } catch(error) {
    return {reasons:[error.message],requiresReview:true};
  }
}

function measureInference(listing,procurement){
  const basis=procurement.priceBasisFor(listing.selling_unit);
  const dimension=basis?.unit&&procurement.measurement(1,basis.unit)?.dimension;
  return ['mass','volume','bushel'].includes(dimension)||/^(?:WEIGHT|VOLUME|MEASURE)$/i.test(listing.selling_unit||'');
}

function confirmationProblem(listing,document,origin,unit,procurement){
  const source=listing.import_row.row;
  if(hasPrintedQuoteUnit(source,procurement)||origin.status==='confirmed')
    return 'The quoted unit is already stated or confirmed.';
  const declared=documentQuoteEvidence(document.original_text,procurement);
  if(declared.present&&declared.unit!==unit)return 'The selected unit conflicts with the document terms.';
  if(listing.selling_unit&&origin.status!=='inferred')
    return 'The saved quoted unit is not a blank or an unconfirmed inference.';
  if(measureInference(listing,procurement))return 'A weight or volume inference requires individual review.';
  // A withdrawn price cannot be revived by a document confirmation. The
  // existing importer marks unresolved unit observations unavailable and held.
  const hasUnitHold=listing.import_row.reviewRequired===true&&
    (listing.import_row.reviewFields?.includes('selling_unit')||origin.status==='inferred'||!listing.selling_unit);
  if(listing.price_unavailable&&!hasUnitHold)return 'The quote is unavailable for a reason other than the unresolved unit.';
  return null;
}

export function planDocumentQuoteConfirmation({organization,vocabulary,document,listings,mappings,invoices=[],unit,listingIds,now=new Date()}){
  const procurement=workspaceProcurement({organization,vocabulary});
  const canonical=canonicalQuoteUnit(unit,procurement);
  if(!canonical)throw new Error('Choose a recognized quoted unit.');
  if(!document?.id||document.organization_id!==organization.id||document.document_kind!=='pricelist'||!document.vendor_id)
    throw new Error('Choose a price sheet in this organization.');
  const byListing=new Map(mappings.map(mapping=>[mapping.vendor_item_id,mapping]));
  const selected=listingIds?new Set(listingIds):null;
  const rows=[],held=[];
  for(const listing of listings){
    if(listing.organization_id!==organization.id||listing.import_row?.sourceDocumentId!==document.id||selected&&!selected.has(listing.id))continue;
    const mapping=byListing.get(listing.id);
    const problem=observationProblem(listing,mapping,document,organization,procurement,now);
    const origin=quotedUnitOrigin(listing,procurement);
    const exclusion=problem||confirmationProblem(listing,document,origin,canonical,procurement);
    if(exclusion){held.push({listingId:listing.id,reason:exclusion});continue;}
    const sellingUnit=canonicalQuoteUnit(listing.selling_unit,procurement)===canonical?listing.selling_unit:canonical;
    const prepared=prepareObservation(listing,mapping,listing.import_row.row,sellingUnit,invoices,listings,procurement);
    if(prepared.requiresReview||!prepared.resolved||prepared.row.priceUnavailable){
      held.push({listingId:listing.id,reason:prepared.reasons.join(' ')||'The price, pack, and selected unit could not be verified.'});
      continue;
    }
    rows.push({listingId:listing.id,expectedListing:listing,expectedMapping:mapping,sellingUnit,
      priceBasis:prepared.resolved.basis.basis,priceUnavailable:false,rowKey:listing.import_row.rowKey,packSize:listing.pack_size});
  }
  return {rows,held};
}

function reviewBaseline(listing){
  return {description:listing.description,brand:listing.brand??null,packSize:listing.pack_size??null,
    sellingUnit:listing.selling_unit??null,price:listing.price,gtin:listing.gtin??null,manufacturerCode:listing.manufacturer_code??null};
}

// The planner works for any held observation and current interpretation
// rules. It produces evidence and an exact patch proposal, never a write.
export function planSourceReviewRecheck({organization,vocabulary,documents,listings,mappings,invoices=[],listingIds,now=new Date()}){
  const procurement=workspaceProcurement({organization,vocabulary});
  const byDocument=new Map(documents.filter(document=>document.organization_id===organization.id).map(document=>[document.id,document]));
  const byListing=new Map(mappings.map(mapping=>[mapping.vendor_item_id,mapping]));
  const selected=listingIds?new Set(listingIds):null;
  const rows=[],held=[];
  for(const listing of listings){
    const observation=listing.import_row;
    if(listing.organization_id!==organization.id||!observation?.reviewRequired||
      (selected?!selected.has(listing.id):!byDocument.has(observation.sourceDocumentId)))continue;
    const document=byDocument.get(observation.sourceDocumentId),mapping=byListing.get(listing.id);
    const problem=observationProblem(listing,mapping,document,organization,procurement,now);
    if(problem){held.push({listingId:listing.id,reason:problem});continue;}
    const origin=quotedUnitOrigin(listing,procurement),root=origin.root?.confirmation?.documentConfirmation;
    const currentRoot=root?.documentId===document.id;
    const staleRoot=currentRoot&&(root.documentFingerprint!==document.fingerprint||root.rowKey!==observation.rowKey);
    if(staleRoot){held.push({listingId:listing.id,reason:'The confirmed source row no longer matches its document receipt.'});continue;}
    const declared=documentQuoteEvidence(document.original_text,procurement);
    if(declared.present&&declared.unit!==canonicalQuoteUnit(listing.selling_unit,procurement)){
      held.push({listingId:listing.id,reason:'The saved quoted unit conflicts with the document terms.'});
      continue;
    }
    const source=observation.row;
    const confirmedUnit=origin.confirmation&&!hasPrintedQuoteUnit(source,procurement)?listing.selling_unit:null;
    const prepared=prepareObservation(listing,mapping,source,confirmedUnit,invoices,listings,procurement);
    const currentBasis=procurement.priceBasisFor(listing.selling_unit);
    if(prepared.requiresReview||!prepared.resolved||prepared.row.priceUnavailable||listing.price_unavailable||
      canonicalQuoteUnit(prepared.resolved.sellingUnit,procurement)!==canonicalQuoteUnit(listing.selling_unit,procurement)||
      currentBasis?.basis!==listing.price_basis){
      held.push({listingId:listing.id,reason:prepared.reasons.join(' ')||'The active quote still needs its saved unit or availability resolved.',
        reviewFields:prepared.reviewFields||[]});
      continue;
    }
    rows.push({listingId:listing.id,expectedListing:listing,expectedMapping:mapping,
      reviewFields:[],reviewRequired:false,baseline:reviewBaseline(listing)});
  }
  return {rows,held};
}
