import {PDFiumModule} from 'npm:@hyzyla/pdfium@3.0.0';
import UPNG from 'npm:upng-js@2.1.0';
import {authorizedServiceRequest} from '../process-attachment/request-auth.mjs';
import {createPdfPageReader,PdfInputError} from './pdf-reader.mjs';
const WASM_URL='https://cdn.jsdelivr.net/npm/@hyzyla/pdfium@3.0.0/dist/pdfium.wasm';
const WASM_SHA='beeaf5bbff216d555fecec7cd486072838c4632a2272d31b52ef1fd05008fe7c';
const readPage=createPdfPageReader(async()=>{
  const response=await fetch(WASM_URL,{signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('PDF engine unavailable');
  const wasm=new Uint8Array(await response.arrayBuffer());
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',wasm)),b=>b.toString(16).padStart(2,'0')).join('');
  if(digest!==WASM_SHA)throw new Error('PDF engine checksum mismatch');
  return PDFiumModule({wasmBinary:wasm});
},async(pixels:Uint8Array,width:number,height:number)=>new Uint8Array(UPNG.encode([pixels.buffer.slice(pixels.byteOffset,pixels.byteOffset+pixels.byteLength)],width,height,0)));
Deno.serve(async req=>{
  if(!authorizedServiceRequest(req.headers.get('Authorization'),Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')))return new Response('Unauthorized',{status:401});
  if(req.method!=='POST')return new Response('POST required',{status:405});
  try{
    const raw=await req.text();if(raw.length>7200000)return Response.json({error:'PDF request is too large'},{status:413});
    const body=JSON.parse(raw);if(typeof body.content!=='string')return Response.json({error:'PDF content is required'},{status:400});
    const bytes=Uint8Array.from(atob(body.content),c=>c.charCodeAt(0));
    return Response.json(await readPage(bytes,body.page??0));
  }catch(error){return Response.json({error:error instanceof Error?error.message:'PDF reading failed'},{status:error instanceof PdfInputError||error instanceof SyntaxError?422:503});}
});
