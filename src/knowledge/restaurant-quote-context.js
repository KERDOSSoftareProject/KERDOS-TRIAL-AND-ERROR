import {parsePackSize,priceBasisFor} from "../procurement.js";

// Contextual clue, not a confirmed quote. Broad lower bound is a sanity
// check for animal proteins and cheese, never a catalog price or market feed.
// Other industries supply their own vocabulary and reasoning profile.
const ANIMAL_OR_CHEESE=/\b(?:bacon|chic(?:ken)?|beef|pork|turkey|ham|salami|cheese|brst|breast)\b/i;
export function restaurantQuoteContext(row,rows=[]){
  if(row.priceUnavailable||row.sellingUnit||!ANIMAL_OR_CHEESE.test(row.description||""))return null;
  const pack=parsePackSize(row.packSize),amount=Number(row.price);
  if(!pack?.parsed||pack.dimension!=="mass"||pack.unit!=="LB"||pack.total<5||!Number.isFinite(amount)||amount<=0)return null;
  const asCasePerLb=amount/pack.total;
  if(asCasePerLb>=0.75||amount<1||amount>20)return null;
  // A vendor can mix per-case and per-pound amounts in the same column.
  // Similar ambiguous rows corroborate the format, but never certify it.
  const peers=rows.filter(other=>other!==row&&ANIMAL_OR_CHEESE.test(other.description||"")&&
    !other.sellingUnit&&Number(other.price)>1&&Number(other.price)<20&&
    parsePackSize(other.packSize)?.dimension==="mass"&&parsePackSize(other.packSize)?.total>=5&&
    Number(other.price)/parsePackSize(other.packSize).total<0.75);
  const strength=peers.length>=2?90:80;
  return {sellingUnit:"LB",basis:priceBasisFor("LB"),accuracy:strength,
    reason:`${pack.total} LB for $${amount.toFixed(2)} would be $${asCasePerLb.toFixed(2)}/LB if this were a case quote; per LB implies $${(amount*pack.total).toFixed(2)} per case.${peers.length?` ${peers.length} similar weighted row(s) on this sheet strengthen the inference.`:""}`};
}
