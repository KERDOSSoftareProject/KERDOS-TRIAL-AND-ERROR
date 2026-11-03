import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {parseDocument} from '../src/ingestion.js';
import {prepareAutomaticInvoice} from '../src/core/automatic-invoice.js';
import {lookupQuoteComparison} from '../src/core/quote-provenance.js';

const db=new PGlite(), read=p=>fs.readFileSync(new URL('../'+p,import.meta.url),'utf8');
const migration=fs.readdirSync(new URL('../supabase/migrations/',import.meta.url)).find(n=>n.endsWith('_invoice_quote_provenance.sql'));
const id=n=>`00000000-0000-0000-0000-${String(n).padStart(12,'0')}`;
const [org,vendor,item,route,message,token,att,actor,doc,history,otherDoc,otherHistory]=Array.from({length:12},(_,i)=>id(i+1));
let passed=0;
async function check(label,fn){await fn();passed++;console.log('PASS '+label);}
const text='INVOICE PROV-101\nDate: 10/27/2026\nItem,Description,Pack,Price Unit,Qty,Unit Price,Extended Price\n49200,CHIC BRST RAW BNLS RNDM CVP,4/10 LB,LB,40,2.06,82.40';
const listing={id:item,organization_id:org,vendor_id:vendor,vendor_item_code:'49200',description:'CHIC BRST RAW BNLS RNDM CVP',pack_size:'4/10 LB'};
const lookup=()=>db.query('select *,effective_date::text,quote_valid_until::text from price_history where id=$1',[history]).then(r=>r.rows[0]);
const args={text,rows:parseDocument(text).rows,organizationId:org,vendorId:vendor,vendorItems:[listing]};
try {
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
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
  const prepared=await prepareAutomaticInvoice({...args,importService:{historicalQuote:lookup}});
  assert.equal(prepared.reason,null);
  const header={...prepared.header,file_name:'invoice.csv',file_path:'fixture/original'};
  const line=prepared.lines[0];
  const manual=(l=line,h={...header,invoice_number:"MANUAL-101"})=>db.query('select kerdos_record_invoice($1::jsonb,$2::jsonb) id',[JSON.stringify(h),JSON.stringify([l])]);
  const automatic=(l=line,h=header,t=token)=>db.query('select kerdos_auto_record_invoice($1::uuid,$2::uuid,$3,$4::jsonb,$5::jsonb) id',[att,t,'fixture:'+h.invoice_number,JSON.stringify(h),JSON.stringify([l])]);
  const saved=invoiceId=>db.query('select * from invoice_lines where invoice_id=$1',[invoiceId]).then(r=>r.rows[0]);
  const count=()=>db.query('select count(*)::int n from invoices').then(r=>r.rows[0].n);
  const assertEvidence=s=>{
    assert.equal(Number(s.price_variance),0.06);assert.equal(Number(s.quoted_rate),2);
    assert.equal(Number(s.quoted_source_rate),2);assert.equal(s.quoted_source,'price_list');
    assert.equal(s.quoted_basis,'measure');assert.equal(s.quoted_price_history_id,history);
    assert.equal(s.quoted_source_document_id,doc);assert.equal(s.quoted_comparison_note,null);
    assert.equal(Number(s.quantity),40);assert.equal(Number(s.line_total),82.4);
    assert.deepEqual(s.billed_quantity_evidence,line.billed_quantity_evidence);
  };
  await check('interactive RPC saves and reloads all quote fields and billed evidence',async()=>{
    await db.exec('SET ROLE authenticated');try{assertEvidence(await saved((await manual()).rows[0].id));}finally{await db.exec('RESET ROLE');}
  });
  await check('automatic RPC saves quote evidence with atomic attachment completion',async()=>{
    await db.exec('SET ROLE service_role');let invoiceId;try{invoiceId=(await automatic()).rows[0].id;}finally{await db.exec('RESET ROLE');}
    assertEvidence(await saved(invoiceId));
    assert.equal((await db.query('select processing_status from inbound_attachments where id=$1',[att])).rows[0].processing_status,'auto_imported');
  });
  await check('automatic replay preserves original comparison after current price changes',async()=>{
    await db.query('update price_history set price=3 where id=$1',[history]);
    await db.query("update inbound_attachments set processing_status='processing' where id=$1",[att]);
    const fresh=await prepareAutomaticInvoice({...args,importService:{historicalQuote:lookup}});
    // Replay returns the first invoice and must not overwrite its retained evidence.
    const n=await count(),s=await saved((await automatic(fresh.lines[0])).rows[0].id);
    assert.equal(await count(),n);assertEvidence(s);
    await db.query('update price_history set price=2 where id=$1',[history]);
  });
  for(const note of ['lookup_error','no_eligible_quote','quote_expired','basis_incompatible','client_window_exceeded'])await check(note+' persists distinctly with no false zero',async()=>{
    const {quoteProvenance}=await lookupQuoteComparison({vendorItemId:null});
    const s=await saved((await manual({...line,...quoteProvenance,price_variance:null,quoted_comparison_note:note})).rows[0].id);
    assert.equal(s.quoted_comparison_note,note);assert.equal(s.price_variance,null);assert.equal(s.quoted_rate,null);
  });
  await check('true zero and undercharge persist as performed comparisons',async()=>{
    for(const [rate,variance] of [[2,0],[1.5,-0.5]]){
      const s=await saved((await manual({...line,unit_price:rate,line_total:rate*40,price_variance:variance},{...header,total_amount:rate*40})).rows[0].id);
      assert.equal(Number(s.price_variance),variance);assert.equal(s.quoted_comparison_note,null);
    }
  });
  for(const [label,change,pattern] of [
    ['foreign quote',{quoted_price_history_id:otherHistory},/Quote evidence/],
    ['foreign document',{quoted_source_document_id:otherDoc},/Quote evidence|Quote document/],
    ['fabricated source rate',{quoted_source_rate:999},/Quote evidence/],
    ['inconsistent rate/variance',{price_variance:15},/must reconcile/],
    ['failed comparison with variance',{quoted_comparison_note:'lookup_error'},/Unperformed/],
  ])await check('both RPCs reject '+label+' atomically',async()=>{
    await db.query("update inbound_attachments set processing_status='processing' where id=$1",[att]);
    const n=await count();await assert.rejects(()=>manual({...line,...change}),pattern);
    await assert.rejects(()=>automatic({...line,...change},{...header,invoice_number:"REJECT-"+label,raw_text:text+label}),pattern);assert.equal(await count(),n);
  });
  await check('interactive writer still rejects unauthorized users',async()=>{
    await db.exec("SELECT set_config('request.jwt.claim.sub','',false)");await assert.rejects(()=>manual(),/Authentication/);
    await db.exec(`SELECT set_config('request.jwt.claim.sub','${vendor}',false)`);await assert.rejects(()=>manual(),/Owner or manager/);
    await db.exec(`SELECT set_config('request.jwt.claim.sub','${actor}',false)`);
  });
  await check('automatic writer retains service-only execution and lease fencing',async()=>{
    await db.exec('SET ROLE authenticated');try{await assert.rejects(()=>automatic(),/permission denied/);}finally{await db.exec('RESET ROLE');}
    await assert.rejects(()=>automatic(line,header,actor),/LEASE_LOST/);
  });
  await check('missing quote versus lookup error executed through actual automatic preparer',async()=>{
    for(const [historicalQuote,expected] of [[async()=>null,'no_eligible_quote'],[async()=>{throw Error('network unavailable');},'lookup_error']]){
      const result=await prepareAutomaticInvoice({...args,importService:{historicalQuote}});
      assert.equal(result.lines[0].quoted_comparison_note,expected);assert.equal(result.lines[0].price_variance,null);
    }
  });
  await check('shared interactive lookup persists error distinction and refresh exclusion',async()=>{
    const p={importService:{historicalQuote:async()=>{throw Error('network unavailable');}},organizationId:org,vendorItemId:item,invoiceDate:'2026-10-27',billedUnit:'LB',packSize:'4/10 LB',unitPrice:2.06};
    const failed=await lookupQuoteComparison(p);assert.equal(failed.comparisonNote,'lookup_error');assert.match(failed.lookupError,/network/);
    const filtered=await lookupQuoteComparison({...p,importService:{historicalQuote:lookup},clientSettings:{price_refresh_mode:'automatic',price_refresh_days:2}});
    assert.equal(filtered.comparisonNote,'client_window_exceeded');assert.equal(filtered.variance,null);
  });
  console.log(`${passed}/${passed} quote provenance integration checks passed (real JavaScript + PostgreSQL RPC persistence/reload).`);
}finally{await db.close();}
