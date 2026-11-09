-- Quote evidence for both invoice writers. Based on live kerdos-test definitions
-- inspected 2026-11-03; preserves authorization, receipt fencing and invoice mapping.
ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS quoted_rate numeric,
  ADD COLUMN IF NOT EXISTS quoted_source_rate numeric,
  ADD COLUMN IF NOT EXISTS quoted_basis text,
  ADD COLUMN IF NOT EXISTS quoted_effective_date date,
  ADD COLUMN IF NOT EXISTS quoted_source text,
  ADD COLUMN IF NOT EXISTS quoted_price_history_id uuid REFERENCES public.price_history(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS quoted_source_document_id uuid REFERENCES public.import_documents(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS quoted_comparison_note text;

CREATE OR REPLACE FUNCTION public.kerdos_auto_record_invoice(p_attachment_id uuid, p_lease_token uuid, p_fingerprint text, p_header jsonb, p_lines jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO ''
AS $function$
DECLARE
  a public.inbound_attachments%rowtype;
  m public.inbound_messages%rowtype;
  v_org uuid := (p_header->>'organization_id')::uuid;
  v_vendor uuid := (p_header->>'vendor_id')::uuid;
  v_invoice uuid;
  v_doc uuid;
  v_existing_text text;
  v_line jsonb;
  v_total numeric := 0;
  v_number text := nullif(btrim(p_header->>'invoice_number'),'');
BEGIN
  SELECT * INTO a FROM public.inbound_attachments WHERE id=p_attachment_id FOR UPDATE;
  IF NOT FOUND OR a.processing_status<>'processing' OR p_lease_token IS NULL
     OR a.processing_lease_token IS DISTINCT FROM p_lease_token THEN
    RAISE EXCEPTION 'LEASE_LOST: invoice rejected by attachment fence';
  END IF;
  SELECT * INTO m FROM public.inbound_messages WHERE id=a.message_id AND organization_id=a.organization_id;
  IF NOT FOUND OR m.vendor_snapshot_at IS NULL OR m.receipt_document_type IS DISTINCT FROM 'invoice'
     OR v_org IS DISTINCT FROM a.organization_id OR v_vendor IS NULL
     OR v_vendor IS DISTINCT FROM m.receipt_vendor_id OR a.ingest_error IS NOT NULL THEN
    RAISE EXCEPTION 'Invoice does not match the receipt-time organization/vendor/type';
  END IF;
  IF NOT EXISTS(SELECT 1 FROM public.vendors WHERE id=v_vendor AND organization_id=v_org) THEN
    RAISE EXCEPTION 'Invoice vendor is outside the organization';
  END IF;
  IF nullif(p_fingerprint,'') IS NULL OR nullif(p_header->>'raw_text','') IS NULL
     OR nullif(p_header->>'invoice_date','') IS NULL
     OR (p_header->>'file_path') IS DISTINCT FROM a.storage_path
     OR (p_header->>'file_name') IS DISTINCT FROM a.filename THEN
    RAISE EXCEPTION 'Invoice date, original, fingerprint and source text are required';
  END IF;
  IF jsonb_typeof(p_lines) IS DISTINCT FROM 'array' THEN RAISE EXCEPTION 'Invoice lines must be an array'; END IF;
  IF jsonb_array_length(p_lines)=0 THEN RAISE EXCEPTION 'An invoice requires at least one line'; END IF;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP
    IF nullif(btrim(v_line->>'description'),'') IS NULL
       OR (v_line->>'quantity') IS NULL OR (v_line->>'unit_price') IS NULL OR (v_line->>'line_total') IS NULL
       OR (v_line->>'quantity')::numeric<=0 OR (v_line->>'unit_price')::numeric<0
       OR (v_line->>'quantity') IN ('NaN','Infinity','-Infinity')
       OR (v_line->>'unit_price') IN ('NaN','Infinity','-Infinity')
       OR (v_line->>'line_total') IN ('NaN','Infinity','-Infinity')
       OR abs(round((v_line->>'quantity')::numeric*(v_line->>'unit_price')::numeric,2)-(v_line->>'line_total')::numeric)>0.025 THEN
      RAISE EXCEPTION 'Invoice line quantity, price and amount must reconcile';
    END IF;
    IF coalesce((v_line->>'match_confidence')::numeric,0)<90
       OR NOT EXISTS(SELECT 1 FROM public.vendor_items vi WHERE vi.id=(v_line->>'vendor_item_id')::uuid
         AND vi.organization_id=v_org AND vi.vendor_id=v_vendor) THEN
      RAISE EXCEPTION 'Invoice line needs a verified product in the receipt vendor/organization';
    END IF;
    IF nullif(v_line->>'selling_unit','') IS NULL OR jsonb_typeof(v_line->'billing_unit_evidence') IS DISTINCT FROM 'object'
       OR (v_line->'billing_unit_evidence'->>'unit') IS DISTINCT FROM (v_line->>'selling_unit') THEN
      RAISE EXCEPTION 'Invoice line needs source evidence of its billed unit';
    END IF;
    v_total:=v_total+(v_line->>'line_total')::numeric;
  END LOOP;
  IF (p_header->>'total_amount') IS NULL OR (p_header->>'total_amount') IN ('NaN','Infinity','-Infinity')
     OR abs(round(v_total,2)-(p_header->>'total_amount')::numeric)>0.025 THEN
    RAISE EXCEPTION 'Invoice header total must reconcile with its lines';
  END IF;

  -- Serializes separate attachments of the same invoice as well as worker retries.
  PERFORM pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended(
    v_org::text||':'||v_vendor::text||':'||coalesce(v_number,p_header->>'raw_text'),0));
  SELECT id,source_document_id,raw_text INTO v_invoice,v_doc,v_existing_text
    FROM public.invoices WHERE organization_id=v_org AND vendor_id=v_vendor
      AND ((v_number IS NOT NULL AND invoice_number=v_number)
        OR (v_number IS NULL AND raw_text=p_header->>'raw_text'))
    ORDER BY created_at LIMIT 1 FOR UPDATE;
  IF v_invoice IS NOT NULL THEN
    IF v_existing_text IS DISTINCT FROM (p_header->>'raw_text') OR v_doc IS NULL
       OR NOT EXISTS(SELECT 1 FROM public.import_documents d WHERE d.id=v_doc
         AND d.organization_id=v_org AND d.vendor_id=v_vendor AND d.document_kind='invoice' AND d.status='complete')
       OR NOT EXISTS(SELECT 1 FROM public.invoice_lines l WHERE l.invoice_id=v_invoice) THEN
      RAISE EXCEPTION 'Existing invoice requires reconciliation; no duplicate created';
    END IF;
    PERFORM public.set_attachment_processing_status(p_attachment_id,'auto_imported',NULL,v_doc);
    RETURN v_invoice;
  END IF;

  SELECT id INTO v_doc FROM public.import_documents WHERE organization_id=v_org AND vendor_id=v_vendor
    AND document_kind='invoice' AND fingerprint=p_fingerprint FOR UPDATE;
  IF v_doc IS NULL THEN
    INSERT INTO public.import_documents(organization_id,vendor_id,document_kind,fingerprint,original_text,file_name,file_path,status)
    VALUES(v_org,v_vendor,'invoice',p_fingerprint,p_header->>'raw_text',a.filename,a.storage_path,'processing') RETURNING id INTO v_doc;
  END IF;
  INSERT INTO public.invoices(organization_id,vendor_id,invoice_number,invoice_date,total_amount,raw_text,status,file_path,file_name,source_document_id)
  VALUES(v_org,v_vendor,v_number,(p_header->>'invoice_date')::date,round(v_total,2),p_header->>'raw_text','recorded',a.storage_path,a.filename,v_doc)
  RETURNING id INTO v_invoice;
  FOR v_line IN SELECT value FROM jsonb_array_elements(p_lines) LOOP

    -- Provenance must refer to this exact vendor listing and source document.
    IF nullif(v_line->>'quoted_comparison_note','') IS NOT NULL THEN
      IF v_line->>'quoted_comparison_note' NOT IN ('no_eligible_quote','quote_expired',
        'source_ineligible','unknown_billed_unit','basis_incompatible','lookup_error',
        'client_window_exceeded','invalid_rate') THEN
        RAISE EXCEPTION 'Unknown quote comparison note';
      END IF;
      IF nullif(v_line->>'price_variance','') IS NOT NULL OR nullif(v_line->>'quoted_rate','') IS NOT NULL THEN
        RAISE EXCEPTION 'Unperformed comparison cannot contain a variance or compared rate';
      END IF;
    END IF;
    IF nullif(v_line->>'quoted_rate','') IS NOT NULL THEN
      IF v_line->>'quoted_rate' IN ('NaN','Infinity','-Infinity')
         OR (v_line->>'quoted_rate')::numeric<0
         OR nullif(v_line->>'price_variance','') IS NULL
         OR (v_line->>'price_variance')::numeric IS DISTINCT FROM
            round((v_line->>'unit_price')::numeric-(v_line->>'quoted_rate')::numeric,2) THEN
        RAISE EXCEPTION 'Quote comparison rate and variance must reconcile';
      END IF;
    END IF;
    IF nullif(v_line->>'quoted_price_history_id','') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.price_history ph
      WHERE ph.id=(v_line->>'quoted_price_history_id')::uuid
        AND ph.organization_id=v_org AND ph.vendor_item_id=(v_line->>'vendor_item_id')::uuid
        AND ph.source_document_id IS NOT DISTINCT FROM nullif(v_line->>'quoted_source_document_id','')::uuid
        AND ph.price IS NOT DISTINCT FROM nullif(v_line->>'quoted_source_rate','')::numeric
        AND ph.price_basis IS NOT DISTINCT FROM nullif(v_line->>'quoted_basis','')
        AND ph.source IS NOT DISTINCT FROM nullif(v_line->>'quoted_source','')
        AND ph.effective_date::date IS NOT DISTINCT FROM nullif(v_line->>'quoted_effective_date','')::date
    ) THEN RAISE EXCEPTION 'Quote evidence does not match this organization, vendor item and source'; END IF;
    IF nullif(v_line->>'quoted_source_document_id','') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.import_documents d
      WHERE d.id=(v_line->>'quoted_source_document_id')::uuid
        AND d.organization_id=v_org AND d.vendor_id=v_vendor
    ) THEN RAISE EXCEPTION 'Quote document is outside this organization/vendor'; END IF;

    INSERT INTO public.invoice_lines(invoice_id,vendor_item_id,vendor_item_code,description,quantity,unit_price,line_total,
      price_variance,match_confidence,match_method,selling_unit,pack_size,source_line,billing_unit_evidence,quantity_source,billed_quantity_evidence,
      quoted_rate,quoted_source_rate,quoted_basis,quoted_effective_date,quoted_source,quoted_price_history_id,quoted_source_document_id,quoted_comparison_note)
    VALUES(v_invoice,(v_line->>'vendor_item_id')::uuid,nullif(v_line->>'vendor_item_code',''),v_line->>'description',
      (v_line->>'quantity')::numeric,(v_line->>'unit_price')::numeric,(v_line->>'line_total')::numeric,
      nullif(v_line->>'price_variance','')::numeric,(v_line->>'match_confidence')::numeric,v_line->>'match_method',v_line->>'selling_unit',v_line->>'pack_size',
      v_line->>'source_line',v_line->'billing_unit_evidence',nullif(v_line->'quantity_source','null'::jsonb),nullif(v_line->'billed_quantity_evidence','null'::jsonb),
      nullif(v_line->>'quoted_rate','')::numeric,
      nullif(v_line->>'quoted_source_rate','')::numeric,
      nullif(v_line->>'quoted_basis',''),
      nullif(v_line->>'quoted_effective_date','')::date,
      nullif(v_line->>'quoted_source',''),
      nullif(v_line->>'quoted_price_history_id','')::uuid,
      nullif(v_line->>'quoted_source_document_id','')::uuid,
      nullif(v_line->>'quoted_comparison_note',''));
  END LOOP;
  UPDATE public.import_documents SET status='complete',completed_keys=(SELECT jsonb_agg('row:'||n::text)
    FROM generate_series(0,jsonb_array_length(p_lines)-1) n) WHERE id=v_doc;
  PERFORM public.set_attachment_processing_status(p_attachment_id,'auto_imported',NULL,v_doc);
  RETURN v_invoice;
END;
$function$;

CREATE OR REPLACE FUNCTION public.kerdos_record_invoice(p_header jsonb, p_lines jsonb)
 RETURNS uuid
 LANGUAGE plpgsql
 SET search_path TO 'public'
AS $function$
declare
  v_invoice_id uuid;
  v_line jsonb;
  v_vendor_item_id uuid;
begin
  if auth.uid() is null then raise exception 'Authentication is required'; end if;
  if nullif(p_header->>'organization_id','') is null or nullif(p_header->>'vendor_id','') is null then
    raise exception 'Invoice organization and vendor are required';
  end if;
  if not exists (
    select 1 from organization_members m
    where m.organization_id=(p_header->>'organization_id')::uuid
      and m.user_id=auth.uid() and m.role in ('owner','manager')
  ) then raise exception 'Owner or manager access is required for this organization'; end if;
  if not exists (
    select 1 from vendors v
    where v.id=(p_header->>'vendor_id')::uuid
      and v.organization_id=(p_header->>'organization_id')::uuid
  ) then raise exception 'Vendor is outside the requested organization'; end if;
  if jsonb_typeof(p_lines) <> 'array' or jsonb_array_length(p_lines)=0 then
    raise exception 'An invoice requires at least one line';
  end if;

  insert into invoices(
    organization_id,vendor_id,total_amount,raw_text,invoice_date,
    invoice_number,status,file_path,file_name
  ) values (
    (p_header->>'organization_id')::uuid,(p_header->>'vendor_id')::uuid,
    (p_header->>'total_amount')::numeric,p_header->>'raw_text',
    (p_header->>'invoice_date')::date,nullif(p_header->>'invoice_number',''),
    'recorded',nullif(p_header->>'file_path',''),nullif(p_header->>'file_name','')
  ) returning id into v_invoice_id;

  for v_line in select value from jsonb_array_elements(p_lines) loop
    v_vendor_item_id=nullif(v_line->>'vendor_item_id','')::uuid;
    if v_vendor_item_id is not null and not exists (
      select 1 from vendor_items vi
      where vi.id=v_vendor_item_id
        and vi.organization_id=(p_header->>'organization_id')::uuid
        and vi.vendor_id=(p_header->>'vendor_id')::uuid
    ) then raise exception 'Invoice vendor item is outside the requested organization/vendor'; end if;
    if nullif(v_line->>'catalog_item_id','') is not null and not exists (
      select 1 from catalog_items ci
      where ci.id=(v_line->>'catalog_item_id')::uuid
        and ci.organization_id=(p_header->>'organization_id')::uuid
    ) then raise exception 'Catalog item is outside the requested organization'; end if;
    if v_vendor_item_id is null and coalesce((v_line->>'create_vendor_item')::boolean,false) then
      select id into v_vendor_item_id from vendor_items
      where organization_id=(p_header->>'organization_id')::uuid
        and vendor_id=(p_header->>'vendor_id')::uuid
        and ((nullif(v_line->>'vendor_item_code','') is not null and vendor_item_code=v_line->>'vendor_item_code')
          or (nullif(v_line->>'vendor_item_code','') is null and vendor_item_code is null
            and description=v_line->>'description'
            and pack_size is not distinct from nullif(v_line->>'pack_size','')))
      limit 1;
      if v_vendor_item_id is null then
        insert into vendor_items(
        organization_id,vendor_id,vendor_item_code,description,pack_size,price,last_updated,price_source
        ) values (
          (p_header->>'organization_id')::uuid,(p_header->>'vendor_id')::uuid,
          nullif(v_line->>'vendor_item_code',''),v_line->>'description',nullif(v_line->>'pack_size',''),
          (v_line->>'unit_price')::numeric,(p_header->>'invoice_date')::date,'invoice'
        ) returning id into v_vendor_item_id;
      end if;

    end if;
    -- This also repairs an existing vendor listing that has no catalog link.
    -- Never replace a previously approved association with a new guess.
    if v_vendor_item_id is not null and nullif(v_line->>'catalog_item_id','') is not null then
      insert into item_mappings(
        organization_id,catalog_item_id,vendor_item_id,confidence_score,match_method,comparison_track
      ) values (
        (p_header->>'organization_id')::uuid,(v_line->>'catalog_item_id')::uuid,v_vendor_item_id,
        coalesce((v_line->>'catalog_confidence')::integer,0),'rule_based',
        coalesce(nullif(v_line->>'catalog_track',''),'new')
      ) on conflict do nothing;
    end if;


    -- Provenance must refer to this exact vendor listing and source document.
    IF nullif(v_line->>'quoted_comparison_note','') IS NOT NULL THEN
      IF v_line->>'quoted_comparison_note' NOT IN ('no_eligible_quote','quote_expired',
        'source_ineligible','unknown_billed_unit','basis_incompatible','lookup_error',
        'client_window_exceeded','invalid_rate') THEN
        RAISE EXCEPTION 'Unknown quote comparison note';
      END IF;
      IF nullif(v_line->>'price_variance','') IS NOT NULL OR nullif(v_line->>'quoted_rate','') IS NOT NULL THEN
        RAISE EXCEPTION 'Unperformed comparison cannot contain a variance or compared rate';
      END IF;
    END IF;
    IF nullif(v_line->>'quoted_rate','') IS NOT NULL THEN
      IF v_line->>'quoted_rate' IN ('NaN','Infinity','-Infinity')
         OR (v_line->>'quoted_rate')::numeric<0
         OR nullif(v_line->>'price_variance','') IS NULL
         OR (v_line->>'price_variance')::numeric IS DISTINCT FROM
            round((v_line->>'unit_price')::numeric-(v_line->>'quoted_rate')::numeric,2) THEN
        RAISE EXCEPTION 'Quote comparison rate and variance must reconcile';
      END IF;
    END IF;
    IF nullif(v_line->>'quoted_price_history_id','') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.price_history ph
      WHERE ph.id=(v_line->>'quoted_price_history_id')::uuid
        AND ph.organization_id=(p_header->>'organization_id')::uuid AND ph.vendor_item_id=v_vendor_item_id
        AND ph.source_document_id IS NOT DISTINCT FROM nullif(v_line->>'quoted_source_document_id','')::uuid
        AND ph.price IS NOT DISTINCT FROM nullif(v_line->>'quoted_source_rate','')::numeric
        AND ph.price_basis IS NOT DISTINCT FROM nullif(v_line->>'quoted_basis','')
        AND ph.source IS NOT DISTINCT FROM nullif(v_line->>'quoted_source','')
        AND ph.effective_date::date IS NOT DISTINCT FROM nullif(v_line->>'quoted_effective_date','')::date
    ) THEN RAISE EXCEPTION 'Quote evidence does not match this organization, vendor item and source'; END IF;
    IF nullif(v_line->>'quoted_source_document_id','') IS NOT NULL AND NOT EXISTS (
      SELECT 1 FROM public.import_documents d
      WHERE d.id=(v_line->>'quoted_source_document_id')::uuid
        AND d.organization_id=(p_header->>'organization_id')::uuid AND d.vendor_id=(p_header->>'vendor_id')::uuid
    ) THEN RAISE EXCEPTION 'Quote document is outside this organization/vendor'; END IF;

    insert into invoice_lines(
      invoice_id,vendor_item_id,vendor_item_code,description,unit_price,
      line_total,price_variance,match_confidence,match_method,
      quantity,selling_unit,pack_size,source_line,billing_unit_evidence,quantity_source,billed_quantity_evidence,
      quoted_rate,quoted_source_rate,quoted_basis,quoted_effective_date,quoted_source,quoted_price_history_id,quoted_source_document_id,quoted_comparison_note
    ) values (
      v_invoice_id,v_vendor_item_id,nullif(v_line->>'vendor_item_code',''),v_line->>'description',
      (v_line->>'unit_price')::numeric,(v_line->>'line_total')::numeric,
      nullif(v_line->>'price_variance','')::numeric,nullif(v_line->>'match_confidence','')::integer,
      nullif(v_line->>'match_method',''),
      nullif(v_line->>'quantity','')::numeric,nullif(v_line->>'selling_unit',''),
      nullif(v_line->>'pack_size',''),v_line->>'source_line',
      nullif(v_line->'billing_unit_evidence','null'::jsonb),nullif(v_line->'quantity_source','null'::jsonb),nullif(v_line->'billed_quantity_evidence','null'::jsonb),
      nullif(v_line->>'quoted_rate','')::numeric,
      nullif(v_line->>'quoted_source_rate','')::numeric,
      nullif(v_line->>'quoted_basis',''),
      nullif(v_line->>'quoted_effective_date','')::date,
      nullif(v_line->>'quoted_source',''),
      nullif(v_line->>'quoted_price_history_id','')::uuid,
      nullif(v_line->>'quoted_source_document_id','')::uuid,
      nullif(v_line->>'quoted_comparison_note','')
    );
  end loop;

  return v_invoice_id;
end;
$function$;

-- Existing grants and security-invoker behavior are preserved by CREATE OR REPLACE.
