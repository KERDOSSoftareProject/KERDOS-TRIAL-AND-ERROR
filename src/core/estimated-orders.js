import {estimateCaseCost} from '../procurement.js';
import {estimatedDraftTotal} from './estimated-purchase-drafts.js';
import {formatMoney} from '../localization.js';
const rateText=n=>`${formatMoney(n)}${Number(n)!==Math.round(Number(n)*100)/100?` (stated rate ${n})`:''}`;
const stable=v=>Array.isArray(v)?v.map(stable):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,stable(v[k])])):v;
export const sameOrderData=(a,b)=>JSON.stringify(stable(a))===JSON.stringify(stable(b));
export function estimateText(e){
 if(e?.estimated!==true||e.guaranteed!==false)return 'Estimate unavailable';
 return e.amount!=null?formatMoney(e.amount):`${formatMoney(e.minimum)}–${formatMoney(e.maximum)}`;
}
export const orderAmountText=row=>row?.estimated_snapshot?`Estimated ${estimateText(row.estimated_snapshot.estimate)}`:formatMoney(row?.total_amount);
export const orderLineAmountText=row=>row?.estimated_snapshot?`Estimated ${estimateText(row.estimated_snapshot.estimate)}`:formatMoney(row?.line_total);
export function validateEstimatedOrder(order,{organizationId,draftId,review}={}){
 if(order?.kind!=='estimated_purchase_order'||order.version!==1||!order.id||order.organizationId!==organizationId||order.sourceDraftId!==draftId||!order.vendorId||!order.submittedBy||!order.submittedAt||!Number.isFinite(Date.parse(order.submittedAt))||order.finalCharge!==null||order.deliveryStatus!=='not_sent'||!Array.isArray(order.lines)||!order.lines.length)throw new Error('Recorded estimated order has invalid scope or status');
 if(!sameOrderData(estimatedDraftTotal(order.lines),order.estimate))throw new Error('Recorded order estimate differs from its lines');
 if(!['met','unknown'].includes(order.deliveryMinimum?.status)||!Number.isSafeInteger(order.deliveryMinimum.caseQuantity)||order.deliveryMinimum.caseQuantity!==order.lines.reduce((sum,l)=>sum+l.quantity,0))throw new Error('Recorded delivery minimum snapshot is invalid');
 const seen=new Set();
 for(const l of order.lines){
  if(l.kind!=='estimated_purchase_line'||l.version!==1||!l.id||seen.has(l.id)||l.orderId!==order.id||l.orderUnit!=='case'||l.actualCharge!==null||l.terms?.organizationId!==organizationId||l.terms?.vendorId!==order.vendorId||!Number.isSafeInteger(l.quantity)||l.quantity<=0)throw new Error('Recorded order line has invalid scope or quantity');
  if(!l.approvalId||!Number.isSafeInteger(l.rowRevision)||l.rowRevision<0||['catalogItemId','vendorItemId','sourceDocumentId','sourceRowKey'].some(k=>!l.terms[k]))throw new Error('Recorded order line lacks source evidence');
  const e=estimateCaseCost(l.terms.quotedRate,'measure',l.terms.quotedUnit,l.terms.packSize),money=n=>Math.round((n+Number.EPSILON)*100)/100;
  const expected=e&&{amount:e.amount==null?null:money(e.amount*l.quantity),minimum:e.minimum==null?null:money(e.minimum*l.quantity),maximum:e.maximum==null?null:money(e.maximum*l.quantity),estimated:true,guaranteed:false};
  if(!expected||!sameOrderData(expected,l.estimate))throw new Error('Recorded line estimate differs from source terms');
  seen.add(l.id);
 }
 if(review){
  const requested=order.lines.map(l=>{const r={...l,kind:'estimated_purchase_line_intent',expectedRevision:l.rowRevision,requiresAuthenticatedPersistence:true};delete r.id;delete r.orderId;delete r.rowRevision;return r;});
  if(review.organizationId!==organizationId||review.draftId!==draftId||review.vendorId!==order.vendorId||!sameOrderData(requested,review.requestedLines)||!sameOrderData(order.estimate,review.estimate)||!sameOrderData(order.deliveryMinimum,review.deliveryMinimum))throw new Error('Recorded order differs from the confirmed review');
 }
 return order;
}
export function estimatedOrderExport(order,{organizationId,draftId,customerName='',vendorName=''}={}){
 validateEstimatedOrder(order,{organizationId,draftId});
 return ['KERDOS Purchase Order',`Order: ${order.id}`,`Customer: ${order.customerName||customerName||order.organizationId}`,`Vendor: ${order.vendorName||vendorName||order.vendorId}`,`Recorded: ${order.submittedAt}`,'',
 ...order.lines.map(l=>`${l.quantity} case × ${l.terms.vendorItemCode?`[${l.terms.vendorItemCode}] `:''}${l.terms.description||'Item'} (${l.terms.packSize}) — ${rateText(l.terms.quotedRate)} per ${l.terms.quotedUnit}; estimated ${estimateText(l.estimate)}`),
 '',`Estimated total: ${estimateText(order.estimate)}`,'Final charge: unknown; delivered weight determines the invoice charge. Estimates and range endpoints are not guaranteed.',
 order.deliveryMinimum.status==='unknown'?'Monetary delivery minimum: unconfirmed; verify with the vendor.':'Delivery minimum: case requirement met; no monetary minimum recorded.',
 'Delivery status: not sent by KERDOS. This export does not confirm vendor receipt.'].join('\n');
}
