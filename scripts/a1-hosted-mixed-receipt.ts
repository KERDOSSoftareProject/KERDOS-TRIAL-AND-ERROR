// Fixed, expiring kerdos-test diagnostic. It cannot accept arbitrary payloads,
// IDs, credentials or destinations. It never returns credentials.
const URL="https://gwtnaudjfoxjermhvhpx.supabase.co";
const ORG="ab0f7ada-83ad-43eb-a513-6a8c5bd43a09",VENDOR="110e43fc-5788-47c2-ad9d-21b18a28be80";
const PAYLOAD={
  "MessageID": "a1-mixed-csv-png-20261028-001",
  "OriginalRecipient": "aa55b9cf38e8fab147fc4c8b7e914e7d+a1-pdf-prices@inbound.postmarkapp.com",
  "To": "aa55b9cf38e8fab147fc4c8b7e914e7d+a1-pdf-prices@inbound.postmarkapp.com",
  "ToFull": [
    {
      "Email": "aa55b9cf38e8fab147fc4c8b7e914e7d+a1-pdf-prices@inbound.postmarkapp.com",
      "Name": "A1 mixed synthetic test",
      "MailboxHash": "a1-pdf-prices"
    }
  ],
  "From": "mixed-test@example.invalid",
  "FromFull": {
    "Email": "mixed-test@example.invalid",
    "Name": "A1 mixed acceptance"
  },
  "Subject": "A1 MIXED CSV + PNG \u2014 synthetic verification",
  "TextBody": "Nonpricing image first; valid prices second. No client action.",
  "Date": "2026-10-29T01:16:32.431417+00:00",
  "Attachments": [
    {
      "Name": "incidental.png",
      "ContentType": "image/png",
      "Content": "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Ec/d3Z07FHzw4IHAavyRXK5McHZ2njhx4oYNG8rKyuhLI4TcvXv3yZMnAmcEh2PlMeGkSZNUKtXQoUMJIWq1Wi6Xl5eX23VhQu3atSswMJAQ0tjY+Oeff9pe8O7du9zBG//WM/6P586dE1hNqVTSRlBQkEXXMF1cXHbt2kX3/Akh9+7dE74tOBbrT8wEBwerVKphw4YRQjQaTWRk5PPnz+23MKFcXV3//vtv2s7Ozn779q2NBbmHGyQSyU8//cTvUigUtFFeXi5k77empiYnJ4e2Y2NjLV2Jq6urn58fbfPPrEI/Y9OT9UFBQSqVit69pdFoIiIiSktL7bQwC8ybN4+mRavVCn8+qFdZWVl5eXm0vX79+m7nLePi4rhUrFq1Sq1Wmyil1WoTExPp08ZisTg5OdnSxXR1dXFP9PZ1PAn9gK1fbxEYGHj79m16sNTU1DRr1qx//vnHHguzzNatW2njyJEj7969s6JCe3v7+vXrN23aRH/09vbmP7JEOTs7Z2Zm0rZarQ4PD6+oqOi1WmNjY3R0NHfXW3p6Ot11t0h6ejr3AcjdPwD9kMAbvU0/iFBVVeXr60sHeHl59XzI/as+RUFNnTqVDlu3bp2QCp2dnU1NTRUVFSdPnuz2PKFYLC4qKupropSUFG6ki4vL8uXL8/Ly6uvracH79++npaWZfZ4wKioqMjJy8+bNZ86cefjwYXV1dVNTk06n+/z5c2Vl5bFjx3799VeuQnBwsMFgsPR9A0dht6+3qK6u5r4eZtCgQU+fPu11cyHKysosmpri7pB2c3N7//691bOPHj1apVKZmEiv1/f8kOyLQqHo9cl67lEmszw8PJ48eWJiPeDo7PZtazKZrKCgYNSoUYSQ1tbWqKio//is+oIFCyZPnkwI0Wq127dvt6KCj49PWlpaWVmZXC43MczJySkzMzMnJycgIMDEMPodM0qlkrtjxgphYWGFhYXCEwuOyOJ7R03w8/O7fft2REREbW0tzeH169e7nWD8ekQi0datWxctWkQIOXToUGpqquknKgYOHOju7u7h4TFu3LiQkJDp06fPmjWL+8oJs+Li4hYsWHD58uWrV68WFRU1NDS0trZKJJKhQ4eGhIRER0cvXLjQxN1tN2/eLCkpKS4uLikpefXqVXNzc3Nzc1tbm5ubm4eHh7+/f2hoaGxsbHh4uEgksuh9AIfz/3uLAYAVfPkvAGMIIQBjCCEAYwghAGMIIQBjCCEAYwghAGMIIQBjCCEAYwghAGMIIQBjCCEAYwghAGMIIQBjCCEAYwghAGMIIQBjCCEAYwghAGMIIQBjCCEAYwghAGMIIQBjCCEAYwghAGMIIQBjCCEAYwghAGMIIQBjCCEAYwghAGMIIQBjCCEAYwghAGMIIQBjCCEAYwghAGMIIQBjCCEAYwghAGMIIQBjCCEAYwghAGMIIQBj/wNsjKRLwCbkKwAAAABJRU5ErkJggg==",
      "ContentLength": 2905
    },
    {
      "Name": "mixed-prices.csv",
      "ContentType": "text/csv",
      "Content": "Q29kZSxEZXNjcmlwdGlvbixQYWNrLFByaWNlIFVuaXQsUHJpY2UKMTIzNDUsQ2hpY2tlbiBCcmVhc3QsMjAgTEIsQ0FTRSw0MS4yNQoxMjM0NixUdXJrZXkgQnJlYXN0LDIwIExCLENBU0UsNTEuNzUK",
      "ContentLength": 114
    }
  ]
},EXPIRES="2026-10-29T01:47:26.827170+00:00";
async function equal(a:string,b:string){if(!a||!b)return false;const h=async(s:string)=>new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(s)));const[x,y]=await Promise.all([h(a),h(b)]);let d=0;for(let i=0;i<x.length;i++)d|=x[i]^y[i];return d===0;}
const digest=async(bytes:Uint8Array)=>Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",bytes)),b=>b.toString(16).padStart(2,"0")).join("");
Deno.serve(async req=>{
 if(Deno.env.get("SUPABASE_URL")!==URL||Date.now()>Date.parse(EXPIRES))return new Response("Gone",{status:410});
 if(req.method!=="POST")return new Response("POST required",{status:405});
 if(!await equal((req.headers.get("Authorization")??"").replace(/^Bearer /,""),Deno.env.get("RECOVERY_SWEEP_SECRET")??""))return new Response("Unauthorized",{status:401});
 const checks:any[]=[],key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")??"";
 const verify=(condition:boolean,label:string)=>{checks.push({label,passed:!!condition});if(!condition)throw new Error(label);};
 const get=async(table:string,params:Record<string,string>)=>{
  const r=await fetch(URL+"/rest/v1/"+table+"?"+new URLSearchParams(params),{headers:{apikey:key,Authorization:"Bearer "+key},signal:AbortSignal.timeout(20000)});
  if(!r.ok)throw new Error("Database inspection failed: "+table+" "+r.status);const rows=await r.json();if(!Array.isArray(rows))throw new Error("Invalid database response: "+table);return rows;
 };
 const snapshot=async()=>{
  const messages=await get("inbound_messages",{select:"id,organization_id,receipt_vendor_id,receipt_document_type",organization_id:"eq."+ORG,postmark_message_id:"eq."+PAYLOAD.MessageID});
  const items=await get("vendor_items",{select:"id,vendor_item_code,selling_unit,price_basis",organization_id:"eq."+ORG,vendor_id:"eq."+VENDOR,order:"vendor_item_code.asc"});
  if(!messages.length)return {messages,items,attachments:[],documents:[],prices:[],originals:[]};
  if(messages.length!==1)throw new Error("Duplicate message records");
  const attachments=await get("inbound_attachments",{select:"id,filename,storage_path,file_size_bytes,processing_status,processing_error,import_document_id",organization_id:"eq."+ORG,message_id:"eq."+messages[0].id,order:"filename.asc"});
  const ids=attachments.map((a:any)=>a.import_document_id).filter(Boolean);
  if(ids.some((id:string)=>!/^[-0-9a-f]{36}$/i.test(id)))throw new Error("Invalid document identity");
  const documents=ids.length?await get("import_documents",{select:"id,status,file_name,file_path,completed_keys",organization_id:"eq."+ORG,id:"in.("+ids.join(",")+")"}):[];
  const prices=await get("price_history",{select:"id,vendor_item_id,source_document_id,source_file_name,price",organization_id:"eq."+ORG,source_file_name:"in.(incidental.png,mixed-prices.csv)",order:"price.asc"});
  const originals=[];
  for(const attachment of attachments){
   if(!attachment.storage_path.startsWith(ORG+"/inbound/"+messages[0].id+"/"))throw new Error("Original escaped fixture receipt");
   const r=await fetch(URL+"/storage/v1/object/authenticated/documents/"+attachment.storage_path.split("/").map(encodeURIComponent).join("/"),{headers:{apikey:key,Authorization:"Bearer "+key},signal:AbortSignal.timeout(20000)});
   if(!r.ok)throw new Error("Original download failed: "+attachment.filename);
   const bytes=new Uint8Array(await r.arrayBuffer()),expected=PAYLOAD.Attachments.find((a:any)=>a.Name===attachment.filename);
   if(!expected)throw new Error("Unexpected attachment");
   const expectedBytes=Uint8Array.from(atob(expected.Content),c=>c.charCodeAt(0));
   originals.push({filename:attachment.filename,bytes:bytes.length,sha256:await digest(bytes),matchesFixture:bytes.length===expectedBytes.length&&await digest(bytes)===await digest(expectedBytes)});
  }
  return {messages,items,attachments,documents,prices,originals};
 };
 let before:any,first:any,replay:any;
 try{
  before=await snapshot();verify(before.messages.length===0,"Fresh fixture message absent before delivery");
  const send=async()=>{
   const u=Deno.env.get("POSTMARK_WEBHOOK_USERNAME")??"",p=Deno.env.get("POSTMARK_WEBHOOK_PASSWORD")??"";
   if(!u||!p)throw new Error("Webhook credentials missing");
   const r=await fetch(URL+"/functions/v1/inbound-email",{method:"POST",headers:{"Content-Type":"application/json",Authorization:"Basic "+btoa(u+":"+p)},body:JSON.stringify(PAYLOAD),signal:AbortSignal.timeout(100000)});await r.text();return r.status;
 };
  const firstStatus=await send();verify(firstStatus===200,"One mixed receipt accepted by inbound-email");first=await snapshot();
  verify(first.messages.length===1&&first.attachments.length===2&&first.messages[0].receipt_vendor_id===VENDOR&&first.messages[0].receipt_document_type==="pricelist","Single receipt has both attachments and exact vendor/type snapshot");
  const csv=first.attachments.find((a:any)=>a.filename==="mixed-prices.csv"),png=first.attachments.find((a:any)=>a.filename==="incidental.png");
  verify(csv?.processing_status==="auto_imported"&&first.documents.length===1&&first.documents[0].status==="complete"&&first.documents[0].completed_keys.length===2,"CSV completed automatically despite the earlier nonpricing PNG");
  const rows=first.prices.map((p:any)=>({code:first.items.find((i:any)=>i.id===p.vendor_item_id)?.vendor_item_code,price:Number(p.price),file:p.source_file_name,doc:p.source_document_id}));
  verify(JSON.stringify(rows.map((r:any)=>[r.code,r.price]))===JSON.stringify([["12345",41.25],["12346",51.75]])&&rows.every((r:any)=>r.file==="mixed-prices.csv"&&r.doc===csv.import_document_id),"Exact two CSV prices and source filenames saved");
  verify(png?.processing_status==="needs_review"&&!png.import_document_id&&first.prices.every((p:any)=>p.source_file_name!=="incidental.png"),"Nonpricing PNG terminal exception creates no document or false price");
  verify(first.originals.length===2&&first.originals.every((o:any)=>o.matchesFixture),"Both retained originals byte-match their fixtures");
  verify(first.items.length===before.items.length,"Existing catalog/vendor items reused without duplicate listings");
  const replayStatus=await send();verify(replayStatus===200,"Identical mixed receipt replay accepted");replay=await snapshot();
  const stable=(x:any)=>JSON.stringify({messages:x.messages,attachments:x.attachments,documents:x.documents,prices:x.prices,originals:x.originals,items:x.items});
  verify(stable(first)===stable(replay),"Replay preserves every receipt/attachment/document/price/item/original ID, value and terminal state");
  return Response.json({passed:true,category:"Hosted synthetic mixed receipt; not real-email delivery",messageId:PAYLOAD.MessageID,checks,before,first,replay});
 }catch(error){return Response.json({passed:false,error:error instanceof Error?error.message:"Verification failed",checks,before,first,replay},{status:502});}
});
