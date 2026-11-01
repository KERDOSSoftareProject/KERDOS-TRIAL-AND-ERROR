import {billingUnitEvidence} from './billing-unit-evidence.js';
export function billedQuantityHeader(header){
 return /^(?:billed (?:quantity|qty|weight)|(?:quantity|weight) billed|invoice (?:quantity|qty))$/i.test(String(header||'').trim().replace(/\s+/g,' '));
}
const quantityValue=raw=>typeof raw==='string'&&/^(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw.trim())?Number(raw.replaceAll(',','')):null;
// Arithmetic never turns an ordered count or unlabeled quantity into billed weight.
// Unconfirmed source remains retained for later explicit reviewer resolution.
export function invoiceBilledQuantityEvidence(row){
 const s=row?.quantitySource,unit=billingUnitEvidence(row||{});
 if(!s||!unit||!row.sourceLine||typeof s.rawValue!=='string'||typeof s.headerLine!=='string')return null;
 const quantity=quantityValue(s.rawValue);
 if(!Number.isFinite(quantity)||quantity<=0||quantity!==Number(row.qty))return null;
 if(s.kind==='quantity-column'){
  if(!billedQuantityHeader(s.header)||!Number.isSafeInteger(s.columnIndex)||s.columnIndex<0||s.headerLine.split('\t')[s.columnIndex]!==s.header||row.sourceLine.split('\t')[s.columnIndex]!==s.rawValue)return null;
 }else if(s.kind==='goods-invoice-weight'){
  if(!/^(?:Weight|Billed\s+Quantity)$/i.test(s.header)||unit.kind!=='goods-invoice-billed-unit'||!/(?:ORD|ORDERED).*?(?:DLV|DELIVERED).*?UOM.*?Description.*?Pack\s*Size.*?(?:Weight|Billed\s+Quantity).*?Unit\s*Price.*?(?:Extended|Line\s+Total)/i.test(s.headerLine))return null;
  const printed=row.sourceLine.match(/\s+(\d+\.\d{2})\s+\$[\d,]+\.\d{2}\s+\$[\d,]+\.\d{2}\s*$/)?.[1];
  if(printed!==s.rawValue)return null;
 }else return null;
 return {kind:'invoice_billed_quantity',header:s.header,quantity,unit:row.sellingUnit,sourceLine:row.sourceLine,quantitySource:structuredClone(s)};
}
