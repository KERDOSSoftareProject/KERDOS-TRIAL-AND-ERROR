import {readFileSync} from 'node:fs';
import {randomUUID} from 'node:crypto';
export const scheduleMigration='supabase/migrations/20261106214348_vendor_schedule_claims.sql';
export async function vendorScheduleFixture(db){
 const [org,other,owner,manager,employee,outsider,vendor,otherVendor]=Array.from({length:8},()=>randomUUID());
 await db.exec(`do $$begin
  if not exists(select 1 from pg_roles where rolname='authenticated') then create role authenticated;end if;
  if not exists(select 1 from pg_roles where rolname='anon') then create role anon;end if;
  if not exists(select 1 from pg_roles where rolname='service_role') then create role service_role;end if;
 end$$;
 create schema auth;
 create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated,anon;
 create table organizations(id uuid primary key);
 create table vendors(id uuid primary key,organization_id uuid references organizations(id),is_active boolean default true,unique(organization_id,id));
 create table organization_members(organization_id uuid,user_id uuid,role text);
 grant select on vendors,organization_members to authenticated;`);
 await db.query('insert into organizations values($1),($2)',[org,other]);
 await db.query('insert into vendors values($1,$2,true),($3,$4,true)',[vendor,org,otherVendor,other]);
 await db.query("insert into organization_members values($1,$2,'owner'),($1,$3,'manager'),($1,$4,'employee'),($5,$6,'owner')",[org,owner,manager,employee,other,outsider]);
 for(const file of ['20261101135440_vendor_connect_setup.sql','20261102144952_vendor_portal_selection.sql','20261102152622_pending_vendor_transfer_revocation.sql','20261106212606_vendor_schedule_clock.sql'])await db.exec(readFileSync('supabase/migrations/'+file,'utf8'));
 const migration=readFileSync(scheduleMigration,'utf8');await db.exec(migration);await db.exec(migration);
 async function actor(c,user){await c.query('reset role');await c.query("select set_config('request.jwt.claim.sub',$1,false)",[user??'']);await c.query('set role authenticated');}
 async function request(c,user,organizationId,vendorId){await actor(c,user);const id=(await c.query("select kerdos_request_vendor_connection($1,$2,'us-foods-moxe') as id",[organizationId,vendorId])).rows[0].id;await c.query("update vendor_connection_requests set portal_account_label='Synthetic account',portal_list_label='Synthetic list' where id=$1",[id]);return id;}
 const requestId=await request(db,owner,org,vendor),otherRequest=await request(db,outsider,other,otherVendor);
 const save=async(c,id,expected,patch={})=>(await c.query('select kerdos_set_vendor_refresh_schedule($1,$2,$3::smallint[],$4::time,$5,$6,$7) as version',[id,expected,patch.days??[1],patch.time??'06:00',patch.zone??'America/New_York',patch.enabled??true,patch.grace??15])).rows[0].version;
 const claim=async(c,id)=>(await c.query('select kerdos_claim_scheduled_refresh($1) as claim',[id])).rows[0].claim;
 // Admin-only fixture timestamps make a currently due slot without sleeping.
 // Production RPCs never accept slot_at, effective_from or a browser clock.
 async function due(c,id,expected=0){
  await c.query('reset role');
  const slot=(await c.query("select to_char(clock_timestamp()-interval '1 minute','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') as stamp,extract(isodow from (clock_timestamp()-interval '1 minute') at time zone 'UTC')::int as day,((clock_timestamp()-interval '1 minute') at time zone 'UTC')::time as time")).rows[0];
  const user=id===otherRequest?outsider:owner;await actor(c,user);const version=await save(c,id,expected,{days:[slot.day],time:slot.time,zone:'UTC'});
  await c.query('reset role');await c.query("update kerdos_scheduling.versions set effective_from=clock_timestamp()-interval '2 minutes' where request_id=$1 and version=$2",[id,version]);await actor(c,user);return version;
 }
 await db.query('reset role');
 return {org,other,owner,manager,employee,outsider,vendor,otherVendor,requestId,otherRequest,actor,save,claim,due};
}
