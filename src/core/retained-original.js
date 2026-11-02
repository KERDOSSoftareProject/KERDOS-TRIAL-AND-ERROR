// Companion originals are verified as bytes, never by re-encoding extracted text.
export const MAX_VERIFIED_ORIGINAL_BYTES=5*1024*1024;
export function assertOriginalEvidence(evidence){
  if(evidence?.kind!=='browser_companion'||typeof evidence.sha256!=='string'||!/^([a-f0-9]{64})$/.test(evidence.sha256||'')||
    !Number.isSafeInteger(evidence.byte_length)||evidence.byte_length<1||evidence.byte_length>MAX_VERIFIED_ORIGINAL_BYTES)
    throw new Error('The stored original has no valid transfer-byte evidence. Pricing was kept for review.');
}
export async function verifyOriginalBytes(data,evidence,{assertActive=()=>{},cryptoApi=globalThis.crypto}={}){
  assertActive();assertOriginalEvidence(evidence);
  if(!cryptoApi?.subtle?.digest)throw new Error('Secure original-file verification is unavailable.');
  const size=typeof data?.size==='number'?data.size:data?.byteLength;
  if(size!==evidence.byte_length)throw new Error('The stored original byte length differs from its transfer evidence.');
  let bytes;
  if(data instanceof ArrayBuffer)bytes=new Uint8Array(data);
  else if(ArrayBuffer.isView(data))bytes=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
  else if(typeof data?.arrayBuffer==='function')bytes=new Uint8Array(await data.arrayBuffer());
  else throw new Error('The stored original could not be read as file bytes.');
  assertActive();
  if(bytes.byteLength!==evidence.byte_length)throw new Error('The stored original byte length differs from its transfer evidence.');
  const digest=await cryptoApi.subtle.digest('SHA-256',bytes);assertActive();
  const sha256=Array.from(new Uint8Array(digest),value=>value.toString(16).padStart(2,'0')).join('');
  if(sha256!==evidence.sha256)throw new Error('The stored original SHA-256 differs from its transfer evidence.');
  return {sha256,byteLength:bytes.byteLength};
}
