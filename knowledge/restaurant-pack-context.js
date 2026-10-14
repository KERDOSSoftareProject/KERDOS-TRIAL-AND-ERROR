// These words describe the product, not a missing quantity. Keep them in
// the raw pack and comparison signature while reading its measurement.
const QUALIFIERS=new Map([["slicing","slicing"],["fresh","fresh"],["frozen","frozen"],
  ["imp","imported"],["imported","imported"],["domest","domestic"],["domestic","domestic"]]);
export function restaurantPackContext(text){
  const qualifiers=[];
  const working=String(text).replace(/\b(slicing|fresh|frozen|imp|imported|domest|domestic)(?=\b|\d)/gi,word=>{
    qualifiers.push(QUALIFIERS.get(word.toLowerCase()));return " ";
  }).replace(/\s+/g," ").trim();
  return {working,qualifiers:[...new Set(qualifiers)].sort()};
}
