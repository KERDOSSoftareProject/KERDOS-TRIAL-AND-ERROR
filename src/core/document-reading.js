import {pdfTextLines} from './pdf-layout.js';

// Reading retains source structure. B3 may derive rows from these records;
// the text remains available to the existing parser during that transition.
export function readWorkbook(workbook,XLSX,filename,kind='workbook'){
  const worksheets=workbook.SheetNames.map(name=>{
    const sheet=workbook.Sheets[name],reference=sheet['!ref']||null;
    const range=reference?XLSX.utils.decode_range(reference):null;
    const cells=[];
    if(range)for(let row=range.s.r;row<=range.e.r;row++)for(let column=range.s.c;column<=range.e.c;column++){
      const address=XLSX.utils.encode_cell({r:row,c:column}),cell=sheet[address];
      if(cell)cells.push({address,row:row+1,column:column+1,value:cell.v??null,type:cell.t,formula:cell.f??null,formatted:cell.w??null});
    }
    return {name,reference,cells,text:XLSX.utils.sheet_to_csv(sheet)};
  });
  return {kind,filename,worksheets,pages:[],text:worksheets.map(sheet=>sheet.text).filter(text=>text.replace(/[\s,]/g,'').length>0).join('\n')};
}

export async function readPdf(pdf,filename,recognizePage){
  const pages=[];
  for(let number=1;number<=pdf.numPages;number++){
    const page=await pdf.getPage(number);
    try{
      const content=await page.getTextContent();
      const items=content.items.filter(item=>typeof item.str==='string').map(item=>({
        text:item.str,transform:Array.from(item.transform),width:item.width,height:item.height,
        direction:item.dir,fontName:item.fontName,hasEOL:!!item.hasEOL,
      }));
      const text=pdfTextLines(content.items).join('\n');
      const viewport=page.getViewport({scale:1});
      if(text.trim())pages.push({number,width:viewport.width,height:viewport.height,source:'embedded-text',items,text,ocr:null});
      else{
        const ocr=await recognizePage(page);
        pages.push({number,width:viewport.width,height:viewport.height,source:'local-ocr',items,text:ocr.text||'',ocr:{confidence:ocr.confidence??null,coordinateScale:ocr.coordinateScale??1,blocks:ocr.blocks??[]}});
      }
    }finally{page.cleanup?.();}
  }
  return {kind:'pdf',filename,worksheets:[],pages,text:pages.map(page=>page.text+'\n').join('')};
}

export function createDocumentReader({loadPdf,loadWorkbook,recognizePage,readOther}){
  return async function readDocument(file){
    const name=file.name.toLowerCase();
    if(name.endsWith('.pdf')){
      const pdf=await loadPdf(await file.arrayBuffer());
      try{return await readPdf(pdf,file.name,recognizePage);}finally{await pdf.loadingTask.destroy();}
    }
    if(/\.(xlsx|xls|csv)$/.test(name)){
      const XLSX=await loadWorkbook();
      const csv=name.endsWith('.csv');
      // Keep CSV text exact for fingerprints; its cells supplement that text.
      const text=csv?await file.text():null;
      const workbook=XLSX.read(csv?text:await file.arrayBuffer(),csv?{type:'string',raw:true}:{type:'array'});
      const result=readWorkbook(workbook,XLSX,file.name,csv?'csv':'workbook');
      if(csv)result.text=text;
      return result;
    }
    return {kind:'text',filename:file.name,text:await readOther(file),pages:[],worksheets:[]};
  };
}
