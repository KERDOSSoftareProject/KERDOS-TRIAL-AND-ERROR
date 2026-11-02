// Descriptive source columns are retained, not treated as purchasing fields.
// Vocabulary is supplier/client independent and never learned as a confirmation.
export const isSourceMetadataHeader=label=>/^(?:line (?:number|no)|group (?:name|description)|customer product (?:number|no)|storage description|(?:[a-z0-9]+ )*class description)$/i.test(String(label||'').trim());
export function automaticPriceGroups(groups,unknowns){
 return groups.map(group=>{
  const unresolved=unknowns.filter(p=>p.groupId===group.id).flatMap(p=>p.unknownHeaders).filter(h=>!isSourceMetadataHeader(h.label));
  for(const part of group.parts?.length?group.parts:[group])for(const h of part.layout?.headers||[])if(h.how==='unknown'&&!h.label)unresolved.push({...h,label:'Unlabelled column '+(h.index+1)});
  const headerless=(group.parts?.length?group.parts:[group]).some(part=>!part.layout?.headers?.some(h=>h.how==='recognised'||h.how==='remembered'));
  const reasons=[...(unresolved.length?['Unconfirmed source columns retained for review: '+unresolved.map(h=>h.label).join(', ')]:[]),...(headerless?['Column roles are inferred from a source without recognized headings; confirm before using its quotes.']:[])];
  return reasons.length?{...group,rows:group.rows.map(row=>({...row,issues:[...(row.issues||[]),...reasons],columnReview:unresolved,requiresReview:true}))}:group;
 });
}
