-- Generated with Supabase CLI 2.122.0; version matches hosted migration history.
-- I · A · Task 2. Browser evidence is a client
-- assertion, not an authenticated vendor_pull message. No inbound RPC changes.
BEGIN;
SET LOCAL lock_timeout='3s';
SET LOCAL statement_timeout='15s';
ALTER TABLE public.import_documents ADD COLUMN retrieval_evidence jsonb;
ALTER TABLE public.import_documents ADD CONSTRAINT import_retrieval_evidence_shape CHECK (
 retrieval_evidence IS NULL OR (
  jsonb_typeof(retrieval_evidence)='object'
  AND retrieval_evidence->>'kind'='browser_companion'
  AND retrieval_evidence->>'assurance'='user_approved_browser_session'
  AND retrieval_evidence->>'sha256' ~ '^[0-9a-f]{64}$'
  AND jsonb_typeof(retrieval_evidence->'byte_length')='number'
  AND (retrieval_evidence->>'byte_length')::numeric BETWEEN 1 AND 5242880
 ) IS TRUE
);
-- Existing import_documents org/role RLS remains authoritative. Preserve the
-- original claim: manual documents cannot later be relabelled as companion files.
CREATE FUNCTION public.preserve_import_retrieval_evidence() RETURNS trigger
LANGUAGE plpgsql SET search_path=pg_catalog AS $$
BEGIN
 IF NEW.retrieval_evidence IS DISTINCT FROM OLD.retrieval_evidence THEN
  RAISE EXCEPTION 'retrieval_evidence_immutable';
 END IF;
 RETURN NEW;
END;
$$;
REVOKE ALL ON FUNCTION public.preserve_import_retrieval_evidence() FROM PUBLIC;
CREATE TRIGGER preserve_import_retrieval_evidence BEFORE UPDATE OF retrieval_evidence
 ON public.import_documents FOR EACH ROW EXECUTE FUNCTION public.preserve_import_retrieval_evidence();
COMMIT;
