import fs from 'node:fs';
import {parseDocument} from '../../src/ingestion.js';

// Shared by embedded persistence tests and independent PostgreSQL sessions.
export async function invoiceQuoteFixture(db){
const read=p=>fs.readFileSync(new URL('../../'+p,import.meta.url),'utf8');
const migration=fs.readdirSync(new URL('../../supabase/migrations/',import.meta.url)).find(n=>n.endsWith('_invoice_quote_provenance.sql'));
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const [org,vendor,item,route,message,token,att,actor,doc,history,otherDoc,otherHistory]=Array.from({length:12},(_,i)=>id(i+1));
const text='INVOICE PROV-101\nDate: 10/27/2026\nItem,Description,Pack,Price Unit,Qty,Unit Price,Extended Price\n49200,CHIC BRST RAW BNLS RNDM CVP,4/10 LB,LB,40,2.06,82.40';
const listing={id:item,organization_id:org,vendor_id:vendor,vendor_item_code:'49200',description:'CHIC BRST RAW BNLS RNDM CVP',pack_size:'4/10 LB'};
const lookup=()=>db.query('select *,effective_date::text,quote_valid_until::text from price_history where id=$1',[history]).then(r=>r.rows[0]);
const args={text,rows:parseDocument(text).rows,organizationId:org,vendorId:vendor,vendorItems:[listing]};
  await db.exec(`DO $$ BEGIN IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated; END IF; IF NOT EXISTS(SELECT FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role; END IF; END $$;
    CREATE SCHEMA auth;CREATE FUNCTION auth.uid() RETURNS uuid LANGUAGE sql AS $$SELECT nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
    CREATE TABLE organization_members(organization_id uuid,user_id uuid,role text);
    CREATE TABLE vendors(id uuid PRIMARY KEY,organization_id uuid,UNIQUE(organization_id,id));
    CREATE TABLE email_routing_addresses(id uuid PRIMARY KEY,organization_id uuid,routing_address text,is_active boolean DEFAULT true);
    CREATE TABLE inbound_messages(id uuid PRIMARY KEY,organization_id uuid,routing_address_id uuid);
    CREATE TABLE import_documents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,vendor_id uuid,document_kind text,fingerprint text,original_text text,file_name text,file_path text,status text,created_at timestamptz DEFAULT now(),completed_keys jsonb DEFAULT '[]');
    CREATE TABLE inbound_attachments(id uuid PRIMARY KEY,organization_id uuid,message_id uuid,filename text,storage_path text,ingest_error text,import_document_id uuid,processing_status text,processing_error text,processing_lease_token uuid);
    CREATE TABLE vendor_items(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,vendor_id uuid,vendor_item_code text,description text,pack_size text,price numeric,last_updated date,price_source text);
    CREATE TABLE catalog_items(id uuid PRIMARY KEY,organization_id uuid);
    CREATE TABLE item_mappings(organization_id uuid,catalog_item_id uuid,vendor_item_id uuid,confidence_score integer,match_method text,comparison_track text);
    CREATE TABLE invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,vendor_id uuid,invoice_number text,invoice_date date,total_amount numeric,raw_text text,status text,file_path text,file_name text,created_at timestamptz DEFAULT now());
    CREATE TABLE invoice_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),invoice_id uuid REFERENCES invoices(id),vendor_item_id uuid,vendor_item_code text,description text,quantity numeric,unit_price numeric,line_total numeric,price_variance numeric,match_confidence numeric,match_method text);
    CREATE TABLE price_history(id uuid PRIMARY KEY,organization_id uuid,vendor_item_id uuid,source_document_id uuid,price numeric,effective_date timestamptz,quote_valid_until date,source text,price_basis text,selling_unit text);
  `);
  for(const p of ['knowledge/migration_038_receipt_vendor_snapshot_draft.sql','knowledge/migration_039_routing_document_type.sql','supabase/migrations/20261027205000_a1_atomic_background_invoice.sql','supabase/migrations/20261101213251_invoice_billed_quantity_evidence.sql',`supabase/migrations/${migration}`])await db.exec(read(p));
  await db.exec(`GRANT USAGE ON SCHEMA public,auth TO authenticated,service_role;GRANT ALL ON ALL TABLES IN SCHEMA public TO authenticated,service_role;
    INSERT INTO organization_members VALUES('${org}','${actor}','owner');INSERT INTO vendors VALUES('${vendor}','${org}');
    INSERT INTO vendor_items(id,organization_id,vendor_id) VALUES('${item}','${org}','${vendor}');
    INSERT INTO import_documents(id,organization_id,vendor_id,document_kind,status) VALUES('${doc}','${org}','${vendor}','pricelist','complete'),('${otherDoc}','${vendor}','${org}','pricelist','complete');
    INSERT INTO price_history VALUES('${history}','${org}','${item}','${doc}',2,'2026-10-01','2026-11-30','price_list','measure','lb'),('${otherHistory}','${vendor}','${item}','${otherDoc}',2,'2026-10-01','2026-11-30','price_list','measure','lb');
    INSERT INTO email_routing_addresses(id,organization_id,routing_address,document_type) VALUES('${route}','${org}','client.vendor@example.invalid','invoice');
    INSERT INTO inbound_messages(id,organization_id,routing_address_id,receipt_vendor_id,vendor_snapshot_at,receipt_document_type) VALUES('${message}','${org}','${route}','${vendor}',now(),'invoice');
    INSERT INTO inbound_attachments(id,organization_id,message_id,filename,storage_path,processing_status,processing_lease_token) VALUES('${att}','${org}','${message}','invoice.csv','fixture/original','processing','${token}');
    SELECT set_config('request.jwt.claim.sub','${actor}',false);
  `);
return {org,vendor,item,route,message,token,att,actor,doc,history,otherDoc,otherHistory,text,listing,args,lookup};
}
