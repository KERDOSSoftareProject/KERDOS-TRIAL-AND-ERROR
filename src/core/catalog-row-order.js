import {casePriceFromQuote,priceBasisFor,quoteStatus} from '../procurement.js';
import {productFamily} from './product-linking.js';
function packPrice(row,settings){
  const v=row.vendorItem;
  if(quoteStatus(v,settings)!=='current'||v.price_unavailable)return Infinity;
  const override=v.field_resolutions?.unit_cost_override?.value;
  const basis=v.price_basis||priceBasisFor(v.selling_unit)?.basis;
  const amount=override?Number(override.packPrice):casePriceFromQuote(v.price,basis,v.selling_unit,v.pack_size);
  return Number.isFinite(amount)&&amount>0?amount:Infinity;
}
export function compareCatalogRows(a,b,settings={}){
  const text=(x,y)=>String(x||'').localeCompare(String(y||''),undefined,{numeric:true,sensitivity:'base'});
  const group=text(a.evidence.category.value,b.evidence.category.value)||
    text(productFamily({description:a.item.name}),productFamily({description:b.item.name}))||
    text(a.item.name,b.item.name)||text(a.item.id,b.item.id);
  if(group)return group;
  const ap=packPrice(a,settings),bp=packPrice(b,settings);
  if(ap!==bp)return ap<bp?-1:1;
  return text(a.vendor?.name,b.vendor?.name)||text(a.vendorItem.id,b.vendorItem.id);
}
