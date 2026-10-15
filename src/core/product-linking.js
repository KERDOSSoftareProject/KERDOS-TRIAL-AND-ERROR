import {bestPurchasingMatch,bestPurchasingSuggestion,compareProductIdentity,comparePurchasingPack,normalizeForMatch,productKnowledge,brandsMatch} from '../procurement.js';
export function productDescription(row){
  const brand=new Set(String(row.brand||'').toLowerCase().split(/\s+/).filter(Boolean));
  return String(row.description||'').split(/\s+/).filter(word=>!brand.has(word.toLowerCase())).join(' ');
}
// Category and brand are separate fields. Match understood product + pack,
// comparing each existing vendor listing rather than just a display label.
export function matchExistingProduct(row,catalogItems=[],vendorItems=[],mappings=[]){
  const vi=new Map(vendorItems.map(v=>[v.id,v]));
  const ranked=[];
  for(const item of catalogItems){
    const peers=mappings.filter(m=>m.catalog_item_id===item.id).map(m=>vi.get(m.vendor_item_id)).filter(Boolean);
    if(peers.some(p=>(row.field_resolutions?.rejected_vendor_item_ids||[]).includes(p.id)||(p.field_resolutions?.rejected_vendor_item_ids||[]).includes(row.id)))continue;
    const witnesses=peers.length?peers:[{description:item.name,pack_size:null}];
    for(const peer of witnesses){
      const pack=comparePurchasingPack(row.pack_size,peer.pack_size);
      if(pack.status==='different')continue;
      const candidate={...item,name:productDescription(peer),pack_size:peer.pack_size};
      const found=bestPurchasingMatch(productDescription(row),row.pack_size,[candidate])||bestPurchasingSuggestion(productDescription(row),row.pack_size,[candidate])||(pack.status==='same'&&row.gtin&&row.gtin===peer.gtin?{track:'review',score:0.95,reason:'Matching barcode and pack; verify product wording'}:null);
      if(!found)continue;
      const brandAllowed=!item.brand_locked||brandsMatch(row.brand,item.locked_brand);
      const exact=brandAllowed&&found.track==='exact'&&peers.length>0&&peers.every(p=>compareProductIdentity(productDescription(row),productDescription(p)).status==='same'&&comparePurchasingPack(row.pack_size,p.pack_size).status==='same');
      ranked.push({catalogItemId:item.id,track:exact?'exact':'review',score:found.score,reason:exact?'Product identity and purchasing pack match':!brandAllowed?'Product and pack match; selected brand is required':found.reason||'Product or pack details need confirmation',item});
    }
  }
  ranked.sort((a,b)=>(b.track==='exact')-(a.track==='exact')||b.score-a.score||String(a.item.created_at||'').localeCompare(String(b.item.created_at||''))||String(a.catalogItemId).localeCompare(String(b.catalogItemId)));
  return ranked[0]||null;
}
export function productFamily(row){
  const knowledge=productKnowledge(productDescription(row));
  const food=knowledge.evidence.filter(e=>e.group==='food'&&e.kind==='product').sort((a,b)=>b.term.split(' ').length-a.term.split(' ').length)[0];
  return food?.term.split(' ')[0]||normalizeForMatch(productDescription(row)).sort()[0]||'Other';
}
