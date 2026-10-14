import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {fileURLToPath,pathToFileURL} from "node:url";
import {join} from "node:path";
import {createElement} from "react";
import {renderToStaticMarkup} from "react-dom/server";
import {build} from "vite";

const temporary=mkdtempSync(fileURLToPath(new URL("../../node_modules/.kerdos-document-pages-",import.meta.url)));
try{
  await build({configFile:false,logLevel:"error",esbuild:{jsx:"automatic"},build:{
    ssr:fileURLToPath(new URL("./DocumentPages.jsx",import.meta.url)),outDir:temporary,
    rollupOptions:{output:{entryFileNames:"document-pages.mjs"}},
  }});
  const {PriceSheetsPage}=await import(pathToFileURL(join(temporary,"document-pages.mjs")));
  const file={id:"document-1",vendor_id:"v1",document_kind:"pricelist",created_at:"2026-09-26",file_name:"Vendor prices.xlsx",file_path:"org/vendor/source.xlsx",status:"partial",completed_keys:["row:0","row:1"]};
  const corrections=Array.from({length:3},(_,n)=>({id:`change-${n}`,vendor_item_id:"item-1",source_file_name:"Catalog field correction",effective_date:`2026-09-26T10:0${n}:00Z`,price:25+n}));
  const base={vendors:[{id:"v1",name:"Supplier A"},{id:"v2",name:"Supplier B"}],vendorFilter:"v1",vendorColors:new Map(),formatDate:value=>value,role:"owner",
    importDocuments:[file],priceHistory:corrections,vendorItems:[{id:"item-1",vendor_id:"v1",description:"Edited product"}],unavailableCount:55,expiredCount:5};
  const render=props=>renderToStaticMarkup(createElement(PriceSheetsPage,{...base,...props}));

  let html=render({expandedId:file.id});
  assert.match(html,/Vendor prices.xlsx/);
  assert.match(html,/1 source file/);
  assert.match(html,/Import marked incomplete/);
  assert.match(html,/2 rows checkpointed/);
  assert.match(html,/Open original file/);
  for(const unwanted of ["Catalog field correction","Edited product","price row","need attention","25.00"])
    assert.ok(!html.includes(unwanted),`${unwanted} must not appear as an imported document or activity`);

  html=render({importDocuments:[]});
  // vendorFilter is active (v1 = "Supplier A") so we get the vendor-specific message
  assert.match(html,/No price sheets on file for.*Supplier A/);
  assert.match(html,/Import price sheet/i);
  assert.match(html,/0 source files/);
  assert.ok(!html.includes("Catalog field correction"),"history alone cannot create documents");

  html=render({importDocuments:[file,{...file,id:"document-2",created_at:"2026-09-27"},{...file,id:"invoice-1",document_kind:"invoice"},{...file,id:"other-vendor",vendor_id:"v2"}]});
  assert.equal((html.match(/▤ Vendor prices.xlsx/g)||[]).length,2,"same-named actual imports remain separate; other vendors and invoices are excluded");
  assert.match(html,/2 source files/);
  assert.ok(html.indexOf("2026-09-27")<html.indexOf("2026-09-26"),"newer documents are first");
  assert.ok(!html.includes("Open original file"),"documents remain closed by default");

  html=render({importDocuments:[{...file,file_path:null,file_name:"Pasted quotation"}],expandedId:file.id});
  assert.match(html,/Open original source/,"pasted imports still expose their saved original text");
  html=render({importDocuments:[{...file,file_name:"Catalog field correction"}]});
  assert.match(html,/▤ Catalog field correction/,"real imports are identified by their source record, never a filename blacklist");
  html=render({hasMore:true,loadingMore:false});
  assert.match(html,/Load earlier imported documents/);
  html=render({role:"employee",expandedId:file.id});
  assert.match(html,/Open original file/);
  assert.ok(!html.includes("Actions for Vendor prices.xlsx"),"employees can open documents without destructive controls");
  console.log("Imported-document page checks passed: actual sources only, correction history excluded, original access, incomplete and repeated imports, vendor filtering, closed defaults, and document pagination.");
}finally{rmSync(temporary,{recursive:true,force:true});}
