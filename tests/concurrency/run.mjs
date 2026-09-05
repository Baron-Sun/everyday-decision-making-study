/** Real PostgreSQL, independent TCP sessions. Never accepts a remote database. */
import fs from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
const options = Object.fromEntries(process.argv.slice(2).map(a => a.replace(/^--/, '').split(/=(.*)/s).slice(0, 2)));
const driver = process.env.PG_DRIVER_PATH || 'pg';
const { default: pg } = await import(driver.startsWith('/') ? pathToFileURL(driver).href : driver);
const { Client } = pg;
const baseUrl = new URL(process.env.LOCAL_PG_URL || 'postgresql://postgres:local-benchmark-only@127.0.0.1:55439/postgres');
assert(['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname), 'This destructive fixture harness ONLY accepts localhost.');
const label = options.label || 'current';
assert(/^[a-z0-9_]+$/.test(label), 'Use a simple label.');
const wrapper=options.wrapper||'same_post';
assert(['same_post','v4'].includes(wrapper),'Known claim wrapper only');
const setup = options.setup || 'supabase_advice_transfer_setup.sql';
const migrations = (options.migrations || '').split(',').filter(Boolean);
const setupSql=await fs.readFile(setup,'utf8');
const seedSql=await fs.readFile('supabase_advice_transfer_seed.sql','utf8');
const migrationSql=await Promise.all(migrations.map(file=>fs.readFile(file,'utf8')));
const report = { label, wrapper, startedAt: new Date().toISOString(), setup, migrations, transport: 'native PostgreSQL TCP; one independently connected anon backend per concurrent operation; all connected before burst', statementTimeoutMs: 3000, sourceSha256:{setup:createHash('sha256').update(setupSql).digest('hex'),migrations:migrationSql.map(s=>createHash('sha256').update(s).digest('hex'))}, tests: [] };
const admin = new Client({ connectionString: baseUrl.href });
await admin.connect();
report.server = (await admin.query("select version(), current_setting('max_connections') as max_connections")).rows[0];
let currentDb;
let fixture;
let failures = 0;
const openClients = new Set();
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
async function connect(user = 'anon') {
  const url = new URL(baseUrl); url.pathname = `/${currentDb}`; url.username = user;
  const client = new Client({ connectionString: url.href, application_name: `aita_local_${label}` });
  client.on('error', () => {});
  await client.connect(); openClients.add(client); return client;
}
async function close(client) { openClients.delete(client); await client.end(); }
async function fixtureDb(name) {
  if (fixture) await close(fixture);
  currentDb = `aita_load_${label}_${name}`;
  assert(/^aita_load_[a-z0-9_]+$/.test(currentDb));
  await admin.query(`drop database if exists "${currentDb}" with (force)`);
  await admin.query(`create database "${currentDb}"`);
  fixture = await connect('postgres');
  fixture.on('notice', () => {});
  await fixture.query('create schema extensions; create extension pgcrypto with schema extensions; set search_path=public,extensions');
  await fixture.query(setupSql);
  await fixture.query(seedSql);
  for (const sql of migrationSql) await fixture.query(sql);
  await fixture.query("update public.advice_transfer_settings set setting_value='5'::jsonb where setting_key='formal_target_per_cell'; update public.advice_transfer_settings set setting_value='true'::jsonb where setting_key='formal_recruitment_open'; select public.ensure_advice_transfer_quota_tokens();");
}
function claim(pid, session = 'session') {
  return { kind: 'claim', pid, sql: `select public.claim_advice_transfer_assignment_${wrapper}($1,$2,$3,false,null,null) as result`, params: [pid, 'local-load-study', session] };
}
function heartbeat(a) { return { kind: 'heartbeat', sql: 'select public.heartbeat_advice_transfer_assignment($1,$2) as result', params: [a.assignmentId, a.pid] }; }
function draft(a) { return { kind: 'draft', sql: 'select public.save_advice_transfer_draft($1,$2,$3::jsonb) as result', params: [a.assignmentId, a.pid, JSON.stringify({schemaVersion:'advice-transfer-v4-gist',assignmentId:a.assignmentId,screen:'exposure',gistText:'draft '.repeat(35),savedAt:new Date().toISOString()})] }; }
function stages(a) {
  const phase1={schemaVersion:'advice-transfer-v4-gist',commentJudgments:a.commentOrder.map((commentIndex,i)=>({displayPosition:i+1,commentIndex,commentSha256:a.commentHashes[i],label:['YTA','NTA','ESH','NAH','INFO'][i]})),gistText:'summary '.repeat(25).trim(),gistDifficulty:4,timings:{phase1ActiveTimeMs:12000,gistActiveTimeMs:4000}};
  const phase2={schemaVersion:'advice-transfer-v4-gist',adviceText:'NTA '+ 'advice '.repeat(76).trim(),...(wrapper==='same_post'?{postTaskMeasure:'opinion_difficulty',difficulty:3}:{effort:3}),confidence:6,timings:{adviceResponseTimeMs:16000}};
  return [phase1,phase2].map((p,i)=>({kind:`phase${i+1}`,sql:'select public.save_advice_transfer_stage($1,$2,$3,$4::jsonb) as result',params:[a.assignmentId,a.pid,`phase${i+1}`,JSON.stringify(p)]}));
}
function final(a) { return {kind:'final',sql:'select public.submit_advice_transfer_payload($1,$2::jsonb) as result',params:[a.assignmentId,JSON.stringify({schemaVersion:'advice-transfer-v4-gist',assignmentId:a.assignmentId,participant:{prolificPid:a.pid,studyId:'local-load-study',sessionId:'session'},purposeGuess:'Understanding how people respond to online opinions.',commentsStoodOut:'no',commentsStoodOutDetails:'',aiGeneratedBelief:'unsure',aiLikelihood:4,demographics:{genderIdentity:'prefer-not-to-say',ageYears:35,englishProficiency:'no-fluent',educationLevel:'graduate-or-professional-training',employmentStatus:'self-employed'}})]}; }
function summarize(rows) {
  const sorted=rows.map(r=>r.ms).sort((a,b)=>a-b), q=p=>Math.round(sorted[Math.min(sorted.length-1,Math.floor(sorted.length*p))]*10)/10;
  return {count:rows.length,success:rows.filter(r=>!r.error).length,errors:rows.filter(r=>r.error).length,p50Ms:q(.5),p95Ms:q(.95),p99Ms:q(.99),maxMs:q(1),errorCodes:rows.reduce((o,r)=>{if(r.error)o[r.error.code]=(o[r.error.code]||0)+1;return o},{}),statuses:rows.reduce((o,r)=>{const s=r.result?.admissionStatus||r.result?.status||String(r.result?.ok);if(!r.error)o[s]=(o[s]||0)+1;return o},{})};
}
async function burst(name, operations, { expectNoErrors = true } = {}) {
  const clients=[];
  // Connect in chunks to avoid TCP accept-queue pressure being confused with SQL contention.
  for(let i=0;i<operations.length;i+=25) clients.push(...await Promise.all(operations.slice(i,i+25).map(()=>connect())));
  const backendIds=await Promise.all(clients.map(c=>c.query("select pg_backend_pid() as pid,current_setting('statement_timeout') as timeout")));
  assert.equal(new Set(backendIds.map(r=>r.rows[0].pid)).size,operations.length);
  assert(backendIds.every(r=>r.rows[0].timeout==='3s'));
  const start=performance.now();
  const rows=await Promise.all(operations.map(async(op,i)=>{
    const t=performance.now(); let attempts=0,busyResponses=0,lockRetries=0,firstAttemptMs;
    while(true) {
      attempts++;
      try {
        const result=(await clients[i].query(op.sql,op.params)).rows[0].result;
        firstAttemptMs ??= performance.now()-t;
        if(result?.reason==='server_busy') {
          busyResponses++;
          if(performance.now()-t>=30000) return {kind:op.kind,pid:op.pid,error:{code:'CLIENT_RETRY_BUDGET',message:'Server remained busy after the 30-second test budget'},attempts,busyResponses,lockRetries,firstAttemptMs,ms:performance.now()-t};
          await sleep(Number(result.retryAfterMs)||500+Math.random()*1500);continue;
        }
        return {kind:op.kind,pid:op.pid,result,attempts,busyResponses,lockRetries,firstAttemptMs,ms:performance.now()-t};
      } catch(e) {
        firstAttemptMs ??= performance.now()-t;
        if(e.code==='55P03' && performance.now()-t<30000) {lockRetries++;await sleep(500+Math.random()*1500);continue;}
        return {kind:op.kind,pid:op.pid,error:{code:e.code,message:e.message,where:e.where},attempts,busyResponses,lockRetries,firstAttemptMs,ms:performance.now()-t};
      }
    }
  }));
  await Promise.all(clients.map(close));
  const result={name,independentConnections:operations.length,wallMs:Math.round(performance.now()-start),...summarize(rows),byOperation:Object.fromEntries([...new Set(rows.map(r=>r.kind))].map(k=>[k,summarize(rows.filter(r=>r.kind===k))])),retrySummary:{busyResponses:rows.reduce((n,r)=>n+(r.busyResponses||0),0),lockRetries:rows.reduce((n,r)=>n+(r.lockRetries||0),0),maxAttempts:Math.max(...rows.map(r=>r.attempts||1)),firstAttemptP95Ms:summarize(rows.map(r=>({...r,ms:r.firstAttemptMs??r.ms}))).p95Ms},errorExamples:rows.filter(r=>r.error).slice(0,3).map(r=>r.error)};
  report.tests.push(result);console.log(JSON.stringify(result));
  if(expectNoErrors&&result.errors) failures++;
  return rows;
}
async function invariant(name, expected) {
  const rows=(await fixture.query('select * from public.advice_transfer_formal_cell_progress')).rows;
  const counts=(await fixture.query("select (select count(*)::int from advice_transfer_assignments where not is_test) as assignments,(select count(*)::int from advice_transfer_submissions where not is_test) as submissions,(select count(*)::int from advice_transfer_quota_tokens) as tokens,(select count(*)::int from advice_transfer_waitlist) as waiters,(select count(*)::int from (select prolific_pid,study_id from advice_transfer_assignments where not is_test group by prolific_pid,study_id having count(*)>1) x) as duplicate_participants,(select count(*)::int from advice_transfer_quota_tokens t join advice_transfer_assignments a on a.assignment_id=t.current_assignment_id where a.quota_token_id is distinct from t.id or (a.stimulus_id,a.condition) is distinct from (t.stimulus_id,t.condition)) as token_owner_mismatches")).rows[0];
  const checks={twentyCells:rows.length===20,fiveTokensPerCell:rows.every(r=>Number(r.token_total)===5),quotaInvariant:rows.every(r=>r.quota_invariant_ok),noDuplicateParticipants:counts.duplicate_participants===0,consistentTokenOwners:counts.token_owner_mismatches===0,...(expected?.assignments>=100?{fiveCommittedPerCell:rows.every(r=>Number(r.quota_committed)===5)}:{}),...(expected?.submissions===100?{fiveCompletedPerCell:rows.every(r=>Number(r.usable_completed)===5)}:{}),...Object.fromEntries(Object.entries(expected||{}).map(([key,value])=>[key,counts[key]===value]))};
  const ok=Object.values(checks).every(Boolean);if(!ok)failures++;
  const result={name,type:'invariants',ok,counts,checks,cells:rows.map(r=>({pair:r.pair_number,condition:r.condition,reserved:Number(r.reserved),pending:Number(r.pending),valid:Number(r.valid),available:Number(r.available),standby:Number(r.active_standby)}))};
  report.tests.push(result);console.log(JSON.stringify(result));return result;
}
const assigned=rows=>rows.filter(r=>r.result?.admissionStatus==='assigned').map(r=>({...r.result,pid:r.pid}));
try {
  for (const n of (options.arrivals||'100,200,500').split(',').filter(Boolean).map(Number)) {
    await fixtureDb(`arrivals${n}`);
    await burst(`simultaneous_${n}_new_arrivals`,Array.from({length:n},(_,i)=>claim(`load-arrival-${n}-${i}`)));
    await invariant(`arrivals_${n}_balance`,{assignments:100});
  }
  if(options.lifecycle!=='false') {
    await fixtureDb('mixed');
    const entrants=assigned(await burst('initial_100',Array.from({length:100},(_,i)=>claim(`load-mixed-${i}`))));
    const mix=[...entrants.map(heartbeat),...entrants.map(draft),...Array.from({length:200},(_,i)=>claim(`load-extra-${i}`))];
    await burst('100_heartbeats_100_drafts_200_new_arrivals',mix);
    await invariant('mixed_balance',{assignments:100});
    await burst('100_phase1_saves',entrants.map(a=>stages(a)[0]));
    await burst('100_phase2_saves',entrants.map(a=>stages(a)[1]));
    await burst('100_finals_with_100_duplicate_retries_and_100_heartbeats',entrants.flatMap(a=>[final(a),final(a),heartbeat(a)]));
    await invariant('completion_exact_20x5',{assignments:100,submissions:100});
    await burst('100_refreshes_changed_session',entrants.map(a=>claim(a.pid,'reopened-session')));
    await invariant('resume_deduplication',{assignments:100,submissions:100});

    await fixtureDb('samepid');
    const duplicates=await burst('50_same_pid_simultaneous_claims',Array.from({length:50},(_,i)=>claim('load-same-pid',`session-${i}`)));
    const ids=new Set(assigned(duplicates).map(a=>a.assignmentId));
    if(ids.size!==1){failures++;console.error('Same PID claims did not all resolve to exactly one assignment',ids.size)}
    await invariant('same_pid_deduplication',{assignments:1});

    await fixtureDb('replacement');
    const full=assigned(await burst('fill_100_for_replacement',Array.from({length:100},(_,i)=>claim(`load-replace-${i}`))));
    const revive=full[0];
    await fixture.query("update advice_transfer_assignments set lease_expires_at=now()-interval '1 second' where assignment_id=$1",[revive.assignmentId]);
    await fixture.query("update advice_transfer_quota_tokens set reservation_expires_at=now()-interval '1 second' where current_assignment_id=$1",[revive.assignmentId]);
    await fixture.query('select reclaim_expired_advice_transfer_assignments()');
    await burst('revive_expired_via_heartbeat',[heartbeat(revive)]);
    await burst('newcomer_after_revived_standby',[claim('load-standby-newcomer')]);
    const revived=(await fixture.query('select reservation_kind,quota_token_id from advice_transfer_assignments where assignment_id=$1',[revive.assignmentId])).rows[0];
    const priority=revived.reservation_kind==='quota'&&revived.quota_token_id!==null;
    report.tests.push({name:'revived_standby_priority',ok:priority,revived});if(!priority)failures++;
    const replacements=(await fixture.query("select distinct on (stimulus_id,condition) assignment_id from advice_transfer_assignments where reservation_kind='quota' order by stimulus_id,condition,assignment_id")).rows.map(r=>r.assignment_id);
    await fixture.query("update advice_transfer_assignments set lease_expires_at=now()-interval '1 second' where assignment_id=any($1::text[])",[replacements]);
    await fixture.query("update advice_transfer_quota_tokens set reservation_expires_at=now()-interval '1 second' where current_assignment_id=any($1::text[])",[replacements]);
    await burst('200_arrivals_replace_20_expired_slots',Array.from({length:200},(_,i)=>claim(`load-replacement-new-${i}`)));
    await invariant('replacement_exact_20x5',{assignments:120});

    if(options.events!=='false') {
      await fixtureDb('events');
      const [eventPerson]=assigned(await burst('seed_event_participant',[claim('load-event')]));
      const event={kind:'failure_event',sql:'select public.record_advice_transfer_comprehension_failure($1,$2,$3::jsonb) as result',params:[eventPerson.assignmentId,'incorrect-option',JSON.stringify({clientEventId:'same-ack-lost-event'})]};
      await burst('30_identical_comprehension_event_retries',Array.from({length:30},()=>event));
      const saved=(await fixture.query('select status,comprehension_failures,jsonb_array_length(comprehension_events) as event_count from advice_transfer_assignments where assignment_id=$1',[eventPerson.assignmentId])).rows[0];
      const once=saved.status==='claimed'&&saved.comprehension_failures===1&&saved.event_count===1;
      report.tests.push({name:'comprehension_once',ok:once,saved});if(!once)failures++;
    }

    await fixtureDb('blockedrow');
    const people=assigned(await burst('seed_two_participants',[claim('load-blocked'),claim('load-unrelated')]));
    const blocker=await connect('postgres');await blocker.query('begin');
    await blocker.query('select 1 from advice_transfer_assignments where assignment_id=$1 for update',[people[0].assignmentId]);
    const blockedClient=await connect();
    const blockedPromise=blockedClient.query(heartbeat(people[0]).sql,heartbeat(people[0]).params).then(()=>({ok:true})).catch(e=>({error:e.code,message:e.message}));
    await sleep(100);
    const lockSnapshot=(await fixture.query("select wait_event_type,wait_event,count(*)::int from pg_stat_activity where datname=current_database() and application_name=$1 group by wait_event_type,wait_event",[`aita_local_${label}`])).rows;
    console.log(JSON.stringify({name:'blocked_row_wait_snapshot',rows:lockSnapshot}));
    await burst('one_blocked_participant_20_unrelated_claims_heartbeats',[...Array.from({length:20},(_,i)=>claim(`load-unrelated-new-${i}`)),...Array.from({length:20},()=>heartbeat(people[1]))]);
    const blocked=await blockedPromise;await blocker.query('rollback');await close(blocker);await close(blockedClient);
    report.tests.push({name:'intentional_single_participant_timeout',blocked});
    await invariant('blocked_row_balance');
  }
} finally {
  report.finishedAt=new Date().toISOString();report.failedChecks=failures;
  await fs.mkdir(path.dirname(options.output||`/private/tmp/aita-pg-runtime/${label}.json`),{recursive:true});
  await fs.writeFile(options.output||`/private/tmp/aita-pg-runtime/${label}.json`,JSON.stringify(report,null,2)+'\n');
  await Promise.allSettled([...openClients].map(close));await admin.end();
}
if(failures){console.error(`${failures} benchmark checks failed (expected when measuring the unfixed baseline).`);process.exitCode=1;}
