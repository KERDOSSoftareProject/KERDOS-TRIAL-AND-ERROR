import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
try{
 await db.exec(`CREATE ROLE authenticated;CREATE ROLE anon;CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS text LANGUAGE sql STABLE AS $$SELECT current_setting('request.jwt.claim.sub',true)$$;
 GRANT USAGE ON SCHEMA auth TO authenticated,anon;
 CREATE TABLE public.organization_members(organization_id text,user_id text,role text);
 CREATE TABLE public.vendors(id text PRIMARY KEY,organization_id text NOT NULL,UNIQUE(organization_id,id));
 CREATE TABLE public.import_documents(id int PRIMARY KEY,organization_id text NOT NULL,vendor_id text REFERENCES vendors(id));
 GRANT SELECT ON organization_members,vendors TO authenticated;
 GRANT SELECT,INSERT,UPDATE,DELETE ON import_documents TO authenticated;
 ALTER TABLE import_documents ENABLE ROW LEVEL SECURITY;
 CREATE POLICY "import_documents: members access" ON import_documents FOR ALL TO authenticated
 USING (EXISTS(SELECT FROM organization_members m WHERE m.organization_id=import_documents.organization_id AND m.user_id=auth.uid()));
 CREATE POLICY "import_documents: members read" ON import_documents FOR SELECT TO authenticated
 USING (EXISTS(SELECT FROM organization_members m WHERE m.organization_id=import_documents.organization_id AND m.user_id=auth.uid()));
 CREATE POLICY "import_documents: managers insert" ON import_documents FOR INSERT TO authenticated
 WITH CHECK(EXISTS(SELECT FROM organization_members m WHERE m.organization_id=import_documents.organization_id AND m.user_id=auth.uid() AND m.role IN('owner','manager')));
 CREATE POLICY "import_documents: managers update" ON import_documents FOR UPDATE TO authenticated
 USING(EXISTS(SELECT FROM organization_members m WHERE m.organization_id=import_documents.organization_id AND m.user_id=auth.uid() AND m.role IN('owner','manager')))
 WITH CHECK(EXISTS(SELECT FROM organization_members m WHERE m.organization_id=import_documents.organization_id AND m.user_id=auth.uid() AND m.role IN('owner','manager')));
 INSERT INTO organization_members VALUES('a','owner','owner'),('a','manager','manager'),('a','employee','employee'),('b','other','owner');
 INSERT INTO vendors VALUES('v-a','a'),('v-b','b');
 INSERT INTO import_documents VALUES(1,'a','v-a'),(2,'b','v-b');`);
 await db.exec(readFileSync('knowledge/a2_import_access_draft.sql','utf8'));
 async function asUser(user,fn){await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('SET ROLE authenticated');try{return await fn();}finally{await db.exec('RESET ROLE');}}
 await asUser('employee',async()=>{
  assert.deepEqual((await db.query('SELECT id FROM import_documents')).rows,[{id:1}]);
  await assert.rejects(db.query("INSERT INTO import_documents VALUES(3,'a','v-a')"),/row-level security/);
  assert.equal((await db.query('UPDATE import_documents SET id=4 WHERE id=1 RETURNING id')).rows.length,0);
  assert.equal((await db.query('DELETE FROM import_documents WHERE id=1 RETURNING id')).rows.length,0);
 });
 for(const user of ['owner','manager'])await asUser(user,async()=>{
  await db.query("INSERT INTO import_documents VALUES(3,'a','v-a')");
  await db.query('UPDATE import_documents SET id=4 WHERE id=3');
  await assert.rejects(db.query("INSERT INTO import_documents VALUES(5,'b','v-b')"),/row-level security/);
  await assert.rejects(db.query("INSERT INTO import_documents VALUES(6,'a','v-b')"),/foreign key/);
  await assert.rejects(db.query("UPDATE import_documents SET vendor_id='v-b' WHERE id=4"),/foreign key/);
  assert.equal((await db.query('SELECT id FROM import_documents WHERE id=2')).rows.length,0);
  await db.exec('RESET ROLE');await db.query('DELETE FROM import_documents WHERE id=4');await db.exec('SET ROLE authenticated');
 });
 await db.exec('SET ROLE anon');try{await assert.rejects(db.query('SELECT * FROM import_documents'),/permission denied/);}finally{await db.exec('RESET ROLE');}
 console.log('PASS actual access migration: employees read only; owner/manager writes remain scoped; cross-client vendor FK enforced; anonymous denied');
}finally{await db.close();}
