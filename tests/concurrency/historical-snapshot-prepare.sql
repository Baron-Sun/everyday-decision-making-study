-- Local integration fixture. Run AFTER the real historical opinion-difficulty
-- migration and BEFORE the concurrency migration. No trigger is disabled.
begin;
do $$ begin
  if current_database() not like 'aita_load_%' then
    raise exception 'This fixture is restricted to local aita_load_ databases';
  end if;
end $$;
create temporary table historical_snapshot_fixture (
  assignment_id text, pid text, phase1 jsonb, phase2 jsonb, phase1_locked_at timestamptz, phase2_locked_at timestamptz
) on commit preserve rows;
do $fixture$
declare
  v_pid text := 'qa-historical-locked-snapshot';
  v_claim jsonb;
  v_judgments jsonb;
begin
  v_claim := public.claim_advice_transfer_assignment_same_post(v_pid,'local-historical-study','historical-session',true,1,'human');
  select jsonb_agg(jsonb_build_object('displayPosition',i+1,'commentIndex',(v_claim->'commentOrder'->>i)::integer,'commentSha256',v_claim->'commentHashes'->>i,'label','NTA') order by i)
    into v_judgments from generate_series(0,4) i;
  perform public.save_advice_transfer_stage(v_claim->>'assignmentId',v_pid,'phase1',jsonb_build_object(
    'schemaVersion','advice-transfer-v4-gist','commentJudgments',v_judgments,'gistText',btrim(repeat('gist ',25)),
    'gistDifficulty',4,'timings',jsonb_build_object('phase1ActiveTimeMs',3000,'gistActiveTimeMs',1000)));
  -- The actually deployed historical server accepts this omitted marker.
  perform public.save_advice_transfer_stage(v_claim->>'assignmentId',v_pid,'phase2',jsonb_build_object(
    'schemaVersion','advice-transfer-v4-gist','adviceText',btrim(repeat('opinion ',77)),'difficulty',4,'confidence',5,
    'timings',jsonb_build_object('adviceResponseTimeMs',2000)));
  insert into historical_snapshot_fixture
    select assignment_id,prolific_pid,phase1_snapshot,phase2_snapshot,phase1_locked_at,phase2_locked_at
      from public.advice_transfer_assignments where assignment_id=v_claim->>'assignmentId';
  if exists(select 1 from historical_snapshot_fixture where phase2 ?| array['designVariant','responsePostId','responsePostSha256']) then
    raise exception 'The fixture was not created by the actual historical stage-save function';
  end if;
end
$fixture$;
commit;
