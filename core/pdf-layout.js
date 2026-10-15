// Preserve independently priced lanes when a PDF prints two Product/Price
// tables next to one another. Detect the repeated headings on each page.
export function pdfTextLines(items) {
  const words=items.filter(item=>item.str?.trim()).map(item=>({x:item.transform[4],y:item.transform[5],str:item.str.trim()}));
  const groups=[];
  for(const word of words){
    let group=groups.find(g=>Math.abs(g.y-word.y)<3);
    if(!group){group={y:word.y,words:[]};groups.push(group);}
    group.words.push(word);
  }
  groups.sort((a,b)=>b.y-a.y);
  const heading=groups.find(g=>g.words.filter(w=>/^product$/i.test(w.str)).length>=2 && g.words.filter(w=>/^price$/i.test(w.str)).length>=2);
  if(!heading){
    const rawLines=groups.map(g=>g.words.sort((a,b)=>a.x-b.x).map(w=>w.str).join(' '));
    // bare price line merge: a line that is only a number belongs to the
    // description on the line before it. sourceLine evidence is on the
    // description row before merging happens.
    const merged=[];
    for(let i=0;i<rawLines.length;i++){
      const next=rawLines[i+1]||"";
      if(next&&/^\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$/.test(next.trim())){merged.push(rawLines[i]+"  "+next.trim());i++;}
      else merged.push(rawLines[i]);
    }
    return merged;
  }
  const products=heading.words.filter(w=>/^product$/i.test(w.str)).sort((a,b)=>a.x-b.x);
  const prices=heading.words.filter(w=>/^price$/i.test(w.str)).sort((a,b)=>a.x-b.x);
  const boundary=(prices[0].x+products[1].x)/2;
  const lanes=[[],[]];
  for(const group of groups){
    for(let lane=0;lane<2;lane++){
      const segment=group.words.filter(w=>lane===0?w.x<boundary:w.x>=boundary).sort((a,b)=>a.x-b.x);
      if(segment.length)lanes[lane].push(segment.map(w=>w.str).join(' '));
    }
  }
  return lanes.map(lane=>{
    const merged=[];
    for(let i=0;i<lane.length;i++){
      const next=lane[i+1]||"";
      if(next&&/^\d{1,3}(?:,\d{3})*(?:\.\d{1,2})?$/.test(next.trim())){merged.push(lane[i]+"  "+next.trim());i++;}
      else merged.push(lane[i]);
    }
    return merged;
  }).flat();
}
