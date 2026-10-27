-- Applied after initializing the five-minute job and copying the existing secret to Vault.
-- Migration: a1_remove_scheduler_initializer.
DROP FUNCTION IF EXISTS public.initialize_a1_test_scheduler(text);
