import {build} from 'esbuild';
import {execFileSync} from 'node:child_process';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
const dir=mkdtempSync(join(tmpdir(),'kerdos-retained-'));
const source=String.raw`
import React from 'react';import Renderer,{act} from 'react-test-renderer';import assert from 'node:assert/strict';
import {RetainedImportRows} from './src/pages/RetainedImportRows.jsx';import {createSourceRowSnapshot} from './src/core/import-resume.js';
const text=node=>typeof node==='string'?node:(node?.children||[]).map(text).join('');
const rows=[{description:'Cantaloupe size 12',price:31,sourceLine:'Cantaloupe size 12 31.00',sourceProvenance:{page:1,lines:[2]}},{description:'Cantaloupe size 12',price:29,sourceLine:'Cantaloupe size 12 29.00',sourceProvenance:{page:2,lines:[3]}}];
const document={id:'d',vendor_id:'v',document_kind:'pricelist',status:'partial',file_name:'retained.pdf',source_rows:createSourceRowSnapshot(rows),completed_keys:[]};
const vendors=[{id:'v',name:'Test vendor'}],calls=[];
const service={retainedPartialDocuments:async(org)=>{calls.push(org);return [document];}};
const props={orgId:'org',vendors,service};let tree;
await act(async()=>{tree=Renderer.create(React.createElement(RetainedImportRows,props));});
let html=text(tree.toJSON());assert.match(html,/2 not yet linked/);assert.match(html,/31.00/);assert.match(html,/29.00/);assert.match(html,/Unconfirmed/);assert.match(html,/not used for ordering/);assert.match(html,/retained.pdf/);assert.deepEqual(calls,['org']);assert.equal(tree.root.findAllByType('details').length,2);assert.equal(tree.root.findAllByType('button').length,0);
console.log('PASS retained observations appear without Save, Apply, confirmation or write calls');
await act(async()=>{tree.update(React.createElement(RetainedImportRows,{...props,search:'absent'}));});assert.equal(tree.toJSON(),null);assert.deepEqual(calls,['org']);
await act(async()=>{tree.update(React.createElement(RetainedImportRows,{...props,search:'Cantaloupe'}));});assert.match(text(tree.toJSON()),/2 not yet linked/);
console.log('PASS catalog search filters display without removing retained evidence or reloading');
const delayed={retainedPartialDocuments:()=>new Promise(()=>{})};await act(async()=>{tree.update(React.createElement(RetainedImportRows,{...props,orgId:'another-org',service:delayed}));});assert.equal(tree.toJSON(),null);tree.unmount();
console.log('PASS switching organization immediately hides previous organization rows');
await act(async()=>{tree=Renderer.create(React.createElement(RetainedImportRows,{...props,service:{retainedPartialDocuments:async()=>{throw Error('Permission denied');}}}));});assert.match(JSON.stringify(tree.toJSON()),/Permission denied/);assert.equal(tree.root.findAllByProps({role:'alert'}).length,1);tree.unmount();
console.log('PASS load failures remain visible rather than reporting an empty catalog');
console.log('4/4 rendered retained-row checks passed (mocked read boundary; no hosted writes).');
process.exit(0);
`;
try{
 const outfile=join(dir,'test.mjs');
 await build({stdin:{contents:source,resolveDir:process.cwd(),loader:'jsx'},outfile,bundle:true,platform:'node',format:'esm',jsx:'automatic'});
 process.stdout.write(execFileSync(process.execPath,[outfile],{encoding:'utf8',timeout:30000}));
}finally{rmSync(dir,{recursive:true,force:true});}
