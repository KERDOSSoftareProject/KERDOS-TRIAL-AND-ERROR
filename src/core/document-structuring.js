import {parseDocument,mapColumnsFromHeader,detectDocumentKind,findQuoteValidity} from '../ingestion.js';
import {applySourceUnits,documentQuoteUnit} from './source-units.js';

const clean=value=>String(value??'').replace(/[\t\r\n]+/g,' ').trim();
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)]||1;};
const furniture=text=>/^(?:page\s+\d+|(?:grand\s+)?total\b|subtotal\b|signature\b|terms:|note:|invoice\s+(?:number|date)|bill\s+to\b|ship\s+to\b)/i.test(text.trim());
const roles=cells=>mapColumnsFromHeader(cells.map(cell=>clean(cell.text??cell)));
const isHeader=cells=>{const map=roles(cells);return map.description!==undefined&&map.price!==undefined;};
const lineText=row=>row.cells.map(cell=>clean(cell.text)).join('\t');

function ocrWords(nodes,scale,height,result=[]){
  for(const node of nodes||[]){
    const children=node.paragraphs||node.lines||node.words;
    if(children?.length){ocrWords(children,scale,height,result);continue;}
    const box=node.bbox;
    if(clean(node.text)&&box)result.push({text:clean(node.text),x:box.x0/scale,y:height-box.y1/scale,width:(box.x1-box.x0)/scale,height:(box.y1-box.y0)/scale,box:{...box},confidence:node.confidence??null});
  }
  return result;
}
function pageWords(page){
  if(page.source==='local-ocr')return ocrWords(page.ocr?.blocks,page.ocr?.coordinateScale||1,page.height);
  if(page.items.some(item=>Math.abs(item.transform[1])>.01||Math.abs(item.transform[2])>.01))return [];
  return page.items.filter(item=>clean(item.text)).map((item,index)=>({text:clean(item.text),x:item.transform[4],y:item.transform[5],width:item.width||0,height:item.height||Math.abs(item.transform[3])||10,item:index,transform:[...item.transform]}));
}
function groupLines(words){
  const tolerance=Math.max(2,median(words.map(word=>word.height))*.4),lines=[];
  for(const word of [...words].sort((a,b)=>b.y-a.y||a.x-b.x)){
    let line=lines.find(line=>Math.abs(line.y-word.y)<=tolerance);
    if(!line){line={y:word.y,words:[]};lines.push(line);}
    line.words.push(word);
  }
  return lines.sort((a,b)=>b.y-a.y).map((line,index)=>({...line,index,words:line.words.sort((a,b)=>a.x-b.x)}));
}
function chunks(words){
  const result=[];
  for(const word of words){
    const prior=result.at(-1),gap=prior?word.x-(prior.x+prior.width):Infinity;
    if(prior&&gap<=Math.max(5,word.height*.9)){
      prior.text+=' '+word.text;prior.width=Math.max(prior.x+prior.width,word.x+word.width)-prior.x;prior.words.push(word);
    }else result.push({...word,words:[word]});
  }
  return result;
}
function headerLanes(cells){
  if(!isHeader(cells))return null;
  const firstRole=Object.keys(roles([cells[0]]))[0];
  const starts=firstRole?cells.map((cell,index)=>roles([cell])[firstRole]===0?index:-1).filter(index=>index>=0):[0];
  const cuts=starts.length>1?starts:[0];
  const lanes=cuts.map((start,index)=>cells.slice(start,cuts[index+1]??cells.length));
  return lanes.every(isHeader)?lanes:[cells];
}
function assignCells(words,anchors){
  const boundaries=anchors.slice(1).map((anchor,index)=>(anchors[index].x+anchors[index].width+anchor.x)/2);
  const cells=anchors.map(()=>({text:'',words:[]}));
  for(const word of words){
    let index=boundaries.findIndex(boundary=>word.x<boundary);if(index<0)index=anchors.length-1;
    const cell=cells[index];cell.text+=(cell.text?' ':'')+word.text;cell.words.push(word);
  }
  return cells;
}
function pdfSegments(reading){
  const segments=[],skipped=[];
  for(const page of reading.pages){
    const words=pageWords(page),lines=groupLines(words);let active=[];
    const finish=()=>{for(const table of active)if(table.rows.length>1)segments.push(table);active=[];};
    if(!words.length){segments.push({kind:'freeform',page:page.number,text:page.text,rows:[],reason:'No reliable horizontal positioned words'});continue;}
    const height=median(words.map(word=>word.height));
    for(const line of lines){
      const parts=chunks(line.words),lanes=headerLanes(parts),text=line.words.map(word=>word.text).join(' ');
      if(lanes){
        finish();
        active=lanes.map((anchors,index)=>({kind:'positioned',page:page.number,anchors,left:index===0?-Infinity:(lanes[index-1].at(-1).x+lanes[index-1].at(-1).width+anchors[0].x)/2,right:index===lanes.length-1?Infinity:(anchors.at(-1).x+anchors.at(-1).width+lanes[index+1][0].x)/2,rows:[{cells:anchors.map(anchor=>({text:anchor.text,words:anchor.words})),lines:[line.index],y:line.y}]}));
        continue;
      }
      if(furniture(text)){if(/^(?:(?:grand\s+)?total\b|subtotal\b)/i.test(text))finish();skipped.push({page:page.number,line:text,lineNumber:line.index,text,reason:'document metadata or page furniture'});continue;}
      if(active.length){
        for(const table of active){
          const laneWords=line.words.filter(word=>word.x>=table.left&&word.x<table.right);if(!laneWords.length)continue;
          const cells=assignCells(laneWords,table.anchors),prior=table.rows.at(-1),description=roles(table.anchors).description;
          const populated=cells.map((cell,index)=>cell.text?index:-1).filter(index=>index>=0);
          if(table.rows.length>1&&populated.length===1&&populated[0]===description&&prior.y-line.y<=height*1.4){
            prior.cells[description].text+=' '+cells[description].text;prior.cells[description].words.push(...cells[description].words);prior.lines.push(line.index);prior.y=line.y;
          }else table.rows.push({cells,lines:[line.index],y:line.y});
        }
      }else skipped.push({page:page.number,line:text,lineNumber:line.index,text,words:line.words,reason:'outside a confirmed table'});
    }
    finish();
    const pageTables=segments.filter(segment=>segment.page===page.number);
    if(pageTables.length){
      const used=new Set(pageTables.flatMap(table=>table.rows.flatMap(row=>row.lines)));
      const outside=lines.filter(line=>!used.has(line.index)&&!furniture(line.words.map(word=>word.text).join(' ')));
      if(outside.length)segments.push({kind:'freeform',page:page.number,text:outside.map(line=>line.words.map(word=>word.text).join(' ')).join('\n'),rows:[],reason:'Content outside positioned tables remains available to fallback'});
    }
    if(!pageTables.length){
      // Alignment can establish structure without inventing field labels. Three
      // consistently aligned rows are required; field roles stay parser evidence.
      const candidates=lines.filter(line=>!furniture(line.words.map(word=>word.text).join(' '))).map(line=>({...line,cells:chunks(line.words)}));
      const count=candidates[0]?.cells.length;
      const aligned=candidates.length>=3&&count>=2&&candidates.every(row=>row.cells.length===count&&row.cells.every((cell,index)=>Math.abs(cell.x-candidates[0].cells[index].x)<=height));
      if(aligned)segments.push({kind:'positioned-unlabelled',page:page.number,rows:candidates.map(line=>({cells:line.cells,lines:[line.index]}))});
      else segments.push({kind:'freeform',page:page.number,text:page.text,rows:[],reason:'Geometry does not establish reliable columns'});
    }
  }
  return {segments,skipped};
}
function worksheetSegments(reading){
  const segments=[];
  for(const sheet of reading.worksheets){
    if(!sheet.cells.length)continue;
    const min=Math.min(...sheet.cells.map(cell=>cell.column)),max=Math.max(...sheet.cells.map(cell=>cell.column));
    const rows=new Map();
    for(const cell of sheet.cells){
      if(!rows.has(cell.row))rows.set(cell.row,{cells:Array.from({length:max-min+1},()=>({text:'',cells:[]})),lines:[cell.row]});
      const slot=rows.get(cell.row).cells[cell.column-min];slot.text=clean(cell.value);slot.cells.push(cell);
    }
    let active=[];
    const finish=()=>{if(active.length)segments.push({kind:'native',worksheet:sheet.name,rows:active});active=[];};
    for(const row of [...rows.values()].sort((a,b)=>a.lines[0]-b.lines[0])){
      if(!row.cells.some(cell=>cell.text))continue;
      if(isHeader(row.cells)&&active.some(prior=>isHeader(prior.cells)))finish();
      active.push(row);
    }
    finish();
  }
  return {segments,skipped:[]};
}

export function structureDocument(reading){
  if(reading?.pages?.length)return pdfSegments(reading);
  if(reading?.worksheets?.length)return worksheetSegments(reading);
  return {segments:[],skipped:[]};
}

function unlabelledRoles(segment){
  if(segment.kind!=='positioned-unlabelled')return null;
  const count=segment.rows[0].cells.length;
  const columns=Array.from({length:count},(_,index)=>segment.rows.map(row=>row.cells[index].text));
  const money=columns.map((values,index)=>values.every(value=>/^\$?[\d,]+\.\d{2}$/.test(value))?index:-1).filter(index=>index>=0);
  if(money.length!==1)return null;
  const text=columns.map((values,index)=>({index,length:values.every(value=>/[a-z]{2}/i.test(value)&&!/^\d/.test(value))?values.reduce((sum,value)=>sum+value.length,0):0})).sort((a,b)=>b.length-a.length)[0];
  return text?.length?{price:money[0],description:text.index}:null;
}

// All parts stay inside ONE original file group/document. Row ordinals remain
// deterministic for duplicate/resume keys, while layouts are tracked per table.
export function parseStructuredDocument(text,reading,parse=(input,options)=>parseDocument(input,options)){
  const structure=structureDocument(reading);
  if(!structure.segments.length)return {...parse(text),parts:[],structure};
  const parts=structure.segments.map((segment,index)=>{
    const inferredColumns=unlabelledRoles(segment);
    const fallback=segment.kind==='freeform'||(segment.kind==='positioned-unlabelled'&&!inferredColumns);
    const input=fallback?(segment.text??segment.rows.map(row=>row.cells.map(cell=>clean(cell.text)).join(' ')).join('\n')):segment.rows.map(lineText).join('\n');
    const parsed=parse(input,{includeSourceIndex:true,...(inferredColumns?{inferredColumns}:{})}),available=[...segment.rows];
    const rows=parsed.rows.map(row=>{
      const at=available.findIndex(source=>lineText(source)===row.sourceLine);
      const source=Number.isInteger(row.sourceIndex)?segment.rows[row.sourceIndex]:(at>=0?available.splice(at,1)[0]:null);
      const page=reading.pages?.find(page=>page.number===segment.page);
      const confidence=source?.cells.flatMap(cell=>cell.words||[]).map(word=>word.confidence).filter(value=>typeof value==='number')||[];
      if(page?.source==='local-ocr'&&typeof page.ocr?.confidence==='number')confidence.push(page.ocr.confidence);
      const lowOcr=confidence.some(value=>value<90);
      const issues=[...(row.issues||[]),...(inferredColumns?[{kind:'inferred-column',message:'Price column inferred from aligned decimal amounts; no column label confirms its meaning.'}]:[]),...(lowOcr?[{kind:'low-confidence-ocr',message:'Source recognition is below 90%; retained values need confirmation.'}]:[])];
      return {...applySourceUnits(row,{documentUnit:documentQuoteUnit(text)}),...(inferredColumns||lowOcr?{priceNeedsReview:true,issues}:{}),sourceProvenance:{filename:reading.filename,kind:fallback?'freeform':segment.kind,page:segment.page??null,worksheet:segment.worksheet??null,table:index,lines:source?.lines??[],cells:source?.cells??[],fallback}};
    });
    return {...parsed,rows,segment:index};
  });
  const kinds=new Set(parts.map(part=>part.documentKind).filter(kind=>kind!=='unknown'));
  const documentKind=detectDocumentKind(text);
  return {...parts[0],rows:parts.flatMap(part=>part.rows),skipped:[...structure.skipped,...parts.flatMap(part=>part.skipped)],parts,structure,
    documentKind:documentKind==='unknown'?(kinds.size>1?'mixed':[...kinds][0]||'unknown'):documentKind,quoteValidUntil:findQuoteValidity(text)};
}
