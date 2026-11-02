-- Preserve full invoice lookup/FK coverage after adding root-only reference uniqueness.
create index if not exists invoice_payments_invoice on public.invoice_payments(invoice_id);
