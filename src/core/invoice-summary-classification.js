export const invoiceSummaryCategory=label=>{
 if(/^(subtotal|sub total|merchandise subtotal|item subtotal)$/.test(label))return 'subtotal';
 if(/^(invoice total|grand total|total due|amount due|total)$/.test(label))return 'total';
 if(/^(tax|sales tax|vat|gst|hst)$/.test(label))return 'tax';
 if(/^(freight|shipping|shipping charge|delivery|delivery charge|delivery fee)$/.test(label))return 'freight';
 if(/^(credit|credits|discount|discounts)$/.test(label))return 'credits';
 if(/^(fuel surcharge|service charge|handling fee|other charges|other fees)$/.test(label))return 'other';
 return null;
};
// Relabel retained whole monetary lines only. Never invent amounts or ignore a line.
export const summaryKinds={subtotal:'Subtotal',tax:'Tax',freight:'Freight',credits:'Credits',other:'Other charges',total:'Invoice Total'};
const key=value=>String(value??'').trim().replace(/[,|\s]+/g,' ');
export const sameSummaryData=(a,b)=>JSON.stringify(sort(a))===JSON.stringify(sort(b));
function sort(v){return Array.isArray(v)?v.map(sort):v&&typeof v==='object'?Object.fromEntries(Object.keys(v).sort().map(k=>[k,sort(v[k])])):v;}
export function invoiceSummaryBasis(source){return {rawText:source.header.rawText??'',itemSources:source.lines.map(l=>l.sourceLine??null)};}
export function classifyInvoiceSummary(basis,mappings){
 if(typeof basis?.rawText!=='string'||basis.rawText.length>1000000||!Array.isArray(basis.itemSources)||basis.itemSources.some(x=>x!==null&&typeof x!=='string')||!Array.isArray(mappings)||mappings.length>50)throw Error('Summary classification needs bounded retained source and mappings');
 const lines=basis.rawText.replaceAll('\r','').split('\n'),items=new Set(basis.itemSources.map(key));let previous=0;
 for(const m of mappings){
  if(!Number.isSafeInteger(m?.lineNumber)||m.lineNumber<=previous||m.lineNumber>lines.length||!Object.hasOwn(summaryKinds,m.kind)||!sameSummaryData(m,{lineNumber:m.lineNumber,kind:m.kind}))throw Error('Choose unique ordered source lines and supported summary categories');previous=m.lineNumber;
  const raw=lines[m.lineNumber-1],match=raw.trim().match(/^(.+?)\s*[:\t, ]\s*(\(?-?\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d{2})\)?)\s*$/);
  if(!match||items.has(key(raw)))throw Error('Classify a complete retained monetary summary line, never an item line');
  const recognized=invoiceSummaryCategory(match[1].trim().toLowerCase().replace(/[:\s]+$/,'').replace(/\s+/g,' '));if(recognized&&recognized!==m.kind)throw Error('Recognized summary labels retain their existing category');
  let money=match[2].replaceAll(',','').replace('$','');if(money.startsWith('(')){if(!money.endsWith(')')||money.includes('-'))throw Error('Summary monetary sign needs clarification');money='-'+money.slice(1,-1);}else if(money.endsWith(')'))throw Error('Summary monetary sign needs clarification');
  // BigInt avoids rounding before the existing reconciliation parser sees the token.
  if(money.length>32||!/^-?\d+\.\d{2}$/.test(money)||BigInt(money.replace('-','').replace('.',''))>9007199254740991n)throw Error('Summary monetary precision needs clarification');
  lines[m.lineNumber-1]=summaryKinds[m.kind]+' '+match[2];
 }
 return lines.join('\n');
}
export function validateSummaryClassification(record,organizationId,invoiceId){
 if(record?.kind!=='invoice_summary_classification'||record.version!==1||!record.id||record.organizationId!==organizationId||record.invoiceId!==invoiceId||!record.requestId||!record.recordedBy||!Number.isFinite(Date.parse(record.recordedAt))||!Number.isSafeInteger(record.revision)||record.revision<1||(record.revision===1?record.previousId!==null:!record.previousId)||typeof record.reason!=='string'||record.reason!==record.reason.trim()||[...record.reason].length<10||[...record.reason].length>500||record.classifiedText!==classifyInvoiceSummary(record.basis,record.mappings))throw Error('Invalid invoice summary classification audit');
 return record;
}
export function invoiceSummaryText(source){
 const record=source.summaryClassification;if(!record)return source.header.rawText;
 validateSummaryClassification(record,source.organizationId,source.invoiceId);
 if(!sameSummaryData(record.basis,invoiceSummaryBasis(source)))throw Error('Summary classification source changed; review the retained source again');
 return record.classifiedText;
}
