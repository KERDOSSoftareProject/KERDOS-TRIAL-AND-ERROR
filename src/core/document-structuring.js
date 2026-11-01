import {parseDocument,mapColumnsFromHeader,isTableHeader,detectDocumentKind,findQuoteValidity,findInvoiceNumber} from '../ingestion.js';
import {applySourceUnits,documentQuoteUnit} from './source-units.js';

const clean=value=>String(value??'').replace(/[\t\r\n]+/g,' ').trim();
const median=values=>{const sorted=[...values].sort((a,b)=>a-b);return sorted[Math.floor(sorted.length/2)]||1;};
const furniture=text=>/^(?:page\s+\d+|(?:grand\s+)?total\b|subtotal\b|signature\b|terms:|note:|invoice\s+(?:number|date)|bill\s+to\b|ship\s+to\b|tax:|service charge:|\*+\s*(?:notice|thank you)|a finance charge\b|referred for collection\b|\d+\s*(?:cs|pc)(?:\s+\d+(?:\.\d{2})?)?$|cases & pieces:)/i.test(text.trim());
const sectionTitle=text=>/^\*+\s*(?:[a-z]\s*)+\*+$/i.test(text.trim());
const nonProductSection=text=>/(?:following items were out of stock|these are your outstanding invoices)/i.test(text);
const roles=cells=>mapColumnsFromHeader(cells.map(cell=>clean(cell.text??cell)));
const isHeader=(cells,previousColumns={})=>isTableHeader(cells.map(cell=>clean(cell.text??cell)),previousColumns);
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
  return page.items.filter(item=>clean(item.text)).map((item,index)=>({text:clean(item.text),sourceText:item.text,fontFamily:item.fontFamily,x:item.transform[4],y:item.transform[5],width:item.width||0,height:item.height||Math.abs(item.transform[3])||10,item:index,transform:[...item.transform]}));
}
function groupLines(words){
  const tolerance=Math.max(2,median(words.map(word=>word.height))*.4),lines=[];
  for(const word of [...words].sort((a,b)=>b.y-a.y||a.x-b.x)){
    // OCR boxes end at each word's lowest glyph, not a shared baseline.
    // A descender can move one header word below the baseline tolerance even
    // when its box overlaps every other word on the same physical line.
    let line=lines.find(line=>Math.abs(line.y-word.y)<=tolerance||word.box&&line.ocr&&
      Math.min(line.top,word.y+word.height)-Math.max(line.bottom,word.y)>=Math.min(line.height,word.height)*.5);
    if(!line){line={y:word.y,top:word.y+word.height,bottom:word.y,height:word.height,ocr:!!word.box,words:[]};lines.push(line);}
    line.words.push(word);
  }
  return lines.sort((a,b)=>b.y-a.y).map((line,index)=>({...line,index,words:line.words.sort((a,b)=>a.x-b.x)}));
}
function chunks(words){
  const result=[];
  for(const word of words){
    const prior=result.at(-1),gap=prior?word.x-(prior.x+prior.width):Infinity;
    const distinctUnitPack=prior&&/^u\/?m$/i.test(prior.text)&&roles([word]).packSize===0;
    if(prior&&!distinctUnitPack&&gap<=Math.max(5,word.height*.9)){
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
  // A short description heading does not define the right edge of its column.
  // The next heading starts the next lane; keep long descriptions before it.
  const boundaries=anchors.slice(1).map(anchor=>anchor.x-2);
  const cells=anchors.map(()=>({text:'',words:[]}));
  const tokens=words.flatMap(word=>{
    if(word.fontFamily!=='monospace'||!word.sourceText||!boundaries.some(x=>word.x<x&&word.x+word.width>x))return [word];
    const advance=word.width/word.sourceText.length;
    return [...word.sourceText.matchAll(/\S+/g)].map(match=>({...word,text:match[0],x:word.x+match.index*advance,width:match[0].length*advance,sourceSpan:[match.index,match.index+match[0].length]}));
  });
  for(const word of tokens){
    let index=boundaries.findIndex(boundary=>word.x<boundary);if(index<0)index=anchors.length-1;
    const cell=cells[index];cell.text+=(cell.text?' ':'')+word.text;cell.words.push(word);
  }
  return cells;
}
function alignDescriptionPrices(table){
  const map=roles(table.anchors);
  if(table.anchors.length!==2||map.description===undefined||map.price===undefined)return table;
  const body=table.rows.slice(1),prices=body.filter(row=>/^\$?\d+(?:,\d{3})*(?:\.\d{1,2})?$/.test(row.cells[map.price].text.trim()));
  if(prices.length<2)return table;
  const buckets=prices.map(row=>({cells:table.anchors.map(()=>({text:'',words:[]})),center:row.cells[map.price].words[0].y}));
  const height=median(body.flatMap(row=>row.cells.flatMap(cell=>cell.words.map(word=>word.height))));
  const unmatched=[];
  for(const row of body)for(let column=0;column<row.cells.length;column++)for(const word of row.cells[column].words){
    const target=[...buckets].sort((a,b)=>Math.abs(a.center-word.y)-Math.abs(b.center-word.y))[0];
    if(Math.abs(target.center-word.y)>height*1.4){unmatched.push({cells:table.anchors.map((_,index)=>({text:index===column?word.text:'',words:index===column?[word]:[]})),lines:[word.line],y:word.y});continue;}
    target.cells[column].words.push(word);
  }
  const rows=buckets.map(bucket=>{for(const cell of bucket.cells){cell.words.sort((a,b)=>b.y-a.y||a.x-b.x);cell.text=cell.words.map(word=>word.text).join(' ');}return {cells:bucket.cells,lines:[...new Set(bucket.cells.flatMap(cell=>cell.words.map(word=>word.line)))].sort((a,b)=>a-b),y:bucket.center};});
  return {...table,rows:[table.rows[0],...rows,...unmatched].sort((a,b)=>b.y-a.y)};
}
function pdfSegments(reading){
  const segments=[],skipped=[];
  for(const page of reading.pages){
    const words=pageWords(page),lines=groupLines(words);let active=[],afterItems=false;
    const finish=()=>{for(const table of active)if(table.rows.length>1)segments.push(alignDescriptionPrices(table));active=[];};
    if(!words.length){segments.push({kind:'freeform',page:page.number,text:page.text,rows:[],reason:'No reliable horizontal positioned words'});continue;}
    const height=median(words.map(word=>word.height));
    for(const line of lines){
      const parts=chunks(line.words),lanes=headerLanes(parts),text=line.words.map(word=>word.text).join(' ');
      if(nonProductSection(text)){finish();afterItems=true;skipped.push({page:page.number,text,lineNumber:line.index,reason:'non-product invoice section'});continue;}
      if(lanes){
        finish();afterItems=false;
        active=lanes.map((anchors,index)=>({kind:'positioned',page:page.number,anchors,left:index===0?-Infinity:(lanes[index-1].at(-1).x+lanes[index-1].at(-1).width+anchors[0].x)/2,right:index===lanes.length-1?Infinity:(anchors.at(-1).x+anchors.at(-1).width+lanes[index+1][0].x)/2,rows:[{cells:anchors.map(anchor=>({text:anchor.text,words:anchor.words})),lines:[line.index],y:line.y}]}));
        continue;
      }
      if(afterItems||sectionTitle(text)){skipped.push({page:page.number,text,lineNumber:line.index,reason:'non-product invoice section or category heading'});continue;}
      if(furniture(text)){if(/^(?:(?:grand\s+)?total\b|subtotal\b)/i.test(text))finish();skipped.push({page:page.number,line:text,lineNumber:line.index,text,reason:'document metadata or page furniture'});continue;}
      if(active.length){
        for(const table of active){
          const laneWords=line.words.filter(word=>word.x>=table.left&&word.x<table.right).map(word=>({...word,line:line.index}));if(!laneWords.length)continue;
          const cells=assignCells(laneWords,table.anchors),prior=table.rows.at(-1),description=roles(table.anchors).description;
          const populated=cells.map((cell,index)=>cell.text?index:-1).filter(index=>index>=0);
          const price=roles(table.anchors).price;
          if(table.rows.length>1&&prior.cells[description]?.text&&!prior.cells[price]?.text&&prior.y-line.y<=height*.9&&populated.every(index=>index===description||index===price)){
            cells.forEach((cell,index)=>{if(cell.text){prior.cells[index].text+=(prior.cells[index].text?' ':'')+cell.text;prior.cells[index].words.push(...cell.words);}});prior.lines.push(line.index);prior.y=line.y;
          }else if(table.rows.length>1&&populated.length===1&&populated[0]===description&&prior.y-line.y<=height*1.4){
            prior.cells[description].text+=' '+cells[description].text;prior.cells[description].words.push(...cells[description].words);prior.lines.push(line.index);prior.y=line.y;
          }else table.rows.push({cells,lines:[line.index],y:line.y});
        }
      }else skipped.push({page:page.number,line:text,lineNumber:line.index,text,words:line.words,reason:'outside a confirmed table'});
    }
    finish();
    const pageTables=segments.filter(segment=>segment.page===page.number);
    if(pageTables.length){
      const used=new Set(pageTables.flatMap(table=>table.rows.flatMap(row=>row.lines)));
      const excluded=new Set(skipped.filter(line=>line.page===page.number&&/non-product/.test(line.reason)).map(line=>line.lineNumber));
      const outside=lines.filter(line=>!used.has(line.index)&&!excluded.has(line.index)&&!furniture(line.words.map(word=>word.text).join(' ')));
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
    let active=[],headerColumns=null;
    const finish=()=>{if(active.length)segments.push({kind:'native',worksheet:sheet.name,rows:active});active=[];headerColumns=null;};
    for(const row of [...rows.values()].sort((a,b)=>a.lines[0]-b.lines[0])){
      if(!row.cells.some(cell=>cell.text))continue;
      if(isHeader(row.cells,headerColumns||{})){
        if(headerColumns)finish();
        headerColumns=roles(row.cells);
      }
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
    const parsed=parse(input,{includeSourceIndex:true,...(!fallback?{delimiter:'tab'}:{}),...(inferredColumns?{inferredColumns}:{})}),available=[...segment.rows];
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
  const duplicatePages=[];
  if(detectDocumentKind(text)==='invoice'){
    const seen=new Map();
    for(const page of reading.pages||[]){
      const pageParts=parts.filter(part=>structure.segments[part.segment].page===page.number);
      const rows=pageParts.flatMap(part=>part.rows),invoice=findInvoiceNumber(page.text||'');
      if(!invoice||!rows.length)continue;
      const watermark=(page.items||[]).filter(item=>item.height>=median(page.items.map(item=>item.height))*3).map(item=>item.text).join(' ');
      const copy=/\b(?:customer|office|merchant)\b/i.test(watermark)&&/\bcopy\b/i.test(watermark);
      const key=invoice+':'+JSON.stringify(rows.map(row=>[row.code,row.description,row.packSize,row.qty,row.price,row.amount,row.sellingUnit]));
      const prior=seen.get(key);
      if(prior&&(copy||prior.copy)){
        rows.forEach((row,index)=>{const source=prior.rows[index].sourceProvenance;source.copies=[...(source.copies||[]),row.sourceProvenance];});
        pageParts.forEach(part=>{part.rows=[];part.duplicateOf=prior.page;});
        duplicatePages.push({page:page.number,duplicateOf:prior.page,invoice,reason:'Identical invoice rows on an explicitly marked copy page'});
      }else seen.set(key,{page:page.number,rows,copy});
    }
  }
  const kinds=new Set(parts.map(part=>part.documentKind).filter(kind=>kind!=='unknown'));
  const documentKind=detectDocumentKind(text);
  return {...parts[0],rows:parts.flatMap(part=>part.rows),skipped:[...structure.skipped,...parts.flatMap(part=>part.skipped),...duplicatePages],parts,structure,duplicatePages,
    documentKind:documentKind==='unknown'?(kinds.size>1?'mixed':[...kinds][0]||'unknown'):documentKind,quoteValidUntil:findQuoteValidity(text)};
}
