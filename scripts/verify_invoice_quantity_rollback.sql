-- kerdos-test only: role simulation of manual and automatic RPCs; all data rolls back.
-- No email, Storage upload or vendor request is performed.
begin;
set local lock_timeout='3s';set local statement_timeout='20s';
do $$
declare o uuid:=gen_random_uuid();v uuid:=gen_random_uuid();vi uuid:=gen_random_uuid();route uuid:=gen_random_uuid();msg uuid:=gen_random_uuid();att uuid:=gen_random_uuid();token uuid:=gen_random_uuid();u uuid;source jsonb;line jsonb;
begin
 select om.user_id into u from public.organization_members om join auth.users au on au.id=om.user_id where om.role='owner' limit 1;
 if u is null then raise exception 'A test owner is required';end if;
 insert into public.organizations(id,name) values(o,'KERDOS rollback quantity fixture');
 insert into public.organization_members(organization_id,user_id,role) values(o,u,'owner');
 insert into public.vendors(id,organization_id,name) values(v,o,'Synthetic quantity vendor');
 insert into public.vendor_items(id,organization_id,vendor_id,vendor_item_code,description,pack_size) values(vi,o,v,'SYN-Q','Synthetic quantity material','2/6-8 LBA');
 insert into public.email_routing_addresses(id,organization_id,routing_address,vendor_id,document_type,is_automatic) values(route,o,'quantity.'||o::text||'@fixture.invalid',v,'invoice',false);
 insert into public.inbound_messages(id,organization_id,routing_address_id,postmark_message_id,sender_email,receipt_vendor_id,vendor_snapshot_at,receipt_document_type) values(msg,o,route,'quantity-smoke:'||msg::text,'fixture@example.invalid',v,current_timestamp,'invoice');
 insert into public.inbound_attachments(id,organization_id,message_id,attachment_index,filename,storage_path,processing_status,processing_lease_token) values(att,o,msg,0,'quantity.csv',o::text||'/quantity.csv','processing',token);
 source:=jsonb_build_object('kind','quantity-column','header','Billed Weight','rawValue','14','columnIndex',5,'headerLine',E'Item\tDescription\tPack\tPrice Unit\tOrdered\tBilled Weight\tUnit Price\tExtended Price');
 line:=jsonb_build_object('vendor_item_id',vi,'vendor_item_code','SYN-Q','description','Synthetic quantity material','quantity',14,'unit_price',4,'line_total',56,'selling_unit','LB','pack_size','2/6-8 LBA','source_line',E'SYN-Q\tSynthetic quantity material\t2/6-8 LBA\tLB\t2\t14\t4\t56','billing_unit_evidence',jsonb_build_object('kind','pricing-unit-header','header','Price Unit','unit','LB'),'quantity_source',source,'match_confidence',100,'match_method','code');
 perform set_config('request.jwt.claim.sub',u::text,true);
 perform set_config('kerdos.quantity_smoke',jsonb_build_object('org',o,'vendor',v,'attachment',att,'token',token,'line',line)::text,true);
end $$;
set local role authenticated;
do $$
declare c jsonb:=current_setting('kerdos.quantity_smoke')::jsonb;h jsonb;i uuid;saved jsonb;blocked boolean:=false;
begin
 h:=jsonb_build_object('organization_id',c->'org','vendor_id',c->'vendor','invoice_number','SYN-Q-MANUAL','invoice_date',current_date,'total_amount',56,'raw_text','INVOICE SYN-Q-MANUAL');
 i:=public.kerdos_record_invoice(h,jsonb_build_array(c->'line'));
 select billed_quantity_evidence into saved from public.invoice_lines where invoice_id=i;
 if saved->>'quantity'<>'14' or saved->>'unit'<>'LB' or saved->>'header'<>'Billed Weight' then raise exception 'Manual billed quantity evidence was not retained';end if;
 begin perform public.kerdos_record_invoice(h||jsonb_build_object('invoice_number','SYN-Q-BAD'),jsonb_build_array((c->'line')||jsonb_build_object('billed_quantity_evidence',jsonb_build_object('quantity',2))));exception when raise_exception then if sqlerrm like '%Billed quantity evidence differs%' then blocked:=true;else raise;end if;end;
 if not blocked then raise exception 'Contradictory proof was not blocked';end if;
end $$;
reset role;
select set_config('request.jwt.claim.role','service_role',true);
set local role service_role;
do $$
declare c jsonb:=current_setting('kerdos.quantity_smoke')::jsonb;h jsonb;i uuid;again uuid;proof jsonb;
begin
 h:=jsonb_build_object('organization_id',c->'org','vendor_id',c->'vendor','invoice_number','SYN-Q-AUTO','invoice_date',current_date,'total_amount',56,'raw_text','INVOICE SYN-Q-AUTO','file_name','quantity.csv','file_path',(c->>'org')||'/quantity.csv');
 i:=public.kerdos_auto_record_invoice((c->>'attachment')::uuid,(c->>'token')::uuid,'quantity-smoke',h,jsonb_build_array(c->'line'));
 select billed_quantity_evidence into proof from public.invoice_lines where invoice_id=i;
 if proof->>'quantity'<>'14' or proof->>'unit'<>'LB' then raise exception 'Automatic quantity evidence was not retained';end if;
 update public.inbound_attachments set processing_status='processing' where id=(c->>'attachment')::uuid;
 again:=public.kerdos_auto_record_invoice((c->>'attachment')::uuid,(c->>'token')::uuid,'quantity-smoke',h,jsonb_build_array(c->'line'));
 if again<>i or (select count(*) from public.invoice_lines where invoice_id=i)<>1 then raise exception 'Replay duplicated the invoice line';end if;
end $$;
rollback;
select (select count(*) from public.invoices) as invoices,(select count(*) from public.invoice_lines) as invoice_lines,(select count(*) from public.invoice_lines where quantity_source is not null or billed_quantity_evidence is not null) as historical_evidence_rows,(select count(*) from public.organizations where name='KERDOS rollback quantity fixture') as fixture_organizations;
