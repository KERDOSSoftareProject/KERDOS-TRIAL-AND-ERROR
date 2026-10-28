// Temporary, time-limited kerdos-test-only synthetic webhook fixture.
// Exact CSV and route only; no caller-provided data. Retire after initialization.
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.4";
const URL="https://gwtnaudjfoxjermhvhpx.supabase.co";
const MESSAGE="a1-review-resolution-20261028-001";
const CSV="Code,Description,Pack,Price Unit,Price\nA1-REVIEW-HOLD-001,Chicken Breast Boneless Skinless,1/10 LB,,20.00\nA1-REVIEW-CLEAN-001,Turkey Breast Smoked Deli Style,2/10 LB,CASE,40.00\n";
const EXPIRES="2026-10-28T18:26:29.384Z";
async function equal(a:string,b:string){if(!a||!b)return false;const hash=async(s:string)=>new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)));const[x,y]=await Promise.all([hash(a),hash(b)]);let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];return d===0;}
Deno.serve(async req=>{
 if(Deno.env.get("SUPABASE_URL")!==URL||Date.now()>Date.parse(EXPIRES))return new Response("Gone",{status:410});
 if(req.method!=="POST")return new Response("POST required",{status:405});
 if(!await equal((req.headers.get("Authorization")??"").replace(/^Bearer /,""),Deno.env.get("RECOVERY_SWEEP_SECRET")??""))return new Response("Unauthorized",{status:401});
 const key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")??"";
 const client=createClient(URL,key,{auth:{persistSession:false},global:{headers:{Authorization:"Bearer "+key}}});
 const seen=await client.from("inbound_messages").select("id").eq("postmark_message_id",MESSAGE).maybeSingle();
 if(seen.error)return Response.json({error:"Fixture lookup failed"},{status:500});
 if(seen.data)return new Response("Fixture already exists",{status:410});
 const user=Deno.env.get("POSTMARK_WEBHOOK_USERNAME")??"",pass=Deno.env.get("POSTMARK_WEBHOOK_PASSWORD")??"";
 if(!user||!pass)return Response.json({error:"Webhook authentication is not configured"},{status:503});
 const receiver="aa55b9cf38e8fab147fc4c8b7e914e7d+a1-review@inbound.postmarkapp.com";
 const payload={MessageID:MESSAGE,OriginalRecipient:receiver,To:receiver,ToFull:[{Email:receiver,Name:"A1 Review Test",MailboxHash:"a1-review"}],From:"a1-test@example.invalid",FromFull:{Email:"a1-test@example.invalid",Name:"KERDOS synthetic verification"},Subject:"A1 REVIEW TEST — mixed rows (synthetic, not email)",TextBody:"Controlled deployed webhook test: resolve only the missing quoted-per unit. Not real email delivery.",Date:new Date().toISOString(),Attachments:[{Name:"A1_Review_Mixed_Test.csv",ContentType:"text/csv",Content:btoa(CSV),ContentLength:new TextEncoder().encode(CSV).length}]};
 const response=await fetch(URL+"/functions/v1/inbound-email",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Basic "+btoa(user+":"+pass)},body:JSON.stringify(payload)});
 const result=await response.text();
 return Response.json({synthetic:true,webhookStatus:response.status,result},{status:response.ok?200:502});
});
