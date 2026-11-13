// One deterministic reader for monetary cells assigned by sheet understanding.
// Strict reading is used to profile a column; qualified reading is used only
// after its role has already been assigned. This module has no I/O or grouping.
import {canonicalQuoteUnit} from './source-units.js';

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

// A quoted price may carry a stated unit. An arbitrary suffix or a malformed
// decimal must leave the assigned cell unresolved, even if it starts with digits.
export function parseAssignedMoney(value){
 const text=String(value??'').trim();
 // Treat one trailing period on a plain decimal as punctuation. The caller
 // retains the original assigned cell and the strict column profiler is unchanged.
 if(/^\d+\.\d+\.$/.test(text))return parseMoney(text.slice(0,-1));
 const number=text.match(/^\(?-?(?:\$\s*)?(?:\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+|,\d{1,2})?)\)?/)?.[0];
 if(!number||number.startsWith('(')!==number.endsWith(')'))return null;
 const suffix=text.slice(number.length).trim();
 if(suffix){
  const unit=suffix.match(/^(?:\/\s*|per\s+)?([a-z][a-z .]*)$/i)?.[1];
  if(!unit||!canonicalQuoteUnit(unit))return null;
 }
 return parseMoney(number);
}
