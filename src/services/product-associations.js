export function productGroupRequest(group,mappings,{organizationId,requestId,confirmed}){
 if(typeof confirmed!=='boolean')throw new Error('An explicit confirmation choice is required for this group.');
 const members=group.rows.map(row=>{
  const links=mappings.filter(m=>m.vendor_item_id===row.id);
  if(links.length!==1)throw new Error('Each listing needs one current catalog association. Refresh and review.');
  return {id:row.id,revision:row.row_revision??0,catalogItemId:links[0].catalog_item_id};
 }).sort((a,b)=>a.id.localeCompare(b.id));
 return {organizationId,requestId,targetCatalogItemId:group.targetCatalogItemId,name:group.label,members,version:'product-associations-1',confirmed};
}
