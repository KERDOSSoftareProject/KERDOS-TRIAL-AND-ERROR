import {createProcurementContext,getProcurementContext} from '../procurement.js';
import {createProductLabelReader} from './product-label.js';

export const ASSOCIATION_VERSION='product-associations-1';

// Pure preview: never edits mappings, source rows, field evidence or prices.
// A row occurs exactly once, in a proposal (including singleton) or unresolved.
export function buildProductAssociations({vendorItems=[],catalogItems=[],mappings=[],industry='',profile=null,procurement=null}){
 const context=procurement||(industry?createProcurementContext({industry}):getProcurementContext());
 const read=profile?createProductLabelReader({profile}):context.readProductLabel;
 const itemById=new Map(catalogItems.map(i=>[i.id,i]));
 const byRow=new Map();for(const m of mappings){const list=byRow.get(m.vendor_item_id)||[];list.push(m);byRow.set(m.vendor_item_id,list);}
 const buckets=new Map(),unresolved=[];
 for(const row of [...vendorItems].sort((a,b)=>String(a.id).localeCompare(String(b.id)))){
  const identity=read(row),links=byRow.get(row.id)||[];
  if(!identity.key){unresolved.push({row,reason:identity.reason});continue;}
  const mapping=links[0],item=itemById.get(mapping?.catalog_item_id);
  // Existing explicit groups/brand restrictions and rejected pairs are not
  // silently absorbed. A separate intentional manual edit remains available.
  const protectedRow=links.length!==1||!item||item.merged_into_id||item.concept_split_from_id||item.concept_review_required||item.brand_locked||item.preferred_brand||item.comparison_mode==='exact'||
   row.field_resolutions?.automatic_group_excluded||row.field_resolutions?.catalog_item_id?.confirmedBy||
   mapping?.match_method==='rejected'||productGroupApproved(row,item,mapping);
  const key=protectedRow?'retained:'+(item?.id||row.id):identity.key;
  const list=buckets.get(key)||[];list.push({row,identity,item,mapping,protectedRow});buckets.set(key,list);
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
   const protectedGroup=part.some(e=>e.protectedRow);
   const needsApply=!protectedGroup&&(catalogIds.length>1||!target);
   const awaitingConfirmation=!protectedGroup&&!needsApply&&part.some(e=>e.row.field_resolutions?.product_group?.confirmed===false);
   const confirmed=target&&part.every(e=>productGroupApproved(e.row,target,e.mapping));
   const disposition=confirmed?'confirmed':needsApply?'proposed':awaitingConfirmation?'awaiting_confirmation':'retained';
   groups.push({key:key+'|'+part[0].row.id,label:protectedGroup?target?.name||part[0].identity.label:part[0].identity.label,
    rows:part.map(e=>e.row),targetCatalogItemId:target?.id??null,catalogIds,
    disposition,protected:protectedGroup,needsApply,
    canSave:part.length<=100&&(needsApply||awaitingConfirmation),
    reason:protectedGroup?'Existing client decision or restriction retained':!target?'Allocate a distinct KERDOS item for this product group':part[0].identity.reason||'Same product label. Review each vendor listing independently.'});
  }
 }
 groups.sort((a,b)=>a.label.localeCompare(b.label)||a.key.localeCompare(b.key));
 return {version:ASSOCIATION_VERSION,profileVersion:profile?.version??context.associationProfile.version,groups,unresolved,total:vendorItems.length,
  groupedListings:groups.reduce((n,g)=>n+g.rows.length,0)};
}

// Approval concerns product identity alone. A client-entered listing brand
// does not undo the accepted group; preference is checked when ordering.
// A changed description or target still requires a fresh identity review.
export function productGroupApproved(row,item,mapping){
 const record=row?.field_resolutions?.product_group;
 return !!item&&!!record&&record.confirmed!==false&&mapping?.match_method==='manual'&&mapping.comparison_track==='exact'&&mapping.confidence_score===100&&
  record.catalogItemId===item?.id&&mapping.catalog_item_id===item?.id&&record.description===row.description;
}
