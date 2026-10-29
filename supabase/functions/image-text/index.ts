import TesseractCore from 'npm:tesseract.js-core@7.0.0/tesseract-core-simd-lstm.wasm.js';
import UPNG from 'npm:upng-js@2.1.0';
import jpeg from 'npm:jpeg-js@0.4.4';
import {authorizedServiceRequest} from '../process-attachment/request-auth.mjs';
import {createImageRecognizer,ImageInputError} from './image-ocr.mjs';
const LANGUAGE_URL='https://kerdossoftareproject.github.io/KERDOS-TRIAL-AND-ERROR/ocr/eng.traineddata.gz';
const LANGUAGE_SHA='45b4cb346724ac1774f1c36f42f182b887bcdb28ebe63e6fff90ac41f3fcff91';
const recognize=createImageRecognizer(()=>TesseractCore({}),async()=>{
  const response=await fetch(LANGUAGE_URL,{signal:AbortSignal.timeout(20000)});
  if(!response.ok)throw new Error('OCR language asset unavailable');
  const compressed=new Uint8Array(await response.arrayBuffer());
  const digest=Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',compressed)),b=>b.toString(16).padStart(2,'0')).join('');
  if(digest!==LANGUAGE_SHA)throw new Error('OCR language asset checksum mismatch');
  return new Uint8Array(await new Response(new Blob([compressed]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
},async(bytes:Uint8Array,size:{mime:string,width:number,height:number})=>{
  if(size.mime==='image/png'){
    const image=UPNG.decode(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
    if(image.frames?.length>1)throw new Error('Animated PNG documents are not supported');
    return new Uint8Array(UPNG.toRGBA8(image)[0]);
  }
  return jpeg.decode(bytes,{useTArray:true,maxResolutionInMP:4,maxMemoryUsageInMB:64,tolerantDecoding:false}).data;
},async(pixels:Uint8Array,width:number,height:number)=>new Uint8Array(UPNG.encode([pixels.buffer.slice(pixels.byteOffset,pixels.byteOffset+pixels.byteLength)],width,height,0)));
Deno.serve(async req=>{
  if(!authorizedServiceRequest(req.headers.get('Authorization'),Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')))return new Response('Unauthorized',{status:401});
  if(req.method!=='POST')return new Response('POST required',{status:405});
  try{
    const raw=await req.text();if(raw.length>7200000)return Response.json({error:'Image request is too large'},{status:413});
    const body=JSON.parse(raw);if(typeof body.content!=='string')return Response.json({error:'Image content is required'},{status:400});
    const bytes=Uint8Array.from(atob(body.content),c=>c.charCodeAt(0));
    const result=await recognize(bytes,body.part??0);
    return Response.json(result);
  }catch(error){return Response.json({error:error instanceof Error?error.message:'Image recognition failed'},{status:error instanceof ImageInputError||error instanceof SyntaxError?422:503});}
});
