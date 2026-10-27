-- Applied to kerdos-test as a1_2_f_fix_null_status_fence; source copy for review.
-- Not applied to production, and not committed to the repository.
-- Existing set_attachment_status_fenced evaluates NOT NULL to NULL when
-- recovery has cleared processing_lease_token; PL/pgSQL IF skips the branch.
-- Replace it with an explicit false default and require processing state.

CREATE OR REPLACE FUNCTION public.set_attachment_status_fenced(
  p_attachment_id uuid,
  p_status text,
  p_error text,
  p_import_document_id uuid,
  p_lease_token uuid
) RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path TO ''
AS $function$
DECLARE
  v_token_matches boolean;
BEGIN
  SELECT (processing_lease_token = p_lease_token)
    INTO v_token_matches
    FROM public.inbound_attachments
   WHERE id = p_attachment_id
     AND processing_status = 'processing'
     FOR UPDATE;

  IF NOT FOUND OR NOT COALESCE(v_token_matches, false) THEN
    RETURN false;
  END IF;

  PERFORM public.set_attachment_processing_status(
    p_attachment_id      := p_attachment_id,
    p_status             := p_status,
    p_error              := p_error,
    p_import_document_id := p_import_document_id
  );
  RETURN true;
END;
$function$;
