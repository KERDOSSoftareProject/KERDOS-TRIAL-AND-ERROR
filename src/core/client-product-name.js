import {associationProfile,productAssociationIdentity} from './product-associations.js';
import {industryClientNames} from '../knowledge/category-profiles.js';
import {dictionaryTokens} from './term-dictionary.js';
import {productKnowledge} from '../procurement.js';

const title=value=>String(value||'').replace(/\b[a-z]+/g,word=>word[0].toUpperCase()+word.slice(1));
const text=value=>dictionaryTokens(value).join(' ');
export function clientProductName(item,rows=[],industry=''){
 const current=String(item.name||'').trim();
 // A deliberately entered client name takes precedence over display vocabulary.
 if(rows.some(row=>row.field_resolutions?.item_name?.confirmedBy))return current;
 const vocabulary=industryClientNames(industry),profile=associationProfile(industry);
 const sourceWords=dictionaryTokens(current);
 if(!sourceWords.some(word=>/[a-z]/i.test(word)&&!vocabulary.nonProducts?.includes(word)))return null;
 const identity=productAssociationIdentity({description:current},profile);
 if(identity.key?.startsWith('concept:')){
  const [base,...details]=identity.label.split(' — ');
  const name=vocabulary.labels?.[base]||base;
  return title(name)+(details.length?' — '+title(details.join(' — ')):'');
 }
 const normalized=' '+text(productKnowledge(current).text)+' ';
 const aliases=(vocabulary.aliases||[]).filter(entry=>entry.terms.some(term=>normalized.includes(' '+text(term)+' ')));
 if(aliases.length===1)return aliases[0].label;
 // Unknown names stay source-derived. Remove formatting/known brand/pack
 // noise without inventing a product identity from an unexplained abbreviation.
 let clean=text(current);
 for(const row of rows)for(const value of [row.brand,row.pack_size]){
  const known=text(value);if(known)clean=(' '+clean+' ').split(' '+known+' ').join(' ').trim();
 }
 clean=clean.split(' ').filter(word=>!vocabulary.displayNoise?.includes(word)&&!/^\d+(?:\.\d+)?$/.test(word)).join(' ');
 clean=clean.replace(/^\d[\d\s]*\s+/,'').replace(/\b\d{4,}\b/g,'').replace(/\b\d+(?:\.\d+)?\s*(?:lb|lbs|oz|ct|gal|gallon|liter|kg|ml)\b/gi,'').replace(/\s+/g,' ').trim();
 return title(clean||current)||'Product name needed';
}
