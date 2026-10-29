import {validatePdf,PDF_LIMITS} from '../pdf-text/pdf-reader.mjs';
import {validateImage} from '../image-text/image-ocr.mjs';
import {FileReadError} from './portable-file-reader.mjs';

// All source pages must be read successfully before the importer writes rows.
// Keep PDF-page + OCR calls below the hosted nested-request ceiling.
export async function extractPdfText(bytes,{invoke,renewLease,imageTextReader}){
  try{validatePdf(bytes);}catch(error){throw new FileReadError(error.message);}
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  const content=btoa(binary),lines=[];let pages=1,calls=0;
  for(let page=0;page<pages;page++){
    if(++calls>24)throw new FileReadError('PDF exceeds the automatic page/OCR work limit');
    await renewLease();const response=await invoke({content,page});
    if(!response.ok){
      if([400,413,422].includes(response.status))throw new FileReadError(response.error||'PDF cannot be read');
      throw new Error('PDF text service unavailable; automatic retry required');
    }
    const result=response.data;
    if(result.page!==page||!Number.isInteger(result.pages)||result.pages<1||result.pages>PDF_LIMITS.pages||(page>0&&result.pages!==pages))throw new Error('Incomplete PDF page response; automatic retry required');
    pages=result.pages;
    if(result.kind==='text'){
      if(!Array.isArray(result.lines)||result.lines.some(line=>typeof line!=='string')||result.lines.join('\n').length>250000)throw new Error('Invalid PDF text response; automatic retry required');
      lines.push(...result.lines.map(text=>({text,confidence:100,page:page+1,source:'embedded-text'})));
    }else if(result.kind==='image'){
      if(typeof result.content!=='string'||result.content.length>7200000)throw new Error('Invalid PDF image response; automatic retry required');
      let image,size;
      try{image=Uint8Array.from(atob(result.content),c=>c.charCodeAt(0));size=validateImage(image,0);}catch{throw new Error('Invalid PDF page image; automatic retry required');}
      if(size.width!==result.width||size.height!==result.height)throw new Error('Incomplete PDF image response; automatic retry required');
      calls+=size.parts;if(calls>24)throw new FileReadError('PDF exceeds the automatic page/OCR work limit');
      const recognized=await imageTextReader(image);
      if(!recognized.ocr?.lines)throw new Error('Missing PDF OCR evidence; automatic retry required');
      lines.push(...recognized.ocr.lines.map(line=>({...line,page:page+1,source:'scanned-page'})));
    }else throw new Error('Unknown PDF page response; automatic retry required');
  }
  await renewLease();
  return {kind:'lines',lines:lines.map(line=>line.text),ocr:{engine:'pdfium-3.0.0+tesseract-core-7.0.0',lines,confidence:lines.length?Math.min(...lines.map(line=>line.confidence)):null},pdf:{pages}};
}
