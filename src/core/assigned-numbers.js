// One deterministic reader for monetary cells assigned by sheet understanding.
// Strict reading is used to profile a column; qualified reading is used only
// after its role has already been assigned. This module has no I/O or grouping.
export function parseMoney(str){
 if(str==null)return null;
 let cleaned=String(str).replace(/[$]/g,'').trim();
 if(/^-?\d+,\d{1,2}$/.test(cleaned))cleaned=cleaned.replace(',','.');
 else cleaned=cleaned.replace(/,/g,'');
 let negative=false;
 if(/^\(.*\)$/.test(cleaned)){
  negative=true;cleaned=cleaned.slice(1,-1).trim();
 }
 if(!/^-?\d+(\.\d+)?$/.test(cleaned))return null;
 const value=Number(cleaned);
 return Number.isFinite(value)?negative?-Math.abs(value):value:null;
}

export function parseMoneyLenient(str){
 if(str==null)return null;
 const exact=parseMoney(str);
 if(exact!==null)return exact;
 const match=String(str).trim().match(/^\(?-?\$?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?\)?/);
 return match?.[0]?.trim()?parseMoney(match[0]):null;
}
