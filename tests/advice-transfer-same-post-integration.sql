-- Run after, in order:
--   supabase_advice_transfer_same_post_migration.sql
--   supabase_advice_transfer_opinion_difficulty_migration.sql
-- Every write is rolled back.
begin;

create or replace function pg_temp.expect_advice_transfer_stage_error(
  p_assignment_id text,
  p_prolific_pid text,
  p_stage text,
  p_payload jsonb,
  p_message_pattern text
)
returns void
language plpgsql
as $$
declare
  v_raised boolean := false;
  v_message text;
begin
  begin
    perform public.save_advice_transfer_stage(
      p_assignment_id, p_prolific_pid, p_stage, p_payload
    );
  exception when others then
    v_raised := true;
    v_message := sqlerrm;
  end;
  if not v_raised then
    raise exception 'Expected stage save to fail with pattern %', p_message_pattern;
  end if;
  if v_message !~* p_message_pattern then
    raise exception 'Unexpected stage-save error: % (wanted pattern %)',
      v_message, p_message_pattern;
  end if;
end;
$$;

do $test$
declare
  v_suffix text := replace(gen_random_uuid()::text, '-', '');
  v_new_pid text := 'qa-same-post-' || v_suffix;
  v_old_pid text := 'qa-a-to-b-' || v_suffix;
  v_new jsonb;
  v_old_initial jsonb;
  v_old_again jsonb;
  v_new_assignment public.advice_transfer_assignments%rowtype;
  v_old_assignment public.advice_transfer_assignments%rowtype;
  v_stimulus public.advice_transfer_stimuli%rowtype;
  v_new_submission public.advice_transfer_submissions%rowtype;
  v_old_submission public.advice_transfer_submissions%rowtype;
  v_new_judgments jsonb;
  v_old_judgments jsonb;
  v_new_phase1 jsonb;
  v_old_phase1 jsonb;
  v_new_phase2 jsonb;
  v_old_phase2 jsonb;
  v_final jsonb;
  v_result jsonb;
  v_advice text := btrim(repeat('word ', 77));
  v_gist text := btrim(repeat('gist ', 25));
  v_demographics jsonb := jsonb_build_object(
    'genderIdentity', 'prefer-not-to-say',
    'ageYears', 30,
    'englishProficiency', 'yes',
    'educationLevel', 'graduate-or-professional-training',
    'employmentStatus', 'employed'
  );
begin
  -- A new wrapper claim is same-post and receives opinion difficulty.
  v_new := public.claim_advice_transfer_assignment_same_post(
    v_new_pid, 'same-post-integration', 'new-session', true, 1, 'human'
  );
  if v_new ->> 'admissionStatus' is distinct from 'assigned'
     or v_new ->> 'designVariant' is distinct from 'same_post'
     or v_new ->> 'postTaskMeasure' is distinct from 'opinion_difficulty'
     or v_new #>> '{responsePost,postId}' is distinct from
          v_new #>> '{exposurePost,postId}'
     or v_new #>> '{responsePost,sha256}' is distinct from
          v_new #>> '{exposurePost,sha256}'
     or v_new #>> '{targetPost,postId}' is not distinct from
          v_new #>> '{exposurePost,postId}' then
    raise exception 'A new same-post claim returned the wrong design or measure';
  end if;

  select * into v_new_assignment
    from public.advice_transfer_assignments
   where assignment_id = v_new ->> 'assignmentId';
  if v_new_assignment.design_variant is distinct from 'same_post'
     or v_new_assignment.post_task_measure is distinct from 'opinion_difficulty' then
    raise exception 'The new assignment did not retain its design and measure stamps';
  end if;

  select jsonb_agg(jsonb_build_object(
    'displayPosition', i + 1,
    'commentIndex', (v_new -> 'commentOrder' ->> i)::integer,
    'commentSha256', v_new -> 'commentHashes' ->> i,
    'label', (array['YTA', 'NTA', 'ESH', 'NAH', 'INFO'])[i + 1]
  ) order by i)
    into v_new_judgments
    from generate_series(0, 4) as g(i);

  v_new_phase1 := jsonb_build_object(
    'schemaVersion', 'advice-transfer-v4-gist',
    'commentJudgments', v_new_judgments,
    'gistText', v_gist,
    'gistDifficulty', 4,
    'timings', jsonb_build_object(
      'phase1ActiveTimeMs', 3000, 'gistActiveTimeMs', 1000
    )
  );
  perform public.save_advice_transfer_stage(
    v_new ->> 'assignmentId', v_new_pid, 'phase1', v_new_phase1
  );

  v_new_phase2 := jsonb_build_object(
    'schemaVersion', 'advice-transfer-v4-gist',
    'postTaskMeasure', 'opinion_difficulty',
    'adviceText', v_advice,
    'difficulty', 4,
    'confidence', 5,
    'timings', jsonb_build_object('adviceResponseTimeMs', 2000)
  );
  perform pg_temp.expect_advice_transfer_stage_error(
    v_new ->> 'assignmentId', v_new_pid, 'phase2',
    v_new_phase2 - 'difficulty', 'difficulty'
  );
  perform pg_temp.expect_advice_transfer_stage_error(
    v_new ->> 'assignmentId', v_new_pid, 'phase2',
    jsonb_set(v_new_phase2, '{difficulty}', 'null'::jsonb), 'difficulty'
  );
  perform pg_temp.expect_advice_transfer_stage_error(
    v_new ->> 'assignmentId', v_new_pid, 'phase2',
    jsonb_set(v_new_phase2, '{difficulty}', '0'::jsonb), 'difficulty'
  );
  perform pg_temp.expect_advice_transfer_stage_error(
    v_new ->> 'assignmentId', v_new_pid, 'phase2',
    jsonb_set(v_new_phase2, '{difficulty}', '8'::jsonb), 'difficulty'
  );
  perform pg_temp.expect_advice_transfer_stage_error(
    v_new ->> 'assignmentId', v_new_pid, 'phase2',
    jsonb_set(v_new_phase2, '{difficulty}', '"4"'::jsonb), 'difficulty'
  );
  perform pg_temp.expect_advice_transfer_stage_error(
    v_new ->> 'assignmentId', v_new_pid, 'phase2',
    v_new_phase2 || jsonb_build_object('effort', 3), 'Effort is not collected for this assignment'
  );
  perform pg_temp.expect_advice_transfer_stage_error(
    v_new ->> 'assignmentId', v_new_pid, 'phase2',
    jsonb_set(v_new_phase2, '{postTaskMeasure}', '"effort"'::jsonb),
    'does not match assignment'
  );

  v_result := public.save_advice_transfer_stage(
    v_new ->> 'assignmentId', v_new_pid, 'phase2', v_new_phase2
  );
  if v_result #>> '{snapshot,postTaskMeasure}' is distinct from 'opinion_difficulty'
     or v_result #>> '{snapshot,difficulty}' is distinct from '4'
     or v_result #> '{snapshot,effort}' is distinct from 'null'::jsonb then
    raise exception 'The new phase-2 snapshot did not isolate opinion difficulty';
  end if;

  v_final := jsonb_build_object(
    'schemaVersion', 'advice-transfer-v4-gist',
    'participant', jsonb_build_object(
      'prolificPid', v_new_pid,
      'studyId', 'same-post-integration',
      'sessionId', 'new-session'
    ),
    'purposeGuess', 'Integration test purpose',
    'commentsStoodOut', 'no',
    'commentsStoodOutDetails', '',
    'aiGeneratedBelief', 'unsure',
    'aiLikelihood', 4,
    'demographics', v_demographics
  );
  perform public.submit_advice_transfer_payload(
    v_new ->> 'assignmentId', v_final
  );

  select * into v_new_submission
    from public.advice_transfer_submissions
   where assignment_id = v_new ->> 'assignmentId';
  select * into v_stimulus
    from public.advice_transfer_stimuli
   where stimulus_id = v_new_submission.stimulus_id;
  if v_new_submission.design_variant is distinct from 'same_post'
     or v_new_submission.response_post_id is distinct from v_stimulus.exposure_post_id
     or v_new_submission.response_post_id is distinct from
          v_new_submission.exposure_post_id
     or v_new_submission.post_task_measure is distinct from 'opinion_difficulty'
     or v_new_submission.difficulty is distinct from 4
     or v_new_submission.effort is not null
     or v_new_submission.confidence is distinct from 5
     or v_new_submission.full_payload ? 'opinionDifficulty'
     or v_new_submission.full_payload ->> 'postTaskMeasure' is distinct from
          'opinion_difficulty'
     or v_new_submission.full_payload #>> '{serverAudit,postTaskMeasure}' is distinct from
          'opinion_difficulty'
     or v_new_submission.full_payload #>> '{serverAudit,responsePostId}' is distinct from
          v_new_submission.exposure_post_id then
    raise exception 'The new submission did not preserve same-post difficulty semantics';
  end if;

  -- A claim created by the historical v4 endpoint stays A-to-B and effort.
  v_old_initial := public.claim_advice_transfer_assignment_v4(
    v_old_pid, 'same-post-integration', 'old-session', true, 1, 'ai'
  );
  v_old_again := public.claim_advice_transfer_assignment_same_post(
    v_old_pid, 'same-post-integration', 'old-session', true, 1, 'ai'
  );
  if v_old_initial ->> 'admissionStatus' is distinct from 'assigned'
     or v_old_again ->> 'designVariant' is distinct from 'a_to_b'
     or v_old_again ->> 'postTaskMeasure' is distinct from 'effort'
     or v_old_again #>> '{responsePost,postId}' is distinct from
          v_old_again #>> '{targetPost,postId}' then
    raise exception 'An existing v4 assignment was incorrectly converted';
  end if;

  select * into v_old_assignment
    from public.advice_transfer_assignments
   where assignment_id = v_old_again ->> 'assignmentId';
  if v_old_assignment.design_variant is distinct from 'a_to_b'
     or v_old_assignment.post_task_measure is distinct from 'effort' then
    raise exception 'The old assignment did not retain its legacy stamps';
  end if;

  select jsonb_agg(jsonb_build_object(
    'displayPosition', i + 1,
    'commentIndex', (v_old_again -> 'commentOrder' ->> i)::integer,
    'commentSha256', v_old_again -> 'commentHashes' ->> i,
    'label', (array['YTA', 'NTA', 'ESH', 'NAH', 'INFO'])[i + 1]
  ) order by i)
    into v_old_judgments
    from generate_series(0, 4) as g(i);

  v_old_phase1 := jsonb_build_object(
    'schemaVersion', 'advice-transfer-v4-gist',
    'commentJudgments', v_old_judgments,
    'gistText', v_gist,
    'gistDifficulty', 3,
    'timings', jsonb_build_object(
      'phase1ActiveTimeMs', 3000, 'gistActiveTimeMs', 1000
    )
  );
  perform public.save_advice_transfer_stage(
    v_old_again ->> 'assignmentId', v_old_pid, 'phase1', v_old_phase1
  );

  -- Omit postTaskMeasure to emulate an already-open historical client.
  v_old_phase2 := jsonb_build_object(
    'schemaVersion', 'advice-transfer-v4-gist',
    'adviceText', v_advice,
    'effort', 3,
    'confidence', 6,
    'timings', jsonb_build_object('adviceResponseTimeMs', 2000)
  );
  perform pg_temp.expect_advice_transfer_stage_error(
    v_old_again ->> 'assignmentId', v_old_pid, 'phase2',
    v_old_phase2 || jsonb_build_object('difficulty', 4),
    'Opinion difficulty is not collected for this assignment'
  );

  v_result := public.save_advice_transfer_stage(
    v_old_again ->> 'assignmentId', v_old_pid, 'phase2', v_old_phase2
  );
  if v_result #>> '{snapshot,postTaskMeasure}' is distinct from 'effort'
     or v_result #>> '{snapshot,effort}' is distinct from '3'
     or v_result #> '{snapshot,difficulty}' is distinct from 'null'::jsonb then
    raise exception 'The historical phase-2 snapshot did not retain effort';
  end if;

  v_final := jsonb_build_object(
    'schemaVersion', 'advice-transfer-v4-gist',
    'participant', jsonb_build_object(
      'prolificPid', v_old_pid,
      'studyId', 'same-post-integration',
      'sessionId', 'old-session'
    ),
    'purposeGuess', 'Integration test purpose',
    'commentsStoodOut', 'no',
    'commentsStoodOutDetails', '',
    'aiGeneratedBelief', 'unsure',
    'aiLikelihood', 4,
    'demographics', v_demographics
  );
  perform public.submit_advice_transfer_payload(
    v_old_again ->> 'assignmentId', v_final
  );

  select * into v_old_submission
    from public.advice_transfer_submissions
   where assignment_id = v_old_again ->> 'assignmentId';
  if v_old_submission.design_variant is distinct from 'a_to_b'
     or v_old_submission.response_post_id is distinct from
          v_old_submission.target_post_id
     or v_old_submission.post_task_measure is distinct from 'effort'
     or v_old_submission.difficulty is not null
     or v_old_submission.effort is distinct from 3
     or v_old_submission.confidence is distinct from 6
     or v_old_submission.full_payload #>> '{serverAudit,postTaskMeasure}' is distinct from
          'effort'
     or v_old_submission.full_payload #>> '{serverAudit,responsePostId}' is distinct from
          v_old_submission.target_post_id then
    raise exception 'The historical submission lost its A-to-B effort semantics';
  end if;
end;
$test$;

rollback;
