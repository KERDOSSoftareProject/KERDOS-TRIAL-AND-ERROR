import pdfWorkerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import {createDocumentReader} from "./core/document-reading.js";

function localOcrPath(name="") {
  const base=String(import.meta.env.BASE_URL||"/").replace(/\/$/,"");
  return `${base}/ocr${name?`/${name}`:""}`;
}

// One OCR worker per read; page recognition remains entirely local.
export async function readDocument(file){
  let worker;
  const reader=createDocumentReader({
    loadPdf:async data=>{
      const pdfjsLib=await import("pdfjs-dist");
      pdfjsLib.GlobalWorkerOptions.workerSrc=pdfWorkerUrl;
      const task=pdfjsLib.getDocument({data});
      try{return await task.promise;}catch(error){await task.destroy();throw error;}
    },
    loadWorkbook:()=>import("xlsx"),
    recognizePage:async page=>{
      if(!worker){
        const {createWorker}=await import("tesseract.js");
        try{worker=await createWorker("eng",1,{workerPath:localOcrPath("worker.min.js"),corePath:localOcrPath("core"),langPath:localOcrPath()});}
        catch(error){throw new Error(`This scanned PDF could not start local text recognition: ${error.message||String(error)}`);}
      }
      const viewport=page.getViewport({scale:2}),canvas=document.createElement("canvas");
      canvas.width=viewport.width;canvas.height=viewport.height;
      await page.render({canvasContext:canvas.getContext("2d"),viewport}).promise;
      const {data}=await worker.recognize(canvas,{}, {text:true,blocks:true});
      return {...data,coordinateScale:2};
    },
    readOther:async source=>{
      const name=source.name.toLowerCase(),text=await source.text();
      if(name.endsWith(".eml"))return emailToText(text);
      if(/\.html?$/.test(name))return htmlToText(text);
      return text;
    },
  });
  try{return await reader(file);}finally{if(worker)await worker.terminate();}
}

async function extractPdfText(file){return (await readDocument(file)).text;}

function htmlToText(html){
  const doc=new DOMParser().parseFromString(String(html||""),"text/html");
  doc.querySelectorAll("script,style,iframe,object,svg").forEach(element=>element.remove());
  for(const row of [...doc.querySelectorAll("tr")]){
    const cells=[...row.querySelectorAll(":scope > th,:scope > td")].map(element=>element.textContent.trim().replace(/\s+/g," "));
    row.replaceWith(doc.createTextNode("\n"+cells.join("\t")+"\n"));
  }
  for(const br of [...doc.querySelectorAll("br")])br.replaceWith(doc.createTextNode("\n"));
  for(const element of [...doc.querySelectorAll("p,div,li,h1,h2,h3")])element.append(doc.createTextNode("\n"));
  return (doc.body?.textContent||"").replace(/\n[ \t]+/g,"\n");
}

function emailToText(raw){
  const source=String(raw||"").replace(/\r\n/g,"\n"),headerEnd=source.indexOf("\n\n");
  if(headerEnd<0)return source;
  const headers=source.slice(0,headerEnd),body=source.slice(headerEnd+2);
  const boundary=headers.match(/boundary\s*=\s*["']?([^"';\s]+)/i)?.[1];
  const parts=boundary?body.split(`--${boundary}`):[source];
  const decode=(partHeaders,partBody)=>{
    const encoding=partHeaders.match(/content-transfer-encoding\s*:\s*([^\s;]+)/i)?.[1]?.toLowerCase();
    if(encoding==="base64"){
      try{return new TextDecoder().decode(Uint8Array.from(atob(partBody.replace(/\s/g,"")),character=>character.charCodeAt(0)));}catch{return "";}
    }
    if(encoding==="quoted-printable"){
      const normalized=partBody.replace(/=\n/g,"");
      try{const bytes=[];for(let i=0;i<normalized.length;i++){
        if(normalized[i]==="="&&/^[0-9a-f]{2}$/i.test(normalized.slice(i+1,i+3))){bytes.push(parseInt(normalized.slice(i+1,i+3),16));i+=2;}
        else bytes.push(...new TextEncoder().encode(normalized[i]));
      }return new TextDecoder().decode(new Uint8Array(bytes));}catch{return normalized;}
    }
    return partBody;
  };
  for(const kind of ["text/plain","text/html"]){
    for(const part of parts){
      const index=part.indexOf("\n\n");if(index<0)continue;
      const partHeaders=part.slice(0,index),partBody=part.slice(index+2);
      if(!new RegExp(`content-type\\s*:\\s*${kind.replace("/","\\/")}`,"i").test(partHeaders))continue;
      if(/content-disposition\s*:\s*attachment/i.test(partHeaders))continue;
      const value=decode(partHeaders,partBody.replace(/\n--\s*$/, ""));
      return kind==="text/html"?htmlToText(value):headers.split("\n").filter(line=>/^(?:from|subject|date):/i.test(line)).join("\n")+"\n"+value;
    }
  }
  return headers.split("\n").filter(line=>/^(?:from|subject|date):/i.test(line)).join("\n")+"\n"+body;
}

export async function fileToText(file,{onRead}={}){
  const result=await readDocument(file);
  onRead?.(result);
  return result.text;
}

export {emailToText,htmlToText,extractPdfText};
