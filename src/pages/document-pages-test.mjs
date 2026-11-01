import assert from "node:assert/strict";
import {mkdtempSync,rmSync} from "node:fs";
import {fileURLToPath,pathToFileURL} from "node:url";
import {join} from "node:path";
import {createElement} from "react";
import Renderer,{act} from "react-test-renderer";
import {renderToStaticMarkup} from "react-dom/server";
import {build} from "vite";
import {createRecords} from "../backend/records.js";
import {createVarianceReportService} from "../services/variance-report.js";

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
  const invoiceActions=[];
  const invoiceProps={...base,vendorFilter:null,formatMoney:value=>String(value),attentionCount:1,
    invoices:[{id:'i1',vendor_id:'v1',invoice_number:'INV-123',file_name:'October delivery.pdf',invoice_date:'2026-10-15',file_path:'original.pdf',invoice_lines:[{price_variance:2}]},{id:'i2',vendor_id:'v2',invoice_number:'INV-456',file_name:'November delivery.pdf',invoice_date:'2026-11-01',invoice_lines:[]}],
    onImport:id=>invoiceActions.push(['import',id]),onExport:()=>invoiceActions.push(['export']),onViewOriginal:path=>invoiceActions.push(['original',path])};
  await act(async()=>{tree=Renderer.create(createElement(InvoicesPage,invoiceProps));});
  const invoiceSearch=()=>tree.root.findByProps({'aria-label':'Search invoices'});
  const invoiceBrowse=tree.root.findByProps({'aria-label':'Invoice browse controls'});
  assert.equal(invoiceBrowse.findAllByType('select').length,1);
  await act(async()=>{invoiceBrowse.findAllByType('button')[1].props.onClick();});
  assert.equal(tree.root.findAllByProps({role:'dialog','aria-label':'Price Variance Report'}).length,1,'report opens before download');
  assert.deepEqual(invoiceActions,[],'opening report must not immediately download');
  const reportButton=tree.root.findAllByType('button').find(button=>text(button.toJSON?.()||{children:button.children})==='Download CSV');
  await act(async()=>{reportButton.props.onClick();});
  assert.deepEqual(invoiceActions,[['export']],'report keeps its CSV export callback');
  const closeReport=tree.root.findAllByType('button').find(button=>text(button.toJSON?.()||{children:button.children})==='Close');
  await act(async()=>{closeReport.props.onClick();});
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
  let exported;
  const zeroInvoice={id:'zero',vendor_id:'v1',invoice_number:'ZERO-1',invoice_date:'2026-10-20',invoice_lines:[{description:'Matched item',unit_price:10,line_total:10,price_variance:0}]};
  await act(async()=>{tree=Renderer.create(createElement(InvoicesPage,{...invoiceProps,invoices:[zeroInvoice],onExport:scope=>exported=scope}));});
  await act(async()=>{tree.root.findByProps({'aria-label':'Invoice browse controls'}).findAllByType('button')[1].props.onClick();});
  assert.equal((pageText().match(/0 variances found/g)||[]).length,2,'every client vendor appears at zero');
  assert.match(pageText(),/Invoice #ZERO-1/);
  assert.match(pageText(),/Report period/);
  assert.match(pageText(),/reference not recorded/,'price sheet provenance cannot be invented');
  assert.match(pageText(),/No completed invoice comparisons/,'no evidence is distinct from a clean comparison');
  assert.ok(!pageText().includes('0 items found'));
  await act(async()=>{tree.root.findByProps({'aria-label':'Report from date'}).props.onChange({target:{value:'2026-11-01'}});});
  assert.ok(!pageText().includes('Invoice #ZERO-1'),'report periods exclude invoices outside the range');
  const download=()=>tree.root.findAllByType('button').find(button=>text({children:button.children})==='Download CSV');
  await act(async()=>{download().props.onClick();});assert.deepEqual(exported.invoices,[],'CSV uses the report period');
  await act(async()=>{tree.root.findByProps({'aria-label':'Report to date'}).props.onChange({target:{value:'2026-10-01'}});});
  assert.match(pageText(),/Choose an end date/);assert.equal(download().props.disabled,true);
  tree.unmount();
  const reads=[];
  const stored=Array.from({length:205},(_,i)=>({...zeroInvoice,id:'stored'+i,organization_id:'org'}));
  const service=createVarianceReportService({records:createRecords(async spec=>{
    reads.push(spec);assert.equal(spec.action,'select');assert.ok(spec.filters.some(f=>f.column==='organization_id'&&f.value==='org'));
    return {data:stored.slice(spec.range.from,spec.range.to+1),error:null};
  })});
  assert.equal((await service.invoices('org')).length,205,'report reads beyond the normal 30-invoice snapshot');
  assert.equal(reads.length,2);
  console.log('PASS variance report opens with per-vendor zero results, invoice evidence, explicit missing price-sheet references, period filters and scoped download; history reads remain read-only.');
  console.log("Imported-document page checks passed: actual sources only, correction history excluded, original access, incomplete and repeated imports, vendor filtering, closed defaults, and document pagination.");
}finally{rmSync(temporary,{recursive:true,force:true});}
