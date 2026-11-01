import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {retrieveVendorExport,PullError,safePullReason} from '../supabase/functions/vendor-price-pull/adapter.mjs';
import {createVendorConnectService,VendorConnectUnavailable} from '../src/services/vendor-connect.js';
import {createRecords} from '../src/backend/records.js';
import {BackendError} from '../src/backend/contract.js';
const db=new PGlite();let count=0;
async function check(name,fn){await fn();count++;console.log('PASS '+name);}
const org='10000000-0000-0000-0000-000000000001',other='10000000-0000-0000-0000-000000000002';
const vendor='20000000-0000-0000-0000-000000000001',otherVendor='20000000-0000-0000-0000-000000000002';
const owner='30000000-0000-0000-0000-000000000001',employee='30000000-0000-0000-0000-000000000002',outsider='30000000-0000-0000-0000-000000000003';
async function asUser(user,fn){await db.query("SELECT set_config('request.jwt.claim.sub',$1,false)",[user]);await db.exec('SET ROLE authenticated');try{return await fn();}finally{await db.exec('RESET ROLE');}}
try{
 await db.exec(`CREATE ROLE authenticated; CREATE ROLE anon; CREATE SCHEMA auth;
 CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql STABLE AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 GRANT USAGE ON SCHEMA auth TO authenticated,anon;
 CREATE TABLE organizations(id uuid PRIMARY KEY);
 CREATE TABLE vendors(id uuid PRIMARY KEY,organization_id uuid REFERENCES organizations(id),is_active boolean DEFAULT true,UNIQUE(organization_id,id));
 CREATE TABLE organization_members(organization_id uuid,user_id uuid,role text);
 GRANT SELECT ON vendors,organization_members TO authenticated;
 INSERT INTO organizations VALUES('${org}'),('${other}');
 INSERT INTO vendors VALUES('${vendor}','${org}',true),('${otherVendor}','${other}',true);
 INSERT INTO organization_members VALUES('${org}','${owner}','owner'),('${org}','${employee}','employee'),('${other}','${outsider}','manager');`);
 await db.exec(readFileSync('knowledge/a2_vendor_connect_draft.sql','utf8'));
 let request;
 await check('owner creates idempotent pending setup without a credential or operational source',async()=>{
   request=await asUser(owner,async()=>{
    const args=[org,vendor,'us-foods-moxe'];const q='SELECT kerdos_request_vendor_connection($1,$2,$3) id';
    const id=(await db.query(q,args)).rows[0].id;
    assert.equal((await db.query(q,args)).rows[0].id,id);
    const rows=(await db.query('SELECT * FROM vendor_connection_requests')).rows;
    assert.equal(rows.length,1);assert.equal(rows[0].state,'setup_requested');
    assert.ok(!JSON.stringify(rows).includes('credential'));return id;
   });
 });
 await check('cross-client reads, enrollment and cancellation are denied at the database boundary',async()=>{
  await asUser(outsider,async()=>{
   assert.equal((await db.query('SELECT * FROM vendor_connection_requests')).rows.length,0);
   assert.equal((await db.query("UPDATE vendor_connection_requests SET state='cancelled' WHERE id=$1 RETURNING id",[request])).rows.length,0);
   await assert.rejects(db.query('SELECT kerdos_request_vendor_connection($1,$2,$3)',[org,vendor,'us-foods-moxe']),/row-level security/);
  });
  await asUser(owner,()=>assert.rejects(db.query('SELECT kerdos_request_vendor_connection($1,$2,$3)',[org,otherVendor,'us-foods-moxe']),/row-level security|foreign key/));
 });
 await check('employee and anonymous cannot enroll, read private client requests or promote state',async()=>{
  await asUser(employee,async()=>{assert.equal((await db.query('SELECT * FROM vendor_connection_requests')).rows.length,0);await assert.rejects(db.query('SELECT kerdos_request_vendor_connection($1,$2,$3)',[org,vendor,'https-export']),/row-level security/);});
  await db.exec('SET ROLE anon');try{await assert.rejects(db.query('SELECT kerdos_request_vendor_connection($1,$2,$3)',[org,vendor,'us-foods-moxe']),/permission denied/);}finally{await db.exec('RESET ROLE');}
  await asUser(owner,async()=>{
   await assert.rejects(db.query("UPDATE vendor_connection_requests SET state='connected' WHERE id=$1",[request]),/check constraint|row-level security/);
   await assert.rejects(db.query('UPDATE vendor_connection_requests SET organization_id=$1 WHERE id=$2',[other,request]),/permission denied/);
   await assert.rejects(db.query("UPDATE vendor_connection_adapters SET execution_model='server_export'"),/permission denied/);
  });
 });
 await check('pending setup can be cancelled and requested again without a duplicate or fake connection',async()=>{
  await asUser(owner,async()=>{
   await db.query("UPDATE vendor_connection_requests SET state='cancelled' WHERE id=$1",[request]);
   assert.equal((await db.query('SELECT kerdos_request_vendor_connection($1,$2,$3) id',[org,vendor,'us-foods-moxe'])).rows[0].id,request);
   assert.equal((await db.query('SELECT state FROM vendor_connection_requests WHERE id=$1',[request])).rows[0].state,'setup_requested');
  });
 });
 await check('inactive vendors and unavailable adapters cannot start or restart setup',async()=>{
  await db.query('UPDATE vendors SET is_active=false WHERE id=$1',[vendor]);
  await asUser(owner,async()=>{await db.query("UPDATE vendor_connection_requests SET state='cancelled' WHERE id=$1",[request]);await assert.rejects(db.query('SELECT kerdos_request_vendor_connection($1,$2,$3)',[org,vendor,'us-foods-moxe']),/row-level security/);});
  await db.query('UPDATE vendors SET is_active=true WHERE id=$1',[vendor]);
  await db.exec("UPDATE vendor_connection_adapters SET setup_available=false WHERE adapter_key='us-foods-moxe'");
  await asUser(owner,()=>assert.rejects(db.query('SELECT kerdos_request_vendor_connection($1,$2,$3)',[org,vendor,'us-foods-moxe']),/row-level security/));
 });
 await check('legacy export dispatch unchanged; unsupported portals never call HTTP or ingestion',async()=>{
  const bytes=new TextEncoder().encode('Code,Price\nA,12');let calls=0;
  const options={httpsExport:async()=>{calls++;return {bytes,contentType:'text/csv'};}};
  assert.equal((await retrieveVendorExport({file_name:'prices.csv'},options)).bytes,bytes);
  for(const source of [{retrieval_kind:'unexpected'},{retrieval_kind:'portal_session',adapter_key:'moxe'}])await assert.rejects(retrieveVendorExport(source,options),/unsupported_adapter/);
  assert.equal(calls,1);
  await assert.rejects(retrieveVendorExport({retrieval_kind:'portal_session',adapter_key:'local'}, {...options,portalAdapters:new Map([['local',{executionModel:'local',retrieve(){assert.fail('local browser cannot run in Edge');}}]])}),/execution_unavailable/);
 });
 await check('trusted adapters preserve verification errors and validate retrieved bytes before ingestion',async()=>{
  assert.equal(safePullReason(new PullError('secret-from-unreviewed-adapter')),'pull_failed');
  const source={retrieval_kind:'portal_session',adapter_key:'test',file_name:'prices.csv'};
  const withResult=retrieve=>({httpsExport:()=>assert.fail(),portalAdapters:new Map([['test',{executionModel:'server',retrieve}]])});
  await assert.rejects(retrieveVendorExport(source,withResult(async()=>{throw new PullError('verification_needed');})),/verification_needed/);
  for(const [result,reason] of [[{bytes:new Uint8Array(),contentType:'text/csv'},'empty_export'],[{bytes:new TextEncoder().encode('<html><form>login'),contentType:'text/csv'},'portal_login_page'],[{bytes:new Uint8Array(5242881),contentType:'text/csv'},'export_too_large'],[{bytes:new Uint8Array([1]),contentType:'text/html'},'unsupported_export']])await assert.rejects(retrieveVendorExport(source,withResult(async()=>result)),new RegExp(reason));
 });
 await check('service scopes reads/cancellation to the selected client and passes only enrollment identifiers',async()=>{
  const calls=[];const backend={records:createRecords(async spec=>{calls.push(spec);return {data:spec.action==='update'?[{id:'r'}]:[],error:null};}),vendorConnect:{request:async args=>{calls.push(args);return 'r';}}};
  const service=createVendorConnectService(backend);await service.list(org);assert.deepEqual(calls[1].filters,[{operator:'eq',column:'organization_id',value:org}]);
  await service.request({organizationId:org,vendorId:vendor,adapterKey:'test',credential:'must-not-forward'});assert.deepEqual(calls.at(-1),{organizationId:org,vendorId:vendor,adapterKey:'test'});
  await service.cancel({organizationId:org,requestId:'r'});assert.equal(calls.at(-1).filters[0].value,org);
  await assert.rejects(createVendorConnectService({...backend,vendorConnect:{request:async()=>{throw new BackendError('rpc',{code:'PGRST202',message:'unavailable'});}}}).request({organizationId:org,vendorId:vendor,adapterKey:'test'}),VendorConnectUnavailable);
 });
 console.log(`${count}/${count} Vendor Connect local SQL/adapter/service checks passed. No live database, browser login or vendor retrieval is implied.`);
}finally{await db.close();}
