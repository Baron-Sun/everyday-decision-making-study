-- Checked deployment of the Study 2 concurrency upgrade.
-- Accepts the committed setup and verified live migration variants.
-- Exact before/after body hashes guard every patch; unknown versions abort.
-- Includes compatibility for already locked historical phase snapshots.
-- No recruitment, target, stimulus, or participant records are changed.
begin;
set local lock_timeout = '5s';
select pg_advisory_xact_lock(hashtext('advice_transfer_admission_v3'));
create index if not exists advice_transfer_claimed_lease_idx
  on public.advice_transfer_assignments (lease_expires_at)
  where status = 'claimed' and lease_expires_at is not null;

do $upgrade$
declare
  v_oid oid := 'public.ensure_advice_transfer_quota_tokens()'::regprocedure;
  v_body text;
  v_original text;
  v_definition text;
begin
  select prosrc, pg_get_functiondef(oid) into v_original, v_definition
    from pg_proc where oid = v_oid;
  v_body := v_original;
  if md5(v_original) = '17984ccf94538e7d57912118d8029f12' then
    v_body := overlay(v_body placing $patch$    return 0;
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
$patch$ from 345 for 0);
  elsif md5(v_original) <> 'ade65bc0084b0d9f666404f872c70b94' then
    raise exception 'Unexpected installed definition: ensure_advice_transfer_quota_tokens(); inspect before upgrading';
  end if;
  if md5(v_body) <> 'ade65bc0084b0d9f666404f872c70b94' then
    raise exception 'Concurrency patch verification failed: ensure_advice_transfer_quota_tokens()';
  end if;
  if v_body is distinct from v_original then
    execute replace(v_definition, v_original, v_body);
  end if;
end;
$upgrade$;

alter function public.ensure_advice_transfer_quota_tokens() set lock_timeout = '250ms';

do $upgrade$
declare
  v_oid oid := 'public.claim_advice_transfer_assignment(text,text,text,boolean,integer,text)'::regprocedure;
  v_body text;
  v_original text;
  v_definition text;
begin
  select prosrc, pg_get_functiondef(oid) into v_original, v_definition
    from pg_proc where oid = v_oid;
  v_body := v_original;
  if md5(v_original) = '5a9c6dec6f669dd3ece64cdd5fc3e931' then
    v_body := overlay(v_body placing $patch$exception when lock_not_available then
  return jsonb_build_object(
    'admissionStatus', 'waiting',
    'reason', 'server_busy',
    'retryAfterMs', 500 + floor(random() * 1500)::integer,
    'message', 'Your study place is being prepared. Please keep this page open.',
    'serverTime', clock_timestamp()
  );
$patch$ from 21369 for 0);
    v_body := overlay(v_body placing $patch$      elsif v_waited_seconds >= v_standby_after_seconds then
$patch$ from 13041 for 86);
    v_body := overlay(v_body placing $patch$$patch$ from 12862 for 14);
    v_body := overlay(v_body placing $patch$      -- An absent queue head must not block a free token. The exclusive
      -- admission gate and token row still enforce each cell's hard cap.
      with cell_counts as (
$patch$ from 11703 for 65);
    v_body := overlay(v_body placing $patch$           and exists (
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
$patch$ from 10353 for 0);
    v_body := overlay(v_body placing $patch$      -- Preserve existing standby priority, including work just revived by a
      -- shared heartbeat. Skip cells with no eligible standby rather than
      -- invoking the promotion function for all 20 cells on every arrival.
$patch$ from 10002 for 121);
  elsif md5(v_original) = '2758768122b34c5a98a7b36ef9b9853b' then
    v_body := overlay(v_body placing $patch$exception when lock_not_available then
  return jsonb_build_object(
    'admissionStatus', 'waiting',
    'reason', 'server_busy',
    'retryAfterMs', 500 + floor(random() * 1500)::integer,
    'message', 'Your study place is being prepared. Please keep this page open.',
    'serverTime', clock_timestamp()
  );
$patch$ from 20717 for 0);
    v_body := overlay(v_body placing $patch$    'responsePost', case
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
$patch$ from 19943 for 0);
    v_body := overlay(v_body placing $patch$    'designVariant', v_assignment.design_variant,
    'postTaskMeasure', v_assignment.post_task_measure,
$patch$ from 19479 for 0);
    v_body := overlay(v_body placing $patch$      elsif v_waited_seconds >= v_standby_after_seconds then
$patch$ from 13041 for 86);
    v_body := overlay(v_body placing $patch$$patch$ from 12862 for 14);
    v_body := overlay(v_body placing $patch$      -- An absent queue head must not block a free token. The exclusive
      -- admission gate and token row still enforce each cell's hard cap.
      with cell_counts as (
$patch$ from 11703 for 65);
    v_body := overlay(v_body placing $patch$           and exists (
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
$patch$ from 10353 for 0);
    v_body := overlay(v_body placing $patch$      -- Preserve existing standby priority, including work just revived by a
      -- shared heartbeat. Skip cells with no eligible standby rather than
      -- invoking the promotion function for all 20 cells on every arrival.
$patch$ from 10002 for 121);
  elsif md5(v_original) <> 'c4388401f2654114c5610c57c8840621' then
    raise exception 'Unexpected installed definition: claim_advice_transfer_assignment(text,text,text,boolean,integer,text); inspect before upgrading';
  end if;
  if md5(v_body) <> 'c4388401f2654114c5610c57c8840621' then
    raise exception 'Concurrency patch verification failed: claim_advice_transfer_assignment(text,text,text,boolean,integer,text)';
  end if;
  if v_body is distinct from v_original then
    execute replace(v_definition, v_original, v_body);
  end if;
end;
$upgrade$;

alter function public.claim_advice_transfer_assignment(text,text,text,boolean,integer,text) set lock_timeout = '250ms';

do $upgrade$
declare
  v_oid oid := 'public.claim_advice_transfer_assignment_v4(text,text,text,boolean,integer,text)'::regprocedure;
  v_body text;
  v_original text;
  v_definition text;
begin
  select prosrc, pg_get_functiondef(oid) into v_original, v_definition
    from pg_proc where oid = v_oid;
  v_body := v_original;
  if md5(v_original) = '85357300b36185b89de8a50b5d3c0787' then
    v_body := overlay(v_body placing $patch$exception when lock_not_available then
  return jsonb_build_object(
    'admissionStatus', 'waiting',
    'reason', 'server_busy',
    'retryAfterMs', 500 + floor(random() * 1500)::integer,
    'message', 'Your study place is being prepared. Please keep this page open.',
    'serverTime', clock_timestamp()
  );
$patch$ from 4105 for 0);
  elsif md5(v_original) = 'b61bfe5c6d87608799e02b2bf14858ee' then
    v_body := overlay(v_body placing $patch$exception when lock_not_available then
  return jsonb_build_object(
    'admissionStatus', 'waiting',
    'reason', 'server_busy',
    'retryAfterMs', 500 + floor(random() * 1500)::integer,
    'message', 'Your study place is being prepared. Please keep this page open.',
    'serverTime', clock_timestamp()
  );
$patch$ from 3874 for 0);
    v_body := overlay(v_body placing $patch$    -- New v4 sessions remove only the leading verdict token and persist hashes
    -- of exactly what participants see. Historical sessions that used the
    -- former all-position rule continue to receive their original display.
$patch$ from 2450 for 0);
  elsif md5(v_original) <> 'fda70ff45a75fed08f64851dcf4104f3' then
    raise exception 'Unexpected installed definition: claim_advice_transfer_assignment_v4(text,text,text,boolean,integer,text); inspect before upgrading';
  end if;
  if md5(v_body) <> 'fda70ff45a75fed08f64851dcf4104f3' then
    raise exception 'Concurrency patch verification failed: claim_advice_transfer_assignment_v4(text,text,text,boolean,integer,text)';
  end if;
  if v_body is distinct from v_original then
    execute replace(v_definition, v_original, v_body);
  end if;
end;
$upgrade$;

alter function public.claim_advice_transfer_assignment_v4(text,text,text,boolean,integer,text) set lock_timeout = '250ms';

do $upgrade$
declare
  v_oid oid := 'public.claim_advice_transfer_assignment_same_post(text,text,text,boolean,integer,text)'::regprocedure;
  v_body text;
  v_original text;
  v_definition text;
begin
  select prosrc, pg_get_functiondef(oid) into v_original, v_definition
    from pg_proc where oid = v_oid;
  v_body := v_original;
  if md5(v_original) = '5bc38c8a4ff6cb01ff737ee081769f9c' then
    v_body := overlay(v_body placing $patch$exception when lock_not_available then
  return jsonb_build_object(
    'admissionStatus', 'waiting',
    'reason', 'server_busy',
    'retryAfterMs', 500 + floor(random() * 1500)::integer,
    'message', 'Your study place is being prepared. Please keep this page open.',
    'serverTime', clock_timestamp()
  );
$patch$ from 1928 for 0);
  elsif md5(v_original) = '20749b60bd623dba606f8c5182ff5f4d' then
    v_body := overlay(v_body placing $patch$exception when lock_not_available then
  return jsonb_build_object(
    'admissionStatus', 'waiting',
    'reason', 'server_busy',
    'retryAfterMs', 500 + floor(random() * 1500)::integer,
    'message', 'Your study place is being prepared. Please keep this page open.',
    'serverTime', clock_timestamp()
  );
$patch$ from 1979 for 0);
    v_body := overlay(v_body placing $patch$      v_assignment,
      v_assignment.draft_payload
$patch$ from 1921 for 47);
    v_body := overlay(v_body placing $patch$    'responsePost', case
      when v_assignment.design_variant = 'same_post'
        then v_response -> 'exposurePost'
      else v_response -> 'targetPost'
    end,
$patch$ from 1825 for 37);
    v_body := overlay(v_body placing $patch$$patch$ from 1516 for 161);
    v_body := overlay(v_body placing $patch$$patch$ from 932 for 1);
    v_body := overlay(v_body placing $patch$$patch$ from 336 for 25);
  elsif md5(v_original) <> '0978264828c664235a02291617b4005f' then
    raise exception 'Unexpected installed definition: claim_advice_transfer_assignment_same_post(text,text,text,boolean,integer,text); inspect before upgrading';
  end if;
  if md5(v_body) <> '0978264828c664235a02291617b4005f' then
    raise exception 'Concurrency patch verification failed: claim_advice_transfer_assignment_same_post(text,text,text,boolean,integer,text)';
  end if;
  if v_body is distinct from v_original then
    execute replace(v_definition, v_original, v_body);
  end if;
end;
$upgrade$;

alter function public.claim_advice_transfer_assignment_same_post(text,text,text,boolean,integer,text) set lock_timeout = '250ms';

do $upgrade$
declare
  v_oid oid := 'public.heartbeat_advice_transfer_assignment(text,text)'::regprocedure;
  v_body text;
  v_original text;
  v_definition text;
begin
  select prosrc, pg_get_functiondef(oid) into v_original, v_definition
    from pg_proc where oid = v_oid;
  v_body := v_original;
  if md5(v_original) = 'a2473c0065b32dae3cd8dff134c25c2b' then
    v_body := overlay(v_body placing $patch$$patch$ from 3533 for 330);
    v_body := overlay(v_body placing $patch$  -- Common saves share this gate and only lock their own assignment/token.
  -- Quota ownership transitions take the exclusive gate BEFORE row locks.
  -- Never upgrade shared to exclusive here: promotion is deferred to an
  -- allocator/reclaim/review/final-submit transaction.
  perform pg_advisory_xact_lock_shared(hashtext('advice_transfer_admission_v3'));
$patch$ from 386 for 301);
  elsif md5(v_original) <> '403097013020d953bc1ce163ddbfa102' then
    raise exception 'Unexpected installed definition: heartbeat_advice_transfer_assignment(text,text); inspect before upgrading';
  end if;
  if md5(v_body) <> '403097013020d953bc1ce163ddbfa102' then
    raise exception 'Concurrency patch verification failed: heartbeat_advice_transfer_assignment(text,text)';
  end if;
  if v_body is distinct from v_original then
    execute replace(v_definition, v_original, v_body);
  end if;
end;
$upgrade$;

alter function public.heartbeat_advice_transfer_assignment(text,text) set lock_timeout = '250ms';

do $upgrade$
declare
  v_oid oid := 'public.save_advice_transfer_stage(text,text,text,jsonb)'::regprocedure;
  v_body text;
  v_original text;
  v_definition text;
begin
  select prosrc, pg_get_functiondef(oid) into v_original, v_definition
    from pg_proc where oid = v_oid;
  v_body := v_original;
  if md5(v_original) = '211507703f103f70db26a55327af13c5' then
    v_body := overlay(v_body placing $patch$    'postTaskMeasure', v_assignment.post_task_measure,
$patch$ from 10703 for 0);
    v_body := overlay(v_body placing $patch$      if p_payload ? 'postTaskMeasure'
         and p_payload ->> 'postTaskMeasure'
$patch$ from 7787 for 61);
    v_body := overlay(v_body placing $patch$  perform pg_advisory_xact_lock_shared(hashtext('advice_transfer_admission_v3'));
$patch$ from 1415 for 75);
  elsif md5(v_original) = '8e8d0fcf2eb715efd0fd30813a6f0174' then
    v_body := overlay(v_body placing $patch$        'responsePostId', case
          when v_assignment.design_variant = 'same_post'
            then v_stimulus.exposure_post_id
          else v_stimulus.target_post_id
        end,
        'responsePostSha256', case
          when v_assignment.design_variant = 'same_post'
            then v_stimulus.exposure_post_body_sha256
          else v_stimulus.target_post_body_sha256
        end,
$patch$ from 8524 for 0);
    v_body := overlay(v_body placing $patch$        'designVariant', v_assignment.design_variant,
$patch$ from 8465 for 0);
    v_body := overlay(v_body placing $patch$      v_confidence := public.advice_transfer_required_integer(p_payload -> 'confidence', 'confidence', 1, 7);
$patch$ from 7987 for 126);
    v_body := overlay(v_body placing $patch$          raise exception 'Opinion difficulty is not collected for this assignment';
$patch$ from 7845 for 82);
    v_body := overlay(v_body placing $patch$          raise exception 'Effort is not collected for this assignment';
$patch$ from 7448 for 91);
    v_body := overlay(v_body placing $patch$         and p_payload ->> 'postTaskMeasure'
           is distinct from v_assignment.post_task_measure then
$patch$ from 6940 for 98);
    v_body := overlay(v_body placing $patch$        'designVariant', v_assignment.design_variant,
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
$patch$ from 5935 for 0);
    v_body := overlay(v_body placing $patch$      if jsonb_typeof(p_payload -> 'commentJudgments') is distinct from 'array' then
        raise exception 'Exactly five comment classifications are required';
      end if;
      if jsonb_array_length(p_payload -> 'commentJudgments') <> 5 then
$patch$ from 2886 for 154);
    v_body := overlay(v_body placing $patch$  end if;

  select * into v_stimulus
    from public.advice_transfer_stimuli
   where stimulus_id = v_assignment.stimulus_id;
  if v_stimulus.stimulus_id is null then
    raise exception 'Assigned Study 2 stimulus was not found';
$patch$ from 1835 for 0);
    v_body := overlay(v_body placing $patch$  perform pg_advisory_xact_lock_shared(hashtext('advice_transfer_admission_v3'));
$patch$ from 1362 for 75);
    v_body := overlay(v_body placing $patch$  v_stimulus public.advice_transfer_stimuli%rowtype;
$patch$ from 69 for 0);
  elsif md5(v_original) <> '5c1b330b3680b59fe9c66df30dc677bd' then
    raise exception 'Unexpected installed definition: save_advice_transfer_stage(text,text,text,jsonb); inspect before upgrading';
  end if;
  if md5(v_body) <> '5c1b330b3680b59fe9c66df30dc677bd' then
    raise exception 'Concurrency patch verification failed: save_advice_transfer_stage(text,text,text,jsonb)';
  end if;
  if v_body is distinct from v_original then
    execute replace(v_definition, v_original, v_body);
  end if;
end;
$upgrade$;

alter function public.save_advice_transfer_stage(text,text,text,jsonb) set lock_timeout = '250ms';

alter function public.save_advice_transfer_draft(text,text,jsonb) set lock_timeout = '250ms';

alter function public.withdraw_advice_transfer_assignment(text,text,text) set lock_timeout = '250ms';

do $upgrade$
declare
  v_oid oid := 'public.mark_advice_transfer_departure(text,text,jsonb)'::regprocedure;
  v_body text;
  v_original text;
  v_definition text;
begin
  select prosrc, pg_get_functiondef(oid) into v_original, v_definition
    from pg_proc where oid = v_oid;
  v_body := v_original;
  if md5(v_original) = 'f28e6ab049eaff11a88f861f6f9df6ad' then
    v_body := overlay(v_body placing $patch$  -- Shared gate before the participant row, matching heartbeat/stage saves.
  -- Departure only shortens the lease of this participant's existing token.
  perform pg_advisory_xact_lock_shared(hashtext('advice_transfer_admission_v3'));
$patch$ from 656 for 215);
  elsif md5(v_original) <> '2be75880210735df3af92808c644fb5f' then
    raise exception 'Unexpected installed definition: mark_advice_transfer_departure(text,text,jsonb); inspect before upgrading';
  end if;
  if md5(v_body) <> '2be75880210735df3af92808c644fb5f' then
    raise exception 'Concurrency patch verification failed: mark_advice_transfer_departure(text,text,jsonb)';
  end if;
  if v_body is distinct from v_original then
    execute replace(v_definition, v_original, v_body);
  end if;
end;
$upgrade$;

alter function public.mark_advice_transfer_departure(text,text,jsonb) set lock_timeout = '250ms';

alter function public.mark_advice_transfer_departure(text,text) set lock_timeout = '250ms';

do $upgrade$
declare
  v_oid oid := 'public.record_advice_transfer_comprehension_failure(text,text,jsonb)'::regprocedure;
  v_body text;
  v_original text;
  v_definition text;
begin
  select prosrc, pg_get_functiondef(oid) into v_original, v_definition
    from pg_proc where oid = v_oid;
  v_body := v_original;
  if md5(v_original) = '41bd5fc26467d39f150db8851391d22e' then
    v_body := overlay(v_body placing $patch$  -- Retrying a recorded answer after acknowledgement loss is one attempt.
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

$patch$ from 783 for 0);
    v_body := overlay(v_body placing $patch$  v_event_id text := nullif(p_payload ->> 'clientEventId', '');
$patch$ from 69 for 0);
  elsif md5(v_original) <> '1189c3f570c58c7fd5c20358181017fe' then
    raise exception 'Unexpected installed definition: record_advice_transfer_comprehension_failure(text,text,jsonb); inspect before upgrading';
  end if;
  if md5(v_body) <> '1189c3f570c58c7fd5c20358181017fe' then
    raise exception 'Concurrency patch verification failed: record_advice_transfer_comprehension_failure(text,text,jsonb)';
  end if;
  if v_body is distinct from v_original then
    execute replace(v_definition, v_original, v_body);
  end if;
end;
$upgrade$;

alter function public.record_advice_transfer_comprehension_failure(text,text,jsonb) set lock_timeout = '250ms';

do $upgrade$
declare
  v_oid oid := 'public.submit_advice_transfer_payload(text,jsonb)'::regprocedure;
  v_body text;
  v_original text;
  v_definition text;
begin
  select prosrc, pg_get_functiondef(oid) into v_original, v_definition
    from pg_proc where oid = v_oid;
  v_body := v_original;
  if md5(v_original) = '26275f313b61791417a43edca693fc61' then
    v_body := overlay(v_body placing $patch$           is distinct from 'opinion_difficulty' then
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
$patch$ from 6723 for 420);
  elsif md5(v_original) = '3cae33cebfe10e12c7c0a8fe1b3982f7' then
    v_body := overlay(v_body placing $patch$      -- A late browser must never steal a token that has already been given
      -- to its replacement. The response is retained as paid standby data.
$patch$ from 13296 for 0);
    v_body := overlay(v_body placing $patch$        'responsePostId', case when v_assignment.design_variant = 'same_post'
          then v_stimulus.exposure_post_id else v_stimulus.target_post_id end,
        'responsePostSha256', case when v_assignment.design_variant = 'same_post'
          then v_stimulus.exposure_post_body_sha256 else v_stimulus.target_post_body_sha256 end,
$patch$ from 12828 for 0);
    v_body := overlay(v_body placing $patch$        'designVariant', v_assignment.design_variant,
$patch$ from 12415 for 0);
    v_body := overlay(v_body placing $patch$$patch$ from 12038 for 57);
    v_body := overlay(v_body placing $patch$$patch$ from 11942 for 36);
    v_body := overlay(v_body placing $patch$    case when v_assignment.design_variant = 'same_post'
      then v_stimulus.exposure_post_id else v_stimulus.target_post_id end,
    case when v_assignment.design_variant = 'same_post'
      then v_stimulus.exposure_post_body_sha256 else v_stimulus.target_post_body_sha256 end,
$patch$ from 11385 for 0);
    v_body := overlay(v_body placing $patch$    v_assignment.design_variant,
    v_assignment.post_task_measure,
$patch$ from 11138 for 0);
    v_body := overlay(v_body placing $patch$$patch$ from 10811 for 23);
    v_body := overlay(v_body placing $patch$    response_post_id,
    response_post_body_sha256,
$patch$ from 10247 for 0);
    v_body := overlay(v_body placing $patch$    design_variant,
    post_task_measure,
$patch$ from 10093 for 0);
    v_body := overlay(v_body placing $patch$$patch$ from 8198 for 148);
    v_body := overlay(v_body placing $patch$  if (
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
$patch$ from 7452 for 667);
    v_body := overlay(v_body placing $patch$  if v_assignment.protocol_version = 'advice-transfer-v4-gist' then
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
$patch$ from 6380 for 193);
    v_body := overlay(v_body placing $patch$    -- Never trust final/draft copies of locked data. This also makes a final
    -- retry safe after an earlier stage response was lost in transit.
$patch$ from 4541 for 0);
  elsif md5(v_original) <> '846827529f657973dda522743948c9fb' then
    raise exception 'Unexpected installed definition: submit_advice_transfer_payload(text,jsonb); inspect before upgrading';
  end if;
  if md5(v_body) <> '846827529f657973dda522743948c9fb' then
    raise exception 'Concurrency patch verification failed: submit_advice_transfer_payload(text,jsonb)';
  end if;
  if v_body is distinct from v_original then
    execute replace(v_definition, v_original, v_body);
  end if;
end;
$upgrade$;

alter function public.submit_advice_transfer_payload(text,jsonb) set lock_timeout = '250ms';

alter function public.review_advice_transfer_assignment(text,text,text) set lock_timeout = '250ms';

commit;
