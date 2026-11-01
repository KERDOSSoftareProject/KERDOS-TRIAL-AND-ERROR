const priceHeader=h=>/^(?:unit price|price|rate|billed rate)$/i.test(String(h).trim().replace(/\s+/g,' '));
const amountHeader=h=>/^(?:extended price|extended amount|extended|line total|line amount|amount|ext\.? price|total amount)$/i.test(String(h).trim().replace(/\s+/g,' '));
const money=raw=>typeof raw==='string'&&/^\$?(?:\d+|\d{1,3}(?:,\d{3})+)(?:\.\d+)?$/.test(raw.trim())?Number(raw.replace(/[$,]/g,'')):null;
export function invoiceChargeSourceMatches(invoiceLine){
 const s=invoiceLine?.quantitySource,row=invoiceLine?.row;if(!s||typeof row?.sourceLine!=='string')return false;
 let price,amount;
 if(s.kind==='quantity-column'){
  if(typeof s.headerLine!=='string')return false;
  const headers=s.headerLine.split('\t'),p=headers.map((h,i)=>priceHeader(h)?i:-1).filter(i=>i>=0),a=headers.map((h,i)=>amountHeader(h)?i:-1).filter(i=>i>=0),cells=row.sourceLine.split('\t');
  if(p.length!==1||a.length!==1||p[0]===a[0]||p[0]===s.columnIndex||a[0]===s.columnIndex)return false;
  price=money(cells[p[0]]);amount=money(cells[a[0]]);
 }else if(s.kind==='goods-invoice-weight'){
  const matches=row.sourceLine.match(/\s+\$([\d,]+\.\d{2})\s+\$([\d,]+\.\d{2})\s*$/);if(!matches)return false;price=money(matches[1]);amount=money(matches[2]);
 }else return false;
 return price!=null&&amount!=null&&price===row.price&&amount===row.amount;
}
