create or replace function public.crm_firm_key(value text)
returns text
language sql
immutable
strict
as $$
  select trim(regexp_replace(
    regexp_replace(
      regexp_replace(lower(replace(value, '&', ' and ')), '[^a-z0-9]+', ' ', 'g'),
      '\m(and|l\s*l\s*p|l\s*l\s*c|p\s*l\s*l\s*c|p\s*c|p\s*a|law firm|law offices|the)\M', ' ', 'g'
    ),
    '\s+', ' ', 'g'
  ));
$$;

create or replace function public.crm_add_prospects(p_batch jsonb)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  supplied_key text := coalesce((current_setting('request.headers', true)::jsonb ->> 'x-swilcan-automation-key'), '');
  current_payload jsonb;
  new_rows jsonb := '[]'::jsonb;
  batch_id text := gen_random_uuid()::text;
  inserted_count integer := 0;
begin
  if encode(extensions.digest(supplied_key, 'sha256'), 'hex') <> '0bde60b0b6dc3583592e23000a003e31b29acd398eccb16ce9caf605236ff8a9' then
    raise exception 'unauthorized';
  end if;
  if jsonb_typeof(p_batch) <> 'array' or jsonb_array_length(p_batch) = 0 or jsonb_array_length(p_batch) > 5 then
    raise exception 'p_batch must contain one to five prospects';
  end if;

  select payload into current_payload from public.crm_state where id = 1 for update;

  select coalesce(jsonb_agg(
    (prospect - 'contactName') || jsonb_build_object(
      'name', coalesce(
        nullif(trim(prospect ->> 'name'), ''),
        nullif(trim(prospect ->> 'contactName'), '')
      ),
      'id', gen_random_uuid()::text,
      'reviewStatus', 'pending',
      'source', 'weekly-research',
      'batchId', batch_id,
      'createdAt', to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt', to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    ) order by batch_ordinal
  ), '[]'::jsonb)
  into new_rows
  from jsonb_array_elements(p_batch) with ordinality as incoming(prospect, batch_ordinal)
  where coalesce(
      nullif(trim(prospect ->> 'name'), ''),
      nullif(trim(prospect ->> 'contactName'), '')
    ) is not null
    and nullif(trim(prospect ->> 'organization'), '') is not null
    and nullif(trim(prospect ->> 'sourceUrl'), '') is not null
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(current_payload -> 'candidates', '[]'::jsonb) || coalesce(current_payload -> 'prospects', '[]'::jsonb)) existing
      where lower(coalesce(existing ->> 'email', '')) <> ''
        and lower(existing ->> 'email') = lower(coalesce(prospect ->> 'email', ''))
      or (
        lower(coalesce(existing ->> 'name', existing ->> 'contactName', '')) = lower(coalesce(prospect ->> 'name', prospect ->> 'contactName', ''))
        and public.crm_firm_key(coalesce(existing ->> 'organization', '')) = public.crm_firm_key(prospect ->> 'organization')
      )
    )
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(current_payload -> 'candidates', '[]'::jsonb)) candidate
      where candidate ->> 'reviewStatus' = 'pending'
        and public.crm_firm_key(coalesce(candidate ->> 'organization', '')) = public.crm_firm_key(prospect ->> 'organization')
    )
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(current_payload -> 'prospects', '[]'::jsonb)) active
      where public.crm_firm_key(coalesce(active ->> 'organization', '')) = public.crm_firm_key(prospect ->> 'organization')
        and coalesce(active ->> 'stage', 'prospect') <> 'cold'
        and coalesce((active ->> 'needsAlternateContact')::boolean, false) = false
    )
    and not exists (
      select 1
      from jsonb_array_elements(p_batch) with ordinality as earlier(row, earlier_ordinal)
      where earlier_ordinal < batch_ordinal
        and public.crm_firm_key(coalesce(row ->> 'organization', '')) = public.crm_firm_key(prospect ->> 'organization')
    );

  inserted_count := jsonb_array_length(new_rows);
  update public.crm_state
  set payload = jsonb_set(
        jsonb_set(payload, '{schemaVersion}', '2'::jsonb, true),
        '{candidates}', coalesce(payload -> 'candidates', '[]'::jsonb) || new_rows, true
      ),
      revision = revision + 1,
      updated_at = now()
  where id = 1;

  return jsonb_build_object('batchId', batch_id, 'insertedCount', inserted_count);
end;
$$;

revoke all on function public.crm_firm_key(text) from public;
revoke all on function public.crm_add_prospects(jsonb) from public;
grant execute on function public.crm_add_prospects(jsonb) to anon, authenticated;
