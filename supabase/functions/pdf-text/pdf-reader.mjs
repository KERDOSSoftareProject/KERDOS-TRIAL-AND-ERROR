// Worker-free PDFium adapter. One bounded page per request; never execute PDF
// JavaScript, follow document links, or use a browser canvas.
export const PDF_LIMITS=Object.freeze({bytes:5*1024*1024,pages:20,chars:50000,pixels:4000000,width:2400,height:4000});
export class PdfInputError extends Error{}

export function validatePdf(bytes,page=0){
  if(!(bytes instanceof Uint8Array)||bytes.length<8||new TextDecoder().decode(bytes.subarray(0,5))!=='%PDF-')throw new PdfInputError('Not a valid PDF document');
  if(bytes.length>PDF_LIMITS.bytes)throw new PdfInputError('PDF exceeds the 5 MiB automatic reading limit');
  if(!Number.isInteger(page)||page<0||page>=PDF_LIMITS.pages)throw new PdfInputError('PDF page is outside the supported range');
}

// Reconstruct cell spacing from character coordinates. A PDF commonly stores
// table cells as separate text objects without tabs or useful reading order.
export function positionedPdfLines(chars){
  const rows=[];
  for(const char of chars){
    let row=rows.find(row=>Math.abs(row.y-char.y)<Math.max(2,Math.min(row.height,char.height)*0.35));
    if(!row){row={y:char.y,height:char.height,chars:[]};rows.push(row);}
    row.chars.push(char);
  }
  rows.sort((a,b)=>b.y-a.y);
  const words=row=>{
    const sorted=row.chars.slice().sort((a,b)=>a.x-b.x),out=[];let separated=false;
    for(const char of sorted){
      if(!char.text.trim()){separated=true;continue;}
      const prior=out.at(-1),gap=prior?char.x-prior.right:0;
      if(prior&&!separated&&gap<Math.max(3,char.height*0.6)){prior.text+=char.text;prior.right=char.x+char.width;}
      else out.push({...char,right:char.x+char.width});
      separated=false;
    }
    return out;
  };
  const groups=rows.map(words);
  // Separate repeated Product/Price lanes before combining rows. Never pair a
  // left-hand description with the price from the neighboring table.
  const heading=groups.find(words=>words.filter(w=>/^(product|description)$/i.test(w.text)).length===2&&words.filter(w=>/^price$/i.test(w.text)).length===2);
  let boundary=null;
  if(heading){
    const products=heading.filter(w=>/^(product|description)$/i.test(w.text));
    const prices=heading.filter(w=>/^price$/i.test(w.text));
    if(prices[0].right<products[1].x)boundary=(prices[0].right+products[1].x)/2;
  }
  const join=words=>words.reduce((line,w,i)=>line+(i?(w.x-words[i-1].right>Math.max(10,w.height)?'\t':' '):'')+w.text,'');
  return (boundary===null?[groups]:[groups.map(g=>g.filter(w=>w.x<boundary)),groups.map(g=>g.filter(w=>w.x>=boundary))]).flatMap(lane=>lane.filter(g=>g.length).map(join));
}

export function createPdfPageReader(loadModule,encodePng){
  let modulePromise,tail=Promise.resolve();
  return async(bytes,pageIndex=0)=>{
    validatePdf(bytes,pageIndex);
    const prior=tail;let release;tail=new Promise(resolve=>{release=resolve;});await prior;
    let m,ptr=0,doc=0,page=0,textPage=0,coords=0,bitmap=0,pixels=0;
    try{
      if(!modulePromise)modulePromise=loadModule().then(m=>{m._FPDF_InitLibrary();return m;}).catch(e=>{modulePromise=null;throw e;});
      m=await modulePromise;
      ptr=m.wasmExports.malloc(bytes.length);if(!ptr)throw Error('PDF memory unavailable');m.HEAPU8.set(bytes,ptr);
      doc=m._FPDF_LoadMemDocument(ptr,bytes.length,0);
      if(!doc)throw new PdfInputError(m._FPDF_GetLastError()===4?'PDF requires a password':'PDF is corrupt or uses unsupported encryption');
      const pages=m._FPDF_GetPageCount(doc);
      if(pages<1||pages>PDF_LIMITS.pages)throw new PdfInputError('PDF must contain between 1 and 20 pages');
      if(pageIndex>=pages)throw new PdfInputError('PDF page does not exist');
      page=m._FPDF_LoadPage(doc,pageIndex);if(!page)throw new PdfInputError('PDF page cannot be loaded');
      textPage=m._FPDFText_LoadPage(page);if(!textPage)throw new PdfInputError('PDF text cannot be read');
      const count=m._FPDFText_CountChars(textPage);
      if(count<0||count>PDF_LIMITS.chars)throw new PdfInputError('PDF page exceeds the automatic text limit');
      coords=m.wasmExports.malloc(48);if(!coords)throw Error('PDF memory unavailable');
      const chars=[];let unmapped=false;
      for(let i=0;i<count;i++){
        const value=m._FPDFText_GetUnicode(textPage,i);
        if(!value||value===0xfffd||value>0x10ffff){unmapped=true;continue;}
        const text=String.fromCodePoint(value);if(value<32)continue;
        if(m._FPDFText_HasUnicodeMapError(textPage,i)||Math.abs(m._FPDFText_GetCharAngle(textPage,i))>0.01||!m._FPDFText_GetCharBox(textPage,i,coords,coords+8,coords+16,coords+24)||!m._FPDFText_GetCharOrigin(textPage,i,coords+32,coords+40)){unmapped=true;continue;}
        const [left,right,bottom,top,x,y]=new Float64Array(m.HEAPU8.buffer,coords,6);
        if(![left,right,bottom,top,x,y].every(Number.isFinite)){unmapped=true;continue;}
        chars.push({text,x,y,width:right-x,height:m._FPDFText_GetFontSize(textPage,i)||top-bottom});
      }
      let objects=0;
      const hasImage=(object,depth=0)=>{
        if(++objects>10000||depth>8)return true;
        const type=m._FPDFPageObj_GetType(object);
        if(type===3)return true;
        if(type===5){const n=m._FPDFFormObj_CountObjects(object);for(let i=0;i<n;i++)if(hasImage(m._FPDFFormObj_GetObject(object,i),depth+1))return true;}
        return false;
      };
      let raster=unmapped||!chars.length;
      const n=m._FPDFPage_CountObjects(page);if(n>10000)throw new PdfInputError('PDF page contains too many objects');
      for(let i=0;i<n&&!raster;i++)raster=hasImage(m._FPDFPage_GetObject(page,i));
      if(!raster)return {page:pageIndex,pages,kind:'text',lines:positionedPdfLines(chars)};
      // Any image-bearing page is rasterized as a whole: a text header must
      // never conceal scanned product rows below it. OCR sees the visible page.
      const w=m._FPDF_GetPageWidth(page),h=m._FPDF_GetPageHeight(page);
      if(!Number.isFinite(w)||!Number.isFinite(h)||w<=0||h<=0)throw new PdfInputError('PDF page dimensions are invalid');
      const scale=Math.min(2,PDF_LIMITS.width/w,PDF_LIMITS.height/h,Math.sqrt(PDF_LIMITS.pixels/(w*h)));
      if(scale<1)throw new PdfInputError('PDF page dimensions exceed automatic reading limits');
      const width=Math.floor(w*scale),height=Math.floor(h*scale);
      pixels=m.wasmExports.malloc(width*height*4);if(!pixels)throw Error('PDF image memory unavailable');
      bitmap=m._FPDFBitmap_CreateEx(width,height,4,pixels,width*4);if(!bitmap)throw Error('PDF bitmap unavailable');
      m._FPDFBitmap_FillRect(bitmap,0,0,width,height,0xffffffff);
      m._FPDF_RenderPageBitmap(bitmap,page,0,0,width,height,0,17|512);
      const png=await encodePng(m.HEAPU8.slice(pixels,pixels+width*height*4),width,height);
      if(png.length>PDF_LIMITS.bytes)throw new PdfInputError('Rendered PDF page exceeds automatic image limits');
      let binary='';for(let i=0;i<png.length;i+=8192)binary+=String.fromCharCode(...png.subarray(i,i+8192));
      return {page:pageIndex,pages,kind:'image',width,height,content:btoa(binary)};
    }catch(error){
      // A failed WASM instance must not poison later automatic attempts.
      if(!(error instanceof PdfInputError))modulePromise=null;
      throw error;
    }finally{
      try{
        if(m){if(bitmap)m._FPDFBitmap_Destroy(bitmap);if(pixels)m.wasmExports.free(pixels);if(coords)m.wasmExports.free(coords);if(textPage)m._FPDFText_ClosePage(textPage);if(page)m._FPDF_ClosePage(page);if(doc)m._FPDF_CloseDocument(doc);if(ptr)m.wasmExports.free(ptr);}
      }finally{release();}
    }
  };
}
