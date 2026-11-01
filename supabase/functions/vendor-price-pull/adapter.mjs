// Adapter registry is supplied by trusted worker code, never by a client payload.
// Browser execution and authentication are separate capabilities, not HTTP guesses.
export class PullError extends Error {
  constructor(code){super(code);this.code=code;}
}
const TYPES=new Map([
  ['text/csv',['csv']],['text/plain',['txt','csv']],
  ['application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',['xlsx']],
  ['application/pdf',['pdf']],['image/png',['png']],['image/jpeg',['jpg','jpeg']],
]);
export function validateRetrievedExport(result,source){
  if(!(result?.bytes instanceof Uint8Array)||!result.bytes.length)throw new PullError('empty_export');
  if(result.bytes.length>5*1024*1024)throw new PullError('export_too_large');
  const extension=String(source.file_name||'').split('.').at(-1).toLowerCase();
  if(!TYPES.get(result.contentType)?.includes(extension))throw new PullError('unsupported_export');
  if(/<\s*(!doctype\s+html|html|form)\b/i.test(new TextDecoder().decode(result.bytes.slice(0,1024))))throw new PullError('portal_login_page');
  return {bytes:result.bytes,contentType:result.contentType};
}
export async function retrieveVendorExport(source,{httpsExport,portalAdapters=new Map(),signal,...options}){
  // Missing kind is the installed, legacy HTTPS contract. Unknown kinds never
  // fall through to a network request or receive a default portal implementation.
  const kind=source.retrieval_kind??'https_export';
  let result;
  if(kind==='https_export')result=await httpsExport(source,{...options,signal});
  else if(kind==='portal_session'){
    const adapter=portalAdapters.get(source.adapter_key);
    if(!adapter||typeof adapter.retrieve!=='function')throw new PullError('unsupported_adapter');
    if(adapter.executionModel!=='server')throw new PullError('execution_unavailable');
    // No MOXe adapter is registered. Only a reviewed server adapter can run here.
    result=await adapter.retrieve(source,{signal});
  }else throw new PullError('unsupported_adapter');
  return validateRetrievedExport(result,source);
}

const SAFE_REASONS=new Set(['auto_imported','needs_review','skipped','pull_failed','invalid_source','credential_invalid','dns_validation_required','dns_failed','source_network_denied','download_failed','vendor_auth_rejected','vendor_http_failed','unsupported_export','export_too_large','empty_export','portal_login_page','dispatch_failed','storage_failed','retained_original_mismatch','unsupported_adapter','verification_needed','execution_unavailable']);
export function safePullReason(error){return error instanceof PullError&&SAFE_REASONS.has(error.code)?error.code:'pull_failed';}
