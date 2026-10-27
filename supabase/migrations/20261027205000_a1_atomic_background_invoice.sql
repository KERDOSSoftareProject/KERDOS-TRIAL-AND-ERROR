-- Applied to kerdos-test as 20261027212432 on October 27, 2026.
-- Requires migration_039_routing_document_type.sql first.
-- Service-only atomic invoice ingestion. Existing interactive RPC is unchanged.
-- No new table or RLS policy; caller is the worker service role.
ALTER TABLE public.invoices ADD COLUMN IF NOT EXISTS source_document_id uuid REFERENCES public.import_documents(id);
CREATE UNIQUE INDEX IF NOT EXISTS invoices_source_document_unique ON public.invoices(source_document_id) WHERE source_document_id IS NOT NULL;
ALTER TABLE public.invoice_lines
  ADD COLUMN IF NOT EXISTS selling_unit text,
  ADD COLUMN IF NOT EXISTS pack_size text,
  ADD COLUMN IF NOT EXISTS source_line text,
  ADD COLUMN IF NOT EXISTS billing_unit_evidence jsonb;

CREATE OR REPLACE FUNCTION public.kerdos_auto_record_invoice(
  p_attachment_id uuid,p_lease_token uuid,p_fingerprint text,p_header jsonb,p_lines jsonb
) RETURNS uuid LANGUAGE plpgsql SECURITY INVOKER SET search_path = '' AS $$
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
    INSERT INTO public.invoice_lines(invoice_id,vendor_item_id,vendor_item_code,description,quantity,unit_price,line_total,
      price_variance,match_confidence,match_method,selling_unit,pack_size,source_line,billing_unit_evidence)
    VALUES(v_invoice,(v_line->>'vendor_item_id')::uuid,nullif(v_line->>'vendor_item_code',''),v_line->>'description',
      (v_line->>'quantity')::numeric,(v_line->>'unit_price')::numeric,(v_line->>'line_total')::numeric,
      NULL,(v_line->>'match_confidence')::numeric,v_line->>'match_method',v_line->>'selling_unit',v_line->>'pack_size',
      v_line->>'source_line',v_line->'billing_unit_evidence');
  END LOOP;
  UPDATE public.import_documents SET status='complete',completed_keys=(SELECT jsonb_agg('row:'||n::text)
    FROM generate_series(0,jsonb_array_length(p_lines)-1) n) WHERE id=v_doc;
  PERFORM public.set_attachment_processing_status(p_attachment_id,'auto_imported',NULL,v_doc);
  RETURN v_invoice;
END;
$$;
REVOKE ALL ON FUNCTION public.kerdos_auto_record_invoice(uuid,uuid,text,jsonb,jsonb) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.kerdos_auto_record_invoice(uuid,uuid,text,jsonb,jsonb) TO service_role;
