-- kerdos-test only. Database role simulation, not signed-in browser acceptance.
-- Every fixture and purchase record rolls back. No email or portal operation.
begin;
set local lock_timeout='3s';
set local statement_timeout='20s';
do $$
declare o uuid:=gen_random_uuid(); v uuid:=gen_random_uuid(); ci uuid:=gen_random_uuid(); category uuid:=gen_random_uuid(); vi uuid:=gen_random_uuid(); m uuid:=gen_random_uuid(); doc uuid:=gen_random_uuid(); inv1 uuid:=gen_random_uuid(); inv2 uuid:=gen_random_uuid(); il1 uuid:=gen_random_uuid(); il2 uuid:=gen_random_uuid(); qs jsonb; u uuid; source jsonb; proof jsonb;
begin
 select om.user_id into u from public.organization_members om join auth.users au on au.id=om.user_id where om.role='owner' limit 1;
 if u is null then raise exception 'An existing test owner is required'; end if;
 source:='{"code":"SYN-ORDER","description":"Synthetic order rollback material","brand":"Example","packSize":"2/6-8 LBA","price":4,"sellingUnit":"LB","priceUnavailable":false,"billingUnitEvidence":{"kind":"pricing-unit-header","header":"Product UOM","unit":"LB"}}';
 proof:=jsonb_build_object('key','row:0','values',jsonb_build_array('SYN-ORDER','Synthetic order rollback material','Example','2/6-8 LBA',null,4,null,'LB',null,null,null,false),'billingUnitEvidence',source->'billingUnitEvidence');
 insert into public.organizations(id,name) values(o,'KERDOS rollback receipt fixture');
 insert into public.organization_members(organization_id,user_id,role) values(o,u,'owner');
 insert into public.vendors(id,organization_id,name,delivery_minimum_dollar,delivery_minimum_units) values(v,o,'Synthetic rollback vendor',200,1);
 insert into public.catalog_categories(id,organization_id,name,range_start,range_end) values(category,o,'Synthetic rollback category',900000,999999);
 insert into public.catalog_items(id,organization_id,name,category_id) values(ci,o,'Synthetic order rollback material',category);
 insert into public.import_documents(id,organization_id,vendor_id,document_kind,file_name,source_rows) values(doc,o,v,'pricelist','synthetic-order-rollback.csv',jsonb_build_object('version',1,'rows',jsonb_build_array(proof)));
 insert into public.vendor_items(id,organization_id,vendor_id,vendor_item_code,description,brand,pack_size,price,selling_unit,price_basis,price_unavailable,last_updated,import_row)
 values(vi,o,v,'SYN-ORDER','Synthetic order rollback material','Example','2/6-8 LBA',4,'LB','measure',true,current_timestamp,jsonb_build_object('sourceDocumentId',doc,'rowKey','row:0','row',source,'reviewRequired',true,'reviewFields',jsonb_build_array('pack_size')));
 insert into public.item_mappings(id,organization_id,vendor_item_id,catalog_item_id,comparison_track,confidence_score) values(m,o,vi,ci,'exact',100);
 insert into public.invoices(id,organization_id,vendor_id,invoice_number,invoice_date,total_amount,raw_text,status) values(inv1,o,v,'SYN-RECEIPT-1',current_date,56,'Controlled invoice with explicitly printed billed weight, price and total','recorded'),(inv2,o,v,'SYN-RECEIPT-2',current_date,70,'Controlled second partial invoice','recorded');
 qs:=jsonb_build_object('kind','quantity-column','header','Billed Weight','rawValue','14','columnIndex',2,'headerLine',E'Code\tPrice Unit\tBilled Weight\tUnit Price\tExtended Price');
 insert into public.invoice_lines(id,invoice_id,vendor_item_id,vendor_item_code,description,quantity,unit_price,line_total,selling_unit,source_line,billing_unit_evidence,quantity_source,match_confidence,match_method) values
 (il1,inv1,vi,'SYN-ORDER','Synthetic order rollback material',14,4,56,'LB',E'SYN-ORDER\tLB\t14\t4\t56',jsonb_build_object('kind','pricing-unit-header','header','Price Unit','unit','LB'),qs,100,'code'),
 (il2,inv2,vi,'SYN-ORDER','Synthetic order rollback material',14,5,70,'LB',E'SYN-ORDER\tLB\t14\t5\t70',jsonb_build_object('kind','pricing-unit-header','header','Price Unit','unit','LB'),qs,100,'code');
 perform set_config('request.jwt.claim.sub',u::text,true);
 perform set_config('kerdos.order_smoke',jsonb_build_object('org',o,'vendor',v,'vi',vi,'mapping',m,'il1',il1,'il2',il2)::text,true);
end $$;
set local role authenticated;
do $$
declare c jsonb:=current_setting('kerdos.order_smoke')::jsonb; o uuid:=(c->>'org')::uuid; v uuid:=(c->>'vendor')::uuid; vi uuid:=(c->>'vi')::uuid; m uuid:=(c->>'mapping')::uuid; terms jsonb; a jsonb; line jsonb; d jsonb; r jsonb; saved jsonb; replay jsonb; blocked boolean:=false; review1 jsonb; review2 jsonb; receipt1 jsonb; receipt2 jsonb; ol uuid;
begin
 terms:=public.kerdos_variable_weight_terms(o,vi,m);
 a:=public.kerdos_approve_variable_weight(o,vi,m,0,jsonb_build_object('kind','variable_weight_approval_intent','version',1,'requestedBy',auth.uid(),'finalChargeKnown',false,'terms',terms));
 line:=jsonb_build_object('kind','estimated_purchase_line_intent','version',1,'terms',terms,'approvalId',a->'id','quantity',2,'orderUnit','case','estimate',public.kerdos_estimated_weight_cost(terms,2),'actualCharge',null,'requiresAuthenticatedPersistence',true,'expectedRevision',0);
 d:=public.kerdos_save_estimated_draft(o,v,gen_random_uuid(),jsonb_build_array(line));
 r:=public.kerdos_review_estimated_order(o,(d->>'id')::uuid);
 if r->'deliveryMinimum'->>'status'<>'unknown' then raise exception 'Unknown monetary minimum was not retained'; end if;
 saved:=public.kerdos_submit_estimated_order(o,(d->>'id')::uuid,r,true,true);
 replay:=public.kerdos_submit_estimated_order(o,(d->>'id')::uuid,r,true,true);
 if saved<>replay or saved->>'kind'<>'estimated_purchase_order' or saved->>'finalCharge' is not null or saved->>'deliveryStatus'<>'not_sent' then raise exception 'Recorded snapshot/replay failed'; end if;
 if (select count(*) from public.purchase_order_lines where purchase_order_id=(saved->>'id')::uuid)<>1 or (select total_amount from public.purchase_orders where id=(saved->>'id')::uuid) is not null then raise exception 'Shared order history failed'; end if;
 begin perform public.kerdos_cancel_estimated_draft(o,(d->>'id')::uuid); exception when raise_exception then if sqlerrm like '%recorded order%' then blocked:=true; else raise; end if;end;
 if not blocked then raise exception 'Recorded draft cancellation was not blocked'; end if;
 blocked:=false;begin update public.purchase_orders set total_amount=96 where id=(saved->>'id')::uuid;exception when raise_exception then if sqlerrm like '%immutable%' then blocked:=true;else raise;end if;end;
 if not blocked then raise exception 'Recorded header mutation was not blocked';end if;
 ol:=(saved->'lines'->0->>'id')::uuid;
 review1:=public.kerdos_review_estimated_receipt(o,ol,(c->>'il1')::uuid,1);
 receipt1:=public.kerdos_save_estimated_receipt(o,ol,(c->>'il1')::uuid,1,review1,true,true);
 if public.kerdos_save_estimated_receipt(o,ol,(c->>'il1')::uuid,1,review1,true,true)<>receipt1 then raise exception 'Receipt replay changed identity';end if;
 if (select sum(received_cases) from public.estimated_order_receipts where order_id=(saved->>'id')::uuid)<>1 then raise exception 'Partial receipt case count failed';end if;
 review2:=public.kerdos_review_estimated_receipt(o,ol,(c->>'il2')::uuid,1);
 receipt2:=public.kerdos_save_estimated_receipt(o,ol,(c->>'il2')::uuid,1,review2,true,true);
 if (receipt1->>'actualCharge')::numeric<>56 or (receipt2->>'actualCharge')::numeric<>70 or (receipt2->>'rateVariance')::numeric<>14 then raise exception 'Invoice charges or quoted variance failed';end if;
 if (select sum(received_cases) from public.estimated_order_receipts where order_id=(saved->>'id')::uuid)<>2 or (select sum((snapshot->>'actualCharge')::numeric) from public.estimated_order_receipts where order_id=(saved->>'id')::uuid)<>126 then raise exception 'Complete linked item charges failed';end if;
 blocked:=false;begin update public.invoice_lines set unit_price=5 where id=(c->>'il1')::uuid;exception when raise_exception then if sqlerrm like '%immutable%' then blocked:=true;else raise;end if;end;
 if not blocked then raise exception 'Receipt invoice mutation was not blocked';end if;
 set constraints all immediate;
end $$;
rollback;
select (select count(*) from public.estimated_order_receipts) as receipts,(select count(*) from public.purchase_orders) as orders,(select count(*) from public.invoices) as invoices,(select count(*) from public.invoice_lines) as invoice_lines,(select count(*) from public.organizations where name='KERDOS rollback receipt fixture') as fixture_organizations;
