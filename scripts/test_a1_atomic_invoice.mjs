import assert from 'node:assert/strict';
import fs from 'node:fs';
import {PGlite} from '@electric-sql/pglite';
import {createRecords} from '../src/backend/records.js';
import {parseDocument} from '../src/ingestion.js';
import {prepareAutomaticInvoice} from '../src/core/automatic-invoice.js';
import {processAttachmentInBackground,classifyDocument} from '../supabase/functions/process-attachment/background-import.mjs';

const org='00000000-0000-0000-0000-000000000001',vendor='00000000-0000-0000-0000-000000000002';
const item='00000000-0000-0000-0000-000000000003',route='00000000-0000-0000-0000-000000000004',message='00000000-0000-0000-0000-000000000005';
const token='00000000-0000-0000-0000-000000000006',att='00000000-0000-0000-0000-000000000007';
const text='INVOICE INV-101\nDate: 10/27/2026\nItem,Description,Pack,Price Unit,Qty,Unit Price,Extended Price\n49200,CHIC BRST RAW BNLS RNDM CVP,4/10 LB,LB,40,2.06,82.40';
const listing={id:item,organization_id:org,vendor_id:vendor,vendor_item_code:'49200',description:'CHIC BRST RAW BNLS RNDM CVP',pack_size:'4/10 LB',price:2};
const rows=parseDocument(text).rows;
const prepare=overrides=>prepareAutomaticInvoice({text,rows,organizationId:org,vendorId:vendor,vendorItems:[listing],...overrides});
let passed=0;
async function check(name,fn){await fn();passed++;console.log('PASS '+name);}
await check('registered type conflicts are reviewed, including mixed documents',()=>{
  for(const [a,b] of [['invoice','pricelist'],['pricelist','invoice'],['invoice','mixed'],['pricelist','mixed']])
    assert.equal(classifyDocument(a,b).earlyExit.status,'needs_review');
  assert.equal(classifyDocument('invoice','unknown').isInvoice,true);
});
await check('real parsed invoice retains quantity, price, total and billing evidence',()=>{
  const result=prepare();assert.equal(result.reason,null);assert.equal(result.header.total_amount,82.4);
  assert.equal(result.lines[0].quantity,40);assert.equal(result.lines[0].unit_price,2.06);
  assert.equal(result.lines[0].billing_unit_evidence.header,'Price Unit');
});
for(const [name,change] of [
  ['missing date',{text:text.replace('Date: 10/27/2026','')}],['empty document',{rows:[]}],
  ['bad arithmetic',{rows:[{...rows[0],amount:99}]}],['missing quantity',{rows:[{...rows[0],qty:null}]}],
  ['missing extended amount',{rows:[{...rows[0],amount:null}]}],['unresolved parser issue',{rows:[{...rows[0],issues:['Unverified field']}]}],
  ['missing billed-unit evidence',{rows:[{...rows[0],billingUnitEvidence:null,quoteUnitEvidence:[]}]}],
  ['conflicting stated total',{text:text+'\nTOTAL: 99.00'}],
  ['different product under same code',{vendorItems:[{...listing,description:'BEEF PATTY FROZEN 4 OZ'}]}],
  ['different pack under same code',{vendorItems:[{...listing,pack_size:'2/10 LB'}]}],
  ['unknown product',{vendorItems:[]}],['cross-organization candidate',{vendorItems:[{...listing,organization_id:'other'}]}],
])await check(name+' produces a specific review reason',()=>assert.ok(prepare(change).reason));

const db=new PGlite();
const read=path=>fs.readFileSync(new URL('../'+path,import.meta.url),'utf8');
try{
  await db.exec(`CREATE ROLE anon;CREATE ROLE authenticated;CREATE ROLE service_role;
    CREATE TABLE public.vendors(id uuid PRIMARY KEY,organization_id uuid,UNIQUE(organization_id,id));
    CREATE TABLE public.email_routing_addresses(id uuid PRIMARY KEY,organization_id uuid,routing_address text,is_active boolean DEFAULT true);
    CREATE TABLE public.inbound_messages(id uuid PRIMARY KEY,organization_id uuid,routing_address_id uuid);
    CREATE TABLE public.import_documents(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,vendor_id uuid,document_kind text,fingerprint text,original_text text,file_name text,file_path text,status text,created_at timestamptz DEFAULT now(),completed_keys jsonb DEFAULT '[]');
    CREATE TABLE public.inbound_attachments(id uuid PRIMARY KEY,organization_id uuid,message_id uuid,filename text,storage_path text,ingest_error text,import_document_id uuid,processing_status text,processing_error text,processing_lease_token uuid);
    CREATE TABLE public.vendor_items(id uuid PRIMARY KEY,organization_id uuid,vendor_id uuid);
    CREATE TABLE public.invoices(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),organization_id uuid,vendor_id uuid,invoice_number text,invoice_date date,total_amount numeric,raw_text text,status text,file_path text,file_name text,created_at timestamptz DEFAULT now());
    CREATE TABLE public.invoice_lines(id uuid PRIMARY KEY DEFAULT gen_random_uuid(),invoice_id uuid REFERENCES public.invoices(id),vendor_item_id uuid,vendor_item_code text,description text,quantity numeric,unit_price numeric,line_total numeric,price_variance numeric,match_confidence numeric,match_method text);
  `);
  await db.exec(read('knowledge/migration_038_receipt_vendor_snapshot_draft.sql'));
  await db.exec(read('knowledge/migration_039_routing_document_type.sql'));
  await db.exec(read('supabase/migrations/20261027205000_a1_atomic_background_invoice.sql'));
  await db.exec(`GRANT USAGE ON SCHEMA public TO anon,authenticated,service_role;GRANT ALL ON ALL TABLES IN SCHEMA public TO service_role;
    INSERT INTO vendors VALUES('${vendor}','${org}');INSERT INTO vendor_items VALUES('${item}','${org}','${vendor}');
    INSERT INTO email_routing_addresses(id,organization_id,routing_address,document_type) VALUES('${route}','${org}','client.vendor@configured.example','invoice');
    INSERT INTO inbound_messages(id,organization_id,routing_address_id,receipt_vendor_id,vendor_snapshot_at,receipt_document_type) VALUES('${message}','${org}','${route}','${vendor}',now(),'invoice');
    INSERT INTO inbound_attachments(id,organization_id,message_id,filename,storage_path,processing_status,processing_lease_token) VALUES('${att}','${org}','${message}','invoice.csv','org/inbound/file','processing','${token}');
  `);
  const prepared=prepare();
  const header={...prepared.header,file_name:'invoice.csv',file_path:'org/inbound/file'};
  const rpc=(h=header,l=prepared.lines,t=token,a=att,fingerprint='file:128')=>db.query('SELECT public.kerdos_auto_record_invoice($1::uuid,$2::uuid,$3,$4::jsonb,$5::jsonb) AS id',[a,t,fingerprint,JSON.stringify(h),JSON.stringify(l)]);
  const counts=async()=> (await db.query('SELECT (SELECT count(*)::int FROM invoices) invoices,(SELECT count(*)::int FROM invoice_lines) lines,(SELECT count(*)::int FROM import_documents) docs')).rows[0];
  async function rejection(name,fn,pattern){await check(name,async()=>{const before=await counts();await assert.rejects(fn,pattern);assert.deepEqual(await counts(),before,'rejection leaves no partial data');});}
  await rejection('database rejects wrong worker token',()=>rpc(header,prepared.lines,org),/LEASE_LOST/);
  await rejection('database rejects cross-org header',()=>rpc({...header,organization_id:vendor}),/receipt-time/);
  await rejection('database rejects empty lines',()=>rpc(header,[]),/at least one/);
  await rejection('database rejects arithmetic mismatch',()=>rpc(header,[{...prepared.lines[0],line_total:99}]),/reconcile/);
  await rejection('database rejects total mismatch',()=>rpc({...header,total_amount:99}),/total/);
  await rejection('database rejects foreign product',()=>rpc(header,[{...prepared.lines[0],vendor_item_id:org}]),/verified product/);
  await rejection('database rejects false billing evidence',()=>rpc(header,[{...prepared.lines[0],billing_unit_evidence:{unit:'CS'}}]),/billed unit/);
  await check('anonymous and signed-in roles cannot call service invoice writer',async()=>{
    for(const role of ['anon','authenticated']){
      await db.exec('SET ROLE '+role);await assert.rejects(()=>rpc(),/permission denied/);await db.exec('RESET ROLE');
    }
  });
  await check('snapshot document type is immutable',async()=>{
    await assert.rejects(()=>db.query("UPDATE inbound_messages SET receipt_document_type='pricelist' WHERE id=$1",[message]),/cannot be changed/);
  });
  await check('manual reservation blocks worker before any invoice write',async()=>{
    await db.query("UPDATE inbound_attachments SET processing_status='needs_review' WHERE id=$1",[att]);
    await assert.rejects(()=>rpc(),/LEASE_LOST/);assert.deepEqual(await counts(),{invoices:0,lines:0,docs:0});
    await db.query("UPDATE inbound_attachments SET processing_status='processing' WHERE id=$1",[att]);
  });
  await check('actual importer commits invoice header, lines, document and attachment together',async()=>{
    const records=createRecords(async spec=>({data:spec.table==='vendor_items'?[listing]:[],error:null}));
    const backend={records,attachments:{download:async()=>new TextEncoder().encode(text),setStatus:async()=>{throw Error('Unexpected review status');}},
      invoices:{recordAutomatic:async payload=>{await db.exec('SET ROLE service_role');try{return await rpc(payload.header,payload.lines);}finally{await db.exec('RESET ROLE');}}}};
    const result=await processAttachmentInBackground(backend,{id:att,filename:'invoice.csv',content_type:'text/csv',storage_path:'org/inbound/file',file_size_bytes:128},{organizationId:org,vendorId:vendor,documentType:'invoice'});
    assert.equal(result.outcome,'auto_imported');assert.deepEqual(await counts(),{invoices:1,lines:1,docs:1});
    const line=(await db.query('SELECT * FROM invoice_lines')).rows[0];assert.equal(Number(line.quantity),40);assert.equal(Number(line.unit_price),2.06);assert.equal(Number(line.line_total),82.4);assert.equal(line.selling_unit,'LB');
    const linked=(await db.query('SELECT a.processing_status,d.status,d.id=i.source_document_id AS same_document FROM inbound_attachments a JOIN import_documents d ON d.id=a.import_document_id JOIN invoices i ON i.source_document_id=d.id')).rows[0];
    assert.deepEqual(linked,{processing_status:'auto_imported',status:'complete',same_document:true});
  });
  await check('separate attachment/replay of the same invoice reuses saved data',async()=>{
    const a2='00000000-0000-0000-0000-000000000008';
    await db.query('INSERT INTO inbound_attachments SELECT $1,organization_id,message_id,filename,storage_path,ingest_error,NULL,\'processing\',NULL,processing_lease_token FROM inbound_attachments WHERE id=$2',[a2,att]);
    await rpc(header,prepared.lines,token,a2);assert.deepEqual(await counts(),{invoices:1,lines:1,docs:1});
    const ids=(await db.query('SELECT import_document_id FROM inbound_attachments ORDER BY id')).rows;
    assert.equal(ids[0].import_document_id,ids[1].import_document_id);
  });
  await check('same invoice number with changed contents requires reconciliation',async()=>{
    await db.query("UPDATE inbound_attachments SET processing_status='processing' WHERE id=$1",[att]);
    await assert.rejects(()=>rpc({...header,raw_text:text+'\nchanged'}),/reconciliation/);
    assert.deepEqual(await counts(),{invoices:1,lines:1,docs:1});
  });
  await check('late persistence failure rolls back document and invoice lines',async()=>{
    await db.exec(`CREATE FUNCTION reject_final_status() RETURNS trigger LANGUAGE plpgsql AS $$BEGIN IF NEW.processing_status='auto_imported' THEN RAISE EXCEPTION 'simulated final write failure'; END IF; RETURN NEW;END;$$;
      CREATE TRIGGER fail_final_status BEFORE UPDATE ON inbound_attachments FOR EACH ROW EXECUTE FUNCTION reject_final_status();`);
    await assert.rejects(()=>rpc({...header,invoice_number:'INV-102',raw_text:text.replace('INV-101','INV-102')},prepared.lines,token,att,'second:128'),/simulated final/);
    assert.deepEqual(await counts(),{invoices:1,lines:1,docs:1});
    await db.exec('DROP TRIGGER fail_final_status ON inbound_attachments');
    await rpc({...header,invoice_number:'INV-102',raw_text:text.replace('INV-101','INV-102')},prepared.lines,token,att,'second:128');
    assert.deepEqual(await counts(),{invoices:2,lines:2,docs:2});
  });
}finally{await db.close();}
console.log(`${passed}/${passed} automatic invoice checks passed (local parser/importer + PostgreSQL).`);
