// A parser upgrade must not let an old row ordinal refer to a different
// product. Check saved source lines before skipping or retrying any row.
export function verifyResumeRows(rows,completedKeys,savedRows){
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
