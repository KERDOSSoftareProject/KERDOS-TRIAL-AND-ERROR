// Reproduce the mounted Inbox failure using the production backend adapter,
// with only the SDK transport replaced. This is local integration evidence.
import {build} from "esbuild";
import {execFileSync} from "node:child_process";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";

const dir=mkdtempSync(join(tmpdir(),"kerdos-inbox-adapter-"));
const source=String.raw`
import React from "react";
import Renderer,{act} from "react-test-renderer";
import assert from "node:assert/strict";
import {createSupabaseBackend} from "./src/backend/supabase.js";
import {assertBackendContract} from "./src/backend/contract.js";
import {RoutingAddressPanel,EmailInboxPanel} from "./src/pages/EmailInboxPanel.jsx";
import {createRoutingAddress,setRoutingAddressVendor,deactivateRoutingAddress,listMessages,getMessage,listPendingAttachments,getAttachmentFile,beginManualAttachmentReview,markAttachmentIngested} from "./src/services/email-routing.js";
const calls=[];
let rpcData=true,rpcError=null;
const data={email_routing_addresses:[],inbound_messages:[],inbound_attachments:[]};
const client={
  from(table){
    const filters=[];let action="select",value,one=false;
    const q={
      select(){return q;},eq(k,v){filters.push(["eq",k,v]);return q;},
      is(k,v){filters.push(["is",k,v]);return q;},in(k,v){filters.push(["in",k,v]);return q;},
      order(){return q;},range(){return q;},single(){one=true;return q;},maybeSingle(){one=true;return q;},
      insert(v){action="insert";value=v;return q;},update(v){action="update";value=v;return q;},
      then(resolve,reject){
        calls.push({table,action,value,filters});
        const rows=data[table].filter(r=>filters.every(([op,k,v])=>op==="in"?v.includes(r[k]):op==="is"&&v===null?r[k]==null:r[k]===v));
        return Promise.resolve({data:action==="select"?(one?rows[0]||null:rows):one?{id:"address",...value}:[],error:null}).then(resolve,reject);
      },
    };return q;
  },
  rpc(name,params){calls.push({rpc:name,params});return Promise.resolve({data:rpcData,error:rpcError});},
  storage:{from(bucket){assert.equal(bucket,"documents");return {createSignedUrl(path,seconds){calls.push({path,seconds});return Promise.resolve({data:{signedUrl:"data:text/csv,code%2Cdescription%0A001%2CTest"},error:null});}};}},
};
globalThis.window={sessionStorage:{},localStorage:{removeItem(){}}};
const backend=assertBackendContract(createSupabaseBackend({url:"https://example.supabase.co",anonKey:"test-public"},()=>client));
assert.equal(backend.from,undefined);assert.equal(backend.rpc,undefined);assert.equal(backend.storage,undefined);
globalThis.__inboxAdapter=backend;
let tree;
await act(async()=>{tree=Renderer.create(React.createElement(React.Fragment,null,React.createElement(RoutingAddressPanel,{orgId:"org-1"}),React.createElement(EmailInboxPanel,{orgId:"org-1"})))});
const rendered=JSON.stringify(tree.toJSON());
assert.ok(rendered.includes("No client setup is required"));
assert.ok(rendered.includes("No emails received yet"));
assert.ok(!rendered.includes("is not a function"));
assert.ok(calls.every(call=>call.action===undefined||call.action==="select"),"mounting Inbox must never configure routing");
for(const table of ["email_routing_addresses","inbound_messages"]){assert.ok(calls.some(c=>c.table===table&&c.filters.some(f=>f[1]==="organization_id"&&f[2]==="org-1")));}
await act(async()=>tree.unmount());
console.log("PASS both mounted Inbox sections load through the production KERDOS adapter");
await createRoutingAddress(backend,"org-1",{routingAddress:"test@inbound.kerdos.com",vendorId:"vendor-1"});
assert.equal(calls.at(-1).value.organization_id,"org-1");
assert.equal(calls.at(-1).value.vendor_id,"vendor-1");
await setRoutingAddressVendor(backend,"org-1","address","vendor-2");
assert.equal(calls.at(-1).value.vendor_id,"vendor-2");
await deactivateRoutingAddress(backend,"org-1","address");
assert.equal(calls.at(-1).value.is_active,false);
console.log("PASS address create, vendor change and deactivate use records operations");
data.inbound_messages=[{id:"message",organization_id:"org-1",inbound_attachments:[{id:"a1",processing_status:"needs_review"}]}];
assert.equal((await listMessages(backend,"org-1"))[0].pending_count,1);
assert.equal((await getMessage(backend,"org-1","message")).id,"message");
data.inbound_attachments=[
 {id:"a1",organization_id:"org-1",processing_status:"needs_review",import_document_id:null,filename:"test.csv",storage_path:"org-1/inbound/message/0",created_at:"2026-10-27"},
 {id:"a2",organization_id:"org-1",processing_status:"pending",import_document_id:"partial",created_at:"2026-10-26"},
 {id:"done",organization_id:"org-1",processing_status:"auto_imported",import_document_id:"done"},
 {id:"other",organization_id:"org-2",processing_status:"pending",import_document_id:null},
];
assert.deepEqual((await listPendingAttachments(backend,"org-1")).map(x=>x.id),["a1","a2"]);
console.log("PASS message reads and deduplicated pending queue preserve organization scope and partials");
const file=await getAttachmentFile(backend,"org-1","a1");
assert.equal(file.name,"test.csv");assert.equal(await file.text(),"code,description\n001,Test");
assert.ok(calls.some(c=>c.path==="org-1/inbound/message/0"&&c.seconds===60));
console.log("PASS attachment download uses the document adapter");
assert.equal(await beginManualAttachmentReview(backend,"org-1","a1"),true);
assert.deepEqual(calls.at(-1),{rpc:"begin_manual_attachment_review",params:{p_organization_id:"org-1",p_attachment_id:"a1"}});
rpcData=false;assert.equal(await beginManualAttachmentReview(backend,"org-1","a1"),false);
rpcError={message:"permission denied"};await assert.rejects(beginManualAttachmentReview(backend,"org-1","a1"),/permission denied/);
rpcError=null;rpcData=null;
await markAttachmentIngested(backend,"org-1","a1","document","auto_imported");
assert.deepEqual(calls.at(-1),{rpc:"mark_attachment_ingested",params:{p_attachment_id:"a1",p_import_document_id:"document",p_final_status:"auto_imported"}});
console.log("PASS reservation success, contention, errors and final linkage use Inbox adapter operations");
console.log("5/5 Inbox adapter integration checks passed");
process.exit(0);
`;
try{
  const outfile=join(dir,"test.mjs");
  await build({stdin:{contents:source,resolveDir:process.cwd(),loader:"jsx"},outfile,bundle:true,platform:"node",format:"esm",jsx:"automatic",define:{"import.meta.env":"{}"},external:["xlsx","pdfjs-dist","tesseract.js"],plugins:[{name:"inbox-adapter-under-test",setup(b){
    b.onResolve({filter:/backend\/index\.js$/},()=>({path:"test-backend",namespace:"test"}));
    b.onLoad({filter:/.*/,namespace:"test"},()=>({contents:"export const backend=new Proxy({}, {get:(_target,key)=>globalThis.__inboxAdapter[key]});"}));
    b.onResolve({filter:/document-reader\.js$/},()=>({path:"test-reader",namespace:"reader"}));
    b.onLoad({filter:/.*/,namespace:"reader"},()=>({contents:"export async function fileToText(file){return file.text();}"}));
  }}]});
  process.stdout.write(execFileSync(process.execPath,[outfile],{encoding:"utf8",timeout:20000}));
}finally{rmSync(dir,{recursive:true,force:true});}
