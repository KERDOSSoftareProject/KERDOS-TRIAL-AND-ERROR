import {createClient} from 'https://esm.sh/@supabase/supabase-js@2.57.4';
import {authorizedServiceRequest} from '../process-attachment/request-auth.mjs';
import {authorizedSweep} from '../recovery-sweep/auth.mjs';
import {pullVendorSources,retainExport} from './pull.mjs';

// Service-only: operator on-demand call, or a server scheduler. Credentials are
// obtained from Vault through restricted RPCs and never sent to browser code.
Deno.serve(async(req:Request)=>{
  const key=Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')||'';
  if(!authorizedServiceRequest(req.headers.get('Authorization'),key)&&!authorizedSweep(req.headers.get('Authorization'),Deno.env.get('RECOVERY_SWEEP_SECRET')||''))return new Response('Unauthorized',{status:401});
  if(req.method!=='POST')return new Response('Method Not Allowed',{status:405});
  let body:any;try{body=await req.json();}catch{return Response.json({error:'invalid_body'},{status:400});}
  if(!body||typeof body!=='object'||Array.isArray(body))return Response.json({error:'invalid_body'},{status:400});
  if(body.sourceId!=null&&(typeof body.sourceId!=='string'||!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(body.sourceId)))return Response.json({error:'invalid_source_id'},{status:400});
  const client=createClient(Deno.env.get('SUPABASE_URL')||'',key,{auth:{persistSession:false},global:{headers:{Authorization:`Bearer ${key}`}}});
  async function rpc(name:string,args:object){const {data,error}=await client.rpc(name,args);if(error)throw new Error('backend_failed');return data;}
  try{
    const result=await pullVendorSources({
      claim:(id:string|null)=>rpc('kerdos_claim_vendor_pulls',{p_source_id:id}),
      async retain(source:any,path:string,bytes:Uint8Array,contentType:string){
        await rpc('kerdos_check_vendor_pull_lease',{p_source_id:source.id,p_token:source.lease_token});
        await retainExport(client.storage.from('documents'),path,bytes,contentType);
      },
      stage:(source:any,artifact:any)=>rpc('kerdos_stage_vendor_pull',{p_source_id:source.id,p_token:source.lease_token,p_hash:artifact.hash,p_path:artifact.path,p_content_type:artifact.contentType,p_size:artifact.size}),
      async dispatch(organizationId:string,attachmentId:string){const {data,error}=await client.functions.invoke('process-attachment',{body:{organizationId,attachmentId},signal:AbortSignal.timeout(90000)});if(error)throw new Error('dispatch_failed');return data;},
      finish:(source:any,status:string,reason:string,attachmentId:string|null)=>rpc('kerdos_finish_vendor_pull',{p_source_id:source.id,p_token:source.lease_token,p_status:status,p_reason:reason,p_attachment_id:attachmentId}),
    },{sourceId:body.sourceId||null,resolveHost:async(host:string)=>{
      const records=await Promise.allSettled([Deno.resolveDns(host,'A'),Deno.resolveDns(host,'AAAA')]);
      return records.flatMap(result=>result.status==='fulfilled'?result.value:[]);
    }});
    return Response.json(result);
  }catch{return Response.json({error:'vendor_pull_failed'},{status:500});}
});
