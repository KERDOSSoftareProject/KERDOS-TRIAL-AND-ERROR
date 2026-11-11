import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {fileURLToPath,pathToFileURL} from "node:url";
import {join} from "node:path";
import {createElement} from "react";
import Renderer,{act} from "react-test-renderer";
import {renderToStaticMarkup} from "react-dom/server";
import {build} from "vite";
import {createSupabaseBackend} from "../backend/supabase.js";

const temporary=mkdtempSync(fileURLToPath(new URL("../../node_modules/.kerdos-document-pages-",import.meta.url)));
try{
  await build({configFile:false,logLevel:"error",esbuild:{jsx:"automatic"},build:{
    ssr:fileURLToPath(new URL("./DocumentPages.jsx",import.meta.url)),outDir:temporary,
    rollupOptions:{output:{entryFileNames:"document-pages.mjs"}},
  }});
  const {PriceSheetsPage,InvoicesPage}=await import(pathToFileURL(join(temporary,"document-pages.mjs")));
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
  assert.ok(!html.includes('role="status"'),"no aggregate file counter is shown");
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
  const imports=[],data=[file,{...file,id:"document-3",vendor_id:"v2",file_name:"Winter specials.csv",created_at:"2026-10-30"}];
  let tree;
  const props={...base,importDocuments:data,onImport:id=>imports.push(id),setVendorFilter:()=>{}};
  await act(async()=>{tree=Renderer.create(createElement(PriceSheetsPage,props));});
  const findSearch=()=>tree.root.findByProps({"aria-label":"Search price sheets"});
  const text=node=>typeof node==="string"?node:(node?.children||[]).map(text).join("");
  const pageText=()=>text(tree.toJSON());
  const browse=tree.root.findByProps({"aria-label":"Price sheet browse controls"});
  assert.equal(browse.findAllByType('select').length,1,'vendor selection shares the browse row');
  const importButton=browse.findByType('button');
  await act(async()=>{importButton.props.onClick();});
  assert.deepEqual(imports,['v1'],'import retains the selected vendor');
  await act(async()=>{findSearch().props.onChange({target:{value:'WINTER'}});});
  assert.match(pageText(),/No price sheets match/,'search respects selected vendor');
  await act(async()=>{tree.update(createElement(PriceSheetsPage,{...props,vendorFilter:null}));});
  assert.match(pageText(),/Winter specials.csv/,'search opens matching vendor groups');
  assert.ok(!pageText().includes('Vendor prices.xlsx'));
  await act(async()=>{findSearch().props.onChange({target:{value:'supplier a'}});});
  assert.match(pageText(),/Vendor prices.xlsx/,'vendor-name search finds its files');
  assert.ok(!pageText().includes('Winter specials.csv'));
  await act(async()=>{findSearch().props.onChange({target:{value:'2026-10-30'}});});
  assert.match(pageText(),/Winter specials.csv/,'search finds document dates');
  await act(async()=>{findSearch().props.onChange({target:{value:''}});});
  assert.match(pageText(),/Supplier A/,'clearing search restores the first vendor');
  assert.match(pageText(),/Supplier B/,'clearing search restores the second vendor');
  tree.unmount();
  assert.equal(data.length,2,'browsing never changes saved documents');
  console.log('PASS Price Sheets browse row, selected-vendor import, filename/vendor/date search, search clearing and no-match state.');

  const requests=[];
  let refreshes=0,staleApply=false;
  const reviewPriceSheet=async request=>{
    requests.push(request);
    if(request.action.startsWith('preview-')){
      const confirmation=request.action==='preview-confirmation';
      const token=confirmation?'confirm-token':request.documentId?'recheck-token':'workspace-token';
      const rows=[{listingId:'eligible-1',description:'Eligible product',packSize:'12 EA',fileName:file.file_name,
        ...(confirmation?{sellingUnit:'CASE'}:{previousReviewFields:['selling_unit'],reviewFields:[],reviewRequired:false})},
        {listingId:'extra-1',description:'Extra eligible product'}];
      return {
        token:request.listingIds?`${token}-selected`:token,
        rows:request.listingIds?rows.filter(row=>request.listingIds.includes(row.listingId)):rows,
        held:[{listingId:'held-1',description:'Held product',reason:'Verify original pack'}],
        counts:{ready:170,total:531,projectedReady:confirmation?170:256},
      };
    }
    if(staleApply&&request.action==='apply-recheck')throw new Error('Preview is stale. Review the current sheet again.',{cause:{status:409}});
    return {counts:{ready:170,total:531,projectedReady:request.action==='confirm'?170:256,
      readyAfter:request.action==='confirm'?170:256,totalAfter:531}};
  };
  const reviewProps={...base,orgId:'org-1',expandedId:file.id,reviewPriceSheet,onReviewSaved:()=>{refreshes++;}};
  const reviewButton=label=>tree.root.findAllByType('button').find(b=>text({children:b.children})===label);
  await act(async()=>{tree=Renderer.create(createElement(PriceSheetsPage,reviewProps));});
  await act(async()=>{reviewButton('Confirm quoted per').props.onClick();});
  assert.deepEqual(requests,[],'opening confirmation is read only');
  assert.equal(reviewButton('Preview confirmation').props.disabled,true,'a quoted unit is required');
  const pick=value=>tree.root.findByProps({'aria-label':'Confirmed quoted unit'}).props.onChange({target:{value}});
  await act(async()=>{pick('weight');});
  assert.equal(reviewButton('Preview confirmation').props.disabled,true,'a measurement group alone is not a valid unit');
  await act(async()=>{pick('case');});
  await act(async()=>{reviewButton('Preview confirmation').props.onClick();});
  assert.deepEqual(requests,[{organizationId:'org-1',documentId:file.id,action:'preview-confirmation',unit:'CASE'}]);
  assert.match(pageText(),/Eligible product.*12 EA/);
  assert.match(pageText(),/Quoted per Case/);
  assert.match(pageText(),/Held product.*Verify original pack/);
  assert.match(pageText(),/Order Guide ready 170 of 531/);
  await act(async()=>{pick('each');});
  assert.equal(reviewButton('Confirm verified unit'),undefined,'changing the unit invalidates the exact preview');
  await act(async()=>{pick('case');});
  await act(async()=>{reviewButton('Preview confirmation').props.onClick();});
  const selectRow=label=>tree.root.findByProps({'aria-label':`Include ${label}`}).props.onChange();
  await act(async()=>{selectRow('Extra eligible product');});
  assert.equal(reviewButton('Confirm verified unit').props.disabled,true,'changed selection needs a new signed preview');
  await act(async()=>{selectRow('Eligible product');});
  assert.equal(reviewButton('Update preview').props.disabled,true,'empty selection cannot be approved');
  await act(async()=>{selectRow('Eligible product');});
  await act(async()=>{reviewButton('Update preview').props.onClick();});
  assert.deepEqual(requests.at(-1),{organizationId:'org-1',documentId:file.id,action:'preview-confirmation',unit:'CASE',listingIds:['eligible-1']});
  assert.equal(reviewButton('Confirm verified unit').props.disabled,false);
  assert.doesNotMatch(pageText(),/Extra eligible product/);
  await act(async()=>{reviewButton('Confirm verified unit').props.onClick();});
  assert.deepEqual(requests.at(-1),{organizationId:'org-1',documentId:file.id,action:'confirm',token:'confirm-token-selected'});
  assert.equal(refreshes,1);
  assert.match(pageText(),/Quoted unit confirmation saved/);

  await act(async()=>{reviewButton('Preview source recheck').props.onClick();});
  assert.deepEqual(requests.at(-1),{organizationId:'org-1',documentId:file.id,action:'preview-recheck'});
  assert.match(pageText(),/Projected after approval 256 of 531/);
  assert.match(pageText(),/Current review fields quoted per.*Source review clears/);
  staleApply=true;
  await act(async()=>{reviewButton('Approve source recheck').props.onClick();});
  assert.match(pageText(),/Preview is stale/);
  assert.equal(reviewButton('Approve source recheck'),undefined,'a stale preview must be generated again');
  assert.equal(refreshes,1,'the stale attempt did not save anything');
  staleApply=false;
  await act(async()=>{reviewButton('Preview source recheck').props.onClick();});
  await act(async()=>{reviewButton('Approve source recheck').props.onClick();});
  assert.deepEqual(requests.at(-1),{organizationId:'org-1',documentId:file.id,action:'apply-recheck',token:'recheck-token'});
  assert.equal(refreshes,2);
  assert.match(pageText(),/Order Guide ready before save 170 of 531 · Ready after save 256 of 531/);

  await act(async()=>{reviewButton('Preview workspace recheck').props.onClick();});
  assert.deepEqual(requests.at(-1),{organizationId:'org-1',action:'preview-recheck'});
  assert.match(pageText(),/Eligible product.*12 EA.*Vendor prices\.xlsx/);
  await act(async()=>{selectRow('Extra eligible product');});
  assert.equal(reviewButton('Approve workspace recheck').props.disabled,true);
  await act(async()=>{reviewButton('Update preview').props.onClick();});
  assert.deepEqual(requests.at(-1),{organizationId:'org-1',action:'preview-recheck',listingIds:['eligible-1']});
  await act(async()=>{reviewButton('Approve workspace recheck').props.onClick();});
  assert.deepEqual(requests.at(-1),{organizationId:'org-1',action:'apply-recheck',token:'workspace-token-selected'});
  assert.equal(refreshes,3);

  await act(async()=>{tree.update(createElement(PriceSheetsPage,{...reviewProps,role:'manager'}));});
  assert.ok(reviewButton('Confirm quoted per'));
  assert.equal(reviewButton('Preview source recheck'),undefined,'approval is available only to owners');
  assert.equal(reviewButton('Preview workspace recheck'),undefined,'workspace approval is available only to owners');
  await act(async()=>{tree.update(createElement(PriceSheetsPage,{...reviewProps,role:'employee'}));});
  assert.equal(reviewButton('Confirm quoted per'),undefined,'employees cannot confirm pricing');
  await act(async()=>{tree.unmount();});
  console.log('PASS price sheet review shows exact eligible and held listings, sends scoped tokens, and refreshes readiness after each explicit action.');

  const originalWindow=globalThis.window;
  globalThis.window={localStorage:{removeItem(){}},sessionStorage:{}};
  try{
    const invoked=[];
    let fail=false;
    const adapter=createSupabaseBackend({url:'https://example.invalid',anonKey:'test-public-key'},()=>({functions:{invoke:async(name,request)=>{
      invoked.push({name,...request});
      if(fail)return {data:null,error:{context:new Response(JSON.stringify({error:'Preview is stale.'}),{status:409})}};
      return {data:{token:'server-token'},error:null};
    }}}));
    const input={organizationId:'org-1',documentId:file.id,action:'confirm',token:'confirm-token'};
    assert.deepEqual(await adapter.documents.reviewPriceSheet({...input,actor:'forged',time:'forged',patch:{},unit:'EACH',listingIds:['other']}),{token:'server-token'});
    assert.deepEqual(invoked,[{name:'price-sheet-review',body:input}],'browser adapter sends scope and token only');
    await adapter.documents.reviewPriceSheet({organizationId:'org-1',action:'preview-recheck',listingIds:['eligible-1']});
    assert.deepEqual(invoked.at(-1),{name:'price-sheet-review',body:{organizationId:'org-1',action:'preview-recheck',listingIds:['eligible-1']}});
    fail=true;
    await assert.rejects(adapter.documents.reviewPriceSheet(input),err=>err.cause?.status===409&&err.message.includes('Preview is stale.'));
  }finally{
    if(originalWindow===undefined)delete globalThis.window;else globalThis.window=originalWindow;
  }
  console.log('PASS price sheet review adapter uses authenticated Edge invocation and preserves stale-preview errors.');

  const invoiceActions=[];
  const invoiceProps={...base,vendorFilter:null,formatMoney:value=>String(value),attentionCount:1,
    invoices:[{id:'i1',vendor_id:'v1',invoice_number:'INV-123',file_name:'October delivery.pdf',invoice_date:'2026-10-15',file_path:'original.pdf',invoice_lines:[{price_variance:2}]},{id:'i2',vendor_id:'v2',invoice_number:'INV-456',file_name:'November delivery.pdf',invoice_date:'2026-11-01',invoice_lines:[]}],
    onImport:id=>invoiceActions.push(['import',id]),onExport:()=>invoiceActions.push(['export']),onViewOriginal:path=>invoiceActions.push(['original',path])};
  await act(async()=>{tree=Renderer.create(createElement(InvoicesPage,invoiceProps));});
  const invoiceSearch=()=>tree.root.findByProps({'aria-label':'Search invoices'});
  const invoiceBrowse=tree.root.findByProps({'aria-label':'Invoice browse controls'});
  assert.equal(invoiceBrowse.findAllByType('select').length,1);
  await act(async()=>{invoiceBrowse.findAllByType('button')[1].props.onClick();});
  assert.deepEqual(invoiceActions,[],'report opens before any CSV download');
  const reportAction=label=>tree.root.findAllByType('button').find(b=>text({children:b.children})===label);
  assert.equal(tree.root.findAllByProps({role:'dialog','aria-label':'Price Variance Report'}).length,1);
  await act(async()=>{reportAction('Download CSV').props.onClick();});
  assert.deepEqual(invoiceActions,[['export']],'report retains its scoped export callback');
  await act(async()=>{reportAction('Close').props.onClick();});
  for(const value of ['inv-123','october','supplier a','2026-10-15']){
    await act(async()=>{invoiceSearch().props.onChange({target:{value}});});
    assert.match(pageText(),/October delivery.pdf/);
    assert.ok(!pageText().includes('November delivery.pdf'),'search filters invoice documents');
    assert.match(pageText(),/need review/,'price comparison review notice is preserved');
  }
  await act(async()=>{tree.root.findByProps({title:'Open original invoice'}).props.onClick({stopPropagation(){}});});
  assert.deepEqual(invoiceActions.at(-1),['original','original.pdf'],'original file action is preserved');
  await act(async()=>{tree.update(createElement(InvoicesPage,{...invoiceProps,vendorFilter:'v2'}));});
  assert.match(pageText(),/No invoices match/,'search combines with vendor selection');
  await act(async()=>{invoiceSearch().props.onChange({target:{value:''}});});
  const selectedBrowse=tree.root.findByProps({'aria-label':'Invoice browse controls'});
  await act(async()=>{selectedBrowse.findAllByType('button')[0].props.onClick();});
  assert.deepEqual(invoiceActions.at(-1),['import','v2'],'invoice import retains selected vendor');
  await act(async()=>{tree.update(createElement(InvoicesPage,{...invoiceProps,role:'employee'}));});
  assert.ok(!pageText().includes('Import Invoice'),'employee import restriction remains');
  assert.equal(tree.root.findAllByProps({title:'Edit invoice record'}).length,0);
  tree.unmount();
  console.log('PASS invoice search by vendor/number/file/date, selected-vendor import, report export, original access and employee restrictions.');
  console.log("Imported-document page checks passed: actual sources only, correction history excluded, original access, incomplete and repeated imports, vendor filtering, closed defaults, and document pagination.");
}finally{rmSync(temporary,{recursive:true,force:true});}
