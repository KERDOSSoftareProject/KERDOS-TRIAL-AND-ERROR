// Background invoice preparation. Uses the same parser, identity/pack rules,
// matching threshold and billed-unit evidence as the interactive import flow.
// No writes happen here. Uncertain lines keep the whole invoice in review.
import {findDate,findInvoiceNumber} from '../ingestion.js';
import {bestInvoiceMatch,compareProductIdentity,comparePurchasingPack,MATCH_POLICY} from '../procurement.js';
import {billingUnitEvidence} from './billing-unit-evidence.js';

const money = value => Math.round((value + Number.EPSILON) * 100) / 100;
const numeric = value => value != null && value !== '' && Number.isFinite(Number(value));

export function prepareAutomaticInvoice({text,rows,organizationId,vendorId,vendorItems=[]}) {
  const review = reason => ({reason,header:null,lines:[]});
  const date=findDate(text);
  if(!date || !/^\d{4}-\d{2}-\d{2}$/.test(date) || !Number.isFinite(new Date(`${date}T12:00:00Z`).getTime()) || new Date(`${date}T12:00:00Z`).toISOString().slice(0,10)!==date)
    return review('Invoice date is missing or invalid.');
  if(!rows?.length)return review('No invoice lines could be read.');
  const listings=vendorItems.filter(item=>item.organization_id===organizationId&&item.vendor_id===vendorId);
  const lines=[];
  for(const [index,row] of rows.entries()){
    const fail=reason=>review(`Invoice line ${index+1}: ${reason}`);
    if(row.requiresReview||row.issues?.length||row.details?.length)
      return fail(row.issues?.join('; ')||'Source fields require review.');
    if(!row.description?.trim()||!numeric(row.qty)||Number(row.qty)<=0||!numeric(row.price)||Number(row.price)<0||!numeric(row.amount))
      return fail('Description, billed quantity, unit price and extended amount must be stated.');
    if(Math.abs(money(Number(row.qty)*Number(row.price))-Number(row.amount))>0.025)
      return fail('Billed quantity and unit price do not reconcile with the extended amount.');
    if(!billingUnitEvidence(row))return fail('Billed unit is not established by source evidence.');
    let candidates=[],method='code',confidence=100;
    if(row.code){
      candidates=listings.filter(item=>item.vendor_item_code===row.code);
      if(candidates.length>1)return fail('Vendor item code matches multiple products.');
      if(candidates.length&&compareProductIdentity(row.description,candidates[0].description).status!=='same')
        return fail('Vendor item code conflicts with the product description.');
      if(candidates.length&&comparePurchasingPack(row.packSize,candidates[0].pack_size).status!=='same')
        return fail('Vendor item code has an unverified or conflicting purchasing pack.');
    }
    if(!candidates.length){
      method='exact_description';
      candidates=listings.filter(item=>item.description===row.description&&comparePurchasingPack(row.packSize,item.pack_size).status==='same');
      if(candidates.length>1)return fail('Description matches multiple vendor products.');
    }
    if(!candidates.length){
      const match=bestInvoiceMatch(row.description,listings.filter(item=>comparePurchasingPack(row.packSize,item.pack_size).status==='same'),Math.max(0.9,MATCH_POLICY.autoLink));
      if(match){candidates=[match.vendorItem];confidence=Math.round(match.score*100);method='fuzzy';}
    }
    if(!candidates.length)return fail('No sufficiently verified vendor product match; review the product before importing.');
    lines.push({vendor_item_id:candidates[0].id,vendor_item_code:row.code||null,description:row.description,
      quantity:Number(row.qty),unit_price:Number(row.price),line_total:Number(row.amount),
      selling_unit:row.sellingUnit,pack_size:row.packSize,source_line:row.sourceLine,
      billing_unit_evidence:billingUnitEvidence(row),price_variance:null,match_confidence:confidence,match_method:method});
  }
  const total=money(lines.reduce((sum,line)=>sum+line.line_total,0));
  // A stated total must reconcile; taxes, fees, credits and unexplained differences
  // need their own interpretation rather than disappearing from the invoice.
  const totals=[...String(text).matchAll(/^\s*(?:grand\s+total|invoice\s+total|total\s+due|amount\s+due|total)\s*[:,]?\s*\$?([\d,]+\.\d{2})\s*$/gim)];
  if(totals.some(match=>Math.abs(Number(match[1].replaceAll(',',''))-total)>0.025))
    return review('Stated invoice total does not reconcile with the parsed line amounts.');
  return {reason:null,header:{organization_id:organizationId,vendor_id:vendorId,invoice_date:date,
    invoice_number:findInvoiceNumber(text),total_amount:total,raw_text:text},lines};
}
