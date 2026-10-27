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
  const results: {name:string;pass:boolean;detail?:string}[]=[];
  const demand=(condition:unknown,message:string)=>{if(!condition)throw new Error(message);};
  const db=async(p:any)=>{const r=await p;if(r.error)throw new Error(r.error.message);return r.data;};
  const test=async(name:string,fn:()=>Promise<void>)=>{try{await fn();results.push({name,pass:true});}catch(e){results.push({name,pass:false,detail:String(e.message).slice(0,350)});}};
  const call=async(name:string,body:any,auth:string)=>{
    const r=await fetch(url+"/functions/v1/"+name,{method:"POST",headers:{"Content-Type":"application/json",Authorization:auth},body:JSON.stringify(body),signal:AbortSignal.timeout(45000)});
    const text=await r.text();let data:any;try{data=JSON.parse(text);}catch{data=text;}
    return {status:r.status,data};
  };
  const basic="Basic "+btoa(user+":"+pass);
  const marker=crypto.randomUUID(); let org:string|null=null;
  let cleanup=false;
  try {
    await test("authorized processor reaches request validation",async()=>{
      const r=await call("process-attachment",{},"Bearer "+service);
      demand(r.status===400 && r.data.reason==="attachmentId and organizationId are required","Expected processor validation 400; got "+r.status);
    });
    await test("authorized webhook reaches unknown-route lookup",async()=>{
      const r=await call("inbound-email",{MessageID:marker,OriginalRecipient:marker+"@inbound.kerdos.com",FromFull:{Email:"a1@example.invalid"},Attachments:[]},basic);
      demand(r.status===200,"Expected webhook 200; got "+r.status);
    });
    // A sweep is project-wide. Refuse to test over unrelated pending work.
    const queue=await db(client.from("inbound_attachments").select("id").in("processing_status",["pending","processing"]));
    demand(!queue.length,"Unrelated pending/processing rows exist; no fixture or sweep run");
    org=(await db(client.from("organizations").insert({name:"A1 deployed verification "+marker,industry:"restaurant"}).select("id").single())).id;
    const vendors=await db(client.from("vendors").insert([{organization_id:org,name:"Receipt vendor A"},{organization_id:org,name:"Later vendor B"}]).select("id,name"));
    const va=vendors.find((v:any)=>v.name==="Receipt vendor A").id;
    const vb=vendors.find((v:any)=>v.name==="Later vendor B").id;
    const address="a1-"+marker+"@inbound.kerdos.com";
    const route=await db(client.from("email_routing_addresses").insert({organization_id:org,routing_address:address,vendor_id:va}).select("id").single());
    const body={MessageID:marker+"-unsupported",OriginalRecipient:address,FromFull:{Email:"a1@example.invalid"},Subject:"A1 controlled test",Attachments:[{Name:"unsupported.bin",Content:btoa("unsupported test data"),ContentType:"application/octet-stream",ContentLength:21}]};
    let msg:any,att:any;
    await test("synthetic webhook stores original and dispatches review",async()=>{
      const r=await call("inbound-email",body,basic);
      demand(r.status===200,"Webhook status "+r.status);
      msg=await db(client.from("inbound_messages").select("*").eq("organization_id",org).eq("postmark_message_id",body.MessageID).single());
      att=await db(client.from("inbound_attachments").select("*").eq("message_id",msg.id).single());
      demand(msg.receipt_vendor_id===va && !!msg.vendor_snapshot_at,"Receipt snapshot mismatch");
      demand(att.processing_status==="needs_review" && !!att.storage_path,"Attachment did not enter review with original");
      demand(!att.import_document_id,"Unsupported file unexpectedly created document");
      const file=await client.storage.from("documents").download(att.storage_path);
      demand(!file.error && await file.data.text()==="unsupported test data","Original bytes mismatch");
    });
    if(msg&&att){
      await db(client.from("email_routing_addresses").update({vendor_id:vb}).eq("id",route.id));
      await test("replayed webhook preserves snapshot and attachment identity",async()=>{
        const r=await call("inbound-email",body,basic);demand(r.status===200,"Replay failed "+r.status);
        const messages=await db(client.from("inbound_messages").select("id,receipt_vendor_id,vendor_snapshot_at").eq("organization_id",org));
        const attachments=await db(client.from("inbound_attachments").select("id").eq("message_id",msg.id));
        demand(messages.length===1 && messages[0].receipt_vendor_id===va && messages[0].vendor_snapshot_at===msg.vendor_snapshot_at,"Message identity/snapshot changed");
        demand(attachments.length===1 && attachments[0].id===att.id,"Replay duplicated attachment");
      });
      await test("recovery sweep dispatches fixture to deployed processor",async()=>{
        await db(client.from("inbound_attachments").update({processing_status:"pending",processing_error:null}).eq("id",att.id));
        const r=await call("recovery-sweep",{},"Bearer "+sweep);
        demand(r.status===200,"Sweep HTTP "+r.status);
        demand(r.data.replayed?.some((x:any)=>x.id===att.id && x.outcome==="needs_review"),"Fixture absent from successful processor replay");
        demand(!r.data.needsReview?.includes(att.id),"Dispatch failure is not a successful handoff");
        const row=await db(client.from("inbound_attachments").select("processing_status").eq("id",att.id).single());
        demand(row.processing_status==="needs_review","Review status not persisted");
      });
      await test("fresh lease survives deployed recovery sweep",async()=>{
        await db(client.from("inbound_attachments").update({processing_status:"processing",processing_started_at:new Date().toISOString(),processing_heartbeat_at:new Date().toISOString(),processing_lease_token:crypto.randomUUID()}).eq("id",att.id));
        const before=await db(client.from("inbound_attachments").select("processing_lease_token").eq("id",att.id).single());
        const r=await call("recovery-sweep",{},"Bearer "+sweep);demand(r.status===200,"Sweep HTTP "+r.status);
        demand(!r.data.recovered.includes(att.id) && !r.data.replayed.some((x:any)=>x.id===att.id),"Active lease recovered or dispatched");
        const after=await db(client.from("inbound_attachments").select("processing_status,processing_lease_token").eq("id",att.id).single());
        demand(after.processing_status==="processing" && after.processing_lease_token===before.processing_lease_token,"Active lease mutated");
      });
      await test("expired lease recovers and replays through deployed processor",async()=>{
        const old=new Date(Date.now()-20*60*1000).toISOString();
        await db(client.from("inbound_attachments").update({processing_started_at:old,processing_heartbeat_at:old}).eq("id",att.id));
        const r=await call("recovery-sweep",{},"Bearer "+sweep);demand(r.status===200,"Sweep HTTP "+r.status);
        demand(r.data.recovered.includes(att.id) && r.data.replayed.some((x:any)=>x.id===att.id && x.outcome==="needs_review"),"Expired lease did not recover and replay successfully");
      });
    }
    await test("CSV webhook saves one document and one quoted price; replay is idempotent",async()=>{
      await db(client.from("email_routing_addresses").update({vendor_id:va}).eq("id",route.id));
      const category=await db(client.from("catalog_categories").insert({organization_id:org,name:"Verification Other",range_start:900000,range_end:999999}).select("id").single());
      const catalog=await db(client.from("catalog_items").insert({organization_id:org,category_id:category.id,name:"Widget A",master_item_number:900001}).select("id").single());
      const item=await db(client.from("vendor_items").insert({organization_id:org,vendor_id:va,vendor_item_code:"SKU-001",description:"Widget A",pack_size:"18 LB",selling_unit:"CASE",price_basis:"case",price_source:"price_list"}).select("id").single());
      await db(client.from("item_mappings").insert({organization_id:org,vendor_item_id:item.id,catalog_item_id:catalog.id,comparison_track:"exact",confidence_score:100}));
      const csv="code,description,price\nSKU-001,Widget A,10.00";
      const payload={...body,MessageID:marker+"-csv",Attachments:[{Name:"prices.csv",Content:btoa(csv),ContentType:"text/csv",ContentLength:csv.length}]};
      const first=await call("inbound-email",payload,basic);demand(first.status===200,"CSV webhook HTTP "+first.status);
      const message=await db(client.from("inbound_messages").select("id").eq("organization_id",org).eq("postmark_message_id",payload.MessageID).single());
      const attachment=await db(client.from("inbound_attachments").select("processing_status,import_document_id,processing_error").eq("message_id",message.id).single());
      demand(attachment.processing_status==="auto_imported","CSV not fully imported: "+attachment.processing_status+"; "+attachment.processing_error);
      const document=await db(client.from("import_documents").select("id,status,vendor_id").eq("id",attachment.import_document_id).single());
      demand(document.status==="complete" && document.vendor_id===va,"Document status/vendor mismatch");
      const prices=await db(client.from("price_history").select("id,price,source_document_id").eq("organization_id",org));
      demand(prices.length===1 && Number(prices[0].price)===10 && prices[0].source_document_id===document.id,"Expected one linked price of 10.00");
      const replay=await call("inbound-email",payload,basic);demand(replay.status===200,"CSV replay HTTP "+replay.status);
      const docs=await db(client.from("import_documents").select("id").eq("organization_id",org));
      const after=await db(client.from("price_history").select("id").eq("organization_id",org));
      demand(docs.length===1 && docs[0].id===document.id && after.length===1 && after[0].id===prices[0].id,"Replay duplicated document/price");
    });
  } catch(e){results.push({name:"fixture/setup",pass:false,detail:String(e.message).slice(0,350)});}
  finally {
    try {
      if(org){
        const attachments=await db(client.from("inbound_attachments").select("storage_path").eq("organization_id",org));
        const paths=attachments.map((a:any)=>a.storage_path).filter(Boolean);
        if(paths.length)await db(client.storage.from("documents").remove(paths));
        await db(client.from("inbound_messages").delete().eq("organization_id",org));
        await db(client.from("email_routing_addresses").delete().eq("organization_id",org));
        await db(client.from("organizations").delete().eq("id",org));
      }
      cleanup=true;
    } catch(e){results.push({name:"cleanup",pass:false,detail:String(e.message).slice(0,350)});}
  }
  return Response.json({marker,results,cleanup,passed:results.filter(x=>x.pass).length,failed:results.filter(x=>!x.pass).length,notCovered:["browser preview/Save","scheduled recovery","Postmark delivery/forwarding"]});
});
