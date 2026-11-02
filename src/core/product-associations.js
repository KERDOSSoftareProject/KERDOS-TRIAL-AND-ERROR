import {normalizeForMatch} from '../procurement.js';
import {restaurantAssociations} from '../knowledge/restaurant-associations.js';

export const ASSOCIATION_VERSION='product-associations-1';
const tokens=value=>normalizeForMatch(value).filter(w=>!/^\d+(?:\.\d+)?$/.test(w));
const contains=(text,phrase)=>phrase.length>0&&phrase.every(w=>text.includes(w));
const keyOf=words=>[...new Set(words)].sort().join(' ');
const compiledProfiles=new WeakMap();
function compiled(profile){
 if(!compiledProfiles.has(profile))compiledProfiles.set(profile,{concepts:profile.concepts.map(c=>({...c,phrases:c.terms.map(tokens)})),facets:(profile.facets||[]).map(aliases=>({label:aliases[0],phrases:aliases.map(tokens)}))});
 return compiledProfiles.get(profile);
}
export function associationProfile(industry){return String(industry||'').toLowerCase()==='restaurant'?restaurantAssociations:{version:'literal-1',concepts:[],facets:[],fragments:[]};}

export function productAssociationIdentity(row,profile=associationProfile('')){
 const brand=new Set(tokens(row.brand)),pack=new Set(tokens(row.pack_size));
 let description=' '+tokens(row.description).join(' ')+' ';
 for(const value of profile.brandTerms||[]){const phrase=tokens(value).join(' ');if(phrase)description=description.split(' '+phrase+' ').join(' ');}
 const words=description.trim().split(/\s+/).filter(w=>w&&!brand.has(w)&&!pack.has(w));
 const usable=words.filter(w=>!profile.fragments?.includes(w));
 const percentages=[...String(row.description||'').matchAll(/\b(\d+(?:\.\d+)?)\s*%/g)].map(m=>m[1]+'%').sort();
 if(!usable.length||!/[a-z]{3}/i.test(usable.join(' ')))return {key:null,label:row.description||'Missing description',reason:'No identifiable product description'};
 const rules=compiled(profile);
 const matches=rules.concepts.map(c=>({...c,matched:c.phrases.filter(t=>contains(words,t)).sort((a,b)=>b.length-a.length)[0]})).filter(c=>c.matched);
 // Prefer a complete specific phrase over its contained generic nouns.
 const distinct=matches.filter(c=>!matches.some(other=>other!==c&&other.matched.length>c.matched.length&&contains(other.matched,c.matched)));
 const identities=new Map(distinct.map(c=>[keyOf(c.matched),c]));
 if(identities.size>1)return {key:'literal:'+keyOf(words),label:row.description,reason:'Multiple product concepts; retain separately for review'};
 const concept=[...identities.values()][0];
 if(!concept)return {key:'literal:'+keyOf(words),label:row.description,reason:'Literal description; product vocabulary has no unique concept'};
 const facets=rules.facets.filter(f=>f.phrases.some(phrase=>contains(words,phrase))).map(f=>f.label).sort();
 const details=profile.groupDetails===false?[]:[...facets,...percentages];
 return {key:'concept:'+concept.label.toLowerCase()+'|'+details.join('|'),label:concept.label+(details.length?' — '+details.join(', '):''),
  reason:'Shared product concept. Review all vendor details; packs and brands remain independent.'};
}

// Pure preview: never edits mappings, source rows, field evidence or prices.
// A row occurs exactly once, in a proposal (including singleton) or unresolved.
export function buildProductAssociations({vendorItems=[],catalogItems=[],mappings=[],industry='',profile=associationProfile(industry)}){
 const itemById=new Map(catalogItems.map(i=>[i.id,i]));
 const byRow=new Map();for(const m of mappings){const list=byRow.get(m.vendor_item_id)||[];list.push(m);byRow.set(m.vendor_item_id,list);}
 const buckets=new Map(),unresolved=[];
 for(const row of [...vendorItems].sort((a,b)=>String(a.id).localeCompare(String(b.id)))){
  const identity=productAssociationIdentity(row,profile),links=byRow.get(row.id)||[];
  if(!identity.key){unresolved.push({row,reason:identity.reason});continue;}
  const item=itemById.get(links[0]?.catalog_item_id);
  // Existing explicit groups/brand restrictions and rejected pairs are not
  // silently absorbed. A separate intentional manual edit remains available.
  const protectedRow=links.length!==1||!item||item.merged_into_id||item.brand_locked||item.preferred_brand||item.comparison_mode==='exact'||
   row.field_resolutions?.automatic_group_excluded||row.field_resolutions?.catalog_item_id?.confirmedBy||links[0]?.match_method==='rejected';
  const key=protectedRow?'retained:'+(item?.id||row.id):identity.key;
  const list=buckets.get(key)||[];list.push({row,identity,item,protectedRow});buckets.set(key,list);
 }
 const groups=[];
 for(const [key,entries] of buckets){
  // Deterministic complete-link partition: one rejected pair cannot enter the
  // same proposal through a third row (no connected-component chaining).
  const partitions=[];
  for(const e of entries){let part=partitions.find(p=>p.every(x=>!x.row.field_resolutions?.rejected_vendor_item_ids?.includes(e.row.id)&&!e.row.field_resolutions?.rejected_vendor_item_ids?.includes(x.row.id)));
   if(!part){part=[];partitions.push(part);}part.push(e);}
  for(const part of partitions){
   const catalogIds=[...new Set(part.map(e=>e.item?.id).filter(Boolean))];
   const ids=new Set(part.map(e=>e.row.id));
   const safeItems=catalogIds.map(id=>itemById.get(id)).filter(item=>!item.merged_into_id&&!mappings.some(m=>m.catalog_item_id===item.id&&!ids.has(m.vendor_item_id)));
   const target=safeItems.sort((a,b)=>Number(a.master_item_number)-Number(b.master_item_number)||a.id.localeCompare(b.id))[0];
   groups.push({key:key+'|'+part[0].row.id,label:part[0].protectedRow?target?.name||part[0].identity.label:part[0].identity.label,
    rows:part.map(e=>e.row),targetCatalogItemId:target?.id??null,catalogIds,
    saved:catalogIds.length===1&&part.length>1,protected:part.some(e=>e.protectedRow),
    needsApply:(catalogIds.length>1||!target)&&!part.some(e=>e.protectedRow),
    canSave:part.length<=100&&(catalogIds.length>1||!target||part.some(e=>e.row.field_resolutions?.product_group?.confirmed===false))&&!part.some(e=>e.protectedRow),
    reason:part[0].protectedRow?'Existing client decision or restriction retained':!target?'Allocate a distinct KERDOS item for this product group':part[0].identity.reason});
  }
 }
 groups.sort((a,b)=>a.label.localeCompare(b.label)||a.key.localeCompare(b.key));
 return {version:ASSOCIATION_VERSION,profileVersion:profile.version,groups,unresolved,total:vendorItems.length,
  groupedListings:groups.reduce((n,g)=>n+g.rows.length,0)};
}

// Approval concerns identity alone, and expires when the source identity or
// accepted target changes. Pack, price and all field checks stay independent.
export function productGroupApproved(row,item,mapping){
 const record=row?.field_resolutions?.product_group;
 return !!record&&mapping?.match_method==='manual'&&mapping.comparison_track==='exact'&&mapping.confidence_score===100&&
  record.catalogItemId===item?.id&&mapping.catalog_item_id===item?.id&&record.description===row.description&&record.brand===(row.brand??null);
}
