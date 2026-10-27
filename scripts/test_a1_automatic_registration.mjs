import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
const db=new PGlite();
const org='10000000-0000-0000-0000-000000000001',other='10000000-0000-0000-0000-000000000002',user='10000000-0000-0000-0000-000000000003';
const vendor='20000000-0000-0000-0000-000000000001',second='20000000-0000-0000-0000-000000000002',foreign='20000000-0000-0000-0000-000000000003';
let passed=0;async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
const all=async()=> (await db.query('SELECT * FROM public.email_routing_addresses ORDER BY routing_address')).rows;
try{
 await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role BYPASSRLS;
 CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth TO authenticated;GRANT EXECUTE ON FUNCTION auth.uid() TO authenticated;
 CREATE TABLE public.organizations(id uuid PRIMARY KEY,name text NOT NULL,slug text);
 CREATE TABLE public.organization_members(organization_id uuid,user_id uuid,role text);
 CREATE TABLE public.vendors(id uuid PRIMARY KEY,organization_id uuid REFERENCES organizations(id),name text,is_active boolean DEFAULT true,UNIQUE(organization_id,id));
 CREATE TABLE public.email_routing_addresses(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid REFERENCES organizations(id) ON DELETE CASCADE,vendor_id uuid,
 document_type text,routing_address text UNIQUE,label text,is_active boolean DEFAULT true,created_at timestamptz DEFAULT now(),
 FOREIGN KEY(organization_id,vendor_id) REFERENCES vendors(organization_id,id) ON DELETE SET NULL(vendor_id));
 ALTER TABLE public.vendors ENABLE ROW LEVEL SECURITY;
 CREATE POLICY vendor_owner ON public.vendors TO authenticated USING(organization_id IN(SELECT organization_id FROM organization_members WHERE user_id=auth.uid())) WITH CHECK(organization_id IN(SELECT organization_id FROM organization_members WHERE user_id=auth.uid()));
 ALTER TABLE public.email_routing_addresses ENABLE ROW LEVEL SECURITY;
 CREATE POLICY route_reader ON public.email_routing_addresses FOR SELECT TO authenticated USING(organization_id IN(SELECT organization_id FROM organization_members WHERE user_id=auth.uid()));
 GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;
 GRANT SELECT ON public.organizations,public.organization_members TO authenticated;
 GRANT SELECT,INSERT,UPDATE,DELETE ON public.vendors,public.email_routing_addresses TO authenticated;
 INSERT INTO organizations VALUES('${org}','Hornets Nest','hornetsnest'),('${other}','Hornets Nest','hornetsnest');
 INSERT INTO organization_members VALUES('${org}','${user}','owner');
 `);
 const sql=fs.readFileSync(new URL('../supabase/migrations/20261027215318_a1_automatic_receiving_registration.sql',import.meta.url),'utf8');
 await db.exec(sql);
 await check('vendor before domain configuration creates no fictitious receiver',async()=>{
  await db.query('INSERT INTO vendors VALUES($1,$2,$3,true)',[vendor,org,'Minore’s']);assert.equal((await all()).length,0);
 });
 await check('unverified operator domains do not become advertised receivers',async()=>{
  await db.exec("INSERT INTO kerdos_private.receiving_domains VALUES(true,'prices.example.us','invoices.example.com',false)");assert.equal((await all()).length,0);
 });
 let original;
 await check('activating configured domains automatically backfills both registrations',async()=>{
  await db.exec('UPDATE kerdos_private.receiving_domains SET delivery_ready=true');original=await all();assert.equal(original.length,2);
  assert.deepEqual(original.map(r=>r.routing_address),['hornetsnest.minores@invoices.example.com','hornetsnest.minores@prices.example.us']);
  assert.ok(original.every(r=>r.organization_id===org&&r.vendor_id===vendor&&r.is_automatic&&r.is_active));
  assert.equal(original.find(r=>r.document_type==='invoice').routing_address,'hornetsnest.minores@invoices.example.com');
 });
 await check('a normal authenticated vendor insertion provisions both types without UI or routing writes',async()=>{
  await db.exec(`SELECT set_config('request.jwt.claim.sub','${user}',false);SET ROLE authenticated;`);
  await db.query('INSERT INTO vendors VALUES($1,$2,$3,true)',[second,org,'City Line']);
  const own=(await db.query('SELECT * FROM email_routing_addresses WHERE vendor_id=$1',[second])).rows;
  assert.equal(own.length,2);assert.deepEqual(own.map(r=>r.document_type).sort(),['invoice','pricelist']);
  await db.exec('RESET ROLE');
 });
 await check('clients cannot create, edit, deactivate or reassign receiving registrations',async()=>{
  await db.exec('SET ROLE authenticated');
  await assert.rejects(db.query("INSERT INTO email_routing_addresses(organization_id,vendor_id,document_type,routing_address) VALUES($1,$2,'invoice','manual@example.com')",[org,vendor]),/permission denied/);
  await assert.rejects(db.query("UPDATE email_routing_addresses SET document_type='invoice' WHERE vendor_id=$1",[vendor]),/permission denied/);
  await assert.rejects(db.query('DELETE FROM email_routing_addresses WHERE vendor_id=$1',[vendor]),/permission denied/);
  await assert.rejects(db.query('SELECT * FROM kerdos_private.receiving_domains'),/permission denied/);
  await assert.rejects(db.query('SELECT kerdos_private.provision_vendor_receivers($1)',[vendor]),/permission denied/);
  await db.exec('RESET ROLE');
 });
 await check('same client/vendor names in another organization cannot take the first registration',async()=>{
  await db.query('INSERT INTO vendors VALUES($1,$2,$3,true)',[foreign,other,'Minore’s']);
  const rows=await all();assert.equal(rows.length,6);assert.equal(new Set(rows.map(r=>r.routing_address)).size,6);
  for(const old of original)assert.deepEqual(rows.find(r=>r.id===old.id),old);
  await db.exec('SET ROLE authenticated');assert.equal((await db.query('SELECT * FROM email_routing_addresses')).rows.length,4);await db.exec('RESET ROLE');
 });
 await check('repeated provisioning and vendor rename preserve registered identities',async()=>{
  await db.query("UPDATE vendors SET name='Minore Updated' WHERE id=$1",[vendor]);
  await db.query('SELECT kerdos_private.provision_vendor_receivers($1)',[vendor]);
  assert.deepEqual((await all()).filter(r=>r.vendor_id===vendor),original);
 });
 await check('deactivation stops both receivers; reactivation restores the same addresses',async()=>{
  await db.query('UPDATE vendors SET is_active=false WHERE id=$1',[vendor]);assert.ok((await all()).filter(r=>r.vendor_id===vendor).every(r=>!r.is_active));
  await db.query('UPDATE vendors SET is_active=true WHERE id=$1',[vendor]);assert.deepEqual((await all()).filter(r=>r.vendor_id===vendor),original);
 });
 await check('domain changes retire previous registrations and create the new pair without reassignment',async()=>{
  await db.exec("UPDATE kerdos_private.receiving_domains SET price_sheet_domain='prices.example.whatever',invoice_domain='invoices.example.us'");
  const rows=await all();assert.ok(rows.filter(r=>r.vendor_id===vendor&&r.is_active).every(r=>r.routing_address.endsWith('@prices.example.whatever')||r.routing_address.endsWith('@invoices.example.us')));
  assert.ok(original.every(old=>rows.find(r=>r.id===old.id).is_active===false));
 });
 await check('disabling delivery retires active receivers instead of advertising unavailable mailboxes',async()=>{
  await db.exec('UPDATE kerdos_private.receiving_domains SET delivery_ready=false');assert.ok((await all()).every(r=>!r.is_active));
 });
 await check('identical type domains are rejected; no company/domain extension is hardcoded',async()=>{
  await assert.rejects(db.exec("UPDATE kerdos_private.receiving_domains SET invoice_domain=price_sheet_domain"),/check constraint/);
  assert.ok(!sql.includes('kerdospricesheets.com'));assert.ok(!sql.includes('inbound.kerdos.com'));
 });
 await check('untrusted cross-organization vendor insertion is rejected before provisioning',async()=>{
  const count=(await all()).length;await db.exec('SET ROLE authenticated');
  await assert.rejects(db.query('INSERT INTO vendors VALUES(gen_random_uuid(),$1,$2,true)',[other,'Bad route']),/row-level security/);await db.exec('RESET ROLE');assert.equal((await all()).length,count);
 });
}finally{await db.close();}
console.log(`${passed}/${passed} automatic registration PostgreSQL checks passed`);
