import {compareProductIdentity,comparePurchasingPack,priceBasisFor,casePriceFromQuote} from "../procurement.js";

// Invoices are evidence about a vendor listing, never a replacement quote.
// A code ties two documents to the same vendor listing, but conflicting
// descriptions or packs still require a person to resolve the difference.
export function invoiceEvidence(row,invoices=[]){
  const code=String(row.code||"").trim();
  const name=String(row.description||"").trim().toLowerCase();
  const wrapped=invoices.map(entry=>entry&&typeof entry==='object'&&'row' in entry?entry:{row:entry});
  const matches=wrapped.filter(entry=>entry.row&&(code
    ?entry.row.code&&String(entry.row.code).trim()===code
    :!entry.row.code&&name&&String(entry.row.description||"").trim().toLowerCase()===name));
  if(!matches.length)return {matches:[],suggestions:{},conflicts:[]};
  const conflicts=[];
  const valid=matches.filter(entry=>{
    const normalize=value=>String(value||'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim();
    if(normalize(row.description)&&normalize(row.description)===normalize(entry.row.description)||compareProductIdentity(row.description,entry.row.description).status==="same")return true;
    conflicts.push(`Invoice ${entry.number||entry.date||"record"} uses this vendor item number for a different product: ${entry.row.description}.`);
    return false;
  });
  const suggestions={};
  for(const field of ["packSize","brand","sellingUnit"]){
    const stated=valid.filter(entry=>String(entry.row[field]||"").trim());
    if(!stated.length)continue;
    const first=stated[0];
    const different=stated.some(entry=>field==="packSize"
      ?comparePurchasingPack(first.row.packSize,entry.row.packSize).status!=="same"
      :String(first.row[field]).trim().toLowerCase()!==String(entry.row[field]).trim().toLowerCase());
    if(different){
      if(field!=="sellingUnit")conflicts.push(`Invoices disagree on ${field}; check the originals.`);
      continue; // vendors may bill the same physical pack in different units
    }
    const sheetValue=String(row[field]||"").trim();
    if(sheetValue){
      if(field==="sellingUnit"){
        const pack=row.packSize||first.row.packSize;
        const quoted=priceBasisFor(sheetValue),billed=priceBasisFor(first.row.sellingUnit);
        if(quoted&&billed&&casePriceFromQuote(1,quoted.basis,quoted.unit||sheetValue,pack)!=null&&casePriceFromQuote(1,billed.basis,billed.unit||first.row.sellingUnit,pack)!=null)continue;
      }
      if(field==="packSize"?comparePurchasingPack(sheetValue,first.row.packSize).status!=="same":sheetValue.toLowerCase()!==String(first.row[field]).trim().toLowerCase())
        conflicts.push(`Price sheet ${field} (${sheetValue}) differs from invoice ${first.row[field]} (${first.number||first.date||"record"}).`);
    }else suggestions[field]={value:first.row[field],source:first.number||first.date||"invoice"};
  }
  return {matches:valid,suggestions,conflicts};
}

export function enrichFromInvoices(row,invoices=[]){
  const evidence=invoiceEvidence(row,invoices);
  if(evidence.conflicts.length)return row;
  const next={...row},sources={...row.fieldEvidence};
  // Invoice charges never become current quotes. A billed unit by itself
  // does not establish what a different document's price is per.
  for(const field of ["packSize","brand"]){
    const suggestion=evidence.suggestions[field];
    if(!row[field]&&!row.manualFields?.includes(field)&&suggestion){
      next[field]=suggestion.value;
      next[field==="packSize"?"packSource":"brandSource"]="invoice";
      sources[field]={source:"invoice",reference:suggestion.source,
        documentIds:[...new Set(evidence.matches.map(entry=>entry.id).filter(Boolean))]};
    }
  }
  return {...next,fieldEvidence:sources};
}
