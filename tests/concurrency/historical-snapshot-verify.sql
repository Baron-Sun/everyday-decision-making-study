-- Runs in the same session after applying the concurrency upgrade.
begin;
do $test$
declare
  v_old record;
  v_final jsonb;
  v_result jsonb;
  v_again jsonb;
  v_current public.advice_transfer_assignments%rowtype;
  v_submission public.advice_transfer_submissions%rowtype;
  v_claim jsonb;
  v_case jsonb;
  v_error text;
  v_case_number integer := 0;
begin
  select * into strict v_old from historical_snapshot_fixture;
  v_result := public.save_advice_transfer_stage(v_old.assignment_id,v_old.pid,'phase2',jsonb_build_object(
    'schemaVersion','advice-transfer-v4-gist','adviceText','stale retry'));
  if not (v_result->>'alreadySaved')::boolean or v_result->'snapshot' is distinct from v_old.phase2 then
    raise exception 'Historical stage retry must preserve its locked snapshot';
  end if;
  v_final:=jsonb_build_object('schemaVersion','advice-transfer-v4-gist','participant',jsonb_build_object(
    'prolificPid',v_old.pid,'studyId','local-historical-study','sessionId','historical-session'),
    'purposeGuess','Understanding responses to online opinions.','commentsStoodOut','no','aiGeneratedBelief','unsure','aiLikelihood',4,
    'demographics',jsonb_build_object('genderIdentity','prefer-not-to-say','ageYears',30,'englishProficiency','yes',
      'educationLevel','graduate-or-professional-training','employmentStatus','employed'));
  v_result:=public.submit_advice_transfer_payload(v_old.assignment_id,v_final);
  v_again:=public.submit_advice_transfer_payload(v_old.assignment_id,v_final);
  if not (v_result->>'ok')::boolean or (v_result->>'alreadySubmitted')::boolean
     or not (v_again->>'alreadySubmitted')::boolean or v_again->>'submittedAt' is distinct from v_result->>'submittedAt' then
    raise exception 'Historical snapshot final submission and retry are not idempotent';
  end if;
  select * into v_current from advice_transfer_assignments where assignment_id=v_old.assignment_id;
  if (v_current.phase1_snapshot,v_current.phase2_snapshot,v_current.phase1_locked_at,v_current.phase2_locked_at)
     is distinct from (v_old.phase1,v_old.phase2,v_old.phase1_locked_at,v_old.phase2_locked_at) then
    raise exception 'Upgrade or final submission changed immutable historical answers';
  end if;
  select * into v_submission from advice_transfer_submissions where assignment_id=v_old.assignment_id;
  if v_submission.difficulty is distinct from 4 or v_submission.effort is not null or v_submission.confidence is distinct from 5
    or v_submission.response_post_id is distinct from v_submission.exposure_post_id
    or v_submission.full_payload #>> '{serverAudit,responsePostId}' is distinct from v_submission.exposure_post_id then
    raise exception 'Historical completion did not derive its audit from the assigned stimulus';
  end if;
  -- First privileged fixture writes are allowed by the unchanged immutability
  -- trigger. These are deliberately malformed server-side snapshots, never
  -- edits to existing locked answers; final submission must reject them.
  for v_case in select * from (values
    (jsonb_build_object('designVariant','same_post')),
    (jsonb_build_object('designVariant','same_post','responsePostId','incorrect','responsePostSha256',repeat('f',64))),
    (jsonb_build_object('designVariant',null,'responsePostId',null,'responsePostSha256',null))
  ) cases(payload) loop
    v_case_number:=v_case_number+1;
    v_claim:=public.claim_advice_transfer_assignment_same_post('qa-invalid-audit-'||v_case_number,'local-historical-study','invalid-session',true,1,'human');
    update advice_transfer_assignments set phase1_snapshot=v_old.phase1,phase1_locked_at=v_old.phase1_locked_at,
      phase2_snapshot=v_old.phase2||v_case,phase2_locked_at=v_old.phase2_locked_at
      where assignment_id=v_claim->>'assignmentId';
    v_error:=null;
    begin
      perform public.submit_advice_transfer_payload(v_claim->>'assignmentId',jsonb_set(v_final,'{participant,prolificPid}',to_jsonb('qa-invalid-audit-'||v_case_number)));
    exception when others then get stacked diagnostics v_error=message_text;
    end;
    if v_error is null or v_error not ilike '%design audit%' then
      raise exception 'Partial or wrong present audit keys were not rejected: %',v_error;
    end if;
  end loop;
end
$test$;
rollback;
