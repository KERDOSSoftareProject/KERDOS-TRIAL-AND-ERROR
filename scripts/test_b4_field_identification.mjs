// B4: render the production import dialog, parser and organization service.
// Persistence and browser file reading are simulated: local evidence only.
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'kerdos-b1-'));
const source=String.raw`
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import assert from 'node:assert/strict';
import {PasteModal} from './src/pages/ImportModal.jsx';
import {createRecords} from './src/backend/records.js';
import {createPriceImportFixture} from './scripts/fixtures/price-import-backend.mjs';
import {parseDocument} from './src/ingestion.js';
import {rememberedLayout} from './src/core/sheet-layout.js';
const org='10000000-0000-0000-0000-000000000001',vendor='20000000-0000-0000-0000-000000000001';
const sheet=(label='Tariff')=>'Code,Description,Pack,Price Unit,'+label+'\nB4-001,Chicken Breast Boneless Skinless,20 LB,CASE,41.25\n';
const text=n=>typeof n==='string'?n:(n.children||[]).map(text).join('');
let passed=0,failed=0;
function fixture(){
 const f=createPriceImportFixture({text:sheet()});f.settings={price_refresh_days:7,vendorLayouts:{otherVendor:{otherLayout:{0:'ignore'}}}};f.settingWrites=[];
 const original=f.backend.records.query;
 const settings=createRecords(async spec=>{assert.equal(spec.action,'update');assert.deepEqual(spec.filters,[{operator:'eq',column:'id',value:org}]);if(f.failSettings)return {data:null,error:{message:'Controlled settings outage'}};f.settings=structuredClone(spec.value.settings);f.settingWrites.push(structuredClone(spec));return {data:[],error:null};});
 f.backend.records.query=table=>table==='organizations'?settings.query(table):original(table);
 globalThis.__b1Backend=f.backend;return f;
}
async function open(settings){let tree;await act(async()=>{tree=Renderer.create(React.createElement(PasteModal,{industry:'restaurant',vendors:[{id:vendor,name:'B4 Vendor'},{id:'otherVendor',name:'Other Vendor'}],orgId:org,orgSettings:settings,catalogItems:[],categories:[],vendorItems:[],mappings:[],onClose(){},onDone:async()=>{},initialVendorId:vendor,initialMode:'pricelist'}));});return tree;}
const button=(tree,label)=>tree.root.findAllByType('button').find(b=>text(b)===label);
async function upload(tree,label='Tariff'){
 const content=sheet(label);await act(async()=>{tree.root.find(n=>n.type==='input'&&n.props.type==='file').props.onChange({target:{files:[{name:'B4_'+label+'.csv',size:content.length,text:async()=>content}],value:'selected'}});await new Promise(r=>setTimeout(r,950));});
}
async function answer(tree,role='price'){
 assert.match(text(tree.toJSON()),/Check unrecognized column/);
 const select=tree.root.findAllByType('select').find(s=>s.findAllByType('option').some(o=>o.props.value==='price'));
 await act(async()=>{select.props.onChange({target:{value:role}});});
 await act(async()=>{await button(tree,'Continue →').props.onClick();});
 assert.ok(button(tree,'Save Import →'),'confirmation should reach read-only preview');
}
async function cancel(tree){await act(async()=>{button(tree,'Cancel').props.onClick();});}
async function check(name,fn){try{await fn();passed++;console.log('PASS '+name);}catch(e){failed++;console.error('FAIL '+name+' — '+e.message);}}
await check('two recognized column hits identify a header and map exact source fields',async()=>{
 const parsed=parseDocument(sheet().replace('Tariff','Price'));
 assert.equal(parsed.layout.headers.length,5);assert.equal(parsed.rows.length,1);
 const row=parsed.rows[0];assert.equal(row.code,'B4-001');assert.equal(row.description,'Chicken Breast Boneless Skinless');assert.equal(row.packSize,'20 LB');assert.equal(row.sellingUnit,'CASE');assert.equal(row.price,41.25);
});
await check('one recognized column hit cannot promote a row to a confirmed header',async()=>{
 const parsed=parseDocument('Description,Oddity,Other\nChicken Breast Boneless Skinless,20 LB,41.25\nTurkey Breast Smoked,20 LB,51.75');
 assert.deepEqual(parsed.layout.headers,[],'B4 requires at least two recognized column hits');
 assert.deepEqual(parsed.rows.map(row=>row.price),[41.25,51.75],'fallback must retain both genuine products');
});
await check('same vendor/layout is asked once within a still-open modal',async()=>{
 const f=fixture(),tree=await open(f.settings);try{
 await upload(tree);await answer(tree);await cancel(tree);await upload(tree);
 assert.ok(button(tree,'Save Import →'),'already confirmed layout must not ask again');
 assert.equal(f.settingWrites.length,1,'re-reading a remembered layout must not repeat settings writes');
 assert.equal(f.calls.applyQuote.length,0);assert.equal(f.calls.insertImportDoc.length,0);
 }finally{tree.unmount();}
});
await check('a second confirmed layout preserves the first and unrelated settings',async()=>{
 const f=fixture(),tree=await open(f.settings);try{
 await upload(tree);await answer(tree);await cancel(tree);await upload(tree,'Tariff B');await answer(tree);
 const first=parseDocument(sheet()).layout.fingerprint,second=parseDocument(sheet('Tariff B')).layout.fingerprint;
 assert.deepEqual(rememberedLayout(f.settings,vendor,first),{4:'price'},'first answer was overwritten');
 assert.deepEqual(rememberedLayout(f.settings,vendor,second),{4:'price'});
 assert.equal(f.settings.price_refresh_days,7);assert.deepEqual(f.settings.vendorLayouts.otherVendor,{otherLayout:{0:'ignore'}});
 assert.equal(f.calls.applyQuote.length,0);assert.equal(f.calls.insertImportDoc.length,0);
 }finally{tree.unmount();}
});
await check('a fresh modal uses persisted answers without asking or saving source data',async()=>{
 const f=fixture(),first=await open(f.settings);await upload(first);await answer(first);first.unmount();
 const tree=await open(f.settings);try{await upload(tree);assert.ok(button(tree,'Save Import →'));assert.equal(f.settingWrites.length,1);assert.equal(f.calls.applyQuote.length,0);assert.equal(f.calls.insertImportDoc.length,0);}finally{tree.unmount();}
});
await check('confirmed roles stay scoped to their vendor when the selected vendor changes',async()=>{
 const f=fixture(),tree=await open(f.settings);try{
 await upload(tree);await answer(tree,'ignore');await cancel(tree);
 const selector=tree.root.findAllByType('select').find(s=>s.findAllByType('option').some(o=>o.props.value==='otherVendor'));
 await act(async()=>{selector.props.onChange({target:{value:'otherVendor'}});});
 await upload(tree);
 assert.match(text(tree.toJSON()),/Check unrecognized column/,'another vendor must not inherit the first vendor answer');
 const choice=tree.root.findAllByType('select').find(s=>s.findAllByType('option').some(o=>o.props.value==='price'));
 assert.equal(choice.props.value,'price','the new vendor gets its own source-based suggestion');
 assert.equal(f.settingWrites.length,1);assert.equal(f.calls.applyQuote.length,0);
 }finally{tree.unmount();}
});
await check('failed settings persistence stays visible and a later confirmation can retry',async()=>{
 const f=fixture();f.failSettings=true;const tree=await open(f.settings);try{
 await upload(tree);await answer(tree);
 assert.match(text(tree.toJSON()),/could not be remembered/);assert.equal(f.settingWrites.length,0);
 assert.equal(f.calls.applyQuote.length,0);await cancel(tree);f.failSettings=false;
 await upload(tree);await answer(tree);assert.equal(f.settingWrites.length,1);
 assert.ok(!text(tree.toJSON()).includes('could not be remembered'));assert.equal(f.calls.applyQuote.length,0);
 }finally{tree.unmount();}
});
console.log(passed+'/'+(passed+failed)+' B4 parser/rendered checks passed (mocked settings/database; not live browser evidence).');
process.exit(failed?1:0);
`;
try{
 const outfile=join(dir,'test.mjs');
 await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'jsx'},outfile,bundle:true,platform:'node',format:'esm',jsx:'automatic',define:{'import.meta.env':'{}'},plugins:[{name:'b1-boundaries',setup(b){
  b.onResolve({filter:/import-evidence\.js$/},args=>args.namespace==='evidence-spy'?({path:args.path,namespace:'file'}):({path:'spy',namespace:'evidence-spy'}));
  b.onLoad({filter:/spy/,namespace:'evidence-spy'},()=>({contents:`import {explainImportRow as real} from ${JSON.stringify(process.cwd()+'/src/core/import-evidence.js')};export function explainImportRow(...args){globalThis.__evidenceCalls=(globalThis.__evidenceCalls||0)+1;return real(...args);}`}));
  b.onResolve({filter:/document-reader\.js$/},()=>({path:'reader',namespace:'b1'}));
  b.onLoad({filter:/reader/,namespace:'b1'},()=>({contents:'export async function fileToText(file,{onRead}={}){if(file.reading)onRead?.(file.reading);return file.text();}'}));
  b.onResolve({filter:/backend\/index\.js$/},()=>({path:'backend',namespace:'b1'}));
  b.onLoad({filter:/backend/,namespace:'b1'},()=>({contents:'export const backend={records:{query:(...args)=>globalThis.__b1Backend.records.query(...args)},documents:{upload:(...args)=>globalThis.__b1Backend.documents.upload(...args),remove:(...args)=>globalThis.__b1Backend.documents.remove(...args)},pricing:{applyQuote:(...args)=>globalThis.__b1Backend.pricing.applyQuote(...args)},invoices:{record:(...args)=>globalThis.__b1Backend.invoices.record(...args)}};'}));
 }}]});
 try{process.stdout.write(execFileSync(process.execPath,[outfile],{encoding:'utf8',timeout:60000,stdio:['ignore','pipe','pipe']}));}catch(error){process.stdout.write(error.stdout||'');process.stderr.write(error.stderr||'');process.exitCode=1;}
}finally{rmSync(dir,{recursive:true,force:true});}
