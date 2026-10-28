import {validateImage} from '../image-text/image-ocr.mjs';
import {FileReadError} from './portable-file-reader.mjs';

// Same-project, service-only OCR. Renew the existing attachment lease between
// bounded requests; a lost lease cannot lead to a later price/document write.
export async function extractImageText(bytes,{invoke,renewLease}){
  let size;
  try{size=validateImage(bytes,0);}catch(error){throw new FileReadError(error.message);}
  let binary='';for(let i=0;i<bytes.length;i+=8192)binary+=String.fromCharCode(...bytes.subarray(i,i+8192));
  const content=btoa(binary),lines=[];
  for(let part=0;part<size.parts;part++){
    await renewLease();
    const response=await invoke({content,part});
    if(!response.ok){
      if([400,413,422].includes(response.status))throw new FileReadError(response.error||'Image cannot be read');
      throw new Error('Image text service unavailable; automatic retry required');
    }
    const result=response.data;
    if(result.part!==part||result.parts!==size.parts||result.width!==size.width||result.height!==size.height||!Array.isArray(result.lines))throw new Error('Incomplete image text response; automatic retry required');
    for(const line of result.lines){
      if(typeof line.text!=='string'||!Number.isFinite(line.confidence)||line.confidence<0||line.confidence>100)throw new Error('Invalid image text evidence; automatic retry required');
      lines.push({text:line.text,confidence:line.confidence});
    }
  }
  await renewLease();
  return {kind:'lines',lines:lines.map(line=>line.text),ocr:{engine:'tesseract-core-7.0.0',lines,confidence:lines.length?Math.min(...lines.map(line=>line.confidence)):null}};
}
