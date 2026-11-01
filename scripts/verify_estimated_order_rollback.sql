-- kerdos-test only. Database role simulation, not signed-in browser acceptance.
-- Every fixture and purchase record rolls back. No email or portal operation.
begin;
set local lock_timeout='3s';
set local statement_timeout='20s';
do $$
declare o uuid:=gen_random_uuid(); v uuid:=gen_random_uuid(); ci uuid:=gen_random_uuid(); category uuid:=gen_random_uuid(); vi uuid:=gen_random_uuid(); m uuid:=gen_random_uuid(); doc uuid:=gen_random_uuid(); u uuid; source jsonb; proof jsonb;
begin
 select om.user_id into u from public.organization_members om join auth.users au on au.id=om.user_id where om.role='owner' limit 1;
 if u is null then raise exception 'An existing test owner is required'; end if;
 source:='{"code":"SYN-ORDER","description":"Synthetic order rollback material","brand":"Example","packSize":"2/6-8 LBA","price":4,"sellingUnit":"LB","priceUnavailable":false,"billingUnitEvidence":{"kind":"pricing-unit-header","header":"Product UOM","unit":"LB"}}';
 proof:=jsonb_build_object('key','row:0','values',jsonb_build_array('SYN-ORDER','Synthetic order rollback material','Example','2/6-8 LBA',null,4,null,'LB',null,null,null,false),'billingUnitEvidence',source->'billingUnitEvidence');
 insert into public.organizations(id,name) values(o,'KERDOS rollback estimated order fixture');
 insert into public.organization_members(organization_id,user_id,role) values(o,u,'owner');
 insert into public.vendors(id,organization_id,name,delivery_minimum_dollar,delivery_minimum_units) values(v,o,'Synthetic rollback vendor',200,1);
 insert into public.catalog_categories(id,organization_id,name,range_start,range_end) values(category,o,'Synthetic rollback category',900000,999999);
 insert into public.catalog_items(id,organization_id,name,category_id) values(ci,o,'Synthetic order rollback material',category);
 insert into public.import_documents(id,organization_id,vendor_id,document_kind,file_name,source_rows) values(doc,o,v,'pricelist','synthetic-order-rollback.csv',jsonb_build_object('version',1,'rows',jsonb_build_array(proof)));
 insert into public.vendor_items(id,organization_id,vendor_id,vendor_item_code,description,brand,pack_size,price,selling_unit,price_basis,price_unavailable,last_updated,import_row)
 values(vi,o,v,'SYN-ORDER','Synthetic order rollback material','Example','2/6-8 LBA',4,'LB','measure',true,current_timestamp,jsonb_build_object('sourceDocumentId',doc,'rowKey','row:0','row',source,'reviewRequired',true,'reviewFields',jsonb_build_array('pack_size')));
 insert into public.item_mappings(id,organization_id,vendor_item_id,catalog_item_id,comparison_track,confidence_score) values(m,o,vi,ci,'exact',100);
 perform set_config('request.jwt.claim.sub',u::text,true);
 perform set_config('kerdos.order_smoke',jsonb_build_object('org',o,'vendor',v,'vi',vi,'mapping',m)::text,true);
end $$;
set local role authenticated;
do $$
declare c jsonb:=current_setting('kerdos.order_smoke')::jsonb; o uuid:=(c->>'org')::uuid; v uuid:=(c->>'vendor')::uuid; vi uuid:=(c->>'vi')::uuid; m uuid:=(c->>'mapping')::uuid; terms jsonb; a jsonb; line jsonb; d jsonb; r jsonb; saved jsonb; replay jsonb; blocked boolean:=false;
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
 set constraints all immediate;
end $$;
rollback;
select (select count(*) from public.estimated_purchase_drafts) as drafts,(select count(*) from public.variable_weight_approvals) as approvals,(select count(*) from public.estimated_draft_submissions) as submissions,(select count(*) from public.purchase_orders) as orders,(select count(*) from public.purchase_order_lines) as lines,(select count(*) from public.organizations where name='KERDOS rollback estimated order fixture') as remaining_fixture_organizations;
