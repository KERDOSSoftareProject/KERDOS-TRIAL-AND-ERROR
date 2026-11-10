// A parser upgrade must not let an old row ordinal refer to a different
// product. Check saved source lines before skipping or retrying any row.
const snapshotFields=['code','description','brand','packSize','qty','price','amount','sellingUnit','gtin','manufacturerCode','priceNeedsReview','priceUnavailable'];
const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'?Object.fromEntries(Object.keys(value).sort().map(key=>[key,stable(value[key])])):value;
function sourceProof(row,index){
  const provenance=row.sourceProvenance||{};
  return {key:`row:${index}`,sourceLine:row.sourceLine??null,values:snapshotFields.map(field=>row[field]??null),billingUnitEvidence:stable(row.billingUnitEvidence??null),position:{page:provenance.page??null,worksheet:provenance.worksheet??null,table:provenance.table??null,lines:provenance.lines??[],cells:(provenance.cells||[]).map(cell=>cell.text)}};
}
export function createSourceRowSnapshot(rows){return {version:1,rows:rows.map(sourceProof)};}
export function hasWorksheetSnapshot(snapshot){
  return snapshot?.version===1&&Array.isArray(snapshot.rows)&&snapshot.rows.length>0&&
    snapshot.rows.every(row=>typeof row?.position?.worksheet==='string'&&row.position.worksheet.length>0);
}
export const LEGACY_WORKBOOK_REVIEW="This workbook was previously read without a complete worksheet snapshot. Existing rows were kept. Review the saved import and original workbook before re-importing.";

export function verifyResumeRows(rows,completedKeys,savedRows,snapshot=null){
  if(snapshot!==null){
    if(snapshot.version!==1||!Array.isArray(snapshot.rows)||snapshot.rows.length!==rows.length)
      throw new Error('The retained source-row snapshot does not match this file. Existing data was kept.');
    const current=createSourceRowSnapshot(rows);
    // An unfinished ordinal belongs to the same original product too.
    for(const key of new Set([...current.rows.map(row=>row.key),...completedKeys,...savedRows.map(saved=>saved.key).filter(Boolean)])){
      const match=String(key).match(/^row:(\d+)$/),index=match?Number(match[1]):-1;
      const retained=snapshot.rows[index],proof=current.rows[index];
      if(retained?.position?.lines?.length===0&&retained.position.cells?.length===0&&
        rows[index]?.sourceProvenance?.kind==='freeform'){
        // Older freeform snapshots could have exact source text without
        // coordinates. Accept added evidence if the rest of the proof agrees.
        proof.position.lines=[];
        proof.position.cells=[];
      }
      if(!retained||!proof||JSON.stringify(stable(retained))!==JSON.stringify(stable(proof)))
        throw new Error("This file's saved row positions or values differ from the retained source snapshot. Existing data was kept.");
    }
    for(const saved of savedRows){
      if(!saved.key||!saved.sourceLine)continue;
      const index=Number(String(saved.key).slice(4));
      if(String(snapshot.rows[index].sourceLine??'').trim().replace(/""/g,'"')!==String(saved.sourceLine).trim().replace(/""/g,'"'))
        throw new Error('Saved source evidence differs from the retained source snapshot. Existing data was kept.');
    }
    return;
  }
  const normalize=value=>String(value||"").trim().replace(/""/g,'"');
  const byKey=new Map();
  for(const saved of savedRows){
    if(!saved.key)continue;
    const match=String(saved.key).match(/^row:(\d+)$/);
    const current=match?rows[Number(match[1])]:null;
    if(!current||!saved.sourceLine||normalize(current.sourceLine)!==normalize(saved.sourceLine))
      throw new Error("This file's saved row positions differ from the current parser. Existing data was kept. Review the incomplete document before deleting and re-importing it.");
    byKey.set(saved.key,true);
  }
  if(completedKeys.some(key=>!byKey.has(key)))
    throw new Error("A completed import row has no matching saved source evidence. Existing data was kept; review the incomplete document before re-importing it.");
}
