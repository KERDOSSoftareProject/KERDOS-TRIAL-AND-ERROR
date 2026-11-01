import {validateEstimatedReceipt,validateReceiptReversal} from '../services/estimated-receipts.js';
// Exact cents only; missing evidence never becomes zero.
export function invoiceMoneyCents(value){
 if(value==null||value==='')return null;
 // Large JSON numbers can lose a cent before reaching this function; require exact strings.
 if(typeof value==='number'&&(!Number.isFinite(value)||Math.abs(value)>1e12))return null;
 if(String(value).length>32)return null;
 const match=String(value).match(/^(-?)(\d+)(?:\.(\d{1,2}))?$/);if(!match)return null;
 const cents=BigInt(match[2])*100n+BigInt((match[3]||'').padEnd(2,'0'));
 const signed=match[1]?-cents:cents;return signed>BigInt(Number.MAX_SAFE_INTEGER)||signed<BigInt(Number.MIN_SAFE_INTEGER)?null:Number(signed);
}
function sum(values){let total=0;for(const value of values){if(value==null)return null;total+=value;if(!Number.isSafeInteger(total))return null;}return total;}
const labelKey=value=>value.trim().toLowerCase().replace(/[:\s]+$/,'').replace(/\s+/g,' ');
const sourceKey=value=>String(value||'').trim().replace(/[,\t|]+/g,' ').replace(/\s+/g,' ');
const category=label=>{
 if(/^(subtotal|sub total|merchandise subtotal|item subtotal)$/.test(label))return 'subtotal';
 if(/^(invoice total|grand total|total due|amount due|total)$/.test(label))return 'total';
 if(/^(tax|sales tax|vat|gst|hst)$/.test(label))return 'tax';
 if(/^(freight|shipping|shipping charge|delivery|delivery charge|delivery fee)$/.test(label))return 'freight';
 if(/^(credit|credits|discount|discounts)$/.test(label))return 'credits';
 if(/^(fuel surcharge|service charge|handling fee|other charges|other fees)$/.test(label))return 'other';
 return null;
};
export function invoiceSummaryEvidence(rawText,itemSources=[]){
 const entries=[],issues=[],seen=new Set(),itemKeys=new Set(itemSources.map(sourceKey));
 for(const [index,raw] of String(rawText||'').split(/\r?\n/).entries()){
  const match=raw.trim().match(/^(.+?)\s*[:\t, ]\s*(\(?-?\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{2})\)?)\s*$/);
  if(!match){if(!itemKeys.has(sourceKey(raw))&&((/\b(total|subtotal|tax|freight|credit|discount|surcharge|balance|fee|charges?)\b/i.test(raw)&&/[$\d]/.test(raw))||/\p{Sc}|\d+[.,]\d{2}\s*$/u.test(raw)))issues.push(`Summary source line ${index+1} needs clarification: ${raw}`);continue;}
  const label=labelKey(match[1]),kind=category(label);
  if(!kind){if(!itemKeys.has(sourceKey(raw)))issues.push(`Unclassified monetary source line ${index+1}: ${raw}`);continue;}
  if(itemKeys.has(sourceKey(raw)))issues.push(`Summary source line ${index+1} is also recorded as an item line.`);
  if(seen.has(label))issues.push(`Repeated summary label requires clarification: ${label}`);seen.add(label);
  let text=match[2].replaceAll(',','').replace('$','');
  if(text.startsWith('(')){if(!text.endsWith(')')||text.includes('-'))text='invalid';else text='-'+text.slice(1,-1);}else if(text.endsWith(')'))text='invalid';
  let cents=invoiceMoneyCents(text);if(kind==='credits'&&cents!=null)cents=-Math.abs(cents);
  if(cents==null)issues.push(`Unsupported monetary precision on source line ${index+1}.`);
  if(kind!=='credits'&&cents!=null&&cents<0)issues.push(`Negative ${kind} needs source clarification.`);
  entries.push({kind,label,cents,sourceLine:raw,lineNumber:index+1});
 }
 const amounts={};for(const kind of ['subtotal','tax','freight','credits','other','total']){
  const rows=entries.filter(e=>e.kind===kind);amounts[kind]=rows.length?sum(rows.map(e=>e.cents)):null;
  if((kind==='total'||kind==='subtotal')&&rows.length>1)issues.push(`Multiple ${kind} amounts require clarification.`);
 }
 return {entries,amounts,issues};
}
export function reconcileInvoice(source,{organizationId,invoiceId}={}){
 if(source?.kind!=='invoice_reconciliation_source'||source.version!==1||source.organizationId!==organizationId||source.invoiceId!==invoiceId||source.header?.id!==invoiceId||source.header.organizationId!==organizationId||!Array.isArray(source.lines)||!Array.isArray(source.receipts)||!Array.isArray(source.reversals))throw new Error('Invoice reconciliation source has invalid scope');
 if(source.lines.some(l=>!l.id||l.invoiceId!==invoiceId)||new Set(source.lines.map(l=>l.id)).size!==source.lines.length)throw new Error('Invoice line history has invalid scope or duplicates');
 const receipts=source.receipts,reversals=source.reversals;
 for(const receipt of receipts){validateEstimatedReceipt(receipt,organizationId,receipt.orderId);const line=source.lines.find(l=>l.id===receipt.invoiceLineId);
  if(!line||receipt.invoiceDocumentId!==invoiceId||receipt.sourceReview.invoiceLine.vendorId!==source.header.vendorId||line.vendorItemId!==receipt.vendorItemId||line.sellingUnit!==receipt.billedUnit||invoiceMoneyCents(line.amount)!==invoiceMoneyCents(receipt.actualCharge)||String(line.quantity)!==String(receipt.billedQuantity)||String(line.unitPrice)!==String(receipt.billedRate)||line.sourceLine!==receipt.sourceLine)throw new Error('Receipt differs from the retained invoice source');
 }
 if(new Set(receipts.map(r=>r.id)).size!==receipts.length||new Set(receipts.map(r=>r.invoiceLineId)).size!==receipts.length)throw new Error('Duplicate invoice receipt history');
 for(const reversal of reversals){const receipt=receipts.find(r=>r.id===reversal.receiptId);if(!receipt)throw new Error('Invoice reversal refers to an unknown receipt');validateReceiptReversal(reversal,organizationId,receipt.orderId);}
 if(new Set(reversals.map(r=>r.receiptId)).size!==reversals.length||new Set(reversals.map(r=>r.id)).size!==reversals.length)throw new Error('Duplicate invoice reversal history');
 const active=receipts.filter(r=>!reversals.some(v=>v.receiptId===r.id));
 const lines=source.lines.map(line=>{const receipt=active.find(r=>r.invoiceLineId===line.id),historical=receipts.find(r=>r.invoiceLineId===line.id);return {...line,cents:invoiceMoneyCents(line.amount),coverage:receipt?'linked':historical?'reversed':'unlinked',receiptId:receipt?.id||null,orderId:receipt?.orderId||null,orderLineId:receipt?.orderLineId||null,rateVarianceCents:receipt?invoiceMoneyCents(receipt.rateVariance):null,weightOutsideStatedRange:receipt?.weightOutsideStatedRange===true};});
 const evidence=invoiceSummaryEvidence(source.header.rawText,lines.map(l=>l.sourceLine)),issues=[...evidence.issues],a=evidence.amounts;
 const lineCents=lines.length?sum(lines.map(l=>l.cents)):null,recordedCents=invoiceMoneyCents(source.header.recordedTotal);
 if(!lines.length)issues.push('No saved invoice item lines.');
 if(lineCents==null)issues.push('Item line amounts are missing or exceed supported monetary precision.');
 if(recordedCents==null)issues.push('Recorded invoice total is missing or invalid.');
 for(const kind of ['subtotal','tax','freight','credits','total'])if(a[kind]==null)issues.push(`Explicit ${kind} source amount is missing. Absence is not zero.`);
 // No other charge is added unless explicitly stated; unknown source lines block reconciliation.
 const calculatedCents=sum([lineCents,a.tax,a.freight,a.credits,a.other??0]);
 const differenceCents=calculatedCents!=null&&a.total!=null?sum([a.total,-calculatedCents]):null;
 if(calculatedCents==null&&lineCents!=null&&['tax','freight','credits'].every(k=>a[k]!=null))issues.push('Invoice adjustment sum exceeds supported monetary precision.');
 const subtotalDifference=a.subtotal!=null&&lineCents!=null?sum([a.subtotal,-lineCents]):null;
 if(subtotalDifference!==null&&subtotalDifference!==0)issues.push('Printed subtotal differs from saved item lines.');
 if(a.total!=null&&recordedCents!=null&&a.total!==recordedCents)issues.push('Recorded invoice total differs from the printed total.');
 if(differenceCents!==null&&differenceCents!==0)issues.push('Item lines and stated adjustments do not balance to the printed total.');
 const coverage=lines.length&&lines.every(l=>l.coverage==='linked')?'complete':active.length?'partial':'none';
 const arithmetic=issues.length?'needs_review':differenceCents===0?'balanced':'needs_source';
 const variances=lines.filter(l=>l.rateVarianceCents!==null&&l.rateVarianceCents!==0||l.weightOutsideStatedRange);
 return {organizationId,invoiceId,header:source.header,lines,evidence,lineCents,recordedCents,calculatedCents,printedTotalCents:a.total,differenceCents,linkedCents:sum(lines.filter(l=>l.coverage==='linked').map(l=>l.cents)),unlinkedCents:sum(lines.filter(l=>l.coverage!=='linked').map(l=>l.cents)),coverage,arithmetic,issues,varianceCount:variances.length,status:arithmetic==='balanced'&&coverage==='complete'&&!variances.length?'reconciled':'needs_review',settlementStatus:'not_recorded'};
}
