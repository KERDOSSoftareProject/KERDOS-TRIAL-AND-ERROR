// Render the real PasteModal and exercise its event handlers. This is local
// component evidence, not a live browser/database pass.
import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

const dir=mkdtempSync(join(tmpdir(),'kerdos-preview-save-'));
const source=String.raw`
import React from 'react';
import Renderer,{act} from 'react-test-renderer';
import assert from 'node:assert/strict';
import {PasteModal} from './src/pages/ImportModal.jsx';
const text=node=>node.children.map(x=>typeof x==='string'?x:text(x)).join('');
let reads=0,writes=0;
function query(){
  const q={};for(const key of ['select','eq','order','range','limit','maybeSingle','single'])q[key]=()=>q;
  for(const key of ['insert','update','delete','upsert'])q[key]=()=>{writes++;return q;};
  q.then=(resolve,reject)=>{reads++;return Promise.resolve({data:[],error:null}).then(resolve,reject);};return q;
}
globalThis.__a1Backend={records:{query},documents:{upload:async()=>{writes++;}},pricing:{applyQuote:async()=>{writes++;}},catalog:{saveRow:async()=>{writes++;}}};
async function preview(onBeforeSave){
  writes=0;reads=0;let closed=0,tree;
  const props={vendors:[{id:'v1',name:'Test vendor'}],orgId:'org-test',orgSettings:{},catalogItems:[],categories:[],vendorItems:[],mappings:[],onClose:()=>closed++,onDone:()=>{},onFinished:()=>{},onBeforeSave,initialVendorId:'v1',initialMode:'pricelist'};
  await act(async()=>{tree=Renderer.create(React.createElement(PasteModal,props));});
  await act(async()=>{tree.root.findByType('textarea').props.onChange({target:{value:'code,description,pack,price\nSKU-001,Chicken breast,1/10 LB,10.00'}});});
  const review=tree.root.findAllByType('button').find(x=>text(x)==='Review pasted text');
  assert.ok(review,'pasted rows must be reviewable');
  await act(async()=>{await review.props.onClick();});
  for(let i=0;i<50&&!tree.root.findAllByType('button').some(x=>text(x)==='Apply corrections');i++){
    await act(async()=>{await new Promise(resolve=>setTimeout(resolve,20));});
  }
  const previewNext=tree.root.findAllByType('button').find(x=>text(x)==='Save Import →');
  assert.equal(previewNext,undefined,'Inbox must open directly in exception review');
  const save=tree.root.findAllByType('button').find(x=>text(x)==='Apply corrections');
  assert.ok(save,'inbox review must wait for explicit corrections; controls: '+tree.root.findAllByType('button').map(text).join(' | '));
  return {tree,save,get closed(){return closed;}};
}
let passed=0;
{
  let reservations=0;const p=await preview(async()=>{reservations++;return true;});
  assert.equal(reservations,0);assert.equal(writes,0);
  await act(async()=>{p.tree.root.findAllByType('button').find(x=>text(x)==='×').props.onClick();});
  assert.equal(p.closed,1);assert.equal(reservations,0);assert.equal(writes,0);
  p.tree.unmount();console.log('PASS preview and close never reserve or write');passed++;
}
{
  let reservations=0;const p=await preview(async()=>{reservations++;return false;});
  await act(async()=>{await p.save.props.onClick();});
  assert.equal(reservations,1);assert.equal(writes,0);
  assert.ok(JSON.stringify(p.tree.toJSON()).includes('Automatic processing claimed this attachment'));
  p.tree.unmount();console.log('PASS lost automatic-claim race stops before every write');passed++;
}
{
  let reservations=0,release;const waiting=new Promise(resolve=>{release=resolve;});
  const p=await preview(async()=>{reservations++;return waiting;});
  await act(async()=>{
    const a=p.save.props.onClick();const b=p.save.props.onClick();
    release(false);await Promise.all([a,b]);
  });
  assert.equal(reservations,1,'two rapid clicks must make only one reservation attempt');
  assert.equal(writes,0);p.tree.unmount();console.log('PASS repeated Save clicks share one in-flight attempt');passed++;
}
{
  let reservations=0;const p=await preview(async()=>{reservations++;if(reservations===1)throw new Error('temporary reservation failure');return false;});
  await act(async()=>{await p.save.props.onClick();});
  assert.ok(JSON.stringify(p.tree.toJSON()).includes('temporary reservation failure'));
  await act(async()=>{await p.save.props.onClick();});
  assert.equal(reservations,2,'failed reservation must allow an explicit retry');
  assert.equal(writes,0);p.tree.unmount();console.log('PASS failed reservation releases the local save guard for retry');passed++;
}
console.log(passed+'/4 rendered preview/Save checks passed');
process.exit(0);
`;
try{
  const outfile=join(dir,'test.mjs');
  await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'jsx'},outfile,bundle:true,platform:'node',format:'esm',jsx:'automatic',define:{'import.meta.env':'{}'},external:['xlsx','pdfjs-dist','tesseract.js'],plugins:[{name:'a1-test-backend',setup(b){
    // These checks paste CSV text; PDF/OCR browser readers are outside scope.
    b.onResolve({filter:/document-reader\.js$/},()=>({path:'a1-reader',namespace:'reader'}));
    b.onLoad({filter:/.*/,namespace:'reader'},()=>({contents:'export async function fileToText(file){return file.text();}'}));
    b.onResolve({filter:/backend\/index\.js$/},()=>({path:'a1-backend',namespace:'test'}));
    b.onLoad({filter:/.*/,namespace:'test'},()=>({contents:'export const backend={records:{query:(...a)=>globalThis.__a1Backend.records.query(...a)},documents:{upload:(...a)=>globalThis.__a1Backend.documents.upload(...a)},pricing:{applyQuote:(...a)=>globalThis.__a1Backend.pricing.applyQuote(...a)},catalog:{saveRow:(...a)=>globalThis.__a1Backend.catalog.saveRow(...a)}};'}));
  }}]});
  process.stdout.write(execFileSync(process.execPath,[outfile],{encoding:'utf8',timeout:15000}));
}finally{rmSync(dir,{recursive:true,force:true});}
