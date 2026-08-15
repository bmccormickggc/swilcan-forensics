create extension if not exists pgcrypto with schema extensions;

create or replace function public.crm_prospecting_context()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  supplied_key text := coalesce((current_setting('request.headers', true)::jsonb ->> 'x-swilcan-automation-key'), '');
  current_payload jsonb;
begin
  if encode(extensions.digest(supplied_key, 'sha256'), 'hex') <> '0bde60b0b6dc3583592e23000a003e31b29acd398eccb16ce9caf605236ff8a9' then
    raise exception 'unauthorized';
  end if;

  select payload into current_payload from public.crm_state where id = 1;
  return jsonb_build_object(
    'existingProspects', coalesce(current_payload -> 'prospects', '[]'::jsonb),
    'pendingCandidates', coalesce(current_payload -> 'candidates', '[]'::jsonb),
    'recentDeclines', coalesce((
      select jsonb_agg(value order by value ->> 'reviewedAt' desc)
      from jsonb_array_elements(coalesce(current_payload -> 'candidates', '[]'::jsonb))
      where value ->> 'reviewStatus' = 'rejected'
    ), '[]'::jsonb)
  );
end;
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
    prospect || jsonb_build_object(
      'id', gen_random_uuid()::text,
      'reviewStatus', 'pending',
      'source', 'weekly-research',
      'batchId', batch_id,
      'createdAt', to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
      'updatedAt', to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
    )
  ), '[]'::jsonb)
  into new_rows
  from jsonb_array_elements(p_batch) prospect
  where nullif(trim(prospect ->> 'contactName'), '') is not null
    and nullif(trim(prospect ->> 'organization'), '') is not null
    and nullif(trim(prospect ->> 'sourceUrl'), '') is not null
    and not exists (
      select 1
      from jsonb_array_elements(coalesce(current_payload -> 'candidates', '[]'::jsonb) || coalesce(current_payload -> 'prospects', '[]'::jsonb)) existing
      where lower(coalesce(existing ->> 'email', '')) <> ''
        and lower(existing ->> 'email') = lower(coalesce(prospect ->> 'email', ''))
      or (
        lower(coalesce(existing ->> 'contactName', '')) = lower(coalesce(prospect ->> 'contactName', ''))
        and lower(coalesce(existing ->> 'organization', '')) = lower(coalesce(prospect ->> 'organization', ''))
      )
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

revoke all on function public.crm_prospecting_context() from public;
revoke all on function public.crm_add_prospects(jsonb) from public;
grant execute on function public.crm_prospecting_context() to anon, authenticated;
grant execute on function public.crm_add_prospects(jsonb) to anon, authenticated;
