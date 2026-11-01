import {parsePackSize,priceBasisFor,estimateCaseCost,measurement,normalizeUnit,quoteStatus,comparePurchasingPack} from '../procurement.js';
import {billingUnitEvidence} from './billing-unit-evidence.js';

// Pure, provider-neutral preparation only. Persistence adapters must authenticate
// the actor, reload scoped records, check revisions and save atomically. An intent
// is never an authorization receipt and never enables the existing Order Guide.
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
const same=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
const money=n=>Math.round((n+Number.EPSILON)*100)/100;
const id=(value,label)=>{if(typeof value!=='string'||!value.trim())throw new Error(`${label} is required`);return value;};
const numeric=(value,label)=>{if(!['number','string'].includes(typeof value)||(typeof value==='string'&&!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value.trim()))||!Number.isFinite(Number(value)))throw new Error(`${label} must be numeric and finite`);return Number(value);};
const positive=(value,label)=>{const n=numeric(value,label);if(n<=0)throw new Error(`${label} must be positive and finite`);return n;};
const time=value=>{const date=new Date(value);if(value==null||value===''||!Number.isFinite(date.getTime()))throw new Error('A valid review time is required');return date.toISOString();};

function termsFor({organizationId,vendorId,catalogItemId,listing,mapping,settings={},now}){
  for(const [value,label] of [[organizationId,'Organization'],[vendorId,'Vendor'],[catalogItemId,'Catalog item'],[listing?.id,'Vendor item']])id(value,label);
  if(listing.organization_id!==organizationId||listing.vendor_id!==vendorId||mapping?.organization_id!==organizationId||mapping.vendor_item_id!==listing.id||mapping.catalog_item_id!==catalogItemId)
    throw new Error('The listing and catalog link must belong to this client and vendor');
  if(mapping.comparison_track!=='exact'||mapping.confidence_score!==100)throw new Error('Confirm the catalog association first');
  const fields=listing.import_row?.reviewFields;
  if(listing.import_row?.reviewRequired&&(!Array.isArray(fields)||!fields.length||fields.some(field=>field!=='pack_size')))
    throw new Error('Resolve the other source fields before reviewing variable-weight purchasing');
  const reviewedAt=time(now);
  if(quoteStatus({...listing,price_unavailable:false},settings,reviewedAt)!=='current')throw new Error('A current vendor quotation is required');
  const price=positive(listing.price,'Quoted rate'),basis=priceBasisFor(listing.selling_unit),pack=parsePackSize(listing.pack_size);
  if(basis?.basis!=='measure'||!pack?.parsed||!pack.catchWeight||pack.dimension!=='mass')throw new Error('A stated measured rate and readable variable-weight pack are required');
  const estimate=estimateCaseCost(price,'measure',basis.unit,listing.pack_size);
  if(!estimate)throw new Error('Quoted measurement and pack are incompatible');
  const source=listing.import_row;
  id(source?.sourceDocumentId,'Source document');id(source?.rowKey,'Source row');
  const row=source.evidence||source.row,unitProof=billingUnitEvidence(row||{});
  if(!unitProof||row.priceNeedsReview||numeric(row.price,'Stated source rate')!==price||normalizeUnit(row.sellingUnit)!==normalizeUnit(listing.selling_unit)||comparePurchasingPack(row.packSize,listing.pack_size).status!=='same')
    throw new Error('Preserve the stated source rate, unit and variable pack evidence before approval');
  const solePackReview=source.reviewRequired&&Array.isArray(fields)&&fields.length===1&&fields[0]==='pack_size';
  if(listing.price_unavailable&&!solePackReview&&row.priceUnavailable!==false)
    throw new Error('An unavailable quotation cannot be approved as a variable-weight quote');
  return {organizationId,vendorId,catalogItemId,vendorItemId:listing.id,
    vendorItemCode:listing.vendor_item_code??null,description:listing.description??null,brand:listing.brand??null,
    packSize:listing.pack_size,quotedRate:price,quotedUnit:normalizeUnit(basis.unit),
    validUntil:listing.price_quote_valid_until??null,lastUpdated:listing.last_updated?time(listing.last_updated):null,
    sourceDocumentId:source.sourceDocumentId,sourceRowKey:source.rowKey,billingUnitEvidence:structuredClone(unitProof)};
}

export function variableWeightTerms(input){return termsFor(input);}

export function prepareVariableWeightApproval(input){
  if(input.confirmed!==true)throw new Error('Explicit acceptance of estimated purchasing is required');
  const terms=termsFor(input);
  return {kind:'variable_weight_approval_intent',version:1,terms,requestedBy:id(input.actorId,'Reviewing user'),reviewedAt:time(input.now),
    requiresAuthenticatedPersistence:true,finalChargeKnown:false};
}

export function prepareEstimatedPurchaseLine(input){
  const terms=termsFor(input),approval=input.approval;
  // Load this receipt through an authenticated scoped adapter, not arbitrary
  // request JSON. Equality below is a data-integrity check, not authentication.
  if(approval?.kind!=='variable_weight_approval'||approval.version!==1||approval.revokedAt||!approval.id||!approval.approvedBy||!approval.approvedAt||!same(approval.terms,terms))
    throw new Error('A persisted approval for these exact source terms is required');
  id(approval.id,'Saved approval');id(approval.approvedBy,'Approving user');
  if(time(approval.approvedAt)>time(input.now))throw new Error('Approval cannot be dated after this order');
  const quantity=positive(input.quantity,'Case quantity');
  if(!Number.isSafeInteger(quantity)||input.orderUnit!=='case')throw new Error('This contract requires a whole number of cases');
  const estimate=estimateCaseCost(terms.quotedRate,'measure',terms.quotedUnit,terms.packSize);
  const amount=estimate.amount==null?null:money(estimate.amount*quantity);
  const minimum=estimate.minimum==null?null:money(estimate.minimum*quantity),maximum=estimate.maximum==null?null:money(estimate.maximum*quantity);
  if([amount,minimum,maximum].some(n=>n!=null&&(!Number.isFinite(n)||n<=0)))throw new Error('Estimated amount cannot be represented');
  return {kind:'estimated_purchase_line_intent',version:1,terms,approvalId:approval.id,quantity,orderUnit:'case',
    estimate:{amount,minimum,maximum,estimated:true,guaranteed:false},actualCharge:null,
    requiresAuthenticatedPersistence:true};
}

function savedOrderLine(orderLine){
  id(orderLine?.id,'Saved order line');id(orderLine?.orderId,'Saved order');
  if(orderLine.kind!=='estimated_purchase_line'||orderLine.version!==1||orderLine.orderUnit!=='case')throw new Error('A saved estimated purchase line is required');
  const terms=orderLine.terms;
  if(!terms||!orderLine.approvalId)throw new Error('Order source terms and approval are required');
  for(const field of ['organizationId','vendorId','catalogItemId','vendorItemId','sourceDocumentId','sourceRowKey'])id(terms[field],field);
  const pack=parsePackSize(terms.packSize),packUnit=measurement(1,pack?.unit);
  if(!pack?.parsed||!pack.catchWeight||packUnit?.dimension!=='mass')throw new Error('Saved variable pack evidence is invalid');
  positive(terms.quotedRate,'Saved quoted rate');
  const quantity=positive(orderLine.quantity,'Ordered quantity');
  if(!Number.isSafeInteger(quantity))throw new Error('Saved case quantity must be a whole number');
  const estimate=estimateCaseCost(terms.quotedRate,'measure',terms.quotedUnit,terms.packSize);
  const expected=estimate&&{amount:estimate.amount==null?null:money(estimate.amount*quantity),minimum:estimate.minimum==null?null:money(estimate.minimum*quantity),maximum:estimate.maximum==null?null:money(estimate.maximum*quantity),estimated:true,guaranteed:false};
  if(!expected||Object.entries(expected).some(([key,n])=>['amount','minimum','maximum'].includes(key)&&n!=null&&(!Number.isFinite(n)||n<=0))||!same(orderLine.estimate,expected))throw new Error('Saved estimate does not match its retained source terms');
  return {terms,pack,packUnit};
}

export function prepareVariableWeightReceipt({orderLine,invoiceLine,link,receivedCaseQuantity=null,actorId,now}){
  const {terms,pack,packUnit}=savedOrderLine(orderLine);
  if(link?.confirmed!==true||link.orderLineId!==orderLine.id||link.invoiceDocumentId!==invoiceLine?.sourceDocumentId||link.invoiceLineId!==invoiceLine?.id)
    throw new Error('Explicitly link the invoice line to this order line');
  id(invoiceLine.id,'Invoice line');id(invoiceLine.sourceDocumentId,'Invoice document');
  if(invoiceLine.documentKind!=='invoice')throw new Error('An invoice is required for an actual charge');
  if(invoiceLine.organizationId!==terms.organizationId||invoiceLine.vendorId!==terms.vendorId||invoiceLine.vendorItemId!==terms.vendorItemId)
    throw new Error('Invoice evidence must belong to the same client, vendor and product');
  const row=invoiceLine.row,proof=billingUnitEvidence(row||{}),quantityProof=invoiceLine.billedQuantityEvidence;
  if(!proof)throw new Error('A stated invoice billing unit is required');
  const qty=positive(row.qty,'Billed quantity'),rate=numeric(row.price,'Billed rate'),amount=numeric(row.amount,'Billed amount');
  if(row.price==null||row.price===''||row.amount==null||row.amount===''||![rate,amount].every(Number.isFinite)||rate<0||amount<0)
    throw new Error('A nonnegative invoice rate and charge are required');
  if(quantityProof?.kind!=='invoice_billed_quantity'||typeof quantityProof.header!=='string'||!quantityProof.header.trim()||numeric(quantityProof.quantity,'Stated billed quantity')!==qty||normalizeUnit(quantityProof.unit)!==normalizeUnit(row.sellingUnit))
    throw new Error('Preserve evidence identifying the billed quantity and its unit');
  const billedUnit=measurement(1,row.sellingUnit),quotedUnit=measurement(1,terms.quotedUnit);
  if(!billedUnit||!quotedUnit||billedUnit.dimension!=='mass'||quotedUnit.dimension!=='mass')throw new Error('Invoice billing measurement is incompatible');
  if(money(qty*rate)!==money(amount))throw new Error('Invoice arithmetic needs review before reconciling the charge');
  if(!row.sourceLine||!same(quantityProof.sourceLine,row.sourceLine))throw new Error('Retain the printed invoice line for the billed quantity');
  if(terms.vendorItemCode&&row.code&&String(row.code)!==String(terms.vendorItemCode))throw new Error('Invoice product code differs from the ordered item');
  const cases=receivedCaseQuantity==null?null:positive(receivedCaseQuantity,'Received cases');
  if(cases!=null&&(!Number.isSafeInteger(cases)||cases>orderLine.quantity))throw new Error('Received cases cannot exceed the ordered quantity');
  const expectedCharge=money(qty*terms.quotedRate*billedUnit.baseQuantity/quotedUnit.baseQuantity);
  if(!Number.isFinite(expectedCharge))throw new Error('Quoted comparison cannot be represented');
  const deliveredPackWeight=cases==null?null:qty*billedUnit.baseQuantity/packUnit.baseQuantity/cases;
  return {kind:'variable_weight_receipt_intent',version:1,organizationId:terms.organizationId,vendorId:terms.vendorId,
    vendorItemId:terms.vendorItemId,orderId:orderLine.orderId,orderLineId:orderLine.id,approvalId:orderLine.approvalId,
    invoiceDocumentId:invoiceLine.sourceDocumentId,invoiceLineId:invoiceLine.id,
    billedQuantity:qty,billedUnit:row.sellingUnit,billedRate:rate,actualCharge:amount,
    expectedChargeAtQuotedRate:expectedCharge,rateVariance:money(amount-expectedCharge),receivedCaseQuantity:cases,
    weightOutsideStatedRange:pack?.weightRange&&cases!=null?deliveredPackWeight<pack.caseQty*pack.weightRange.minimum||deliveredPackWeight>pack.caseQty*pack.weightRange.maximum:null,
    sourceLine:row.sourceLine,billingUnitEvidence:structuredClone(proof),billedQuantityEvidence:structuredClone(quantityProof),
    requestedBy:id(actorId,'Receiving user'),reviewedAt:time(now),requiresAuthenticatedPersistence:true};
}

export function summarizeVariableWeightReceipts(orderLine,receipts){
  savedOrderLine(orderLine);
  const ordered=positive(orderLine.quantity,'Ordered quantity'),seen=new Set(),receiptIds=new Set();
  let received=0,actual=0,completeQuantities=true;
  for(const receipt of receipts){
    if(receipt.kind!=='variable_weight_receipt'||receipt.version!==1||!receipt.id||receipt.orderLineId!==orderLine.id||receipt.orderId!==orderLine.orderId||receipt.organizationId!==orderLine.terms.organizationId||receipt.vendorId!==orderLine.terms.vendorId||receipt.vendorItemId!==orderLine.terms.vendorItemId||receipt.approvalId!==orderLine.approvalId)
      throw new Error('Only saved receipts belonging to this order line can be summarized');
    const sourceKey=JSON.stringify([receipt.invoiceDocumentId,receipt.invoiceLineId]);
    if(!receipt.invoiceDocumentId||!receipt.invoiceLineId||seen.has(sourceKey)||receiptIds.has(receipt.id))throw new Error('A receipt or invoice line cannot be counted twice');
    seen.add(sourceKey);receiptIds.add(receipt.id);
    if(!Number.isFinite(receipt.actualCharge)||receipt.actualCharge<0)throw new Error('Receipt charge is invalid');
    const cents=Math.round(receipt.actualCharge*100);
    if(!Number.isSafeInteger(cents)||cents/100!==receipt.actualCharge||!Number.isSafeInteger(actual+cents))throw new Error('Actual charge exceeds supported monetary precision');
    actual+=cents;
    if(receipt.receivedCaseQuantity==null)completeQuantities=false;
    else{if(!Number.isSafeInteger(receipt.receivedCaseQuantity)||receipt.receivedCaseQuantity<=0)throw new Error('Receipt quantity is invalid');received+=receipt.receivedCaseQuantity;}
  }
  if(received>ordered)throw new Error('Receipts exceed the ordered case quantity');
  if(!Number.isFinite(actual))throw new Error('Actual charge cannot be represented');
  const complete=completeQuantities&&received===ordered;
  return {status:complete?'complete':receipts.length?'partial':'pending',receivedCaseQuantity:received,
    recordedCharge:actual/100,actualCharge:complete?actual/100:null,estimate:structuredClone(orderLine.estimate),quotedTerms:structuredClone(orderLine.terms)};
}
