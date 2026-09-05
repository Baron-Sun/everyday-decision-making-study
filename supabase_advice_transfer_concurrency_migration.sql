-- Study 2 concurrency upgrade (2026-09-05).
-- Shared gates for independent participant saves; exclusive gates preserve
-- atomic quota ownership. No shared-to-exclusive upgrade is permitted.
-- Function-scoped 250ms lock waits leave connections available for retries.
-- This migration does not change recruitment, targets, stimuli, or responses.
begin;

-- Keep lease reclamation cheap as historical assignments accumulate.
create index if not exists advice_transfer_claimed_lease_idx
  on public.advice_transfer_assignments (lease_expires_at)
  where status = 'claimed' and lease_expires_at is not null;


create or replace function public.ensure_advice_transfer_quota_tokens()
returns integer
language plpgsql
security definer
set search_path = public
set lock_timeout = '250ms'
as $$
declare
  v_target integer := 0;
  v_inserted integer := 0;
begin
  perform pg_advisory_xact_lock(hashtext('advice_transfer_admission_v3'));

  select coalesce((setting_value #>> '{}')::integer, 0)
    into v_target
    from public.advice_transfer_settings
   where setting_key = 'formal_target_per_cell';

  if coalesce(v_target, 0) < 1 then
    return 0;
  end if;

  -- Unique (cell, slot_index) keys and positive bounded slots mean this
  -- count equality proves all active cell tokens already exist.
  if (select count(*)
        from public.advice_transfer_quota_tokens token
        join public.advice_transfer_stimuli stimulus using (stimulus_id)
       where stimulus.active and stimulus.pair_role = 'primary'
         and token.slot_index <= v_target) =
     (select count(*) * 2 * v_target
        from public.advice_transfer_stimuli
       where active and pair_role = 'primary') then
    return 0;
  end if;

  insert into public.advice_transfer_quota_tokens (
    stimulus_id,
    pair_number,
    condition,
    slot_index
  )
  select stimulus.stimulus_id,
         stimulus.pair_number,
         conditions.condition,
         slot.slot_index
    from public.advice_transfer_stimuli stimulus
    cross join (values ('human'::text), ('ai'::text)) conditions(condition)
    cross join generate_series(1, v_target) slot(slot_index)
   where stimulus.active
     and stimulus.pair_role = 'primary'
  on conflict (stimulus_id, condition, slot_index) do nothing;

  get diagnostics v_inserted = row_count;
  return v_inserted;
end;
$$;

create or replace function public.claim_advice_transfer_assignment(
  p_prolific_pid text,
  p_study_id text default null,
  p_session_id text default null,
  p_is_test boolean default false,
  p_pair_number integer default null,
  p_condition text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '250ms'
as $$
declare
  v_assignment public.advice_transfer_assignments%rowtype;
  v_stimulus public.advice_transfer_stimuli%rowtype;
  v_token public.advice_transfer_quota_tokens%rowtype;
  v_waiter public.advice_transfer_waitlist%rowtype;
  v_stimulus_id text;
  v_is_test boolean;
  v_formal_open boolean := false;
  v_target_per_cell integer := 0;
  v_lease_minutes integer := 5;
  v_waitlist_ttl_seconds integer := 180;
  v_poll_seconds integer := 3;
  v_standby_after_seconds integer := 90;
  v_queue_position integer := 1;
  v_waited_seconds integer := 0;
  v_reservation_kind text;
  v_condition text;
  v_comment_order jsonb;
  v_source_comments jsonb;
  v_source_hashes jsonb;
  v_ordered_comments jsonb;
  v_ordered_hashes jsonb;
  v_cell record;
  v_now timestamptz := now();
begin
  p_prolific_pid := nullif(trim(p_prolific_pid), '');
  p_study_id := nullif(trim(p_study_id), '');
  p_session_id := nullif(trim(p_session_id), '');
  p_condition := nullif(lower(trim(p_condition)), '');

  if p_prolific_pid is null then
    raise exception 'Missing PROLIFIC_PID';
  end if;
  if p_pair_number is not null and (p_pair_number < 1 or p_pair_number > 13) then
    raise exception 'The requested test pair must be between 1 and 13';
  end if;
  if p_condition is not null and p_condition not in ('human', 'ai') then
    raise exception 'The requested test condition must be human or ai';
  end if;

  -- Test status is derived from the identifier, not trusted from the browser.
  v_is_test := p_prolific_pid ~* '^(test|preview|qa)[-_]';
  if coalesce(p_is_test, false) <> v_is_test then
    raise exception 'Participant identifier and test flag do not match';
  end if;
  if not v_is_test and (p_pair_number is not null or p_condition is not null) then
    raise exception 'Pair and condition overrides are available only for test identifiers';
  end if;

  select coalesce((setting_value #>> '{}')::boolean, false)
    into v_formal_open
    from public.advice_transfer_settings
   where setting_key = 'formal_recruitment_open';

  select coalesce((setting_value #>> '{}')::integer, 0)
    into v_target_per_cell
    from public.advice_transfer_settings
   where setting_key = 'formal_target_per_cell';

  select greatest(3, least(30, coalesce((setting_value #>> '{}')::integer, 5)))
    into v_lease_minutes
    from public.advice_transfer_settings
   where setting_key = 'assignment_lease_minutes';

  select greatest(120, least(600, coalesce((setting_value #>> '{}')::integer, 180)))
    into v_waitlist_ttl_seconds
    from public.advice_transfer_settings
   where setting_key = 'waitlist_ttl_seconds';

  select greatest(2, least(15, coalesce((setting_value #>> '{}')::integer, 3)))
    into v_poll_seconds
    from public.advice_transfer_settings
   where setting_key = 'admission_poll_seconds';

  select greatest(30, least(600, coalesce((setting_value #>> '{}')::integer, 90)))
    into v_standby_after_seconds
    from public.advice_transfer_settings
   where setting_key = 'standby_after_seconds';

  v_target_per_cell := coalesce(v_target_per_cell, 0);
  v_lease_minutes := coalesce(v_lease_minutes, 5);
  v_waitlist_ttl_seconds := coalesce(v_waitlist_ttl_seconds, 180);
  v_poll_seconds := coalesce(v_poll_seconds, 3);
  v_standby_after_seconds := coalesce(v_standby_after_seconds, 90);

  -- Admission, token release and token promotion share one short transaction
  -- lock. Token rows are the hard per-cell quota boundary.
  perform pg_advisory_xact_lock(hashtext('advice_transfer_admission_v3'));
  perform public.reclaim_expired_advice_transfer_assignments();

  if v_is_test then
    select *
      into v_assignment
      from public.advice_transfer_assignments
     where prolific_pid = p_prolific_pid
       and coalesce(study_id, '') = coalesce(p_study_id, '')
       and coalesce(session_id, '') = coalesce(p_session_id, '')
     order by created_at desc
     limit 1
     for update;
  else
    -- SESSION_ID can change when Prolific reopens a returned submission. A
    -- formal participant must still recover the original assignment.
    select *
      into v_assignment
      from public.advice_transfer_assignments
     where prolific_pid = p_prolific_pid
       and coalesce(study_id, '') = coalesce(p_study_id, '')
       and not is_test
     order by created_at desc
     limit 1
     for update;
  end if;

  if v_assignment.id is not null and v_assignment.status = 'abandoned' then
    if v_assignment.abandonment_reason = 'lease_expired' then
      v_reservation_kind := case when v_assignment.is_test then 'test' else 'standby' end;
      update public.advice_transfer_assignments
         set status = 'claimed',
             last_heartbeat_at = v_now,
             lease_expires_at = v_now + make_interval(mins => v_lease_minutes),
             disconnect_noted_at = null,
             abandoned_at = null,
             abandonment_reason = null,
             reservation_kind = v_reservation_kind,
             quota_token_id = null,
             standby_enqueued_at = case
               when v_assignment.is_test then standby_enqueued_at
               else coalesce(standby_enqueued_at, v_now)
             end,
             updated_at = v_now
       where id = v_assignment.id
       returning * into v_assignment;

      if not v_assignment.is_test then
        perform public.promote_advice_transfer_standby(
          v_assignment.stimulus_id,
          v_assignment.condition
        );
        select * into v_assignment
          from public.advice_transfer_assignments
         where id = v_assignment.id;
      end if;
    else
      raise exception 'This research session is no longer active';
    end if;
  elsif v_assignment.id is not null and v_assignment.status = 'excluded' then
    raise exception 'This research session is no longer active';
  elsif v_assignment.id is not null and v_assignment.status = 'claimed' then
    if not v_assignment.is_test
       and v_assignment.reservation_kind = 'quota'
       and not exists (
         select 1
           from public.advice_transfer_quota_tokens token
          where token.id = v_assignment.quota_token_id
            and token.state = 'reserved'
            and token.current_assignment_id = v_assignment.assignment_id
       ) then
      update public.advice_transfer_assignments
         set reservation_kind = 'standby',
             quota_token_id = null,
             standby_enqueued_at = coalesce(standby_enqueued_at, v_now)
       where id = v_assignment.id;
      v_assignment.reservation_kind := 'standby';
      v_assignment.quota_token_id := null;
    end if;

    update public.advice_transfer_assignments
       set last_heartbeat_at = v_now,
           lease_expires_at = v_now + make_interval(mins => v_lease_minutes),
           disconnect_noted_at = null,
           updated_at = v_now
     where id = v_assignment.id
     returning * into v_assignment;

    if not v_assignment.is_test and v_assignment.reservation_kind = 'quota' then
      update public.advice_transfer_quota_tokens
         set reservation_expires_at = v_assignment.lease_expires_at,
             updated_at = v_now
       where id = v_assignment.quota_token_id
         and state = 'reserved'
         and current_assignment_id = v_assignment.assignment_id;
    elsif not v_assignment.is_test and v_assignment.reservation_kind = 'standby' then
      perform public.promote_advice_transfer_standby(
        v_assignment.stimulus_id,
        v_assignment.condition
      );
      select * into v_assignment
        from public.advice_transfer_assignments
       where id = v_assignment.id;
    end if;
  end if;

  if v_assignment.id is null then
    if not v_is_test
       and not coalesce(v_formal_open, false)
       and not exists (
         select 1
           from public.advice_transfer_waitlist queued
          where queued.prolific_pid = p_prolific_pid
            and queued.study_id = coalesce(p_study_id, '')
            and queued.expires_at >= v_now
       ) then
      return jsonb_build_object(
        'admissionStatus', 'closed',
        'message', 'Formal recruitment is not open yet',
        'serverTime', v_now
      );
    end if;

    if v_is_test then
      -- Select the least-filled eligible pair x condition cell. Screened-out,
      -- excluded and abandoned attempts do not occupy the cell.
      with conditions(condition) as (
        values ('human'::text), ('ai'::text)
      ),
      eligible_cells as (
        select stimulus.stimulus_id,
               stimulus.pair_number,
               conditions.condition
          from public.advice_transfer_stimuli stimulus
          cross join conditions
         where (
                 (p_pair_number is null and stimulus.active and stimulus.pair_role = 'primary')
                 or stimulus.pair_number = p_pair_number
               )
           and (p_condition is null or conditions.condition = p_condition)
      ),
      cell_counts as (
        select assignment.stimulus_id,
               assignment.condition,
               count(*) as occupied_count
          from public.advice_transfer_assignments assignment
         where assignment.is_test
           and assignment.status in ('claimed', 'submitted')
         group by assignment.stimulus_id, assignment.condition
      )
      select eligible.stimulus_id,
             eligible.condition
        into v_stimulus_id,
             v_condition
        from eligible_cells eligible
        left join cell_counts counts
          on counts.stimulus_id = eligible.stimulus_id
         and counts.condition = eligible.condition
       order by coalesce(counts.occupied_count, 0), random()
       limit 1;

      select * into v_stimulus
        from public.advice_transfer_stimuli
       where stimulus_id = v_stimulus_id;
      v_reservation_kind := 'test';
    else
      if v_target_per_cell < 1 then
        raise exception 'Formal assignment targets have not been configured';
      end if;

      perform public.ensure_advice_transfer_quota_tokens();

      -- Preserve existing standby priority, including work just revived by a
      -- shared heartbeat. Skip cells with no eligible standby rather than
      -- invoking the promotion function for all 20 cells on every arrival.
      for v_cell in
        select distinct token.stimulus_id, token.condition
          from public.advice_transfer_quota_tokens token
         where token.state = 'available'
           and token.slot_index <= v_target_per_cell
           and exists (
             select 1
               from public.advice_transfer_assignments standby
               left join public.advice_transfer_submissions submission
                 on submission.assignment_id = standby.assignment_id
              where standby.stimulus_id = token.stimulus_id
                and standby.condition = token.condition
                and not standby.is_test
                and standby.reservation_kind = 'standby'
                and (
                  (standby.status = 'claimed' and standby.lease_expires_at >= v_now)
                  or (standby.status = 'submitted'
                      and submission.quota_disposition = 'standby'
                      and submission.validity_status in ('pending', 'valid'))
                )
           )
      loop
        perform public.promote_advice_transfer_standby(
          v_cell.stimulus_id,
          v_cell.condition
        );
      end loop;

      insert into public.advice_transfer_waitlist (
        waiter_id,
        prolific_pid,
        study_id,
        session_id,
        enqueued_at,
        last_seen_at,
        expires_at,
        updated_at
      ) values (
        'atw-' || replace(gen_random_uuid()::text, '-', ''),
        p_prolific_pid,
        coalesce(p_study_id, ''),
        coalesce(p_session_id, ''),
        v_now,
        v_now,
        v_now + make_interval(secs => v_waitlist_ttl_seconds),
        v_now
      )
      on conflict (prolific_pid, study_id)
      do update set
        session_id = excluded.session_id,
        last_seen_at = excluded.last_seen_at,
        expires_at = excluded.expires_at,
        updated_at = excluded.updated_at
      returning * into v_waiter;

      select count(*)::integer + 1
        into v_queue_position
        from public.advice_transfer_waitlist queued
       where queued.expires_at >= v_now
         and queued.study_id = coalesce(p_study_id, '')
         and (queued.enqueued_at, queued.id) < (v_waiter.enqueued_at, v_waiter.id);

      v_waited_seconds := greatest(
        0,
        floor(extract(epoch from (v_now - v_waiter.enqueued_at)))::integer
      );

      -- An absent queue head must not block a free token. The exclusive
      -- admission gate and token row still enforce each cell's hard cap.
      with cell_counts as (
          select token.stimulus_id,
                 token.condition,
                 count(*) filter (where token.state in ('pending', 'valid'))::integer as completed,
                 count(*) filter (where token.state = 'reserved')::integer as active
            from public.advice_transfer_quota_tokens token
           where token.slot_index <= v_target_per_cell
           group by token.stimulus_id, token.condition
        )
        select token.*
          into v_token
          from public.advice_transfer_quota_tokens token
          join public.advice_transfer_stimuli stimulus
            on stimulus.stimulus_id = token.stimulus_id
          join cell_counts counts
            on counts.stimulus_id = token.stimulus_id
           and counts.condition = token.condition
         where token.state = 'available'
           and token.slot_index <= v_target_per_cell
           and stimulus.active
           and stimulus.pair_role = 'primary'
         order by counts.completed, counts.active, random(), token.slot_index
         limit 1
         for update of token skip locked;

      if v_token.id is not null then
        v_stimulus_id := v_token.stimulus_id;
        v_condition := v_token.condition;
        v_reservation_kind := 'quota';
      elsif v_waited_seconds >= v_standby_after_seconds then
        -- Standby absorbs the brief mismatch between a Prolific return and
        -- database lease expiry. It never consumes a quota token unless a real
        -- vacancy later appears in the same cell.
        with cells as (
          select stimulus.stimulus_id,
                 stimulus.pair_number,
                 conditions.condition
            from public.advice_transfer_stimuli stimulus
            cross join (values ('human'::text), ('ai'::text)) conditions(condition)
           where stimulus.active
             and stimulus.pair_role = 'primary'
        ),
        token_status as (
          select token.stimulus_id,
                 token.condition,
                 min(token.reservation_expires_at) filter (where token.state = 'reserved') as next_expiry
            from public.advice_transfer_quota_tokens token
           where token.slot_index <= v_target_per_cell
           group by token.stimulus_id, token.condition
        ),
        standby_counts as (
          select assignment.stimulus_id,
                 assignment.condition,
                 count(*)::integer as standby_count
            from public.advice_transfer_assignments assignment
           where not assignment.is_test
             and assignment.reservation_kind = 'standby'
             and assignment.status in ('claimed', 'submitted')
           group by assignment.stimulus_id, assignment.condition
        )
        select cell.stimulus_id,
               cell.condition
          into v_stimulus_id,
               v_condition
          from cells cell
          left join token_status token
            on token.stimulus_id = cell.stimulus_id
           and token.condition = cell.condition
          left join standby_counts standby
            on standby.stimulus_id = cell.stimulus_id
           and standby.condition = cell.condition
         order by (token.next_expiry is null),
                  token.next_expiry,
                  coalesce(standby.standby_count, 0),
                  random()
         limit 1;

        v_reservation_kind := 'standby';
      else
        return jsonb_build_object(
          'admissionStatus', 'waiting',
          'queuePosition', v_queue_position,
          'waitedSeconds', v_waited_seconds,
          'retryAfterMs', v_poll_seconds * 1000,
          'message', 'Your study place is being prepared.',
          'serverTime', v_now
        );
      end if;

      select * into v_stimulus
        from public.advice_transfer_stimuli
       where stimulus_id = v_stimulus_id;
    end if;

    if v_stimulus.stimulus_id is null or v_condition is null then
      raise exception 'No eligible advice-transfer cell was available';
    end if;

    select jsonb_agg(comment_index order by random())
      into v_comment_order
      from generate_series(0, 4) indexes(comment_index);

    v_source_hashes := case
      when v_condition = 'human' then v_stimulus.human_comment_sha256
      else v_stimulus.ai_comment_sha256
    end;

    select jsonb_agg(v_source_hashes -> ordered.comment_index order by ordered.position)
      into v_ordered_hashes
      from (
        select value::integer as comment_index, ordinality as position
          from jsonb_array_elements_text(v_comment_order) with ordinality
      ) ordered;

    insert into public.advice_transfer_assignments (
      assignment_id,
      prolific_pid,
      study_id,
      session_id,
      stimulus_id,
      pair_number,
      condition,
      comment_order,
      presented_comment_sha256,
      is_test,
      reservation_kind,
      quota_token_id,
      standby_enqueued_at,
      last_heartbeat_at,
      lease_expires_at
    ) values (
      'at-' || replace(gen_random_uuid()::text, '-', ''),
      p_prolific_pid,
      p_study_id,
      p_session_id,
      v_stimulus.stimulus_id,
      v_stimulus.pair_number,
      v_condition,
      v_comment_order,
      v_ordered_hashes,
      v_is_test,
      v_reservation_kind,
      v_token.id,
      case when v_reservation_kind = 'standby' then v_waiter.enqueued_at else null end,
      v_now,
      v_now + make_interval(mins => v_lease_minutes)
    )
    returning * into v_assignment;

    if not v_is_test then
      delete from public.advice_transfer_waitlist
       where prolific_pid = p_prolific_pid
         and study_id = coalesce(p_study_id, '')
         ;
    end if;

    if v_reservation_kind = 'quota' then
      update public.advice_transfer_quota_tokens
         set state = 'reserved',
             current_assignment_id = v_assignment.assignment_id,
             reservation_expires_at = v_assignment.lease_expires_at,
             updated_at = v_now
       where id = v_token.id
         and state = 'available';
      if not found then
        raise exception 'The selected Study 2 quota token was no longer available';
      end if;
    end if;
  else
    select * into v_stimulus
      from public.advice_transfer_stimuli
     where stimulus_id = v_assignment.stimulus_id;
    v_condition := v_assignment.condition;
  end if;

  if v_stimulus.stimulus_id is null then
    select * into v_stimulus
      from public.advice_transfer_stimuli
     where stimulus_id = v_assignment.stimulus_id;
  end if;

  v_source_comments := case
    when v_assignment.condition = 'human' then v_stimulus.human_comments
    else v_stimulus.ai_comments
  end;
  v_source_hashes := case
    when v_assignment.condition = 'human' then v_stimulus.human_comment_sha256
    else v_stimulus.ai_comment_sha256
  end;

  select jsonb_agg(v_source_comments -> ordered.comment_index order by ordered.position),
         jsonb_agg(v_source_hashes -> ordered.comment_index order by ordered.position)
    into v_ordered_comments,
         v_ordered_hashes
    from (
      select value::integer as comment_index, ordinality as position
        from jsonb_array_elements_text(v_assignment.comment_order) with ordinality
    ) ordered;

  -- Neither condition nor model names are returned to the participant client.
  return jsonb_build_object(
    'admissionStatus', 'assigned',
    'assignmentId', v_assignment.assignment_id,
    'schemaVersion', v_assignment.protocol_version,
    'protocolVersion', v_assignment.protocol_version,
    'status', v_assignment.status,
    'isTest', v_assignment.is_test,
    'pairNumber', v_stimulus.pair_number,
    'pairRole', v_stimulus.pair_role,
    'designVariant', v_assignment.design_variant,
    'postTaskMeasure', v_assignment.post_task_measure,
    'exposurePost', jsonb_build_object(
      'postId', v_stimulus.exposure_post_id,
      'title', v_stimulus.exposure_post_title,
      'body', v_stimulus.exposure_post_body,
      'sha256', v_stimulus.exposure_post_body_sha256
    ),
    'targetPost', jsonb_build_object(
      'postId', v_stimulus.target_post_id,
      'title', v_stimulus.target_post_title,
      'body', v_stimulus.target_post_body,
      'sha256', v_stimulus.target_post_body_sha256
    ),
    'responsePost', case
      when v_assignment.design_variant = 'same_post' then jsonb_build_object(
        'postId', v_stimulus.exposure_post_id,
        'title', v_stimulus.exposure_post_title,
        'body', v_stimulus.exposure_post_body,
        'sha256', v_stimulus.exposure_post_body_sha256
      )
      else jsonb_build_object(
        'postId', v_stimulus.target_post_id,
        'title', v_stimulus.target_post_title,
        'body', v_stimulus.target_post_body,
        'sha256', v_stimulus.target_post_body_sha256
      )
    end,
    'comments', v_ordered_comments,
    'commentHashes', v_ordered_hashes,
    'commentOrder', v_assignment.comment_order,
    'comprehensionFailures', v_assignment.comprehension_failures,
    'draftPayload', public.advice_transfer_locked_payload(v_assignment, v_assignment.draft_payload),
    'draftUpdatedAt', v_assignment.draft_updated_at,
    'phase1Snapshot', v_assignment.phase1_snapshot,
    'phase1LockedAt', v_assignment.phase1_locked_at,
    'phase2Snapshot', v_assignment.phase2_snapshot,
    'phase2LockedAt', v_assignment.phase2_locked_at,
    'claimedAt', v_assignment.claimed_at,
    'leaseExpiresAt', v_assignment.lease_expires_at,
    'screenedOutAt', v_assignment.screened_out_at,
    'submittedAt', v_assignment.submitted_at,
    'serverTime', v_now
  );
exception when lock_not_available then
  return jsonb_build_object(
    'admissionStatus', 'waiting',
    'reason', 'server_busy',
    'retryAfterMs', 500 + floor(random() * 1500)::integer,
    'message', 'Your study place is being prepared. Please keep this page open.',
    'serverTime', clock_timestamp()
  );
end;
$$;

create or replace function public.claim_advice_transfer_assignment_v4(
  p_prolific_pid text,
  p_study_id text default null,
  p_session_id text default null,
  p_is_test boolean default false,
  p_pair_number integer default null,
  p_condition text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '250ms'
as $$
declare
  v_existing_id uuid;
  v_assignment public.advice_transfer_assignments%rowtype;
  v_response jsonb;
  v_clean_comments jsonb;
  v_clean_hashes jsonb;
  v_legacy_comments jsonb;
  v_legacy_hashes jsonb;
  v_pid text := nullif(trim(p_prolific_pid), '');
  v_study text := nullif(trim(p_study_id), '');
  v_session text := nullif(trim(p_session_id), '');
  v_is_test boolean := coalesce(v_pid ~* '^(test|preview|qa)[-_]', false);
begin
  perform pg_advisory_xact_lock(hashtext('advice_transfer_admission_v3'));
  select id into v_existing_id
    from public.advice_transfer_assignments
   where prolific_pid = v_pid
     and coalesce(study_id, '') = coalesce(v_study, '')
     and (
       (v_is_test and coalesce(session_id, '') = coalesce(v_session, ''))
       or (not v_is_test and not is_test)
     )
   order by created_at desc
   limit 1;

  v_response := public.claim_advice_transfer_assignment(
    p_prolific_pid, p_study_id, p_session_id,
    p_is_test, p_pair_number, p_condition
  );
  if v_response ->> 'admissionStatus' <> 'assigned' then
    return v_response;
  end if;

  if v_existing_id is null then
    update public.advice_transfer_assignments
       set protocol_version = 'advice-transfer-v4-gist'
     where assignment_id = v_response ->> 'assignmentId'
     returning * into v_assignment;
  else
    select * into v_assignment
      from public.advice_transfer_assignments
     where assignment_id = v_response ->> 'assignmentId';
  end if;

  if v_assignment.protocol_version = 'advice-transfer-v4-gist' then
    select jsonb_agg(to_jsonb(cleaned.comment_text) order by cleaned.position),
           jsonb_agg(
             to_jsonb(encode(extensions.digest(cleaned.comment_text, 'sha256'), 'hex'))
             order by cleaned.position
           ),
           jsonb_agg(to_jsonb(cleaned.legacy_text) order by cleaned.position),
           jsonb_agg(
             to_jsonb(encode(extensions.digest(cleaned.legacy_text, 'sha256'), 'hex'))
             order by cleaned.position
           )
      into v_clean_comments, v_clean_hashes, v_legacy_comments, v_legacy_hashes
      from (
        select ordinality as position,
               public.advice_transfer_remove_leading_judgment_label(value) as comment_text,
               public.advice_transfer_remove_judgment_labels(value) as legacy_text
          from jsonb_array_elements_text(v_response -> 'comments')
               with ordinality
      ) cleaned;

    -- New v4 sessions remove only the leading verdict token and persist hashes
    -- of exactly what participants see. Historical sessions that used the
    -- former all-position rule continue to receive their original display.
    if v_existing_id is null then
      update public.advice_transfer_assignments
         set presented_comment_sha256 = v_clean_hashes
       where assignment_id = v_assignment.assignment_id
      returning * into v_assignment;
    end if;

    if v_assignment.presented_comment_sha256 = v_clean_hashes then
      v_response := v_response || jsonb_build_object(
        'comments', v_clean_comments,
        'commentHashes', v_clean_hashes
      );
    elsif v_assignment.presented_comment_sha256 = v_legacy_hashes then
      v_response := v_response || jsonb_build_object(
        'comments', v_legacy_comments,
        'commentHashes', v_legacy_hashes
      );
    end if;
  end if;

  return v_response || jsonb_build_object(
    'schemaVersion', v_assignment.protocol_version,
    'protocolVersion', v_assignment.protocol_version,
    'designVariant', v_assignment.design_variant,
    'postTaskMeasure', v_assignment.post_task_measure,
    'responsePost', case
      when v_assignment.design_variant = 'same_post'
        then v_response -> 'exposurePost'
      else v_response -> 'targetPost'
    end,
    'draftPayload', public.advice_transfer_locked_payload(v_assignment, v_assignment.draft_payload),
    'phase1Snapshot', v_assignment.phase1_snapshot,
    'phase1LockedAt', v_assignment.phase1_locked_at,
    'phase2Snapshot', v_assignment.phase2_snapshot,
    'phase2LockedAt', v_assignment.phase2_locked_at
  );
exception when lock_not_available then
  return jsonb_build_object(
    'admissionStatus', 'waiting',
    'reason', 'server_busy',
    'retryAfterMs', 500 + floor(random() * 1500)::integer,
    'message', 'Your study place is being prepared. Please keep this page open.',
    'serverTime', clock_timestamp()
  );
end;
$$;

create or replace function public.claim_advice_transfer_assignment_same_post(
  p_prolific_pid text,
  p_study_id text default null,
  p_session_id text default null,
  p_is_test boolean default false,
  p_pair_number integer default null,
  p_condition text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '250ms'
as $$
declare
  v_existing_id uuid;
  v_response jsonb;
  v_assignment public.advice_transfer_assignments%rowtype;
  v_pid text := nullif(trim(p_prolific_pid), '');
  v_study text := nullif(trim(p_study_id), '');
  v_session text := nullif(trim(p_session_id), '');
  v_is_test boolean := coalesce(v_pid ~* '^(test|preview|qa)[-_]', false);
begin
  perform pg_advisory_xact_lock(hashtext('advice_transfer_admission_v3'));

  select id into v_existing_id
    from public.advice_transfer_assignments
   where prolific_pid = v_pid
     and coalesce(study_id, '') = coalesce(v_study, '')
     and (
       (v_is_test and coalesce(session_id, '') = coalesce(v_session, ''))
       or (not v_is_test and not is_test)
     )
   order by created_at desc
   limit 1;

  v_response := public.claim_advice_transfer_assignment_v4(
    p_prolific_pid, p_study_id, p_session_id,
    p_is_test, p_pair_number, p_condition
  );
  if v_response ->> 'admissionStatus' <> 'assigned' then
    return v_response;
  end if;

  select * into v_assignment
    from public.advice_transfer_assignments
   where assignment_id = v_response ->> 'assignmentId'
   for update;

  if v_existing_id is null
     and v_assignment.protocol_version = 'advice-transfer-v4-gist' then
    update public.advice_transfer_assignments
       set design_variant = 'same_post',
           post_task_measure = 'opinion_difficulty',
           updated_at = now()
     where id = v_assignment.id
     returning * into v_assignment;
  end if;

  return v_response || jsonb_build_object(
    'designVariant', v_assignment.design_variant,
    'postTaskMeasure', v_assignment.post_task_measure,
    'responsePost', case
      when v_assignment.design_variant = 'same_post'
        then v_response -> 'exposurePost'
      else v_response -> 'targetPost'
    end,
    'draftPayload', public.advice_transfer_locked_payload(
      v_assignment,
      v_assignment.draft_payload
    )
  );
exception when lock_not_available then
  return jsonb_build_object(
    'admissionStatus', 'waiting',
    'reason', 'server_busy',
    'retryAfterMs', 500 + floor(random() * 1500)::integer,
    'message', 'Your study place is being prepared. Please keep this page open.',
    'serverTime', clock_timestamp()
  );
end;
$$;

create or replace function public.heartbeat_advice_transfer_assignment(
  p_assignment_id text,
  p_prolific_pid text
)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '250ms'
as $$
declare
  v_assignment public.advice_transfer_assignments%rowtype;
  v_lease_minutes integer := 5;
  v_now timestamptz := now();
begin
  p_assignment_id := nullif(trim(p_assignment_id), '');
  p_prolific_pid := nullif(trim(p_prolific_pid), '');
  if p_assignment_id is null or p_prolific_pid is null then
    raise exception 'Missing assignment or participant identifier';
  end if;

  -- Common saves share this gate and only lock their own assignment/token.
  -- Quota ownership transitions take the exclusive gate BEFORE row locks.
  -- Never upgrade shared to exclusive here: promotion is deferred to an
  -- allocator/reclaim/review/final-submit transaction.
  perform pg_advisory_xact_lock_shared(hashtext('advice_transfer_admission_v3'));

  select greatest(3, least(30, coalesce((setting_value #>> '{}')::integer, 5)))
    into v_lease_minutes
    from public.advice_transfer_settings
   where setting_key = 'assignment_lease_minutes';
  v_lease_minutes := coalesce(v_lease_minutes, 5);

  select * into v_assignment
    from public.advice_transfer_assignments
   where assignment_id = p_assignment_id
     and prolific_pid = p_prolific_pid
   for update;

  if v_assignment.id is null then
    raise exception 'Assignment not found';
  end if;

  if v_assignment.status = 'submitted' then
    return jsonb_build_object(
      'ok', true,
      'status', 'submitted',
      'active', false,
      'serverTime', v_now
    );
  elsif v_assignment.status = 'abandoned'
        and v_assignment.abandonment_reason = 'lease_expired' then
    update public.advice_transfer_assignments
       set status = 'claimed',
           last_heartbeat_at = v_now,
           lease_expires_at = v_now + make_interval(mins => v_lease_minutes),
           disconnect_noted_at = null,
           abandoned_at = null,
           abandonment_reason = null,
           reservation_kind = case when is_test then 'test' else 'standby' end,
           quota_token_id = null,
           standby_enqueued_at = case
             when is_test then standby_enqueued_at
             else coalesce(standby_enqueued_at, v_now)
           end,
           updated_at = v_now
     where id = v_assignment.id
     returning * into v_assignment;
  end if;

  if v_assignment.status = 'claimed' then
    if not v_assignment.is_test
       and v_assignment.reservation_kind = 'quota'
       and not exists (
         select 1
           from public.advice_transfer_quota_tokens token
          where token.id = v_assignment.quota_token_id
            and token.state = 'reserved'
            and token.current_assignment_id = v_assignment.assignment_id
       ) then
      update public.advice_transfer_assignments
         set reservation_kind = 'standby',
             quota_token_id = null,
             standby_enqueued_at = coalesce(standby_enqueued_at, v_now)
       where id = v_assignment.id
       returning * into v_assignment;
    end if;

    update public.advice_transfer_assignments
       set last_heartbeat_at = v_now,
           lease_expires_at = v_now + make_interval(mins => v_lease_minutes),
           disconnect_noted_at = null,
           updated_at = v_now
     where id = v_assignment.id
     returning * into v_assignment;

    if not v_assignment.is_test and v_assignment.reservation_kind = 'quota' then
      update public.advice_transfer_quota_tokens
         set reservation_expires_at = v_assignment.lease_expires_at,
             updated_at = v_now
       where id = v_assignment.quota_token_id
         and state = 'reserved'
         and current_assignment_id = v_assignment.assignment_id;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', v_assignment.status,
    'active', v_assignment.status = 'claimed',
    'leaseExpiresAt', v_assignment.lease_expires_at,
    'serverTime', v_now
  );
end;
$$;

create or replace function public.save_advice_transfer_stage(
  p_assignment_id text,
  p_prolific_pid text,
  p_stage text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '250ms'
as $$
declare
  v_assignment public.advice_transfer_assignments%rowtype;
  v_stimulus public.advice_transfer_stimuli%rowtype;
  v_heartbeat jsonb;
  v_snapshot jsonb;
  v_locked_at timestamptz;
  v_already_saved boolean := false;
  v_judgments jsonb := '[]'::jsonb;
  v_judgment jsonb;
  v_position integer;
  v_comment_index integer;
  v_label text;
  v_gist text;
  v_gist_word_count integer;
  v_gist_difficulty integer;
  v_phase1_ms integer;
  v_gist_ms integer;
  v_advice text;
  v_word_count integer;
  v_difficulty integer;
  v_effort integer;
  v_confidence integer;
  v_advice_ms integer;
  v_timings jsonb;
  v_now timestamptz := now();
begin
  p_assignment_id := nullif(trim(p_assignment_id), '');
  p_prolific_pid := nullif(trim(p_prolific_pid), '');
  if p_assignment_id is null or p_prolific_pid is null then
    raise exception 'Missing assignment or participant identifier';
  end if;
  if p_stage is null or p_stage not in ('phase1', 'phase2') then
    raise exception 'Unknown Study 2 phase';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) is distinct from 'object'
     or octet_length(p_payload::text) > 200000 then
    raise exception 'Stage payload must be a JSON object no larger than 200000 bytes';
  end if;
  if p_payload ->> 'schemaVersion' is distinct from 'advice-transfer-v4-gist' then
    raise exception 'Stage payload protocol is not advice-transfer-v4-gist';
  end if;

  perform pg_advisory_xact_lock_shared(hashtext('advice_transfer_admission_v3'));
  select * into v_assignment
    from public.advice_transfer_assignments
   where assignment_id = p_assignment_id and prolific_pid = p_prolific_pid
   for update;
  if v_assignment.id is null then
    raise exception 'Assignment not found';
  end if;
  if v_assignment.protocol_version <> 'advice-transfer-v4-gist' then
    raise exception 'This assignment belongs to the legacy Study 2 protocol';
  end if;

  select * into v_stimulus
    from public.advice_transfer_stimuli
   where stimulus_id = v_assignment.stimulus_id;
  if v_stimulus.stimulus_id is null then
    raise exception 'Assigned Study 2 stimulus was not found';
  end if;

  v_snapshot := case when p_stage = 'phase1'
    then v_assignment.phase1_snapshot else v_assignment.phase2_snapshot end;
  v_locked_at := case when p_stage = 'phase1'
    then v_assignment.phase1_locked_at else v_assignment.phase2_locked_at end;
  v_already_saved := v_snapshot is not null;
  if not v_already_saved then
    if p_stage = 'phase2' and v_assignment.phase1_snapshot is null then
      raise exception 'Phase 1 must be saved before Phase 2';
    end if;
    v_heartbeat := public.heartbeat_advice_transfer_assignment(p_assignment_id, p_prolific_pid);
    if not coalesce((v_heartbeat ->> 'active')::boolean, false) then
      raise exception 'This assignment is no longer active';
    end if;
    select * into v_assignment
      from public.advice_transfer_assignments
     where assignment_id = p_assignment_id;
    if jsonb_typeof(p_payload -> 'timings') is distinct from 'object' then
      raise exception 'Stage timings are required';
    end if;
    v_timings := p_payload -> 'timings';

    if p_stage = 'phase1' then
      if jsonb_typeof(p_payload -> 'commentJudgments') is distinct from 'array' then
        raise exception 'Exactly five comment classifications are required';
      end if;
      if jsonb_array_length(p_payload -> 'commentJudgments') <> 5 then
        raise exception 'Exactly five comment classifications are required';
      end if;
      for v_position in 1..5 loop
        v_judgment := p_payload -> 'commentJudgments' -> (v_position - 1);
        if jsonb_typeof(v_judgment) is distinct from 'object' then
          raise exception 'Comment classification % is invalid', v_position;
        end if;
        if public.advice_transfer_required_integer(
             v_judgment -> 'displayPosition', 'displayPosition', 1, 5
           ) <> v_position then
          raise exception 'Comment classifications must match display positions 1 through 5';
        end if;
        v_comment_index := public.advice_transfer_required_integer(
          v_judgment -> 'commentIndex', 'commentIndex', 0, 4
        );
        if v_comment_index <> (v_assignment.comment_order ->> (v_position - 1))::integer
           or v_judgment ->> 'commentSha256' is distinct from
                v_assignment.presented_comment_sha256 ->> (v_position - 1) then
          raise exception 'Comment classification % does not match its assigned comment', v_position;
        end if;
        v_label := v_judgment ->> 'label';
        if v_label is null or v_label not in ('YTA', 'NTA', 'ESH', 'NAH', 'INFO') then
          raise exception 'Each comment requires one of YTA, NTA, ESH, NAH, or INFO';
        end if;
        v_judgments := v_judgments || jsonb_build_array(jsonb_build_object(
          'displayPosition', v_position,
          'commentIndex', v_comment_index,
          'commentSha256', v_assignment.presented_comment_sha256 ->> (v_position - 1),
          'label', v_label
        ));
      end loop;
      if jsonb_typeof(p_payload -> 'gistText') is distinct from 'string' then
        raise exception 'A nonempty gist summary is required';
      end if;
      v_gist := btrim(p_payload ->> 'gistText');
      if v_gist = '' or v_gist !~ '\S' then
        raise exception 'A nonempty gist summary is required';
      end if;
      v_gist_word_count := public.advice_transfer_word_count(v_gist);
      if v_gist_word_count < 25 then
        raise exception 'A gist summary of at least 25 English words is required';
      end if;
      v_gist_difficulty := public.advice_transfer_required_integer(
        p_payload -> 'gistDifficulty', 'gistDifficulty', 1, 7
      );
      v_phase1_ms := public.advice_transfer_required_integer(
        v_timings -> 'phase1ActiveTimeMs', 'phase1ActiveTimeMs', 0, 2147483647
      );
      v_gist_ms := public.advice_transfer_required_integer(
        v_timings -> 'gistActiveTimeMs', 'gistActiveTimeMs', 0, 2147483647
      );
      if v_gist_ms > v_phase1_ms then
        raise exception 'Gist time cannot exceed total Phase 1 active time';
      end if;
      v_now := clock_timestamp();
      v_snapshot := jsonb_build_object(
        'schemaVersion', v_assignment.protocol_version,
        'stage', 'phase1',
        'designVariant', v_assignment.design_variant,
        'postTaskMeasure', v_assignment.post_task_measure,
        'responsePostId', case
          when v_assignment.design_variant = 'same_post'
            then v_stimulus.exposure_post_id
          else v_stimulus.target_post_id
        end,
        'responsePostSha256', case
          when v_assignment.design_variant = 'same_post'
            then v_stimulus.exposure_post_body_sha256
          else v_stimulus.target_post_body_sha256
        end,
        'commentJudgments', v_judgments,
        'gistText', v_gist,
        'gistWordCount', v_gist_word_count,
        'gistDifficulty', v_gist_difficulty,
        'timings', v_timings || jsonb_build_object(
          'phase1ActiveTimeMs', v_phase1_ms, 'gistActiveTimeMs', v_gist_ms
        ),
        'lockedAt', v_now
      );
      update public.advice_transfer_assignments
         set phase1_snapshot = v_snapshot, phase1_locked_at = v_now, updated_at = v_now
       where id = v_assignment.id
       returning * into v_assignment;
    else
      if jsonb_typeof(p_payload -> 'adviceText') is distinct from 'string' then
        raise exception 'An opinion of at least 77 English words is required';
      end if;
      v_advice := btrim(p_payload ->> 'adviceText');
      v_word_count := public.advice_transfer_word_count(v_advice);
      if v_word_count < 77 then
        raise exception 'An opinion of at least 77 English words is required';
      end if;
      if p_payload ? 'postTaskMeasure'
         and p_payload ->> 'postTaskMeasure'
           is distinct from v_assignment.post_task_measure then
        raise exception 'Post-task measure does not match assignment';
      end if;
      if v_assignment.post_task_measure = 'opinion_difficulty' then
        v_difficulty := public.advice_transfer_required_integer(
          p_payload -> 'difficulty', 'difficulty', 1, 7
        );
        if p_payload -> 'effort' is not null
           and jsonb_typeof(p_payload -> 'effort') is distinct from 'null' then
          raise exception 'Effort is not collected for this assignment';
        end if;
        v_effort := null;
      else
        v_effort := public.advice_transfer_required_integer(
          p_payload -> 'effort', 'effort', 1, 7
        );
        if p_payload -> 'difficulty' is not null
           and jsonb_typeof(p_payload -> 'difficulty') is distinct from 'null' then
          raise exception 'Opinion difficulty is not collected for this assignment';
        end if;
        v_difficulty := null;
      end if;
      v_confidence := public.advice_transfer_required_integer(p_payload -> 'confidence', 'confidence', 1, 7);
      v_advice_ms := public.advice_transfer_required_integer(
        v_timings -> 'adviceResponseTimeMs', 'adviceResponseTimeMs', 0, 2147483647
      );
      v_now := greatest(clock_timestamp(), v_assignment.phase1_locked_at);
      v_snapshot := jsonb_build_object(
        'schemaVersion', v_assignment.protocol_version,
        'stage', 'phase2',
        'designVariant', v_assignment.design_variant,
        'postTaskMeasure', v_assignment.post_task_measure,
        'responsePostId', case
          when v_assignment.design_variant = 'same_post'
            then v_stimulus.exposure_post_id
          else v_stimulus.target_post_id
        end,
        'responsePostSha256', case
          when v_assignment.design_variant = 'same_post'
            then v_stimulus.exposure_post_body_sha256
          else v_stimulus.target_post_body_sha256
        end,
        'adviceText', v_advice,
        'adviceWordCount', v_word_count,
        'adviceCharacterCount', char_length(v_advice),
        'difficulty', v_difficulty,
        'effort', v_effort,
        'confidence', v_confidence,
        'timings', v_timings || jsonb_build_object('adviceResponseTimeMs', v_advice_ms),
        'lockedAt', v_now
      );
      update public.advice_transfer_assignments
         set phase2_snapshot = v_snapshot, phase2_locked_at = v_now, updated_at = v_now
       where id = v_assignment.id
       returning * into v_assignment;
    end if;
    v_locked_at := v_now;
    update public.advice_transfer_assignments
       set draft_payload = public.advice_transfer_locked_payload(v_assignment, draft_payload),
           draft_updated_at = v_now
     where id = v_assignment.id;
  end if;

  return jsonb_build_object(
    'ok', true,
    'stage', p_stage,
    'postTaskMeasure', v_assignment.post_task_measure,
    'alreadySaved', v_already_saved,
    'snapshot', v_snapshot,
    'lockedAt', v_locked_at,
    'phase1Snapshot', v_assignment.phase1_snapshot,
    'phase1LockedAt', v_assignment.phase1_locked_at,
    'phase2Snapshot', v_assignment.phase2_snapshot,
    'phase2LockedAt', v_assignment.phase2_locked_at,
    'serverTime', v_now
  );
end;
$$;

create or replace function public.save_advice_transfer_draft(
  p_assignment_id text,
  p_prolific_pid text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '250ms'
as $$
declare
  v_assignment public.advice_transfer_assignments%rowtype;
  v_heartbeat jsonb;
  v_now timestamptz := now();
begin
  p_assignment_id := nullif(trim(p_assignment_id), '');
  p_prolific_pid := nullif(trim(p_prolific_pid), '');
  if p_assignment_id is null or p_prolific_pid is null then
    raise exception 'Missing assignment or participant identifier';
  end if;
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Draft payload must be a JSON object';
  end if;
  if octet_length(p_payload::text) > 200000 then
    raise exception 'Draft payload is too large';
  end if;

  v_heartbeat := public.heartbeat_advice_transfer_assignment(
    p_assignment_id,
    p_prolific_pid
  );

  if coalesce((v_heartbeat ->> 'status'), '') = 'submitted' then
    select * into v_assignment
      from public.advice_transfer_assignments
     where assignment_id = p_assignment_id;
    return jsonb_build_object(
      'ok', true,
      'status', 'submitted',
      'savedAt', v_assignment.submitted_at,
      'alreadySubmitted', true
    );
  end if;

  if not coalesce((v_heartbeat ->> 'active')::boolean, false) then
    return jsonb_build_object(
      'ok', false,
      'status', coalesce(v_heartbeat ->> 'status', 'inactive'),
      'saved', false,
      'alreadySubmitted', false
    );
  end if;

  select * into v_assignment
    from public.advice_transfer_assignments
   where assignment_id = p_assignment_id
     and prolific_pid = p_prolific_pid
   for update;

  if v_assignment.id is null then
    raise exception 'Assignment not found';
  end if;
  if v_assignment.status <> 'claimed' then
    raise exception 'This assignment is no longer active';
  end if;

  if v_assignment.protocol_version = 'advice-transfer-v4-gist'
     and p_payload ->> 'schemaVersion' is distinct from v_assignment.protocol_version then
    raise exception 'Draft protocol does not match assignment';
  elsif v_assignment.protocol_version <> 'advice-transfer-v4-gist'
        and p_payload ->> 'schemaVersion' = 'advice-transfer-v4-gist' then
    raise exception 'A legacy draft cannot be replaced with a v4 draft';
  end if;

  update public.advice_transfer_assignments
     set draft_payload = public.advice_transfer_locked_payload(v_assignment, p_payload),
         draft_updated_at = v_now,
         updated_at = v_now
   where id = v_assignment.id;

  return jsonb_build_object(
    'ok', true,
    'status', 'claimed',
    'savedAt', v_now,
    'leaseExpiresAt', v_assignment.lease_expires_at,
    'phase1Snapshot', v_assignment.phase1_snapshot,
    'phase1LockedAt', v_assignment.phase1_locked_at,
    'phase2Snapshot', v_assignment.phase2_snapshot,
    'phase2LockedAt', v_assignment.phase2_locked_at,
    'alreadySubmitted', false
  );
end;
$$;

create or replace function public.withdraw_advice_transfer_assignment(
  p_assignment_id text,
  p_prolific_pid text,
  p_reason text default 'participant_withdrew'
)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '250ms'
as $$
declare
  v_assignment public.advice_transfer_assignments%rowtype;
  v_now timestamptz := now();
begin
  p_assignment_id := nullif(trim(p_assignment_id), '');
  p_prolific_pid := nullif(trim(p_prolific_pid), '');
  p_reason := lower(coalesce(nullif(trim(p_reason), ''), 'participant_withdrew'));
  if p_assignment_id is null or p_prolific_pid is null then
    raise exception 'Missing assignment or participant identifier';
  end if;
  if p_reason not in ('consent_declined', 'participant_withdrew') then
    raise exception 'Invalid withdrawal reason';
  end if;

  perform pg_advisory_xact_lock(hashtext('advice_transfer_admission_v3'));
  perform public.reclaim_expired_advice_transfer_assignments();

  select * into v_assignment
    from public.advice_transfer_assignments
   where assignment_id = p_assignment_id
     and prolific_pid = p_prolific_pid
   for update;

  if v_assignment.id is null then
    raise exception 'Assignment not found';
  end if;
  if v_assignment.status = 'submitted' then
    return jsonb_build_object('ok', true, 'status', 'submitted');
  end if;
  if v_assignment.status = 'claimed'
     or (v_assignment.status = 'abandoned'
         and v_assignment.abandonment_reason = 'lease_expired') then
    update public.advice_transfer_quota_tokens
       set state = 'available',
           current_assignment_id = null,
           reservation_expires_at = null,
           updated_at = v_now
     where current_assignment_id = v_assignment.assignment_id
       and state = 'reserved';

    update public.advice_transfer_assignments
       set status = 'abandoned',
           lease_expires_at = null,
           disconnect_noted_at = null,
           abandoned_at = v_now,
           abandonment_reason = p_reason,
           reservation_kind = case when is_test then 'test' else 'released' end,
           quota_token_id = null,
           updated_at = v_now
     where id = v_assignment.id;

    if not v_assignment.is_test then
      perform public.promote_advice_transfer_standby(
        v_assignment.stimulus_id,
        v_assignment.condition
      );
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', 'abandoned',
    'releasedAt', v_now
  );
end;
$$;

create or replace function public.mark_advice_transfer_departure(
  p_assignment_id text,
  p_prolific_pid text,
  p_draft_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '250ms'
as $$
declare
  v_assignment public.advice_transfer_assignments%rowtype;
  v_grace_seconds integer := 90;
  v_release_at timestamptz;
  v_now timestamptz := now();
begin
  p_assignment_id := nullif(trim(p_assignment_id), '');
  p_prolific_pid := nullif(trim(p_prolific_pid), '');
  if p_assignment_id is null or p_prolific_pid is null then
    raise exception 'Missing assignment or participant identifier';
  end if;
  if p_draft_payload is not null
     and (
       jsonb_typeof(p_draft_payload) <> 'object'
       or octet_length(p_draft_payload::text) > 200000
     ) then
    raise exception 'Departure draft payload is invalid or too large';
  end if;

  -- Shared gate before the participant row, matching heartbeat/stage saves.
  -- Departure only shortens the lease of this participant's existing token.
  perform pg_advisory_xact_lock_shared(hashtext('advice_transfer_admission_v3'));

  select greatest(30, least(600, coalesce((setting_value #>> '{}')::integer, 90)))
    into v_grace_seconds
    from public.advice_transfer_settings
   where setting_key = 'departure_grace_seconds';
  v_grace_seconds := coalesce(v_grace_seconds, 90);
  v_release_at := v_now + make_interval(secs => v_grace_seconds);

  select * into v_assignment
    from public.advice_transfer_assignments
   where assignment_id = p_assignment_id
     and prolific_pid = p_prolific_pid
   for update;

  if v_assignment.id is null then
    raise exception 'Assignment not found';
  end if;

  if p_draft_payload is not null then
    if v_assignment.protocol_version = 'advice-transfer-v4-gist'
       and p_draft_payload ->> 'schemaVersion' is distinct from v_assignment.protocol_version then
      raise exception 'Departure draft protocol does not match assignment';
    elsif v_assignment.protocol_version <> 'advice-transfer-v4-gist'
          and p_draft_payload ->> 'schemaVersion' = 'advice-transfer-v4-gist' then
      raise exception 'A legacy draft cannot be replaced with a v4 draft';
    end if;
  end if;

  if v_assignment.status = 'claimed' then
    update public.advice_transfer_assignments
       set disconnect_noted_at = v_now,
           draft_payload = case
             when p_draft_payload is null then draft_payload
             else public.advice_transfer_locked_payload(v_assignment, p_draft_payload)
           end,
           draft_updated_at = case
             when p_draft_payload is null then draft_updated_at
             else v_now
           end,
           lease_expires_at = least(
             coalesce(lease_expires_at, v_release_at),
             v_release_at
           ),
           updated_at = v_now
     where id = v_assignment.id
     returning * into v_assignment;

    if v_assignment.reservation_kind = 'quota' then
      update public.advice_transfer_quota_tokens
         set reservation_expires_at = v_assignment.lease_expires_at,
             updated_at = v_now
       where id = v_assignment.quota_token_id
         and state = 'reserved'
         and current_assignment_id = v_assignment.assignment_id;
    end if;
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', v_assignment.status,
    'releaseAfter', v_assignment.lease_expires_at,
    'phase1Snapshot', v_assignment.phase1_snapshot,
    'phase1LockedAt', v_assignment.phase1_locked_at,
    'phase2Snapshot', v_assignment.phase2_snapshot,
    'phase2LockedAt', v_assignment.phase2_locked_at,
    'serverTime', v_now
  );
end;
$$;

create or replace function public.mark_advice_transfer_departure(
  p_assignment_id text,
  p_prolific_pid text
)
returns jsonb
language sql
security definer
set search_path = public
set lock_timeout = '250ms'
as $$
  select public.mark_advice_transfer_departure(
    p_assignment_id,
    p_prolific_pid,
    null::jsonb
  );
$$;

create or replace function public.record_advice_transfer_comprehension_failure(
  p_assignment_id text,
  p_selected_option text default null,
  p_payload jsonb default '{}'::jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '250ms'
as $$
declare
  v_assignment public.advice_transfer_assignments%rowtype;
  v_event_id text := nullif(p_payload ->> 'clientEventId', '');
  v_failures integer;
  v_status text;
  v_lease_minutes integer := 5;
  v_now timestamptz := now();
begin
  select greatest(3, least(30, coalesce((setting_value #>> '{}')::integer, 5)))
    into v_lease_minutes
    from public.advice_transfer_settings
   where setting_key = 'assignment_lease_minutes';
  v_lease_minutes := coalesce(v_lease_minutes, 5);

  perform pg_advisory_xact_lock(hashtext('advice_transfer_admission_v3'));
  perform public.reclaim_expired_advice_transfer_assignments();

  select * into v_assignment
    from public.advice_transfer_assignments
   where assignment_id = p_assignment_id
   for update;

  if v_assignment.id is null then
    raise exception 'Assignment not found';
  end if;
  -- Retrying a recorded answer after acknowledgement loss is one attempt.
  -- Old clients without an event id retain their existing behavior.
  if v_event_id is not null then
    if length(v_event_id) > 128 then
      raise exception 'Comprehension event identifier is too long';
    end if;
    if exists (
      select 1 from jsonb_array_elements(v_assignment.comprehension_events) event
       where event #>> '{payload,clientEventId}' = v_event_id
    ) then
      return jsonb_build_object(
        'status', v_assignment.status,
        'comprehensionFailures', v_assignment.comprehension_failures,
        'screenedOut', v_assignment.status = 'screened_out',
        'alreadyRecorded', true
      );
    end if;
  end if;

  if v_assignment.status = 'submitted' then
    return jsonb_build_object(
      'status', v_assignment.status,
      'comprehensionFailures', v_assignment.comprehension_failures,
      'screenedOut', false
    );
  end if;
  if v_assignment.status = 'screened_out' then
    return jsonb_build_object(
      'status', v_assignment.status,
      'comprehensionFailures', v_assignment.comprehension_failures,
      'screenedOut', true
    );
  end if;
  if v_assignment.status = 'abandoned'
     and v_assignment.abandonment_reason = 'lease_expired' then
    update public.advice_transfer_assignments
       set status = 'claimed',
           last_heartbeat_at = v_now,
           lease_expires_at = v_now + make_interval(mins => v_lease_minutes),
           disconnect_noted_at = null,
           abandoned_at = null,
           abandonment_reason = null,
           reservation_kind = case when is_test then 'test' else 'standby' end,
           quota_token_id = null,
           standby_enqueued_at = case
             when is_test then standby_enqueued_at
             else coalesce(standby_enqueued_at, v_now)
           end
     where id = v_assignment.id;
    v_assignment.status := 'claimed';
    v_assignment.reservation_kind := case when v_assignment.is_test then 'test' else 'standby' end;
    v_assignment.quota_token_id := null;

    if not v_assignment.is_test then
      perform public.promote_advice_transfer_standby(
        v_assignment.stimulus_id,
        v_assignment.condition
      );
      select * into v_assignment
        from public.advice_transfer_assignments
       where id = v_assignment.id;
    end if;
  end if;
  if v_assignment.status <> 'claimed' then
    raise exception 'This assignment is no longer active';
  end if;

  v_failures := least(2, v_assignment.comprehension_failures + 1);
  v_status := case when v_failures >= 2 then 'screened_out' else 'claimed' end;

  update public.advice_transfer_assignments
     set comprehension_failures = v_failures,
         comprehension_events = comprehension_events || jsonb_build_array(
           jsonb_build_object(
             'selectedOption', nullif(trim(p_selected_option), ''),
             'occurredAt', v_now,
             'payload', coalesce(p_payload, '{}'::jsonb)
           )
         ),
         status = v_status,
         screened_out_at = case when v_status = 'screened_out' then v_now else screened_out_at end,
         last_heartbeat_at = v_now,
         lease_expires_at = case
           when v_status = 'screened_out' then null
           else v_now + make_interval(mins => v_lease_minutes)
         end,
         updated_at = v_now
   where assignment_id = p_assignment_id;

  if v_status = 'screened_out' and not v_assignment.is_test then
    update public.advice_transfer_quota_tokens
       set state = 'available',
           current_assignment_id = null,
           reservation_expires_at = null,
           updated_at = v_now
     where current_assignment_id = v_assignment.assignment_id
       and state = 'reserved';

    update public.advice_transfer_assignments
       set reservation_kind = 'released',
           quota_token_id = null
     where id = v_assignment.id;

    perform public.promote_advice_transfer_standby(
      v_assignment.stimulus_id,
      v_assignment.condition
    );
  elsif v_status = 'claimed'
        and not v_assignment.is_test
        and v_assignment.reservation_kind = 'quota' then
    update public.advice_transfer_quota_tokens
       set reservation_expires_at = v_now + make_interval(mins => v_lease_minutes),
           updated_at = v_now
     where id = v_assignment.quota_token_id
       and state = 'reserved'
       and current_assignment_id = v_assignment.assignment_id;
  end if;

  return jsonb_build_object(
    'status', v_status,
    'comprehensionFailures', v_failures,
    'screenedOut', v_status = 'screened_out'
  );
end;
$$;

create or replace function public.submit_advice_transfer_payload(
  p_assignment_id text,
  p_payload jsonb
)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '250ms'
as $$
declare
  v_assignment public.advice_transfer_assignments%rowtype;
  v_stimulus public.advice_transfer_stimuli%rowtype;
  v_existing public.advice_transfer_submissions%rowtype;
  v_token public.advice_transfer_quota_tokens%rowtype;
  v_advice text;
  v_word_count integer;
  v_character_count integer;
  v_difficulty integer;
  v_effort integer;
  v_confidence integer;
  v_exposure_time integer;
  v_advice_time integer;
  v_purpose text;
  v_stood_out text;
  v_stood_out_details text;
  v_ai_belief text;
  v_ai_likelihood integer;
  v_gender_identity text;
  v_age_years integer;
  v_english_proficiency text;
  v_education_level text;
  v_employment_status text;
  v_quota_disposition text := 'standby';
  v_comment_judgments jsonb;
  v_gist_text text;
  v_gist_difficulty integer;
  v_phase1_ms integer;
  v_gist_ms integer;
  v_now timestamptz := now();
begin
  if p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'Submission payload must be a JSON object';
  end if;
  if octet_length(p_payload::text) > 200000 then
    raise exception 'Submission payload is too large';
  end if;

  perform pg_advisory_xact_lock(hashtext('advice_transfer_admission_v3'));
  perform public.reclaim_expired_advice_transfer_assignments();

  select * into v_assignment
    from public.advice_transfer_assignments
   where assignment_id = p_assignment_id
   for update;

  if v_assignment.id is null then
    raise exception 'Assignment not found';
  end if;
  if nullif(trim(p_payload #>> '{participant,prolificPid}'), '')
       is distinct from v_assignment.prolific_pid then
    raise exception 'Participant does not match assignment';
  end if;

  select * into v_existing
    from public.advice_transfer_submissions
   where assignment_id = p_assignment_id;
  if v_existing.id is not null then
    return jsonb_build_object(
      'ok', true,
      'status', 'submitted',
      'submittedAt', v_existing.submitted_at,
      'alreadySubmitted', true
    );
  end if;

  if v_assignment.status = 'screened_out' then
    raise exception 'This session ended after two incorrect attention-check answers';
  end if;
  if v_assignment.status = 'abandoned'
     and v_assignment.abandonment_reason = 'lease_expired' then
    update public.advice_transfer_assignments
       set status = 'claimed',
           reservation_kind = case when is_test then 'test' else 'standby' end,
           quota_token_id = null,
           standby_enqueued_at = case
             when is_test then standby_enqueued_at
             else coalesce(standby_enqueued_at, v_now)
           end,
           last_heartbeat_at = v_now,
           abandoned_at = null,
           abandonment_reason = null,
           updated_at = v_now
     where id = v_assignment.id
     returning * into v_assignment;
  elsif v_assignment.status <> 'claimed' then
    raise exception 'This assignment is no longer active';
  end if;

  if not v_assignment.is_test and v_assignment.reservation_kind = 'standby' then
    perform public.promote_advice_transfer_standby(
      v_assignment.stimulus_id,
      v_assignment.condition
    );
    select * into v_assignment
      from public.advice_transfer_assignments
     where id = v_assignment.id;
  end if;

  if v_assignment.is_test then
    v_quota_disposition := 'quota';
  elsif v_assignment.reservation_kind = 'quota' then
    select * into v_token
      from public.advice_transfer_quota_tokens
     where id = v_assignment.quota_token_id
       and state = 'reserved'
       and current_assignment_id = v_assignment.assignment_id
     for update;
    if v_token.id is not null then
      v_quota_disposition := 'quota';
    else
      update public.advice_transfer_assignments
         set reservation_kind = 'standby',
             quota_token_id = null,
             standby_enqueued_at = coalesce(standby_enqueued_at, v_now)
       where id = v_assignment.id
       returning * into v_assignment;
      v_quota_disposition := 'standby';
    end if;
  end if;

  select * into v_stimulus
    from public.advice_transfer_stimuli
   where stimulus_id = v_assignment.stimulus_id;

  if v_assignment.protocol_version = 'advice-transfer-v4-gist' then
    if p_payload ->> 'schemaVersion' is distinct from v_assignment.protocol_version then
      raise exception 'Submission protocol does not match assignment';
    end if;
    if v_assignment.phase1_snapshot is null or v_assignment.phase2_snapshot is null then
      raise exception 'Both Study 2 phases must be saved before final submission';
    end if;
    -- Never trust final/draft copies of locked data. This also makes a final
    -- retry safe after an earlier stage response was lost in transit.
    p_payload := public.advice_transfer_locked_payload(v_assignment, p_payload);
    v_comment_judgments := v_assignment.phase1_snapshot -> 'commentJudgments';
    v_gist_text := v_assignment.phase1_snapshot ->> 'gistText';
    v_gist_difficulty := public.advice_transfer_required_integer(
      v_assignment.phase1_snapshot -> 'gistDifficulty', 'gistDifficulty', 1, 7
    );
    v_phase1_ms := public.advice_transfer_required_integer(
      v_assignment.phase1_snapshot #> '{timings,phase1ActiveTimeMs}', 'phase1ActiveTimeMs', 0, 2147483647
    );
    v_gist_ms := public.advice_transfer_required_integer(
      v_assignment.phase1_snapshot #> '{timings,gistActiveTimeMs}', 'gistActiveTimeMs', 0, 2147483647
    );
    if p_payload -> 'demographics' is null
       or jsonb_typeof(p_payload -> 'demographics') is distinct from 'object' then
      raise exception 'Demographic responses are required';
    end if;
    v_gender_identity := lower(trim(coalesce(
      p_payload #>> '{demographics,genderIdentity}', ''
    )));
    v_age_years := public.advice_transfer_required_integer(
      p_payload #> '{demographics,ageYears}', 'ageYears', 18, 120
    );
    v_english_proficiency := lower(trim(coalesce(
      p_payload #>> '{demographics,englishProficiency}', ''
    )));
    v_education_level := lower(trim(coalesce(
      p_payload #>> '{demographics,educationLevel}', ''
    )));
    v_employment_status := lower(trim(coalesce(
      p_payload #>> '{demographics,employmentStatus}', ''
    )));
  elsif p_payload ->> 'schemaVersion' = 'advice-transfer-v4-gist' then
    raise exception 'A legacy assignment must finish using its original protocol';
  end if;

  v_advice := trim(coalesce(p_payload ->> 'adviceText', ''));
  v_word_count := public.advice_transfer_word_count(v_advice);
  v_character_count := char_length(v_advice);
  if v_assignment.protocol_version = 'advice-transfer-v4-gist' then
    if v_assignment.post_task_measure = 'opinion_difficulty' then
      if v_assignment.phase2_snapshot ->> 'postTaskMeasure'
           is distinct from 'opinion_difficulty' then
        raise exception 'Locked Phase 2 measure does not match assignment';
      end if;
      -- Historical server-locked snapshots predate these three audit keys.
      -- Preserve them unchanged; the assignment/trigger remains authoritative.
      -- If any audit key exists, require the complete matching set.
      if v_assignment.phase2_snapshot ?| array['designVariant', 'responsePostId', 'responsePostSha256']
         and (
           v_assignment.phase2_snapshot ->> 'designVariant'
             is distinct from v_assignment.design_variant
           or v_assignment.phase2_snapshot ->> 'responsePostId'
             is distinct from v_stimulus.exposure_post_id
           or v_assignment.phase2_snapshot ->> 'responsePostSha256'
             is distinct from v_stimulus.exposure_post_body_sha256
         ) then
        raise exception 'Locked Phase 2 design audit does not match assignment';
      end if;
      v_difficulty := public.advice_transfer_required_integer(
        v_assignment.phase2_snapshot -> 'difficulty', 'difficulty', 1, 7
      );
      v_effort := null;
    else
      if v_assignment.phase2_snapshot ? 'postTaskMeasure'
         and v_assignment.phase2_snapshot ->> 'postTaskMeasure'
           is distinct from 'effort' then
        raise exception 'Locked Phase 2 measure does not match assignment';
      end if;
      v_difficulty := null;
      v_effort := public.advice_transfer_required_integer(
        v_assignment.phase2_snapshot -> 'effort', 'effort', 1, 7
      );
    end if;
    v_confidence := public.advice_transfer_required_integer(
      v_assignment.phase2_snapshot -> 'confidence', 'confidence', 1, 7
    );
  else
    v_difficulty := nullif(p_payload ->> 'difficulty', '')::integer;
    v_effort := nullif(p_payload ->> 'effort', '')::integer;
    v_confidence := nullif(p_payload ->> 'confidence', '')::integer;
  end if;
  v_exposure_time := coalesce(nullif(p_payload #>> '{timings,exposureTimeMs}', '')::integer, 0);
  v_advice_time := coalesce(nullif(p_payload #>> '{timings,adviceResponseTimeMs}', '')::integer, 0);
  v_purpose := trim(coalesce(p_payload ->> 'purposeGuess', ''));
  v_stood_out := lower(trim(coalesce(p_payload ->> 'commentsStoodOut', '')));
  v_stood_out_details := nullif(trim(coalesce(p_payload ->> 'commentsStoodOutDetails', '')), '');
  v_ai_belief := lower(trim(coalesce(p_payload ->> 'aiGeneratedBelief', '')));
  v_ai_likelihood := case when v_assignment.protocol_version = 'advice-transfer-v4-gist'
    then public.advice_transfer_required_integer(p_payload -> 'aiLikelihood', 'aiLikelihood', 1, 7)
    else nullif(p_payload ->> 'aiLikelihood', '')::integer end;

  if v_word_count < 77 then
    raise exception 'Advice must contain at least 77 English words';
  end if;
  if (
       v_assignment.protocol_version <> 'advice-transfer-v4-gist'
       and (
         v_difficulty is null or v_difficulty not between 1 and 7
         or v_effort is null or v_effort not between 1 and 7
       )
     )
     or (
       v_assignment.protocol_version = 'advice-transfer-v4-gist'
       and v_assignment.post_task_measure = 'effort'
       and (
         v_difficulty is not null
         or v_effort is null or v_effort not between 1 and 7
       )
     )
     or (
       v_assignment.protocol_version = 'advice-transfer-v4-gist'
       and v_assignment.post_task_measure = 'opinion_difficulty'
       and (
         v_difficulty is null or v_difficulty not between 1 and 7
         or v_effort is not null
       )
     )
     or v_confidence is null or v_confidence not between 1 and 7 then
    raise exception 'Required post-task ratings must each be between 1 and 7';
  end if;
  if v_exposure_time < 0 or v_advice_time < 0 then
    raise exception 'Response times cannot be negative';
  end if;
  if v_purpose = '' or v_purpose !~ '\S' then
    raise exception 'The study-purpose response is required';
  end if;
  if v_stood_out not in ('yes', 'no', 'unsure') then
    raise exception 'The comment-notice response is required';
  end if;
  if v_ai_belief not in ('yes', 'no', 'unsure')
     or v_ai_likelihood is null or v_ai_likelihood not between 1 and 7 then
    raise exception 'The AI-source responses are required';
  end if;
  if v_assignment.protocol_version = 'advice-transfer-v4-gist' then
    if v_gender_identity not in ('male', 'female', 'other', 'prefer-not-to-say') then
      raise exception 'A valid gender identity response is required';
    end if;
    if v_english_proficiency not in
       ('yes', 'no-fluent', 'no-mostly-fluent', 'no-minimal-fluency') then
      raise exception 'A valid English-language response is required';
    end if;
    if v_education_level not in (
      'no-school',
      'eighth-grade-or-less',
      'more-than-eighth-less-than-high-school',
      'high-school-degree-or-equivalent',
      'some-college',
      'four-year-college-degree',
      'graduate-or-professional-training'
    ) then
      raise exception 'A valid education-level response is required';
    end if;
    if v_employment_status not in
       ('employed', 'self-employed', 'student', 'unemployed', 'other') then
      raise exception 'A valid employment-status response is required';
    end if;
  end if;

  insert into public.advice_transfer_submissions (
    assignment_id,
    prolific_pid,
    study_id,
    session_id,
    stimulus_id,
    pair_number,
    pair_role,
    condition,
    design_variant,
    post_task_measure,
    is_test,
    comment_order,
    comment_sha256,
    exposure_post_id,
    exposure_post_body_sha256,
    target_post_id,
    target_post_body_sha256,
    response_post_id,
    response_post_body_sha256,
    advice_text,
    advice_word_count,
    advice_character_count,
    difficulty,
    effort,
    confidence,
    exposure_time_ms,
    advice_response_time_ms,
    purpose_guess,
    comments_stood_out,
    comments_stood_out_details,
    ai_generated_belief,
    ai_likelihood,
    gender_identity,
    age_years,
    english_proficiency,
    education_level,
    employment_status,
    protocol_version,
    comment_judgments,
    gist_text,
    gist_difficulty,
    phase1_active_time_ms,
    gist_active_time_ms,
    phase1_locked_at,
    phase2_locked_at,
    full_payload,
    quota_disposition,
    submitted_at
  ) values (
    v_assignment.assignment_id,
    v_assignment.prolific_pid,
    v_assignment.study_id,
    v_assignment.session_id,
    v_assignment.stimulus_id,
    v_assignment.pair_number,
    v_stimulus.pair_role,
    v_assignment.condition,
    v_assignment.design_variant,
    v_assignment.post_task_measure,
    v_assignment.is_test,
    v_assignment.comment_order,
    v_assignment.presented_comment_sha256,
    v_stimulus.exposure_post_id,
    v_stimulus.exposure_post_body_sha256,
    v_stimulus.target_post_id,
    v_stimulus.target_post_body_sha256,
    case when v_assignment.design_variant = 'same_post'
      then v_stimulus.exposure_post_id else v_stimulus.target_post_id end,
    case when v_assignment.design_variant = 'same_post'
      then v_stimulus.exposure_post_body_sha256 else v_stimulus.target_post_body_sha256 end,
    v_advice,
    v_word_count,
    v_character_count,
    v_difficulty,
    v_effort,
    v_confidence,
    v_exposure_time,
    v_advice_time,
    v_purpose,
    v_stood_out,
    v_stood_out_details,
    v_ai_belief,
    v_ai_likelihood,
    v_gender_identity,
    v_age_years,
    v_english_proficiency,
    v_education_level,
    v_employment_status,
    v_assignment.protocol_version,
    v_comment_judgments,
    v_gist_text,
    v_gist_difficulty,
    v_phase1_ms,
    v_gist_ms,
    v_assignment.phase1_locked_at,
    v_assignment.phase2_locked_at,
    coalesce(p_payload, '{}'::jsonb) || jsonb_build_object(
      'serverAudit', jsonb_build_object(
        'schemaVersion', v_assignment.protocol_version,
        'stimulusId', v_assignment.stimulus_id,
        'pairNumber', v_assignment.pair_number,
        'pairRole', v_stimulus.pair_role,
        'condition', v_assignment.condition,
        'isTest', v_assignment.is_test,
        'designVariant', v_assignment.design_variant,
        'postTaskMeasure', v_assignment.post_task_measure,
        'commentOrder', v_assignment.comment_order,
        'commentHashes', v_assignment.presented_comment_sha256,
        'exposurePostId', v_stimulus.exposure_post_id,
        'exposurePostSha256', v_stimulus.exposure_post_body_sha256,
        'targetPostId', v_stimulus.target_post_id,
        'targetPostSha256', v_stimulus.target_post_body_sha256,
        'responsePostId', case when v_assignment.design_variant = 'same_post'
          then v_stimulus.exposure_post_id else v_stimulus.target_post_id end,
        'responsePostSha256', case when v_assignment.design_variant = 'same_post'
          then v_stimulus.exposure_post_body_sha256 else v_stimulus.target_post_body_sha256 end,
        'serverReceivedAt', v_now
      )
    ),
    v_quota_disposition,
    v_now
  );

  if not v_assignment.is_test and v_quota_disposition = 'quota' then
    update public.advice_transfer_quota_tokens
       set state = 'pending',
           reservation_expires_at = null,
           updated_at = v_now
     where id = v_assignment.quota_token_id
       and state = 'reserved'
       and current_assignment_id = v_assignment.assignment_id;

    if not found then
      -- A late browser must never steal a token that has already been given
      -- to its replacement. The response is retained as paid standby data.
      v_quota_disposition := 'standby';
      update public.advice_transfer_submissions
         set quota_disposition = 'standby'
       where assignment_id = p_assignment_id;
      update public.advice_transfer_assignments
         set reservation_kind = 'standby',
             quota_token_id = null,
             standby_enqueued_at = coalesce(standby_enqueued_at, v_now)
       where assignment_id = p_assignment_id;
    end if;
  end if;

  update public.advice_transfer_assignments
     set status = 'submitted',
         submitted_at = v_now,
         last_heartbeat_at = v_now,
         lease_expires_at = null,
         draft_payload = '{}'::jsonb,
         draft_updated_at = null,
         abandoned_at = null,
         abandonment_reason = null,
         updated_at = v_now
   where assignment_id = p_assignment_id;

  if not v_assignment.is_test and v_quota_disposition = 'standby' then
    perform public.promote_advice_transfer_standby(
      v_assignment.stimulus_id,
      v_assignment.condition
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'status', 'submitted',
    'submittedAt', v_now,
    'alreadySubmitted', false
  );
end;
$$;

create or replace function public.review_advice_transfer_assignment(
  p_assignment_id text,
  p_decision text,
  p_reason text default null
)
returns jsonb
language plpgsql
security definer
set search_path = public
set lock_timeout = '250ms'
as $$
declare
  v_assignment public.advice_transfer_assignments%rowtype;
  v_submission public.advice_transfer_submissions%rowtype;
  v_reopened boolean := false;
  v_now timestamptz := now();
begin
  p_assignment_id := nullif(trim(p_assignment_id), '');
  p_decision := lower(nullif(trim(p_decision), ''));
  p_reason := nullif(trim(p_reason), '');

  if p_assignment_id is null then
    raise exception 'Missing assignment id';
  end if;
  if p_decision is null or p_decision not in ('valid', 'excluded', 'abandoned') then
    raise exception 'Decision must be valid, excluded, or abandoned';
  end if;

  perform pg_advisory_xact_lock(hashtext('advice_transfer_admission_v3'));
  perform public.reclaim_expired_advice_transfer_assignments();
  select * into v_assignment
    from public.advice_transfer_assignments
   where assignment_id = p_assignment_id
   for update;

  if v_assignment.id is null then
    raise exception 'Assignment not found';
  end if;
  if v_assignment.is_test then
    raise exception 'Test assignments do not occupy formal quotas';
  end if;

  select * into v_submission
    from public.advice_transfer_submissions
   where assignment_id = p_assignment_id
   for update;

  if p_decision = 'valid' then
    if v_assignment.status <> 'submitted' or v_submission.id is null then
      raise exception 'Only a submitted response can be marked valid';
    end if;

    update public.advice_transfer_submissions
       set validity_status = 'valid',
           reviewed_at = v_now,
           exclusion_reason = null
     where assignment_id = p_assignment_id;

    if v_submission.quota_disposition = 'quota' then
      update public.advice_transfer_quota_tokens
         set state = 'valid',
             reservation_expires_at = null,
             updated_at = v_now
       where id = v_assignment.quota_token_id
         and current_assignment_id = p_assignment_id
         and state in ('pending', 'valid');
      if not found then
        raise exception 'A quota response could not be matched to its quota token';
      end if;
    end if;
  elsif p_decision = 'excluded' then
    if v_submission.id is null then
      raise exception 'Only a submitted response can be excluded';
    end if;

    update public.advice_transfer_submissions
       set validity_status = 'excluded',
           reviewed_at = v_now,
           exclusion_reason = p_reason
     where assignment_id = p_assignment_id;

    if v_submission.quota_disposition = 'quota' then
      update public.advice_transfer_quota_tokens
         set state = 'available',
             current_assignment_id = null,
             reservation_expires_at = null,
             updated_at = v_now
       where id = v_assignment.quota_token_id
         and current_assignment_id = p_assignment_id
         and state in ('pending', 'valid');
      v_reopened := found;
    end if;

    update public.advice_transfer_assignments
       set status = 'excluded',
           lease_expires_at = null,
           reservation_kind = 'released',
           quota_token_id = null,
           abandoned_at = null,
           abandonment_reason = p_reason,
           updated_at = v_now
     where assignment_id = p_assignment_id;
  else
    if v_assignment.status = 'submitted' then
      raise exception 'A submitted response must be marked valid or excluded';
    end if;

    update public.advice_transfer_quota_tokens
       set state = 'available',
           current_assignment_id = null,
           reservation_expires_at = null,
           updated_at = v_now
     where id = v_assignment.quota_token_id
       and current_assignment_id = p_assignment_id
       and state = 'reserved';
    v_reopened := found;

    update public.advice_transfer_assignments
       set status = 'abandoned',
           lease_expires_at = null,
           reservation_kind = 'released',
           quota_token_id = null,
           abandoned_at = v_now,
           abandonment_reason = coalesce(p_reason, 'researcher_released'),
           updated_at = v_now
     where assignment_id = p_assignment_id;
  end if;

  if v_reopened then
    perform public.promote_advice_transfer_standby(
      v_assignment.stimulus_id,
      v_assignment.condition
    );
  end if;

  return jsonb_build_object(
    'ok', true,
    'assignmentId', p_assignment_id,
    'decision', p_decision,
    'quotaReopened', v_reopened,
    'reviewedAt', v_now
  );
end;
$$;

commit;
