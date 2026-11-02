-- kerdos-test only. Database role simulation, not signed-in browser acceptance.
-- Every fixture and purchase record rolls back. No email or portal operation.
begin;
set local lock_timeout='3s';
set local statement_timeout='20s';
do $$
declare o uuid:=gen_random_uuid(); v uuid:=gen_random_uuid(); ci uuid:=gen_random_uuid(); category uuid:=gen_random_uuid(); vi uuid:=gen_random_uuid(); m uuid:=gen_random_uuid(); doc uuid:=gen_random_uuid(); inv1 uuid:=gen_random_uuid(); inv2 uuid:=gen_random_uuid(); inv3 uuid:=gen_random_uuid(); il1 uuid:=gen_random_uuid(); il2 uuid:=gen_random_uuid(); il3 uuid:=gen_random_uuid(); qs jsonb; u uuid; source jsonb; proof jsonb;
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
 insert into public.invoices(id,organization_id,vendor_id,invoice_number,invoice_date,total_amount,raw_text,status) values(inv1,o,v,'SYN-RECEIPT-1',current_date,56,E'Subtotal 56.00\nTax 0.00\nFreight 0.00\nCredits 0.00\nInvoice Total 56.00','recorded'),(inv2,o,v,'SYN-RECEIPT-2',current_date,70,'Controlled second partial invoice','recorded'),(inv3,o,v,'SYN-RECEIPT-CORRECTED',current_date,90,E'Subtotal 84.00\nTax 5.00\nFreight 2.00\nCredits 1.00\nInvoice Total 90.00','recorded');
 qs:=jsonb_build_object('kind','quantity-column','header','Billed Weight','rawValue','14','columnIndex',2,'headerLine',E'Code\tPrice Unit\tBilled Weight\tUnit Price\tExtended Price');
 insert into public.invoice_lines(id,invoice_id,vendor_item_id,vendor_item_code,description,quantity,unit_price,line_total,selling_unit,source_line,billing_unit_evidence,quantity_source,match_confidence,match_method) values
 (il1,inv1,vi,'SYN-ORDER','Synthetic order rollback material',14,4,56,'LB',E'SYN-ORDER\tLB\t14\t4\t56',jsonb_build_object('kind','pricing-unit-header','header','Price Unit','unit','LB'),qs,100,'code'),
 (il2,inv2,vi,'SYN-ORDER','Synthetic order rollback material',14,5,70,'LB',E'SYN-ORDER\tLB\t14\t5\t70',jsonb_build_object('kind','pricing-unit-header','header','Price Unit','unit','LB'),qs,100,'code'),
 (il3,inv3,vi,'SYN-ORDER','Synthetic order rollback material',14,6,84,'LB',E'SYN-ORDER\tLB\t14\t6\t84',jsonb_build_object('kind','pricing-unit-header','header','Price Unit','unit','LB'),qs,100,'code');
 perform set_config('request.jwt.claim.sub',u::text,true);
 perform set_config('kerdos.order_smoke',jsonb_build_object('org',o,'vendor',v,'vi',vi,'mapping',m,'il1',il1,'il2',il2,'il3',il3)::text,true);
end $$;
set local role authenticated;
do $$
declare c jsonb:=current_setting('kerdos.order_smoke')::jsonb; o uuid:=(c->>'org')::uuid; v uuid:=(c->>'vendor')::uuid; vi uuid:=(c->>'vi')::uuid; m uuid:=(c->>'mapping')::uuid; terms jsonb; a jsonb; line jsonb; d jsonb; r jsonb; saved jsonb; replay jsonb; blocked boolean:=false; review1 jsonb; review2 jsonb; receipt1 jsonb; receipt2 jsonb; reversal jsonb; history jsonb; replacement_review jsonb; replaced jsonb; invoice_review jsonb; approval_review jsonb; approval jsonb; withdrawal jsonb; withdrawn_approval jsonb; request_id uuid:=gen_random_uuid(); pay_request1 uuid:=gen_random_uuid(); pay_request2 uuid:=gen_random_uuid(); pay_review1 jsonb; pay_review2 jsonb; payment1 jsonb; payment2 jsonb; payment3 jsonb; payment_reversal jsonb; payment_ledger jsonb; corrected_review jsonb; corrected_payment jsonb; correction_request_id uuid:=gen_random_uuid(); ol uuid;
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
 select public.kerdos_review_invoice_approval(o,invoice_id) into approval_review from public.invoice_lines where id=(c->>'il1')::uuid;
 if approval_review->'gate'->'eligible' is distinct from 'true'::jsonb then raise exception 'Clean hosted invoice was not eligible for accounting approval';end if;
 approval:=public.kerdos_save_invoice_approval(o,(approval_review->'source'->>'invoiceId')::uuid,request_id,approval_review->'source','Reviewed retained source and receipt',true);
 if public.kerdos_save_invoice_approval(o,(approval_review->'source'->>'invoiceId')::uuid,request_id,approval_review->'source','Reviewed retained source and receipt',true)<>approval then raise exception 'Approval replay changed identity';end if;
 withdrawn_approval:=approval;
 withdrawal:=public.kerdos_withdraw_invoice_approval(o,(approval->>'id')::uuid,'Approval requires a fresh accounting review',true);
 if public.kerdos_withdraw_invoice_approval(o,(approval->>'id')::uuid,'Approval requires a fresh accounting review',true)<>withdrawal then raise exception 'Withdrawal replay changed identity';end if;
 select public.kerdos_review_invoice_approval(o,invoice_id) into approval_review from public.invoice_lines where id=(c->>'il1')::uuid;
 if jsonb_array_length(approval_review->'approvals')<>0 then raise exception 'Legacy reader counted withdrawn approval';end if;
 select public.kerdos_review_invoice_approval_audit(o,invoice_id) into approval_review from public.invoice_lines where id=(c->>'il1')::uuid;
 if jsonb_array_length(approval_review->'approvals')<>1 or jsonb_array_length(approval_review->'withdrawals')<>1 or approval_review->'withdrawals'->0 is distinct from withdrawal then raise exception 'Complete withdrawal audit was not retained';end if;
 if public.kerdos_save_invoice_approval(o,(approval_review->'source'->>'invoiceId')::uuid,request_id,approval_review->'source','Reviewed retained source and receipt',true)<>withdrawn_approval then raise exception 'Historical withdrawn approval replay changed';end if;
 request_id:=gen_random_uuid();
 approval:=public.kerdos_save_invoice_approval(o,(approval_review->'source'->>'invoiceId')::uuid,request_id,approval_review->'source','Fresh approval after withdrawal',true);
 if approval->>'id'=withdrawn_approval->>'id' then raise exception 'Reapproval reused withdrawn identity';end if;
 select public.kerdos_review_invoice_approval(o,invoice_id) into approval_review from public.invoice_lines where id=(c->>'il1')::uuid;
 if jsonb_array_length(approval_review->'approvals')<>1 or approval_review->'approvals'->0 is distinct from approval then raise exception 'Fresh reapproval did not preserve legacy current status';end if;
 pay_review1:=public.kerdos_review_invoice_payment(o,(approval->>'invoiceId')::uuid,(approval->>'id')::uuid,2000,current_date,'check','SYN-CHECK-1');
 payment1:=public.kerdos_save_invoice_payment(o,pay_request1,pay_review1,true);
 if public.kerdos_save_invoice_payment(o,pay_request1,pay_review1,true)<>payment1 then raise exception 'Payment replay changed identity';end if;
 pay_review2:=public.kerdos_review_invoice_payment(o,(approval->>'invoiceId')::uuid,(approval->>'id')::uuid,3600,current_date,'check','SYN-CHECK-2');
 if (pay_review2->>'remainingCents')::numeric<>3600 then raise exception 'Partial payment balance failed';end if;
 payment2:=public.kerdos_save_invoice_payment(o,pay_request2,pay_review2,true);
 blocked:=false;begin perform public.kerdos_review_invoice_payment(o,(approval->>'invoiceId')::uuid,(approval->>'id')::uuid,1,current_date,'check','SYN-EXCESS');exception when raise_exception then if sqlerrm like '%remaining approved%' then blocked:=true;else raise;end if;end;
 if not blocked then raise exception 'Invoice overpayment was not denied';end if;
 payment_reversal:=public.kerdos_reverse_invoice_payment(o,(payment2->>'id')::uuid,'Correcting synthetic recorded payment',true);
 if public.kerdos_reverse_invoice_payment(o,(payment2->>'id')::uuid,'Correcting synthetic recorded payment',true)<>payment_reversal then raise exception 'Payment reversal replay changed identity';end if;
 blocked:=false;begin perform public.kerdos_review_invoice_payment(o,(approval->>'invoiceId')::uuid,(approval->>'id')::uuid,1,current_date,'check','syn-check-2');exception when raise_exception then if sqlerrm like '%reference is already%' then blocked:=true;else raise;end if;end;
 if not blocked then raise exception 'Reversed payment reference reservation was lost';end if;

 corrected_review:=public.kerdos_review_invoice_payment_correction(o,(approval->>'invoiceId')::uuid,(approval->>'id')::uuid,(payment2->>'id')::uuid,3500,current_date,'check','Correcting amount under original reference');
 corrected_payment:=public.kerdos_save_invoice_payment_correction(o,correction_request_id,corrected_review,true,true);
 if public.kerdos_save_invoice_payment_correction(o,correction_request_id,corrected_review,true,true)<>corrected_payment or corrected_payment->>'reference'<>payment2->>'reference' or corrected_payment->'sourceReview'->'correction'->>'paymentId'<>payment2->>'id' then raise exception 'Same-reference correction audit or replay failed';end if;
 if (select sum(p.paid_cents) from public.invoice_payments p where p.invoice_id=(approval->>'invoiceId')::uuid and not exists(select 1 from public.invoice_payment_reversals r where r.payment_id=p.id))<>5500 then raise exception 'Corrected partial balance failed';end if;
 perform public.kerdos_reverse_invoice_payment(o,(corrected_payment->>'id')::uuid,'A second correction needs a fresh record',true);
 payment3:=public.kerdos_save_invoice_payment_correction(o,gen_random_uuid(),public.kerdos_review_invoice_payment_correction(o,(approval->>'invoiceId')::uuid,(approval->>'id')::uuid,(corrected_payment->>'id')::uuid,3600,current_date,'check','Second correction under original reference'),true,true);
 if public.kerdos_save_invoice_payment_correction(o,correction_request_id,corrected_review,true,true)<>corrected_payment then raise exception 'Historical correction replay changed identity';end if;

 payment_ledger:=public.kerdos_invoice_payment_ledger(o,(approval->>'invoiceId')::uuid);
 if jsonb_array_length(payment_ledger->'payments')<>4 or jsonb_array_length(payment_ledger->'reversals')<>2 or (select sum(p.paid_cents) from public.invoice_payments p where p.invoice_id=(approval->>'invoiceId')::uuid and not exists(select 1 from public.invoice_payment_reversals r where r.payment_id=p.id))<>5600 then raise exception 'Full recorded payment coverage failed';end if;
 blocked:=false;begin delete from public.invoice_payments where id=(payment1->>'id')::uuid;exception when insufficient_privilege then blocked:=true;end;
 if not blocked then raise exception 'Payment deletion was not denied';end if;

 blocked:=false;begin delete from public.invoice_approval_withdrawals where id=(withdrawal->>'id')::uuid;exception when insufficient_privilege then blocked:=true;end;
 if not blocked then raise exception 'Withdrawal deletion was not denied';end if;


 if (select sum(received_cases) from public.estimated_order_receipts where order_id=(saved->>'id')::uuid)<>1 then raise exception 'Partial receipt case count failed';end if;
 review2:=public.kerdos_review_estimated_receipt(o,ol,(c->>'il2')::uuid,1);
 receipt2:=public.kerdos_save_estimated_receipt(o,ol,(c->>'il2')::uuid,1,review2,true,true);
 if (receipt1->>'actualCharge')::numeric<>56 or (receipt2->>'actualCharge')::numeric<>70 or (receipt2->>'rateVariance')::numeric<>14 then raise exception 'Invoice charges or quoted variance failed';end if;
 if (select sum(received_cases) from public.estimated_order_receipts where order_id=(saved->>'id')::uuid)<>2 or (select sum((snapshot->>'actualCharge')::numeric) from public.estimated_order_receipts where order_id=(saved->>'id')::uuid)<>126 then raise exception 'Complete linked item charges failed';end if;
 blocked:=false;begin update public.invoice_lines set unit_price=5 where id=(c->>'il1')::uuid;exception when raise_exception then if sqlerrm like '%immutable%' then blocked:=true;else raise;end if;end;
 if not blocked then raise exception 'Receipt invoice mutation was not blocked';end if;
 reversal:=public.kerdos_reverse_estimated_receipt(o,(receipt1->>'id')::uuid,'Incorrect physical case confirmation',true);
 if public.kerdos_reverse_estimated_receipt(o,(receipt1->>'id')::uuid,'Incorrect physical case confirmation',true)<>reversal then raise exception 'Reversal replay changed identity';end if;
 select public.kerdos_review_invoice_approval(o,invoice_id) into approval_review from public.invoice_lines where id=(c->>'il1')::uuid;
 if approval_review->'gate'->'eligible' is distinct from 'false'::jsonb or jsonb_array_length(approval_review->'approvals')<>1 or approval_review->'approvals'->0 is distinct from approval then raise exception 'Approval audit or reversal invalidation failed';end if;
 blocked:=false;begin perform public.kerdos_save_invoice_approval(o,(approval_review->'source'->>'invoiceId')::uuid,gen_random_uuid(),approval_review->'source','',true);exception when raise_exception then if sqlerrm like '%does not pass%' then blocked:=true;else raise;end if;end;
 if not blocked then raise exception 'Incomplete invoice approval was not denied';end if;
 payment_ledger:=public.kerdos_invoice_payment_ledger(o,(approval->>'invoiceId')::uuid);
 if payment_ledger->'approvalReview'->'gate'->'eligible' is distinct from 'false'::jsonb or jsonb_array_length(payment_ledger->'payments')<>4 then raise exception 'Payment history was lost after receipt reversal';end if;

 blocked:=false;begin delete from public.invoice_accounting_approvals where id=(approval->>'id')::uuid;exception when insufficient_privilege then blocked:=true;end;
 if not blocked then raise exception 'Approval deletion was not denied';end if;
 history:=public.kerdos_estimated_receipt_history(o,(saved->>'id')::uuid);
 if jsonb_array_length(history->'receipts')<>2 or jsonb_array_length(history->'reversals')<>1 then raise exception 'Reversal audit history failed';end if;
 if (select sum(er.received_cases) from public.estimated_order_receipts er where er.order_id=(saved->>'id')::uuid and not exists(select 1 from public.estimated_receipt_reversals rv where rv.receipt_id=er.id))<>1 then raise exception 'Reversal did not restore case capacity';end if;
 if (select sum((er.snapshot->>'actualCharge')::numeric) from public.estimated_order_receipts er where er.order_id=(saved->>'id')::uuid and not exists(select 1 from public.estimated_receipt_reversals rv where rv.receipt_id=er.id))<>70 then raise exception 'Reversal did not exclude charges';end if;
 blocked:=false;begin perform public.kerdos_review_estimated_receipt(o,ol,(c->>'il1')::uuid,1);exception when raise_exception then if sqlerrm like '%already linked%' then blocked:=true;else raise;end if;end;
 if not blocked then raise exception 'Reversed invoice reservation was lost';end if;
 blocked:=false;begin delete from public.estimated_receipt_reversals where receipt_id=(receipt1->>'id')::uuid;exception when insufficient_privilege then blocked:=true;end;
 if not blocked then raise exception 'Reversal deletion was not denied';end if;
 replacement_review:=public.kerdos_review_estimated_receipt(o,ol,(c->>'il3')::uuid,1);
 replaced:=public.kerdos_replace_estimated_receipt(o,(receipt1->>'id')::uuid,ol,(c->>'il3')::uuid,1,replacement_review,'Corrected invoice source supplied by vendor',true,true,true);
 if public.kerdos_replace_estimated_receipt(o,(receipt1->>'id')::uuid,ol,(c->>'il3')::uuid,1,replacement_review,'Corrected invoice source supplied by vendor',true,true,true)<>replaced then raise exception 'Replacement replay changed identity';end if;
 history:=public.kerdos_estimated_receipt_history(o,(saved->>'id')::uuid);
 if jsonb_array_length(history->'receipts')<>3 or jsonb_array_length(history->'reversals')<>1 or jsonb_array_length(history->'replacements')<>1 or history->'replacements'->0->>'predecessorId'<>receipt1->>'id' then raise exception 'Replacement lineage was not retained';end if;
 if (select sum((er.snapshot->>'actualCharge')::numeric) from public.estimated_order_receipts er where er.order_id=(saved->>'id')::uuid and not exists(select 1 from public.estimated_receipt_reversals rv where rv.receipt_id=er.id))<>154 then raise exception 'Replacement charge summary failed';end if;
 blocked:=false;begin delete from public.estimated_receipt_replacements where predecessor_id=(receipt1->>'id')::uuid;exception when insufficient_privilege then blocked:=true;end;
 if not blocked then raise exception 'Replacement deletion was not denied';end if;
 select public.kerdos_review_invoice_reconciliation(o,invoice_id) into invoice_review from public.invoice_lines where id=(c->>'il3')::uuid;
 if invoice_review->>'kind'<>'invoice_reconciliation_source' or (invoice_review->'header'->>'recordedTotal')::numeric<>90 or jsonb_array_length(invoice_review->'lines')<>1 or jsonb_array_length(invoice_review->'receipts')<>1 or jsonb_array_length(invoice_review->'reversals')<>0 or invoice_review->'header'->>'rawText' not like '%Tax 5.00%' then raise exception 'Full invoice summary/source/receipt snapshot failed';end if;
 if (invoice_review->'lines'->0->>'amount')::numeric<>84 or (select count(*) from public.estimated_order_receipts where order_id=(saved->>'id')::uuid)<>3 then raise exception 'Invoice review changed receipts or lost item amount';end if;
 set constraints all immediate;
end $$;
rollback;
select (select count(*) from public.invoice_payments) as payment_records,(select count(*) from public.invoice_payment_reversals) as payment_reversals,(select count(*) from public.invoice_approval_withdrawals) as approval_withdrawals,(select count(*) from public.invoice_accounting_approvals) as approvals,(select count(*) from public.estimated_receipt_replacements) as replacements,(select count(*) from public.estimated_receipt_reversals) as reversals,(select count(*) from public.estimated_order_receipts) as receipts,(select count(*) from public.purchase_orders) as orders,(select count(*) from public.invoices) as invoices,(select count(*) from public.invoice_lines) as invoice_lines,(select count(*) from public.organizations where name='KERDOS rollback receipt fixture') as fixture_organizations;
