-- KERDOS 007: invoice header and all invoice lines are one transaction.
-- Run after migration_006_atomic_invites.sql.

create or replace function kerdos_record_invoice(p_header jsonb,p_lines jsonb)
returns uuid
language plpgsql
set search_path = public
as $$
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
          or (nullif(v_line->>'vendor_item_code','') is null and description=v_line->>'description'))
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

      if nullif(v_line->>'catalog_item_id','') is not null then
        insert into item_mappings(
          organization_id,catalog_item_id,vendor_item_id,confidence_score,match_method,comparison_track
        ) values (
          (p_header->>'organization_id')::uuid,(v_line->>'catalog_item_id')::uuid,v_vendor_item_id,
          coalesce((v_line->>'catalog_confidence')::integer,0),'rule_based',
          coalesce(nullif(v_line->>'catalog_track',''),'similar')
        ) on conflict do nothing;
      end if;
    end if;

    insert into invoice_lines(
      invoice_id,vendor_item_id,vendor_item_code,description,unit_price,
      line_total,price_variance,match_confidence,match_method
    ) values (
      v_invoice_id,v_vendor_item_id,nullif(v_line->>'vendor_item_code',''),v_line->>'description',
      (v_line->>'unit_price')::numeric,(v_line->>'line_total')::numeric,
      nullif(v_line->>'price_variance','')::numeric,nullif(v_line->>'match_confidence','')::integer,
      nullif(v_line->>'match_method','')
    );
  end loop;

  return v_invoice_id;
end;
$$;

revoke all on function kerdos_record_invoice(jsonb,jsonb) from public;
grant execute on function kerdos_record_invoice(jsonb,jsonb) to authenticated;
