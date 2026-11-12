-- Read-only before/after evidence for an installed Vendor Connect refresh.
-- Bind the two UUID parameters through psql, or substitute validated UUIDs
-- before sending this single SELECT through the project's read-only tools.
-- Contains no supplier/client constants and performs no setup or test writes.
WITH scope AS (
  SELECT :'organization_id'::uuid AS organization_id, :'vendor_id'::uuid AS vendor_id
), owned_vendor AS (
  SELECT v.id FROM public.vendors v JOIN scope s
    ON v.id=s.vendor_id AND v.organization_id=s.organization_id
), listings AS (
  SELECT v.* FROM public.vendor_items v JOIN scope s
    ON v.organization_id=s.organization_id AND v.vendor_id=s.vendor_id
  WHERE EXISTS (SELECT FROM owned_vendor)
), mappings AS (
  SELECT m.* FROM public.item_mappings m JOIN listings v ON v.id=m.vendor_item_id
  JOIN scope s ON m.organization_id=s.organization_id
), quotations AS (
  SELECT h.* FROM public.price_history h JOIN listings v ON v.id=h.vendor_item_id
  JOIN scope s ON h.organization_id=s.organization_id
), documents AS (
  SELECT d.* FROM public.import_documents d JOIN scope s
    ON d.organization_id=s.organization_id AND d.vendor_id=s.vendor_id
  WHERE d.document_kind='pricelist' AND EXISTS (SELECT FROM owned_vendor)
)
SELECT jsonb_build_object(
  'schema_version',1,
  'captured_at',statement_timestamp(),
  'scope',(SELECT to_jsonb(s) FROM scope s),
  'owned_vendor_found',EXISTS(SELECT FROM owned_vendor),
  'counts',jsonb_build_object(
    'vendor_items',(SELECT count(*) FROM listings),
    'mappings',(SELECT count(*) FROM mappings),
    'quotations',(SELECT count(*) FROM quotations),
    'documents',(SELECT count(*) FROM documents)
  ),
  'state_hashes',jsonb_build_object(
    'vendor_items',(SELECT md5(coalesce(jsonb_agg(to_jsonb(v) ORDER BY v.id),'[]'::jsonb)::text) FROM listings v),
    'mappings',(SELECT md5(coalesce(jsonb_agg(to_jsonb(m) ORDER BY m.id),'[]'::jsonb)::text) FROM mappings m),
    'quotations',(SELECT md5(coalesce(jsonb_agg(to_jsonb(h) ORDER BY h.id),'[]'::jsonb)::text) FROM quotations h),
    'documents',(SELECT md5(coalesce(jsonb_agg(to_jsonb(d) ORDER BY d.id),'[]'::jsonb)::text) FROM documents d)
  ),
  'listing_revisions',coalesce((SELECT jsonb_agg(jsonb_build_object(
    'id',v.id,'code',v.vendor_item_code,'revision',v.row_revision,
    'source_document_id',v.import_row->>'sourceDocumentId',
    'corrections_hash',md5(coalesce(v.field_resolutions,'{}'::jsonb)::text)
  ) ORDER BY v.id) FROM listings v),'[]'::jsonb),
  'sources',coalesce((SELECT jsonb_agg(jsonb_build_object(
    'id',d.id,'status',d.status,'created_at',d.created_at,
    'fingerprint',d.fingerprint,'file_path',d.file_path,
    'retrieval_evidence',d.retrieval_evidence,
    'source_version',d.source_rows->'version',
    'source_rows',CASE WHEN jsonb_typeof(d.source_rows->'rows')='array'
      THEN jsonb_array_length(d.source_rows->'rows') ELSE NULL END,
    'completed_rows',CASE WHEN jsonb_typeof(to_jsonb(d.completed_keys))='array'
      THEN jsonb_array_length(to_jsonb(d.completed_keys)) ELSE NULL END,
    'quoted_rows',(SELECT count(*) FROM quotations h WHERE h.source_document_id=d.id)
  ) ORDER BY d.created_at,d.id) FROM documents d),'[]'::jsonb),
  -- Stored transfer assertions are not evidence of a fresh binary read-back.
  'binary_readback_observed',false,
  'installed_refresh_observed',false
) AS snapshot;
