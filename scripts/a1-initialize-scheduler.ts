// Temporary kerdos-test-only runner. No credentials are returned or logged.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
const PROJECT = "https://gwtnaudjfoxjermhvhpx.supabase.co";
async function equal(a: string, b: string) {
  if (!a || !b) return false;
  const digest = async (s: string) => new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
  const [x,y] = await Promise.all([digest(a),digest(b)]);
  let n=0; for(let i=0;i<x.length;i++)n|=x[i]^y[i]; return n===0;
}
Deno.serve(async req => {
  const url=Deno.env.get("SUPABASE_URL")??"";
  if(url!==PROJECT)return new Response("Wrong project",{status:503});
  const service=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")??"";
  let keys: string[]=[];
  try { keys=Object.values(JSON.parse(Deno.env.get("SUPABASE_SECRET_KEYS")??"{}")).filter(x=>typeof x==="string") as string[]; } catch {}
  const supplied=[req.headers.get("apikey")??"",(req.headers.get("Authorization")??"").replace(/^Bearer /,"")];
  let authorized=false;
  for(const value of supplied)for(const key of [service,...keys])if(await equal(value,key))authorized=true;
  if(!authorized)return new Response("Unauthorized",{status:401});
  if(req.method!=="POST")return new Response("POST required",{status:405});
  const user=Deno.env.get("POSTMARK_WEBHOOK_USERNAME")??"";
  const pass=Deno.env.get("POSTMARK_WEBHOOK_PASSWORD")??"";
  const sweep=Deno.env.get("RECOVERY_SWEEP_SECRET")??"";
  if(!service||!user||!pass||!sweep)return Response.json({error:"Required server secret missing"},{status:503});
  const client=createClient(url,service,{auth:{persistSession:false}});

  const {data,error}=await client.rpc("initialize_a1_test_scheduler",{p_secret:sweep});
  if(error)return Response.json({error:error.message},{status:500});
  return Response.json({configured:true,jobId:data,schedule:"*/5 * * * *",project:"kerdos-test"});
});
