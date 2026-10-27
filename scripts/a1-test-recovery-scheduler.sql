-- DRAFT: not applied. Requires explicit approval of the persistent scheduler design.
CREATE EXTENSION IF NOT EXISTS pg_cron;
CREATE EXTENSION IF NOT EXISTS pg_net;
CREATE SCHEMA IF NOT EXISTS kerdos_private;
REVOKE ALL ON SCHEMA kerdos_private FROM PUBLIC, anon, authenticated;

CREATE OR REPLACE FUNCTION kerdos_private.run_test_recovery_sweep()
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_secret text;
BEGIN
  SELECT decrypted_secret INTO v_secret FROM vault.decrypted_secrets
   WHERE name='kerdos_test_recovery_sweep';
  IF v_secret IS NULL OR v_secret='' THEN RAISE EXCEPTION 'Recovery scheduler secret is not configured'; END IF;
  RETURN net.http_post(
    url:='https://gwtnaudjfoxjermhvhpx.supabase.co/functions/v1/recovery-sweep',
    headers:=jsonb_build_object('Content-Type','application/json','Authorization','Bearer '||v_secret),
    body:='{}'::jsonb, timeout_milliseconds:=60000);
END;
$fn$;
REVOKE ALL ON FUNCTION kerdos_private.run_test_recovery_sweep() FROM PUBLIC,anon,authenticated;
GRANT USAGE ON SCHEMA kerdos_private TO service_role;
GRANT EXECUTE ON FUNCTION kerdos_private.run_test_recovery_sweep() TO service_role;

-- Temporary service-only initializer copies the existing function secret to Vault.
-- Remove this RPC after setup; it never returns its input.
CREATE OR REPLACE FUNCTION public.initialize_a1_test_scheduler(p_secret text)
RETURNS bigint LANGUAGE plpgsql SECURITY DEFINER SET search_path='' AS $fn$
DECLARE v_job bigint;
BEGIN
  IF p_secret IS NULL OR p_secret='' THEN RAISE EXCEPTION 'Secret is required'; END IF;
  IF EXISTS(SELECT 1 FROM vault.secrets WHERE name='kerdos_test_recovery_sweep') THEN
    RAISE EXCEPTION 'Scheduler secret already exists; inspect existing setup before changing it';
  END IF;
  PERFORM vault.create_secret(p_secret,'kerdos_test_recovery_sweep','Existing kerdos-test recovery endpoint credential');
  SELECT cron.schedule('kerdos-test-a1-recovery','*/5 * * * *',
      'select kerdos_private.run_test_recovery_sweep();') INTO v_job;
  RETURN v_job;
END;
$fn$;
REVOKE ALL ON FUNCTION public.initialize_a1_test_scheduler(text) FROM PUBLIC,anon,authenticated;
GRANT EXECUTE ON FUNCTION public.initialize_a1_test_scheduler(text) TO service_role;
