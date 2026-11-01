import {PGlite} from '@electric-sql/pglite';
import fs from 'node:fs';
export async function variableWeightFixture(){
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
const sql=fs.readFileSync(new URL('../../../supabase/migrations/20261101195350_variable_weight_approvals.sql',import.meta.url),'utf8');
await db.exec(sql);await db.exec(sql);
async function actor(user,role='authenticated'){await db.exec('reset role');await db.query("select set_config('request.jwt.claim.sub',$1,false)",[user||'']);await db.exec(`set role ${role}`);}
async function admin(query,args=[]){await db.exec('reset role');return db.query(query,args);}
const loadInput=async actorId=>{
 const listing=(await admin('select * from vendor_items where id=$1',[vi])).rows[0];
 const mapping=(await admin('select * from item_mappings where id=$1',[map])).rows[0];
 return {organizationId:org,vendorId:vendor,catalogItemId:ci,listing,mapping,actorId,confirmed:true,now:new Date().toISOString()};
};
return {db,ids,org,owner,manager,employee,outsider,vendor,ci,vi,map,doc,otherOrg,otherVendor,source,proof,importRow,actor,admin,loadInput};
}
