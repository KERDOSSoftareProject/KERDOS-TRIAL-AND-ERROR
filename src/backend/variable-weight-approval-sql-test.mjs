import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import {prepareVariableWeightApproval} from '../core/variable-weight-purchasing.js';

const db=new PGlite();
const ids=Array.from({length:12},(_,i)=>`00000000-0000-0000-0000-${String(i+1).padStart(12,'0')}`);
const [org,owner,manager,employee,outsider,vendor,ci,vi,map,doc,otherOrg,otherVendor]=ids;
await db.exec(`create schema auth;create role authenticated;create role anon;
create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
create table organizations(id uuid primary key,settings jsonb not null default '{}');
create table organization_members(organization_id uuid,user_id uuid,role text);
create table vendors(id uuid primary key,organization_id uuid);
create table catalog_items(id uuid primary key,organization_id uuid);
create table vendor_items(id uuid primary key,organization_id uuid,vendor_id uuid,vendor_item_code text,description text,brand text,
 pack_size text,price numeric,selling_unit text,price_basis text,price_unavailable boolean,price_source text,price_expired_at timestamptz,
 price_quote_valid_until date,last_updated timestamptz,row_revision bigint not null default 0,import_row jsonb);
create table item_mappings(id uuid primary key,organization_id uuid,vendor_item_id uuid,catalog_item_id uuid,comparison_track text,confidence_score integer);
create table import_documents(id uuid primary key,organization_id uuid,vendor_id uuid,document_kind text,source_rows jsonb);
insert into organizations(id) values('${org}'),('${otherOrg}');
insert into organization_members values('${org}','${owner}','owner'),('${org}','${manager}','manager'),('${org}','${employee}','employee'),('${otherOrg}','${outsider}','owner');
insert into vendors values('${vendor}','${org}'),('${otherVendor}','${otherOrg}');insert into catalog_items values('${ci}','${org}');
grant usage on schema auth,public to authenticated,anon;grant execute on function auth.uid() to authenticated,anon;
grant select on organizations,organization_members,vendors,catalog_items,import_documents to authenticated;
grant select,update on vendor_items,item_mappings to authenticated;`);
const source={code:'TEST-1',description:'Synthetic variable material',brand:'Example',packSize:'2/6-8 LBA',price:4,sellingUnit:'LB',priceUnavailable:false,
  billingUnitEvidence:{kind:'pricing-unit-header',header:'Product UOM',unit:'LB'}};
const proof={key:'row:0',values:['TEST-1',source.description,source.brand,source.packSize,null,4,null,'LB',null,null,null,false],billingUnitEvidence:source.billingUnitEvidence};
const importRow={sourceDocumentId:doc,rowKey:'row:0',row:source,reviewRequired:true,reviewFields:['pack_size']};
await db.query('insert into import_documents values($1,$2,$3,$4,$5)',[doc,org,vendor,'pricelist',JSON.stringify({version:1,rows:[proof]})]);
await db.query('insert into vendor_items(id,organization_id,vendor_id,vendor_item_code,description,brand,pack_size,price,selling_unit,price_basis,price_unavailable,last_updated,import_row) values($1,$2,$3,$4,$5,$6,$7,4,\'LB\',\'measure\',true,$8,$9)',[vi,org,vendor,source.code,source.description,source.brand,source.packSize,'2026-11-01T15:20:30.216144Z',JSON.stringify(importRow)]);
await db.query('insert into item_mappings values($1,$2,$3,$4,$5,100)',[map,org,vi,ci,'exact']);
const sql=fs.readFileSync(new URL('../../supabase/migrations/20261101195350_variable_weight_approvals.sql',import.meta.url),'utf8');
await db.exec(sql);await db.exec(sql);
async function actor(user,role='authenticated'){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user||'']);await db.exec(`set role ${role}`);}
async function admin(query,args=[]){await db.exec('reset role');return db.query(query,args);}
const loadInput=async actorId=>{
 const listing=(await admin('select * from vendor_items where id=$1',[vi])).rows[0];
 const mapping=(await admin('select * from item_mappings where id=$1',[map])).rows[0];
 return {organizationId:org,vendorId:vendor,catalogItemId:ci,listing,mapping,actorId,confirmed:true,now:new Date().toISOString()};
};
const input=await loadInput(owner),intent=prepareVariableWeightApproval(input);
const confirm=(i=intent,revision=0,organization=org)=>db.query('select kerdos_approve_variable_weight($1,$2,$3,$4,$5::jsonb) as approval',[organization,vi,map,revision,JSON.stringify(i)]);
await actor(owner);
const terms=(await db.query('select kerdos_variable_weight_terms($1,$2,$3) as terms',[org,vi,map])).rows[0].terms;
assert.deepEqual(terms,intent.terms,'actual SQL reconstructs the same terms as the shared client core');
const saved=(await confirm()).rows[0].approval;
assert.equal(saved.approved_by,owner);assert.equal(saved.vendor_item_id,vi);
assert.equal((await confirm()).rows[0].approval.id,saved.id,'retry returns the same active approval');
await assert.rejects(confirm({...intent,terms:{...intent.terms,quotedRate:1}}),/terms changed/);
await assert.rejects(confirm({...intent,requestedBy:employee}),/terms changed/);
await assert.rejects(confirm(intent,1),/row changed/);
await assert.rejects(db.query('update variable_weight_approvals set terms=$1 where id=$2',[JSON.stringify({}),saved.id]),/permission denied/);
await assert.rejects(db.query('delete from variable_weight_approvals where id=$1',[saved.id]),/permission denied/);
await assert.rejects(db.query('insert into variable_weight_approvals(organization_id,vendor_id,vendor_item_id,mapping_id,catalog_item_id,terms,approved_by) values($1,$2,$3,$4,$5,$6,$7)',[org,vendor,vi,map,ci,JSON.stringify({...terms,quotedRate:1}),owner]),/row-level security/);
await actor(employee);
assert.equal((await db.query('select count(*) from variable_weight_approvals')).rows[0].count,1);
await assert.rejects(confirm({...intent,requestedBy:employee}),/manager permission/);
await assert.rejects(db.query('insert into variable_weight_approvals(organization_id,vendor_id,vendor_item_id,mapping_id,catalog_item_id,terms,approved_by) values($1,$2,$3,$4,$5,$6,$7)',[org,vendor,vi,map,ci,JSON.stringify(terms),employee]),/row-level security/);
await actor(outsider);
assert.equal((await db.query('select count(*) from variable_weight_approvals')).rows[0].count,0);
await assert.rejects(confirm({...intent,requestedBy:outsider}),/manager permission/);
await assert.rejects(db.query('select kerdos_revoke_variable_weight($1,$2)',[otherOrg,saved.id]),/outside/);
await actor(null,'anon');await assert.rejects(db.query('select * from variable_weight_approvals'),/permission denied/);
await assert.rejects(confirm(),/permission denied/);
await actor(manager);
const revoked=(await db.query('select kerdos_revoke_variable_weight($1,$2) as row',[org,saved.id])).rows[0].row;
assert.equal(revoked.revoked_by,manager);assert.ok(revoked.revoked_at);
assert.deepEqual(revoked.terms,terms,'revocation preserves the reviewed source snapshot');
assert.equal((await db.query('select kerdos_revoke_variable_weight($1,$2) as row',[org,saved.id])).rows[0].row.id,saved.id);
await assert.rejects(db.query('update variable_weight_approvals set revoked_at=null,revoked_by=null where id=$1',[saved.id]),/immutable/);
const managerIntent={...intent,requestedBy:manager};const second=(await confirm(managerIntent)).rows[0].approval;
assert.notEqual(second.id,saved.id);

// Source changes require fresh review, and old approved terms remain historical.
await admin("update vendor_items set row_revision=1,price=5 where id=$1",[vi]);
await actor(manager);await assert.rejects(confirm(managerIntent,1),/source rate/);
await admin('update import_documents set source_rows=$1 where id=$2',[JSON.stringify({version:1,rows:[{...proof,values:proof.values.map((v,i)=>i===5?5:v)}]}),doc]);
const updatedSource={...source,price:5};
await admin('update vendor_items set import_row=$1 where id=$2',[JSON.stringify({...importRow,row:updatedSource}),vi]);
const updated=prepareVariableWeightApproval(await loadInput(manager));
await actor(manager);
const third=(await confirm(updated,1)).rows[0].approval;
assert.notEqual(third.id,second.id);assert.equal(third.terms.quotedRate,5);
assert.ok((await db.query('select revoked_at from variable_weight_approvals where id=$1',[second.id])).rows[0].revoked_at);

await admin("update item_mappings set confidence_score=70 where id=$1",[map]);await actor(manager);
await assert.rejects(confirm(updated,1),/catalog association/);
await admin("update item_mappings set confidence_score=100 where id=$1",[map]);
await admin("update import_documents set vendor_id=$1 where id=$2",[otherVendor,doc]);await actor(manager);
await assert.rejects(confirm(updated,1),/quotation source/);
await admin('update import_documents set vendor_id=$1 where id=$2',[vendor,doc]);
// Existing catalog Apply may clear the pack review while retaining its source hold.
await admin("update vendor_items set import_row=jsonb_set(import_row,'{reviewRequired}','false') where id=$1",[vi]);
const appliedIntent=prepareVariableWeightApproval(await loadInput(manager));await actor(manager);
assert.equal((await confirm(appliedIntent,1)).rows[0].approval.id,third.id);
await admin("update vendor_items set import_row=jsonb_set(import_row,'{reviewRequired}','true') where id=$1",[vi]);
// Source-unavailable and forged billing declarations cannot be approved.
await admin("update import_documents set source_rows=jsonb_set(source_rows,'{rows,0,values,11}','true') where id=$1",[doc]);await actor(manager);
await assert.rejects(confirm(updated,1),/source rate/);
await admin("update import_documents set source_rows=jsonb_set(source_rows,'{rows,0,values,11}','false') where id=$1",[doc]);
await admin("update import_documents set source_rows=jsonb_set(source_rows,'{rows,0,billingUnitEvidence,header}','\"Invented\"') where id=$1",[doc]);await actor(manager);
await assert.rejects(confirm(updated,1),/provenance/);
await admin("update import_documents set source_rows=jsonb_set(source_rows,'{rows,0,billingUnitEvidence,header}','\"Product UOM\"') where id=$1",[doc]);
await admin("update vendor_items set price_expired_at=current_timestamp where id=$1",[vi]);await actor(manager);
await assert.rejects(confirm(updated,1),/current positive/);
const unchanged=(await admin('select price_unavailable,import_row from vendor_items where id=$1',[vi])).rows[0];
assert.equal(unchanged.price_unavailable,true);assert.equal(unchanged.import_row.reviewRequired,true,'confirmation never clears source review or activates a price');
await db.close();
console.log('PASS actual SQL approval reconstruction, idempotency, row revisions, immutable history, role/RLS boundaries, revocation, superseding terms, source ownership and unchanged quote/review state (local PGlite; hosted acceptance separate).');
