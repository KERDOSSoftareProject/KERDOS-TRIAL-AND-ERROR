import fs from 'node:fs';
import {randomUUID} from 'node:crypto';
export const retryMigration=new URL('../../supabase/migrations/20261102133527_price_quote_retry_guard.sql',import.meta.url);
// Isolated synthetic database only: shared by embedded SQL and separate-session tests.
export async function priceQuoteFixture(db,{upgrade=true}={}){
 const org=randomUUID(),owner=randomUUID(),manager=randomUUID(),employee=randomUUID(),outsider=randomUUID(),vendor=randomUUID();
 await db.exec(`create schema auth;do $$begin if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;end$$;
 create function auth.uid() returns uuid language sql as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 create table organization_members(organization_id uuid,user_id uuid,role text);
 create table vendors(id uuid primary key,organization_id uuid);
 create table import_documents(id uuid primary key default gen_random_uuid(),organization_id uuid,vendor_id uuid);
 create table vendor_items(id uuid primary key default gen_random_uuid(),organization_id uuid,vendor_id uuid,vendor_item_code text,description text,brand text,pack_size text,price numeric,last_updated timestamptz,price_source text,price_unavailable boolean,price_expired_at timestamptz,price_quote_valid_until date,selling_unit text,price_basis text,gtin text,manufacturer_code text,import_row jsonb,field_resolutions jsonb,row_revision bigint default 0);
 create table price_history(id uuid primary key default gen_random_uuid(),vendor_item_id uuid references vendor_items(id),organization_id uuid,price numeric,source text,effective_date timestamptz,quote_valid_until date,source_file_path text,source_file_name text,source_description text,source_line text,source_document_id uuid references import_documents(id),selling_unit text,price_basis text);
 grant usage on schema auth,public to authenticated,anon;
 grant select on organization_members,vendors to authenticated;
 grant select,insert,update on import_documents,vendor_items,price_history to authenticated;
 alter table import_documents enable row level security;alter table vendor_items enable row level security;alter table price_history enable row level security;`);
 for(const table of ['import_documents','vendor_items','price_history'])await db.exec(`create policy member_rows on ${table} for all to authenticated using(exists(select 1 from organization_members m where m.organization_id=${table}.organization_id and m.user_id=auth.uid())) with check(exists(select 1 from organization_members m where m.organization_id=${table}.organization_id and m.user_id=auth.uid()));`);
 await db.query('insert into organization_members values($1,$2,\'owner\'),($1,$3,\'manager\'),($1,$4,\'employee\')',[org,owner,manager,employee]);
 await db.query('insert into vendors values($1,$2)',[vendor,org]);
 const original=fs.readFileSync(new URL('../../knowledge/migration_015_recoverable_imports.sql',import.meta.url),'utf8');
 await db.exec(original.slice(0,original.indexOf('create or replace function public.kerdos_save_catalog_row(')));
 if(upgrade){const sql=fs.readFileSync(retryMigration,'utf8');await db.exec(sql);await db.exec(sql);}
 async function document(){return (await db.query('insert into import_documents(organization_id,vendor_id) values($1,$2) returning id',[org,vendor])).rows[0].id;}
 function quote(doc,{item=null,price=41.25,key='row:0',line='TEST-1,Example product,2/10 LB,CS,41.25',description='Example product',unavailable=false}={}){
  const args=[item,org,vendor,'TEST-1',description,'2/10 LB',price,unavailable,'2026-11-02T12:00:00Z',null,null,'Synthetic.csv',line,doc,'CS','case',null,null,JSON.stringify({rowKey:key,sourceDocumentId:doc,row:{price},reviewRequired:unavailable}),null,'Example'];
  return {sql:`select kerdos_apply_price_quote(${args.map((_,i)=>'$'+(i+1)).join(',')}) as value`,args};
 }
 async function actor(c,user){await c.query('reset role');await c.query("select set_config('request.jwt.claim.sub',$1,false)",[user]);await c.query('set role authenticated');}
 const call=async(c,command)=>(await c.query(command.sql,command.args)).rows[0].value;
 return {org,owner,manager,employee,outsider,vendor,document,quote,actor,call};
}
