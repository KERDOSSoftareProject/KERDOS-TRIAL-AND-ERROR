-- Industry-neutral client comparison preferences; existing brand locks remain.
alter table public.catalog_items add column if not exists preferred_brand text;
alter table public.catalog_items add column if not exists comparison_mode text not null default 'alternatives';
do $$ begin
 if not exists(select 1 from pg_constraint where conname='catalog_items_comparison_mode_check' and conrelid='public.catalog_items'::regclass) then
  alter table public.catalog_items add constraint catalog_items_comparison_mode_check check(comparison_mode in ('exact','alternatives'));
 end if;
end $$;
