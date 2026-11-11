-- The Edge function validates the signed-in actor and runs the shared
-- interpreter. These RPCs own the transactional write and its durable proof.
create table if not exists kerdos_private.quote_unit_operations (
  id uuid primary key,
  organization_id uuid not null references public.organizations(id) on delete cascade,
  actor_id uuid not null,
  action text not null check (action in ('confirm', 'recheck')),
  plan_hash text not null,
  result jsonb not null
);
alter table kerdos_private.quote_unit_operations enable row level security;
revoke all on kerdos_private.quote_unit_operations from public, anon, authenticated, service_role;

create or replace function kerdos_private.read_quote_unit_operation(
  p_organization_id uuid, p_actor_id uuid, p_operation_id uuid, p_action text
) returns jsonb language plpgsql stable security definer set search_path = '' as $$
declare
  prior kerdos_private.quote_unit_operations%rowtype;
begin
  if p_action is null or p_action not in ('confirm', 'recheck') or not exists (
    select 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = p_actor_id
      and (m.role = 'owner' or (p_action = 'confirm' and m.role = 'manager'))
  ) then
    raise exception 'Current workspace approval authority is required' using errcode = '42501';
  end if;
  select * into prior from kerdos_private.quote_unit_operations where id = p_operation_id;
  if not found then return null; end if;
  if (prior.organization_id, prior.actor_id, prior.action) is distinct from
      (p_organization_id, p_actor_id, p_action) then
    raise exception 'The operation belongs to a different approval' using errcode = '42501';
  end if;
  return prior.result;
end;
$$;

-- A manager can edit ordinary listing fields. Only an immutable, server-created
-- receipt can introduce a document confirmation into either provenance path.
create or replace function kerdos_private.check_document_quote_unit_proof()
returns trigger language plpgsql security definer set search_path = '' as $$
declare
  proof jsonb;
  receipt_id uuid;
begin
  foreach proof in array array[
    new.field_resolutions->'selling_unit',
    new.import_row#>'{evidence,fieldEvidence,sellingUnit,confirmation}',
    new.import_row#>'{row,fieldEvidence,sellingUnit,confirmation}',
    new.import_row#>'{retainedSource,evidence,fieldEvidence,sellingUnit,confirmation}',
    new.import_row#>'{retainedSource,row,fieldEvidence,sellingUnit,confirmation}'
  ] loop
    if not coalesce(proof ? 'documentConfirmation', false) then continue; end if;
    receipt_id := (proof#>>'{documentConfirmation,operationId}')::uuid;
    if not exists (
      select 1 from kerdos_private.quote_unit_operations receipt
      cross join lateral jsonb_array_elements(receipt.result->'rows') row_receipt
      where receipt.id = receipt_id and receipt.action = 'confirm'
        and receipt.organization_id = new.organization_id
        and row_receipt->>'listingId' = new.id::text
        and row_receipt#>>'{confirmation,documentConfirmation,vendorId}' = new.vendor_id::text
        and row_receipt->'confirmation' = proof
    ) then
      raise exception 'Document confirmation has no matching server receipt' using errcode = '42501';
    end if;
  end loop;
  return new;
end;
$$;
create or replace trigger check_document_quote_unit_proof
  before insert or update of field_resolutions, import_row, organization_id, vendor_id, id
  on public.vendor_items for each row execute function kerdos_private.check_document_quote_unit_proof();

create or replace function kerdos_private.apply_quote_unit_operation(
  p_organization_id uuid, p_actor_id uuid, p_operation_id uuid, p_action text, p_plan jsonb
) returns jsonb language plpgsql security definer set search_path = '' as $$
declare
  prior_result jsonb;
  approved_plan_hash text;
  workspace public.organizations%rowtype;
  document public.import_documents%rowtype;
  listing public.vendor_items%rowtype;
  mapping public.item_mappings%rowtype;
  current_vocabulary jsonb;
  expected_vocabulary jsonb;
  documents jsonb;
  document_ids uuid[];
  entry jsonb;
  ids uuid[];
  confirmed_at timestamptz := statement_timestamp();
  confirmation jsonb;
  receipt_rows jsonb := '[]'::jsonb;
  result jsonb;
begin
  if p_operation_id is null or jsonb_typeof(p_plan) is distinct from 'object' then
    raise exception 'Use the approved quote-unit preview';
  end if;
  approved_plan_hash := encode(sha256(convert_to(p_plan::text, 'UTF8')), 'hex');
  perform pg_advisory_xact_lock(hashtextextended(p_operation_id::text, 0));
  prior_result := kerdos_private.read_quote_unit_operation(p_organization_id, p_actor_id, p_operation_id, p_action);
  if prior_result is not null then
    if exists (select 1 from kerdos_private.quote_unit_operations r where r.id = p_operation_id and r.plan_hash <> approved_plan_hash) then
      raise exception 'The operation was already applied to a different preview';
    end if;
    return prior_result;
  end if;

  -- Hold the workspace context and membership stable through the write.
  select * into workspace from public.organizations where id = p_organization_id for update;
  if not found or nullif(btrim(workspace.industry), '') is null
      or workspace.industry is distinct from p_plan->>'industry'
      or (p_plan ? 'settings' and coalesce(to_jsonb(workspace.settings), 'null'::jsonb) is distinct from p_plan->'settings') then
    raise exception 'Workspace interpretation settings changed; preview again';
  end if;
  perform 1 from public.organization_members m
    where m.organization_id = p_organization_id and m.user_id = p_actor_id
      and (m.role = 'owner' or (p_action = 'confirm' and m.role = 'manager')) for share;
  if not found then
    raise exception 'Current workspace approval authority is required' using errcode = '42501';
  end if;
  if jsonb_typeof(p_plan->'vocabulary') is distinct from 'array' then
    raise exception 'Workspace vocabulary is required';
  end if;
  perform 1 from public.org_vocabulary where organization_id = p_organization_id order by id for share;
  select coalesce(jsonb_agg(to_jsonb(v) order by v.id::text), '[]'::jsonb) into current_vocabulary
    from public.org_vocabulary v where v.organization_id = p_organization_id;
  select coalesce(jsonb_agg(v order by v->>'id'), '[]'::jsonb) into expected_vocabulary
    from jsonb_array_elements(p_plan->'vocabulary') v;
  if current_vocabulary is distinct from expected_vocabulary then
    raise exception 'Workspace vocabulary changed; preview again';
  end if;

  documents := case when p_action = 'recheck' and p_plan->>'documentId' is null then p_plan->'documents'
    else jsonb_build_array(jsonb_build_object('id', p_plan->>'documentId', 'fingerprint', p_plan->>'documentFingerprint'))
    end;
  if jsonb_typeof(documents) is distinct from 'array' or jsonb_array_length(documents) = 0 then
    raise exception 'Select the reviewed price sheets';
  end if;
  select array_agg((scope->>'id')::uuid order by scope->>'id') into document_ids
    from jsonb_array_elements(documents) scope;
  if array_position(document_ids, null) is not null
      or cardinality(document_ids) <> (select count(distinct id) from unnest(document_ids) id) then
    raise exception 'The approved preview contains duplicate or missing price sheets';
  end if;
  perform 1 from public.import_documents where organization_id = p_organization_id
    and id = any(document_ids) order by id for share;
  for entry in select value from jsonb_array_elements(documents) loop
    select * into document from public.import_documents
      where id = (entry->>'id')::uuid and organization_id = p_organization_id and document_kind = 'pricelist';
    if not found or document.fingerprint is distinct from entry->>'fingerprint' or document.status = 'processing' then
      raise exception 'A price sheet changed; preview again';
    end if;
  end loop;
  if jsonb_typeof(p_plan->'rows') is distinct from 'array' or jsonb_array_length(p_plan->'rows') = 0
      or jsonb_typeof(p_plan->'summary') is distinct from 'object' then
    raise exception 'The approved preview must include listings and readiness totals';
  end if;
  select array_agg((row_plan->>'listingId')::uuid order by row_plan->>'listingId') into ids
    from jsonb_array_elements(p_plan->'rows') row_plan;
  if array_position(ids, null) is not null or cardinality(ids) <> (select count(distinct id) from unnest(ids) id) then
    raise exception 'The approved preview contains duplicate or missing listings';
  end if;
  perform 1 from public.vendor_items where organization_id = p_organization_id and id = any(ids) order by id for update;
  perform 1 from public.item_mappings where organization_id = p_organization_id and vendor_item_id = any(ids) order by vendor_item_id, id for share;
  if (select count(*) from public.item_mappings where organization_id = p_organization_id and vendor_item_id = any(ids))
      <> cardinality(ids) then
    raise exception 'Each listing needs its reviewed catalog association';
  end if;

  for entry in select value from jsonb_array_elements(p_plan->'rows') loop
    select * into listing from public.vendor_items
      where id = (entry->>'listingId')::uuid and organization_id = p_organization_id;
    if not found or to_jsonb(listing) is distinct from entry->'expectedListing'
        or jsonb_typeof(listing.import_row->'row') is distinct from 'object' then
      raise exception 'A listing or source observation changed; preview again';
    end if;
    select * into document from public.import_documents where id = (listing.import_row->>'sourceDocumentId')::uuid
      and id = any(document_ids) and organization_id = p_organization_id and vendor_id = listing.vendor_id;
    if not found then raise exception 'A listing is outside the reviewed price sheets'; end if;
    select * into mapping from public.item_mappings where organization_id = p_organization_id and vendor_item_id = listing.id;
    if not found or to_jsonb(mapping) is distinct from entry->'expectedMapping' then
      raise exception 'A catalog association changed; preview again';
    end if;

    if p_action = 'confirm' then
      if nullif(btrim(p_plan->>'unit'), '') is null or nullif(btrim(entry->>'sellingUnit'), '') is null
          or coalesce(entry->>'priceBasis', '') not in ('case', 'each', 'measure')
          or jsonb_typeof(entry->'priceUnavailable') is distinct from 'boolean'
          or nullif(btrim(entry->>'rowKey'), '') is null
          or entry->>'rowKey' is distinct from listing.import_row->>'rowKey'
          or entry->>'packSize' is distinct from listing.pack_size
          or nullif(btrim(listing.pack_size), '') is null
          or listing.price is null or listing.price <= 0 or listing.price_source is distinct from 'price_list'
          or listing.price_expired_at is not null
          or listing.price_quote_valid_until < (confirmed_at at time zone 'UTC')::date
          or listing.field_resolutions->'selling_unit'->>'confirmedBy' is not null then
        raise exception 'A listing no longer qualifies for document confirmation';
      end if;
      confirmation := jsonb_build_object(
        'value', entry->>'sellingUnit', 'confirmedBy', p_actor_id, 'confirmedAt', confirmed_at,
        'sourceValue', listing.import_row#>'{row,sellingUnit}',
        'documentConfirmation', jsonb_build_object(
          'operationId', p_operation_id, 'organizationId', p_organization_id, 'vendorId', document.vendor_id,
          'documentId', document.id, 'documentFingerprint', document.fingerprint, 'listingId', listing.id,
          'rowKey', entry->>'rowKey', 'packSize', listing.pack_size,
          'observationHash', encode(sha256(convert_to((listing.import_row->'row')::text, 'UTF8')), 'hex')
        )
      );
      receipt_rows := receipt_rows || jsonb_build_array(jsonb_build_object(
        'listingId', listing.id, 'confirmation', confirmation
      ));
    else
      if listing.import_row->'reviewRequired' is distinct from 'true'::jsonb
          or jsonb_typeof(entry->'reviewFields') is distinct from 'array'
          or jsonb_typeof(entry->'reviewRequired') is distinct from 'boolean'
          or jsonb_typeof(entry->'baseline') not in ('object', 'null') or not (entry ? 'baseline') then
        raise exception 'The approved source review changed; preview again';
      end if;
      receipt_rows := receipt_rows || jsonb_build_array(jsonb_build_object(
        'listingId', listing.id, 'reviewRequired', entry->'reviewRequired', 'reviewFields', entry->'reviewFields'
      ));
    end if;
  end loop;

  result := jsonb_build_object(
    'operationId', p_operation_id, 'action', p_action, 'confirmedBy', p_actor_id,
    'confirmedAt', confirmed_at, 'documentId', p_plan->>'documentId',
    'documents', documents, 'summary', p_plan->'summary', 'rows', receipt_rows
  );
  -- The proof trigger can now validate updates. A failure rolls back the
  -- receipt and all listing changes together.
  insert into kerdos_private.quote_unit_operations values (
    p_operation_id, p_organization_id, p_actor_id, p_action, approved_plan_hash, result
  );
  if p_action = 'confirm' then
    update public.vendor_items v set
      selling_unit = row_plan->>'sellingUnit',
      price_basis = row_plan->>'priceBasis',
      price_unavailable = (row_plan->>'priceUnavailable')::boolean,
      field_resolutions = jsonb_set(coalesce(v.field_resolutions, '{}'::jsonb), '{selling_unit}', row_receipt->'confirmation'),
      row_revision = v.row_revision + 1
    from jsonb_array_elements(p_plan->'rows') row_plan
    join jsonb_array_elements(receipt_rows) row_receipt on row_receipt->>'listingId' = row_plan->>'listingId'
    where v.id = (row_plan->>'listingId')::uuid and v.organization_id = p_organization_id;
  else
    update public.vendor_items v set import_row = v.import_row || jsonb_build_object(
      'reviewFields', row_plan->'reviewFields', 'reviewRequired', row_plan->'reviewRequired', 'baseline', row_plan->'baseline'
    )
    from jsonb_array_elements(p_plan->'rows') row_plan
    where v.id = (row_plan->>'listingId')::uuid and v.organization_id = p_organization_id;
  end if;
  return result;
end;
$$;

-- Only the public wrappers are callable by the server role. The wrappers use
-- their owner's private-schema access, leaving the shared schema grants intact.
create or replace function public.kerdos_read_quote_unit_operation(
  p_organization_id uuid, p_actor_id uuid, p_operation_id uuid, p_action text
) returns jsonb language sql stable security definer set search_path = '' as $$
  select kerdos_private.read_quote_unit_operation(p_organization_id, p_actor_id, p_operation_id, p_action);
$$;
create or replace function public.kerdos_apply_quote_unit_operation(
  p_organization_id uuid, p_actor_id uuid, p_operation_id uuid, p_action text, p_plan jsonb
) returns jsonb language sql security definer set search_path = '' as $$
  select kerdos_private.apply_quote_unit_operation(p_organization_id, p_actor_id, p_operation_id, p_action, p_plan);
$$;
revoke all on function kerdos_private.read_quote_unit_operation(uuid, uuid, uuid, text),
  kerdos_private.apply_quote_unit_operation(uuid, uuid, uuid, text, jsonb),
  kerdos_private.check_document_quote_unit_proof(),
  public.kerdos_read_quote_unit_operation(uuid, uuid, uuid, text),
  public.kerdos_apply_quote_unit_operation(uuid, uuid, uuid, text, jsonb)
  from public, anon, authenticated, service_role;
grant execute on function public.kerdos_read_quote_unit_operation(uuid, uuid, uuid, text),
  public.kerdos_apply_quote_unit_operation(uuid, uuid, uuid, text, jsonb) to service_role;
