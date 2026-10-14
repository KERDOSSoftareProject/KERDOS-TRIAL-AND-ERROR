import {compileDictionary} from "../core/term-dictionary.js";
import {restaurantDictionaries} from "./restaurant-dictionaries.js";

const interpret=compileDictionary(restaurantDictionaries);

export function restaurantProductContext(value) {
  const result=interpret(value);
  // Do this before generic stopword handling: A is a meaningful potato size,
  // even though it is also an English article. No default size is inferred.
  if (/\bpotato(?:es)?\b/.test(result.text)) {
    const found=[];
    result.text=result.text.replace(/\bsize\s+([ab])\b/g,(_,size)=>{found.push(size);return " ";});
    result.text=result.text.replace(/\b(potato(?:es)?)\s+([ab])\b/g,(_,name,size)=>{found.push(size);return name;});
    const sizes=[...new Set(found)];
    if(sizes.length===1) result.attributes.potato_size=sizes[0].toUpperCase();
    if(sizes.length>1) result.unresolved.push({term:"potato size",meaning:"More than one potato size is stated",source:sizes.join(" / "),kind:"ambiguous"});
  }
  result.text=result.text.replace(/\s+/g," ").trim();
  return result;
}
