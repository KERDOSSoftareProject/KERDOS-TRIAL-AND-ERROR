import {parsePackSize} from '../procurement.js';

// Conservative, industry-neutral identity for alternatives, not exact trade
// items. Brand and the separately recorded purchasing pack may differ. All
// other stated words and numbers remain significant, including qualifiers.
const words=value=>String(value||'').toLowerCase().replace(/[^a-z0-9%]+/g,' ').trim().split(/\s+/).filter(Boolean);
export function alternativeKey(row){
  let text=words(row.description).join(' ');
  const pack=words(row.pack_size).join(' ');
  if(pack)text=(' '+text+' ').split(' '+pack+' ').join(' ').trim();
  const brand=new Set(words(row.brand));
  return words(text).filter(w=>!brand.has(w)&&!['and','the','of'].includes(w)).sort().join(' ');
}
export function automaticAlternativeVerified(row,item,peers=[]){
  const record=row.field_resolutions?.automatic_group;
  const key=alternativeKey(row),pack=parsePackSize(row.pack_size);
  return !!record&&record.catalogItemId===item.id&&item.comparison_mode!=='exact'&&!item.brand_locked&&
    key===record.key&&pack?.parsed&&pack.dimension===record.dimension&&peers.every(peer=>
      alternativeKey(peer)===key&&parsePackSize(peer.pack_size)?.parsed&&parsePackSize(peer.pack_size)?.dimension===pack.dimension);
}
export function alternativeGroups({vendorItems=[],catalogItems=[],mappings=[]}){
  const items=new Map(catalogItems.map(i=>[i.id,i])),rows=new Map(vendorItems.map(v=>[v.id,v]));
  const mapped=new Map(mappings.map(m=>[m.vendor_item_id,m]));
  const peers=new Map();
  for(const m of mappings){const list=peers.get(m.catalog_item_id)||[];list.push(rows.get(m.vendor_item_id));peers.set(m.catalog_item_id,list);}
  const buckets=new Map();
  for(const row of vendorItems){
    const m=mapped.get(row.id),item=items.get(m?.catalog_item_id),key=alternativeKey(row),pack=parsePackSize(row.pack_size);
    if(!item?.category_id||item.brand_locked||item.preferred_brand||item.comparison_mode==='exact'||row.field_resolutions?.automatic_group_excluded||row.field_resolutions?.unit_cost_override||key.length<4)continue;
    // Never absorb or break a group that the client already deliberately built.
    if((peers.get(item.id)||[]).some(p=>!p||alternativeKey(p)!==key||p.field_resolutions?.automatic_group_excluded||p.field_resolutions?.unit_cost_override))continue;
    const id=item.category_id+'|'+key+'|'+(pack?.parsed?pack.dimension:'unknown');
    const bucket=buckets.get(id)||{key,dimension:pack?.parsed?pack.dimension:'unknown',rows:[],catalogIds:new Set()};
    bucket.rows.push(row);bucket.catalogIds.add(item.id);buckets.set(id,bucket);
  }
  return [...buckets.values()].filter(g=>g.rows.length>=2&&g.rows.length<=100&&g.dimension!=='unknown'&&g.catalogIds.size>1)
    .map(g=>({...g,targetCatalogItemId:[...g.catalogIds].sort((a,b)=>Number(items.get(a).master_item_number)-Number(items.get(b).master_item_number)||a.localeCompare(b))[0]}));
}

export function suggestedAlternativeGroups({vendorItems=[],catalogItems=[],mappings=[]}){
  const items=new Map(catalogItems.map(i=>[i.id,i])),mapped=new Map(mappings.map(m=>[m.vendor_item_id,m.catalog_item_id]));
  const buckets=new Map();
  for(const row of vendorItems){const item=items.get(mapped.get(row.id));if(!item?.category_id||item.brand_locked||item.comparison_mode==='exact'||row.field_resolutions?.automatic_group_excluded)continue;
    const list=buckets.get(item.category_id)||[];list.push(row);buckets.set(item.category_id,list);}
  const result=[];
  // Inverted term index avoids comparing every unrelated pair in a catalog.
  // Bound review candidates; clear-match grouping above still scans all rows.
  for(const rows of buckets.values()){
    const index=new Map();
    for(const right of rows){
      const y=new Set(words(alternativeKey(right))),candidates=new Set();
      for(const word of y)for(const left of (index.get(word)||[]).slice(-200))candidates.add(left);
      for(const left of candidates){
        if(mapped.get(left.id)===mapped.get(right.id))continue;
        const x=new Set(words(alternativeKey(left))),shared=[...x].filter(w=>y.has(w));
        if(!shared.length||shared.length/Math.max(x.size,y.size)<0.5)continue;
        result.push({rows:[left,right],reason:'Shared terms: '+shared.join(', ')+'. Check the remaining details before approving.'});
        if(result.length===20)return result;
      }
      for(const word of y){const list=index.get(word)||[];list.push(right);index.set(word,list);}
    }
  }
  return result;
}
