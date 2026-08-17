create or replace function public.crm_decline_candidate(
  p_candidate_id text,
  p_reason text,
  p_feedback text default '',
  p_expected_revision bigint default null
)
returns jsonb
language plpgsql
security definer
set search_path = public, auth
as $$
declare
  caller_email text := lower(coalesce(auth.jwt() ->> 'email', ''));
  current_payload jsonb;
  current_revision bigint;
  next_candidates jsonb;
  matched_count integer;
  event_time text := to_char(clock_timestamp() at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"');
begin
  if caller_email not in ('selena@swilcanforensics.com', 'bill.mccormick14@gmail.com') then
    raise exception 'unauthorized';
  end if;
  if nullif(trim(coalesce(p_candidate_id, '')), '') is null then
    raise exception 'candidate id is required';
  end if;
  if p_reason not in ('off-focus', 'wrong-role', 'wrong-organization', 'wrong-geography', 'duplicate', 'weak-evidence', 'conflict', 'other') then
    raise exception 'invalid decline reason';
  end if;
  if length(coalesce(p_feedback, '')) > 3000 then
    raise exception 'decline feedback exceeds 3000 characters';
  end if;

  select payload, revision into current_payload, current_revision
  from public.crm_state where id = 1 for update;
  if p_expected_revision is null or current_revision <> p_expected_revision then
    raise exception 'revision conflict: expected %, found %', p_expected_revision, current_revision;
  end if;
  select count(*) into matched_count
  from jsonb_array_elements(coalesce(current_payload -> 'candidates', '[]'::jsonb)) candidate
  where candidate ->> 'id' = p_candidate_id and candidate ->> 'reviewStatus' = 'pending';
  if matched_count <> 1 then
    raise exception 'expected one pending candidate %, found %', p_candidate_id, matched_count;
  end if;

  select jsonb_agg(
    case when candidate ->> 'id' = p_candidate_id then
      candidate || jsonb_build_object(
        'reviewStatus', 'rejected',
        'declineReason', p_reason,
        'declineFeedback', coalesce(p_feedback, ''),
        'reviewedAt', event_time,
        'archivedAt', event_time,
        'updatedAt', event_time
      )
    else candidate end
    order by ordinal
  ) into next_candidates
  from jsonb_array_elements(coalesce(current_payload -> 'candidates', '[]'::jsonb))
       with ordinality as rows(candidate, ordinal);

  update public.crm_state
  set payload = jsonb_set(current_payload, '{candidates}', coalesce(next_candidates, '[]'::jsonb), true),
      revision = current_revision + 1,
      updated_at = now(),
      updated_by = auth.uid()
  where id = 1;

  return jsonb_build_object(
    'revision', current_revision + 1,
    'payload', jsonb_set(current_payload, '{candidates}', coalesce(next_candidates, '[]'::jsonb), true),
    'updatedAt', event_time,
    'candidateId', p_candidate_id,
    'reviewStatus', 'rejected'
  );
end;
$$;

revoke all on function public.crm_decline_candidate(text, text, text, bigint) from public;
revoke all on function public.crm_decline_candidate(text, text, text, bigint) from anon;
grant execute on function public.crm_decline_candidate(text, text, text, bigint) to authenticated;
