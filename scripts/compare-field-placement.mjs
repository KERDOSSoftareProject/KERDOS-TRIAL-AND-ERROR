// Read-only replay of retained post-extraction text. No backend imports or writes.
// Usage: node scripts/compare-field-placement.mjs /absolute/path/documents.json
import fs from 'node:fs';
import {execFileSync} from 'node:child_process';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {performance} from 'node:perf_hooks';
import {parseDocument as proposed} from '../src/ingestion.js';
import {configureVocabulary} from '../src/procurement.js';
import {configureCategoryProfile} from '../src/knowledge/category-profiles.js';

const root=fileURLToPath(new URL('../',import.meta.url));
const baseline='753b60ccabe98931a4d7492b5483002a5b815f35';
const input=process.argv[2];
if(!input)throw Error('Supply a JSON array of retained documents with id, file_name and original_text.');
const documents=JSON.parse(fs.readFileSync(input,'utf8'));
configureCategoryProfile('Restaurant');
const vocabulary=['vocabulary_v1.sql','restaurant_food_dictionary_v1.sql'].map(name=>fs.readFileSync(root+'knowledge/'+name,'utf8')).join('\n');
configureVocabulary([...vocabulary.matchAll(/\('Restaurant','(synonym|unit|packaging)','([^']+)'(?:,'([^']+)')?/g)].map(m=>({kind:m[1],term:m[2],canonical:m[3]})));
const temporary=root+'src/.field-replay-baseline-'+process.pid+'.mjs';
let current;
try{
 fs.writeFileSync(temporary,execFileSync('git',['show',baseline+':src/ingestion.js'],{cwd:root}),{flag:'wx'});
 current=(await import(pathToFileURL(temporary).href)).parseDocument;
}finally{if(fs.existsSync(temporary))fs.unlinkSync(temporary);}
const fields=['description','code','brand','packSize','sellingUnit','price'];
const present=v=>v!==null&&v!==undefined&&String(v).trim()!=='';
const normalize=v=>present(v)?String(v):null;
const totals=Object.fromEntries(fields.map(f=>[f,{beforeFilled:0,afterFilled:0,gained:0,lost:0,changed:0}]));
const results=[],differences=[],failures=[];
const counts={beforeRows:0,afterRows:0,matchedRows:0,addedRows:0,removedRows:0,rowsWithPlacementEvidence:0,rowsWithoutPlacementEvidence:0};
const anchors={};
for(const doc of documents){
 if(!doc.original_text){results.push({id:doc.id,file:doc.file_name,excluded:'No retained original text'});continue;}
 let before,after;
 try{before=current(doc.original_text);after=proposed(doc.original_text);}catch(e){failures.push({file:doc.file_name,error:e.message});continue;}
 const row={id:doc.id,file:doc.file_name,modeBefore:before.mode,modeAfter:after.mode,beforeRows:before.rows.length,afterRows:after.rows.length,changedRows:0};
 counts.beforeRows+=before.rows.length;counts.afterRows+=after.rows.length;
 for(const r of before.rows)for(const f of fields)if(present(r[f]))totals[f].beforeFilled++;
 for(const r of after.rows){
  for(const f of fields)if(present(r[f]))totals[f].afterFilled++;
  const status=r.fieldIdentification?.anchor?.status;
  if(status){counts.rowsWithPlacementEvidence++;anchors[status]=(anchors[status]||0)+1;}else counts.rowsWithoutPlacementEvidence++;
 }
 // Match source lines with queues. Where no line survives freeform parsing,
 // only an exactly identical full row is an acceptable fallback match.
 const keyFor=r=>r.sourceLine!=null?'source:'+r.sourceLine:'exact:'+JSON.stringify(r);
 const byLine=new Map();
 for(const r of before.rows){const k=keyFor(r);if(!byLine.has(k))byLine.set(k,[]);byLine.get(k).push(r);}
 let matched=0;
 for(const r of after.rows){
  const prior=byLine.get(keyFor(r))?.shift();
  if(!prior){counts.addedRows++;differences.push({file:doc.file_name,kind:'unmatched-after',sourceLine:r.sourceLine??null});continue;}
  matched++;counts.matchedRows++;
  const changes=[];
  for(const f of fields){
   if(normalize(prior[f])===normalize(r[f]))continue;
   const kind=!present(prior[f])?'gained':!present(r[f])?'lost':'changed';totals[f][kind]++;
   changes.push({field:f,kind,before:prior[f]??null,after:r[f]??null});
  }
  if(changes.length){row.changedRows++;differences.push({file:doc.file_name,sourceLine:r.sourceLine,changes});}
 }
 counts.removedRows+=before.rows.length-matched;
 results.push(row);
}
const usable=documents.filter(d=>d.original_text&&!failures.some(f=>f.file===d.file_name));
const timing=fn=>{const samples=[];for(let pass=0;pass<6;pass++){const start=performance.now();for(const d of usable)fn(d.original_text);const elapsed=performance.now()-start;if(pass)samples.push(elapsed);}return Number(samples.sort((a,b)=>a-b)[2].toFixed(2));};
const report={baseline,scope:'Retained post-extraction text, default parser settings and shared Restaurant vocabulary. No saved layout answers, client corrections, grouping, DB writes, or original binary extraction replay. Filled counts measure presence, not verified correctness. Unmatched rows are not necessarily newly discovered source products.',documents:documents.length,replayed:usable.length,excluded:documents.filter(d=>!d.original_text).map(d=>d.file_name),failures,counts,anchors,fields:totals,timingMsMedian:{before:timing(current),after:timing(proposed)},results,differences};
console.log(JSON.stringify(report,null,2));
if(failures.length)process.exitCode=1;
