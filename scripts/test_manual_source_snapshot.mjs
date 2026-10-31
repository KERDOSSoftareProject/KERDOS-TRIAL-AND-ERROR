import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createSourceRowSnapshot,verifyResumeRows} from '../src/core/import-resume.js';
const rows=[{code:null,description:'Chicken Breast',price:40,packSize:'20 LB',sourceLine:'Chicken Breast 20 LB 40.00'},
 {code:null,description:'Chicken Breast',price:42,packSize:'20 LB',sourceLine:'Chicken Breast 20 LB 42.00'},
 {code:'NEW-1',description:'Turkey Breast',price:50,sourceProvenance:{page:2,table:1,lines:[2]}}];
let passed=0;async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
const snapshot=createSourceRowSnapshot(rows),latestOnly=[{key:'row:1',sourceLine:rows[1].sourceLine}];
await check('duplicate listing overwrite does not erase independent source-row proof',()=>{verifyResumeRows(rows,['row:0','row:1'],latestOnly,snapshot);});
await check('source rows without a freeform sourceLine remain verifiable through full retained values/position',()=>{verifyResumeRows(rows,['row:2'],[{key:'row:2'}],snapshot);});
await check('legacy imports still reject missing or shifted evidence',()=>{assert.throws(()=>verifyResumeRows(rows,['row:0','row:1'],latestOnly),/no matching/);assert.throws(()=>verifyResumeRows([rows[1],rows[0],rows[2]],['row:1'],latestOnly),/positions/);});
await check('price, identity, pack, position and ordinal changes all block resume',()=>{
 for(const patch of [{price:41},{description:'Beef Tenderloin'},{packSize:'10 LB'},{sourceProvenance:{page:3}}]){const changed=structuredClone(rows);changed[0]={...changed[0],...patch};assert.throws(()=>verifyResumeRows(changed,['row:0'],latestOnly,snapshot),/positions or values/);}
 assert.throws(()=>verifyResumeRows([rows[1],rows[0],rows[2]],['row:0'],[],snapshot),/positions or values/);
});
await check('malformed versions, lengths and unsupported row keys fail closed',()=>{
 for(const value of [{version:2,rows:snapshot.rows},{version:1,rows:[]},{}])assert.throws(()=>verifyResumeRows(rows,['row:0'],[],value),/snapshot/);
 assert.throws(()=>verifyResumeRows(rows,['held:row:0'],[],snapshot),/positions or values/);
 assert.throws(()=>verifyResumeRows(rows,['row:0'],[{key:'row:0',sourceLine:'Different stored product 99.00'}],snapshot),/Saved source evidence differs/);
});
const db=new PGlite();try{
 await db.exec('CREATE TABLE public.import_documents(id text PRIMARY KEY,status text,completed_keys jsonb);');
 await db.exec(readFileSync('supabase/migrations/20261031142154_manual_import_source_snapshot.sql','utf8'));
 await check('actual SQL permits legacy records and preserves their existing status/keys',async()=>{await db.exec("INSERT INTO import_documents VALUES('legacy','processing','[\"row:0\"]',NULL)");const {rows:[record]}=await db.query("SELECT status,completed_keys,source_rows FROM import_documents WHERE id='legacy'");assert.equal(record.status,'processing');assert.deepEqual(record.completed_keys,['row:0']);assert.equal(record.source_rows,null);});
 await check('actual SQL stores the proof once and permits normal progress/finalization',async()=>{await db.query("UPDATE import_documents SET source_rows=$1::jsonb WHERE id='legacy'",[JSON.stringify(snapshot)]);await db.exec("UPDATE import_documents SET status='complete',completed_keys='[\"row:0\",\"row:1\"]' WHERE id='legacy'");assert.deepEqual((await db.query("SELECT source_rows FROM import_documents WHERE id='legacy'")).rows[0].source_rows,snapshot);});
 await check('actual SQL rejects replacing or clearing retained proof',async()=>{await assert.rejects(db.query("UPDATE import_documents SET source_rows=NULL WHERE id='legacy'"),/immutable/);await assert.rejects(db.query("UPDATE import_documents SET source_rows=$1::jsonb WHERE id='legacy'",[JSON.stringify({...snapshot,rows:[]})]),/immutable/);});
 await check('actual SQL rejects malformed initial proof',async()=>{for(const value of [{},[],{version:2,rows:[]},{version:1,rows:{}}])await assert.rejects(db.query("INSERT INTO import_documents(id,source_rows) VALUES('bad',$1::jsonb)",[JSON.stringify(value)]),/source_rows_format/);});
 await check('source proof respects existing row security and does not expose a privileged RPC',async()=>{
  await db.exec("CREATE ROLE snapshot_reader; GRANT USAGE ON SCHEMA public TO snapshot_reader; GRANT SELECT ON import_documents TO snapshot_reader; ALTER TABLE import_documents ENABLE ROW LEVEL SECURITY; CREATE POLICY snapshot_reader_scope ON import_documents FOR SELECT TO snapshot_reader USING(id='legacy'); INSERT INTO import_documents(id) VALUES('other');");
  const fn=(await db.query("SELECT prosecdef,has_function_privilege('snapshot_reader','public.kerdos_preserve_import_source_rows()','EXECUTE') allowed FROM pg_proc WHERE oid='public.kerdos_preserve_import_source_rows()'::regprocedure")).rows[0];assert.equal(fn.prosecdef,false);assert.equal(fn.allowed,false);
  await db.exec('SET ROLE snapshot_reader');try{const selected=(await db.query('SELECT id,source_rows FROM import_documents')).rows;assert.equal(selected.length,1);assert.equal(selected[0].id,'legacy');assert.deepEqual(selected[0].source_rows,snapshot);}finally{await db.exec('RESET ROLE');}
 });
}finally{await db.close();}
console.log(`${passed}/10 manual source snapshot checks passed (local actual SQL; not applied/deployed).`);
