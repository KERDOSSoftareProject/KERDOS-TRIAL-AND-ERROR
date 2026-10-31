-- DRAFT: not applied. Nullable proof for new manual imports; legacy guards stay.
BEGIN;
SET LOCAL lock_timeout = '3s';
SET LOCAL statement_timeout = '30s';
SET LOCAL idle_in_transaction_session_timeout = '15s';

ALTER TABLE public.import_documents ADD COLUMN source_rows jsonb;
ALTER TABLE public.import_documents ADD CONSTRAINT import_document_source_rows_format
  CHECK (source_rows IS NULL OR COALESCE(
    jsonb_typeof(source_rows) = 'object'
    AND source_rows->'version' = '1'::jsonb
    AND jsonb_typeof(source_rows->'rows') = 'array', false));

CREATE FUNCTION public.kerdos_preserve_import_source_rows()
RETURNS trigger LANGUAGE plpgsql SET search_path = '' AS $$
BEGIN
  IF OLD.source_rows IS NOT NULL AND NEW.source_rows IS DISTINCT FROM OLD.source_rows THEN
    RAISE EXCEPTION 'Retained import source rows are immutable';
  END IF;
  RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.kerdos_preserve_import_source_rows() FROM PUBLIC;
CREATE TRIGGER preserve_import_source_rows BEFORE UPDATE OF source_rows ON public.import_documents
  FOR EACH ROW EXECUTE FUNCTION public.kerdos_preserve_import_source_rows();
COMMIT;
