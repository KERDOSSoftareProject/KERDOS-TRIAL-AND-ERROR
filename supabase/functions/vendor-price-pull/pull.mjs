// Module A, Task 2: a read-only supplier export adapter. Never logs credentials,
// response bodies or request URLs. Interactive/cookie-based portals require a
// separately verified adapter; an HTML login page is not a price export.
const MAX_BYTES=5*1024*1024;
const TYPES=new Map([
  ['text/csv',['csv']],['text/plain',['txt','csv']],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',['xlsx']],
  ['application/pdf',['pdf']],['image/png',['png']],['image/jpeg',['jpg','jpeg']],
]);
export class PullError extends Error{
  constructor(code){super(code);this.code=code;}
}
export async function retainExport(storage,path,bytes,contentType){
  const {error}=await storage.upload(path,bytes,{contentType,upsert:false});
  if(!error)return;
  if(String(error.statusCode)!=='409'&&!/already exists|duplicate/i.test(error.message||''))throw new PullError('storage_failed');
  // A deterministic path does not establish that an older upload is correct.
  const {data,error:readError}=await storage.download(path);
  if(readError||!data)throw new PullError('storage_failed');
  const previous=new Uint8Array(await data.arrayBuffer());
  if(previous.length!==bytes.length||previous.some((value,index)=>value!==bytes[index]))throw new PullError('retained_original_mismatch');
}
export function sourceUrl(source){
  let origin,url;
  try{origin=new URL(source.approved_origin);url=new URL(source.export_path,origin);}
  catch{throw new PullError('invalid_source');}
  if(origin.protocol!=='https:'||origin.username||origin.password||origin.port||origin.pathname!=='/'||origin.search||origin.hash
    ||url.origin!==origin.origin||url.username||url.password||url.hash||url.search
    ||!source.export_path.startsWith('/')||source.export_path.startsWith('//'))throw new PullError('invalid_source');
  const host=url.hostname.toLowerCase();
  // Only operator-approved DNS names; no IP literals, localhost or local names.
  if(!/^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}$/.test(host)||host.includes('..')||/\.(localhost|local|internal|test|invalid)$/.test(host))throw new PullError('invalid_source');
  return url;
}
export function isPublicAddress(address){
  const v4=address.split('.');
  if(v4.length===4&&v4.every(p=>/^\d+$/.test(p)&&+p<=255)){
    const [a,b]=v4.map(Number);
    return !(a===0||a===10||a===127||a>=224||a===169&&b===254||a===172&&b>=16&&b<=31||a===192&&(b===168||b===0)||a===100&&b>=64&&b<=127||a===198&&(b===18||b===19));
  }
  // Global IPv6 unicast only; reject mapped IPv4, local/link-local, multicast.
  return /^2[0-9a-f]{3}:/i.test(address)&&!/^2001:(db8|0):/i.test(address)&&!/^2002:/i.test(address);
}
function authHeaders(credential){
  if(!credential||typeof credential!=='object')throw new PullError('credential_invalid');
  if(credential.kind==='bearer'&&typeof credential.token==='string'&&credential.token&&!/[\r\n]/.test(credential.token))return {Authorization:`Bearer ${credential.token}`};
  if(credential.kind==='basic'&&typeof credential.username==='string'&&credential.username&&!credential.username.includes(':')&&typeof credential.password==='string'&&credential.password&&!/[\r\n]/.test(credential.username+credential.password)){
    const bytes=new TextEncoder().encode(credential.username+':'+credential.password);
    return {Authorization:'Basic '+btoa(String.fromCharCode(...bytes))};
  }
  throw new PullError('credential_invalid');
}
export async function downloadExport(source,{fetchImpl=fetch,resolveHost,signal}={}){
  const url=sourceUrl(source);
  if(typeof resolveHost!=='function')throw new PullError('dns_validation_required');
  let addresses;
  try{addresses=await resolveHost(url.hostname);}catch{throw new PullError('dns_failed');}
  if(!addresses?.length||addresses.some(address=>!isPublicAddress(address)))throw new PullError('source_network_denied');
  const headers=authHeaders(source.credential);
  let response;
  try{response=await fetchImpl(url.href,{method:'GET',headers,redirect:'error',signal});}
  catch{throw new PullError('download_failed');}
  if(!response.ok){await response.body?.cancel();throw new PullError(response.status===401||response.status===403?'vendor_auth_rejected':'vendor_http_failed');}
  const type=(response.headers.get('content-type')||'').split(';')[0].trim().toLowerCase();
  const extension=String(source.file_name||'').split('.').at(-1).toLowerCase();
  if(!TYPES.get(type)?.includes(extension)){await response.body?.cancel();throw new PullError('unsupported_export');}
  if(Number(response.headers.get('content-length'))>MAX_BYTES){await response.body?.cancel();throw new PullError('export_too_large');}
  const reader=response.body?.getReader();if(!reader)throw new PullError('empty_export');
  let size=0;const chunks=[];
  try{while(true){const {done,value}=await reader.read();if(done)break;size+=value.length;if(size>MAX_BYTES)throw new PullError('export_too_large');chunks.push(value);}}
  catch(error){await reader.cancel().catch(()=>{});throw error instanceof PullError?error:new PullError('download_failed');}
  if(!size)throw new PullError('empty_export');
  const bytes=new Uint8Array(size);let offset=0;for(const chunk of chunks){bytes.set(chunk,offset);offset+=chunk.length;}
  // Some portals return a login form with text/csv even on expired sessions.
  if(/<\s*(!doctype\s+html|html|form)\b/i.test(new TextDecoder().decode(bytes.slice(0,1024))))throw new PullError('portal_login_page');
  return {bytes,contentType:type};
}
export async function pullVendorSources(backend,{sourceId=null,fetchImpl=fetch,resolveHost,digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes))).map(b=>b.toString(16).padStart(2,'0')).join('')}={}){
  const sources=await backend.claim(sourceId);
  const results=await Promise.all(sources.map(async source=>{
    let status='failed',reason='pull_failed',attachmentId=null;
    try{
      const {bytes,contentType}=await downloadExport(source,{fetchImpl,resolveHost,signal:AbortSignal.timeout(30000)});
      const hash=await digest(bytes);
      const previousRevision=Number(source.content_revision||0);
      if(!Number.isSafeInteger(previousRevision)||previousRevision<0||previousRevision>=Number.MAX_SAFE_INTEGER)throw new PullError('invalid_source');
      const revision=source.content_hash===hash?previousRevision:previousRevision+1;
      const path=`${source.organization_id}/vendor-pulls/${source.id}/${revision}/${hash}`;
      await backend.retain(source,path,bytes,contentType);
      const receipt=await backend.stage(source,{hash,path,contentType,size:bytes.length});
      attachmentId=receipt.attachment_id;
      // stage commits a durable pending attachment before dispatch. If dispatch
      // fails, the existing A1 recovery sweep can finish it without another pull.
      let outcome;
      try{outcome=await backend.dispatch(source.organization_id,attachmentId);}
      catch{throw new PullError('dispatch_failed');}
      if(!['auto_imported','needs_review','skipped'].includes(outcome?.outcome))throw new PullError('dispatch_failed');
      status='received';reason=outcome.outcome;
    }catch(error){reason=error instanceof PullError?error.code:'pull_failed';}
    const accepted=await backend.finish(source,status,reason,attachmentId);
    return {sourceId:source.id,status:accepted?status:'lease_lost',reason:accepted?reason:'lease_lost',attachmentId};
  }));
  return {checked:results.length,results};
}
