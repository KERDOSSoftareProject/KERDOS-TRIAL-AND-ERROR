import {associationProfile,productAssociationIdentity} from './product-associations.js';
import {industryClientNames} from '../knowledge/category-profiles.js';
import {dictionaryTokens} from './term-dictionary.js';
import {productKnowledge} from '../procurement.js';

const title=value=>String(value||'').replace(/\b[a-z]+/g,word=>word[0].toUpperCase()+word.slice(1));
const text=value=>dictionaryTokens(value).join(' ');
export function clientProductName(item,rows=[],industry=''){
 let current=String(item.name||'').trim();
 const vocabulary=industryClientNames(industry),profile=associationProfile(industry);
 // A brand is metadata, never the item identity. Remove exact brand phrases
 // supplied by the listings or industry vocabulary before interpreting names.
 const brands=[...new Set([...(vocabulary.brands||[]),...rows.map(row=>row.brand).filter(Boolean)])];
 let withoutBrands=' '+text(current)+' ';
 for(const brand of brands){const phrase=text(brand);if(phrase)withoutBrands=withoutBrands.split(' '+phrase+' ').join(' ');}
 if(text(withoutBrands)!==text(current)){
  const meaningful=dictionaryTokens(withoutBrands).filter(word=>!/^\d/.test(word)&&!vocabulary.nonProducts?.includes(word));
  if(!meaningful.length){
   const identities=rows.map(row=>productAssociationIdentity(row,profile)).filter(identity=>identity.key?.startsWith('concept:'));
   const labels=[...new Set(identities.map(identity=>identity.label))];
   if(labels.length!==1)return null;
   current=labels[0];
  }else current=withoutBrands.trim();
 }
 // Deliberately entered client names still take precedence over synonyms.
 const confirmedGroup=rows.length>0&&rows.every(row=>{
  const decision=row.field_resolutions?.product_group;
  return decision?.confirmedBy&&decision.catalogItemId===item.id&&decision.description===row.description&&decision.brand===(row.brand??null);
 });
 if(confirmedGroup||rows.some(row=>row.field_resolutions?.item_name?.confirmedBy))return current;
 const sourceWords=dictionaryTokens(current);
 if(!sourceWords.some(word=>/[a-z]/i.test(word)&&!vocabulary.nonProducts?.includes(word)&&!/^\d/.test(word)))return null;
 const identity=productAssociationIdentity({description:current},profile);
 if(identity.key?.startsWith('concept:')){
  if(vocabulary.labels?.[identity.label])return vocabulary.labels[identity.label];
  const [base,...details]=identity.label.split(' — ');
  const name=vocabulary.labels?.[base]||base;
  return title(name)+(profile.groupDetails!==false&&details.length?' — '+title(details.join(' — ')):'');
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
